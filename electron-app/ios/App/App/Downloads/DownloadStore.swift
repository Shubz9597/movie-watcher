import Foundation
import SQLite3

/// pgx-style transient destructor for sqlite3_bind_text; named locally to
/// avoid clashing with any SDK-provided definition.
let sqliteTransientDestructor = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

/**
 * DownloadStore (offline-downloads D03) — the device-side durable manifest.
 *
 * SQLite (iOS system library) under Application Support/Downloads/. Records
 * carry the contracts.md §native-fields requirements: server scope
 * (instanceId + origin — NEVER just the URL), canonical title identity, the
 * job manifest, per-asset URL/disk/size/sha, URLSession task mapping, state
 * and safe reason, received bytes, and durable local playback progress.
 *
 * Invariants:
 *  - Every write is transactional; a crash can never leave a half-updated
 *    manifest (tasks are reconciled from the OS on relaunch anyway).
 *  - Relative disk paths only: absolute sandbox paths change between
 *    launches; the store resolves them against the current container root.
 *  - All access funnels through one serial queue (SQLite is not assumed
 *    thread-safe here); callbacks may deliver on any queue.
 */
final class DownloadStore {

    static let states = ["queued", "downloading", "paused", "ready", "failed"]

    enum State: String {
        case queued, downloading, paused, ready, failed
    }

    struct Asset: Codable, Equatable {
        let urlPath: String       // origin-relative public path (contracts §4)
        let diskName: String      // file name inside the download directory
        let sizeBytes: Int64
        let sha256: String
        let lang: String          // subtitles only; "" for video
    }

    struct Record {
        var downloadId: String
        var instanceId: String
        var origin: String
        var clientId: String
        var seriesId: String
        var season: Int
        var episode: Int
        var title: String
        var subtitleLabel: String
        var state: State
        var reason: String
        var assets: [Asset]
        var receivedBytes: Int64
        var createdAt: Date
        var updatedAt: Date

        var totalBytes: Int64 { assets.reduce(0) { $0 + $1.sizeBytes } }
        func asset(forPath urlPath: String) -> Asset? {
            assets.first { $0.urlPath == urlPath }
        }
    }

    struct Progress {
        var positionS: Double
        var durationS: Double
        var subtitleLang: String
    }

    /// A task↔asset mapping for OS-task reconciliation after relaunch.
    struct TaskMapping {
        let taskId: Int
        let downloadId: String
        let urlPath: String
    }

    // MARK: - Paths

