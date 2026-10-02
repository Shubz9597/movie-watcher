import Foundation
import Capacitor

/**
 * TorWatchDownloadsPlugin (offline-downloads D03) — the Capacitor bridge to
 * the native download coordinator and manifest store.
 *
 * Bridge invariants (matching TorWatchNativePlugin's conventions):
 *  - Only contract-shaped data crosses the bridge: download ids, safe states,
 *    byte counts, titles. No magnets, provider data, or absolute sandbox
 *    paths.
 *  - Server scope (instanceId + origin) is RECORDED with every download and
 *    every progress record is scoped by it — progress import only ever goes
 *    back to the instance that owns the record (contracts.md §1, §6).
 *  - `downloadsChanged` fires on the main queue after any durable change so
 *    the shared React adapter can re-read the inventory snapshot.
 */
extension Notification.Name {
    static let torwatchOpenRoute = Notification.Name("TorWatchOpenRoute")
}

/// torwatch://downloads links (Live Activity and notification taps). The
/// route is kept until the web app's plugin has loaded, so a cold launch
/// still lands on Downloads.
enum TorWatchRouteLink {
    private(set) static var pendingRoute: String?

    static func handle(_ url: URL) {
        guard url.scheme?.lowercased() == "torwatch", url.host?.lowercased() == "downloads" else { return }
        pendingRoute = "downloads"
        NotificationCenter.default.post(name: .torwatchOpenRoute, object: nil)
    }

    static func consume() -> String? {
        defer { pendingRoute = nil }
        return pendingRoute
    }
}

