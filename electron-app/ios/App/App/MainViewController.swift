import UIKit
import Capacitor
import VLCSupport

/**
 * App bridge view controller (M1.4.4): registers the app-local
 * TorWatchNativePlugin with the Capacitor bridge.
 *
 * M1.4.7: the app UI stays PORTRAIT; when VLC video is attached
 * (TorWatchPlaybackState.videoAttached) landscape is permitted so playback
 * runs fullscreen, and the portrait lock resumes on detach.
 */
class MainViewController: CAPBridgeViewController {

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        TorWatchPlaybackState.videoAttached ? .allButUpsideDown : .portrait
    }

    override func capacitorDidLoad() {
        // Retain the VLCSupport object so its -l linker settings (xml2, z,
        // bz2, iconv, c++…) are always applied for the MobileVLCKit binary.
        torwatch_vlc_link_support()
        // Let WebKit own the interactive edge-swipe transition. Hash routes
        // and the visible Back controls share its navigation history.
        webView?.allowsBackForwardNavigationGestures = true
        bridge?.registerPluginInstance(TorWatchNativePlugin())
        super.capacitorDidLoad()
    }
}
