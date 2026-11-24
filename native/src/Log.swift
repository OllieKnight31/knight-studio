import Foundation

/// Everything this binary says to its parent process is one JSON object per line
/// on stdout, so the Electron side can parse without any screen-scraping.
enum Log {
    private static let lock = NSLock()
    static func event(_ obj: [String: Any]) {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let s = String(data: d, encoding: .utf8) else { return }
        lock.lock(); defer { lock.unlock() }
        print(s)
        fflush(stdout)
    }
    static func fail(_ message: String, code: Int32 = 1) -> Never {
        event(["event": "error", "message": message])
        exit(code)
    }
}
