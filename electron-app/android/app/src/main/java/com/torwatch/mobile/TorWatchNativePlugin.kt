package com.torwatch.mobile

import android.content.res.Configuration
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
    }

    private var libVLC: LibVLC? = null
    private var mediaPlayer: MediaPlayer? = null
    private var videoLayout: VLCVideoLayout? = null
    private var playId: String = ""
    private var terminalSent = false
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
        val sidecars: List<String> = call.getArray("subtitles")
            ?.toList<Any>()
            ?.mapNotNull { item -> (item as? JSONObject)?.optString("url")?.takeIf { it.isNotBlank() } }
            ?: emptyList()

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

        val newLibVlc = LibVLC(
            activity,
            arrayListOf(
                "--audio-time-stretch",
                "--network-caching=$NETWORK_CACHING_MS",
            ),
        )
        libVLC = newLibVlc
        val player = MediaPlayer(newLibVlc)
        mediaPlayer = player

        player.setEventListener { event ->
            mainHandler.post {
                if (event == null || playId != newPlayId || mediaPlayer !== player || terminalSent) return@post
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
                    MediaPlayer.Event.Paused -> emit(EVENT_PLAYBACK_STATE) {
                        putString("state", "paused")
                        putString(KEY_PLAY_ID, playId)
                    }
                    MediaPlayer.Event.Buffering -> emitBuffering(event.buffering < 100f, event.buffering.toDouble())
                    MediaPlayer.Event.SeekableChanged -> applyPendingSeek()
                    MediaPlayer.Event.EndReached -> {
                        if (!terminalSent) {
                            terminalSent = true
                            emit(EVENT_PLAYBACK_STATE) {
                                putString("state", "ended")
                                putString(KEY_PLAY_ID, playId)
                            }
                        }
                    }
                    MediaPlayer.Event.EncounteredError -> {
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
        // Initial sidecars (session contract offers) attach as slaves.
        for (sidecar in sidecars) {
            try {
                media.addSlave(IMedia.Slave(IMedia.Slave.Type.Subtitle, 0, sidecar))
            } catch (ignored: Exception) {
                // A malformed sidecar never breaks video playback.
            }
        }
        player.media = media
        media.release()
        player.attachViews(layout, null, true, true)

        if (seekTo != null && seekTo > 0) {
            pendingSeek = (seekTo * 1000.0).toLong()
        }
        player.play()

        mainHandler.postDelayed(timeTicker, TIME_TICK_MS)
        scheduleTracksRefresh()
        call.resolve()
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
            player.play()
        }
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
            .map { mapOf("id" to it.id, "label" to (it.name ?: "")) }
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
