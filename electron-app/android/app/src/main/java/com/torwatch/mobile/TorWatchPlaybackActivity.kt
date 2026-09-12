package com.torwatch.mobile

import android.content.Intent
import androidx.media3.common.AudioAttributes
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import androidx.annotation.NonNull
import androidx.annotation.Nullable
import androidx.appcompat.app.AppCompatActivity
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaItem.SubtitleConfiguration
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.ui.PlayerView
import org.json.JSONArray

/**
 * Full-screen Media3 playback activity (feature 002 M1.4.5).
 *
 * Lifecycle/teardown contract (repair pass M1.4):
 *  - The player, PlayerView and listeners live only in this activity;
 *    onDestroy releases them.
 *  - Static `current`/`eventSink` are cleared ONLY when THIS instance is the
     *    current one -- a replaced (dying) activity can never tear down the newly
 *    started playback's sink.
 *  - Every emitted event carries the web-chosen `playId`, so events from a
 *    replaced activity are dropped web-side instead of killing the new
 *    session.
 *  - Exactly one terminal event per playback (ended / error / stopped),
 *    guarded by [terminalSent]; error and ended paths FINISH the activity.
 *  - Back finishes playback cleanly; the emitted "stopped" state drives the
 *    shared session client's server-side DELETE.
 *  - Audio focus is delegated to ExoPlayer (handleAudioFocus = true).
 *
 * Networking: cleartext is permitted ONLY for the documented development
 * origins (res/xml/network_security_config.xml). Release deployments use
 * HTTPS origins and need no cleartext exception.
 */
class TorWatchPlaybackActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_URL = "torwatch.url"
        const val EXTRA_TITLE = "torwatch.title"
        const val EXTRA_SUBTITLES = "torwatch.subtitles"
        const val EXTRA_SEEK_TO = "torwatch.seekTo"
        const val EXTRA_PLAY_ID = "torwatch.playId"
        const val EVENT_TIME_UPDATE = "timeUpdate"
        const val EVENT_PLAYBACK_STATE = "playbackState"
        const val KEY_PLAY_ID = "playId"

        private val sinkLock = Any()
        private var eventSink: ((String, Bundle) -> Unit)? = null
        private var current: TorWatchPlaybackActivity? = null

        fun setEventSink(sink: ((String, Bundle) -> Unit)?) {
            synchronized(sinkLock) { eventSink = sink }
        }

        @JvmStatic
        fun seekTo(playId: String, positionSec: Double) {
            val activity = current ?: return
            if (activity.playId != playId) return
            activity.player?.seekTo((positionSec * 1000.0).toLong())
        }

        @JvmStatic
        fun dismissCurrent(playId: String) {
            val activity = current ?: return
            if (activity.playId != playId) return
            activity.runOnUiThread { activity.finish() }
        }
    }

    private var player: ExoPlayer? = null
    private var playerView: PlayerView? = null
    private var terminalSent = false
    private var playId: String = ""
    private val timeHandler = Handler(Looper.getMainLooper())

    private val timeTicker = object : Runnable {
        override fun run() {
            val activePlayer = player
            if (activePlayer != null && !terminalSent) {
                val data = Bundle().apply {
                    putDouble("currentTime", activePlayer.currentPosition / 1000.0)
                    putDouble("duration", if (activePlayer.duration > 0) activePlayer.duration / 1000.0 else 0.0)
                    putString(KEY_PLAY_ID, playId)
                }
                emitEvent(EVENT_TIME_UPDATE, data)
            }
            timeHandler.postDelayed(this, 500)
        }
    }

    override fun onCreate(@Nullable savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        current = this
        setTheme(androidx.appcompat.R.style.Theme_AppCompat_NoActionBar)
        playerView = PlayerView(this)
        setContentView(playerView)

        val url = intent.getStringExtra(EXTRA_URL)
        val title = intent.getStringExtra(EXTRA_TITLE)
        playId = intent.getStringExtra(EXTRA_PLAY_ID) ?: ""
        if (url.isNullOrEmpty() || playId.isEmpty()) {
            finishWithError("The playback request is incomplete.")
            return
        }
        setTitle(title ?: "TorWatch")

        val renderersFactory = DefaultRenderersFactory(this)
        val newPlayer = ExoPlayer.Builder(this, renderersFactory)
            .setMediaSourceFactory(DefaultMediaSourceFactory(DefaultDataSource.Factory(this)))
            .build()
        player = newPlayer
        playerView?.player = newPlayer
        newPlayer.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
                .build(),
            /* handleAudioFocus = */ true
        )

        newPlayer.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED && !terminalSent) {
                    terminalSent = true
                    finishWithState("ended")
                    finish()
                }
            }

            override fun onPlayerError(@NonNull error: PlaybackException) {
                if (!terminalSent) {
                    terminalSent = true
                    // Truthful, bounded message; never includes the URL.
                    finishWithError("The media could not be played on this device.")
                }
            }
        })

        newPlayer.setMediaItem(buildMediaItem(url, intent.getStringExtra(EXTRA_SUBTITLES)))
        newPlayer.prepare()
        val seekTo = intent.getDoubleExtra(EXTRA_SEEK_TO, 0.0)
        if (seekTo > 0) {
            newPlayer.seekTo((seekTo * 1000.0).toLong())
        }
        playerView?.setControllerShowTimeoutMs(3500)
        playerView?.setShowNextButton(false)
        newPlayer.play()
        timeHandler.postDelayed(timeTicker, 500)
    }

    /**
     * Direct/HLS media item with sidecar WebVTT subtitle configurations
     * attached (Media3 merges them as selectable text tracks). HLS subtitle
     * renditions declared inside the master playlist play natively. A
     * malformed sidecar list must never break video playback.
     */
    private fun buildMediaItem(url: String, sidecarsJson: String?): MediaItem {
        val builder = MediaItem.Builder().setUri(url)
        if (!sidecarsJson.isNullOrEmpty()) {
            try {
                val array = JSONArray(sidecarsJson)
                val configurations = ArrayList<SubtitleConfiguration>()
                for (i in 0 until array.length()) {
                    val sub = array.getJSONObject(i)
                    val subUrl = sub.optString("url")
                    if (subUrl.isEmpty()) continue
                    configurations.add(
                        SubtitleConfiguration.Builder(android.net.Uri.parse(subUrl))
                            .setMimeType(MimeTypes.TEXT_VTT)
                            .setLanguage(sub.optString("language", "und"))
                            .setLabel(sub.optString("label", "Subtitle"))
                            .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
                            .build()
                    )
                }
                builder.setSubtitleConfigurations(configurations)
            } catch (ignored: Exception) {
                // fall through with the video-only item
            }
        }
        return builder.build()
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        // Back dismisses playback cleanly; the terminal "stopped" event drives
        // the shared session client's DELETE.
        if (keyCode == KeyEvent.KEYCODE_BACK && !terminalSent) {
            terminalSent = true
            finishWithState("stopped")
            finish()
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onDestroy() {
        timeHandler.removeCallbacks(timeTicker)
        player?.release()
        player = null
        playerView?.player = null
        if (!terminalSent) {
            terminalSent = true
            // teardown-driven dismissals (replacement / explicit close) end
            // here: notify 'stopped' so the web session client deletes the
            // server session.
            finishWithState("stopped")
        }
        // Replacement safety: clear the statics ONLY if THIS instance is still
        // the current one. A dying replaced activity must never clear the
        // newly started playback's sink or current pointer.
        synchronized(sinkLock) {
            if (current === this) {
                current = null
                eventSink = null
            }
        }
        super.onDestroy()
    }

    private fun finishWithError(message: String) {
        finishWithState("error", message)
        finish()
    }

    private fun finishWithState(state: String, message: String? = null) {
        val data = Bundle().apply {
            putString("state", state)
            putString(KEY_PLAY_ID, playId)
            if (message != null) putString("message", message)
        }
        emitEvent(EVENT_PLAYBACK_STATE, data)
    }

    private fun emitEvent(name: String, data: Bundle) {
        val sink = synchronized(sinkLock) { eventSink } ?: return
        sink(name, data)
    }
}
