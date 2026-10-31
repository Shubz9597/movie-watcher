package com.torwatch.mobile

import android.content.Context
import android.content.res.Configuration
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.ViewGroup
import android.view.WindowManager
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.JSObject
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import org.videolan.libvlc.interfaces.IMedia
import org.json.JSONArray
import org.videolan.libvlc.LibVLC
import org.videolan.libvlc.Media
import org.videolan.libvlc.MediaPlayer
import org.videolan.libvlc.util.VLCVideoLayout
import com.torwatch.mobile.downloads.DownloadEngine
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

/**
 * TorWatchNativePlugin (M1.4.7 VLC layer) — LibVLC playback BEHIND the
 * Capacitor WebView.
 *
 * Architecture (desktop-equivalent UI):
 *  - The VLC surface is inserted at index 0 of the activity's content view,
 *    and the WebView background is made transparent while a surface is
 *    attached, so EVERY control (loading overlay, seek bar, subtitle/audio
 *    sheets, skip-intro chip) is the shared React UI — one implementation for
 *    both platforms.
 *  - Because VLC demuxes the ORIGINAL file directly, embedded audio and
 *    subtitle tracks stay intact: the inventory is reported via `tracksUpdate`
 *    and selected with selectAudioTrack/selectSubtitleTrack WITHOUT a
 *    playback restart.
 *  - Runtime subtitles (OpenSubtitles, torrent sidecars, local imports) load
 *    through VLC slaves at any time — never a media reload.
 *
 * Security/privacy invariants (unchanged from the Media3 baseline):
 *  - Only OPAQUE playback/subtitle URLs from /v2/playback/sessions plus a
 *    display title and the web-chosen playId cross the bridge. No magnets,
 *    tokens, or credentials.
 *  - Every event carries `playId`; events from a replaced (dying) player are
 *    dropped web-side.
 *  - Exactly one terminal state per playback, guarded by [terminalSent].
 *  - Error text is GENERIC (player internals never cross the bridge).
 *
 * Orientation: the surface attaches in SENSOR_LANDSCAPE (video) and restores
 * the previous orientation on detach (web app UI stays portrait).
 */
@CapacitorPlugin(name = "TorWatchNative")
class TorWatchNativePlugin : Plugin() {

    companion object {
        private const val EVENT_TIME_UPDATE = "timeUpdate"
        private const val EVENT_PLAYBACK_STATE = "playbackState"
        private const val EVENT_TRACKS_UPDATE = "tracksUpdate"
        private const val EVENT_BUFFERING = "buffering"
        private const val KEY_PLAY_ID = "playId"
        private const val TIME_TICK_MS = 500L
        private const val TRACKS_REFRESH_MS = 250L
        // Larger than the default: the source is a LAN HTTP stream of a
        // possibly-incomplete torrent; a deeper network buffer absorbs
        // peer-driven throughput dips.
        private const val NETWORK_CACHING_MS = 4000
        private const val VIDEO_SCALE_MODE_KEY = "videoScaleMode"
        private const val EVENT_LOCAL_PROGRESS = "localProgress"
        private const val LOCAL_CHECKPOINT_MS = 10_000L

        @Volatile private var active: TorWatchNativePlugin? = null

        /** Removal while playing: the player closes BEFORE the files go. */
        fun stopLocalPlaybackIfActive(downloadId: String, then: () -> Unit) {
            val plugin = active
            if (plugin == null) { then(); return }
            plugin.mainHandler.post {
                if (plugin.localDownloadId == downloadId) {
                    plugin.persistLocalProgress("stopped")
                    if (!plugin.terminalSent) {
                        plugin.terminalSent = true
                        plugin.emit(EVENT_PLAYBACK_STATE) {
                            putString("state", "stopped")
                            putString(KEY_PLAY_ID, plugin.playId)
                        }
                    }
                    plugin.teardown()
                }
                then()
            }
        }
    }

    // A download playing offline (playLocal): its id, its subtitle files'
    // labels (the last subtitle tracks, in attachment order) and the last
    // position checkpoint.
    private var localDownloadId: String? = null
    private var localSidecars: List<Pair<String, String>> = emptyList() // lang to label
    private var lastLocalSave = 0L
    private var focusRequest: AudioFocusRequest? = null

    override fun load() {
        super.load()
        active = this
    }

