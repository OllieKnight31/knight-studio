import Foundation
import ScreenCaptureKit
import AVFoundation
import Cocoa

@available(macOS 15.0, *)
enum ListCommand {
    static func run() async {
        var payload: [String: Any] = [:]

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)

            payload["displays"] = content.displays.map { d -> [String: Any] in
                let ns = NSScreen.screens.first {
                    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == d.displayID
                }
                let scale = Double(ns?.backingScaleFactor ?? 2.0)
                return [
                    "id": d.displayID,
                    "width": d.width, "height": d.height,
                    "pixelWidth": Int(Double(d.width) * scale),
                    "pixelHeight": Int(Double(d.height) * scale),
                    "scale": scale,
                    "isMain": d.displayID == CGMainDisplayID(),
                    "name": ns?.localizedName ?? "Display \(d.displayID)"
                ]
            }

            // Only real, on-screen, reasonably sized windows — skip menubar extras and shims.
            payload["windows"] = content.windows.compactMap { w -> [String: Any]? in
                guard w.isOnScreen, w.frame.width > 120, w.frame.height > 120 else { return nil }
                guard let app = w.owningApplication else { return nil }
                return [
                    "id": w.windowID,
                    "title": w.title ?? "",
                    "app": app.applicationName,
                    "bundleID": app.bundleIdentifier,
                    "width": Int(w.frame.width), "height": Int(w.frame.height)
                ]
            }
        } catch {
            payload["displays"] = []
            payload["windows"] = []
            payload["contentError"] = error.localizedDescription
        }

        let camTypes: [AVCaptureDevice.DeviceType] = [.builtInWideAngleCamera, .external, .continuityCamera, .deskViewCamera]
        payload["cameras"] = AVCaptureDevice.DiscoverySession(
            deviceTypes: camTypes, mediaType: .video, position: .unspecified
        ).devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }

        payload["microphones"] = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified
        ).devices.map { ["id": $0.uniqueID, "name": $0.localizedName] }

        payload["permissions"] = [
            "screenRecording": CGPreflightScreenCaptureAccess(),
            "accessibility": AXIsProcessTrusted(),
            "camera": AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
            "microphone": AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        ]

        Log.event(["event": "devices", "data": payload])
    }
}
