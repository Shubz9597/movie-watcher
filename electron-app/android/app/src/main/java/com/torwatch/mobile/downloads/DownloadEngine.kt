package com.torwatch.mobile.downloads

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import kotlin.math.min
import kotlin.math.pow

/**
 * Android's downloader: the iPhone DownloadCoordinator's behaviour on a
 * background thread kept alive by [DownloadService].
 *
 *  - One download at a time, oldest first: on a slow link each episode
 *    finishes (and can be watched) while the next one downloads.
 *  - A download handed over while the server still prepares it asks for its
 *    manifest (the server waits up to 240 s per request) until it is ready.
 *  - Transfers resume where they stopped (HTTP Range); every file is checked
 *    against the manifest's size and SHA-256 before the download is ready,
 *    and the staging folder is renamed into ready/ (never half there).
 *  - Wi-Fi only (on by default): transfers are opened on the Wi-Fi network
 *    itself, so they never use mobile data, and wait while there is none.
 *  - Connection drops retry from the bytes received, 15 s ... 4 min apart,
 *    12 times; a new network starts the count over.
 */
object DownloadEngine {

    private const val PREFS = "torwatch.downloads"
    private const val KEY_WIFI_ONLY = "wifiOnly"
    private const val MAX_RETRIES = 12
    private const val MANIFEST_WAIT_SECONDS = 240

    private lateinit var appContext: Context
    private lateinit var store: DownloadStore
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val lock = Object()
    private var started = false

    @Volatile private var wifiNetwork: Network? = null
    @Volatile private var anyNetwork = true
    @Volatile private var current: String? = null
    /** Downloads whose running transfer must stop (paused or removed). */
    private val stopRequests = java.util.Collections.newSetFromMap(java.util.concurrent.ConcurrentHashMap<String, Boolean>())
    private val speeds = java.util.concurrent.ConcurrentHashMap<String, Double>()
    private var attempts = 0
    @Volatile private var wakeups = 0L

    fun init(context: Context) {
        synchronized(lock) {
            if (started) return
            started = true
            appContext = context.applicationContext
            store = DownloadStore.get(appContext)
            // A download marked active when the app died continues.
            for (record in store.list()) {
                if (record.state == DownloadStore.State.VERIFYING) store.setState(record.downloadId, DownloadStore.State.DOWNLOADING)
            }
            watchNetwork()
            Thread(::loop, "torwatch-downloads").apply { isDaemon = true }.start()
        }
    }

    fun store(): DownloadStore = store

    fun onChange(listener: () -> Unit) { listeners.add(listener) }
    fun removeListener(listener: () -> Unit) { listeners.remove(listener) }

    private fun emitChange() {
        for (listener in listeners) {
            try { listener() } catch (_: Exception) {}
        }
        DownloadService.refresh(appContext)
    }

    // MARK: - Wi-Fi only

    val wifiOnly: Boolean get() = appContext.getSharedPreferences(PREFS, 0).getBoolean(KEY_WIFI_ONLY, true)

    fun setWifiOnly(enabled: Boolean) {
        appContext.getSharedPreferences(PREFS, 0).edit().putBoolean(KEY_WIFI_ONLY, enabled).apply()
        // A running transfer on mobile data stops at once; one waiting for
        // Wi-Fi starts.
        current?.let { if (enabled && wifiNetwork == null) stopRequests.add(it) }
        wake()
        emitChange()
    }

    val waitingForWifi: Boolean get() = wifiOnly && wifiNetwork == null

