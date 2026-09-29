import Foundation
import CryptoKit

/**
 * DownloadCoordinator (offline-downloads D03) — native background transfers.
 *
 * Design (contracts.md + plan.md):
 *  - ONE background URLSession (identifier "app.torwatch.downloads"). The OS
 *    owns the transfer: it continues while the app is suspended and wakes the
 *    app via AppDelegate's handleEventsForBackgroundURLSession → the pending
 *    completion handler is stored here and released in
 *    urlSessionDidFinishEvents(forBackgroundURLSession:).
 *  - Every task is mapped to (downloadId, urlPath) in the store BEFORE it is
 *    resumed, so a relaunch can reconcile live tasks against the manifest.
 *  - Finished files land in staging; when ALL assets of a download are
 *    present, each file's SHA-256 is verified against the manifest, and the
 *    staging directory is RENAMED into ready/ (same-volume atomic finalize).
 *    A ready download is never half-present.
 *  - Resume may restart from zero if the server or iOS cannot resume
 *    (background downloadTask resume data is not durable across process
 *    death) — that limitation is contractually disclosed, never hidden.
 *  - Files live in Application Support/Downloads, excluded from iCloud
 *    backup. Relative disk paths only inside the store.
 */
final class DownloadCoordinator: NSObject {

    static let sessionIdentifier = "app.torwatch.downloads"

    static let shared: DownloadCoordinator = {
        guard let store = try? DownloadStore() else {
            preconditionFailure("The download store directory must be creatable")
        }
        return DownloadCoordinator(store: store)
    }()

    let store: DownloadStore
    private var session: URLSession!
    /// Completion handler forwarded from AppDelegate for background events.
    private var backgroundCompletionHandler: (() -> Void)?
    /// Throttle for progress writes: persist at most every 0.5s per task.
    private var lastProgressWrite: [Int: Date] = [:]
    private let stateLock = NSLock()

    /// Emitted (on the main queue) whenever durable state changed; the
    /// Capacitor plugin forwards this to the WebView.
    var onChange: (() -> Void)?

