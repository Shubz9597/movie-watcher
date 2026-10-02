import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

// Live Activity (offline-downloads WF09/WF10, spec N2). Follows the app
// design system: white progress on near-black, secondary text for metadata,
// red only for an item that needs repair. Unknown totals stay indeterminate
// (no invented percentage), unmeasured speed/ETA are omitted, and stale
// content says "Last update" instead of pretending to be live.
@available(iOSApplicationExtension 16.1, *)
struct TorWatchDownloadLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DownloadActivityAttributes.self) { context in
            LockScreenDownloadView(context: context)
                .activityBackgroundTint(Color.black.opacity(0.92))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    ActivityProgressRing(
                        progress: context.state.progress,
                        tint: context.state.tint,
                        size: 44,
                        lineWidth: 3
                    ) {
                        TorWatchActivityIcon(size: 36)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(displayTitle(context.state))
                            .font(.headline)
                            .lineLimit(1)
                        Text(statusLine(context))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if context.state.hasKnownTotal {
                        Text("\(context.state.percent)%")
                            .font(.caption.monospacedDigit().weight(.semibold))
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        if context.state.hasKnownTotal {
                            ProgressView(value: context.state.progress)
                                .tint(context.state.tint)
                        }
                        HStack {
                            Text(byteProgress(context.state))
                                .monospacedDigit()
                            Spacer()
                            if let summary = transferSummary(context) {
                                Text(summary)
                                    .monospacedDigit()
                            } else if let waiting = waitingLine(context.state) {
                                Text(waiting)
                            }
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                TorWatchActivityIcon(size: 24)
            } compactTrailing: {
                // WF09: the compact island carries the measured percentage.
                if context.state.hasKnownTotal && context.state.status == "Downloading" {
                    Text("\(context.state.percent)%")
                        .font(.caption2.monospacedDigit().weight(.semibold))
                        .foregroundStyle(.white)
                        .accessibilityLabel(context.state.status)
                        .accessibilityValue("\(context.state.percent) percent")
                } else {
                    Image(systemName: context.state.symbolName)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(context.state.tint)
                        .accessibilityLabel(context.state.status)
                }
            } minimal: {
                ActivityProgressRing(
                    progress: context.state.progress,
                    tint: context.state.tint,
                    size: 28,
                    lineWidth: 2.5
                ) {
                    TorWatchActivityIcon(size: 18)
                }
                .accessibilityLabel("TorWatch \(context.state.status)")
                .accessibilityValue(context.state.hasKnownTotal ? "\(context.state.percent) percent" : "")
            }
            .keylineTint(context.state.tint)
            .widgetURL(downloadsURL)
        }
    }
}

@available(iOSApplicationExtension 16.1, *)
private struct LockScreenDownloadView: View {
    let context: ActivityViewContext<DownloadActivityAttributes>

    var body: some View {
        HStack(spacing: 14) {
            ActivityProgressRing(
                progress: context.state.progress,
                tint: context.state.tint,
                size: 52,
                lineWidth: 3
            ) {
                TorWatchActivityIcon(size: 42)
            }
            VStack(alignment: .leading, spacing: 7) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(displayTitle(context.state))
                            .font(.headline)
                            .lineLimit(1)
                        Text(statusLine(context))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    if context.state.hasKnownTotal {
                        Text("\(context.state.percent)%")
                            .font(.subheadline.monospacedDigit().weight(.semibold))
                    }
                }
                if context.state.hasKnownTotal {
                    ProgressView(value: context.state.progress)
                        .tint(context.state.tint)
                }
                Text(byteProgress(context.state))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
                if let summary = transferSummary(context) {
                    Text(summary)
                        .font(.caption2.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                if let waiting = waitingLine(context.state) {
                    Text(waiting)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(16)
        .widgetURL(downloadsURL)
    }
}

private struct TorWatchActivityIcon: View {
    let size: CGFloat

    var body: some View {
        Image("TorWatchActivityIcon")
            .renderingMode(.original)
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

private struct ActivityProgressRing<Center: View>: View {
    let progress: Double
    let tint: Color
    let size: CGFloat
    let lineWidth: CGFloat
    let center: Center

    init(
        progress: Double,
        tint: Color,
        size: CGFloat,
        lineWidth: CGFloat,
        @ViewBuilder center: () -> Center
    ) {
        self.progress = progress
        self.tint = tint
        self.size = size
        self.lineWidth = lineWidth
        self.center = center()
    }

    var body: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.16), lineWidth: lineWidth)
            if progress > 0 {
                Circle()
                    .trim(from: 0, to: CGFloat(max(0.015, min(1, progress))))
                    .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            center
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.35), value: progress)
    }
}

@available(iOSApplicationExtension 16.1, *)
private extension DownloadActivityAttributes.ContentState {
    var hasKnownTotal: Bool { totalBytes > 0 }

