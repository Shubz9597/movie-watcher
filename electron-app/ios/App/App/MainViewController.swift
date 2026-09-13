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
        // Let WebKit own the interactive edge-swipe transition. Hash routes
        // and the visible Back controls share its navigation history.
        webView?.allowsBackForwardNavigationGestures = true
        bridge?.registerPluginInstance(TorWatchNativePlugin())
        super.capacitorDidLoad()
    }
}