    init(store: DownloadStore, session: URLSession? = nil) {
        self.store = store
        super.init()
        if let session = session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.background(withIdentifier: Self.sessionIdentifier)
            configuration.isDiscretionary = false
            configuration.sessionSendsLaunchEvents = true
            configuration.waitsForConnectivity = true
            configuration.timeoutIntervalForResource = 7 * 24 * 3600
            self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        }
    }

    // MARK: - Background session lifecycle (AppDelegate forwards this)

    func handleBackgroundEvents(completionHandler: @escaping () -> Void) {
        stateLock.lock()
        backgroundCompletionHandler = completionHandler
        stateLock.unlock()
        // The system redelivers finished download tasks through the delegate
        // right after this call; reconciliation also refreshes live state.
        reconcile()
    }

    private func finishBackgroundEvents() {
        stateLock.lock()
        let handler = backgroundCompletionHandler
        backgroundCompletionHandler = nil
        stateLock.unlock()
        handler?()
    }

    // MARK: - Public API (plugin)

    struct EnqueueRequest {
        let downloadId: String
        let instanceId: String
        let origin: String
        let clientId: String
        let seriesId: String
        let season: Int
        let episode: Int
        let title: String
        let subtitleLabel: String
        let video: (urlPath: String, sizeBytes: Int64, sha256: String)
        let subtitles: [(lang: String, urlPath: String, sizeBytes: Int64, sha256: String)]
    }

    /// Records the manifest and starts one background task per asset.
    func enqueue(_ request: EnqueueRequest) throws {
        var assets: [DownloadStore.Asset] = [
            DownloadStore.Asset(urlPath: request.video.urlPath,
                                diskName: Self.assetDiskName(urlPath: request.video.urlPath, lang: ""),
                                sizeBytes: request.video.sizeBytes,
                                sha256: request.video.sha256,
                                lang: "")
        ]
        for sub in request.subtitles {
            assets.append(DownloadStore.Asset(urlPath: sub.urlPath,
                                              diskName: Self.assetDiskName(urlPath: sub.urlPath, lang: sub.lang),
                                              sizeBytes: sub.sizeBytes,
                                              sha256: sub.sha256,
                                              lang: sub.lang))
        }
        let record = DownloadStore.Record(
            downloadId: request.downloadId,
            instanceId: request.instanceId,
            origin: request.origin,
            clientId: request.clientId,
            seriesId: request.seriesId,
            season: request.season,
            episode: request.episode,
            title: request.title,
            subtitleLabel: request.subtitleLabel,
            state: .queued,
            reason: "",
            assets: assets,
            receivedBytes: 0,
            createdAt: Date(),
            updatedAt: Date())
        try store.upsert(record)
        try startTasks(for: record)
        emitChange()
    }

    /// Creates + resumes one download task per not-yet-done asset.
    private func startTasks(for record: DownloadStore.Record) throws {
        let staging = try DownloadStore.stagingDirectory(downloadId: record.downloadId)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try store.setState(record.downloadId, .downloading)
        for asset in record.assets {
            let done = try isAssetDone(record.downloadId, asset)
            if done { continue }
            guard let url = Self.assetURL(origin: record.origin, urlPath: asset.urlPath, clientId: record.clientId) else {
                // StoreError is store-internal; a malformed asset path is a
                // generic failure here (the asset path was validated upstream).
                throw URLError(.badURL)
            }
            let task = session.downloadTask(with: url)
            try store.recordTask(Int(task.taskIdentifier), downloadId: record.downloadId, urlPath: asset.urlPath)
            task.resume()
        }
    }

    func pause(_ downloadId: String) throws {
        for task in liveTasks(downloadId: downloadId) { task.suspend() }
        try store.setState(downloadId, .paused)
        emitChange()
    }

    func resume(_ downloadId: String) throws {
        // Suspended live tasks continue; tasks the OS lost after a process
        // death are re-created (a disclosed restart-from-zero, contracts §3).
        if let record = try store.get(downloadId) {
            let live = Set(liveTasks(downloadId: downloadId).map { Int($0.taskIdentifier) })
            let mapped = Set(store.allTaskMappings().filter { $0.downloadId == downloadId }.map { $0.taskId })
            if live.isEmpty && mapped.isEmpty {
                try startTasks(for: record)
            } else {
                for task in liveTasks(downloadId: downloadId) { task.resume() }
                try store.setState(downloadId, .downloading)
            }
        }
        emitChange()
    }

    /// Cancels and FORGETS a download: tasks are cancelled, staged/ready
    /// files are deleted, all rows removed. Only owned directories are ever
    /// touched.
    func remove(_ downloadId: String) throws {
        for task in liveTasks(downloadId: downloadId) { task.cancel() }
        _ = try? store.deleteDownload(downloadId)
        try? FileManager.default.removeItem(at: try DownloadStore.stagingDirectory(downloadId: downloadId))
        try? FileManager.default.removeItem(at: try DownloadStore.readyDirectory(downloadId: downloadId))
        emitChange()
    }

    func storageInfo() -> (free: Int64, used: Int64) {
        let root = (try? DownloadStore.rootDirectory()) ?? FileManager.default.temporaryDirectory
        var used: Int64 = 0
        if let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let url as URL in enumerator {
                used += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0
            }
        }
        let values = try? root.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        let free = values?.volumeAvailableCapacityForImportantUsage ?? 0
        return (free, used)
    }

    // MARK: - Reconciliation

    /// Matches the store's task mappings against the OS's live tasks after a
    /// relaunch: mappings without a live task are reset to queued and their
    /// tasks re-created (disclosed restart-from-zero). Live tasks keep
    /// delivering through the delegate.
    func reconcile() {
        guard let liveTasks = session.allTasks as? [URLSessionTask] else { return }
        let liveIds = Set(liveTasks.map { Int($0.taskIdentifier) })
        let mappings = store.allTaskMappings()
        let orphaned = mappings.filter { !liveIds.contains($0.taskId) }
        var affected = Set<String>()
        for mapping in orphaned {
            try? store.removeTask(mapping.taskId)
            affected.insert(mapping.downloadId)
        }
        for downloadId in affected {
            guard let record = try? store.get(downloadId), record.state == .downloading || record.state == .queued else { continue }
            try? store.setState(downloadId, .queued)
            if let record = try? store.get(downloadId) {
                try? startTasks(for: record)
            }
        }
        emitChange()
    }

    // MARK: - Internals

    private func liveTasks(downloadId: String) -> [URLSessionTask] {
        guard let all = session.allTasks as? [URLSessionTask] else { return [] }
        let mapped = Set(store.allTaskMappings().filter { $0.downloadId == downloadId }.map { $0.taskId })
        return all.filter { mapped.contains(Int($0.taskIdentifier)) }
    }

    private func isAssetDone(_ downloadId: String, _ asset: DownloadStore.Asset) throws -> Bool {
        // An asset is done when its finalized file exists with the exact
        // recorded size (fresh enqueues start at zero).
        let dir = try DownloadStore.readyDirectory(downloadId: downloadId)
        let url = dir.appendingPathComponent(asset.diskName)
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]) else { return false }
        return (values.fileSize ?? 0) == Int(asset.sizeBytes)
    }

    static func assetURL(origin: String, urlPath: String, clientId: String) -> URL? {
        guard var components = URLComponents(string: origin) else { return nil }
        components.path = urlPath
        components.queryItems = [URLQueryItem(name: "clientId", value: clientId)]
        return components.url
    }

    /// video / subtitles.<lang> — extension-less names: VLC probes content,
    /// and the server's URL paths carry no extension by contract.
    static func assetDiskName(urlPath: String, lang: String) -> String {
        if lang.isEmpty { return "video" }
        return "subtitles.\(lang)"
    }

    private func emitChange() {
        DispatchQueue.main.async { [weak self] in
            self?.onChange?()
        }
    }

    private enum FinalizeError: Error {
        case sizeMismatch
        case hashMismatch
        case httpStatus(Int)
    }
}

