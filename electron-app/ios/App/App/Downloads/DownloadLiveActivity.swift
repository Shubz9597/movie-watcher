import Foundation

#if canImport(ActivityKit)
import ActivityKit

/// One Live Activity for the device download queue (spec N2). The activity
/// follows the current transfer; other active downloads appear only as the
/// "N waiting" count. When the current item settles, the activity moves to
/// the next active download, or ends with the final state when none remain.
@available(iOS 16.1, *)
enum DownloadLiveActivity {
    private static let queueId = "device-downloads"
    private static let lock = NSLock()
    /// Last content shown, so other items can update only the waiting count.
    private static var shown: DownloadActivityAttributes.ContentState?

    static func start(_ record: DownloadStore.Record) {
        refresh(record, status: record.state == .downloading ? "Downloading" : "Queued")
    }

    static func refresh(
        _ record: DownloadStore.Record,
        status: String,
        bytesPerSecond: Int64 = 0,
        etaSeconds: Int64? = nil
    ) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let waiting = waitingCount(excluding: record.downloadId)
        let candidate = contentState(record, status: status, bytesPerSecond: bytesPerSecond, etaSeconds: etaSeconds, waiting: waiting)

        lock.lock()
        let current = shown
        // The activity keeps following its item; another download takes over
        // only when it is actively transferring and the current one is not.
        let takesOver = current == nil
            || current?.downloadId == record.downloadId
            || (status == "Downloading" && current?.status != "Downloading")
        let next: DownloadActivityAttributes.ContentState
        if takesOver {
            next = candidate
        } else if let current {
            next = current.with(waitingCount: waitingCount(excluding: current.downloadId))
        } else {
            next = candidate
        }
        shown = next
        lock.unlock()

        Task {
            if let activity = queueActivity() {
                await update(activity, state: next)
            } else {
                request(next)
            }
        }
    }

    static func finish(_ record: DownloadStore.Record, status: String, immediate: Bool = false) {
        lock.lock()
        let current = shown
        lock.unlock()
        guard current == nil || current?.downloadId == record.downloadId else {
            // A background item settled: only the waiting count changes.
            if let current {
                lock.lock()
                let updated = current.with(waitingCount: waitingCount(excluding: current.downloadId))
                shown = updated
                lock.unlock()
                Task {
                    if let activity = queueActivity() { await update(activity, state: updated) }
                }
            }
            return
        }

        // Hand the activity to the next active download, if any.
        if let nextRecord = activeRecords().first(where: { $0.downloadId != record.downloadId }) {
            lock.lock()
            shown = nil
            lock.unlock()
            refresh(nextRecord, status: displayStatus(nextRecord))
            return
        }

        let final = contentState(record, status: status, waiting: 0)
        lock.lock()
        shown = nil
        lock.unlock()
        Task {
            guard let activity = queueActivity() else { return }
            let policy: ActivityUIDismissalPolicy = immediate
                ? .immediate
                : .after(Date().addingTimeInterval(60 * 15))
            if #available(iOS 16.2, *) {
                await activity.end(ActivityContent(state: final, staleDate: nil), dismissalPolicy: policy)
            } else {
                await activity.end(using: final, dismissalPolicy: policy)
            }
        }
    }

    // MARK: - Helpers

    private static func activeRecords() -> [DownloadStore.Record] {
        let records = (try? DownloadCoordinator.shared.store.list()) ?? []
        return records.filter {
            $0.state == .downloading || $0.state == .queued || $0.state == .paused || $0.state == .verifying
        }
    }

    private static func waitingCount(excluding downloadId: String) -> Int {
        activeRecords().filter { $0.downloadId != downloadId }.count
    }

    private static func displayStatus(_ record: DownloadStore.Record) -> String {
        switch record.state {
        case .downloading: return "Downloading"
        case .paused: return "Paused"
        case .verifying: return "Checking file"
        default: return "Queued"
        }
    }

    private static func queueActivity() -> Activity<DownloadActivityAttributes>? {
        Activity<DownloadActivityAttributes>.activities.first { $0.attributes.queueId == queueId }
    }

    private static func request(_ state: DownloadActivityAttributes.ContentState) {
        let attributes = DownloadActivityAttributes(queueId: queueId)
        if #available(iOS 16.2, *) {
            _ = try? Activity.request(
                attributes: attributes,
                content: ActivityContent(state: state, staleDate: staleDate(for: state)),
                pushType: nil)
        } else {
            _ = try? Activity.request(attributes: attributes, contentState: state, pushType: nil)
        }
    }

    /// Live transfer numbers go stale if iOS stops delivering updates (the
    /// app is suspended); the widget then shows "Last update" instead of a
    /// frozen speed and time left (spec N2). Settled states never go stale.
    private static func staleDate(for state: DownloadActivityAttributes.ContentState) -> Date? {
        state.status == "Downloading" ? Date().addingTimeInterval(3 * 60) : nil
    }

    private static func contentState(
        _ record: DownloadStore.Record,
        status: String,
        bytesPerSecond: Int64 = 0,
        etaSeconds: Int64? = nil,
        waiting: Int
    ) -> DownloadActivityAttributes.ContentState {
        DownloadActivityAttributes.ContentState(
            downloadId: record.downloadId,
            title: record.title,
            subtitle: record.subtitleLabel,
            receivedBytes: record.receivedBytes,
            totalBytes: record.totalBytes,
            status: status,
            bytesPerSecond: bytesPerSecond > 0 ? bytesPerSecond : nil,
            etaSeconds: etaSeconds,
            waitingCount: waiting)
    }

    private static func update(
        _ activity: Activity<DownloadActivityAttributes>,
        state: DownloadActivityAttributes.ContentState
    ) async {
        if #available(iOS 16.2, *) {
            await activity.update(ActivityContent(state: state, staleDate: staleDate(for: state)))
        } else {
            await activity.update(using: state)
        }
    }
}

@available(iOS 16.1, *)
private extension DownloadActivityAttributes.ContentState {
    func with(waitingCount: Int) -> Self {
        Self(
            downloadId: downloadId, title: title, subtitle: subtitle,
            receivedBytes: receivedBytes, totalBytes: totalBytes, status: status,
            bytesPerSecond: bytesPerSecond, etaSeconds: etaSeconds,
            waitingCount: waitingCount)
    }
}
#endif
