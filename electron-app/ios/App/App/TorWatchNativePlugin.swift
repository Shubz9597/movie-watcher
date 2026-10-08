import Foundation
import AVFoundation
import UIKit
import Capacitor
import MobileVLCKit
import VLCSupport

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
        CAPPluginMethod(name: "playLocal", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seekBy", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "togglePlayback", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectAudioTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "selectSubtitleTrack", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleDelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAudioDelay", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVideoScale", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleScale", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setPlaybackOrientation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadSubtitle", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
    ]

    private var mediaPlayer: VLCMediaPlayer?
    private var surfaceView: VideoSurfaceView?
    private var playId = ""
    private var terminalSent = false

    /// Capacitor calls load() when the webview boots the bridge: register the
    /// local-playback stop hook here (removal-while-playing safety).
    override public func load() {
        super.load()
        localStopObserver = NotificationCenter.default.addObserver(
            forName: .torwatchStopLocalPlayback, object: nil, queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let downloadId = notification.object as? String,
                  self.localDownloadId == downloadId else { return }
            self.persistLocalProgress(state: "stopped")
            self.teardown()
        }
    }
    // Size the drawable with UIKit, without changing VLC's crop/aspect or
    // seeking. This also updates the displayed picture while paused.
    private var videoScaleMode: String = "fit"
    private var playbackRequested = true
    private var pausedPositionMs: Int32?
    // Current media + subtitle text scale (% of default), kept so the engine
    // can be recreated in place when the user pinch-resizes embedded subs.
    private var currentMediaURL: URL?
    private var currentSubTextScale: Int = 75
    private var pendingSeek: Double?
    private var backgroundObserver: NSObjectProtocol?
    private var activeObserver: NSObjectProtocol?
    private var subtitleDownloads: [URLSessionDownloadTask] = []
    private var subtitleFiles: [URL] = []
    // Offline-downloads D04: when set, the current playback is a LOCAL
    // download — no server session, no metadata fetch, no heartbeat; progress
    // persists in the device store (pause/seek/checkpoint/exit).
    private var localDownloadId: String?
    private var lastLocalProgressSave = Date.distantPast
    private var localStopObserver: NSObjectProtocol?

    // MARK: - Local download playback (offline-downloads D04)

    /// Plays a VERIFIED local download: the file URL comes from the device
    /// store via TorWatchDownloads.localPlayablePath — never from web-supplied
    /// filesystem paths. Local start issues ZERO server/provider requests.
    @objc func playLocal(_ call: CAPPluginCall) {
        guard let downloadId = call.getString("downloadId"), !downloadId.isEmpty else {
            call.reject("The download identifier is missing.")
            return
        }
        guard let files = try? DownloadCoordinator.shared.store.readyFileURLs(downloadId) else {
            call.reject("That download is not ready for offline playback.")
            return
        }
        guard let newPlayId = call.getString("playId"), !newPlayId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        // Durable local progress: resume 15s before where the device left
        // off (same as streamed Continue watching); a finished episode
        // (90%+) starts over.
        let saved = DownloadCoordinator.shared.store.loadProgress(downloadId)
        let seekTo = call.getDouble("seekTo") ?? saved.flatMap { progress -> Double? in
            if progress.durationS > 0 && progress.positionS >= progress.durationS * 0.9 { return nil }
            return progress.positionS > 15 ? progress.positionS - 15 : nil
        }
        // Subtitle choice: an explicit request wins, then the viewer's last
        // choice ("" = they turned subtitles off), and on FIRST play the
        // language requested when the download was created.
        let subtitleLang = call.getString("subtitleLang")
            ?? saved?.subtitleLang
            ?? files.subtitles.first?.lang
            ?? ""

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge, let rootVC = bridge.viewController else {
                call.reject("The player surface is unavailable.")
                return
            }
            self.videoScaleMode = TorWatchNativePlugin.savedVideoScaleMode() // the viewer's last Fit/Fill choice
            self.currentMediaURL = files.video
            self.startPlaybackSurface(rootVC: rootVC, url: files.video, seekTo: seekTo, playId: newPlayId, localDownloadId: downloadId)
            self.attachLocalSidecars(selecting: subtitleLang)
            call.resolve(["resumedPositionS": seekTo ?? 0])
        }
    }

    /// Attaches EVERY downloaded subtitle so the viewer can switch languages;
    /// only the chosen one is enforced (selected).
    private func attachLocalSidecars(selecting lang: String) {
        guard let downloadId = localDownloadId,
              let files = try? DownloadCoordinator.shared.store.readyFileURLs(downloadId) else { return }
        for sidecar in files.subtitles {
            let selected = !lang.isEmpty && sidecar.lang == lang
            _ = mediaPlayer?.addPlaybackSlave(sidecar.url, type: .subtitle, enforce: selected)
        }
    }

    /// Removal while playing: the surface must close BEFORE the files go
    /// (contracts.md §native: stop active local playback before deleting).
    /// The notification is observed by the plugin instance below.
    @objc static func stopLocalPlaybackIfActive(downloadId: String) {
        NotificationCenter.default.post(
            name: .torwatchStopLocalPlayback, object: downloadId)
    }

    private func persistLocalProgress(state: String) {
        guard let downloadId = localDownloadId, let player = mediaPlayer else { return }
        let position = Double(player.time.intValue) / 1000.0
        let duration = Double(player.media?.length.intValue ?? 0) / 1000.0
        try? DownloadCoordinator.shared.store.saveProgress(
            downloadId, positionS: position, durationS: duration,
            subtitleLang: currentLocalSubtitleLang(player))
        if !terminalSent {
            notifyListeners("localProgress", data: [
                "downloadId": downloadId,
                "positionS": position,
                "durationS": duration,
                "state": state,
                "playId": playId,
            ])
        }
    }

    private func currentLocalSubtitleLang(_ player: VLCMediaPlayer) -> String {
        // Track selection persistence: map the selected external slave back
        // to its language by matching the sidecar list (embedded tracks keep
        // selection inside the container itself).
        guard let localDownloadId = localDownloadId,
              let files = try? DownloadCoordinator.shared.store.readyFileURLs(localDownloadId),
              !files.subtitles.isEmpty else { return "" }
        let selected = player.currentVideoSubTitleIndex
        guard selected > 0 else { return "" }
        let externalIndex = Int(player.numberOfSubtitlesTracks) - files.subtitles.count
        let position = Int(selected) - externalIndex
        return position >= 0 && position < files.subtitles.count ? files.subtitles[position].lang : ""
    }

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
        // Subtitle text scale (%) from the device preference (pinch on the
        // video persists it); applied to the freshly created engine.
        let requestedScale = Int(call.getDouble("subTextScale") ?? Double(currentSubTextScale))
        currentSubTextScale = max(25, min(200, requestedScale))
        currentMediaURL = url
        localDownloadId = nil // remote session playback: local progress N/A

        DispatchQueue.main.async { [weak self] in
            guard let self = self, let bridge = self.bridge, let rootVC = bridge.viewController else {
                call.reject("The player surface is unavailable.")
                return
            }
            self.videoScaleMode = TorWatchNativePlugin.savedVideoScaleMode() // the viewer's last Fit/Fill choice
            self.startPlaybackSurface(rootVC: rootVC, url: url, seekTo: seekTo, playId: newPlayId, localDownloadId: nil)
            call.resolve()
        }
    }

    /// Creates the VLC player + surface for [url] and starts playback. Shared
    /// by play() (fresh start) and setSubtitleScale() (in-place engine
    /// recreation when embedded subtitles are active and the user pinch-
    /// resizes — libvlc has no runtime text-scale API, so the engine rebuilds
    /// at the current position with a ~1s hiccup).
    private func startPlaybackSurface(rootVC: UIViewController, url: URL, seekTo: Double?, playId newPlayId: String, localDownloadId newLocalDownloadId: String?) {
        // Replacement safety: tear the previous player down BEFORE creating
        // the new one; late events from it are ignored via terminalSent. The
        // orientation stays landscape: restoring portrait here rotated every
        // new video portrait-then-landscape.
        teardown(restoreOrientation: false)
        // Set after teardown, which clears it: a download played with this id
        // unset never saved progress (always resumed at 0, never synced).
        localDownloadId = newLocalDownloadId
        playId = newPlayId
        terminalSent = false

        // sub-text-scale = % of default subtitle size (user-tunable via the
        // pinch gesture; 75 = a touch smaller than default for phones).
        let player = VLCMediaPlayer(options: [
            "--audio-time-stretch",
            "--network-caching=1000", // server prebuffers the torrent; keep decoder catch-up bounded
            "--no-input-fast-seek", // resume at the timestamp, not the preceding keyframe
            "--sub-text-scale=\(currentSubTextScale)",
        ])
        player.delegate = self

        let surface = VideoSurfaceView(frame: rootVC.view.bounds)
        // Use the actual viewport, including iPad split view or a denied
        // rotation request. Recompute only the layout when that size changes.
        surface.onResize = { [weak self] in
            guard let self = self, let player = self.mediaPlayer else { return }
            self.applyVideoScale(player)
        }
        surface.backgroundColor = .black
        surface.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        // Index 0: BEHIND the WebView. The WebView becomes transparent
        // while the surface is attached (restored on teardown).
        rootVC.view.insertSubview(surface, at: 0)
        surfaceView = surface
        makeWebViewTransparent(true)

        let media = VLCMedia(url: url)
        player.media = media
        player.drawable = surface.drawableView

        TorWatchPlaybackState.videoAttached = true
        requestOrientation(true)
        applyVideoScale(player)
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
        UIApplication.shared.isIdleTimerDisabled = true
        // Pause only when the app really leaves the screen: willResignActive
        // also fires for Control Center, Notification Center and Siri, which
        // paused the film every time the viewer adjusted brightness.
        backgroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self, let player = self.mediaPlayer, self.playbackRequested else { return }
            self.pausePlayback(player)
        }
        mediaPlayer = player
        pendingSeek = seekTo
        playbackRequested = true
        pausedPositionMs = nil
        player.play()
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
        if playbackRequested {
            pausePlayback(player)
        } else {
            // Flush queued pre-pause audio/video at the exact pause position.
            // Normal unpause can replay the old decoder queue while its
            // picture waits for the clock to catch up. Never rewind here.
            if pendingSeek == nil, let position = pausedPositionMs, player.isSeekable {
                player.time = VLCTime(int: position)
            }
            pausedPositionMs = nil
            playbackRequested = true
            player.play()
        }
        call.resolve()
    }

    private func pausePlayback(_ player: VLCMediaPlayer) {
        playbackRequested = false
        pausedPositionMs = max(0, player.time.intValue)
        player.pause()
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

    /// Fit preserves the full picture; Fill crops; Stretch fills both axes.
    private static let videoScaleModeKey = "torwatch.videoScaleMode"

    /// Every video starts with the viewer's last sizing choice.
    private static func savedVideoScaleMode() -> String {
        let saved = UserDefaults.standard.string(forKey: videoScaleModeKey) ?? "fit"
        return saved == "fill" || saved == "stretch" ? saved : "fit"
    }

    @objc func setVideoScale(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setVideoScale(call) }; return }
        let mode = call.getString("mode") ?? "fit"
        guard mode == "fit" || mode == "fill" || mode == "stretch" else {
            call.reject("Unknown video scale mode.")
            return
        }
        guard call.getString("playId") == playId else { call.resolve(); return }
        videoScaleMode = mode
        UserDefaults.standard.set(mode, forKey: TorWatchNativePlugin.videoScaleModeKey)
        if let player = mediaPlayer {
            applyVideoScale(player)
        }
        call.resolve()
    }

    /// Keep VLC in its natural aspect and transform the containing drawable.
    /// VLC 3.x's iOS output can ignore source crop/aspect changes when its
    /// display configuration compares equal. UIKit transforms bypass that
    /// path and keep the decoder and current playback timestamp intact.
    private func applyVideoScale(_ player: VLCMediaPlayer) {
        guard let surface = surfaceView else { return }
        let size = player.videoSize
        guard player.hasVideoOut, size.width > 0, size.height > 0 else { return }
        var aspect = size.width / size.height
        // Account for anamorphic pixels, using the selected video track.
        for case let track as [String: Any] in player.media?.tracksInformation ?? [] {
            guard (track[VLCMediaTracksInformationId] as? NSNumber)?.int32Value == player.currentVideoTrackIndex,
                  let numerator = track[VLCMediaTracksInformationSourceAspectRatio] as? NSNumber,
                  let denominator = track[VLCMediaTracksInformationSourceAspectRatioDenominator] as? NSNumber,
                  numerator.doubleValue > 0, denominator.doubleValue > 0 else { continue }
            aspect *= CGFloat(numerator.doubleValue / denominator.doubleValue)
            break
        }
        surface.apply(aspect: aspect, mode: videoScaleMode)
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

    /// Embedded-subtitle text scale (% of default, 25..200). Applied by
    /// recreating the engine at the current position — libvlc has no runtime
    /// text-scale API, so this carries a ~1s hiccup and only fires when
    /// embedded tracks are actually active (the web overlay resizes live).
    @objc func setSubtitleScale(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setSubtitleScale(call) }; return }
        let percent = max(25, min(200, Int(call.getDouble("percent") ?? 75)))
        guard let requestPlayId = call.getString("playId"), requestPlayId == playId,
              let url = currentMediaURL else {
            call.resolve()
            return
        }
        if percent == currentSubTextScale {
            call.resolve()
            return
        }
        currentSubTextScale = percent
        let positionMs = mediaPlayer?.time.intValue ?? 0
        let currentLocalDownload = localDownloadId
        let currentLocalLang = mediaPlayer.map { currentLocalSubtitleLang($0) } ?? ""
        // Same session continues server-side: no terminal event, just an
        // in-place engine rebuild at the current position (playback resumes).
        teardown(restoreOrientation: false)
        playId = requestPlayId
        terminalSent = false
        guard let bridge = self.bridge, let rootVC = bridge.viewController else {
            call.resolve()
            return
        }
        startPlaybackSurface(rootVC: rootVC, url: url, seekTo: Double(positionMs) / 1000.0, playId: requestPlayId, localDownloadId: currentLocalDownload)
        // Downloaded subtitles are playback slaves: a rebuilt engine has none
        // until they are attached again (resizing used to make them vanish).
        if currentLocalDownload != nil { attachLocalSidecars(selecting: currentLocalLang) }
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
        applyVideoScale(player) // video output may appear after the playing/ES callbacks
        // D04: periodic local-progress checkpoints every 10s (VLC reports
        // time several times a second; each save is a database write).
        if localDownloadId != nil, Date().timeIntervalSince(lastLocalProgressSave) >= 10 {
            lastLocalProgressSave = Date()
            persistLocalProgress(state: "checkpoint")
        }
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
            applyVideoScale(player) // the video size is known from here
            notifyListeners("buffering", data: ["active": false, "playId": playId])
            notifyListeners("playbackState", data: ["state": "playing", "playId": playId])
            emitTracks()
        case .paused:
            if localDownloadId != nil { persistLocalProgress(state: "paused") }
            notifyListeners("playbackState", data: ["state": "paused", "playId": playId])
        case .ended:
            if localDownloadId != nil { persistLocalProgress(state: "ended") }
            terminalSent = true
            notifyListeners("playbackState", data: ["state": "ended", "playId": playId])
        case .error:
            if localDownloadId != nil { persistLocalProgress(state: "error") }
            terminalSent = true
            // Generic message ONLY: VLC internals never cross the bridge.
            notifyListeners("playbackState", data: [
                "state": "error",
                "message": "The media could not be played on this device.",
                "playId": playId,
            ])
        case .esAdded:
            // New elementary streams (or an attached subtitle) settled.
            applyVideoScale(player)
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
        if !playbackRequested {
            // A scrub while paused becomes the new resume anchor.
            pausedPositionMs = Int32(max(0, min(upper, seconds * 1000)))
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

    /// Video plays landscape; the web app underneath stays portrait. The flag
    /// is recorded even when the window is not active (app in background):
    /// it is re-applied when the app becomes active again.
    private func requestOrientation(_ landscape: Bool) {
        TorWatchPlaybackState.videoAttached = landscape
        observeActivation()
        guard let scene = bridge?.viewController?.view.window?.windowScene else { return }
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

    /// Rotation requests made while the app is inactive are dropped by iOS;
    /// returning to the app re-asserts landscape (playing) or portrait.
    private func observeActivation() {
        guard activeObserver == nil else { return }
        activeObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            self?.requestOrientation(TorWatchPlaybackState.videoAttached)
        }
    }

    /** Full teardown: bounded, idempotent, surface + background restored.
     *  restoreOrientation is false when a new engine replaces this one. */
    private func teardown(restoreOrientation: Bool = true) {
        if localDownloadId != nil { persistLocalProgress(state: "stopped") }
        localDownloadId = nil
        terminalSent = true
        playId = ""
        pendingSeek = nil
        pausedPositionMs = nil
        playbackRequested = false
        subtitleDownloads.forEach { $0.cancel() }
        subtitleDownloads.removeAll()
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        backgroundObserver = nil
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
        makeWebViewTransparent(false)
        guard restoreOrientation else { return }
        // Let music or podcasts the player interrupted resume.
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        if TorWatchPlaybackState.videoAttached {
            requestOrientation(false)
        }
    }
}

