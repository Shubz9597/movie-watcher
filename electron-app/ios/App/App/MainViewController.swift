import UIKit
import Capacitor
import VLCSupport

/**
 * App bridge view controller (M1.4.4): registers the app-local native
 * plugins with the Capacitor bridge.
 *
 * M1.4.7: the app UI stays PORTRAIT; while VLC video is attached
 * (TorWatchPlaybackState.videoAttached) the app is landscape only, and the
 * portrait lock resumes on detach.
 */
class MainViewController: CAPBridgeViewController {

    // Playback is landscape only: excluding portrait means neither the
    // rotation lock nor returning from the background can show the video
    // upright.
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        TorWatchPlaybackState.videoAttached ? .landscape : .portrait
    }

    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation {
        TorWatchPlaybackState.videoAttached ? .landscapeRight : .portrait
    }

    override func capacitorDidLoad() {
        // Retain the VLCSupport object so its -l linker settings (xml2, z,
        // bz2, iconv, c++…) are always applied for the MobileVLCKit binary.
        torwatch_vlc_link_support()
        // Let WebKit own the interactive edge-swipe transition. Hash routes
        // and the visible Back controls share its navigation history.
        webView?.allowsBackForwardNavigationGestures = true
        bridge?.registerPluginInstance(TorWatchNativePlugin())
        bridge?.registerPluginInstance(TorWatchDownloadsPlugin())
        super.capacitorDidLoad()
    }
}