@objc(TorWatchDownloadsPlugin)
class TorWatchDownloadsPlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TorWatchDownloadsPlugin"
    public let jsName = "TorWatchDownloads"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "list", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "remove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "storage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "loadProgress", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "localPlayablePath", returnType: CAPPluginReturnPromise),
    ]

    private var coordinator: DownloadCoordinator { DownloadCoordinator.shared }

    override public func load() {
        super.load()
        coordinator.onChange = { [weak self] in
            self?.notifyListeners("downloadsChanged", data: [:])
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: .torwatchOpenRoute, object: nil, queue: .main
        ) { [weak self] _ in
            self?.emitPendingRoute()
        }
        emitPendingRoute()
    }

    private var routeObserver: NSObjectProtocol?

    /// Retained until the web listener attaches (cold launch ordering).
    private func emitPendingRoute() {
        guard let route = TorWatchRouteLink.consume() else { return }
        notifyListeners("openRoute", data: ["route": route], retainUntilConsumed: true)
    }

    // MARK: - Bridge API

    /// Native downloads capability exists (D05 gates the four-tab navigation
    /// and the Download affordance on this).
    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func list(_ call: CAPPluginCall) {
        do {
            let records = try coordinator.store.list()
            let progress = records.map { record -> [String: Any] in
                let metrics = coordinator.transferMetrics(for: record)
                var body: [String: Any] = [
                    "downloadId": record.downloadId,
                    "instanceId": record.instanceId,
                    "origin": record.origin,
                    "seriesId": record.seriesId,
                    "season": record.season,
                    "episode": record.episode,
                    "title": record.title,
                    "posterUrl": record.posterURL,
                    "subtitleLabel": record.subtitleLabel,
                    "state": record.state.rawValue,
                    "reason": record.reason,
                    "receivedBytes": record.receivedBytes,
                    "totalBytes": record.totalBytes,
                    "bytesPerSecond": metrics.bytesPerSecond,
                ]
                if let eta = metrics.etaSeconds { body["etaSeconds"] = eta }
                if let progress = coordinator.store.loadProgress(record.downloadId) {
                    body["positionS"] = progress.positionS
                    body["durationS"] = progress.durationS
                    body["subtitleLang"] = progress.subtitleLang
                }
                return body
            }
            call.resolve(["items": progress])
        } catch {
            // A failed inventory read is a storage error — surfaced, never
            // reported as "zero downloads" (spec C2).
            call.reject("The local downloads inventory could not be read.")
        }
    }

    @objc func enqueue(_ call: CAPPluginCall) {
        guard let downloadId = call.getString("downloadId"), !downloadId.isEmpty,
              let instanceId = call.getString("instanceId"), !instanceId.isEmpty,
              let origin = call.getString("origin"), let originURL = URL(string: origin),
              originURL.scheme == "http" || originURL.scheme == "https",
              let clientId = call.getString("clientId"), !clientId.isEmpty,
              let seriesId = call.getString("seriesId"), !seriesId.isEmpty,
              let title = call.getString("title"), !title.isEmpty,
              let video = call.getObject("video"),
              let videoPath = video["path"] as? String, videoPath.hasPrefix("/v1/downloads/jobs/"),
              let videoSize = (video["sizeBytes"] as? NSNumber)?.int64Value, videoSize > 0,
              let videoSHA = video["sha256"] as? String, videoSHA.count == 64 else {
            call.reject("The download request is incomplete.")
            return
        }
        var subtitles: [(lang: String, urlPath: String, sizeBytes: Int64, sha256: String)] = []
        for raw in (call.getArray("subtitles") ?? []) {
            guard let entry = raw as? [String: Any],
                  let lang = entry["lang"] as? String, lang.count == 2,
                  let path = entry["path"] as? String, path.hasPrefix("/v1/downloads/jobs/"),
                  let size = (entry["sizeBytes"] as? NSNumber)?.int64Value, size > 0,
                  let sha = entry["sha256"] as? String, sha.count == 64 else {
                call.reject("A requested subtitle sidecar is malformed.")
                return
            }
            subtitles.append((lang: lang.lowercased(), urlPath: path, sizeBytes: size, sha256: sha))
        }
        let request = DownloadCoordinator.EnqueueRequest(
            downloadId: downloadId,
            instanceId: instanceId,
            origin: origin,
            clientId: clientId,
            seriesId: seriesId,
            season: call.getInt("season") ?? 0,
            episode: call.getInt("episode") ?? 0,
            title: title,
            posterURL: call.getString("posterUrl") ?? "",
            subtitleLabel: call.getString("subtitleLabel") ?? "",
            video: (urlPath: videoPath, sizeBytes: videoSize, sha256: videoSHA.lowercased()),
            subtitles: subtitles)
        do {
            try coordinator.enqueue(request)
            call.resolve()
        } catch {
            call.reject("The download could not be started on this device.")
        }
    }

    @objc func pause(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        coordinator.pause(id) { error in
            if error != nil {
                call.reject("The download could not be paused.")
            } else {
                call.resolve()
            }
        }
    }

    @objc func resume(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        coordinator.resume(id) { error in
            if error != nil {
                call.reject("The download could not be resumed.")
            } else {
                call.resolve()
            }
        }
    }

    /// Abandons in-flight work: tasks are cancelled and this download's
    /// staged bytes + rows are deleted. A READY download is refused here —
    /// removal of verified files is the explicit, UI-confirmed `remove`.
    @objc func cancel(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        do {
            if let record = try coordinator.store.get(id), record.state == .ready {
                call.reject("A ready download cannot be cancelled. Remove it instead.")
                return
            }
        } catch {
            call.reject("The download could not be cancelled.")
            return
        }
        coordinator.remove(id) { error in
            if error != nil {
                call.reject("The download could not be cancelled.")
            } else {
                call.resolve()
            }
        }
    }

    /// Removes a download after the caller's explicit confirmation: stops
    /// local playback if this download is active, cancels tasks, deletes this
    /// download's files and rows — never touches favourites/watch-later.
    @objc func remove(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        TorWatchNativePlugin.stopLocalPlaybackIfActive(downloadId: id)
        coordinator.remove(id) { error in
            if error != nil {
                call.reject("The download could not be removed.")
            } else {
                call.resolve()
            }
        }
    }

    @objc func storage(_ call: CAPPluginCall) {
        let info = coordinator.storageInfo()
        call.resolve(["freeBytes": info.free, "usedBytes": info.used])
    }

    // MARK: - Local playback progress (D04)

    @objc func saveProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId"),
              let position = call.getDouble("positionS"),
              let duration = call.getDouble("durationS") else {
            call.reject("The progress payload is incomplete.")
            return
        }
        do {
            try coordinator.store.saveProgress(id, positionS: position, durationS: duration,
                                               subtitleLang: call.getString("subtitleLang") ?? "")
            call.resolve()
        } catch {
            call.reject("The playback position could not be saved.")
        }
    }

    @objc func loadProgress(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        guard let progress = coordinator.store.loadProgress(id) else {
            call.resolve(["found": false])
            return
        }
        call.resolve([
            "found": true,
            "positionS": progress.positionS,
            "durationS": progress.durationS,
            "subtitleLang": progress.subtitleLang,
        ])
    }

    /// Returns the absolute file URL of a ready download's video (plus its
    /// sidecar files) for local playback. Only READY, verified downloads are
    /// resolvable — this is the only way JS can obtain a local file handle,
    /// and it can never name an arbitrary filesystem path.
    @objc func localPlayablePath(_ call: CAPPluginCall) {
        guard let id = call.getString("downloadId") else {
            call.reject("The download identifier is missing.")
            return
        }
        guard let files = try? coordinator.store.readyFileURLs(id) else {
            call.reject("That download is not ready for offline playback.")
            return
        }
        call.resolve([
            "videoPath": files.video.path,
            "subtitles": files.subtitles.map { ["lang": $0.lang, "path": $0.url.path] },
        ])
    }
}