    private var libVLC: LibVLC? = null
    private var mediaPlayer: MediaPlayer? = null
    private var videoLayout: VLCVideoLayout? = null
    private var playId: String = ""
    private var terminalSent = false
    // Current media + subtitle text scale (% of default), kept so the engine
    // can be recreated in place when the user pinch-resizes embedded subs.
    private var currentUrl: String? = null
    private var currentTitle: String = "TorWatch"
    private var currentSubTextScale: Int = 75
    private var attachedOrientation = Configuration.ORIENTATION_UNDEFINED
    private var previousOrientation = Configuration.ORIENTATION_UNDEFINED
    private var pendingSeek: Long? = null
    private val downloads = Executors.newSingleThreadExecutor()
    private val subtitleFiles = mutableListOf<File>()

    private val mainHandler = Handler(Looper.getMainLooper())
    private val tracksHandler = Handler(Looper.getMainLooper())

    private val timeTicker = object : Runnable {
        override fun run() {
            val player = mediaPlayer
            if (player != null && !terminalSent) {
                applyPendingSeek()
                if (localDownloadId != null && System.currentTimeMillis() - lastLocalSave >= LOCAL_CHECKPOINT_MS) {
                    lastLocalSave = System.currentTimeMillis()
                    persistLocalProgress("checkpoint")
                }
                emit(EVENT_TIME_UPDATE) {
                    putDouble("currentTime", player.time / 1000.0)
                    putDouble("duration", if (player.length > 0) player.length / 1000.0 else 0.0)
                    putString(KEY_PLAY_ID, playId)
                }
            }
            mainHandler.postDelayed(this, TIME_TICK_MS)
        }
    }

    // Track inventory changes arrive through several ES* events; debounce to
    // one bounded refresh instead of a burst.
    private val tracksRefresher = object : Runnable {
        override fun run() {
            emitTracks()
        }
    }

    // MARK: - Bridge API

