import Foundation
import AVFoundation
import UIKit
import Capacitor
import MobileVLCKit

/**
 * TorWatchNativePlugin (M1.4.7 VLC layer) — MobileVLCKit playback BEHIND the
 * Capacitor WebView.
 *
 * Architecture (desktop-equivalent UI):
 *  - The VLC surface is inserted at index 0 of the bridge view controller's
 *    view, and the WebView is made transparent while a surface is attached,
 *    so EVERY control (loading overlay, seek bar, subtitle/audio sheets,
 *    skip-intro chip) is the shared React UI — one implementation for both
 *    platforms.
 *  - VLC demuxes the ORIGINAL file directly: embedded audio/subtitle tracks
 *    stay intact; the inventory is reported via `tracksUpdate` and selection
 *    happens without a playback restart. Runtime subtitles (OpenSubtitles,
 *    torrent sidecars, local imports) attach through playback slaves.
 *
 * Security/privacy invariants (unchanged):
 *  - Only OPAQUE playback/subtitle URLs from /v2/playback/sessions, a display
 *    title, and the web-chosen playId cross the bridge. No magnets, tokens,
 *    or credentials.
 *  - Every event carries `playId`; events from a replaced (dying) player are
 *    dropped web-side.
 *  - Exactly one terminal state per playback, guarded by `terminalSent`.
 *  - Error text is GENERIC (player internals never cross the bridge).
 *
 * Setup note: MobileVLCKit is consumed as a pinned binary via the local SPM
 * package `ios/App/VLCDependency` (outside Capacitor's generated CapApp-SPM).
 * Run `npm run setup:ios-vlc` on the Mac before opening Xcode: it downloads
 * the checksum-verified official 3.7.3 XCFramework into that package.
 */
@objc(TorWatchNativePlugin)
class TorWatchNativePlugin: CAPPlugin, CAPBridgedPlugin, VLCMediaPlayerDelegate {

