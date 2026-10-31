package com.torwatch.mobile.downloads

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.torwatch.mobile.TorWatchNativePlugin
import java.io.File

/**
 * The Downloads bridge ("TorWatchDownloads"): the iPhone plugin's methods,
 * arguments and answers, so the shared app (download-queue.ts, Downloads,
 * Settings) works unchanged. Only contract-shaped data crosses: ids, states,
 * byte counts, titles; never magnets or sandbox paths except the ready
 * files' paths for offline playback.
 */
@CapacitorPlugin(name = "TorWatchDownloads")
class TorWatchDownloadsPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private var changeQueued = false
    private val listener: () -> Unit = {
        // Progress changes often: the screen re-reads at most every 300 ms.
        main.post {
            if (!changeQueued) {
                changeQueued = true
                main.postDelayed({
                    changeQueued = false
                    notifyListeners("downloadsChanged", JSObject())
                }, 300)
            }
        }
    }

    override fun load() {
        super.load()
        DownloadEngine.init(context)
        DownloadEngine.onChange(listener)
        handleRoute(activity?.intent)
        if (DownloadEngine.hasWork()) DownloadService.start(context)
    }

    override fun handleOnNewIntent(intent: Intent) {
        super.handleOnNewIntent(intent)
        handleRoute(intent)
    }

    override fun handleOnDestroy() {
        DownloadEngine.removeListener(listener)
        super.handleOnDestroy()
    }

    /** The notification's tap opens Downloads (kept until the app listens). */
    private fun handleRoute(intent: Intent?) {
        val route = intent?.getStringExtra("torwatchRoute") ?: return
        intent.removeExtra("torwatchRoute")
        notifyListeners("openRoute", JSObject().put("route", route), true)
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", true))
    }

    @PluginMethod
    fun list(call: PluginCall) {
        val store = DownloadEngine.store()
        val waitingForWifi = DownloadEngine.waitingForWifi
        val items = JSArray()
        for (record in store.list()) {
            val (speed, eta) = DownloadEngine.metrics(record.downloadId)
            val item = JSObject()
                .put("downloadId", record.downloadId)
                .put("instanceId", record.instanceId)
                .put("origin", record.origin)
                .put("seriesId", record.seriesId)
                .put("season", record.season)
                .put("episode", record.episode)
                .put("title", record.title)
                .put("posterUrl", record.posterUrl)
                .put("subtitleLabel", record.subtitleLabel)
                .put("state", record.state.wire)
                .put("reason", record.reason)
                .put("receivedBytes", record.receivedBytes)
                .put("totalBytes", record.totalBytes)
                .put("bytesPerSecond", speed)
                .put("awaitingServer", record.assets.isEmpty())
                .put("waitingForWifi", waitingForWifi && record.state == DownloadStore.State.DOWNLOADING)
            if (eta != null) item.put("etaSeconds", eta)
            store.loadProgress(record.downloadId)?.let {
                item.put("positionS", it.positionS).put("durationS", it.durationS)
                    .put("progressUpdatedAt", it.updatedAt).put("subtitleLang", it.subtitleLang)
            }
            items.put(item)
        }
        call.resolve(JSObject().put("items", items))
    }

    @PluginMethod
    fun enqueue(call: PluginCall) {
        val downloadId = call.getString("downloadId")
        val instanceId = call.getString("instanceId")
        val origin = call.getString("origin")
        val clientId = call.getString("clientId")
        val seriesId = call.getString("seriesId")
        val title = call.getString("title")
        if (downloadId.isNullOrEmpty() || instanceId.isNullOrEmpty() || clientId.isNullOrEmpty() || seriesId.isNullOrEmpty()
            || title.isNullOrEmpty() || origin == null || !(origin.startsWith("http://") || origin.startsWith("https://"))) {
            call.reject("The download request is incomplete.")
            return
        }
        // No video yet: the server is still preparing it; the downloader
        // waits for it itself.
        val assets = mutableListOf<DownloadStore.Asset>()
        call.getObject("video")?.let { video ->
            val path = video.optString("path")
            val size = video.optLong("sizeBytes")
            val sha = video.optString("sha256")
            if (!path.startsWith("/v1/downloads/jobs/") || size <= 0 || sha.length != 64) {
                call.reject("The download request is incomplete.")
                return
            }
            assets.add(DownloadStore.Asset(path, DownloadStore.diskName(""), size, sha.lowercase(), ""))
            val subs = call.getArray("subtitles")
            if (subs != null) {
                for (i in 0 until subs.length()) {
                    val sub = subs.getJSONObject(i)
                    val lang = sub.optString("lang").lowercase()
                    val subPath = sub.optString("path")
                    val subSize = sub.optLong("sizeBytes")
                    val subSha = sub.optString("sha256")
                    if (lang.length != 2 || !subPath.startsWith("/v1/downloads/jobs/") || subSize <= 0 || subSha.length != 64) {
                        call.reject("A requested subtitle sidecar is malformed.")
                        return
                    }
                    assets.add(DownloadStore.Asset(subPath, DownloadStore.diskName(lang), subSize, subSha.lowercase(), lang))
                }
            }
        }
        askForNotifications()
        DownloadEngine.enqueue(DownloadEngine.Enqueue(
            downloadId, instanceId, origin, clientId, seriesId,
            call.getInt("season") ?: 0, call.getInt("episode") ?: 0, title,
            call.getString("posterUrl") ?: "", call.getString("subtitleLabel") ?: "", assets))
        call.resolve()
    }

    /** Android 13+: the download notification needs permission (asked once). */
    private fun askForNotifications() {
        val activity = activity ?: return
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (ContextCompat.checkSelfPermission(activity, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val prefs = activity.getSharedPreferences("torwatch.downloads", 0)
        if (prefs.getBoolean("askedNotifications", false)) return
        prefs.edit().putBoolean("askedNotifications", true).apply()
        ActivityCompat.requestPermissions(activity, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 4018)
    }

    @PluginMethod
    fun pause(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        DownloadEngine.pause(id)
        call.resolve()
    }

    @PluginMethod
    fun resume(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        DownloadEngine.resume(id)
        call.resolve()
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        if (DownloadEngine.store().get(id)?.state == DownloadStore.State.READY) {
            call.reject("A ready download cannot be cancelled. Remove it instead.")
            return
        }
        DownloadEngine.remove(id)
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        // The player closes before its files go.
        TorWatchNativePlugin.stopLocalPlaybackIfActive(id) {
            DownloadEngine.remove(id)
            call.resolve()
        }
    }

    @PluginMethod
    fun storage(call: PluginCall) {
        val (free, used) = DownloadEngine.storage()
        call.resolve(JSObject().put("freeBytes", free).put("usedBytes", used))
    }

    @PluginMethod
    fun saveProgress(call: PluginCall) {
        val id = call.getString("downloadId")
        val position = call.getDouble("positionS")
        val duration = call.getDouble("durationS")
        if (id == null || position == null || duration == null) {
            call.reject("The progress record is incomplete.")
            return
        }
        DownloadEngine.store().saveProgress(id, position, duration, call.getString("subtitleLang") ?: "")
        call.resolve()
    }

    @PluginMethod
    fun loadProgress(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        val progress = DownloadEngine.store().loadProgress(id)
        if (progress == null) {
            call.resolve(JSObject().put("found", false))
            return
        }
        call.resolve(JSObject().put("found", true).put("positionS", progress.positionS)
            .put("durationS", progress.durationS).put("subtitleLang", progress.subtitleLang))
    }

    @PluginMethod
    fun localPlayablePath(call: PluginCall) {
        val id = call.getString("downloadId") ?: return call.reject("The download identifier is missing.")
        val files = DownloadEngine.store().readyFiles(id) ?: return call.reject("That download is not ready for offline playback.")
        val subs = JSArray()
        for ((lang, file) in files.second) subs.put(JSObject().put("lang", lang).put("path", file.absolutePath))
        call.resolve(JSObject().put("videoPath", files.first.absolutePath).put("subtitles", subs))
    }

    @PluginMethod
    fun relocate(call: PluginCall) {
        val id = call.getString("downloadId")
        val seriesId = call.getString("seriesId")
        val season = call.getInt("season")
        val episode = call.getInt("episode")
        if (id == null || seriesId.isNullOrEmpty() || season == null || episode == null) {
            call.reject("The move is incomplete.")
            return
        }
        DownloadEngine.store().update(id) {
            it.seriesId = seriesId
            it.season = season.coerceAtLeast(0)
            it.episode = episode.coerceAtLeast(0)
            it.subtitleLabel = call.getString("subtitleLabel") ?: "S$season E$episode"
        }
        listener()
        call.resolve()
    }

    /** A subtitle picked online replaces the download's own in that language. */
    @PluginMethod
    fun replaceSubtitle(call: PluginCall) {
        val id = call.getString("downloadId")
        val lang = call.getString("lang")?.lowercase()
        val text = call.getString("text")
        if (id.isNullOrEmpty() || lang == null || lang.length != 2 || !lang.all { it in 'a'..'z' }
            || text == null || !text.contains("-->") || text.length > 4 * 1024 * 1024) {
            call.reject("The subtitle is incomplete.")
            return
        }
        val store = DownloadEngine.store()
        val record = store.get(id)
        if (record == null || record.state != DownloadStore.State.READY) {
            call.reject("The subtitle could not be saved with the download.")
            return
        }
        val existing = record.assets.firstOrNull { it.lang == lang }
        val diskName = existing?.diskName ?: DownloadStore.diskName(lang)
        val file = File(store.readyDir(id), diskName)
        val tmp = File(store.readyDir(id), "$diskName.tmp")
        tmp.writeText(text)
        if (!tmp.renameTo(file)) {
            call.reject("The subtitle could not be saved with the download.")
            return
        }
        val sha = DownloadEngine.sha256(file) ?: ""
        store.update(id) { r ->
            r.assets.removeAll { it.lang == lang }
            r.assets.add(DownloadStore.Asset(existing?.urlPath ?: "/local/subtitles/$lang", diskName, file.length(), sha, lang, file.length(), true))
        }
        call.resolve()
    }

    @PluginMethod
    fun getNetworkRule(call: PluginCall) {
        call.resolve(JSObject().put("wifiOnly", DownloadEngine.wifiOnly).put("waitingForWifi", DownloadEngine.waitingForWifi))
    }

    @PluginMethod
    fun setNetworkRule(call: PluginCall) {
        val wifiOnly = call.getBoolean("wifiOnly") ?: return call.reject("wifiOnly is required.")
        DownloadEngine.setWifiOnly(wifiOnly)
        call.resolve(JSObject().put("wifiOnly", DownloadEngine.wifiOnly).put("waitingForWifi", DownloadEngine.waitingForWifi))
    }
}
