import Cocoa
import CoreGraphics
import Foundation

/// Records global cursor movement, clicks, scrolls and key-press beats to a JSONL
/// file. Timestamps are seconds relative to the recording's t0, so the editor can
/// line every event up against a video frame with no extra correlation work.
///
/// This is the raw material for click-driven auto-zoom — the one thing a browser
/// simply cannot provide, since no web API exposes the cursor outside its own window.
final class EventTracker {
    private let out: FileHandle
    private let bounds: CGRect
    private let scale: CGFloat
    private var t0: CFAbsoluteTime = 0
    private var pollTimer: DispatchSourceTimer?
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?
    private var tapThread: Thread?
    fileprivate var tapShouldStop = false
    private let queue = DispatchQueue(label: "knightcap.events")
    private var lastPoint: CGPoint = CGPoint(x: -1, y: -1)
    private var running = false

    /// Time spent paused, subtracted so event times match the trimmed video timeline.
    var pausedOffset: Double = 0
    var isPaused = false

    init(path: String, displayID: CGDirectDisplayID) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let h = FileHandle(forWritingAtPath: path) else {
            throw NSError(domain: "knightcap", code: 10,
                          userInfo: [NSLocalizedDescriptionKey: "cannot open events file at \(path)"])
        }
        self.out = h
        self.bounds = CGDisplayBounds(displayID)
        if let mode = CGDisplayCopyDisplayMode(displayID), mode.width > 0 {
            self.scale = CGFloat(mode.pixelWidth) / CGFloat(mode.width)
        } else {
            self.scale = 2.0
        }
    }

    /// Global CoreGraphics points (top-left origin) -> display-local PIXELS, which is
    /// the coordinate space of the captured video frames.
    private func toPixels(_ p: CGPoint) -> CGPoint {
        CGPoint(x: (p.x - bounds.minX) * scale, y: (p.y - bounds.minY) * scale)
    }

    /// CGEvent rather than NSEvent.mouseLocation: it is thread-safe, and it already
    /// reports in CoreGraphics' top-left coordinate space, so no flip is needed.
    private func cursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private func now() -> Double {
        max(0, CFAbsoluteTimeGetCurrent() - t0 - pausedOffset)
    }

    private func emit(_ obj: [String: Any]) {
        guard running, !isPaused else { return }
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return }
        queue.async { [weak self] in
            guard let self = self else { return }
            self.out.write(d)
            self.out.write("\n".data(using: .utf8)!)
        }
    }

    func start(t0: CFAbsoluteTime) {
        self.t0 = t0
        self.running = true

        emit(["t": 0, "type": "meta",
              "displayWidthPx": Int(bounds.width * scale),
              "displayHeightPx": Int(bounds.height * scale),
              "scale": scale,
              "accessibility": AXIsProcessTrusted()])

        install()

        // 60 Hz poll: global monitors only fire while other apps handle events, so
        // polling guarantees a continuous cursor path to smooth and follow.
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(16))
        timer.setEventHandler { [weak self] in
            guard let self = self, self.running, !self.isPaused else { return }
            let raw = self.cursor()
            if abs(raw.x - self.lastPoint.x) < 0.5 && abs(raw.y - self.lastPoint.y) < 0.5 { return }
            self.lastPoint = raw
            let p = self.toPixels(raw)
            self.emit(["t": self.now(), "type": "move",
                       "x": Int(p.x.rounded()), "y": Int(p.y.rounded())])
        }
        timer.resume()
        pollTimer = timer
    }

    /// Installs a CoreGraphics event tap for clicks, scrolls and key beats.
    ///
    /// NSEvent's global monitors never fire in a process that has no running
    /// NSApplication, which is exactly what this helper is — so clicks silently went
    /// missing. A CGEventTap works headlessly. It does require Accessibility
    /// permission; without it the tap simply never installs, which `accessibility`
    /// in the meta record reports so the app can tell the user why zooms are missing.
    private func install() {
        let mask: CGEventMask =
            (1 << CGEventType.leftMouseDown.rawValue) |
            (1 << CGEventType.leftMouseUp.rawValue) |
            (1 << CGEventType.rightMouseDown.rawValue) |
            (1 << CGEventType.rightMouseUp.rawValue) |
            (1 << CGEventType.otherMouseDown.rawValue) |
            (1 << CGEventType.otherMouseUp.rawValue) |
            (1 << CGEventType.scrollWheel.rawValue) |
            (1 << CGEventType.keyDown.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon = refcon else { return Unmanaged.passUnretained(event) }
            let tracker = Unmanaged<EventTracker>.fromOpaque(refcon).takeUnretainedValue()
            tracker.handle(type: type, event: event)
            return Unmanaged.passUnretained(event)
        }

        let thread = Thread { [weak self] in
            guard let self = self else { return }
            guard let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap,
                place: .headInsertEventTap,
                options: .listenOnly,          // observe only; never alter input
                eventsOfInterest: mask,
                callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque()
            ) else {
                Log.event(["event": "warning",
                           "message": "click capture unavailable — grant Accessibility permission to enable auto zoom"])
                return
            }
            self.tap = tap
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
            self.tapSource = source
            CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
            CGEvent.tapEnable(tap: tap, enable: true)
            self.tapRunLoop = CFRunLoopGetCurrent()
            while !self.tapShouldStop {
                CFRunLoopRunInMode(.defaultMode, 0.2, false)
            }
        }
        thread.name = "knightcap.eventtap"
        thread.start()
        tapThread = thread
    }

    /// Called on the event-tap thread for every observed input event.
    fileprivate func handle(type: CGEventType, event: CGEvent) {
        // macOS disables a tap that runs too slowly; re-arm it rather than going deaf.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let t = tap { CGEvent.tapEnable(tap: t, enable: true) }
            return
        }
        let p = toPixels(event.location)
        var kind: String
        switch type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown: kind = "down"
        case .leftMouseUp, .rightMouseUp, .otherMouseUp:       kind = "up"
        case .scrollWheel:                                     kind = "scroll"
        case .keyDown:                                         kind = "key"
        default:                                               return
        }
        if kind == "key" {
            // Timing beat only — no characters are recorded.
            emit(["t": now(), "type": "key"])
            return
        }
        var o: [String: Any] = ["t": now(), "type": kind,
                                "x": Int(p.x.rounded()), "y": Int(p.y.rounded())]
        if kind == "down" || kind == "up" {
            o["button"] = Int(event.getIntegerValueField(.mouseEventButtonNumber))
        }
        if kind == "scroll" {
            o["dy"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis1)
            o["dx"] = event.getIntegerValueField(.scrollWheelEventDeltaAxis2)
        }
        emit(o)
    }

    func stop() {
        running = false
        pollTimer?.cancel(); pollTimer = nil
        tapShouldStop = true
        if let t = tap { CGEvent.tapEnable(tap: t, enable: false) }
        if let rl = tapRunLoop, let src = tapSource {
            CFRunLoopRemoveSource(rl, src, .commonModes)
            CFRunLoopStop(rl)
        }
        tap = nil; tapSource = nil; tapRunLoop = nil; tapThread = nil
        queue.sync { }
        try? out.close()
    }
}
