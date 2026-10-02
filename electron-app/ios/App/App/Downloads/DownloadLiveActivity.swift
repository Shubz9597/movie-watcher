import Foundation

#if canImport(ActivityKit)
import ActivityKit

@available(iOS 16.1, *)
enum DownloadLiveActivity {
    static func start(_ record: DownloadStore.Record) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = contentState(record, status: "Downloading")
        Task {
            if let existing = activity(downloadId: record.downloadId) {
                await update(existing, state: state)
                return
            }
            let attributes = DownloadActivityAttributes(
                downloadId: record.downloadId,
                title: record.title,
                subtitle: record.subtitleLabel)
            if #available(iOS 16.2, *) {
                _ = try? Activity.request(
                    attributes: attributes,
                    content: ActivityContent(state: state, staleDate: staleDate(for: state)),
                    pushType: nil)
            } else {
                _ = try? Activity.request(attributes: attributes, contentState: state, pushType: nil)
            }
        }
    }

    static func refresh(
        _ record: DownloadStore.Record,
        status: String,
        bytesPerSecond: Int64 = 0,
        etaSeconds: Int64? = nil
    ) {
        let state = contentState(
            record,
            status: status,
            bytesPerSecond: bytesPerSecond,
            etaSeconds: etaSeconds)
        Task {
            guard let current = activity(downloadId: record.downloadId) else {
                start(record)
                return
            }
            await update(current, state: state)
        }
    }

    static func finish(_ record: DownloadStore.Record, status: String, immediate: Bool = false) {
        let state = contentState(record, status: status)
        Task {
            guard let current = activity(downloadId: record.downloadId) else { return }
            let policy: ActivityUIDismissalPolicy = immediate
                ? .immediate
                : .after(Date().addingTimeInterval(60 * 15))
            if #available(iOS 16.2, *) {
                await current.end(
                    ActivityContent(state: state, staleDate: nil),
                    dismissalPolicy: policy)
            } else {
                await current.end(using: state, dismissalPolicy: policy)
            }
        }
    }

    /// Live transfer numbers go stale if iOS stops delivering updates (the
    /// app is suspended); the widget then shows "Last update" instead of a
    /// frozen speed and time left (spec N2). Settled states never go stale.
    private static func staleDate(for state: DownloadActivityAttributes.ContentState) -> Date? {
        state.status == "Downloading" ? Date().addingTimeInterval(3 * 60) : nil
    }

    private static func activity(downloadId: String) -> Activity<DownloadActivityAttributes>? {
        Activity<DownloadActivityAttributes>.activities.first {
            $0.attributes.downloadId == downloadId
        }
    }

    private static func contentState(
        _ record: DownloadStore.Record,
        status: String,
        bytesPerSecond: Int64 = 0,
        etaSeconds: Int64? = nil
    ) -> DownloadActivityAttributes.ContentState {
        DownloadActivityAttributes.ContentState(
            receivedBytes: record.receivedBytes,
            totalBytes: record.totalBytes,
            status: status,
            bytesPerSecond: bytesPerSecond > 0 ? bytesPerSecond : nil,
            etaSeconds: etaSeconds)
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
#endif
