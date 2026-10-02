import ActivityKit
import Foundation
import SwiftUI
import WidgetKit

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
                        size: 42,
                        lineWidth: 3
                    ) {
                        TorWatchActivityIcon(size: 32)
                    }
                }
                DynamicIslandExpandedRegion(.center) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(context.attributes.title)
                            .font(.headline)
                            .lineLimit(1)
                        Text(context.state.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(context.state.percent)%")
                        .font(.caption.monospacedDigit().weight(.semibold))
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(spacing: 6) {
                        ProgressView(value: context.state.progress)
                            .tint(context.state.tint)
                        HStack {
                            Text(context.attributes.subtitle.isEmpty ? "TorWatch" : context.attributes.subtitle)
                            Spacer()
                            Text(byteProgress(context.state))
                                .monospacedDigit()
                        }
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    }
                }
            } compactLeading: {
                TorWatchActivityIcon(size: 20)
            } compactTrailing: {
                ActivityProgressRing(
                    progress: context.state.progress,
                    tint: context.state.tint,
                    size: 24,
                    lineWidth: 2.5
                ) {
                    Image(systemName: context.state.symbolName)
                        .font(.system(size: 8, weight: .bold))
                        .foregroundStyle(context.state.tint)
                }
                .accessibilityLabel(context.state.status)
                .accessibilityValue("\(context.state.percent) percent")
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
                .accessibilityValue("\(context.state.percent) percent")
            }
            .keylineTint(context.state.tint)
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
                        Text(context.attributes.title)
                            .font(.headline)
                            .lineLimit(1)
                        Text(context.state.status)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 12)
                    Text("\(context.state.percent)%")
                        .font(.subheadline.monospacedDigit().weight(.semibold))
                }
                ProgressView(value: context.state.progress)
                    .tint(context.state.tint)
                Text(byteProgress(context.state))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
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
            .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
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
            Circle()
                .trim(from: 0, to: CGFloat(max(0.015, min(1, progress))))
                .stroke(tint, style: StrokeStyle(lineWidth: lineWidth, lineCap: .round))
                .rotationEffect(.degrees(-90))
            center
        }
        .frame(width: size, height: size)
        .animation(.easeOut(duration: 0.35), value: progress)
    }
}

@available(iOSApplicationExtension 16.1, *)
private extension DownloadActivityAttributes.ContentState {
    var tint: Color {
        switch status {
        case "Needs attention": return .red
        case "Paused": return .orange
        default: return Color(red: 0.12, green: 0.84, blue: 0.49)
        }
    }

    var symbolName: String {
        switch status {
        case "Checking file": return "checkmark.shield.fill"
        case "Downloaded": return "checkmark"
        case "Needs attention": return "exclamationmark"
        case "Paused": return "pause.fill"
        default: return "arrow.down"
        }
    }
}

@available(iOSApplicationExtension 16.1, *)
private func byteProgress(_ state: DownloadActivityAttributes.ContentState) -> String {
    let received = ByteCountFormatter.string(fromByteCount: state.receivedBytes, countStyle: .file)
    let total = ByteCountFormatter.string(fromByteCount: state.totalBytes, countStyle: .file)
    return "\(received) of \(total)"
}
