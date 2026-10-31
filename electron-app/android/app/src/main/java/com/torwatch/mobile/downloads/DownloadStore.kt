package com.torwatch.mobile.downloads

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * The phone's downloads: one JSON file (records, their files, local playback
 * positions) beside the files themselves, the Android twin of the iPhone's
 * DownloadStore (same states, reasons and fields cross the bridge).
 *
 *  - Files live in filesDir/Downloads: staging/<id>/ while they arrive,
 *    ready/<id>/ once every file passed its size and SHA-256 check (a rename,
 *    so a ready download is never half there).
 *  - Every change is written whole to state.json.tmp and renamed over
 *    state.json: a crash leaves the old or the new state, never a torn one.
 */
class DownloadStore private constructor(context: Context) {

    enum class State(val wire: String) {
        QUEUED("queued"), DOWNLOADING("downloading"), PAUSED("paused"),
        VERIFYING("verifying"), READY("ready"), FAILED("failed");

        companion object {
            fun of(value: String): State = values().firstOrNull { it.wire == value } ?: QUEUED
        }
    }

    data class Asset(
        val urlPath: String,
        val diskName: String,
        var sizeBytes: Long,
        var sha256: String,
        val lang: String,
        var receivedBytes: Long = 0,
        var done: Boolean = false,
    )

    data class Record(
        val downloadId: String,
        var instanceId: String,
        var origin: String,
        var clientId: String,
        var seriesId: String,
        var season: Int,
        var episode: Int,
        var title: String,
        var posterUrl: String,
        var subtitleLabel: String,
        var state: State,
        var reason: String,
        var assets: MutableList<Asset>,
        val createdAt: Long,
        var updatedAt: Long,
    ) {
        val totalBytes: Long get() = assets.sumOf { it.sizeBytes }
        val receivedBytes: Long get() = assets.sumOf { if (it.done) it.sizeBytes else it.receivedBytes }
        fun asset(urlPath: String): Asset? = assets.firstOrNull { it.urlPath == urlPath }
    }

    data class Progress(val positionS: Double, val durationS: Double, val subtitleLang: String, val updatedAt: Double)

    val root: File = File(context.filesDir, "Downloads").apply { mkdirs() }
    private val stateFile = File(root, "state.json")
    private val records = LinkedHashMap<String, Record>()
    private val progress = HashMap<String, Progress>()

    init {
        load()
    }

    companion object {
        @Volatile private var instance: DownloadStore? = null

        fun get(context: Context): DownloadStore =
            instance ?: synchronized(this) {
                instance ?: DownloadStore(context.applicationContext).also { instance = it }
            }

        /** Only [A-Za-z0-9-] ids reach a path: a hostile id cannot leave the root. */
        fun safeId(id: String): String = id.map { if (it.isLetterOrDigit() && it.code < 128 || it == '-') it else '-' }.joinToString("")

        /** video / subtitles.<lang>: extension-less, VLC probes the content. */
        fun diskName(lang: String): String = if (lang.isEmpty()) "video" else "subtitles.$lang"
    }

    fun stagingDir(id: String) = File(root, "staging/${safeId(id)}")
    fun readyDir(id: String) = File(root, "ready/${safeId(id)}")

    @Synchronized fun list(): List<Record> = records.values.sortedBy { it.createdAt }.map { it.copy(assets = it.assets.map { a -> a.copy() }.toMutableList()) }

    @Synchronized fun get(id: String): Record? = records[id]?.let { it.copy(assets = it.assets.map { a -> a.copy() }.toMutableList()) }

    @Synchronized fun upsert(record: Record) {
        records[record.downloadId] = record.copy(assets = record.assets.map { it.copy() }.toMutableList(), updatedAt = System.currentTimeMillis())
        save()
    }

    @Synchronized fun update(id: String, change: (Record) -> Unit): Record? {
        val record = records[id] ?: return null
        change(record)
        record.updatedAt = System.currentTimeMillis()
        save()
        return record.copy(assets = record.assets.map { it.copy() }.toMutableList())
    }

    /** Byte counts change many times a second: kept in memory, written at most every [persist]. */
    @Synchronized fun setReceived(id: String, urlPath: String, bytes: Long, persist: Boolean) {
        val asset = records[id]?.asset(urlPath) ?: return
        asset.receivedBytes = bytes
        if (persist) save()
    }

