import Foundation
import Cocoa
import ScreenCaptureKit
import AVFoundation

// knightcap — the native capture engine behind Ainable Studio.
//
//   knightcap list
//   knightcap permissions
//   knightcap record --out <dir> [--display N] [--window N] [--fps 60]
//                    [--mic <id>] [--camera <id>] [--no-system-audio]
//                    [--codec h264|hevc] [--cursor] [--scale N]
//
// While recording it reads commands on stdin: `pause`, `resume`, `stop`.
// Every line it writes to stdout is a JSON object.

func arg(_ name: String) -> String? {
    let a = CommandLine.arguments
    guard let i = a.firstIndex(of: "--\(name)"), i + 1 < a.count else { return nil }
    return a[i + 1]
}
func flag(_ name: String) -> Bool { CommandLine.arguments.contains("--\(name)") }

guard #available(macOS 15.0, *) else {
    Log.fail("Ainable Studio needs macOS 15 or newer")
}

let command = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "help"

switch command {

case "list":
    let sem = DispatchSemaphore(value: 0)
    Task { await ListCommand.run(); sem.signal() }
    sem.wait()

case "request-screen":
    // Registers this app in Screen & System Audio Recording and shows the system
    // prompt. Without a request macOS leaves the app out of that list entirely.
    if !CGPreflightScreenCaptureAccess() { _ = CGRequestScreenCaptureAccess() }
    Log.event(["event": "screen", "data": ["screenRecording": CGPreflightScreenCaptureAccess()]])

case "permissions":
    // Requesting screen access shows the system prompt on first run.
    let screen = CGPreflightScreenCaptureAccess()
    if !screen { CGRequestScreenCaptureAccess() }
    if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
        let s = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .video) { _ in s.signal() }
        s.wait()
    }
    if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
        let s = DispatchSemaphore(value: 0)
        AVCaptureDevice.requestAccess(for: .audio) { _ in s.signal() }
        s.wait()
    }
    if !AXIsProcessTrusted() {
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
    }
    Log.event(["event": "permissions", "data": [
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "accessibility": AXIsProcessTrusted(),
        "camera": AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
        "microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    ]])

case "record":
    guard let outDir = arg("out") else { Log.fail("--out <dir> is required") }
    var o = RecordOptions(outDir: outDir)
    if let d = arg("display"), let v = UInt32(d) { o.displayID = v }
    if let w = arg("window"), let v = UInt32(w) { o.windowID = v }
    if let f = arg("fps"), let v = Int(f) { o.fps = max(1, min(120, v)) }
    if let m = arg("min-fps"), let v = Double(m) { o.minFPS = max(1, min(60, v)) }
    if let w = arg("warmup"), let v = Double(w) { o.warmupSeconds = max(0, min(3, v)) }
    if let e = arg("exclude-pid") {
        o.excludePIDs = e.split(separator: ",").compactMap { pid_t($0.trimmingCharacters(in: .whitespaces)) }
    }
    if let s = arg("scale"), let v = Int(s) { o.scaleFactor = v }
    o.micDeviceID = arg("mic")
    o.cameraDeviceID = arg("camera")
    o.systemAudio = !flag("no-system-audio")
    o.showsCursor = flag("cursor")
    if let c = arg("codec") { o.codec = c }

    let recorder = Recorder(options: o)
    let done = DispatchSemaphore(value: 0)

    // Ctrl-C should still produce a playable file.
    signal(SIGINT, SIG_IGN)
    let sigsrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
    sigsrc.setEventHandler { Task { await recorder.stop(); done.signal() } }
    sigsrc.resume()

    Task {
        do { try await recorder.start() }
        catch { Log.fail("start failed: \(error.localizedDescription)") }
    }

    // stdin command loop
    DispatchQueue.global().async {
        while let line = readLine(strippingNewline: true) {
            switch line.trimmingCharacters(in: .whitespaces).lowercased() {
            case "pause":  recorder.pause()
            case "resume": recorder.resume()
            case "status": Log.event(["event": "status", "t": recorder.currentSeconds()])
            case "stop", "quit", "exit":
                Task { await recorder.stop(); done.signal() }
                return
            default: break
            }
        }
        // stdin closed (parent died) — stop cleanly rather than orphaning the capture.
        Task { await recorder.stop(); done.signal() }
    }

    // The main thread must keep pumping its run loop: ScreenCaptureKit delivers via
    // XPC and NSEvent global monitors only fire on a live main run loop. Blocking here
    // on a semaphore starves both and the capture silently produces nothing.
    while done.wait(timeout: .now()) == .timedOut {
        RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    exit(0)

default:
    Log.event(["event": "help", "usage": [
        "knightcap list",
        "knightcap permissions",
        "knightcap record --out <dir> [--display N] [--window N] [--fps 60] [--min-fps 5] [--warmup 0.6] [--mic <id>] [--camera <id>] [--no-system-audio] [--codec h264|hevc] [--cursor] [--scale N] [--exclude-pid 123,456]"
    ]])
}