    private fun watchNetwork() {
        val cm = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val wifi = NetworkRequest.Builder()
            .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
            .addTransportType(NetworkCapabilities.TRANSPORT_ETHERNET)
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()
        cm.registerNetworkCallback(wifi, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                wifiNetwork = network
                networkChanged()
            }
            override fun onLost(network: Network) {
                if (wifiNetwork == network) wifiNetwork = null
                // Wi-Fi only and Wi-Fi gone: the transfer stops and waits.
                current?.let { if (wifiOnly) stopRequests.add(it) }
                emitChange()
            }
        })
        cm.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                anyNetwork = true
                networkChanged()
            }
            override fun onLost(network: Network) {
                anyNetwork = false
            }
        })
    }

    private fun networkChanged() {
        synchronized(lock) { attempts = 0 }
        // Failed only for lack of network: back in line.
        for (record in store.list()) {
            if (record.state == DownloadStore.State.FAILED && record.reason == "network_failed") {
                store.setState(record.downloadId, DownloadStore.State.QUEUED)
            }
        }
        wake()
        emitChange()
    }

    // MARK: - Public API (plugin)

    data class Enqueue(
        val downloadId: String, val instanceId: String, val origin: String, val clientId: String,
        val seriesId: String, val season: Int, val episode: Int, val title: String,
        val posterUrl: String, val subtitleLabel: String,
        val assets: List<DownloadStore.Asset>,
    )

    fun enqueue(request: Enqueue) {
        val existing = store.get(request.downloadId)
        if (existing != null) {
            // Already handed over: only a missing manifest is filled in.
            if (existing.assets.isEmpty() && request.assets.isNotEmpty()) {
                store.update(request.downloadId) { it.assets = request.assets.toMutableList() }
                wake()
                emitChange()
            }
            return
        }
        val now = System.currentTimeMillis()
        store.upsert(DownloadStore.Record(
            request.downloadId, request.instanceId, request.origin, request.clientId, request.seriesId,
            request.season, request.episode, request.title, request.posterUrl, request.subtitleLabel,
            DownloadStore.State.QUEUED, "", request.assets.toMutableList(), now, now))
        DownloadService.start(appContext)
        wake()
        emitChange()
    }

    fun pause(id: String) {
        stopRequests.add(id)
        store.setState(id, DownloadStore.State.PAUSED)
        wake()
        emitChange()
    }

    fun resume(id: String) {
        val record = store.get(id) ?: return
        if (record.state == DownloadStore.State.FAILED && record.reason == "verification_failed") {
            // Never reuse a damaged file.
            store.stagingDir(id).deleteRecursively()
            store.update(id) { r -> r.assets.forEach { it.receivedBytes = 0; it.done = false } }
        }
        if (record.state != DownloadStore.State.READY) store.setState(id, DownloadStore.State.QUEUED)
        stopRequests.remove(id)
        DownloadService.start(appContext)
        wake()
        emitChange()
    }

    /** Cancels and forgets a download: its transfer stops, its files go. */
    fun remove(id: String) {
        stopRequests.add(id)
        store.delete(id)
        store.stagingDir(id).deleteRecursively()
        store.readyDir(id).deleteRecursively()
        speeds.remove(id)
        wake()
        emitChange()
    }

    fun metrics(id: String): Pair<Long, Long?> {
        val speed = speeds[id] ?: 0.0
        if (speed < 1024) return 0L to null
        val record = store.get(id) ?: return 0L to null
        val remaining = (record.totalBytes - record.receivedBytes).coerceAtLeast(0)
        return speed.toLong() to min(30L * 24 * 3600, (remaining / speed).toLong() + 1)
    }

    fun hasWork(): Boolean = store.list().any {
        it.state == DownloadStore.State.QUEUED || it.state == DownloadStore.State.DOWNLOADING || it.state == DownloadStore.State.VERIFYING
    }

    fun activeRecord(): DownloadStore.Record? = current?.let { store.get(it) }

    fun storage(): Pair<Long, Long> {
        val used = store.root.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        return store.root.usableSpace to used
    }

    // MARK: - The worker

    private fun wake() {
        synchronized(lock) {
            wakeups++
            lock.notifyAll()
        }
    }

    private fun sleep(ms: Long) {
        synchronized(lock) {
            val seen = wakeups
            val until = System.currentTimeMillis() + ms
            while (wakeups == seen) {
                val left = until - System.currentTimeMillis()
                if (left <= 0) break
                lock.wait(left)
            }
        }
    }

    private fun loop() {
        while (true) {
            val records = store.list()
            val next = records.firstOrNull { it.state == DownloadStore.State.DOWNLOADING }
                ?: records.firstOrNull { it.state == DownloadStore.State.QUEUED }
            if (next == null || waitingForWifi || !anyNetwork) {
                if (next == null) DownloadService.idle(appContext)
                sleep(60_000)
                continue
            }
            stopRequests.remove(next.downloadId)
            current = next.downloadId
            try {
                run(next.downloadId)
            } catch (_: Exception) {
            } finally {
                current = null
                speeds.remove(next.downloadId)
            }
            emitChange()
        }
    }

    private class Stopped : Exception()

    private fun run(id: String) {
        synchronized(progressLock) { progressSampleAt = 0L; progressSavedAt = 0L }
        store.setState(id, DownloadStore.State.DOWNLOADING)
        emitChange()
        try {
            if (store.get(id)?.assets.isNullOrEmpty() && !awaitManifest(id)) return
            val record = store.get(id) ?: return
            for (asset in record.assets) {
                if (!asset.done) transfer(record, asset)
            }
            finalize(id)
            synchronized(lock) { attempts = 0 }
        } catch (_: Stopped) {
            // Paused, removed, or Wi-Fi left: the state says which.
        } catch (error: IOException) {
            retryOrFail(id, "network_failed")
        } catch (error: ServerError) {
            retryOrFail(id, error.reason, error.retryable)
        }
    }

    private class ServerError(val reason: String, val retryable: Boolean) : Exception()

    private fun retryOrFail(id: String, reason: String, retryable: Boolean = true) {
        val attempt = synchronized(lock) { ++attempts }
        if (!retryable || attempt > MAX_RETRIES) {
            synchronized(lock) { attempts = 0 }
            store.setState(id, DownloadStore.State.FAILED, reason)
            emitChange()
            return
        }
        emitChange()
        sleep((15_000.0 * 2.0.pow(attempt - 1)).toLong().coerceAtMost(240_000))
    }

    private fun checkStop(id: String) {
        if (stopRequests.contains(id) || store.get(id)?.state != DownloadStore.State.DOWNLOADING) throw Stopped()
        if (waitingForWifi) throw Stopped()
    }

    private fun open(url: URL): HttpURLConnection {
        val network = if (wifiOnly) wifiNetwork ?: throw Stopped() else null
        return (network?.openConnection(url) ?: url.openConnection()) as HttpURLConnection
    }

    private fun clientQuery(record: DownloadStore.Record) = "clientId=" + URLEncoder.encode(record.clientId, "UTF-8")

    /** Asks for the manifest until the server has prepared the package. */
    private fun awaitManifest(id: String): Boolean {
        while (true) {
            checkStop(id)
            val record = store.get(id) ?: return false
            val url = URL(record.origin.trimEnd('/') + "/v1/downloads/jobs/" + URLEncoder.encode(id, "UTF-8") +
                "/manifest?" + clientQuery(record) + "&wait=$MANIFEST_WAIT_SECONDS")
            val connection = open(url)
            connection.connectTimeout = 15_000
            connection.readTimeout = (MANIFEST_WAIT_SECONDS + 60) * 1000
            try {
                when (val code = connection.responseCode) {
                    200 -> {
                        val body = connection.inputStream.bufferedReader().readText()
                        val assets = manifestAssets(JSONObject(body)) ?: throw ServerError("server_error", false)
                        store.update(id) { it.assets = assets.toMutableList() }
                        emitChange()
                        return true
                    }
                    202 -> sleep(2_000) // still preparing: ask again
                    410 -> throw ServerError("server_failed", false)
                    in 500..599 -> throw ServerError("server_error", true)
                    else -> throw ServerError(if (code == 404) "server_failed" else "server_error", false)
                }
            } finally {
                connection.disconnect()
            }
        }
    }

    fun manifestAssets(json: JSONObject): List<DownloadStore.Asset>? {
        if (json.optInt("manifestVersion") != 1) return null
        val video = json.optJSONObject("video") ?: return null
        val path = video.optString("path")
        val size = video.optLong("sizeBytes")
        val sha = video.optString("sha256")
        if (!path.startsWith("/v1/downloads/jobs/") || size <= 0 || sha.length != 64) return null
        val assets = mutableListOf(DownloadStore.Asset(path, DownloadStore.diskName(""), size, sha.lowercase(), ""))
        val subs = json.optJSONArray("subtitles")
        if (subs != null) {
            for (i in 0 until subs.length()) {
                val s = subs.getJSONObject(i)
                val lang = s.optString("lang").lowercase()
                val subPath = s.optString("path")
                val subSize = s.optLong("sizeBytes")
                val subSha = s.optString("sha256")
                if (lang.length != 2 || !subPath.startsWith("/v1/downloads/jobs/") || subSize <= 0 || subSha.length != 64) return null
                assets.add(DownloadStore.Asset(subPath, DownloadStore.diskName(lang), subSize, subSha.lowercase(), lang))
            }
        }
        return assets
    }

    // A video downloads in parts at once (HTTP Range), joined before the
    // SHA-256 check: one connection over a lossy path (Tailscale's UDP
    // through an ISP that drops it) ran at ~5 Mbps where the line carried
    // ~70. Each part resumes from what it has.
    private const val PART_COUNT = 4
    private const val MIN_PARTED_BYTES = 64L shl 20

    private fun transfer(record: DownloadStore.Record, asset: DownloadStore.Asset) {
        val id = record.downloadId
        val dir = store.stagingDir(id).apply { mkdirs() }
        val file = File(dir, asset.diskName)
        val url = URL(record.origin.trimEnd('/') + asset.urlPath + "?" + clientQuery(record))
        val whole = file.exists() && file.length() == asset.sizeBytes
        if (!whole && asset.lang.isEmpty() && asset.sizeBytes >= MIN_PARTED_BYTES) {
            transferParts(id, asset, url, dir, file)
        } else if (!whole) {
            fetchRange(id, url, file, 0, asset.sizeBytes - 1) { received -> progress(id, asset.urlPath, received) }
        }
        if (file.length() != asset.sizeBytes) throw IOException("incomplete")
        store.update(id) { r -> r.asset(asset.urlPath)?.let { it.receivedBytes = asset.sizeBytes; it.done = true } }
        emitChange()
    }

    private fun partRanges(size: Long): List<LongRange> {
        val step = (size + PART_COUNT - 1) / PART_COUNT
        return (0 until PART_COUNT).mapNotNull { k ->
            val first = k * step
            val last = minOf(size, first + step) - 1
            if (first <= last) first..last else null
        }
    }

    private fun transferParts(id: String, asset: DownloadStore.Asset, url: URL, dir: File, file: File) {
        val ranges = partRanges(asset.sizeBytes)
        val parts = ranges.indices.map { File(dir, "${asset.diskName}.part$it") }
        val received = LongArray(ranges.size) { k -> parts[k].takeIf { it.exists() }?.length() ?: 0L }
        val failures = java.util.concurrent.ConcurrentLinkedQueue<Throwable>()
        val workers = ranges.mapIndexed { k, range ->
            Thread({
                try {
                    fetchRange(id, url, parts[k], range.first, range.last) { bytes ->
                        val total = synchronized(received) { received[k] = bytes; received.sum() }
                        progress(id, asset.urlPath, total)
                    }
                } catch (error: Throwable) {
                    failures.add(error)
                }
            }, "torwatch-part-$k").apply { start() }
        }
        workers.forEach { it.join() }
        failures.peek()?.let { throw it }
        // Every part complete: joined into the video.
        val joining = File(dir, "${asset.diskName}.joining")
        FileOutputStream(joining).use { out ->
            for (part in parts) part.inputStream().use { it.copyTo(out, 4 * 1024 * 1024) }
        }
        if (joining.length() != asset.sizeBytes) {
            joining.delete()
            throw IOException("joined parts are the wrong size")
        }
        file.delete()
        if (!joining.renameTo(file)) throw IOException("could not place the joined video")
        parts.forEach { it.delete() }
    }

    /** Bytes [first, last] of url into file, continuing from what it has. */
    private fun fetchRange(id: String, url: URL, file: File, first: Long, last: Long, onBytes: (Long) -> Unit) {
        val length = last - first + 1
        var have = if (file.exists()) file.length() else 0L
        if (have > length) { file.delete(); have = 0 }
        if (have == length) { onBytes(have); return }
        val connection = open(url)
        connection.connectTimeout = 15_000
        connection.readTimeout = 90_000 // silent this long: reconnect
        connection.setRequestProperty("Range", "bytes=${first + have}-$last")
        try {
            val code = connection.responseCode
            if (code == 200) {
                // The server ignored the range: only a whole-file request can use it.
                if (first != 0L) throw ServerError("server_error", true)
                have = 0
            } else if (code != 206) {
                throw ServerError("server_error", code in 500..599)
            }
            FileOutputStream(file, have > 0).use { out ->
                connection.inputStream.use { input ->
                    val buffer = ByteArray(64 * 1024)
                    var written = have
                    var lastCheck = 0L
                    while (written < length) {
                        val count = input.read(buffer, 0, minOf(buffer.size.toLong(), length - written).toInt())
                        if (count < 0) break
                        out.write(buffer, 0, count)
                        written += count
                        val now = System.currentTimeMillis()
                        if (now - lastCheck >= 500) {
                            lastCheck = now
                            checkStop(id)
                            onBytes(written)
                        }
                    }
                    onBytes(written)
                    if (written != length) throw IOException("connection ended early")
                }
            }
        } finally {
            connection.disconnect()
        }
    }

    // Progress of the asset being transferred (all its parts together): the
    // store's byte count, the screen and the speed estimate.
    private val progressLock = Object()
    private var progressSampleAt = 0L
    private var progressSampleBytes = 0L
    private var progressSavedAt = 0L
    private var progressEmitAt = 0L

    private fun progress(id: String, urlPath: String, received: Long) {
        val now = System.currentTimeMillis()
        synchronized(progressLock) {
            if (progressSampleAt == 0L || received < progressSampleBytes) {
                progressSampleAt = now
                progressSampleBytes = received
            } else if (now - progressSampleAt >= 1000) {
                val instant = (received - progressSampleBytes) * 1000.0 / (now - progressSampleAt)
                speeds[id] = (speeds[id] ?: instant) * 0.7 + instant * 0.3
                progressSampleAt = now
                progressSampleBytes = received
            }
            val persist = now - progressSavedAt >= 5_000
            if (persist) progressSavedAt = now
            store.setReceived(id, urlPath, received, persist)
            if (now - progressEmitAt < 500) return
            progressEmitAt = now
        }
        emitChange()
    }

    /** Every file checked, then staging renamed into ready/. */
    private fun finalize(id: String) {
        val record = store.get(id) ?: return
        store.setState(id, DownloadStore.State.VERIFYING)
        emitChange()
        val staging = store.stagingDir(id)
        for (asset in record.assets) {
            if (sha256(File(staging, asset.diskName)) != asset.sha256.lowercase()) {
                store.setState(id, DownloadStore.State.FAILED, "verification_failed")
                emitChange()
                throw Stopped()
            }
        }
        val ready = store.readyDir(id)
        ready.parentFile?.mkdirs()
        ready.deleteRecursively()
        if (!staging.renameTo(ready)) {
            store.setState(id, DownloadStore.State.FAILED, "storage_failed")
            emitChange()
            throw Stopped()
        }
        store.setState(id, DownloadStore.State.READY)
        emitChange()
    }

    fun sha256(file: File): String? = try {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(4 * 1024 * 1024)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                digest.update(buffer, 0, n)
            }
        }
        digest.digest().joinToString("") { "%02x".format(it) }
    } catch (_: IOException) {
        null
    }
}
