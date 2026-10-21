import Foundation
import AVFoundation
import UIKit
import Capacitor
import MediaPlayer
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
        CAPPluginMethod(name: "subtitleCapabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setDiagnosticsEndpoint", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSubtitleLayout", returnType: CAPPluginReturnPromise),
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
    // Track selection last sent to the controls (Int32.min: none sent yet).
    private var reportedAudioTrack: Int32 = Int32.min
    private var reportedSubtitleTrack: Int32 = Int32.min
    private var playbackRequested = true
    private var pausedPositionMs: Int32?
    // Current media + subtitle text scale (% of default), kept so the engine
    // can be recreated in place when the user pinch-resizes embedded subs.
    private var currentMediaURL: URL?
    private var currentSubTextScale: Int = 55
    // TorWatch's patched MobileVLCKit (npm run build:ios-vlc): VLC draws
    // text subtitles in the box itself and moves/resizes them while playing
    // (the official framework lacks it: the app draws the box instead).
    private static let boxedSubtitles = torwatch_vlc_has_subtitle_layout() != 0
    private var subtitleLiftPermille: Int32 = -1
    private var pendingSeek: Double?
    private var backgroundObserver: NSObjectProtocol?
    private var activeObserver: NSObjectProtocol?
    // The video track switched off while the app is in the background (see
    // releaseVideoForBackground), restored when the app returns.
    private var videoTrackBeforeBackground: Int32?
    // Names for a download's subtitle files, in attachment order. VLC lists
    // them after the video's own tracks as plain "Track N".
    private var localSidecarLabels: [String] = []
    // A call or another app took the audio (AVAudioSession interruption);
    // VLC's audio output must be rebuilt before playing again.
    private var interruptionObserver: NSObjectProtocol?
    private var audioNeedsRestart = false
    // Play that does not get going (VLC stuck on an audio output an alarm,
    // call or Siri left behind): the engine is rebuilt at the position.
    private var resumeWatchdog: DispatchWorkItem?
    // The audio track detached when an interruption began (VLC's own audio
    // output stays dead after an alarm or call: iOS seldom says "should
    // resume"), attached again, on a fresh output, at the next Play.
    private var audioTrackBeforeInterruption: Int32?

    /// Player events for diagnosis (the app sends them to the server's
    /// diagnostics/phone.log).
    private func diag(_ kind: String, _ detail: [String: Any] = [:]) {
        var data = detail
        if let player = mediaPlayer {
            // 0 stopped, 1 opening, 2 buffering, 3 ended, 4 error, 5 playing, 6 paused, 7 es-added
            data["vlcState"] = player.state.rawValue
            data["timeMs"] = Int(player.time.intValue)
            data["isPlaying"] = player.isPlaying
        }
        data["requested"] = playbackRequested
        data["app"] = UIApplication.shared.applicationState == .active ? "active"
            : UIApplication.shared.applicationState == .inactive ? "inactive" : "background"
        let at = Int64(Date().timeIntervalSince1970 * 1000)
        freezeLock.lock()
        recentDiagnostics.append(["at": at, "kind": kind, "detail": data])
        if recentDiagnostics.count > 40 { recentDiagnostics.removeFirst(recentDiagnostics.count - 40) }
        freezeLock.unlock()
        notifyListeners("diagnostic", data: ["kind": kind, "detail": data, "playId": playId, "at": at])
    }

    // MARK: - Freeze watcher
    // A player stuck in VLC can block the main thread: then the whole app
    // freezes and no event reaches the app's own reporting. A background
    // timer notices (no main-thread heartbeat for 3 s while a video is open)
    // and sends the last events straight to the server.
    private let freezeLock = NSLock()
    private var recentDiagnostics: [[String: Any]] = []
    private var diagnosticsEndpoint: URL?
    private var lastMainBeat = Date()
    private var freezeReported = false
    private var watchingFreezes = false
    private var freezeTimer: DispatchSourceTimer?

    @objc func setDiagnosticsEndpoint(_ call: CAPPluginCall) {
        let url = call.getString("url").flatMap { URL(string: $0) }
        freezeLock.lock()
        diagnosticsEndpoint = url
        freezeLock.unlock()
        call.resolve()
    }

    private func setWatchingFreezes(_ watching: Bool) {
        freezeLock.lock()
        watchingFreezes = watching
        lastMainBeat = Date()
        freezeLock.unlock()
        guard watching, freezeTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in self?.checkMainThread() }
        freezeTimer = timer
        timer.resume()
    }

    /// Runs off the main thread every second.
    private func checkMainThread() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.freezeLock.lock()
            self.lastMainBeat = Date()
            self.freezeLock.unlock()
        }
        freezeLock.lock()
        let silent = Date().timeIntervalSince(lastMainBeat)
        let watching = watchingFreezes
        let reported = freezeReported
        let events = recentDiagnostics
        let endpoint = diagnosticsEndpoint
        if watching && silent > 3 && !reported { freezeReported = true }
        if reported && silent < 1.5 { freezeReported = false }
        freezeLock.unlock()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        if watching && silent > 3 && !reported {
            postDiagnostics(events + [["at": now, "kind": "main-frozen", "detail": ["seconds": Int(silent)]]], to: endpoint)
        } else if reported && silent < 1.5 {
            postDiagnostics([["at": now, "kind": "main-recovered", "detail": [:] as [String: Any]]], to: endpoint)
        }
    }

    private func postDiagnostics(_ events: [[String: Any]], to endpoint: URL?) {
        guard let endpoint = endpoint,
              let body = try? JSONSerialization.data(withJSONObject: ["device": "iPhone (native)", "events": events]) else { return }
        var request = URLRequest(url: endpoint, timeoutInterval: 10)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        URLSession.shared.dataTask(with: request).resume()
    }
    // System media controls: AirPods, Control Center, Lock Screen, car and
    // headphone buttons (MPRemoteCommandCenter + Now Playing).
    private struct NowPlayingItem {
        var title: String
        var subtitle: String
        var posterURL: URL?
    }
    private var nowPlayingItem: NowPlayingItem?
    private var nowPlayingArtwork: MPMediaItemArtwork?
    private var remoteTargets: [(MPRemoteCommand, Any)] = []
    private var routeObserver: NSObjectProtocol?
    private var lastNowPlayingUpdate = Date.distantPast
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
            let record = try? DownloadCoordinator.shared.store.get(downloadId)
            let item = NowPlayingItem(
                title: record?.title ?? call.getString("title") ?? "TorWatch",
                subtitle: record?.subtitleLabel ?? "",
                posterURL: URL(string: record?.posterURL ?? call.getString("posterUrl") ?? ""))
            self.startPlaybackSurface(rootVC: rootVC, url: files.video, seekTo: seekTo, playId: newPlayId, localDownloadId: downloadId, localSubtitleLang: subtitleLang, nowPlaying: item)
            call.resolve(["resumedPositionS": seekTo ?? 0])
        }
    }

    /// Attaches EVERY downloaded subtitle so the viewer can switch languages;
    /// only the chosen one is enforced (selected).
    private func attachLocalSidecars(selecting lang: String) {
        guard let downloadId = localDownloadId,
              let files = try? DownloadCoordinator.shared.store.readyFileURLs(downloadId) else { return }
        localSidecarLabels = []
        for sidecar in files.subtitles {
            let selected = !lang.isEmpty && sidecar.lang == lang
            if mediaPlayer?.addPlaybackSlave(sidecar.url, type: .subtitle, enforce: selected) == 0 {
                localSidecarLabels.append(Self.sidecarLabel(sidecar.url, lang: sidecar.lang))
            }
        }
    }

    /// "Dub - [English]" for a subtitle the server matched to a dual-audio
    /// release's dub (its WebVTT NOTE says so), else "Downloaded - [English]";
    /// the web layer shows these as "English · Dub" / "English · Downloaded".
    private static func sidecarLabel(_ url: URL, lang: String) -> String {
        let language = Locale(identifier: "en_US").localizedString(forLanguageCode: lang) ?? lang
        var head = ""
        if let handle = try? FileHandle(forReadingFrom: url) {
            head = String(decoding: (try? handle.read(upToCount: 512)) ?? Data(), as: UTF8.self)
            try? handle.close()
        }
        let kind = head.contains("torwatch-variant: dub") ? "Dub" : "Downloaded"
        return "\(kind) - [\(language)]"
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
            let item = NowPlayingItem(title: call.getString("title") ?? "TorWatch", subtitle: "",
                                      posterURL: URL(string: call.getString("posterUrl") ?? ""))
            self.startPlaybackSurface(rootVC: rootVC, url: url, seekTo: seekTo, playId: newPlayId, localDownloadId: nil, nowPlaying: item)
            call.resolve()
        }
    }

    /// Creates the VLC player + surface for [url] and starts playback. Shared
    /// by play() (fresh start) and setSubtitleScale() (in-place engine
    /// recreation when embedded subtitles are active and the user pinch-
    /// resizes — libvlc has no runtime text-scale API, so the engine rebuilds
    /// at the current position with a ~1s hiccup).
    private func startPlaybackSurface(rootVC: UIViewController, url: URL, seekTo: Double?, playId newPlayId: String, localDownloadId newLocalDownloadId: String?, localSubtitleLang: String? = nil, nowPlaying item: NowPlayingItem? = nil) {
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
        setWatchingFreezes(true)

        // sub-text-scale = % of default subtitle size (user-tunable via the
        // pinch gesture; 75 = a touch smaller than default for phones).
        let player = VLCMediaPlayer(options: [
            "--audio-time-stretch",
            "--network-caching=1000", // server prebuffers the torrent; keep decoder catch-up bounded
            // Downloads get the same start-up buffer as streams. VLC's 300 ms
            // file default left too little time to start the hardware HEVC
            // decoder and the 5.1 downmix: choppy sound and late frames at 0:00.
            "--file-caching=1000",
            "--no-input-fast-seek", // resume at the timestamp, not the preceding keyframe
            "--sub-text-scale=\(currentSubTextScale)",
            // A plain sans-serif like the streaming apps' (Netflix Sans);
            // the patched framework's dialogue ASS tracks use it too.
            "--freetype-font=Helvetica Neue",
            "--freetype-color=16777215",
        ] + TorWatchNativePlugin.subtitleLookOptions)
        // A new player starts at its options: no lift, the configured size.
        subtitleLiftPermille = -1
        torwatch_vlc_set_subtitle_layout(-1, 0)
        player.delegate = self
        reportedAudioTrack = Int32.min // a new player reports its tracks afresh
        reportedSubtitleTrack = Int32.min

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
        // Open at the resume position. Seeking once Playing let the start
        // play for a moment, then flushed audio and video mid-start: choppy
        // sound while the picture caught up from the previous keyframe.
        let startsAtResume = seekTo.map { $0.isFinite && $0 >= 1 } ?? false
        if startsAtResume, let start = seekTo {
            media.addOption(":start-time=\(String(format: "%.3f", start))")
        }
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
            guard let self = self, let player = self.mediaPlayer else { return }
            if self.playbackRequested { self.pausePlayback(player) }
            self.releaseVideoForBackground(player)
        }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] notification in
            self?.handleAudioInterruption(notification)
        }
        mediaPlayer = player
        pendingSeek = startsAtResume ? nil : seekTo
        playbackRequested = true
        pausedPositionMs = nil
        // Downloaded subtitles join the media before it opens, not while
        // playback is starting.
        if let lang = localSubtitleLang { attachLocalSidecars(selecting: lang) }
        player.play()
        nowPlayingItem = item
        startSystemControls()
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
        // By what the player is doing, not only what was asked: an alarm or
        // call can pause VLC behind the app's back, and Play then paused
        // again instead of playing (the video seemed frozen).
        diag("toggle")
        if playbackRequested && player.isPlaying {
            pausePlayback(player)
        } else {
            resumeFromPause(player)
        }
        call.resolve()
    }

    /// Play after a pause, from the app or a system control.
    private func resumeFromPause(_ player: VLCMediaPlayer) {
        restartAudioOutputIfNeeded()
        // Flush queued pre-pause audio/video at the exact pause position.
        // A plain unpause froze the picture while the sound ran on, in the
        // app as well as after Home (tried 2026-10-13, reverted on device
        // feedback). Never rewind here.
        if pendingSeek == nil, let position = pausedPositionMs, player.isSeekable {
            player.time = VLCTime(int: position)
        }
        let fromMs = pausedPositionMs ?? max(0, player.time.intValue)
        pausedPositionMs = nil
        playbackRequested = true
        diag("vlc-play-begin")
        player.play()
        diag("vlc-play-end")
        watchResume(fromMs: fromMs, playId: playId, attempt: 1)
        if audioNeedsRestart { retryAudio(playId: playId, remaining: 10) }
    }

    /// iOS refused the audio at Play (an alarm still letting go): the picture
    /// plays on and the sound joins as soon as iOS gives it back.
    private func retryAudio(playId expected: String, remaining: Int) {
        guard remaining > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self = self, self.playId == expected, !self.terminalSent, self.audioNeedsRestart else { return }
            self.restartAudioOutputIfNeeded()
            self.retryAudio(playId: expected, remaining: remaining - 1)
        }
    }

    /// After Play the clock must move. Still stopped after 3 s while not
    /// buffering (or after 9 s in any case): the player is stuck, as after an
    /// alarm took the audio; it is rebuilt in place at the position, as a
    /// subtitle resize does, and plays on.
    private func watchResume(fromMs: Int32, playId expected: String, attempt: Int) {
        resumeWatchdog?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, let player = self.mediaPlayer, !self.terminalSent,
                  self.playbackRequested, self.playId == expected else { return }
            if player.time.intValue > fromMs + 300 { return } // playing
            let loading = player.state == .buffering || player.state == .opening
            self.diag("play-stuck", ["attempt": attempt, "fromMs": Int(fromMs)])
            if loading && attempt < 3 {
                self.watchResume(fromMs: fromMs, playId: expected, attempt: attempt + 1)
                return
            }
            if attempt == 1 {
                // First a fresh audio output, then (still stuck) a new engine.
                self.audioNeedsRestart = true
                self.restartAudioOutputIfNeeded()
                if player.isSeekable { player.time = VLCTime(int: fromMs) }
                player.play()
                self.watchResume(fromMs: fromMs, playId: expected, attempt: 3)
                return
            }
            self.diag("rebuild", ["fromMs": Int(fromMs)])
            self.rebuildEngine(atMs: fromMs)
        }
        resumeWatchdog = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: work)
    }

    /// A fresh engine for the same video at a position: same session, no
    /// terminal event, playback resumes (a download's subtitle files are
    /// attached again).
    private func rebuildEngine(atMs positionMs: Int32) {
        guard let url = currentMediaURL, let bridge = self.bridge, let rootVC = bridge.viewController else { return }
        let requestPlayId = playId
        let currentLocalDownload = localDownloadId
        let currentLocalLang = mediaPlayer.map { currentLocalSubtitleLang($0) } ?? ""
        let currentNowPlaying = nowPlayingItem
        teardown(restoreOrientation: false)
        playId = requestPlayId
        terminalSent = false
        startPlaybackSurface(rootVC: rootVC, url: url, seekTo: Double(positionMs) / 1000.0, playId: requestPlayId,
            localDownloadId: currentLocalDownload, localSubtitleLang: currentLocalDownload != nil ? currentLocalLang : nil,
            nowPlaying: currentNowPlaying)
    }

    private func pausePlayback(_ player: VLCMediaPlayer) {
        playbackRequested = false
        pausedPositionMs = max(0, player.time.intValue)
        diag("vlc-pause-begin")
        player.pause()
        diag("vlc-pause-end")
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
            // From where the controls show (while paused, the last seek's
            // target: repeated taps back each step back again).
            pendingSeek = Double(displayTimeMs(player)) / 1000.0 + delta
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
        // The picture fills the screen (never cropped); a spread stretches it
        // edge to edge. Older choices (fit, fill) start at the default.
        let saved = UserDefaults.standard.string(forKey: videoScaleModeKey) ?? "stretch"
        return saved == "edge" ? "edge" : "stretch"
    }

    @objc func setVideoScale(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setVideoScale(call) }; return }
        let mode = call.getString("mode") ?? "fit"
        guard mode == "fit" || mode == "fill" || mode == "stretch" || mode == "edge" else {
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
    /// Text subtitles in the app's sans-serif font. The patched framework
    /// draws one 60% black box around each subtitle (as the app does); the
    /// official one would draw its background as a band across the whole
    /// picture, so there its subtitles get a thin outline instead.
    private static var subtitleLookOptions: [String] {
        boxedSubtitles
            ? ["--freetype-background-opacity=153", "--freetype-background-color=0",
               "--freetype-outline-thickness=0", "--freetype-shadow-opacity=0"]
            : ["--freetype-background-opacity=0", "--freetype-outline-thickness=2"]
    }

    @objc func subtitleCapabilities(_ call: CAPPluginCall) {
        call.resolve(["boxedSubtitles": TorWatchNativePlugin.boxedSubtitles])
    }

    /// Lifts the player's subtitles by a share (thousandths) of the picture
    /// height, above the controls while they show; negative puts them back.
    @objc func setSubtitleLayout(_ call: CAPPluginCall) {
        if !Thread.isMainThread { DispatchQueue.main.async { self.setSubtitleLayout(call) }; return }
        guard TorWatchNativePlugin.boxedSubtitles, call.getString("playId") == playId else { call.resolve(); return }
        subtitleLiftPermille = Int32(max(-1, min(500, Int(call.getDouble("marginPermille") ?? -1))))
        torwatch_vlc_set_subtitle_layout(subtitleLiftPermille, Int32(currentSubTextScale))
        call.resolve()
    }

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
        if TorWatchNativePlugin.boxedSubtitles {
            // The patched framework resizes the subtitle on screen at once.
            torwatch_vlc_set_subtitle_layout(subtitleLiftPermille, Int32(percent))
            call.resolve()
            return
        }
        _ = url
        // Same session continues server-side: an in-place engine rebuild at
        // the current position (playback resumes).
        rebuildEngine(atMs: mediaPlayer?.time.intValue ?? 0)
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
        // VLC picks its default subtitle/audio track a moment after Playing,
        // with no callback of its own: report any change so the controls
        // never show "Off" while subtitles are on screen.
        if player.currentVideoSubTitleIndex != reportedSubtitleTrack
            || player.currentAudioTrackIndex != reportedAudioTrack {
            emitTracks()
        }
        // The system's Now Playing clock runs on its own; correct it now and
        // then (and once the duration is known).
        if Date().timeIntervalSince(lastNowPlayingUpdate) >= 15 { updateNowPlaying() }
        // D04: periodic local-progress checkpoints every 10s (VLC reports
        // time several times a second; each save is a database write).
        if localDownloadId != nil, Date().timeIntervalSince(lastLocalProgressSave) >= 10 {
            lastLocalProgressSave = Date()
            persistLocalProgress(state: "checkpoint")
        }
        emitTime(player)
    }

    /// The position the controls show. While paused it is the anchor Play
    /// resumes from: after a seek VLC shows the new picture but keeps
    /// reporting the old time until it plays, which snapped the seek bar
    /// back to where it was paused.
    private func displayTimeMs(_ player: VLCMediaPlayer) -> Int32 {
        if !playbackRequested, let anchor = pausedPositionMs { return anchor }
        return player.time.intValue
    }

    private func emitTime(_ player: VLCMediaPlayer) {
        let duration = player.media?.length.intValue ?? 0
        notifyListeners("timeUpdate", data: [
            "currentTime": Double(displayTimeMs(player)) / 1000.0,
            "duration": Double(max(duration, 0)) / 1000.0,
            "playId": playId,
        ])
    }

    func mediaPlayerStateChanged(_ aNotificationName: Notification) {
        guard !terminalSent, let player = aNotificationName.object as? VLCMediaPlayer,
              player === mediaPlayer else { return }
        diag("state")
        switch player.state {
        case .buffering:
            notifyListeners("buffering", data: ["active": true, "playId": playId])
        case .playing:
            applyPendingSeek(player)
            applyVideoScale(player) // the video size is known from here
            updateNowPlaying()
            notifyListeners("buffering", data: ["active": false, "playId": playId])
            notifyListeners("playbackState", data: ["state": "playing", "playId": playId])
            emitTracks()
        case .paused:
            updateNowPlaying()
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
            // A scrub while paused becomes the new resume anchor, shown at
            // once (VLC sends no time change while paused).
            pausedPositionMs = Int32(max(0, min(upper, seconds * 1000)))
            emitTime(player)
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
        // A download's subtitle files are the last tracks, in attachment order.
        if localDownloadId != nil, !localSidecarLabels.isEmpty, subs.count >= localSidecarLabels.count {
            let first = subs.count - localSidecarLabels.count
            for (offset, label) in localSidecarLabels.enumerated() {
                subs[first + offset]["label"] = label
            }
        }
        reportedAudioTrack = player.currentAudioTrackIndex
        reportedSubtitleTrack = player.currentVideoSubTitleIndex
        notifyListeners("tracksUpdate", data: ["audio": audio, "subtitles": subs, "playId": playId,
            "selectedAudioTrackId": reportedAudioTrack,
            "selectedSubtitleTrackId": reportedSubtitleTrack])
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
            // VLC's video view handles the same notification; restore after it.
            DispatchQueue.main.async {
                self?.restoreVideoAfterBackground()
                self?.restartAudioOutputIfNeeded()
            }
        }
    }

    /// A WhatsApp or phone call (or another app) took the audio. VLC marks
    /// its output paused and resumes it only when iOS says "should resume",
    /// which a call's end often omits; iOS also stopped the audio unit. The
    /// next Play then flushed into a stopped output and waited forever: the
    /// video loaded endlessly and closing it froze the app. The player
    /// pauses when the interruption begins; its audio output is rebuilt
    /// once the app is back.
    private func handleAudioInterruption(_ notification: Notification) {
        guard let player = mediaPlayer, !terminalSent,
              let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        audioNeedsRestart = true
        let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        diag("interruption", ["type": type == .began ? "began" : "ended",
                              "shouldResume": options & AVAudioSession.InterruptionOptions.shouldResume.rawValue != 0])
        if type == .began {
            if playbackRequested { pausePlayback(player) }
            // Let go of VLC's audio output now, while it is still sound:
            // after the interruption it would stay dead and Play would wait
            // on it forever. A new one is made at the next Play.
            let track = player.currentAudioTrackIndex
            if track >= 0, audioTrackBeforeInterruption == nil {
                audioTrackBeforeInterruption = track
                diag("vlc-audio-detach-begin")
                player.currentAudioTrackIndex = -1
                diag("vlc-audio-detach-end")
            }
        } else if UIApplication.shared.applicationState == .active {
            restartAudioOutputIfNeeded()
        }
    }

    /// Re-selecting the audio track makes VLC start a new audio output (and
    /// audio unit) on a re-activated session.
    private func restartAudioOutputIfNeeded() {
        guard audioNeedsRestart, let player = mediaPlayer, !terminalSent else { return }
        let track = audioTrackBeforeInterruption ?? player.currentAudioTrackIndex
        guard track >= 0 else { return }
        // An alarm or call may still hold the audio: then try again at the
        // next Play or return to the app (the Play watchdog covers the rest).
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
            try AVAudioSession.sharedInstance().setActive(true)
        } catch {
            diag("audio-activate-failed", ["error": error.localizedDescription])
            return
        }
        audioNeedsRestart = false
        audioTrackBeforeInterruption = nil
        diag("vlc-audio-track-begin", ["track": Int(track)])
        player.currentAudioTrackIndex = -1
        player.currentAudioTrackIndex = track
        diag("audio-restarted", ["track": Int(track)])
    }

    /// iOS discards a backgrounded app's hardware video decoder. VLC then
    /// rebuilds it on return and has no picture until the next keyframe:
    /// after Play the sound ran for 5-10 s over a frozen frame. Switching the
    /// video track off in the background leaves nothing to discard (as VLC
    /// for iOS does).
    private func releaseVideoForBackground(_ player: VLCMediaPlayer) {
        guard !terminalSent, videoTrackBeforeBackground == nil else { return }
        let track = player.currentVideoTrackIndex
        guard track >= 0 else { return }
        videoTrackBeforeBackground = track
        player.currentVideoTrackIndex = -1
    }

    /// Back in the app: a fresh decoder for the video track, and the paused
    /// position again so it decodes from the keyframe before it rather than
    /// waiting for the next one.
    private func restoreVideoAfterBackground() {
        guard let player = mediaPlayer, !terminalSent, let track = videoTrackBeforeBackground,
              UIApplication.shared.applicationState == .active else { return }
        videoTrackBeforeBackground = nil
        player.currentVideoTrackIndex = track
        applyVideoScale(player)
        if pendingSeek == nil, let position = pausedPositionMs, player.isSeekable {
            player.time = VLCTime(int: position)
        }
    }

    // MARK: - System media controls

    /// AirPods (tap, squeeze, double/triple press, taking one out), Control
    /// Center, the Lock Screen, car and headphone buttons all arrive as
    /// remote commands; the Now Playing card shows the title, poster and
    /// progress. Video does not play in the background, so Play from the
    /// Lock Screen is refused there.
    private func startSystemControls() {
        stopSystemControls()
        let center = MPRemoteCommandCenter.shared()
        func add(_ command: MPRemoteCommand, _ handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus) {
            command.isEnabled = true
            remoteTargets.append((command, command.addTarget(handler: handler)))
        }
        add(center.playCommand) { [weak self] _ in self?.remoteSetPlaying(true) ?? .commandFailed }
        add(center.pauseCommand) { [weak self] _ in self?.remoteSetPlaying(false) ?? .commandFailed }
        add(center.togglePlayPauseCommand) { [weak self] _ in
            guard let self = self else { return .commandFailed }
            return self.remoteSetPlaying(!(self.playbackRequested && self.mediaPlayer?.isPlaying == true))
        }
        center.skipForwardCommand.preferredIntervals = [10]
        center.skipBackwardCommand.preferredIntervals = [10]
        add(center.skipForwardCommand) { [weak self] _ in self?.remoteSkip(10) ?? .commandFailed }
        add(center.skipBackwardCommand) { [weak self] _ in self?.remoteSkip(-10) ?? .commandFailed }
        // AirPods double/triple press and car "next/previous" buttons.
        add(center.nextTrackCommand) { [weak self] _ in self?.remoteSkip(10) ?? .commandFailed }
        add(center.previousTrackCommand) { [weak self] _ in self?.remoteSkip(-10) ?? .commandFailed }
        add(center.changePlaybackPositionCommand) { [weak self] event in
            guard let self = self, let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            return self.remoteSeek(to: event.positionTime)
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main
        ) { [weak self] notification in
            self?.handleRouteChange(notification)
        }
        loadNowPlayingArtwork()
        updateNowPlaying()
    }

    private func stopSystemControls() {
        for (command, target) in remoteTargets {
            command.removeTarget(target)
            command.isEnabled = false
        }
        remoteTargets.removeAll()
        if let observer = routeObserver { NotificationCenter.default.removeObserver(observer) }
        routeObserver = nil
        nowPlayingArtwork = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    private func remoteSetPlaying(_ play: Bool) -> MPRemoteCommandHandlerStatus {
        guard let player = mediaPlayer, !terminalSent else { return .noActionableNowPlayingItem }
        if play {
            guard UIApplication.shared.applicationState != .background else { return .commandFailed }
            if !(playbackRequested && player.isPlaying) { resumeFromPause(player) }
        } else if playbackRequested {
            pausePlayback(player)
        }
        updateNowPlaying()
        return .success
    }

    private func remoteSkip(_ seconds: Double) -> MPRemoteCommandHandlerStatus {
        guard let player = mediaPlayer, !terminalSent else { return .noActionableNowPlayingItem }
        return remoteSeek(to: Double(player.time.intValue) / 1000.0 + seconds)
    }

    private func remoteSeek(to seconds: Double) -> MPRemoteCommandHandlerStatus {
        guard let player = mediaPlayer, !terminalSent, seconds.isFinite else { return .noActionableNowPlayingItem }
        pendingSeek = max(0, seconds)
        applyPendingSeek(player)
        updateNowPlaying()
        return .success
    }

    /// Unplugging headphones or AirPods disconnecting pauses, as iOS's own
    /// players do, instead of continuing out of the speaker.
    private func handleRouteChange(_ notification: Notification) {
        guard let player = mediaPlayer, !terminalSent, playbackRequested,
              let raw = notification.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              AVAudioSession.RouteChangeReason(rawValue: raw) == .oldDeviceUnavailable else { return }
        pausePlayback(player)
        updateNowPlaying()
    }

    private func updateNowPlaying() {
        guard let player = mediaPlayer, !terminalSent, let item = nowPlayingItem else { return }
        lastNowPlayingUpdate = Date()
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: item.title,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.video.rawValue,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: Double(max(0, player.time.intValue)) / 1000.0,
            MPNowPlayingInfoPropertyPlaybackRate: playbackRequested ? 1.0 : 0.0,
        ]
        if !item.subtitle.isEmpty { info[MPMediaItemPropertyArtist] = item.subtitle }
        let duration = Double(player.media?.length.intValue ?? 0) / 1000.0
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        if let artwork = nowPlayingArtwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func loadNowPlayingArtwork() {
        guard let url = nowPlayingItem?.posterURL, url.scheme == "http" || url.scheme == "https" else { return }
        let expectedPlayId = playId
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let data = data, let image = UIImage(data: data) else { return }
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            DispatchQueue.main.async {
                guard let self = self, self.playId == expectedPlayId else { return }
                self.nowPlayingArtwork = artwork
                self.updateNowPlaying()
            }
        }.resume()
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
        videoTrackBeforeBackground = nil
        localSidecarLabels = []
        audioNeedsRestart = false
        if let observer = interruptionObserver { NotificationCenter.default.removeObserver(observer) }
        interruptionObserver = nil
        stopSystemControls()
        subtitleDownloads.forEach { $0.cancel() }
        resumeWatchdog?.cancel()
        resumeWatchdog = nil
        audioTrackBeforeInterruption = nil
        setWatchingFreezes(false)
        subtitleDownloads.removeAll()
        if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
        backgroundObserver = nil
        UIApplication.shared.isIdleTimerDisabled = false
        let stopping = mediaPlayer
        if let player = stopping {
            player.delegate = nil
            // stop() waits for VLC's threads. A stalled audio output (after a
            // call) made it wait forever on the main thread: the whole app
            // froze until force-quit. Stop off the main thread; the session
            // is released once VLC has stopped, unless a new video started.
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                player.stop()
                DispatchQueue.main.async {
                    player.drawable = nil
                    if restoreOrientation, self?.mediaPlayer == nil {
                        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
                    }
                }
            }
        }
        mediaPlayer = nil
        subtitleFiles.forEach { try? FileManager.default.removeItem(at: $0) }
        subtitleFiles.removeAll()
        surfaceView?.removeFromSuperview()
        surfaceView = nil
        makeWebViewTransparent(false)
        guard restoreOrientation else { return }
        // Let music or podcasts the player interrupted resume (once stopped,
        // above, when there was a player).
        if stopping == nil {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
        if TorWatchPlaybackState.videoAttached {
            requestOrientation(false)
        }
    }
}