    public let identifier = "TorWatchNativePlugin"
    public let jsName = "TorWatchNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekBy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "togglePlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectAudioTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectSubtitleTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleDelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAudioDelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVideoScale", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackOrientation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
    ]

    private var mediaPlayer: VLCMediaPlayer?
    private var surfaceView: UIView?
    private var playId = ""
    private var terminalSent = false
    // Video scale preference: "fit" letterboxes the full picture inside the
    // drawable; "fill" center-crops the source to the drawable's aspect so the
    // video covers the display (never stretched).
    private var videoScaleMode: String = "fit"
    // Initial sidecar subtitles attach as soon as the media opens (VLC slaves
    // need a live demuxer; they never force a restart).
    private var pendingSubtitleURLs: [URL] = []
    private var pendingSeek: Double?
    private var backgroundObserver: NSObjectProtocol?
    private var rotationObserver: NSObjectProtocol?
    private var subtitleDownloads: [URLSessionDownloadTask] = []
    private var subtitleFiles: [URL] = []

    // MARK: - Bridge API

    @objc func play(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("The playback URL is missing or invalid.")
            return
        }
        guard let newPlayId = call.getString("playId"), !newPlayId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        let seekTo = call.getDouble("seekTo")
        var sidecars: [URL] = []
        for item in call.getArray("subtitles") ?? [] {
            guard let dict = item as? [String: Any],
                  let sidecarString = dict["url"] as? String,
                  let sidecarURL = URL(string: sidecarString) else { continue }
            sidecars.append(sidecarURL)
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge, let rootVC = bridge.viewController else {
                call.reject("The player surface is unavailable.")
                return
            }
            // Replacement safety: tear the previous player down BEFORE creating
            // the new one; late events from it are ignored via terminalSent.
            self.teardown()
            self.playId = newPlayId
            self.terminalSent = false
            self.pendingSubtitleURLs = sidecars

            // TEMPORARY diagnosis: libvlc's failure reasons print to the Xcode
            // console — but ONLY via the SHARED library instance. A private
            // VLCMediaPlayer(options:) library bypasses shared-library loggers,
            // so the player uses the shared library and takes media-level
            // options instead. Remove once playback is verified on device.
            // (Modern non-deprecated logger API: libvlc always reports errors.)
            VLCLibrary.shared().loggers = [VLCConsoleLogger()]
            let player = VLCMediaPlayer()
            player.delegate = self

            let surface = UIView(frame: rootVC.view.bounds)
            surface.backgroundColor = .black
            surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            // Index 0: BEHIND the WebView. The WebView becomes transparent
            // while the surface is attached (restored on teardown).
            rootVC.view.insertSubview(surface, at: 0)
            self.surfaceView = surface
            self.makeWebViewTransparent(true)

            let media = VLCMedia(url: url)
            // Media-level equivalent of the previous --network-caching=4000:
            // a deeper buffer absorbs peer-driven throughput dips.
            media.addOptions([":network-caching": 4000])
            player.media = media
            player.drawable = surface

            TorWatchPlaybackState.videoAttached = true
            self.requestOrientation(true)
            self.applyVideoScale(player)
            try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try? AVAudioSession.sharedInstance().setActive(true)
            UIApplication.shared.isIdleTimerDisabled = true
            self.backgroundObserver = NotificationCenter.default.addObserver(
                forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                if self?.mediaPlayer?.isPlaying == true { self?.mediaPlayer?.pause() }
            }
            // Fill mode crops to the DRAWABLE's aspect ratio: recompute when
            // the device rotates or the window resizes (tablet multitasking).
            self.rotationObserver = NotificationCenter.default.addObserver(
                forName: UIDevice.orientationDidChangeNotification, object: nil, queue: .main
            ) { [weak self] _ in
                guard let self = self, let player = self.mediaPlayer else { return }
                self.applyVideoScale(player)
            }
            self.mediaPlayer = player
            self.pendingSeek = seekTo
            player.play()
            call.resolve()
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.seek(call) }; return }
        guard let position = call.getDouble("positionSec"),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        if position.isFinite { pendingSeek = position; applyPendingSeek(player) }
        call.resolve()
    }

    @objc func togglePlayback(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.togglePlayback(call) }; return }
        guard let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        if player.isPlaying {
            player.pause()
        } else {
            player.play()
        }
        call.resolve()
    }

    @objc func seekBy(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.seekBy(call) }; return }
        guard let delta = call.getDouble("deltaSeconds"),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        if delta.isFinite {
            pendingSeek = Double(player.time.intValue) / 1000.0 + delta
            applyPendingSeek(player)
        }
        call.resolve()
    }

    @objc func selectAudioTrack(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.selectAudioTrack(call) }; return }
        guard let trackId = call.getInt("trackId"),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        player.currentAudioTrackIndex = Int32(trackId)
        emitTracks()
        call.resolve()
    }

    @objc func selectSubtitleTrack(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.selectSubtitleTrack(call) }; return }
        guard let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        // null / -1 disables subtitles.
        let trackId = call.getInt("trackId") ?? -1
        player.currentVideoSubTitleIndex = Int32(trackId)
        emitTracks()
        call.resolve()
    }

    @objc func setSubtitleDelay(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setSubtitleDelay(call) }; return }
        guard let seconds = call.getDouble("seconds"),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        // MobileVLCKit delays are MICROSECONDS; positive = displayed later.
        if seconds.isFinite { player.currentVideoSubTitleDelay = Int(max(-30, min(30, seconds)) * 1_000_000.0) }
        call.resolve()
    }

    @objc func setAudioDelay(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setAudioDelay(call) }; return }
        guard let seconds = call.getDouble("seconds"),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.resolve()
            return
        }
        if seconds.isFinite { player.currentAudioPlaybackDelay = Int(max(-30, min(30, seconds)) * 1_000_000.0) }
        call.resolve()
    }

    /// Fit letterboxes the complete picture inside the drawable; Fill
    /// center-crops the source to the drawable's aspect ratio so the video
    /// covers the display. Neither mode ever stretches the picture.
    @objc func setVideoScale(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setVideoScale(call) }; return }
        let mode = call.getString("mode") ?? "fit"
        guard mode == "fit" || mode == "fill" else {
            call.reject("Unknown video scale mode.")
            return
        }
        videoScaleMode = mode
        if let player = mediaPlayer { applyVideoScale(player) }
        call.resolve()
    }

    private func applyVideoScale(_ player: VLCMediaPlayer) {
        if videoScaleMode == "fill" {
            if let size = surfaceView?.bounds.size, size.width > 1, size.height > 1 {
                setCropGeometry(aspectRatioString(size), on: player)
            }
        } else {
            setCropGeometry(nil, on: player) // libvlc default: aspect-fit letterbox
        }
    }

    /// MobileVLCKit's `videoCropGeometry` is a raw `char *` property: bridge a
    /// Swift String through a C copy that libvlc's var system takes ownership
    /// of (var_SetString duplicates), then release our buffer immediately.
    private func setCropGeometry(_ geometry: String?, on player: VLCMediaPlayer) {
        guard let geometry = geometry else {
            player.videoCropGeometry = nil
            return
        }
        geometry.withCString { pointer in
            let copy = strdup(pointer)
            player.videoCropGeometry = copy
            free(copy)
        }
    }

    /// "W:H" with the canonical reduced form libvlc expects ("16:9").
    private func aspectRatioString(_ size: CGSize) -> String {
        let width = Int(round(size.width * 100))
        let height = Int(round(size.height * 100))
        var a = width, b = height
        while b != 0 { (a, b) = (b, a % b) }
        let gcd = max(a, 1)
        return "\(width / gcd):\(height / gcd)"
    }

    /// Orientation handoff from the web layer: locks landscape the moment the
    /// user enters playback (before metadata/session preparation) so the
    /// loading surface is already landscape; restores on close/failure.
    /// A denied request (iPad multitasking constraints, scene absent) resolves
    /// harmlessly — playback continues unrotated.
    @objc func setPlaybackOrientation(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setPlaybackOrientation(call) }; return }
        let landscape = call.getBool("landscape") ?? true
        TorWatchPlaybackState.videoAttached = landscape
        requestOrientation(landscape)
        call.resolve()
    }

    @objc func loadSubtitle(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.loadSubtitle(call) }; return }
        guard let urlString = call.getString("url"), let url = URL(string: urlString),
              let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let player = mediaPlayer else {
            call.reject("The subtitle URL is missing or playback is inactive.")
            return
        }
        // Download first so HTTP failures are reported, and VLC receives a
        // local file with a known extension. The active movie is never reloaded.
        let task = URLSession.shared.downloadTask(with: url) { [weak self, weak player] temporary, response, error in
            guard error == nil, let temporary = temporary,
                  let response = response as? HTTPURLResponse, (200...299).contains(response.statusCode) else {
                call.reject("The subtitle could not be downloaded. Try another file.")
                return
            }
            let type = response.mimeType ?? ""
            let ext = type.contains("ssa") ? "ass" : type.contains("subrip") ? "srt" : "vtt"
            let destination = FileManager.default.temporaryDirectory.appendingPathComponent("torwatch-sub-\(UUID().uuidString).\(ext)")
            do {
                let attributes = try FileManager.default.attributesOfItem(atPath: temporary.path)
                let size = (attributes[.size] as? NSNumber)?.intValue ?? 0
                guard size > 0 && size <= 4 * 1024 * 1024 else {
                    call.reject("Choose a non-empty subtitle file up to 4 MiB.")
                    return
                }
                try FileManager.default.moveItem(at: temporary, to: destination)
            } catch {
                call.reject("The subtitle could not be saved on this device.")
                return
            }
            DispatchQueue.main.async {
                guard let self = self, let player = player, player === self.mediaPlayer,
                      requestPlayId == self.playId, !self.terminalSent else {
                    try? FileManager.default.removeItem(at: destination)
                    call.reject("Playback changed before the subtitle finished loading.")
                    return
                }
                guard player.addPlaybackSlave(destination, type: .subtitle, enforce: true) == 0 else {
                    try? FileManager.default.removeItem(at: destination)
                    call.reject("The subtitle could not be loaded.")
                    return
                }
                self.subtitleFiles.append(destination)
                self.subtitleDownloads.removeAll { $0.state == .completed }
                self.emitTracks()
                call.resolve()
            }
        }
        subtitleDownloads.append(task)
        task.resume()
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.dismiss(call) }; return }
        guard let requestPlayId = call.getString("playId"), requestPlayId == playId else {
            call.resolve()
            return
        }
        if !terminalSent {
            terminalSent = true
            notifyListeners("playbackState", data: ["state": "stopped", "playId": playId])
        }
        teardown()
        call.resolve()
    }

    // MARK: - VLCMediaPlayerDelegate

    func mediaPlayerTimeChanged(_ notification: Notification) {
        guard !terminalSent, let player = notification.object as? VLCMediaPlayer,
              player === mediaPlayer else { return }
        applyPendingSeek(player)
        let duration = player.media?.length.intValue ?? 0
        notifyListeners("timeUpdate", data: [
            "currentTime": Double(player.time.intValue) / 1000.0,
            "duration": Double(max(duration, 0)) / 1000.0,
            "playId": playId,
        ])
    }

    func mediaPlayerStateChanged(_ aNotificationName: Notification) {
        guard !terminalSent, let player = aNotificationName.object as? VLCMediaPlayer,
              player === mediaPlayer else { return }
        switch player.state {
        case .buffering:
            notifyListeners("buffering", data: ["active": true, "playId": playId])
        case .playing:
            applyPendingSeek(player)
            attachPendingSubtitles()
            notifyListeners("buffering", data: ["active": false, "playId": playId])
            notifyListeners("playbackState", data: ["state": "playing", "playId": playId])
            emitTracks()
        case .paused:
            notifyListeners("playbackState", data: ["state": "paused", "playId": playId])
        case .ended:
            terminalSent = true
            notifyListeners("playbackState", data: ["state": "ended", "playId": playId])
        case .error:
            terminalSent = true
            // Generic message ONLY: VLC internals never cross the bridge.
            notifyListeners("playbackState", data: [
                "state": "error",
                "message": "The media could not be played on this device.",
                "playId": playId,
            ])
        case .esAdded:
            // New elementary streams (or an attached subtitle) settled: report
            // the inventory and flush pending initial sidecars.
            attachPendingSubtitles()
            emitTracks()
        default:
            break
        }
    }

    // MARK: - Internals

    private func applyPendingSeek(_ player: VLCMediaPlayer) {
        guard let seconds = pendingSeek, seconds.isFinite, player.isSeekable else { return }
        pendingSeek = nil
        let duration = Double(player.media?.length.intValue ?? 0)
        let upper = duration > 0 ? duration : Double(Int32.max)
        player.time = VLCTime(int: Int32(max(0, min(upper, seconds * 1000))))
    }

    private func attachPendingSubtitles() {
        guard let player = mediaPlayer, !pendingSubtitleURLs.isEmpty else { return }
        let remaining = pendingSubtitleURLs
        pendingSubtitleURLs = []
        for url in remaining {
            player.addPlaybackSlave(url, type: .subtitle, enforce: false)
        }
    }

    private func emitTracks() {
        guard let player = mediaPlayer else { return }
        var audio: [[String: Any]] = []
        let audioNames = player.audioTrackNames
        let audioIndexes = player.audioTrackIndexes
        for (index, name) in audioNames.enumerated() where index < audioIndexes.count {
            guard let id = (audioIndexes[index] as? NSNumber)?.int32Value, id >= 0 else { continue }
            audio.append(["id": id, "label": name])
        }
        var subs: [[String: Any]] = []
        // Header-verified names: videoSubTitlesNames / videoSubTitlesIndexes.
        let subNames = player.videoSubTitlesNames
        let subIndexes = player.videoSubTitlesIndexes
        for (index, name) in subNames.enumerated() where index < subIndexes.count {
            guard let id = (subIndexes[index] as? NSNumber)?.int32Value, id >= 0 else { continue }
            subs.append(["id": id, "label": name])
        }
        notifyListeners("tracksUpdate", data: ["audio": audio, "subtitles": subs, "playId": playId,
            "selectedAudioTrackId": player.currentAudioTrackIndex,
            "selectedSubtitleTrackId": player.currentVideoSubTitleIndex])
    }

    private func makeWebViewTransparent(_ transparent: Bool) {
        guard let webView = bridge?.webView else { return }
        webView.isOpaque = !transparent
        webView.backgroundColor = transparent ? .clear : .black
        webView.scrollView.backgroundColor = transparent ? .clear : .black
    }

    /// Video plays landscape; the web app underneath stays portrait.
    private func requestOrientation(_ landscape: Bool) {
        guard let scene = bridge?.viewController?.view.window?.windowScene else { return }
        TorWatchPlaybackState.videoAttached = landscape
        if #available(iOS 16.0, *) {
            bridge?.viewController?.setNeedsUpdateOfSupportedInterfaceOrientations()
            scene.requestGeometryUpdate(.iOS(interfaceOrientations: landscape ? .landscape : .portrait)) { _ in
                // Rotation failures are non-fatal: the user can still rotate
                // the device manually within the app's supported set.
            }
        } else {
            let value: UIDeviceOrientation = landscape ? .landscapeRight : .portrait
            UIDevice.current.setValue(value.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }

    /** Full teardown: bounded, idempotent, surface + background restored. */
    private func teardown() {
        terminalSent = true
        playId = ""
        pendingSeek = nil
        subtitleDownloads.forEach { $0.cancel() }
        subtitleDownloads.removeAll()
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        backgroundObserver = nil
        if let observer = rotationObserver { NotificationCenter.default.removeObserver(observer) }
        rotationObserver = nil
        UIApplication.shared.isIdleTimerDisabled = false
        if let player = mediaPlayer {
            player.delegate = nil
            player.stop()
            player.drawable = nil
        }
        mediaPlayer = nil
        subtitleFiles.forEach { try? FileManager.default.removeItem(at: $0) }
        subtitleFiles.removeAll()
        surfaceView?.removeFromSuperview()
        surfaceView = nil
        pendingSubtitleURLs = []
        makeWebViewTransparent(false)
        if TorWatchPlaybackState.videoAttached {
            requestOrientation(false)
        }
    }
}

/// Shared playback-state flags consulted by the app bridge view controller.
enum TorWatchPlaybackState {
    // When true, MainViewController permits landscape (video attached).
    static var videoAttached = false
}