    @Synchronized fun setState(id: String, state: State, reason: String = "") {
        update(id) { it.state = state; it.reason = reason }
    }

    @Synchronized fun delete(id: String) {
        records.remove(id)
        progress.remove(id)
        save()
    }

    @Synchronized fun saveProgress(id: String, positionS: Double, durationS: Double, subtitleLang: String) {
        progress[id] = Progress(positionS.coerceAtLeast(0.0), durationS.coerceAtLeast(0.0), subtitleLang, System.currentTimeMillis() / 1000.0)
        save()
    }

    @Synchronized fun loadProgress(id: String): Progress? = progress[id]

    /** The ready download's video and subtitle files (null unless ready). */
    @Synchronized fun readyFiles(id: String): Pair<File, List<Pair<String, File>>>? {
        val record = records[id] ?: return null
        if (record.state != State.READY) return null
        val dir = readyDir(id)
        val video = record.assets.firstOrNull { it.lang.isEmpty() } ?: return null
        val subs = record.assets.filter { it.lang.isNotEmpty() }.map { it.lang to File(dir, it.diskName) }
        return File(dir, video.diskName) to subs
    }

    // MARK: - Persistence

    private fun load() {
        if (!stateFile.exists()) return
        try {
            val json = JSONObject(stateFile.readText())
            val list = json.optJSONArray("records") ?: JSONArray()
            for (i in 0 until list.length()) {
                val r = list.getJSONObject(i)
                val assets = mutableListOf<Asset>()
                val rawAssets = r.optJSONArray("assets") ?: JSONArray()
                for (j in 0 until rawAssets.length()) {
                    val a = rawAssets.getJSONObject(j)
                    assets.add(Asset(a.getString("urlPath"), a.getString("diskName"), a.getLong("sizeBytes"),
                        a.getString("sha256"), a.optString("lang"), a.optLong("receivedBytes"), a.optBoolean("done")))
                }
                val record = Record(r.getString("downloadId"), r.optString("instanceId"), r.optString("origin"),
                    r.optString("clientId"), r.optString("seriesId"), r.optInt("season"), r.optInt("episode"),
                    r.optString("title"), r.optString("posterUrl"), r.optString("subtitleLabel"),
                    State.of(r.optString("state")), r.optString("reason"), assets,
                    r.optLong("createdAt"), r.optLong("updatedAt"))
                records[record.downloadId] = record
            }
            val saved = json.optJSONObject("progress") ?: JSONObject()
            for (key in saved.keys()) {
                val p = saved.getJSONObject(key)
                progress[key] = Progress(p.optDouble("positionS"), p.optDouble("durationS"), p.optString("subtitleLang"), p.optDouble("updatedAt"))
            }
        } catch (_: Exception) {
            // Unreadable state: the downloads list starts empty; files stay
            // on disk until removed.
        }
    }

    private fun save() {
        val json = JSONObject()
        val list = JSONArray()
        for (r in records.values) {
            val assets = JSONArray()
            for (a in r.assets) {
                assets.put(JSONObject().put("urlPath", a.urlPath).put("diskName", a.diskName).put("sizeBytes", a.sizeBytes)
                    .put("sha256", a.sha256).put("lang", a.lang).put("receivedBytes", a.receivedBytes).put("done", a.done))
            }
            list.put(JSONObject().put("downloadId", r.downloadId).put("instanceId", r.instanceId).put("origin", r.origin)
                .put("clientId", r.clientId).put("seriesId", r.seriesId).put("season", r.season).put("episode", r.episode)
                .put("title", r.title).put("posterUrl", r.posterUrl).put("subtitleLabel", r.subtitleLabel)
                .put("state", r.state.wire).put("reason", r.reason).put("assets", assets)
                .put("createdAt", r.createdAt).put("updatedAt", r.updatedAt))
        }
        json.put("records", list)
        val saved = JSONObject()
        for ((key, p) in progress) {
            saved.put(key, JSONObject().put("positionS", p.positionS).put("durationS", p.durationS)
                .put("subtitleLang", p.subtitleLang).put("updatedAt", p.updatedAt))
        }
        json.put("progress", saved)
        val tmp = File(root, "state.json.tmp")
        tmp.writeText(json.toString())
        if (!tmp.renameTo(stateFile)) {
            stateFile.delete()
            tmp.renameTo(stateFile)
        }
    }
}
