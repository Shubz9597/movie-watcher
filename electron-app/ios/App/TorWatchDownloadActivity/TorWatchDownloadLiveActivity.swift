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
                    TorWatchActivityIcon(size: 36)
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
                            .tint(.white)
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
                Text("\(context.state.percent)%")
                    .font(.caption2.monospacedDigit().weight(.semibold))
            } minimal: {
                TorWatchActivityIcon(size: 18)
            }
            .keylineTint(.white.opacity(0.6))
        }
    }
}

@available(iOSApplicationExtension 16.1, *)
private struct LockScreenDownloadView: View {
    let context: ActivityViewContext<DownloadActivityAttributes>

    var body: some View {
        HStack(spacing: 14) {
            TorWatchActivityIcon(size: 44)
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
                    .tint(.white)
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
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .clipShape(RoundedRectangle(cornerRadius: size * 0.24, style: .continuous))
            .accessibilityHidden(true)
    }
}

@available(iOSApplicationExtension 16.1, *)
private func byteProgress(_ state: DownloadActivityAttributes.ContentState) -> String {
    let received = ByteCountFormatter.string(fromByteCount: state.receivedBytes, countStyle: .file)
    let total = ByteCountFormatter.string(fromByteCount: state.totalBytes, countStyle: .file)
    return "\(received) of \(total)"
}
