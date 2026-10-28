import Foundation
import CryptoKit
import Network

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
    /// Automatic retries per asset ("downloadId|urlPath") in this process.
    private var retryAttempts: [String: Int] = [:]
    /// Backoff 15 s ... 4 min: about 40 minutes of attempts before a
    /// download is marked failed and the queue moves on.
    private static let maxRetries = 12
    /// Last time each download received bytes (or was started/retried).
    private var lastByteAt: [String: Date] = [:]
    /// Transfers cancelled as stalled; their completion is a retry, not a
    /// pause or removal.
    private var stallCancelled = Set<Int>()
    /// A transfer that receives nothing for this long is restarted. A
    /// background session waits for connectivity (up to 7 days) without
    /// failing: when the server became unreachable mid-transfer (Tailscale
    /// reconnecting, the server restarting), the transfer sat "running"
    /// with no bytes and the one-at-a-time queue never moved on.
    private static let stallLimit: TimeInterval = 90
    /// Right after the network changes (Wi-Fi to mobile data, a new Wi-Fi,
    /// back from no signal) the old connections are dead: a transfer silent
    /// for this long is restarted at once instead of after stallLimit.
    private static let networkChangeStallLimit: TimeInterval = 8
    private var quickStallChecksUntil = Date.distantPast
    private var pathMonitor: NWPathMonitor?
    private var lastPathSignature = ""
    /// The phone is on Wi-Fi (or a cable), per the path monitor.
    private var onWifi = true

    /// Videos download only over Wi-Fi unless the viewer turns this off.
    /// iOS enforces it on every transfer (allowsCellularAccess), so it holds
    /// while the app is closed too; meanwhile the transfer just waits.
    static let wifiOnlyKey = "torwatch.downloads.wifiOnly"
    /// The rule the live transfers were started with (older builds: mobile
    /// data allowed).
    private static let appliedWifiOnlyKey = "torwatch.downloads.appliedWifiOnly"

    var wifiOnly: Bool {
        UserDefaults.standard.object(forKey: Self.wifiOnlyKey) as? Bool ?? true
    }

    /// Wi-Fi only is on and the phone is not on Wi-Fi: transfers wait.
    var waitingForWifi: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return wifiOnly && !onWifi
    }
    private let stateLock = NSLock()
    /// Serialises queue decisions; recursive because finishing one download
    /// starts the next from inside the same call chain.
    private let queueLock = NSRecursiveLock()

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
            // The manifest request waits on the server for up to 240 s while
            // it prepares an episode (no bytes meanwhile).
            configuration.timeoutIntervalForRequest = 300
            self.session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
            watchNetwork()
        }
    }

    // MARK: - Network changes

    /// A new network (or the network coming back) restarts what it broke:
    /// transfers gone silent restart at once, downloads that ran out of
    /// retries while offline go back in line, and the retry count starts
    /// over. Before, an episode that failed during a long outage stayed
    /// failed, and a dead transfer held the one-at-a-time queue for 90 s.
    private func watchNetwork() {
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self = self else { return }
            let signature = "\(path.status)|\(path.availableInterfaces.map { $0.name }.joined(separator: ","))|\(path.isExpensive)"
            let wifi = path.status == .satisfied
                && (path.usesInterfaceType(.wifi) || path.usesInterfaceType(.wiredEthernet))
            self.stateLock.lock()
            let changed = signature != self.lastPathSignature
            self.lastPathSignature = signature
            let wifiChanged = wifi != self.onWifi
            self.onWifi = wifi
            self.stateLock.unlock()
            if wifiChanged { self.wifiStateChanged() }
            guard changed, path.status == .satisfied else { return }
            self.networkChanged()
        }
        monitor.start(queue: DispatchQueue(label: "torwatch.downloads.network"))
        pathMonitor = monitor
    }

    /// Leaving or reaching Wi-Fi changes what a waiting download shows.
    private func wifiStateChanged() {
        if #available(iOS 16.1, *) {
            let status = waitingForWifi ? "Waiting for Wi-Fi" : "Downloading"
            for record in (try? store.list()) ?? [] where record.state == .downloading {
                DownloadLiveActivity.refresh(record, status: status)
            }
        }
        emitChange()
    }

    func setWifiOnly(_ enabled: Bool) {
        UserDefaults.standard.set(enabled, forKey: Self.wifiOnlyKey)
        applyNetworkRule()
        wifiStateChanged()
    }

    /// A transfer keeps the mobile-data rule it started with. After the
    /// viewer changes it (or on the first launch of this build), running and
    /// paused transfers restart under the current rule, keeping the bytes
    /// already received.
    private func applyNetworkRule() {
        let wifiOnly = self.wifiOnly
        guard (UserDefaults.standard.object(forKey: Self.appliedWifiOnlyKey) as? Bool ?? false) != wifiOnly else { return }
        UserDefaults.standard.set(wifiOnly, forKey: Self.appliedWifiOnlyKey)
        session.getAllTasks { [weak self] tasks in
            guard let self = self else { return }
            for task in tasks {
                let taskId = Int(task.taskIdentifier)
                guard let download = task as? URLSessionDownloadTask,
                      task.state == .running || task.state == .suspended,
                      let mapping = self.store.taskOwner(taskId),
                      mapping.urlPath != Self.manifestMarker else { continue }
                let paused = task.state == .suspended
                self.stateLock.lock()
                self.stallCancelled.insert(taskId) // its cancel is not a failure
                self.stateLock.unlock()
                download.cancel { [weak self] resumeData in
                    guard let self = self else { return }
                    // The replacement is recorded before the old task is
                    // dropped, so the queue never sees the download without one.
                    var replacement: URLSessionDownloadTask?
                    if let resumeData = resumeData {
                        replacement = self.assetTask(resumeData: resumeData)
                    } else if let record = try? self.store.get(mapping.downloadId),
                              let url = self.taskURL(record, urlPath: mapping.urlPath) {
                        replacement = self.assetTask(url)
                    }
                    if let replacement = replacement {
                        try? self.store.recordTask(Int(replacement.taskIdentifier), downloadId: mapping.downloadId, urlPath: mapping.urlPath)
                        self.noteActivity(mapping.downloadId, at: Date())
                        if !paused { replacement.resume() }
                    }
                    self.clearTaskMetrics(taskId)
                    try? self.store.removeTask(taskId)
                    self.stateLock.lock()
                    self.stallCancelled.remove(taskId)
                    self.stateLock.unlock()
                    self.startNextIfIdle()
                }
            }
        }
    }

    /// A video or subtitle transfer under the current mobile-data rule.
    /// (Manifest requests are a few KB and may use mobile data.)
    private func assetTask(_ url: URL) -> URLSessionDownloadTask {
        var request = URLRequest(url: url)
        request.timeoutInterval = session.configuration.timeoutIntervalForRequest
        request.allowsCellularAccess = !wifiOnly
        return session.downloadTask(with: request)
    }

    private func assetTask(resumeData: Data) -> URLSessionDownloadTask {
        session.downloadTask(withResumeData: Self.resumeData(resumeData, allowingCellular: !wifiOnly) ?? resumeData)
    }

    /// Resume data carries the stopped transfer's request, its mobile-data
    /// rule included; this rewrites the rule. nil when the data is not in the
    /// form expected (the caller then keeps it as it was).
    static func resumeData(_ data: Data, allowingCellular: Bool) -> Data? {
        var format = PropertyListSerialization.PropertyListFormat.binary
        guard var resume = (try? PropertyListSerialization.propertyList(from: data, options: [], format: &format)) as? [String: Any],
              resume["$archiver"] == nil else { return nil }
        var rewritten = false
        for key in ["NSURLSessionResumeCurrentRequest", "NSURLSessionResumeOriginalRequest"] {
            guard let archived = resume[key] as? Data else { continue }
            guard let request = archivedRequest(archived, allowingCellular: allowingCellular) else { return nil }
            resume[key] = request
            rewritten = true
        }
        guard rewritten else { return nil }
        return try? PropertyListSerialization.data(fromPropertyList: resume, format: format, options: 0)
    }

    /// Re-archives one request with the rule, under the root key it had.
    private static func archivedRequest(_ data: Data, allowingCellular: Bool) -> Data? {
        guard let unarchiver = try? NSKeyedUnarchiver(forReadingFrom: data) else { return nil }
        unarchiver.requiresSecureCoding = false
        var rootKey = NSKeyedArchiveRootObjectKey
        var request = unarchiver.decodeObject(forKey: rootKey) as? NSURLRequest
        if request == nil {
            rootKey = "NSKeyedArchiveRootObjectKey"
            request = unarchiver.decodeObject(forKey: rootKey) as? NSURLRequest
        }
        unarchiver.finishDecoding()
        guard let mutable = request?.mutableCopy() as? NSMutableURLRequest else { return nil }
        mutable.allowsCellularAccess = allowingCellular
        guard let updated = mutable.copy() as? NSURLRequest else { return nil }
        let archiver = NSKeyedArchiver(requiringSecureCoding: false)
        archiver.encode(updated, forKey: rootKey)
        archiver.finishEncoding()
        return archiver.encodedData
    }

    private func networkChanged() {
        stateLock.lock()
        retryAttempts.removeAll()
        quickStallChecksUntil = Date().addingTimeInterval(60)
        stateLock.unlock()
        requeueNetworkFailures()
        startNextIfIdle()
    }

    /// Downloads that failed only because the network was away go back in
    /// line (finished parts are kept).
    func requeueNetworkFailures() {
        var changed = false
        for record in (try? store.list()) ?? [] where record.state == .failed && record.reason == "network_failed" {
            try? store.setState(record.downloadId, .queued)
            changed = true
        }
        if changed { emitChange() }
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
        /// nil: the server is still preparing it; the downloader asks for the
        /// manifest itself (with the app closed too) and then downloads.
        let video: (urlPath: String, sizeBytes: Int64, sha256: String)?
        let subtitles: [(lang: String, urlPath: String, sizeBytes: Int64, sha256: String)]
    }

    /// The task "path" of a manifest request (not an asset).
    static let manifestMarker = "manifest"

    static func manifestURL(origin: String, downloadId: String, clientId: String) -> URL? {
        guard var components = URLComponents(string: origin.trimmingCharacters(in: CharacterSet(charactersIn: "/"))) else { return nil }
        components.path = components.path + "/v1/downloads/jobs/" + downloadId + "/manifest"
        components.queryItems = [URLQueryItem(name: "clientId", value: clientId), URLQueryItem(name: "wait", value: "240")]
        return components.url
    }

    private func taskURL(_ record: DownloadStore.Record, urlPath: String) -> URL? {
        urlPath == Self.manifestMarker
            ? Self.manifestURL(origin: record.origin, downloadId: record.downloadId, clientId: record.clientId)
            : Self.assetURL(origin: record.origin, urlPath: urlPath, clientId: record.clientId)
    }

    /// Records the manifest and starts one background task per asset.
    func enqueue(_ request: EnqueueRequest) throws {
        if let existing = try? store.get(request.downloadId) {
            // Already handed over (the downloader may be further along than
            // the app knows): only a missing manifest is filled in.
            guard existing.assets.isEmpty, request.video != nil else { return }
        }
        var assets: [DownloadStore.Asset] = []
        if let video = request.video {
            assets.append(DownloadStore.Asset(urlPath: video.urlPath,
                                              diskName: Self.assetDiskName(urlPath: video.urlPath, lang: ""),
                                              sizeBytes: video.sizeBytes,
                                              sha256: video.sha256,
                                              lang: ""))
        }
        for sub in request.subtitles where request.video != nil {
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
        if #available(iOS 16.1, *) {
            DownloadLiveActivity.start(record)
        }
        startNextIfIdle()
        emitChange()
    }

    /// Transfers run one at a time, oldest first: on a slow link each episode
    /// finishes (and can be watched) while the next one downloads, instead of
    /// every episode sharing the bandwidth and none finishing. Called whenever
    /// a transfer ends, fails, pauses, resumes or is removed, after enqueueing,
    /// and on every Downloads list read.
    ///
    /// The decision uses the transfers iOS actually holds, not only the stored
    /// state: a download marked downloading whose transfer iOS dropped (or left
    /// suspended) must never block the queue.
    func startNextIfIdle() {
        session.getAllTasks { [weak self] allTasks in
            guard let self = self else { return }
            self.queueLock.lock()
            defer { self.queueLock.unlock() }
            var owner: [Int: String] = [:]
            for mapping in self.store.allTaskMappings() { owner[mapping.taskId] = mapping.downloadId }
            var changed = false
            if self.restartStalledTransfers(allTasks, owner: owner) { changed = true }
            var inFlight = Set<String>()
            var suspended: [String: [URLSessionTask]] = [:]
            for task in allTasks {
                guard let downloadId = owner[Int(task.taskIdentifier)] else { continue }
                if task.state == .suspended {
                    suspended[downloadId, default: []].append(task)
                } else {
                    inFlight.insert(downloadId)
                }
            }
            let mapped = Set(owner.values)
            for record in (try? self.store.list()) ?? [] where record.state == .downloading && !inFlight.contains(record.downloadId) {
                if let tasks = suspended[record.downloadId] {
                    for task in tasks { task.resume() }
                    inFlight.insert(record.downloadId)
                    changed = true
                } else if !mapped.contains(record.downloadId) && Date().timeIntervalSince(record.updatedAt) > 30 {
                    // Its transfer is gone and nothing has moved for 30 s (a
                    // transfer that just finished is still being verified):
                    // back in line; finished assets are kept.
                    try? self.store.setState(record.downloadId, .queued)
                    changed = true
                } else {
                    inFlight.insert(record.downloadId)
                }
            }
            if inFlight.isEmpty {
                var attempted = Set<String>()
                while let next = ((try? self.store.list()) ?? []).first(where: { $0.state == .queued && !attempted.contains($0.downloadId) }) {
                    attempted.insert(next.downloadId)
                    changed = true
                    do {
                        // Sets .downloading, or finalizes at once when every
                        // asset is already staged; then the next one is tried.
                        try self.startTasks(for: next)
                    } catch {
                        self.failDownload(next.downloadId, reason: "storage_failed")
                    }
                    if (try? self.store.get(next.downloadId))?.state == .downloading { break }
                }
            }
            // Only real changes are announced: list reads call this too, and an
            // unconditional event would make the screen re-read forever.
            if changed { self.emitChange() }
        }
    }

    /// Creates + resumes one download task per not-yet-done asset.
    private func startTasks(for record: DownloadStore.Record) throws {
        resetTransferMetrics(record.downloadId)
        let staging = try DownloadStore.stagingDirectory(downloadId: record.downloadId)
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        try store.setState(record.downloadId, .downloading)
        if record.assets.isEmpty {
            // Still preparing on the server: wait for its manifest.
            guard let url = Self.manifestURL(origin: record.origin, downloadId: record.downloadId, clientId: record.clientId) else {
                throw URLError(.badURL)
            }
            let task = session.downloadTask(with: url)
            try store.recordTask(Int(task.taskIdentifier), downloadId: record.downloadId, urlPath: Self.manifestMarker)
            noteActivity(record.downloadId, at: Date())
            task.resume()
            return
        }
        var startedTask = false
        for asset in record.assets {
            let done = try isAssetDone(record.downloadId, asset)
            if done { continue }
            guard let url = Self.assetURL(origin: record.origin, urlPath: asset.urlPath, clientId: record.clientId) else {
                // StoreError is store-internal; a malformed asset path is a
                // generic failure here (the asset path was validated upstream).
                throw URLError(.badURL)
            }
            let task = assetTask(url)
            try store.recordTask(Int(task.taskIdentifier), downloadId: record.downloadId, urlPath: asset.urlPath)
            noteActivity(record.downloadId, at: Date())
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
                self.startNextIfIdle()
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
                        try self.store.setState(downloadId, .queued)
                        self.startNextIfIdle()
                    }
                } else if tasks.isEmpty {
                    // Lost transfers wait their turn in the queue.
                    try self.store.setState(downloadId, .queued)
                    self.startNextIfIdle()
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
            self.startNextIfIdle()
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
            // A download marked active with no mapped task at all (its
            // transfer ended while the app was not running) is restarted too.
            let mapped = Set(mappings.map { $0.downloadId })
            for record in self.store.incompleteDownloads()
            where (record.state == .downloading || record.state == .queued) && !mapped.contains(record.downloadId) {
                affected.insert(record.downloadId)
            }
            for downloadId in affected {
                guard let record = try? self.store.get(downloadId), record.state == .downloading || record.state == .queued else { continue }
                try? self.store.setState(downloadId, .queued)
            }
            // Builds before the one-at-a-time queue started every download at
            // once. Keep the oldest live transfer; the others restart in turn.
            let live = self.store.incompleteDownloads().filter { $0.state == .downloading }
            for record in live.dropFirst() {
                let ids = Set(self.store.allTaskMappings().filter { $0.downloadId == record.downloadId }.map { $0.taskId })
                for task in allTasks where ids.contains(Int(task.taskIdentifier)) { task.cancel() }
                try? self.store.removeTasks(record.downloadId)
                try? self.store.resetTransferProgress(record.downloadId)
                try? self.store.setState(record.downloadId, .queued)
            }
            self.startNextIfIdle()
            // A process may be suspended after the transfer finishes but
            // before verification/finalization. The staged files are durable,
            // so finish that state instead of leaving it stuck forever.
            for record in self.store.incompleteDownloads() where record.state == .verifying {
                self.tryMaybeFinalize(record)
            }
            // Transfers from before this build (or a rule change) take the
            // current Wi-Fi rule.
            self.applyNetworkRule()
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
        lastByteAt[mapping.downloadId] = now
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
        if let mapping = store.taskOwner(Int(downloadTask.taskIdentifier)), mapping.urlPath == Self.manifestMarker {
            finishManifest(downloadTask, mapping: mapping, location: location)
            return
        }
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
            let taskId = Int(downloadTask.taskIdentifier)
            try? store.removeTask(taskId)
            clearTaskMetrics(taskId)
            // 5xx (server restarting) is worth retrying; 4xx is final.
            if http.statusCode < 500 || !scheduleRetry(downloadId: mapping.downloadId, urlPath: mapping.urlPath, resumeData: nil) {
                failDownload(mapping.downloadId, reason: "server_error")
            }
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
            stateLock.lock()
            retryAttempts.removeValue(forKey: record.downloadId + "|" + asset.urlPath)
            stateLock.unlock()
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
        stateLock.lock()
        let stalled = stallCancelled.contains(taskId)
        stateLock.unlock()
        if stalled { return } // restartStalledTransfers retries it
        clearTaskMetrics(taskId)
        try? store.removeTask(taskId)
        if error.code == NSURLErrorCancelled {
            // Usually pause()/remove(); if iOS cancelled it instead, the queue
            // check puts the download back in line.
            startNextIfIdle()
            return
        }
        // Connection drops and server restarts are routine on a home server:
        // continue from the bytes already received instead of failing.
        // A manifest request starts over (its answer may have changed).
        let resumeData = mapping.urlPath == Self.manifestMarker ? nil : error.userInfo[NSURLSessionDownloadTaskResumeData] as? Data
        if !scheduleRetry(downloadId: mapping.downloadId, urlPath: mapping.urlPath, resumeData: resumeData) {
            failDownload(mapping.downloadId, reason: "network_failed")
        }
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        finishBackgroundEvents()
    }

    // MARK: - Waiting for the server

    /// The server's answer to a manifest request: the package (download it
    /// now), still preparing (ask again), or the job failed.
    private func finishManifest(_ task: URLSessionDownloadTask, mapping: DownloadStore.TaskMapping, location: URL) {
        let taskId = Int(task.taskIdentifier)
        let data = try? Data(contentsOf: location)
        try? FileManager.default.removeItem(at: location)
        try? store.removeTask(taskId)
        clearTaskMetrics(taskId)
        guard let record = try? store.get(mapping.downloadId),
              record.state == .downloading || record.state == .queued else { return }
        if !record.assets.isEmpty {
            // The app handed the package over meanwhile: its transfers run.
            startNextIfIdle()
            return
        }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        switch status {
        case 200:
            guard let data = data, let assets = Self.manifestAssets(data), !assets.isEmpty else {
                failDownload(record.downloadId, reason: "server_error")
                return
            }
            var updated = record
            updated.assets = assets
            do {
                try store.upsert(updated)
                stateLock.lock()
                retryAttempts.removeValue(forKey: record.downloadId + "|" + Self.manifestMarker)
                stateLock.unlock()
                try startTasks(for: updated)
            } catch {
                failDownload(record.downloadId, reason: "storage_failed")
                return
            }
            emitChange()
        case 202:
            // Still preparing: ask again (the server waits up to 240 s).
            guard let url = taskURL(record, urlPath: Self.manifestMarker) else {
                failDownload(record.downloadId, reason: "server_error")
                return
            }
            let next = session.downloadTask(with: url)
            next.earliestBeginDate = Date().addingTimeInterval(2)
            try? store.recordTask(Int(next.taskIdentifier), downloadId: record.downloadId, urlPath: Self.manifestMarker)
            noteActivity(record.downloadId, at: Date())
            next.resume()
        case 410:
            failDownload(record.downloadId, reason: "server_failed")
        case 500...599:
            if !scheduleRetry(downloadId: record.downloadId, urlPath: Self.manifestMarker, resumeData: nil) {
                failDownload(record.downloadId, reason: "server_error")
            }
        default:
            failDownload(record.downloadId, reason: "server_error")
        }
    }

    /// The assets of a version-1 manifest (contracts.md §4).
    static func manifestAssets(_ data: Data) -> [DownloadStore.Asset]? {
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (json["manifestVersion"] as? NSNumber)?.intValue == 1,
              let video = json["video"] as? [String: Any],
              let videoPath = video["path"] as? String, videoPath.hasPrefix("/v1/downloads/jobs/"),
              let videoSize = (video["sizeBytes"] as? NSNumber)?.int64Value, videoSize > 0,
              let videoSHA = video["sha256"] as? String, videoSHA.count == 64 else { return nil }
        var assets = [DownloadStore.Asset(urlPath: videoPath, diskName: assetDiskName(urlPath: videoPath, lang: ""),
                                          sizeBytes: videoSize, sha256: videoSHA.lowercased(), lang: "")]
        for raw in (json["subtitles"] as? [[String: Any]]) ?? [] {
            guard let lang = raw["lang"] as? String, lang.count == 2,
                  let path = raw["path"] as? String, path.hasPrefix("/v1/downloads/jobs/"),
                  let size = (raw["sizeBytes"] as? NSNumber)?.int64Value, size > 0,
                  let sha = raw["sha256"] as? String, sha.count == 64 else { return nil }
            assets.append(DownloadStore.Asset(urlPath: path, diskName: assetDiskName(urlPath: path, lang: lang.lowercased()),
                                              sizeBytes: size, sha256: sha.lowercased(), lang: lang.lowercased()))
        }
        return assets
    }

    // MARK: - Stalled transfers

    private func noteActivity(_ downloadId: String, at date: Date) {
        stateLock.lock()
        lastByteAt[downloadId] = date
        stateLock.unlock()
    }

    /// Restarts running transfers that received nothing for stallLimit,
    /// keeping the bytes already received (resume data). Called with every
    /// queue check: on Downloads reads, transfer events, returning to the
    /// app, and every 30 s while it is open. Returns whether one restarted.
    private func restartStalledTransfers(_ tasks: [URLSessionTask], owner: [Int: String]) -> Bool {
        let now = Date()
        var restarted = false
        if waitingForWifi {
            // Silent on purpose: iOS holds them until Wi-Fi. The clock starts
            // over so they are not counted stalled the moment it returns.
            stateLock.lock()
            for downloadId in owner.values { lastByteAt[downloadId] = now }
            stateLock.unlock()
            return false
        }
        stateLock.lock()
        let limit = now < quickStallChecksUntil ? Self.networkChangeStallLimit : Self.stallLimit
        stateLock.unlock()
        for task in tasks where task.state == .running {
            let taskId = Int(task.taskIdentifier)
            guard let downloadId = owner[taskId], let download = task as? URLSessionDownloadTask,
                  let mapping = store.taskOwner(taskId) else { continue }
            // A manifest request is silent while the server prepares; the
            // request timeout (300 s) ends a dead one.
            if mapping.urlPath == Self.manifestMarker { continue }
            stateLock.lock()
            let last = lastByteAt[downloadId]
            if last == nil { lastByteAt[downloadId] = now } // first seen since launch
            let stalled = last.map { now.timeIntervalSince($0) > limit } ?? false
            if stalled {
                stallCancelled.insert(taskId)
                lastByteAt[downloadId] = now
            }
            stateLock.unlock()
            guard stalled else { continue }
            restarted = true
            download.cancel { [weak self] resumeData in
                guard let self = self else { return }
                // The replacement is recorded before the old task is dropped,
                // so the queue never sees this download without a transfer.
                let retried = self.scheduleRetry(downloadId: downloadId, urlPath: mapping.urlPath, resumeData: resumeData)
                self.clearTaskMetrics(taskId)
                try? self.store.removeTask(taskId)
                self.stateLock.lock()
                self.stallCancelled.remove(taskId)
                self.stateLock.unlock()
                if !retried { self.failDownload(downloadId, reason: "network_failed") }
            }
        }
        return restarted
    }

    // MARK: - Retry

    /// Re-creates one asset's transfer after a backoff (15s, 30s, ... 4min).
    /// earliestBeginDate lets the system start it later even while the app
    /// is suspended. Returns false once the retries are spent.
    private func scheduleRetry(downloadId: String, urlPath: String, resumeData: Data?) -> Bool {
        let key = downloadId + "|" + urlPath
        stateLock.lock()
        let attempt = (retryAttempts[key] ?? 0) + 1
        retryAttempts[key] = attempt
        stateLock.unlock()
        guard attempt <= Self.maxRetries,
              let record = try? store.get(downloadId),
              record.state == .downloading || record.state == .queued else { return false }
        let task: URLSessionDownloadTask
        if let resumeData = resumeData {
            task = assetTask(resumeData: resumeData)
        } else if let url = taskURL(record, urlPath: urlPath) {
            task = urlPath == Self.manifestMarker ? session.downloadTask(with: url) : assetTask(url)
        } else {
            return false
        }
        let begin = Date().addingTimeInterval(min(240, 15 * pow(2, Double(attempt - 1))))
        task.earliestBeginDate = begin
        do {
            try store.recordTask(Int(task.taskIdentifier), downloadId: downloadId, urlPath: urlPath)
        } catch {
            task.cancel()
            return false
        }
        noteActivity(downloadId, at: begin) // not stalled before it may begin
        task.resume()
        if #available(iOS 16.1, *) {
            DownloadLiveActivity.refresh(record, status: "Reconnecting")
        }
        emitChange()
        return true
    }

    // MARK: - Finalize

    private func tryMaybeFinalize(_ record: DownloadStore.Record) {
        guard let fresh = try? store.get(record.downloadId),
              fresh.state == .downloading || fresh.state == .queued || fresh.state == .verifying,
              !fresh.assets.isEmpty else { return } // still waiting for the server
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
        startNextIfIdle()
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
            DownloadLiveActivity.finish(record, status: "Needs repair")
        }
        resetTransferMetrics(downloadId)
        emitChange()
        // One failed asset invalidates the atomic download. Stop its sibling
        // transfers instead of wasting bandwidth until the user taps Retry.
        liveTasks(downloadId: downloadId) { tasks in
            for task in tasks { task.cancel() }
            try? self.store.removeTasks(downloadId)
        }
        startNextIfIdle()
    }
}
