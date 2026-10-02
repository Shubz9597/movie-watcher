import ActivityKit

/// One Live Activity for the whole device download queue (spec N2): the
/// content follows the current transfer and counts what is still waiting.
/// Keep this file identical in the app and widget targets.
@available(iOSApplicationExtension 16.1, *)
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let downloadId: String
        let title: String
        let subtitle: String
        let receivedBytes: Int64
        let totalBytes: Int64
        let status: String
        let bytesPerSecond: Int64?
        let etaSeconds: Int64?
        let waitingCount: Int

        var progress: Double {
            guard totalBytes > 0 else { return 0 }
            return min(1, max(0, Double(receivedBytes) / Double(totalBytes)))
        }

        var percent: Int { Int((progress * 100).rounded()) }
    }

    /// Constant queue identity; per-download details live in ContentState.
    let queueId: String
}