// MARK: - URLSessionDownloadDelegate

extension DownloadCoordinator: URLSessionDownloadDelegate {

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didWriteData bytesWritten: Int64, totalBytesWritten: Int64,
                    totalBytesExpectedToWrite: Int64) {
        guard let mapping = store.taskOwner(Int(downloadTask.taskIdentifier)) else { return }
        // Throttle durable writes: the UI reads the store; a 0.5s cadence is
        // plenty for bytes/percentage display and keeps flash writes bounded.
        stateLock.lock()
        let now = Date()
        let last = lastProgressWrite[Int(downloadTask.taskIdentifier)] ?? .distantPast
        guard now.timeIntervalSince(last) > 0.5 else {
            stateLock.unlock()
            return
        }
        lastProgressWrite[Int(downloadTask.taskIdentifier)] = now
        stateLock.unlock()
        try? store.setReceivedBytes(mapping.downloadId, totalBytesWritten)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask,
                    didFinishDownloadingTo location: URL) {
        guard let mapping = store.taskOwner(Int(downloadTask.taskIdentifier)),
              let record = try? store.get(mapping.downloadId),
              let asset = record.asset(forPath: mapping.urlPath) else {
            try? FileManager.default.removeItem(at: location)
            return
        }
        // HTTP failures surface as completed files containing the error body:
        // validate the status BEFORE trusting the file.
        if let http = downloadTask.response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            try? FileManager.default.removeItem(at: location)
            failDownload(mapping.downloadId, reason: "server_error")
            return
        }
        do {
            let expected = Int64(asset.sizeBytes)
            let attributes = try FileManager.default.attributesOfItem(atPath: location.path)
            let size = Int64((attributes[.size] as? NSNumber)?.intValue ?? 0)
            guard size == expected else { throw FinalizeError.sizeMismatch }
            let staging = try DownloadStore.stagingDirectory(downloadId: record.downloadId)
            try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
            let destination = staging.appendingPathComponent(asset.diskName)
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            try store.markAssetDone(record.downloadId, urlPath: asset.urlPath)
            try store.removeTask(Int(downloadTask.taskIdentifier))
            tryMaybeFinalize(record)
        } catch {
            try? FileManager.default.removeItem(at: location)
            failDownload(mapping.downloadId, reason: "verification_failed")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let mapping = store.taskOwner(Int(task.taskIdentifier)) else { return }
        guard let error = error as NSError? else { return } // nil error = success path
        if error.code == NSURLErrorCancelled {
            // pause()/remove() initiated this; durable state already reflects it.
            try? store.removeTask(Int(task.taskIdentifier))
            return
        }
        failDownload(mapping.downloadId, reason: "network_failed")
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        finishBackgroundEvents()
    }

    // MARK: - Finalize

    private func tryMaybeFinalize(_ record: DownloadStore.Record) {
        guard let fresh = try? store.get(record.downloadId), fresh.state == .downloading || fresh.state == .queued else { return }
        let allDone = fresh.assets.allSatisfy { asset in
            (try? isAssetDone(record.downloadId, asset)) ?? false
        }
        guard allDone else { emitChange(); return }

        // Verify every file against the manifest BEFORE anything is ready
        // (acceptance D7: no ready/notification before verification). The
        // hash streams in chunks — multi-GB videos never load into memory.
        let staging = try? DownloadStore.stagingDirectory(downloadId: record.downloadId)
        for asset in fresh.assets {
            let url = staging?.appendingPathComponent(asset.diskName)
            guard let url = url, Self.sha256Hex(ofFileAt: url) == asset.sha256.lowercased() else {
                failDownload(record.downloadId, reason: "verification_failed")
                return
            }
        }

        // Same-volume atomic finalize: rename staging → ready.
        let ready = try? DownloadStore.readyDirectory(downloadId: record.downloadId)
        guard let staging = staging, let ready = ready else {
            failDownload(record.downloadId, reason: "verification_failed")
            return
        }
        try? FileManager.default.removeItem(at: ready)
        do {
            try FileManager.default.moveItem(at: staging, to: ready)
        } catch {
            failDownload(record.downloadId, reason: "verification_failed")
            return
        }
        try? store.setState(record.downloadId, .ready)
        emitChange()
    }

    /// Streams a file in 4 MiB chunks through SHA-256 (never whole-file in
    /// memory).
    static func sha256Hex(ofFileAt url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            let chunk: Data
            do { chunk = try handle.read(upToCount: 4 * 1024 * 1024) ?? Data() }
            catch { return nil }
            if chunk.isEmpty { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func failDownload(_ downloadId: String, reason: String) {
        try? store.setState(downloadId, .failed, reason: reason)
        emitChange()
    }
}
