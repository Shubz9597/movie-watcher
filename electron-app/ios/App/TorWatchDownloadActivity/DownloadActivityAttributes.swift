import ActivityKit

@available(iOSApplicationExtension 16.1, *)
struct DownloadActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        let receivedBytes: Int64
        let totalBytes: Int64
        let status: String
        let bytesPerSecond: Int64?
        let etaSeconds: Int64?

        var progress: Double {
            guard totalBytes > 0 else { return 0 }
            return min(1, max(0, Double(receivedBytes) / Double(totalBytes)))
        }

        var percent: Int { Int((progress * 100).rounded()) }
    }

    let downloadId: String
    let title: String
    let subtitle: String
}