    @PluginMethod
    fun play(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            mainHandler.post { play(call) }
            return
        }
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("The playback URL is missing or invalid.")
            return
        }
        val newPlayId = call.getString("playId")
        if (newPlayId.isNullOrEmpty()) {
            call.reject("The playback identifier is missing.")
            return
        }
        val title = call.getString("title") ?: "TorWatch"
        val seekTo: Double? = call.getDouble("seekTo")
        // Subtitle text scale (%) from the device preference (pinch on the
        // video persists it); applied to the freshly created engine.
        call.getInt("subTextScale")?.let { if (it in 25..200) currentSubTextScale = it }
        currentUrl = url
        currentTitle = title

        // Replacement safety: tear the previous player down BEFORE creating
        // the new one; late events from it are ignored via terminalSent.
        teardown()

        val activity = bridge?.activity
        if (activity == null) {
            call.reject("The player surface is unavailable.")
            return
        }

        playId = newPlayId
        terminalSent = false
        localDownloadId = null
        localSidecars = emptyList()

        startPlaybackEngine(activity, url, title, seekTo)

        mainHandler.postDelayed(timeTicker, TIME_TICK_MS)
        scheduleTracksRefresh()
        call.resolve()
    }

    /**
     * Creates the LibVLC engine + player + surface for [url] and starts
     * playback at the pending seek position. Shared by play() (fresh start)
     * and setSubtitleScale() (in-place engine recreation when embedded
     * subtitles are active and the user pinches a new text size — libvlc has
     * no runtime text-scale API, so the engine is rebuilt at the current
     * position with a ~1s hiccup).
     */
    private fun startPlaybackEngine(activity: android.app.Activity, url: String, title: String, seekTo: Double?) {
        val enginePlayId = playId
        val newLibVlc = LibVLC(
            activity,
            arrayListOf(
                "--audio-time-stretch",
                "--network-caching=$NETWORK_CACHING_MS",
                "--sub-text-scale=$currentSubTextScale",
            ),
        )
        libVLC = newLibVlc
        val player = MediaPlayer(newLibVlc)
        mediaPlayer = player

        player.setEventListener { event ->
            mainHandler.post {
                if (event == null || playId != enginePlayId || mediaPlayer !== player || terminalSent) return@post
                when (event.type) {
                    MediaPlayer.Event.Playing -> {
                        applyPendingSeek()
                        emit(EVENT_PLAYBACK_STATE) {
                            putString("state", "playing")
                            putString(KEY_PLAY_ID, playId)
                        }
                        emitBuffering(false, 100.0)
                        scheduleTracksRefresh()
                    }
                    MediaPlayer.Event.Paused -> {
                        persistLocalProgress("paused")
                        emit(EVENT_PLAYBACK_STATE) {
                            putString("state", "paused")
                            putString(KEY_PLAY_ID, playId)
                        }
                    }
                    MediaPlayer.Event.Buffering -> emitBuffering(event.buffering < 100f, event.buffering.toDouble())
                    MediaPlayer.Event.SeekableChanged -> applyPendingSeek()
                    MediaPlayer.Event.EndReached -> {
                        persistLocalProgress("ended")
                        if (!terminalSent) {
                            terminalSent = true
                            emit(EVENT_PLAYBACK_STATE) {
                                putString("state", "ended")
                                putString(KEY_PLAY_ID, playId)
                            }
                        }
                    }
                    MediaPlayer.Event.EncounteredError -> {
                        persistLocalProgress("error")
                        if (!terminalSent) {
                            terminalSent = true
                            // Generic message ONLY: VLC internals never cross the bridge.
                            emit(EVENT_PLAYBACK_STATE) {
                                putString("state", "error")
                                putString("message", "The media could not be played on this device.")
                                putString(KEY_PLAY_ID, playId)
                            }
                        }
                    }
                    MediaPlayer.Event.ESAdded, MediaPlayer.Event.ESDeleted, MediaPlayer.Event.ESSelected -> {
                        scheduleTracksRefresh()
                    }
                }
            }
        }

        val layout = VLCVideoLayout(activity)
        videoLayout = layout
        val root = bridge.webView.parent as ViewGroup
        // Index 0: BEHIND the WebView. The WebView becomes transparent while
        // the surface is attached (restored on teardown).
        root.addView(layout, root.indexOfChild(bridge.webView), ViewGroup.LayoutParams(-1, -1))
        bridge?.webView?.setBackgroundColor(Color.TRANSPARENT)
        previousOrientation = activity.requestedOrientation
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        attachedOrientation = Configuration.ORIENTATION_LANDSCAPE

        val media = Media(newLibVlc, Uri.parse(url))
        media.setHWDecoderEnabled(true, false)
        // Session sidecar offers are NOT attached as slaves: the web layer
        // renders sheet-loaded subtitles itself (pinch-resizable overlay),
        // and auto-attached slaves would double-render under the overlay.
        // The web layer still asks for embedded spu tracks via setSpuTrack.
        player.media = media
        media.release()
        attachLocalSidecars(player)
        player.attachViews(layout, null, true, true)
        applyVideoScale(player, savedScaleMode(activity))
        requestAudioFocus(activity)

        if (seekTo != null && seekTo > 0) {
            pendingSeek = (seekTo * 1000.0).toLong()
        }
        player.play()
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { seek(call) }; return }
        val position = call.getDouble("positionSec") ?: run {
            call.reject("The seek request is incomplete.")
            return
        }
        val requestPlayId = call.getString("playId")
        if (requestPlayId.isNullOrEmpty() || requestPlayId != playId) {
            call.resolve()
            return
        }
        if (position.isFinite()) {
            pendingSeek = (position.coerceAtLeast(0.0) * 1000.0).toLong()
            applyPendingSeek()
        }
        call.resolve()
    }

    @PluginMethod
    fun togglePlayback(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { togglePlayback(call) }; return }
        if (call.getString("playId") != playId) { call.resolve(); return }
        val player = mediaPlayer ?: run { call.resolve(); return }
        if (player.isPlaying) {
            player.pause()
        } else {
            bridge?.activity?.let { requestAudioFocus(it) }
            player.play()
        }
        call.resolve()
    }

    /**
     * Embedded-subtitle text scale (% of default, 25..200). Applied by
     * recreating the engine at the current position — libvlc has no runtime
     * text-scale API, so this carries a ~1s hiccup and only fires when
     * embedded tracks are actually active (the web overlay resizes live).
     */
    @PluginMethod
    fun setSubtitleScale(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { setSubtitleScale(call) }; return }
        val percent = (call.getInt("percent") ?: 75).coerceIn(25, 200)
        if (call.getString("playId") != playId) { call.resolve(); return }
        val activity = bridge?.activity
        val url = currentUrl
        if (percent == currentSubTextScale || activity == null || url == null || mediaPlayer == null) {
            call.resolve()
            return
        }
        currentSubTextScale = percent
        val positionMs = mediaPlayer?.time ?: 0L
        // Same session continues server-side: no terminal event, just an
        // in-place engine rebuild at the current position (playback resumes).
        // An offline download keeps its id and subtitle files.
        val local = localDownloadId
        val sidecars = localSidecars
        teardown()
        localDownloadId = local
        localSidecars = sidecars
        playId = call.getString("playId") ?: playId
        terminalSent = false
        pendingSeek = positionMs
        startPlaybackEngine(activity, url, currentTitle, null)
        call.resolve()
    }

    @PluginMethod
    fun seekBy(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { seekBy(call) }; return }
        val delta = call.getDouble("deltaSeconds") ?: 0.0
        val requestPlayId = call.getString("playId")
        if (requestPlayId.isNullOrEmpty() || requestPlayId != playId) {
            call.resolve()
            return
        }
        val player = mediaPlayer ?: run { call.resolve(); return }
        val duration = player.length
        val target = (player.time + (delta * 1000.0).toLong())
            .coerceIn(0L, if (duration > 0) duration else Long.MAX_VALUE)
        player.time = target
        call.resolve()
    }

    @PluginMethod
    fun selectAudioTrack(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { selectAudioTrack(call) }; return }
        val trackId = call.getInt("trackId") ?: return run { call.reject("trackId missing") }
        if (call.getString("playId") != playId) { call.resolve(); return }
        mediaPlayer?.setAudioTrack(trackId)
        call.resolve()
    }

    @PluginMethod
    fun selectSubtitleTrack(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { selectSubtitleTrack(call) }; return }
        // null or -1 disables subtitles.
        val trackId = call.getInt("trackId") ?: -1
        if (call.getString("playId") != playId) { call.resolve(); return }
        mediaPlayer?.setSpuTrack(trackId)
        call.resolve()
    }

    @PluginMethod
    fun setSubtitleDelay(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { setSubtitleDelay(call) }; return }
        val seconds = call.getDouble("seconds") ?: 0.0
        if (call.getString("playId") != playId) { call.resolve(); return }
        // Both LibVLC delay APIs use MICROSECONDS; positive = later.
        if (seconds.isFinite()) mediaPlayer?.setSpuDelay((seconds.coerceIn(-30.0, 30.0) * 1_000_000.0).toLong())
        call.resolve()
    }

    @PluginMethod
    fun setAudioDelay(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { setAudioDelay(call) }; return }
        val seconds = call.getDouble("seconds") ?: 0.0
        if (call.getString("playId") != playId) { call.resolve(); return }
        if (seconds.isFinite()) mediaPlayer?.setAudioDelay((seconds.coerceIn(-30.0, 30.0) * 1_000_000.0).toLong())
        call.resolve()
    }

    @PluginMethod
    fun setVideoScale(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { setVideoScale(call) }; return }
        val mode = call.getString("mode") ?: "fit"
        if (mode != "fit" && mode != "fill" && mode != "stretch" && mode != "edge") {
            call.reject("Unknown video scale mode.")
            return
        }
        if (call.getString("playId") != playId) { call.resolve(); return }
        bridge.activity.getSharedPreferences("torwatch.player", 0).edit()
            .putString(VIDEO_SCALE_MODE_KEY, mode).apply()
        mediaPlayer?.let { applyVideoScale(it, mode) }
        call.resolve()
    }

    // The iPhone's sizes: the picture fills the screen (stretched to at most
    // 16:9, never cropped) by default; a spread stretches it edge to edge.
    private fun savedScaleMode(activity: android.app.Activity): String {
        val saved = activity.getSharedPreferences("torwatch.player", 0).getString(VIDEO_SCALE_MODE_KEY, "stretch")
        return if (saved == "edge") "edge" else "stretch"
    }

    private fun applyVideoScale(player: MediaPlayer, mode: String) {
        when (mode) {
            "edge" -> { player.aspectRatio = null; player.setVideoScale(MediaPlayer.ScaleType.SURFACE_FILL) }
            "stretch" -> { player.aspectRatio = "16:9"; player.setVideoScale(MediaPlayer.ScaleType.SURFACE_BEST_FIT) }
            "fill" -> { player.aspectRatio = null; player.setVideoScale(MediaPlayer.ScaleType.SURFACE_FIT_SCREEN) }
            else -> { player.aspectRatio = null; player.setVideoScale(MediaPlayer.ScaleType.SURFACE_BEST_FIT) }
        }
    }

    /** Offline playback of a ready download, with its subtitle files. */
    @PluginMethod
    fun playLocal(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { playLocal(call) }; return }
        val downloadId = call.getString("downloadId")
        if (downloadId.isNullOrEmpty()) { call.reject("The download identifier is missing."); return }
        val newPlayId = call.getString("playId")
        if (newPlayId.isNullOrEmpty()) { call.reject("The playback identifier is missing."); return }
        DownloadEngine.init(context)
        val store = DownloadEngine.store()
        val files = store.readyFiles(downloadId) ?: run {
            call.reject("That download is not ready for offline playback.")
            return
        }
        // Resume 15 s before where this phone left off; a finished episode
        // (90%+) starts over.
        val saved = store.loadProgress(downloadId)
        val seekTo = call.getDouble("seekTo") ?: saved?.let {
            if (it.durationS > 0 && it.positionS >= it.durationS * 0.9) null
            else if (it.positionS > 15) it.positionS - 15 else null
        }
        // An explicit choice wins, then the viewer's last ("" = off), then
        // the language asked for when it was downloaded.
        val subtitleLang = call.getString("subtitleLang") ?: saved?.subtitleLang ?: files.second.firstOrNull()?.first ?: ""
        val record = store.get(downloadId)
        teardown()
        val activity = bridge?.activity ?: run { call.reject("The player surface is unavailable."); return }
        playId = newPlayId
        terminalSent = false
        localDownloadId = downloadId
        localSidecars = files.second.map { (lang, file) -> lang to sidecarLabel(file, lang) }
        localSubtitleLang = subtitleLang
        currentUrl = Uri.fromFile(files.first).toString()
        currentTitle = record?.title ?: call.getString("title") ?: "TorWatch"
        startPlaybackEngine(activity, currentUrl!!, currentTitle, seekTo)
        mainHandler.postDelayed(timeTicker, TIME_TICK_MS)
        scheduleTracksRefresh()
        call.resolve(JSObject().put("resumedPositionS", seekTo ?: 0.0))
    }

    private var localSubtitleLang = ""

    /** Every downloaded subtitle is attached; only the chosen one is selected. */
    private fun attachLocalSidecars(player: MediaPlayer) {
        val id = localDownloadId ?: return
        val files = DownloadEngine.store().readyFiles(id) ?: return
        for ((lang, file) in files.second) {
            player.addSlave(IMedia.Slave.Type.Subtitle, Uri.fromFile(file), localSubtitleLang.isNotEmpty() && lang == localSubtitleLang)
        }
    }

    /** "Dub - [English]" for a subtitle matched to a dual-audio release's
     *  dub (its WebVTT NOTE says so), else "Downloaded - [English]". */
    private fun sidecarLabel(file: File, lang: String): String {
        val language = java.util.Locale(lang).getDisplayLanguage(java.util.Locale.ENGLISH).ifEmpty { lang }
        val head = try {
            file.inputStream().use { input ->
                val buffer = ByteArray(512)
                val n = input.read(buffer)
                if (n > 0) String(buffer, 0, n) else ""
            }
        } catch (_: Exception) { "" }
        return (if (head.contains("torwatch-variant: dub")) "Dub" else "Downloaded") + " - [" + language + "]"
    }

    /** The playing download's position, kept on the phone (offline too). */
    private fun persistLocalProgress(state: String) {
        val id = localDownloadId ?: return
        val player = mediaPlayer ?: return
        val position = player.time / 1000.0
        val duration = if (player.length > 0) player.length / 1000.0 else 0.0
        if (duration <= 0) return
        DownloadEngine.store().saveProgress(id, position, duration, currentLocalSubtitleLang(player))
        if (!terminalSent) {
            emit(EVENT_LOCAL_PROGRESS) {
                putString("downloadId", id)
                putDouble("positionS", position)
                putDouble("durationS", duration)
                putString("state", state)
                putString(KEY_PLAY_ID, playId)
            }
        }
    }

    /** The selected subtitle's language when it is a downloaded file. */
    private fun currentLocalSubtitleLang(player: MediaPlayer): String {
        if (localSidecars.isEmpty()) return ""
        val tracks = player.spuTracks.orEmpty().filter { it.id >= 0 }
        val index = tracks.indexOfFirst { it.id == player.spuTrack }
        if (index < 0) return ""
        val position = index - (tracks.size - localSidecars.size)
        return if (position in localSidecars.indices) localSidecars[position].first else ""
    }

    // A call or alarm takes the audio: playback pauses and stays paused
    // until Play (the iPhone's behaviour the viewer chose).
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            mainHandler.post { mediaPlayer?.let { if (it.isPlaying) it.pause() } }
        }
    }

    private fun requestAudioFocus(activity: android.app.Activity) {
        val audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                .setAudioAttributes(AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
                .setOnAudioFocusChangeListener(focusListener, mainHandler)
                .build()
            focusRequest = request
            audio.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
        }
    }

    private fun abandonAudioFocus() {
        val audio = bridge?.activity?.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audio.abandonAudioFocusRequest(it) }
        } else {
            @Suppress("DEPRECATION")
            audio.abandonAudioFocus(focusListener)
        }
        focusRequest = null
    }

    @PluginMethod
    fun setPlaybackOrientation(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { setPlaybackOrientation(call) }; return }
        val landscape = call.getBoolean("landscape") ?: true
        val activity = bridge?.activity ?: run { call.resolve(); return }
        // Locks landscape the moment playback is entered (before media
        // preparation); UNSPECIFIED hands control back to the OS on close.
        activity.requestedOrientation = if (landscape) {
            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        call.resolve()
    }

    @PluginMethod
    fun loadSubtitle(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { loadSubtitle(call) }; return }
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("The subtitle URL is missing or invalid.")
            return
        }
        if (call.getString("playId") != playId) { call.resolve(); return }
        val player = mediaPlayer
        if (player == null) {
            call.reject("No active playback.")
            return
        }
        val id = playId
        val cacheDir = activity.cacheDir
        downloads.execute {
            var file: File? = null
            try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 10000
                connection.readTimeout = 20000
                try {
                    if (connection.responseCode !in 200..299) error("download failed")
                    val type = connection.contentType.orEmpty()
                    val extension = when {
                        type.contains("ssa") -> ".ass"
                        type.contains("subrip") -> ".srt"
                        else -> ".vtt"
                    }
                    file = File.createTempFile("torwatch-sub-", extension, cacheDir)
                    connection.inputStream.use { input ->
                        file!!.outputStream().use { output ->
                            val buffer = ByteArray(8192)
                            var total = 0
                            while (true) {
                                val count = input.read(buffer)
                                if (count < 0) break
                                total += count
                                if (total > 4 * 1024 * 1024) error("subtitle too large")
                                output.write(buffer, 0, count)
                            }
                            if (total == 0) error("empty subtitle")
                        }
                    }
                } finally { connection.disconnect() }
                val downloaded = file!!
                mainHandler.post {
                    if (mediaPlayer !== player || playId != id || terminalSent) {
                        downloaded.delete()
                        call.reject("Playback changed before the subtitle finished loading.")
                    } else if (player.addSlave(IMedia.Slave.Type.Subtitle, downloaded.absolutePath, true)) {
                        subtitleFiles.add(downloaded)
                        scheduleTracksRefresh()
                        call.resolve()
                    } else {
                        downloaded.delete()
                        call.reject("The subtitle could not be loaded.")
                    }
                }
            } catch (_: Exception) {
                file?.delete()
                mainHandler.post { call.reject("The subtitle could not be downloaded. Try another file.") }
            }
        }
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        if (Looper.myLooper() != Looper.getMainLooper()) { mainHandler.post { dismiss(call) }; return }
        val requestPlayId = call.getString("playId")
        if (requestPlayId.isNullOrEmpty() || requestPlayId != playId) {
            call.resolve()
            return
        }
        persistLocalProgress("stopped")
        if (!terminalSent) {
            terminalSent = true
            emit(EVENT_PLAYBACK_STATE) {
                putString("state", "stopped")
                putString(KEY_PLAY_ID, playId)
            }
        }
        teardown()
        call.resolve()
    }

    // MARK: - Internals

    private fun applyPendingSeek() {
        val player = mediaPlayer ?: return
        val position = pendingSeek ?: return
        if (!player.isSeekable) return
        pendingSeek = null
        player.time = position.coerceIn(0L, if (player.length > 0) player.length else Long.MAX_VALUE)
    }

    override fun handleOnPause() {
        mainHandler.post { mediaPlayer?.let { if (it.isPlaying) it.pause() } }
    }

    override fun handleOnDestroy() {
        mainHandler.post { teardown() }
        downloads.shutdownNow()
    }

    private fun scheduleTracksRefresh() {
        tracksHandler.removeCallbacks(tracksRefresher)
        tracksHandler.postDelayed(tracksRefresher, TRACKS_REFRESH_MS)
    }

    private fun emitTracks() {
        val player = mediaPlayer ?: return
        val audio = player.audioTracks.orEmpty()
            .filter { it.id >= 0 }
            .map { mapOf("id" to it.id, "label" to (it.name ?: "")) }
        val subs = player.spuTracks.orEmpty()
            .filter { it.id >= 0 }
            .map { mutableMapOf<String, Any>("id" to it.id, "label" to (it.name ?: "")) }
        // A download's subtitle files are the last tracks, in attachment order.
        if (localSidecars.isNotEmpty() && subs.size >= localSidecars.size) {
            val first = subs.size - localSidecars.size
            localSidecars.forEachIndexed { offset, (_, label) -> subs[first + offset]["label"] = label }
        }
        emit(EVENT_TRACKS_UPDATE) {
            putString(KEY_PLAY_ID, playId)
            putString("audio", JSONArray(audio).toString())
            putString("subtitles", JSONArray(subs).toString())
            putInt("selectedAudioTrackId", player.audioTrack)
            putInt("selectedSubtitleTrackId", player.spuTrack)
        }
    }

    private fun emitBuffering(active: Boolean, progress: Double) {
        emit(EVENT_BUFFERING) {
            putBoolean("active", active)
            putDouble("progress", progress)
            putString(KEY_PLAY_ID, playId)
        }
    }

    private fun emit(name: String, fill: Bundle.() -> Unit) {
        notifyListenersFromMainThread(name, Bundle().apply(fill))
    }

    private fun notifyListenersFromMainThread(name: String, data: Bundle) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            notifyListeners(name, bundleToJSObject(data))
        } else {
            mainHandler.post { notifyListeners(name, bundleToJSObject(data)) }
        }
    }

    private fun bundleToJSObject(data: Bundle): JSObject {
        val payload = JSObject()
        for (key in data.keySet()) {
            when (val value = data.get(key)) {
                is String -> payload.put(key, if (key == "audio" || key == "subtitles") JSONArray(value) else value)
                is Double -> payload.put(key, value)
                is Boolean -> payload.put(key, value)
                is Int -> payload.put(key, value)
                is Long -> payload.put(key, value)
                is JSONArray -> payload.put(key, value)
            }
        }
        return payload
    }

    /** Full teardown: bounded, idempotent, orientation + background restored. */
    private fun teardown() {
        abandonAudioFocus()
        localDownloadId = null
        terminalSent = true
        playId = ""
        pendingSeek = null
        mainHandler.removeCallbacks(timeTicker)
        tracksHandler.removeCallbacks(tracksRefresher)
        try {
            mediaPlayer?.setEventListener(null)
            mediaPlayer?.stop()
        } catch (ignored: Exception) {
        }
        try {
            mediaPlayer?.detachViews()
        } catch (ignored: Exception) {
        }
        mediaPlayer?.release()
        mediaPlayer = null
        subtitleFiles.forEach { it.delete() }
        subtitleFiles.clear()
        libVLC?.release()
        libVLC = null
        videoLayout?.let { layout ->
            (layout.parent as? ViewGroup)?.removeView(layout)
        }
        videoLayout = null
        bridge?.webView?.setBackgroundColor(Color.BLACK)
        if (attachedOrientation != Configuration.ORIENTATION_UNDEFINED) {
            bridge?.activity?.requestedOrientation =
                previousOrientation
            attachedOrientation = Configuration.ORIENTATION_UNDEFINED
        }
        bridge?.activity?.window?.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }
}
