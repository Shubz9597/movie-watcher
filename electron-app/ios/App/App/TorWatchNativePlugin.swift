import Foundation
import AVFoundation
import AVKit
import UIKit
import Capacitor

/**
 * TorWatchNativePlugin (feature 002 M1.4.4) — local Capacitor plugin
 * implementing full-screen native playback with AVPlayer (AVKit).
 *
 * Security/privacy invariants (repair pass M1.4):
 *  - Only OPAQUE playback/subtitle URLs (from /v2/playback/sessions), a
 *    display title, and the web-chosen `playId` cross the bridge. No magnets,
 *    tokens, or credentials.
 *  - Error surfaces are GENERIC: AVFoundation error text is never forwarded
 *    (it can embed request context); the web layer owns actionable copy.
 *  - Every event carries `playId`, so events from a replaced (dying) player
 *    can never be attributed to the new session.
 *  - Exactly one terminal state per playback, guarded by `terminalSent`.
 *  - All observers/time-observers/player items are torn down on dismiss or
 *    replacement.
 *
 * Subtitles (honest scope): HLS renditions that declare WebVTT via
 * #EXT-X-MEDIA are handled natively by AVPlayer's media-selection UI.
 * Standalone sidecar WebVTT files CANNOT be attached to AVPlayer without a
 * custom renderer — this is a documented device follow-up, not a claimed
 * feature.
 *
 * Build note: this file is part of the App target; compiling requires
 * Xcode/macOS. BLOCKED ON MAC/XCODE — never validated on this Windows host.
 */
@objc(TorWatchNativePlugin)
class TorWatchNativePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TorWatchNativePlugin"
    public let jsName = "TorWatchNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
    ]

    private var playerViewController: TorWatchPlayerViewController?

    // MARK: - Bridge API

    @objc func play(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("The playback URL is missing or invalid.")
            return
        }
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        let title = call.getString("title") ?? "TorWatch"
        let seekTo = call.getDouble("seekTo")

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Replace any existing session cleanly (observers included).
            self.teardownPlayer()
            let controller = TorWatchPlayerViewController(
                url: url,
                title: title,
                seekTo: seekTo,
                playId: playId,
                eventSink: { [weak self] name, data in
                    self?.notifyListeners(name, data: data)
                },
                onDismissed: { [weak self] in
                    if self?.playerViewController?.hasPlayId(playId) == true {
                        self?.playerViewController = nil
                    }
                }
            )
            self.playerViewController = controller
            let presenting = self.currentPresentationViewController()
            presenting.present(controller, animated: true) {
                controller.startPlayback()
            }
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("positionSec") ?? 0
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            if let controller = self?.playerViewController, controller.hasPlayId(playId) {
                controller.seek(toSeconds: position)
            }
            call.resolve()
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let controller = self.playerViewController, controller.hasPlayId(playId) {
                // teardownPlayer runs in the dismissal completion; the explicit
                // call here covers the JS-initiated close where the delegate
                // callback may not fire first.
                controller.dismissAndTeardown()
                self.playerViewController = nil
            }
            call.resolve()
        }
    }

    // MARK: - Helpers

    private func currentPresentationViewController() -> UIViewController {
        var candidate: UIViewController? = self.bridge?.viewController
        while let presented = candidate?.presentedViewController, !presented.isBeingDismissed {
            candidate = presented
        }
        return candidate ?? UIViewController()
    }

    private func teardownPlayer() {
        playerViewController?.dismissAndTeardown()
        playerViewController = nil
    }
}

/**
 * Full-screen AVPlayerViewController with observer hygiene and honest
 * interruption/background handling.
 */
class TorWatchPlayerViewController: AVPlayerViewController {

    private var timeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var interruptionObserver: NSObjectProtocol?
    private var endedObserver: NSObjectProtocol?
    private var terminalSent = false
    private let playId: String
    private let eventSink: (String, [String: Any]) -> Void
    private let onDismissed: () -> Void

