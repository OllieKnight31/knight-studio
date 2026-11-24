import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import CoreVideo
import Cocoa

struct RecordOptions {
    var displayID: CGDirectDisplayID?
    var windowID: CGWindowID?
    var outDir: String
    var fps: Int = 60
    var systemAudio: Bool = true
    var micDeviceID: String?          // AVCaptureDevice uniqueID, nil = no mic
    var cameraDeviceID: String?       // AVCaptureDevice uniqueID, nil = no camera
    var showsCursor: Bool = false     // we redraw the cursor from the event log
    var codec: String = "h264"        // h264 | hevc
    var scaleFactor: Int = 0          // 0 = native retina
    var minFPS: Double = 5            // keepalive floor, see note below
    var warmupSeconds: Double = 0.6   // discarded while the capture settles
    var excludePIDs: [pid_t] = []     // app windows to keep out of the recording
}

/// Captures the screen with ScreenCaptureKit into screen.mov (video + optional
/// system-audio and mic tracks), the webcam into camera.mov, and the cursor/click
/// stream into events.jsonl — all sharing one clock so they stay frame-accurate.
///
/// ScreenCaptureKit only emits a frame when screen pixels actually change, so a
/// still screen yields no frames at all and the writer would never even start.
/// A keepalive timer re-appends the last frame at `minFPS` to keep the file
/// continuous and its duration honest, at almost no size cost (static H.264
/// P-frames are tiny).
@available(macOS 15.0, *)
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureVideoDataOutputSampleBufferDelegate {
    private let opts: RecordOptions
    private var stream: SCStream?

    private var writer: AVAssetWriter?
    private var videoIn: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sysAudioIn: AVAssetWriterInput?
    private var micIn: AVAssetWriterInput?
    /// Which audio track is which, in file order — the exporter reads this instead of
    /// guessing, so changing the order here can never silently mis-map the mix.
    private var audioOrder: [String] = []

    // The camera is written by our own AVAssetWriter rather than AVCaptureMovieFileOutput.
    // A movie-file output decides for itself when its file begins — roughly a second
    // after it is asked to — and never says when, so the camera ended up a second ahead
    // of the voice. Writing the frames ourselves lets every one be stamped on the host
    // clock, the same clock ScreenCaptureKit stamps the screen and the microphone with.
    private var cameraSession: AVCaptureSession?
    private var cameraDataOut: AVCaptureVideoDataOutput?
    private var cameraWriter: AVAssetWriter?
    private var cameraIn: AVAssetWriterInput?
    private var cameraStarted = false
    private var cameraFailed = false
    private var micSeen = false         // the microphone has delivered at least one buffer
    private var cameraSeen = false      // the camera has delivered at least one frame
    private var cameraLastPTS: CMTime = .invalid
    private var cameraFrames = 0
    private var cameraStartOffset: Double = 0
    private var tracker: EventTracker?

    private let sampleQueue = DispatchQueue(label: "knightcap.samples")
    private var keepalive: DispatchSourceTimer?

    private var sessionStarted = false
    private var warmedUp = false
    private var captureStartHost: CMTime = .invalid
    private var firstPTS: CMTime = .invalid
    private var lastSourcePTS: CMTime = .zero      // newest PTS seen from SCK
    private var lastWrittenPTS: CMTime = .invalid  // newest PTS appended (output timeline)
    private var lastPixelBuffer: CVPixelBuffer?
    private var frameCount = 0
    private var keepaliveFrames = 0

    private var isPaused = false
    private var pauseStart: CMTime = .invalid
    private var pausedTotal: CMTime = .zero

    private var outWidth = 0
    private var outHeight = 0
    private var displayID: CGDirectDisplayID = 0
    private var t0: CFAbsoluteTime = 0
    private var stopped = false

    init(options: RecordOptions) { self.opts = options }

    // MARK: - Setup

    private func resolveFilter() async throws -> (SCContentFilter, Int, Int, CGDirectDisplayID) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

        if let wid = opts.windowID {
            guard let win = content.windows.first(where: { $0.windowID == wid }) else {
                throw err(20, "window \(wid) not found")
            }
            let did = content.displays.first?.displayID ?? CGMainDisplayID()
            let scale = scaleFor(did)
            return (SCContentFilter(desktopIndependentWindow: win),
                    even(Int(win.frame.width * scale)), even(Int(win.frame.height * scale)), did)
        }

        let did = opts.displayID ?? CGMainDisplayID()
        guard let disp = content.displays.first(where: { $0.displayID == did }) ?? content.displays.first else {
            throw err(21, "no displays available")
        }
        let scale = scaleFor(disp.displayID)
        // Keep the recorder's own UI out of the shot. knightcap runs as a separate
        // process from the app, so the app passes its PID in via --exclude-pid.
        var excluded = opts.excludePIDs
        excluded.append(ProcessInfo.processInfo.processIdentifier)
        let excludedApps = content.applications.filter { excluded.contains($0.processID) }
        let filter = SCContentFilter(display: disp,
                                     excludingApplications: excludedApps,
                                     exceptingWindows: [])
        return (filter,
                even(Int(Double(disp.width) * scale)),
                even(Int(Double(disp.height) * scale)),
                disp.displayID)
    }

    private func err(_ code: Int, _ msg: String) -> NSError {
        NSError(domain: "knightcap", code: code, userInfo: [NSLocalizedDescriptionKey: msg])
    }

    /// SCDisplay dimensions are logical POINTS. Capturing at those numbers silently
    /// gives a half-resolution recording on retina, so always scale up to pixels.
    /// CoreGraphics rather than NSScreen: AppKit is main-thread-only and this runs
    /// off the main actor, where touching NSScreen blocks.
    private func scaleFor(_ id: CGDirectDisplayID) -> Double {
        if opts.scaleFactor > 0 { return Double(opts.scaleFactor) }
        if let mode = CGDisplayCopyDisplayMode(id), mode.width > 0 {
            return Double(mode.pixelWidth) / Double(mode.width)
        }
        return 2.0
    }

    private func even(_ n: Int) -> Int { n % 2 == 0 ? n : n - 1 }

    private func makeWriter(width: Int, height: Int) throws {
        let url = URL(fileURLWithPath: opts.outDir).appendingPathComponent("screen.mov")
        try? FileManager.default.removeItem(at: url)
        let w = try AVAssetWriter(outputURL: url, fileType: .mov)

        // ~0.11 bits per pixel per frame keeps text crisp at retina sizes without
        // absurd file sizes; clamped so tiny and huge displays both stay sane.
        let pixels = Double(width * height)
        let bitrate = Int(min(120_000_000, max(8_000_000, pixels * Double(opts.fps) * 0.11)))
        let codec: AVVideoCodecType = (opts.codec.lowercased() == "hevc") ? .hevc : .h264
        var compression: [String: Any] = [
            AVVideoAverageBitRateKey: bitrate,
            AVVideoExpectedSourceFrameRateKey: opts.fps,
            AVVideoMaxKeyFrameIntervalKey: opts.fps * 2,
            AVVideoAllowFrameReorderingKey: false
        ]
        if codec == .h264 { compression[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }

        let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: codec,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: compression
        ])
        vin.expectsMediaDataInRealTime = true
        guard w.canAdd(vin) else { throw err(22, "cannot add video input") }
        w.add(vin)
        videoIn = vin
        adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: vin,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height
            ])

        let audioSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 48000,
            AVNumberOfChannelsKey: 2,
            AVEncoderBitRateKey: 192000
        ]
        // The microphone goes FIRST on purpose. Players that only play one audio
        // track — QuickTime, Finder previews, most browsers — take the first one, and
        // a recording whose first track is silent system audio sounds broken even
        // though the voice is sitting right there on track two.
        if opts.micDeviceID != nil {
            let m = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            m.expectsMediaDataInRealTime = true
            if w.canAdd(m) { w.add(m); micIn = m; audioOrder.append("microphone") }
        }
        if opts.systemAudio {
            let a = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            a.expectsMediaDataInRealTime = true
            if w.canAdd(a) { w.add(a); sysAudioIn = a; audioOrder.append("system") }
        }
        writer = w
    }

    /// Starts the webcam file recording, if a camera is available and permitted.
    /// The camera is strictly optional: any failure here is logged and skipped so the
    /// screen capture always survives.
    private func prepareCamera() {
        guard let uid = opts.cameraDeviceID else { return }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else {
            Log.event(["event": "cameraSkipped", "reason": "camera access not authorized"]); return
        }
        guard let dev = AVCaptureDevice(uniqueID: uid),
              let input = try? AVCaptureDeviceInput(device: dev) else {
            Log.event(["event": "cameraSkipped", "reason": "camera device unavailable"]); return
        }

        let session = AVCaptureSession()
        session.beginConfiguration()
        // Add the input BEFORE choosing a preset: canAddInput() fails outright when the
        // session is already pinned to a preset the camera cannot produce, which is how
        // a perfectly good webcam ends up looking "unavailable".
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            Log.event(["event": "cameraSkipped", "reason": "cannot add camera input"]); return
        }
        session.addInput(input)
        for preset in [AVCaptureSession.Preset.hd1920x1080, .hd1280x720, .high] where dev.supportsSessionPreset(preset) {
            session.sessionPreset = preset
            break
        }
        // Mic is captured by ScreenCaptureKit, so the camera file stays video-only.
        let out = AVCaptureVideoDataOutput()
        out.alwaysDiscardsLateVideoFrames = true
        out.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange]
        // Same serial queue as the screen and audio samples, so the shared timeline
        // state is only ever touched from one place.
        out.setSampleBufferDelegate(self, queue: sampleQueue)
        guard session.canAddOutput(out) else {
            session.commitConfiguration()
            Log.event(["event": "cameraSkipped", "reason": "cannot add camera output"]); return
        }
        session.addOutput(out)
        session.commitConfiguration()
        session.startRunning()

        cameraSession = session
        cameraDataOut = out
    }

    /// Opens camera.mov the moment the first camera frame arrives, sized to that frame.
    private func makeCameraWriter(width: Int, height: Int) -> Bool {
        let url = URL(fileURLWithPath: opts.outDir).appendingPathComponent("camera.mov")
        try? FileManager.default.removeItem(at: url)
        guard let w = try? AVAssetWriter(outputURL: url, fileType: .mov) else { return false }
        let bitrate = Int(min(16_000_000, max(4_000_000, Double(width * height) * 30 * 0.14)))
        let vin = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoMaxKeyFrameIntervalKey: 60,
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
            ] as [String: Any]
        ])
        vin.expectsMediaDataInRealTime = true
        guard w.canAdd(vin) else { return false }
        w.add(vin)
        guard w.startWriting() else {
            Log.event(["event": "cameraError", "message": w.error?.localizedDescription ?? "camera writer failed to start"])
            return false
        }
        cameraWriter = w
        cameraIn = vin
        return true
    }

    /// One camera frame. Its timestamp is converted to the host clock and placed on the
    /// same timeline as the screen: host time, minus time spent paused. The file's own
    /// zero is its first frame, and `cameraStartOffset` records exactly where that
    /// frame sits on the screen timeline — measured, not assumed.
    private func handleCamera(_ sb: CMSampleBuffer) {
        cameraSeen = true
        if cameraWriter == nil && !cameraFailed {
            // Opened on the first frame the camera ever delivers — before the timeline
            // starts — because opening a writer takes long enough to drop frames.
            guard let px = CMSampleBufferGetImageBuffer(sb),
                  makeCameraWriter(width: CVPixelBufferGetWidth(px), height: CVPixelBufferGetHeight(px)) else {
                cameraFailed = true
                Log.event(["event": "cameraSkipped", "reason": "camera writer unavailable"])
                return
            }
        }
        guard !stopped, warmedUp, sessionStarted, firstPTS.isValid, !isPaused,
              CMSampleBufferDataIsReady(sb) else { return }
        var pts = CMSampleBufferGetPresentationTimeStamp(sb)
        if let clock = cameraSession?.synchronizationClock {
            pts = CMSyncConvertTime(pts, from: clock, to: CMClockGetHostTimeClock())
        }
        // Frames captured before the screen timeline began belong to no recording.
        if CMTimeCompare(pts, firstPTS) < 0 { return }
        let out = CMTimeSubtract(pts, pausedTotal)

        if !cameraStarted {
            guard let cw = cameraWriter, cw.status == .writing else { return }
            cw.startSession(atSourceTime: out)
            cameraStarted = true
            cameraStartOffset = max(0, CMTimeGetSeconds(CMTimeSubtract(out, firstPTS)))
            Log.event(["event": "cameraStarted", "offset": cameraStartOffset])
        }
        guard let vin = cameraIn, vin.isReadyForMoreMediaData else { return }
        if cameraLastPTS.isValid && CMTimeCompare(out, cameraLastPTS) <= 0 { return }

        var timing = CMSampleTimingInfo(duration: CMSampleBufferGetDuration(sb),
                                        presentationTimeStamp: out, decodeTimeStamp: .invalid)
        var copy: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault, sampleBuffer: sb,
                                                    sampleTimingEntryCount: 1, sampleTimingArray: &timing,
                                                    sampleBufferOut: &copy) == noErr, let stamped = copy else { return }
        if vin.append(stamped) {
            cameraLastPTS = out
            cameraFrames += 1
        }
    }

    // MARK: - Run

    func start() async throws {
        try FileManager.default.createDirectory(atPath: opts.outDir, withIntermediateDirectories: true)
        let (filter, w, h, did) = try await resolveFilter()
        outWidth = w; outHeight = h; displayID = did
        try makeWriter(width: w, height: h)
        // Opened now rather than on the first frame: startWriting() blocks for a couple
        // of hundred milliseconds, and paying that at the start of the timeline cost the
        // opening frames of every take.
        if writer?.startWriting() != true {
            throw err(23, writer?.error?.localizedDescription ?? "could not open screen.mov for writing")
        }

        let cfg = SCStreamConfiguration()
        cfg.width = w
        cfg.height = h
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(opts.fps))
        cfg.queueDepth = 8
        cfg.showsCursor = opts.showsCursor
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        cfg.capturesAudio = opts.systemAudio
        cfg.excludesCurrentProcessAudio = true
        cfg.sampleRate = 48000
        cfg.channelCount = 2
        if let mic = opts.micDeviceID {
            cfg.captureMicrophone = true
            cfg.microphoneCaptureDeviceID = mic
        }

        let s = SCStream(filter: filter, configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        if opts.systemAudio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue) }
        if opts.micDeviceID != nil { try s.addStreamOutput(self, type: .microphone, sampleHandlerQueue: sampleQueue) }
        stream = s

        tracker = try? EventTracker(path: URL(fileURLWithPath: opts.outDir)
            .appendingPathComponent("events.jsonl").path, displayID: did)

        // Bring the camera up first: AVCaptureSession needs a second or so to produce
        // its first frame, and starting it after the screen capture would leave the
        // opening of every recording with no camera in it.
        prepareCamera()

        captureStartHost = CMClockGetTime(CMClockGetHostTimeClock())
        try await s.startCapture()
        // The clock, the camera file and the event log all start together once the
        // capture has settled — see beginTimeline().
        startKeepalive()

        Log.event(["event": "started", "width": w, "height": h, "fps": opts.fps,
                   "dir": opts.outDir, "codec": opts.codec, "display": did])
    }

    /// Anchors every clock to the same instant, once frames are actually flowing.
    ///
    /// ScreenCaptureKit emits a short burst and then stalls for a few hundred
    /// milliseconds while it settles, so a recording that starts on the very first
    /// frame opens with a stutter and with audio that begins late. Discarding that
    /// warm-up and starting the timeline, the camera file and the event log together
    /// gives every recording a clean first second.
    private func beginTimeline() {
        warmedUp = true
        t0 = CFAbsoluteTimeGetCurrent()
        tracker?.start(t0: t0)
    }

    /// Re-appends the most recent frame whenever the screen has gone quiet, so the
    /// recording never has a hole and never ends up empty.
    private func startKeepalive() {
        let interval = 1.0 / max(1.0, opts.minFPS)
        let t = DispatchSource.makeTimerSource(queue: sampleQueue)
        t.schedule(deadline: .now() + interval, repeating: interval)
        t.setEventHandler { [weak self] in
            guard let self = self, !self.isPaused, !self.stopped, self.warmedUp,
                  self.sessionStarted, let buf = self.lastPixelBuffer else { return }
            let host = CMClockGetTime(CMClockGetHostTimeClock())
            let gap = CMTimeGetSeconds(CMTimeSubtract(host, self.lastSourcePTS))
            guard gap >= interval else { return }   // real frames are still flowing
            self.appendVideo(buf, at: host)
            self.keepaliveFrames += 1
        }
        t.resume()
        keepalive = t
    }

    /// Appends a frame on the output timeline (source PTS minus time spent paused),
    /// enforcing strictly increasing timestamps.
    private func appendVideo(_ buffer: CVPixelBuffer, at sourcePTS: CMTime) {
        guard let vin = videoIn, let ad = adaptor, vin.isReadyForMoreMediaData else { return }
        let pts = CMTimeSubtract(sourcePTS, pausedTotal)
        if lastWrittenPTS.isValid && CMTimeCompare(pts, lastWrittenPTS) <= 0 { return }
        if ad.append(buffer, withPresentationTime: pts) {
            lastWrittenPTS = pts
            frameCount += 1
        }
    }

    func pause() {
        guard !isPaused, !stopped else { return }
        isPaused = true
        tracker?.isPaused = true
        pauseStart = CMClockGetTime(CMClockGetHostTimeClock())
        Log.event(["event": "paused", "t": currentSeconds()])
    }

    func resume() {
        guard isPaused, !stopped else { return }
        isPaused = false
        if pauseStart.isValid {
            let gap = CMTimeSubtract(CMClockGetTime(CMClockGetHostTimeClock()), pauseStart)
            if CMTimeGetSeconds(gap) > 0 {
                pausedTotal = CMTimeAdd(pausedTotal, gap)
                tracker?.pausedOffset += CMTimeGetSeconds(gap)
            }
        }
        pauseStart = .invalid
        tracker?.isPaused = false
        Log.event(["event": "resumed", "t": currentSeconds()])
    }

    func currentSeconds() -> Double {
        guard firstPTS.isValid, lastWrittenPTS.isValid else { return 0 }
        return max(0, CMTimeGetSeconds(CMTimeSubtract(lastWrittenPTS, firstPTS)))
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        keepalive?.cancel(); keepalive = nil
        tracker?.stop()
        if let s = stream { try? await s.stopCapture() }
        cameraDataOut?.setSampleBufferDelegate(nil, queue: nil)
        cameraSession?.stopRunning()
        // Let any sample already on the queue finish before the writers are closed.
        sampleQueue.sync { }

        let duration = currentSeconds()

        // markAsFinished() throws if the writer never started (no frames ever arrived).
        if let w = writer, w.status == .writing {
            videoIn?.markAsFinished()
            sysAudioIn?.markAsFinished()
            micIn?.markAsFinished()
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                w.finishWriting { c.resume() }
            }
        }
        if let cw = cameraWriter, cw.status == .writing {
            if !cameraStarted { cw.startSession(atSourceTime: .zero) }
            cameraIn?.markAsFinished()
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                cw.finishWriting { c.resume() }
            }
        }

        writeManifest(duration: duration)
        Log.event(["event": "stopped", "duration": duration, "frames": frameCount,
                   "keepaliveFrames": keepaliveFrames, "dir": opts.outDir])
    }

    private func writeManifest(duration: Double) {
        let dir = URL(fileURLWithPath: opts.outDir)
        let hasCamera = cameraFrames > 0
            && FileManager.default.fileExists(atPath: dir.appendingPathComponent("camera.mov").path)
        let m: [String: Any] = [
            "version": 2,
            // "host-clock": the offset below was measured from frame timestamps. Takes
            // without this key predate that and carry an offset that is about a second short.
            "cameraSync": "host-clock",
            "cameraFrames": cameraFrames,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "duration": duration,
            "width": outWidth, "height": outHeight,
            "fps": opts.fps, "codec": opts.codec, "display": displayID,
            "screen": "screen.mov",
            "camera": hasCamera ? "camera.mov" : NSNull(),
            "cameraStartOffset": cameraStartOffset,
            "events": "events.jsonl",
            "audio": ["system": opts.systemAudio, "microphone": opts.micDeviceID != nil],
            "audioOrder": audioOrder,
            "frames": frameCount, "keepaliveFrames": keepaliveFrames,
            "cursorBakedIn": opts.showsCursor
        ]
        if let d = try? JSONSerialization.data(withJSONObject: m, options: [.prettyPrinted, .sortedKeys]) {
            try? d.write(to: dir.appendingPathComponent("manifest.json"))
        }
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard !stopped, CMSampleBufferDataIsReady(sb), let writer = writer else { return }

        if type == .screen {
            // SCK also emits idle/blank status frames that carry no new pixels.
            guard let attach = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
                  let raw = attach.first?[.status] as? Int,
                  let status = SCFrameStatus(rawValue: raw), status == .complete else { return }
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sb)
        // Throw away everything until the stream has settled, then start all clocks
        // together on the first frame that survives.
        if !warmedUp {
            if type == .microphone { micSeen = true }
            guard type == .screen, captureStartHost.isValid else { return }
            let settled = CMTimeGetSeconds(CMTimeSubtract(pts, captureStartHost))
            if settled < opts.warmupSeconds { return }
            // A camera takes longer to wake than the screen does. Hold the start until
            // its first frame is in, so a take never opens with an empty camera — but
            // never hold for long, and never at all if the camera turns out to be dead.
            if cameraSession != nil && !cameraSeen && settled < 3.0 { return }
            // Same for the microphone, which otherwise leaves the first half-second silent.
            if opts.micDeviceID != nil && !micSeen && settled < 3.0 { return }
            beginTimeline()
        }

        if !sessionStarted {
            guard type == .screen else { return }   // always anchor the timeline to video
            guard writer.status == .writing else {
                Log.event(["event": "error",
                           "message": writer.error?.localizedDescription ?? "screen writer is not open"])
                return
            }
            writer.startSession(atSourceTime: pts)
            firstPTS = pts
            sessionStarted = true
        }

        if type == .screen {
            lastSourcePTS = pts
            if let px = CMSampleBufferGetImageBuffer(sb) { lastPixelBuffer = px }
        }
        if isPaused { return }

        switch type {
        case .screen:
            if let px = CMSampleBufferGetImageBuffer(sb) { appendVideo(px, at: pts) }
        case .audio:
            if let a = sysAudioIn, a.isReadyForMoreMediaData,
               let s = Self.retimed(sb, by: pausedTotal) { a.append(s) }
        default:
            if type == .microphone, let m = micIn, m.isReadyForMoreMediaData,
               let s = Self.retimed(sb, by: pausedTotal) { m.append(s) }
        }
    }

    /// Rebuilds a sample buffer with its timestamps moved earlier by `delta`, so the
    /// output has no gap where the recording was paused.
    private static func retimed(_ sb: CMSampleBuffer, by delta: CMTime) -> CMSampleBuffer? {
        if delta == .zero { return sb }
        var count: CMItemCount = 0
        guard CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: 0,
                                                     arrayToFill: nil, entriesNeededOut: &count) == noErr else { return sb }
        var timings = [CMSampleTimingInfo](repeating: .init(), count: count)
        guard CMSampleBufferGetSampleTimingInfoArray(sb, entryCount: count,
                                                     arrayToFill: &timings, entriesNeededOut: nil) == noErr else { return sb }
        for i in 0..<timings.count {
            timings[i].presentationTimeStamp = CMTimeSubtract(timings[i].presentationTimeStamp, delta)
            if timings[i].decodeTimeStamp.isValid {
                timings[i].decodeTimeStamp = CMTimeSubtract(timings[i].decodeTimeStamp, delta)
            }
        }
        var out: CMSampleBuffer?
        guard CMSampleBufferCreateCopyWithNewTiming(allocator: kCFAllocatorDefault,
                                                    sampleBuffer: sb,
                                                    sampleTimingEntryCount: count,
                                                    sampleTimingArray: &timings,
                                                    sampleBufferOut: &out) == noErr else { return sb }
        return out
    }

    // MARK: - AVCaptureVideoDataOutputSampleBufferDelegate

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        handleCamera(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.event(["event": "error", "message": error.localizedDescription])
    }
}