/// A clipped viewport around a natural-aspect VLC drawable. The drawable's
/// bounds stay constant across mode changes; only its transform changes.
final class VideoSurfaceView: UIView {
    let drawableView = UIView()
    private let viewportView = UIView()
    var onResize: (() -> Void)?
    private var lastSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        backgroundColor = .black
        viewportView.clipsToBounds = true
        viewportView.frame = bounds
        addSubview(viewportView)
        drawableView.frame = bounds
        viewportView.addSubview(drawableView)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func apply(aspect: CGFloat, mode: String) {
        // Symmetric gutters keep the picture centered and clear of the
        // Dynamic Island/notch, whichever side it occupies in landscape.
        // Edge to edge covers the whole screen, the notch side included.
        let sideInset = mode == "edge" ? 0 : max(safeAreaInsets.left, safeAreaInsets.right)
        let availableWidth = max(0, bounds.width - sideInset * 2)
        let layout = torwatch_video_layout(Double(availableWidth), Double(bounds.height),
            Double(aspect), mode == "fill" ? 1 : mode == "stretch" ? 2 : mode == "edge" ? 3 : 0)
        guard layout.width > 0, layout.height > 0 else { return }
        let viewportFrame = CGRect(x: (bounds.width - CGFloat(layout.viewport_width)) / 2,
            y: 0, width: CGFloat(layout.viewport_width), height: bounds.height)
        if viewportView.frame != viewportFrame { viewportView.frame = viewportFrame }
        let drawableBounds = CGRect(x: 0, y: 0, width: CGFloat(layout.width), height: CGFloat(layout.height))
        let center = CGPoint(x: viewportView.bounds.midX, y: viewportView.bounds.midY)
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

    override func safeAreaInsetsDidChange() {
        super.safeAreaInsetsDidChange()
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
