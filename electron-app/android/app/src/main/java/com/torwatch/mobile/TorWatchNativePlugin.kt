package com.torwatch.mobile

import android.content.Intent
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * TorWatchNativePlugin (feature 002 M1.4.5) — local Capacitor plugin
 * implementing full-screen native playback with AndroidX Media3 (ExoPlayer).
 *
 * Security/privacy invariants:
 *  - Only OPAQUE playback/subtitle URLs (from /v2/playback/sessions) plus a
 *    display title and a per-play identifier cross the bridge. No magnets,
 *    tokens, or credentials.
 *  - Every event carries the `playId` chosen by the web layer, so events from
 *    a replaced (dying) activity can never be attributed to the new session.
 *
 * Networking: cleartext is permitted ONLY for the documented development
 * origins (res/xml/network_security_config.xml). Release deployments use
 * HTTPS origins (Tailscale Serve HTTPS), where no cleartext is needed.
 */
@CapacitorPlugin(name = "TorWatchNative")
class TorWatchNativePlugin : Plugin() {

    @PluginMethod
    fun play(call: PluginCall) {
        val url = call.getString("url")
        if (url.isNullOrEmpty()) {
            call.reject("The playback URL is missing or invalid.")
            return
        }
        val playId = call.getString("playId")
        if (playId.isNullOrEmpty()) {
            call.reject("The playback identifier is missing.")
            return
        }
        val title = call.getString("title") ?: "TorWatch"
        val subtitles: JSArray? = call.getArray("subtitles")
        val seekTo: Double? = call.getDouble("seekTo")

        val intent = Intent(getContext(), TorWatchPlaybackActivity::class.java).apply {
            putExtra(TorWatchPlaybackActivity.EXTRA_URL, url)
            putExtra(TorWatchPlaybackActivity.EXTRA_TITLE, title)
            putExtra(TorWatchPlaybackActivity.EXTRA_PLAY_ID, playId)
            subtitles?.toString()?.let { putExtra(TorWatchPlaybackActivity.EXTRA_SUBTITLES, it) }
            seekTo?.let { putExtra(TorWatchPlaybackActivity.EXTRA_SEEK_TO, it) }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        TorWatchPlaybackActivity.setEventSink { name, data ->
            val payload = JSObject()
            for (key in data.keySet()) {
                when (val value = data.get(key)) {
                    is String -> payload.put(key, value)
                    is Double -> payload.put(key, value)
                    is Boolean -> payload.put(key, value)
                    is Int -> payload.put(key, value)
                    is Long -> payload.put(key, value)
                }
            }
            notifyListeners(name, payload)
        }
        getContext().startActivity(intent)
        call.resolve()
    }

    @PluginMethod
    fun seek(call: PluginCall) {
        val position = call.getDouble("positionSec")
        val playId = call.getString("playId")
        if (position == null || playId.isNullOrEmpty()) {
            call.reject("The seek request is incomplete.")
            return
        }
        TorWatchPlaybackActivity.seekTo(playId, position)
        call.resolve()
    }

    @PluginMethod
    fun dismiss(call: PluginCall) {
        val playId = call.getString("playId")
        if (playId.isNullOrEmpty()) {
            call.reject("The playback identifier is missing.")
            return
        }
        TorWatchPlaybackActivity.dismissCurrent(playId)
        call.resolve()
    }
}