    /// Application Support/Downloads — excluded from iCloud backup (contracts:
    /// large media never belongs in backups).
    static func rootDirectory() throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask,
            appropriateFor: nil, create: true)
        let root = base.appendingPathComponent("Downloads", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var resourceValues = URLResourceValues()
        resourceValues.isExcludedFromBackup = true
        var mutable = root
        try? mutable.setResourceValues(resourceValues)
        return root
    }

    /// Directory that will hold a download's finalized files.
    static func readyDirectory(downloadId: String) throws -> URL {
        try rootDirectory().appendingPathComponent("ready/\(safeId(downloadId))", isDirectory: true)
    }

    /// Directory holding in-flight files (renamed atomically at finalize).
    static func stagingDirectory(downloadId: String) throws -> URL {
        try rootDirectory().appendingPathComponent("staging/\(safeId(downloadId))", isDirectory: true)
    }

    /// Only [A-Za-z0-9-] ids may ever reach a path: a hostile id cannot
    /// traverse out of the downloads root.
    static func safeId(_ id: String) -> String {
        String(id.map { ch in
            (ch.isLetter && ch.isASCII) || (ch.isNumber && ch.isASCII) || ch == "-" ? ch : "-"
        })
    }

    // MARK: - Database

    private let queue = DispatchQueue(label: "app.torwatch.downloadstore")
    private var db: OpaquePointer?
    let directory: URL

    init(directory: URL? = nil) throws {
        let root = try directory ?? DownloadStore.rootDirectory()
        self.directory = root
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        db = Self.openDatabase(at: root.appendingPathComponent("downloads.sqlite3"))
        try migrate()
    }

    deinit {
        if let db = db { sqlite3_close(db) }
    }

    private static func openDatabase(at url: URL) -> OpaquePointer? {
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK else {
            if let handle = handle { sqlite3_close(handle) }
            return nil
        }
        return handle
    }

    private func migrate() throws {
        try exec("""
        CREATE TABLE IF NOT EXISTS downloads (
          download_id TEXT PRIMARY KEY,
          instance_id TEXT NOT NULL,
          origin TEXT NOT NULL,
          client_id TEXT NOT NULL,
          series_id TEXT NOT NULL,
          season INTEGER NOT NULL DEFAULT 0,
          episode INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL,
          subtitle_label TEXT NOT NULL DEFAULT '',
          state TEXT NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          expected_bytes INTEGER NOT NULL DEFAULT 0,
          received_bytes INTEGER NOT NULL DEFAULT 0,
          created_at REAL NOT NULL,
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS download_assets (
          download_id TEXT NOT NULL,
          url_path TEXT NOT NULL,
          disk_name TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          lang TEXT NOT NULL DEFAULT '',
          done INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (download_id, url_path)
        );
        CREATE TABLE IF NOT EXISTS download_tasks (
          task_id INTEGER PRIMARY KEY,
          download_id TEXT NOT NULL,
          url_path TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS download_progress (
          download_id TEXT PRIMARY KEY,
          position_s REAL NOT NULL DEFAULT 0,
          duration_s REAL NOT NULL DEFAULT 0,
          subtitle_lang TEXT NOT NULL DEFAULT '',
          updated_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        """)
        // Schema versioning: future migrations key off this value.
        try exec("INSERT OR IGNORE INTO meta (key, value) VALUES ('schemaVersion', '1')")
    }

    private func exec(_ sql: String) throws {
        var error: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(db, sql, nil, nil, &error) == SQLITE_OK else {
            let message = error.map { String(cString: $0) } ?? "unknown sqlite error"
            if let error = error { sqlite3_free(error) }
            throw StoreError.database(message)
        }
    }

    /// Runs `body` inside BEGIN IMMEDIATE/COMMIT with a guaranteed ROLLBACK
    /// on any failure — a crash can never leave partial writes behind.
    private func transaction(_ body: () throws -> Void) throws {
        try exec("BEGIN IMMEDIATE TRANSACTION")
        do {
            try body()
            try exec("COMMIT")
        } catch {
            try? exec("ROLLBACK")
            throw error
        }
    }

    enum StoreError: Error {
        case database(String)
        case notFound
    }

    // MARK: - Writes

    /// Inserts (or replaces) the download row + assets in one transaction.
    func upsert(_ record: Record) throws {
        try onQueue {
            try transaction {
                try exec("""
                INSERT INTO downloads (download_id, instance_id, origin, client_id, series_id, season, episode,
                                       title, subtitle_label, state, reason, expected_bytes, received_bytes, created_at, updated_at)
                VALUES ('\(_esc(record.downloadId))', '\(_esc(record.instanceId))', '\(_esc(record.origin))',
                        '\(_esc(record.clientId))', '\(_esc(record.seriesId))', \(record.season), \(record.episode),
                        '\(_esc(record.title))', '\(_esc(record.subtitleLabel))', '\(record.state.rawValue)',
                        '\(_esc(record.reason))', \(record.totalBytes), \(record.receivedBytes),
                        \(record.createdAt.timeIntervalSince1970), \(record.updatedAt.timeIntervalSince1970))
                ON CONFLICT (download_id) DO UPDATE SET
                  instance_id='\(_esc(record.instanceId))', origin='\(_esc(record.origin))',
                  client_id='\(_esc(record.clientId))', series_id='\(_esc(record.seriesId))',
                  season=\(record.season), episode=\(record.episode), title='\(_esc(record.title))',
                  subtitle_label='\(_esc(record.subtitleLabel))', state='\(record.state.rawValue)',
                  reason='\(_esc(record.reason))', expected_bytes=\(record.totalBytes),
                  received_bytes=\(record.receivedBytes), updated_at=\(record.updatedAt.timeIntervalSince1970)
                """)
                try exec("DELETE FROM download_assets WHERE download_id='\(_esc(record.downloadId))'")
                for asset in record.assets {
                    try exec("""
                    INSERT INTO download_assets (download_id, url_path, disk_name, size_bytes, sha256, lang, done)
                    VALUES ('\(_esc(record.downloadId))', '\(_esc(asset.urlPath))', '\(_esc(asset.diskName))',
                            \(asset.sizeBytes), '\(_esc(asset.sha256))', '\(_esc(asset.lang))', 0)
                    """)
                }
            }
        }
    }

    func setState(_ downloadId: String, _ state: State, reason: String = "") throws {
        try onQueue {
            try exec("""
            UPDATE downloads SET state='\(state.rawValue)', reason='\(_esc(reason))',
            updated_at=\(Date().timeIntervalSince1970) WHERE download_id='\(_esc(downloadId))'
            """)
        }
    }

    func setReceivedBytes(_ downloadId: String, _ bytes: Int64) throws {
        try onQueue {
            try exec("""
            UPDATE downloads SET received_bytes=\(max(0, bytes)),
            updated_at=\(Date().timeIntervalSince1970) WHERE download_id='\(_esc(downloadId))'
            """)
        }
    }

    func markAssetDone(_ downloadId: String, urlPath: String) throws {
        try onQueue {
            try exec("""
            UPDATE download_assets SET done=1
            WHERE download_id='\(_esc(downloadId))' AND url_path='\(_esc(urlPath))'
            """)
        }
    }

    /// Removes all recorded rows (files are the coordinator's responsibility).
    func deleteDownload(_ downloadId: String) throws {
        try onQueue {
            try transaction {
                try exec("DELETE FROM download_tasks WHERE download_id='\(_esc(downloadId))'")
                try exec("DELETE FROM download_assets WHERE download_id='\(_esc(downloadId))'")
                try exec("DELETE FROM download_progress WHERE download_id='\(_esc(downloadId))'")
                try exec("DELETE FROM downloads WHERE download_id='\(_esc(downloadId))'")
            }
        }
    }

    // MARK: - Task mapping (OS reconciliation)

    func recordTask(_ taskId: Int, downloadId: String, urlPath: String) throws {
        try onQueue {
            try exec("""
            INSERT OR REPLACE INTO download_tasks (task_id, download_id, url_path)
            VALUES (\(taskId), '\(_esc(downloadId))', '\(_esc(urlPath))')
            """)
        }
    }

    func taskOwner(_ taskId: Int) -> TaskMapping? {
        onQueue {
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, "SELECT download_id, url_path FROM download_tasks WHERE task_id=?", -1, &stmt, nil) == SQLITE_OK else { return nil }
            sqlite3_bind_int(stmt, 1, Int32(taskId))
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            let downloadId = String(cString: sqlite3_column_text(stmt, 0))
            let urlPath = String(cString: sqlite3_column_text(stmt, 1))
            return TaskMapping(taskId: taskId, downloadId: downloadId, urlPath: urlPath)
        }
    }

    func removeTask(_ taskId: Int) throws {
        try onQueue { try exec("DELETE FROM download_tasks WHERE task_id=\(taskId)") }
    }

    func removeTasks(_ downloadId: String) throws {
        try onQueue {
            try exec("DELETE FROM download_tasks WHERE download_id='\(_esc(downloadId))'")
        }
    }

    /// All live task mappings for reconciliation after relaunch.
    func allTaskMappings() -> [TaskMapping] {
        onQueue {
            var result: [TaskMapping] = []
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, "SELECT task_id, download_id, url_path FROM download_tasks", -1, &stmt, nil) == SQLITE_OK else { return result }
            while sqlite3_step(stmt) == SQLITE_ROW {
                result.append(TaskMapping(
                    taskId: Int(sqlite3_column_int64(stmt, 0)),
                    downloadId: String(cString: sqlite3_column_text(stmt, 1)),
                    urlPath: String(cString: sqlite3_column_text(stmt, 2))))
            }
            return result
        }
    }

    /// Downloads whose assets are not all done — reconciliation resets these
    /// to queued so their missing tasks re-enqueue.
    func incompleteDownloads() -> [Record] {
        (try? list()) ?? []
            .filter { $0.state != .ready && $0.state != .failed }
    }

    // MARK: - Reads

    func list() throws -> [Record] {
        try onQueue {
            var result: [Record] = []
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, """
            SELECT download_id, instance_id, origin, client_id, series_id, season, episode, title,
                   subtitle_label, state, reason, received_bytes, created_at, updated_at
            FROM downloads ORDER BY created_at
            """, -1, &stmt, nil) == SQLITE_OK else {
                throw StoreError.database("prepare list failed")
            }
            while sqlite3_step(stmt) == SQLITE_ROW {
                let id = String(cString: sqlite3_column_text(stmt, 0))
                let record = Record(
                    downloadId: id,
                    instanceId: String(cString: sqlite3_column_text(stmt, 1)),
                    origin: String(cString: sqlite3_column_text(stmt, 2)),
                    clientId: String(cString: sqlite3_column_text(stmt, 3)),
                    seriesId: String(cString: sqlite3_column_text(stmt, 4)),
                    season: Int(sqlite3_column_int(stmt, 5)),
                    episode: Int(sqlite3_column_int(stmt, 6)),
                    title: String(cString: sqlite3_column_text(stmt, 7)),
                    subtitleLabel: String(cString: sqlite3_column_text(stmt, 8)),
                    state: State(rawValue: String(cString: sqlite3_column_text(stmt, 9))) ?? .failed,
                    reason: String(cString: sqlite3_column_text(stmt, 10)),
                    assets: try assetsFor(id),
                    receivedBytes: sqlite3_column_int64(stmt, 11),
                    createdAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 12)),
                    updatedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 13)))
                result.append(record)
            }
            return result
        }
    }

    func get(_ downloadId: String) throws -> Record? {
        try list().first { $0.downloadId == downloadId }
    }

    private func assetsFor(_ downloadId: String) throws -> [Asset] {
        var result: [Asset] = []
        var stmt: OpaquePointer?
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_prepare_v2(db, """
        SELECT url_path, disk_name, size_bytes, sha256, lang FROM download_assets
        WHERE download_id='\(_esc(downloadId))' ORDER BY lang, url_path
        """, -1, &stmt, nil) == SQLITE_OK else {
            throw StoreError.database("prepare assets failed")
        }
        while sqlite3_step(stmt) == SQLITE_ROW {
            result.append(Asset(
                urlPath: String(cString: sqlite3_column_text(stmt, 0)),
                diskName: String(cString: sqlite3_column_text(stmt, 1)),
                sizeBytes: sqlite3_column_int64(stmt, 2),
                sha256: String(cString: sqlite3_column_text(stmt, 3)),
                lang: String(cString: sqlite3_column_text(stmt, 4))))
        }
        return result
    }

    /// Finalized asset file URLs (video first, then sidecars) for playback.
    func readyFileURLs(_ downloadId: String) throws -> (video: URL, subtitles: [(lang: String, url: URL)])? {
        guard let record = try get(downloadId), record.state == .ready else { return nil }
        let dir = try DownloadStore.readyDirectory(downloadId: downloadId)
        let videoAsset = record.assets.first { $0.lang.isEmpty }
        guard let video = videoAsset else { return nil }
        let subs = record.assets.filter { !$0.lang.isEmpty }.map { (lang: $0.lang, url: dir.appendingPathComponent($0.diskName)) }
        return (dir.appendingPathComponent(video.diskName), subs)
    }

    // MARK: - Local playback progress (D04)

    func saveProgress(_ downloadId: String, positionS: Double, durationS: Double, subtitleLang: String) throws {
        try onQueue {
            try exec("""
            INSERT INTO download_progress (download_id, position_s, duration_s, subtitle_lang, updated_at)
            VALUES ('\(_esc(downloadId))', \(max(0, positionS)), \(max(0, durationS)), '\(_esc(subtitleLang))',
                    \(Date().timeIntervalSince1970))
            ON CONFLICT (download_id) DO UPDATE SET
              position_s=\(max(0, positionS)), duration_s=\(max(0, durationS)),
              subtitle_lang='\(_esc(subtitleLang))', updated_at=\(Date().timeIntervalSince1970)
            """)
        }
    }

    func loadProgress(_ downloadId: String) -> Progress? {
        onQueue {
            var stmt: OpaquePointer?
            defer { sqlite3_finalize(stmt) }
            guard sqlite3_prepare_v2(db, """
            SELECT position_s, duration_s, subtitle_lang FROM download_progress WHERE download_id=?
            """, -1, &stmt, nil) == SQLITE_OK else { return nil }
            sqlite3_bind_text(stmt, 1, downloadId, -1, sqliteTransientDestructor)
            guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
            return Progress(
                positionS: sqlite3_column_double(stmt, 0),
                durationS: sqlite3_column_double(stmt, 1),
                subtitleLang: String(cString: sqlite3_column_text(stmt, 2)))
        }
    }

    // MARK: - Helpers

    private func onQueue<T>(_ body: () throws -> T) rethrows -> T {
        // The serial queue serializes ALL database access. Callers on the
        // main thread may block briefly while a background write drains;
        // the queue itself never dispatches to main, so this cannot
        // deadlock.
        return try queue.sync { try body() }
    }

    private func _esc(_ value: String) -> String {
        value.replacingOccurrences(of: "'", with: "''")
    }

    private static func encodeAssets(_ assets: [Asset]) throws -> Data {
        try JSONEncoder().encode(assets)
    }
}
