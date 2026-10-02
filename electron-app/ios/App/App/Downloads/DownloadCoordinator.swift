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
    private var lastProgressSample: [Int: (date: Date, bytes: Int64)] = [:]
    private var transferSpeeds: [String: Double] = [:]
    private var lastActivityRefresh: [String: Date] = [:]
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

    func transferMetrics(for record: DownloadStore.Record) -> (bytesPerSecond: Int64, etaSeconds: Int64?) {
        stateLock.lock()
        let speed = transferSpeeds[record.downloadId] ?? 0
        stateLock.unlock()
        guard speed >= 1_024 else { return (0, nil) }
        let remaining = max(0, record.totalBytes - record.receivedBytes)
        let eta = min(Int64(30 * 24 * 60 * 60), Int64((Double(remaining) / speed).rounded(.up)))
        return (Int64(speed.rounded()), eta)
    }

    struct EnqueueRequest {
        let downloadId: String
        let instanceId: String
        let origin: String
        let clientId: String
        let seriesId: String
        let season: Int
        let episode: Int
        let title: String
        let posterURL: String
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
            posterURL: request.posterURL,
            subtitleLabel: request.subtitleLabel,
            state: .queued,
            reason: "",
            assets: assets,
            receivedBytes: 0,
            createdAt: Date(),
            updatedAt: Date())
        try store.upsert(record)
        try startTasks(for: record)
        if #available(iOS 16.1, *) {
            DownloadLiveActivity.start(record)
        }
        emitChange()
    }

    /// Creates + resumes one download task per not-yet-done asset.
    private func startTasks(for record: DownloadStore.Record) throws {
        resetTransferMetrics(record.downloadId)
        let staging = try DownloadStore.stagingDirectory(downloadId: record.downloadId)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try store.setState(record.downloadId, .downloading)
        var startedTask = false
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
            startedTask = true
        }
        // A relaunch can leave every verified asset in staging after the OS
        // completed its tasks but before the atomic finalize ran. Do not leave
        // that record stuck in "downloading" with no live task.
        if !startedTask {
            tryMaybeFinalize(record)
        }
    }

    func pause(_ downloadId: String, completion: @escaping (Error?) -> Void) {
        liveTasks(downloadId: downloadId) { tasks in
            for task in tasks { task.suspend() }
            do {
                try self.store.setState(downloadId, .paused)
                if #available(iOS 16.1, *), let record = try? self.store.get(downloadId) {
                    DownloadLiveActivity.refresh(record, status: "Paused")
                }
                self.emitChange()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    func resume(_ downloadId: String, completion: @escaping (Error?) -> Void) {
        // Suspended live tasks continue; tasks the OS lost after a process
        // death are re-created (a disclosed restart-from-zero, contracts §3).
        liveTasks(downloadId: downloadId) { tasks in
            do {
                guard let record = try self.store.get(downloadId) else {
                    completion(nil)
                    return
                }
                if record.state == .failed {
                    for task in tasks { task.cancel() }
                    try self.store.removeTasks(downloadId)
                    if self.stagedAssetsAreVerified(record) {
                        // Older builds could verify every byte and then fail
                        // only because ready/ did not exist. Salvage those
                        // staged bytes instead of downloading gigabytes again.
                        try self.store.setState(downloadId, .verifying)
                        self.tryMaybeFinalize(record)
                        completion(nil)
                        return
                    } else {
                        // Never reuse a genuinely damaged or partial asset.
                        try? FileManager.default.removeItem(
                            at: try DownloadStore.stagingDirectory(downloadId: downloadId))
                        try self.store.resetTransferProgress(downloadId)
                        try self.startTasks(for: record)
                    }
                } else if tasks.isEmpty {
                    try self.startTasks(for: record)
                } else {
                    for task in tasks { task.resume() }
                    try self.store.setState(downloadId, .downloading)
                }
                if #available(iOS 16.1, *), let fresh = try? self.store.get(downloadId) {
                    DownloadLiveActivity.refresh(fresh, status: "Downloading")
                }
                self.emitChange()
                completion(nil)
            } catch {
                completion(error)
            }
        }
    }

    /// Cancels and FORGETS a download: tasks are cancelled, staged/ready
    /// files are deleted, all rows removed. Only owned directories are ever
    /// touched.
    func remove(_ downloadId: String, completion: @escaping (Error?) -> Void) {
        liveTasks(downloadId: downloadId) { tasks in
            let record = try? self.store.get(downloadId)
            for task in tasks { task.cancel() }
            _ = try? self.store.deleteDownload(downloadId)
            try? FileManager.default.removeItem(at: try DownloadStore.stagingDirectory(downloadId: downloadId))
            try? FileManager.default.removeItem(at: try DownloadStore.readyDirectory(downloadId: downloadId))
            if #available(iOS 16.1, *), let record = record {
                DownloadLiveActivity.finish(record, status: "Cancelled", immediate: true)
            }
            self.resetTransferMetrics(downloadId)
            self.emitChange()
            completion(nil)
        }
    }

    func storageInfo() -> (free: Int64, used: Int64) {
        let root = (try? DownloadStore.rootDirectory()) ?? FileManager.default.temporaryDirectory
        var used: Int64 = 0
        if let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.fileSizeKey]) {
            for case let url as URL in enumerator {
                // .fileSize is Int; the running total is Int64 — convert
                // explicitly.
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0) ?? 0
                used += Int64(size)
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
        // allTasks is an async-only property in current SDKs — use the
        // completion-based getAllTasks instead.
        session.getAllTasks { [weak self] allTasks in
            guard let self = self else { return }
            let liveIds = Set(allTasks.map { Int($0.taskIdentifier) })
            let mappings = self.store.allTaskMappings()
            let orphaned = mappings.filter { !liveIds.contains($0.taskId) }
            var affected = Set<String>()
            for mapping in orphaned {
                try? self.store.removeTask(mapping.taskId)
                affected.insert(mapping.downloadId)
            }
            for downloadId in affected {
                guard let record = try? self.store.get(downloadId), record.state == .downloading || record.state == .queued else { continue }
                try? self.store.setState(downloadId, .queued)
                if let record = try? self.store.get(downloadId) {
                    try? self.startTasks(for: record)
                }
            }
            // A process may be suspended after the transfer finishes but
            // before verification/finalization. The staged files are durable,
            // so finish that state instead of leaving it stuck forever.
            for record in self.store.incompleteDownloads() where record.state == .verifying {
                self.tryMaybeFinalize(record)
            }
            self.emitChange()
        }
    }

    // MARK: - Internals

    private func liveTasks(downloadId: String, completion: @escaping ([URLSessionTask]) -> Void) {
        // allTasks is an async-only property in current SDKs — use the
        // completion-based getAllTasks instead.
        session.getAllTasks { [weak self] allTasks in
            guard let self = self else { completion([]); return }
            let mapped = Set(self.store.allTaskMappings().filter { $0.downloadId == downloadId }.map { $0.taskId })
            completion(allTasks.filter { mapped.contains(Int($0.taskIdentifier)) })
        }
    }

    private func isAssetDone(_ downloadId: String, _ asset: DownloadStore.Asset) throws -> Bool {
        // In-flight assets live in staging until every file has passed its
        // size and hash checks. Looking in ready here prevents the last task
        // from ever reaching atomic finalize and leaves a completed transfer
        // stuck indefinitely.
        let dir = try DownloadStore.stagingDirectory(downloadId: downloadId)
        let url = dir.appendingPathComponent(asset.diskName)
        guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]) else { return false }
        return (values.fileSize ?? 0) == Int(asset.sizeBytes)
    }

    private func stagedAssetsAreVerified(_ record: DownloadStore.Record) -> Bool {
        guard let staging = try? DownloadStore.stagingDirectory(downloadId: record.downloadId) else {
            return false
        }
        return record.assets.allSatisfy { asset in
            let url = staging.appendingPathComponent(asset.diskName)
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey]),
                  (values.fileSize ?? 0) == Int(asset.sizeBytes) else {
                return false
            }
            return Self.sha256Hex(ofFileAt: url) == asset.sha256.lowercased()
        }
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

    private func resetTransferMetrics(_ downloadId: String) {
        stateLock.lock()
        transferSpeeds.removeValue(forKey: downloadId)
        lastActivityRefresh.removeValue(forKey: downloadId)
        stateLock.unlock()
    }

    private func clearTaskMetrics(_ taskId: Int) {
        stateLock.lock()
        lastProgressWrite.removeValue(forKey: taskId)
        lastProgressSample.removeValue(forKey: taskId)
        stateLock.unlock()
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
        let taskId = Int(downloadTask.taskIdentifier)
        let last = lastProgressWrite[taskId] ?? .distantPast
        guard now.timeIntervalSince(last) > 0.5 else {
            stateLock.unlock()
            return
        }
        lastProgressWrite[taskId] = now
        if let sample = lastProgressSample[taskId] {
            let elapsed = now.timeIntervalSince(sample.date)
            let delta = totalBytesWritten - sample.bytes
            if elapsed > 0, delta >= 0 {
                let instant = Double(delta) / elapsed
                let previous = transferSpeeds[mapping.downloadId] ?? instant
                transferSpeeds[mapping.downloadId] = previous * 0.7 + instant * 0.3
            }
        }
        lastProgressSample[taskId] = (date: now, bytes: totalBytesWritten)
        let previousActivityRefresh = lastActivityRefresh[mapping.downloadId] ?? .distantPast
        let shouldRefreshActivity = now.timeIntervalSince(previousActivityRefresh) >= 2
        if shouldRefreshActivity { lastActivityRefresh[mapping.downloadId] = now }
        stateLock.unlock()
        try? store.setAssetReceivedBytes(
            mapping.downloadId,
            urlPath: mapping.urlPath,
            bytes: totalBytesWritten)
        // The durable store changed, so the Downloads screen must re-read it;
        // without this event the row remained visually stuck at 0%.
        emitChange()
        if #available(iOS 16.1, *), let record = try? store.get(mapping.downloadId) {
            guard record.state == .queued || record.state == .downloading || record.state == .paused else {
                return
            }
            let status = record.state == .paused ? "Paused" : "Downloading"
            if shouldRefreshActivity {
                let metrics = transferMetrics(for: record)
                DownloadLiveActivity.refresh(
                    record,
                    status: status,
                    bytesPerSecond: metrics.bytesPerSecond,
                    etaSeconds: metrics.etaSeconds)
            }
        }
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
            let taskId = Int(downloadTask.taskIdentifier)
            try store.removeTask(taskId)
            clearTaskMetrics(taskId)
            tryMaybeFinalize(record)
        } catch {
            try? FileManager.default.removeItem(at: location)
            failDownload(mapping.downloadId, reason: "verification_failed")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let taskId = Int(task.taskIdentifier)
        guard let mapping = store.taskOwner(taskId) else { return }
        guard let error = error as NSError? else { return } // nil error = success path
        clearTaskMetrics(taskId)
        if error.code == NSURLErrorCancelled {
            // pause()/remove() initiated this; durable state already reflects it.
            try? store.removeTask(taskId)
            return
        }
        failDownload(mapping.downloadId, reason: "network_failed")
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        finishBackgroundEvents()
    }

    // MARK: - Finalize

    private func tryMaybeFinalize(_ record: DownloadStore.Record) {
        guard let fresh = try? store.get(record.downloadId),
              fresh.state == .downloading || fresh.state == .queued || fresh.state == .verifying else { return }
        let allDone = fresh.assets.allSatisfy { asset in
            (try? isAssetDone(record.downloadId, asset)) ?? false
        }
        guard allDone else { emitChange(); return }

        if fresh.state != .verifying {
            try? store.setState(record.downloadId, .verifying)
            if #available(iOS 16.1, *), let checking = try? store.get(record.downloadId) {
                DownloadLiveActivity.refresh(checking, status: "Checking file")
            }
            emitChange()
        }

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
            failDownload(record.downloadId, reason: "storage_failed")
            return
        }
        do {
            // `ready/<download-id>` cannot be renamed into place until its
            // parent exists. Missing this directory made every first download
            // reach 100%, pass its hash, then fail during the final move.
            try FileManager.default.createDirectory(
                at: ready.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try? FileManager.default.removeItem(at: ready)
            try FileManager.default.moveItem(at: staging, to: ready)
        } catch {
            failDownload(record.downloadId, reason: "storage_failed")
            return
        }
        try? store.setReceivedBytes(record.downloadId, fresh.totalBytes)
        try? store.setState(record.downloadId, .ready)
        if #available(iOS 16.1, *), let complete = try? store.get(record.downloadId) {
            DownloadLiveActivity.finish(complete, status: "Downloaded")
        }
        resetTransferMetrics(record.downloadId)
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
        if #available(iOS 16.1, *), let record = try? store.get(downloadId) {
            DownloadLiveActivity.finish(record, status: "Needs attention")
        }
        resetTransferMetrics(downloadId)
        emitChange()
        // One failed asset invalidates the atomic download. Stop its sibling
        // transfers instead of wasting bandwidth until the user taps Retry.
        liveTasks(downloadId: downloadId) { tasks in
            for task in tasks { task.cancel() }
            try? self.store.removeTasks(downloadId)
        }
    }
}