    // Design system: white progress; paused is quieter; red only for repair.
    var tint: Color {
        switch status {
        case "Needs repair": return .red
        case "Paused": return Color.white.opacity(0.55)
        default: return .white
        }
    }

    var symbolName: String {
        switch status {
        case "Checking file": return "checkmark.shield.fill"
        case "Downloaded": return "checkmark"
        case "Needs repair": return "exclamationmark"
        case "Paused": return "pause.fill"
        default: return "arrow.down"
        }
    }

    var compactETA: String? {
        guard let etaSeconds, etaSeconds > 0 else { return nil }
        if etaSeconds < 60 { return "<1m" }
        let minutes = Int(ceil(Double(etaSeconds) / 60))
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        let remainder = minutes % 60
        return remainder == 0 ? "\(hours)h" : "\(hours)h \(remainder)m"
    }
}

@available(iOSApplicationExtension 16.1, *)
private func isStale(_ context: ActivityViewContext<DownloadActivityAttributes>) -> Bool {
    if #available(iOS 16.2, *) {
        return context.isStale
    }
    return false
}

/// "Frieren · S1 E3" — the episode (or quality) label follows the title.
@available(iOSApplicationExtension 16.1, *)
private func displayTitle(_ state: DownloadActivityAttributes.ContentState) -> String {
    state.subtitle.isEmpty ? state.title : "\(state.title) · \(state.subtitle)"
}

/// Queue context for the rest of the device queue ("2 waiting").
@available(iOSApplicationExtension 16.1, *)
private func waitingLine(_ state: DownloadActivityAttributes.ContentState) -> String? {
    state.waitingCount > 0 ? "\(state.waitingCount) waiting" : nil
}

/// Taps open the Downloads tab (SceneDelegate → TorWatchRouteLink).
private let downloadsURL = URL(string: "torwatch://downloads")

@available(iOSApplicationExtension 16.1, *)
private func statusLine(_ context: ActivityViewContext<DownloadActivityAttributes>) -> String {
    isStale(context) && context.state.status == "Downloading" ? "Last update" : context.state.status
}

@available(iOSApplicationExtension 16.1, *)
private func byteProgress(_ state: DownloadActivityAttributes.ContentState) -> String {
    // Binary units match the app's Downloads screen (1 GB = 1024 MB).
    let received = ByteCountFormatter.string(fromByteCount: state.receivedBytes, countStyle: .binary)
    guard state.hasKnownTotal else { return "\(received) received" }
    let total = ByteCountFormatter.string(fromByteCount: state.totalBytes, countStyle: .binary)
    return "\(received) of \(total)"
}

/// Measured speed and time left only; nothing when stale or unmeasured.
@available(iOSApplicationExtension 16.1, *)
private func transferSummary(_ context: ActivityViewContext<DownloadActivityAttributes>) -> String? {
    let state = context.state
    guard state.status == "Downloading", !isStale(context) else { return nil }
    var parts: [String] = []
    if let bytesPerSecond = state.bytesPerSecond, bytesPerSecond > 0 {
        parts.append(ByteCountFormatter.string(fromByteCount: bytesPerSecond, countStyle: .binary) + "/s")
    }
    if let eta = state.compactETA {
        parts.append("\(eta) left")
    }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
}
