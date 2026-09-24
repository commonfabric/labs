import Foundation
import SwiftRs
import Tauri
import UIKit
import WebKit

/// Tauri v2 mobile plugin shell. The command surface the Rust/webview side
/// calls. The real work lives in LocationCollector / PointQueue / Uploader; this
/// is the thin @objc bridge.
class SetPausedArgs: Decodable { let paused: Bool }
class SetConfigArgs: Decodable {
    let ingestUrl: String
    let token: String
    let installId: String?
    let devAllowLocalhost: Bool?
}

class LoomLocationPlugin: Plugin {
    // Use the shared collector — the app delegate touches the same instance at
    // launch so the CL delegate is live for background wakes (see README).
    private let collector = LocationCollector.shared

    @objc public func startBeacon(_ invoke: Invoke) throws {
        BeaconConfig.shared.paused = false
        collector.start()
        invoke.resolve(["ok": true])
    }

    @objc public func stopBeacon(_ invoke: Invoke) throws {
        collector.stop()
        invoke.resolve(["ok": true])
    }

    @objc public func setPaused(_ invoke: Invoke) throws {
        let args = try invoke.parseArgs(SetPausedArgs.self)
        collector.setPaused(args.paused)
        invoke.resolve(["ok": true, "paused": args.paused])
    }
}

@_cdecl("init_plugin_loom_location")
func initPlugin() -> Plugin {
    return LoomLocationPlugin()
}
