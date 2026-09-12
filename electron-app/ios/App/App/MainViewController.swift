import UIKit
import Capacitor

/**
 * App bridge view controller (M1.4.4): registers the app-local
 * TorWatchNativePlugin (TorWatchNativePlugin.swift) with the Capacitor
 * bridge. Standard Capacitor app-local plugin registration — the plugin is
 * part of the App target, not a separate package.
 */
class MainViewController: CAPBridgeViewController {

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(TorWatchNativePlugin())
        super.capacitorDidLoad()
    }
}