/// A clipped viewport around a natural-aspect VLC drawable. The drawable's
/// bounds stay constant across mode changes; only its transform changes.
final class VideoSurfaceView: UIView {
    let drawableView = UIView()
    var onResize: (() -> Void)?
    private var lastSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        drawableView.frame = bounds
        addSubview(drawableView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(aspect: CGFloat, mode: String) {
        let layout = torwatch_video_layout(Double(bounds.width), Double(bounds.height),
            Double(aspect), mode == "fill" ? 1 : mode == "stretch" ? 2 : 0)
        guard layout.width > 0, layout.height > 0 else { return }
        let drawableBounds = CGRect(x: 0, y: 0, width: CGFloat(layout.width), height: CGFloat(layout.height))
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let transform = CGAffineTransform(scaleX: CGFloat(layout.scale_x), y: CGFloat(layout.scale_y))
        guard drawableView.bounds != drawableBounds || drawableView.center != center ||
              drawableView.transform != transform else { return }
        UIView.performWithoutAnimation {
            drawableView.bounds = drawableBounds
            drawableView.center = center
            drawableView.transform = transform
        }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != lastSize else { return }
        lastSize = bounds.size
        onResize?()
    }
}

/// Shared playback-state flags consulted by the app bridge view controller.
enum TorWatchPlaybackState {
    // When true, MainViewController permits landscape (video attached).
    static var videoAttached = false
}

extension Notification.Name {
    static let torwatchStopLocalPlayback = Notification.Name("torwatch.stop-local-playback")
}