    init(
        url: URL,
        title: String,
        seekTo: Double?,
        playId: String,
        eventSink: @escaping (String, [String: Any]) -> Void,
        onDismissed: @escaping () -> Void
    ) {
        self.playId = playId
        self.eventSink = eventSink
        self.onDismissed = onDismissed

        let playerItem = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: playerItem)
        super.init(nibName: nil, bundle: nil)
        self.player = player
        self.title = title
        // Rotation is NOT forced: follow the device/app supported orientations.
        self.modalPresentationStyle = .fullScreen
        self.entersFullScreenWhenPlaybackBegins = true

        // Periodic time updates for progress heartbeats (bounded cadence).
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 10),
            queue: .main
        ) { [weak self] time in
            guard let self = self, !self.terminalSent else { return }
            let duration = self.player?.currentItem?.duration.seconds ?? 0
            self.eventSink("timeUpdate", [
                "currentTime": time.seconds.isFinite ? time.seconds : 0,
                "duration": duration.isFinite ? duration : 0,
                "playId": self.playId,
            ])
        }

        // Item status: terminal error reporting (exactly once, generic text).
        statusObserver = playerItem.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard let self = self, !self.terminalSent else { return }
            switch item.status {
            case .failed:
                self.terminalSent = true
                // Generic message ONLY: AVFoundation error text can embed
                // request context; the web layer owns actionable copy.
                self.eventSink("playbackState", [
                    "state": "error",
                    "message": "The media could not be played on this device.",
                    "playId": self.playId,
                ])
            case .readyToPlay:
                if let seekTo = seekTo, seekTo > 0 {
                    player.seek(
                        to: CMTime(seconds: seekTo, preferredTimescale: 600),
                        toleranceBefore: .zero,
                        toleranceAfter: CMTime(seconds: 0.5, preferredTimescale: 600)
                    )
                }
            default:
                break
            }
        }

        // Playback end: exactly-once terminal.
        endedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, !self.terminalSent else { return }
            self.terminalSent = true
            self.eventSink("playbackState", ["state": "ended", "playId": self.playId])
        }

        // Audio interruptions (calls, alarms): honest paused state to the app.
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let info = notification.userInfo,
                  let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
            switch type {
            case .began:
                self.eventSink("playbackState", [
                    "state": "paused",
                    "message": "Audio interrupted.",
                    "playId": self.playId,
                ])
            case .ended:
                self.eventSink("playbackState", ["state": "playing", "playId": self.playId])
            @unknown default:
                break
            }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    func startPlayback() {
        setUpAudioSession()
        player?.play()
    }

    func seek(toSeconds: Double) {
        player?.seek(
            to: CMTime(seconds: toSeconds, preferredTimescale: 600),
            toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 600),
            toleranceAfter: CMTime(seconds: 1, preferredTimescale: 600)
        )
    }

    func hasPlayId(_ candidate: String) -> Bool {
        return playId == candidate
    }

    func dismissAndTeardown() {
        if presentingViewController != nil {
            dismiss(animated: true) { [weak self] in
                self?.fullTeardown()
                self?.onDismissed()
            }
        } else {
            fullTeardown()
            onDismissed()
        }
    }

    /// User dismissal (Done button / swipe): notify 'stopped' exactly once so
    /// the JS session client can delete the server session.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if presentedViewController == nil && !terminalSent {
            terminalSent = true
            eventSink("playbackState", ["state": "stopped", "playId": playId])
            fullTeardown()
            onDismissed()
        }
    }

    private func fullTeardown() {
        if let timeObserver = timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        statusObserver?.invalidate()
        statusObserver = nil
        if let interruptionObserver = interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
        if let endedObserver = endedObserver {
            NotificationCenter.default.removeObserver(endedObserver)
        }
        endedObserver = nil
        player?.pause()
        player = nil
    }

    /// Playback category so audio respects the device's silent switch and
    /// interruption contract. No background-audio entitlement is claimed.
    private func setUpAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}
