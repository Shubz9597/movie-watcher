import Foundation
import AVFoundation
import AVKit
import UIKit
import Capacitor

/**
 * TorWatchNativePlugin (feature 002 M1.4.4) — local Capacitor plugin
 * implementing full-screen native playback with AVPlayer (AVKit).
 *
 * Security/privacy invariants (repair pass M1.4):
 *  - Only OPAQUE playback/subtitle URLs (from /v2/playback/sessions), a
 *    display title, an optional public poster URL, and the web-chosen
 *    `playId` cross the bridge. No magnets, tokens, or credentials.
 *  - Error surfaces are GENERIC: AVFoundation error text is never forwarded
 *    (it can embed request context); the web layer owns actionable copy.
 *  - Every event carries `playId`, so events from a replaced (dying) player
 *    can never be attributed to the new session.
 *  - Exactly one terminal state per playback, guarded by `terminalSent`.
 *  - All observers/time-observers/player items are torn down on dismiss or
 *    replacement.
 *
 * Playback UX (M1.4 device pass):
 *  - The player and the pre-flight loading screen are LANDSCAPE-locked; the
 *    web app underneath stays portrait (device default).
 *  - A poster-backed buffering overlay covers the player until the item is
 *    likely to keep up (frames flowing), and re-appears when the buffer runs
 *    empty — a truthful "loader in the video" for peer-driven sources.
 *
 * Subtitles (M1.4.7): sidecar/extracted WebVTT tracks (the only kind the
 * /v2/playback/sessions contract offers) are rendered by a NATIVE overlay —
 * downloaded, parsed, and synced against a 0.25 s time observer, with a CC
 * button cycling Off → track. HLS renditions that declare WebVTT via
 * #EXT-X-MEDIA continue to be handled natively by AVPlayer's media-selection
 * UI; the overlay coexists with it (the server currently emits the same
 * tracks as sidecars, so the CC picker is the reliable surface).
 *
 * Build note: this file is part of the App target; compiling requires
 * Xcode/macOS.
 */
@objc(TorWatchNativePlugin)
class TorWatchNativePlugin: CAPPlugin, CAPBridgedPlugin {

    public let identifier = "TorWatchNativePlugin"
    public let jsName = "TorWatchNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "prepare", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "showError", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "play", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "seek", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "dismiss", returnType: CAPPluginReturnPromise),
    ]

    private var playerViewController: TorWatchPlayerViewController?
    private var loadingViewController: TorWatchLoadingViewController?

    // MARK: - Bridge API

    @objc func prepare(_ call: CAPPluginCall) {
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        let title = call.getString("title") ?? "TorWatch"
        let posterUrl = URL(string: call.getString("posterUrl") ?? "")
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { call.reject("Player unavailable."); return }
            let controller = TorWatchLoadingViewController(title: title, posterUrl: posterUrl, playId: playId) { [weak self] in
                self?.notifyListeners("playbackState", data: ["state": "stopped", "playId": playId])
            }
            self.loadingViewController = controller
            self.currentPresentationViewController().present(controller, animated: false) {
                call.resolve()
            }
        }
    }

    @objc func showError(_ call: CAPPluginCall) {
        let playId = call.getString("playId") ?? ""
        let message = call.getString("message") ?? "Could not prepare this source."
        DispatchQueue.main.async { [weak self] in
            if let controller = self?.loadingViewController, controller.playId == playId {
                controller.showError(message)
            }
            call.resolve()
        }
    }

    @objc func play(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("The playback URL is missing or invalid.")
            return
        }
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        let title = call.getString("title") ?? "TorWatch"
        let posterUrl = URL(string: call.getString("posterUrl") ?? "")
        let seekTo = call.getDouble("seekTo")
        var subtitleTracks: [SubtitleTrackSource] = []
        for item in call.getArray("subtitles") ?? [] {
            guard let dict = item as? [String: Any],
                  let urlString = dict["url"] as? String,
                  let trackUrl = URL(string: urlString) else { continue }
            subtitleTracks.append(SubtitleTrackSource(url: trackUrl, label: dict["label"] as? String))
        }

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            // Replace any existing session cleanly (observers included).
            self.teardownPlayer()
            let controller = TorWatchPlayerViewController(
                url: url,
                title: title,
                posterUrl: posterUrl,
                subtitleTracks: subtitleTracks,
                seekTo: seekTo,
                playId: playId,
                eventSink: { [weak self] name, data in
                    self?.notifyListeners(name, data: data)
                },
                onDismissed: { [weak self] in
                    if self?.playerViewController?.hasPlayId(playId) == true {
                        self?.playerViewController = nil
                    }
                }
            )
            self.playerViewController = controller
            let presentPlayer = {
                self.currentPresentationViewController().present(controller, animated: false) {
                    controller.startPlayback()
                    call.resolve()
                }
            }
            if let loading = self.loadingViewController, loading.playId == playId {
                self.loadingViewController = nil
                loading.dismiss(animated: false, completion: presentPlayer)
            } else {
                presentPlayer()
            }
        }
    }

    @objc func seek(_ call: CAPPluginCall) {
        let position = call.getDouble("positionSec") ?? 0
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            if let controller = self?.playerViewController, controller.hasPlayId(playId) {
                controller.seek(toSeconds: position)
            }
            call.resolve()
        }
    }

    @objc func dismiss(_ call: CAPPluginCall) {
        guard let playId = call.getString("playId"), !playId.isEmpty else {
            call.reject("The playback identifier is missing.")
            return
        }
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            if let loading = self.loadingViewController, loading.playId == playId {
                self.loadingViewController = nil
                loading.dismiss(animated: false) { call.resolve() }
                return
            }
            if let controller = self.playerViewController, controller.hasPlayId(playId) {
                // teardownPlayer runs in the dismissal completion; the explicit
                // call here covers the JS-initiated close where the delegate
                // callback may not fire first.
                self.playerViewController = nil
                controller.dismissAndTeardown { call.resolve() }
                return
            }
            call.resolve()
        }
    }

    // MARK: - Helpers

    private func currentPresentationViewController() -> UIViewController {
        var candidate: UIViewController? = self.bridge?.viewController
        while let presented = candidate?.presentedViewController, !presented.isBeingDismissed {
            candidate = presented
        }
        return candidate ?? UIViewController()
    }

    private func teardownPlayer() {
        playerViewController?.dismissAndTeardown()
        playerViewController = nil
    }
}

// MARK: - Subtitle sources

/// One WebVTT track offered by the session (opaque URL + display label only).
struct SubtitleTrackSource {
    let url: URL
    let label: String?
}

// MARK: - Shared poster/buffering visuals

/// The poster-backed buffering surface. Used full-screen by the pre-flight
/// loading screen and as an overlay above the video while AVPlayer buffers.
final class TorWatchBufferingView: UIView {
    private let posterImageView = UIImageView()
    private let blurredBackdrop = UIVisualEffectView(effect: UIBlurEffect(style: .dark))
    private let backdropImageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()

    init(title: String, posterUrl: URL?) {
        super.init(frame: .zero)
        backgroundColor = .black

        backdropImageView.contentMode = .scaleAspectFill
        backdropImageView.alpha = 0
        addSubview(backdropImageView)
        addSubview(blurredBackdrop)

        posterImageView.contentMode = .scaleAspectFill
        posterImageView.clipsToBounds = true
        posterImageView.layer.cornerRadius = 14
        posterImageView.layer.cornerCurve = .continuous
        posterImageView.layer.shadowColor = UIColor.black.cgColor
        posterImageView.layer.shadowOpacity = 0.6
        posterImageView.layer.shadowRadius = 18
        posterImageView.layer.shadowOffset = CGSize(width: 0, height: 8)
        posterImageView.alpha = 0
        addSubview(posterImageView)

        titleLabel.text = title
        titleLabel.textColor = .white
        titleLabel.font = .preferredFont(forTextStyle: .title3).bold()
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.numberOfLines = 2
        titleLabel.textAlignment = .center
        titleLabel.alpha = 0

        statusLabel.text = "Buffering…"
        statusLabel.textColor = .lightGray
        statusLabel.font = .preferredFont(forTextStyle: .footnote)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.numberOfLines = 1
        statusLabel.textAlignment = .center
        statusLabel.alpha = 0

        spinner.color = .white
        spinner.hidesWhenStopped = true
        spinner.startAnimating()

        addSubview(titleLabel)
        addSubview(spinner)
        addSubview(statusLabel)

        titleLabel.translatesAutoresizingMaskIntoConstraints = false
        spinner.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        backdropImageView.translatesAutoresizingMaskIntoConstraints = false
        blurredBackdrop.translatesAutoresizingMaskIntoConstraints = false
        posterImageView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            backdropImageView.topAnchor.constraint(equalTo: topAnchor),
            backdropImageView.bottomAnchor.constraint(equalTo: bottomAnchor),
            backdropImageView.leadingAnchor.constraint(equalTo: leadingAnchor),
            backdropImageView.trailingAnchor.constraint(equalTo: trailingAnchor),

            blurredBackdrop.topAnchor.constraint(equalTo: topAnchor),
            blurredBackdrop.bottomAnchor.constraint(equalTo: bottomAnchor),
            blurredBackdrop.leadingAnchor.constraint(equalTo: leadingAnchor),
            blurredBackdrop.trailingAnchor.constraint(equalTo: trailingAnchor),

            posterImageView.centerXAnchor.constraint(equalTo: centerXAnchor),
            posterImageView.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -28),
            posterImageView.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.52),
            posterImageView.widthAnchor.constraint(equalTo: posterImageView.heightAnchor, multiplier: 2.0 / 3.0),

            titleLabel.topAnchor.constraint(equalTo: posterImageView.bottomAnchor, constant: 20),
            titleLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 32),
            titleLabel.trailingAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.trailingAnchor, constant: -32),
            titleLabel.centerXAnchor.constraint(equalTo: centerXAnchor),

            spinner.topAnchor.constraint(equalTo: titleLabel.bottomAnchor, constant: 18),
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),

            statusLabel.topAnchor.constraint(equalTo: spinner.bottomAnchor, constant: 10),
            statusLabel.leadingAnchor.constraint(greaterThanOrEqualTo: safeAreaLayoutGuide.leadingAnchor, constant: 24),
            statusLabel.trailingAnchor.constraint(lessThanOrEqualTo: safeAreaLayoutGuide.trailingAnchor, constant: -24),
            statusLabel.centerXAnchor.constraint(equalTo: centerXAnchor),
        ])

        if let posterUrl = posterUrl {
            loadPoster(from: posterUrl)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    private func loadPoster(from url: URL) {
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard let self = self, let data = data, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard self.posterImageView.image == nil else { return }
                self.backdropImageView.image = image
                self.posterImageView.image = image
                UIView.animate(withDuration: 0.35) {
                    self.backdropImageView.alpha = 0.55
                    self.posterImageView.alpha = 1
                    self.titleLabel.alpha = 1
                    self.statusLabel.alpha = 1
                }
                self.startBreathing()
            }
        }.resume()
    }

    /// The shared app's loading language: the poster gently "breathes" while
    /// the source prepares. Runs until the view is torn down with the overlay.
    private func startBreathing() {
        UIView.animate(
            withDuration: 1.6,
            delay: 0,
            options: [.repeat, .autoreverse, .allowUserInteraction]
        ) {
            self.posterImageView.transform = CGAffineTransform(scaleX: 1.035, y: 1.035)
        }
    }

    func setStatus(_ text: String) {
        statusLabel.text = text
    }
}

// MARK: - Loading screen (pre-flight)

/// A native full-screen landscape stage appears before server inspection
/// starts. It receives only a display title, poster URL, and a generation
/// tag — never a source URL.
class TorWatchLoadingViewController: UIViewController {
    let playId: String
    private let bufferingView: TorWatchBufferingView
    private let onClose: () -> Void
    private let closeButton = UIButton(type: .system)

    init(title: String, posterUrl: URL?, playId: String, onClose: @escaping () -> Void) {
        self.playId = playId
        self.bufferingView = TorWatchBufferingView(title: title, posterUrl: posterUrl)
        self.onClose = onClose
        super.init(nibName: nil, bundle: nil)
        modalPresentationStyle = .fullScreen
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { [.landscapeLeft, .landscapeRight] }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        bufferingView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(bufferingView)
        NSLayoutConstraint.activate([
            bufferingView.topAnchor.constraint(equalTo: view.topAnchor),
            bufferingView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            bufferingView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bufferingView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])
        closeButton.setTitle("Close player", for: .normal)
        closeButton.tintColor = .white
        closeButton.backgroundColor = UIColor.black.withAlphaComponent(0.55)
        closeButton.layer.cornerRadius = 18
        closeButton.layer.borderWidth = 1
        closeButton.layer.borderColor = UIColor.white.withAlphaComponent(0.25).cgColor
        closeButton.contentEdgeInsets = UIEdgeInsets(top: 12, left: 20, bottom: 12, right: 20)
        closeButton.addTarget(self, action: #selector(closePlayer), for: .touchUpInside)
        closeButton.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(closeButton)
        NSLayoutConstraint.activate([
            closeButton.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            closeButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -18),
            closeButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ])
    }

    func showError(_ message: String) {
        loadViewIfNeeded()
        bufferingView.setStatus(message)
        closeButton.setTitle("Choose another source", for: .normal)
    }

    @objc private func closePlayer() {
        closeButton.isEnabled = false
        onClose()
    }
}

// MARK: - Subtitle rendering

struct ParsedSubtitleCue {
    let start: Double
    let end: Double
    let text: String
}

/// Minimal WebVTT parser for the session sidecar contract: cues with
/// timestamps; NOTE/STYLE/REGION blocks skipped; inline tags stripped; the
/// handful of entities the contract produces decoded. Cue styling from the
/// file is intentionally dropped (matches the shared VTT limitation).
enum WebVTTParser {
    static func parse(_ raw: String) -> [ParsedSubtitleCue] {
        let lines = raw
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
            .components(separatedBy: "\n")
        var cues: [ParsedSubtitleCue] = []
        var index = 0
        while index < lines.count {
            let line = lines[index].trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("WEBVTT") || line.hasPrefix("NOTE")
                || line.hasPrefix("STYLE") || line.hasPrefix("REGION") {
                index += 1
                continue
            }
            // Cue block: optional identifier line, then the timing line.
            var timingLine: String?
            if line.contains("-->") {
                timingLine = line
                index += 1
            } else if index + 1 < lines.count, lines[index + 1].contains("-->") {
                timingLine = lines[index + 1]
                index += 2
            }
            guard let timing = timingLine else { index += 1; continue }
            let parts = timing.components(separatedBy: "-->")
            guard parts.count == 2,
                  let start = timestampSeconds(parts[0].trimmingCharacters(in: .whitespaces)) else {
                continue
            }
            // "--> end settings" — discard alignment/position settings.
            let endPart = parts[1].split(whereSeparator: { $0 == " " || $0 == "\t" }).first
                .map(String.init) ?? parts[1]
            guard let end = timestampSeconds(endPart.trimmingCharacters(in: .whitespaces)) else { continue }
            var textLines: [String] = []
            while index < lines.count {
                let textLine = lines[index]
                if textLine.trimmingCharacters(in: .whitespaces).isEmpty { break }
                textLines.append(textLine)
                index += 1
            }
            let text = decodeEntities(
                textLines.joined(separator: "\n")
                    .replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
            )
            if !text.isEmpty {
                cues.append(ParsedSubtitleCue(start: start, end: end, text: text))
            }
        }
        return cues
    }

    private static func timestampSeconds(_ value: String) -> Double? {
        let cleaned = value.replacingOccurrences(of: ",", with: ".")
        let segments = cleaned.split(separator: ":").map(String.init)
        guard segments.count == 2 || segments.count == 3 else { return nil }
        var seconds = 0.0
        for segment in segments {
            guard let piece = Double(segment) else { return nil }
            seconds = seconds * 60 + piece
        }
        return seconds
    }

    private static func decodeEntities(_ text: String) -> String {
        let stripped = text.replacingOccurrences(of: "<[^>]+>", with: "", options: .regularExpression)
        return stripped
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .replacingOccurrences(of: "&nbsp;", with: " ")
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&#39;", with: "'")
    }
}

/// Native sidecar-subtitle renderer: downloads the session's WebVTT tracks,
/// renders the active cue above the video's bottom edge, and exposes a CC
/// button cycling Off → tracks. Works for direct AND remuxed sessions (the
/// server's HLS subtitle renditions are the same sidecar files).
final class TorWatchSubtitleController: NSObject {
    static let maxSubtitleBytes = 4 << 20

    private struct LoadedTrack {
        let label: String
        let cues: [ParsedSubtitleCue]
    }

    private let tracks: [SubtitleTrackSource]
    private weak var overlayHost: UIView?
    private let cueLabel = UILabel()
    private let ccButton = UIButton(type: .system)
    private var loaded: [Int: LoadedTrack] = [:]
    private var loadingStarted = false
    private var selectedIndex: Int? // nil = off
    private var activeText: String?

    init(tracks: [SubtitleTrackSource], overlayHost: UIView) {
        self.tracks = tracks
        self.overlayHost = overlayHost
        super.init()
        buildOverlay()
    }

    var hasTracks: Bool { !tracks.isEmpty }

    private func buildOverlay() {
        guard let host = overlayHost, hasTracks else { return }
        cueLabel.textColor = .white
        cueLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        cueLabel.textAlignment = .center
        cueLabel.numberOfLines = 3
        cueLabel.layer.shadowColor = UIColor.black.cgColor
        cueLabel.layer.shadowOpacity = 0.9
        cueLabel.layer.shadowRadius = 3
        cueLabel.layer.shadowOffset = CGSize(width: 0, height: 1)
        cueLabel.alpha = 0
        cueLabel.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(cueLabel)

        ccButton.setTitle("CC", for: .normal)
        ccButton.setTitleColor(.white, for: .normal)
        ccButton.titleLabel?.font = .systemFont(ofSize: 14, weight: .bold)
        ccButton.backgroundColor = UIColor.black.withAlphaComponent(0.6)
        ccButton.layer.cornerRadius = 10
        ccButton.layer.borderWidth = 1
        ccButton.layer.borderColor = UIColor.white.withAlphaComponent(0.35).cgColor
        ccButton.contentEdgeInsets = UIEdgeInsets(top: 6, left: 12, bottom: 6, right: 12)
        ccButton.addTarget(self, action: #selector(showPicker), for: .touchUpInside)
        ccButton.translatesAutoresizingMaskIntoConstraints = false
        host.addSubview(ccButton)

        NSLayoutConstraint.activate([
            cueLabel.centerXAnchor.constraint(equalTo: host.safeAreaLayoutGuide.centerXAnchor),
            cueLabel.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -64),
            cueLabel.leadingAnchor.constraint(greaterThanOrEqualTo: host.safeAreaLayoutGuide.leadingAnchor, constant: 40),
            cueLabel.trailingAnchor.constraint(lessThanOrEqualTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -40),

            ccButton.topAnchor.constraint(equalTo: host.safeAreaLayoutGuide.topAnchor, constant: 56),
            ccButton.trailingAnchor.constraint(equalTo: host.safeAreaLayoutGuide.trailingAnchor, constant: -16),
        ])
    }

    /// Download + parse every track once (bounded); tracks appear in the CC
    /// picker as their downloads finish.
    func loadTracksIfNeeded() {
        guard !loadingStarted else { return }
        loadingStarted = true
        for (index, track) in tracks.enumerated() {
            let task = URLSession.shared.dataTask(with: track.url) { [weak self] data, _, _ in
                guard let self = self,
                      let data = data,
                      data.count <= Self.maxSubtitleBytes,
                      let raw = String(data: data, encoding: .utf8) else { return }
                let cues = WebVTTParser.parse(raw)
                DispatchQueue.main.async {
                    self.loaded[index] = LoadedTrack(label: self.tracks[index].label ?? "Track \(index + 1)", cues: cues)
                }
            }
            task.resume()
        }
    }

    /// Called on the 0.25 s subtitle time observer (main queue).
    func update(currentTime: Double) {
        guard let index = selectedIndex, let track = loaded[index] else { return }
        let cue = track.cues.first { currentTime >= $0.start && currentTime <= $0.end }
        let text = cue?.text
        if text != activeText {
            activeText = text
            cueLabel.text = text
            UIView.animate(withDuration: 0.15) {
                self.cueLabel.alpha = text == nil ? 0 : 1
            }
        }
    }

    @objc private func showPicker() {
        guard let host = overlayHost,
              let presenting = host.next as? UIViewController else { return }

        let alert = UIAlertController(title: "Subtitles", message: nil, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: selectedIndex == nil ? "✓ Off" : "Off", style: .default) { [weak self] _ in
            self?.select(nil)
        })
        for (index, _) in tracks.enumerated() {
            let label = loaded[index]?.label ?? (tracks[index].label ?? "Track \(index + 1)")
            let checkmark = selectedIndex == index ? "✓ " : ""
            alert.addAction(UIAlertAction(title: "\(checkmark)\(label)", style: .default) { [weak self] _ in
                self?.select(index)
            })
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel))
        if let popover = alert.popoverPresentationController {
            popover.sourceView = ccButton
            popover.sourceRect = ccButton.bounds
        }
        presenting.present(alert, animated: true)
    }

    private func select(_ index: Int?) {
        selectedIndex = index
        activeText = nil
        cueLabel.text = nil
        cueLabel.alpha = 0
        ccButton.backgroundColor = index == nil
            ? UIColor.black.withAlphaComponent(0.6)
            : UIColor.white.withAlphaComponent(0.85)
        ccButton.setTitleColor(index == nil ? .white : .black, for: .normal)
    }
}

// MARK: - Player

/**
 * Full-screen landscape AVPlayerViewController with observer hygiene, honest
 * interruption/background handling, a poster-backed buffering overlay, and
 * native sidecar-subtitle rendering.
 */
class TorWatchPlayerViewController: AVPlayerViewController {

    private var timeObserver: Any?
    private var subtitleTimeObserver: Any?
    private var statusObserver: NSKeyValueObservation?
    private var likelyToKeepUpObserver: NSKeyValueObservation?
    private var bufferEmptyObserver: NSKeyValueObservation?
    private var interruptionObserver: NSObjectProtocol?
    private var endedObserver: NSObjectProtocol?
    private var terminalSent = false
    private let playId: String
    private let posterUrl: URL?
    private let subtitleTracks: [SubtitleTrackSource]
    private var bufferingView: TorWatchBufferingView?
    private var subtitleController: TorWatchSubtitleController?
    private let eventSink: (String, [String: Any]) -> Void
    private let onDismissed: () -> Void

    init(
        url: URL,
        title: String,
        posterUrl: URL?,
        subtitleTracks: [SubtitleTrackSource],
        seekTo: Double?,
        playId: String,
        eventSink: @escaping (String, [String: Any]) -> Void,
        onDismissed: @escaping () -> Void
    ) {
        self.playId = playId
        self.posterUrl = posterUrl
        self.subtitleTracks = subtitleTracks
        self.eventSink = eventSink
        self.onDismissed = onDismissed

        let playerItem = AVPlayerItem(url: url)
        let player = AVPlayer(playerItem: playerItem)
        super.init(nibName: nil, bundle: nil)
        self.player = player
        self.title = title
        // Landscape-locked video: present landscape regardless of the device
        // orientation; dismissal returns the app to the web UI's portrait.
        self.modalPresentationStyle = .fullScreen
        self.entersFullScreenWhenPlaybackBegins = true

        // Periodic time updates for progress heartbeats (bounded cadence).
        timeObserver = player.addPeriodicTimeObserver(
            forInterval: CMTime(seconds: 0.5, preferredTimescale: 10),
            queue: .main
        ) { [weak self] time in
            guard let self = self, !self.terminalSent else { return }
            let duration = self.player?.currentItem?.duration.seconds ?? 0
            self.eventSink("timeUpdate", [
                "currentTime": time.seconds.isFinite ? time.seconds : 0,
                "duration": duration.isFinite ? duration : 0,
                "playId": self.playId,
            ])
        }

        // Faster tick for subtitle cue switching (0.5 s feels laggy for text).
        if !subtitleTracks.isEmpty {
            subtitleTimeObserver = player.addPeriodicTimeObserver(
                forInterval: CMTime(seconds: 0.25, preferredTimescale: 10),
                queue: .main
            ) { [weak self] time in
                self?.subtitleController?.update(currentTime: time.seconds)
            }
        }

        // Item status: terminal error reporting (exactly once, generic text).
        statusObserver = playerItem.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard let self = self, !self.terminalSent else { return }
            switch item.status {
            case .failed:
                self.terminalSent = true
                // Generic message ONLY: AVFoundation error text can embed
                // request context; the web layer owns actionable copy.
                self.eventSink("playbackState", [
                    "state": "error",
                    "message": "The media could not be played on this device.",
                    "playId": self.playId,
                ])
            case .readyToPlay:
                if let seekTo = seekTo, seekTo > 0 {
                    player.seek(
                        to: CMTime(seconds: seekTo, preferredTimescale: 600),
                        toleranceBefore: .zero,
                        toleranceAfter: CMTime(seconds: 0.5, preferredTimescale: 600)
                    )
                }
            default:
                break
            }
        }

        // Buffering truth: the poster overlay covers the player until frames
        // actually render (.playing) and returns during stalls (.waiting…).
        // .paused intentionally keeps the overlay hidden (a user pause is not
        // a buffering state).
        // Buffering truth: the poster overlay covers the player until the
        // item reports it is likely to keep up, and returns when the buffer
        // runs empty (a stall). A user pause is not a buffering state: pause
        // triggers neither signal, so the overlay stays hidden.
        likelyToKeepUpObserver = playerItem.observe(\.isPlaybackLikelyToKeepUp, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.terminalSent else { return }
                if item.isPlaybackLikelyToKeepUp {
                    self.setBufferingVisible(false)
                }
            }
        }
        bufferEmptyObserver = playerItem.observe(\.isPlaybackBufferEmpty, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self = self, !self.terminalSent else { return }
                if item.isPlaybackBufferEmpty {
                    self.setBufferingVisible(true)
                }
            }
        }

        // Playback end: exactly-once terminal.
        endedObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: playerItem,
            queue: .main
        ) { [weak self] _ in
            guard let self = self, !self.terminalSent else { return }
            self.terminalSent = true
            self.eventSink("playbackState", ["state": "ended", "playId": self.playId])
        }

        // Audio interruptions (calls, alarms): honest paused state to the app.
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            guard let self = self,
                  let info = notification.userInfo,
                  let typeRaw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
            switch type {
            case .began:
                self.eventSink("playbackState", [
                    "state": "paused",
                    "message": "Audio interrupted.",
                    "playId": self.playId,
                ])
            case .ended:
                self.eventSink("playbackState", ["state": "playing", "playId": self.playId])
            @unknown default:
                break
            }
        }
    }

    required init?(coder: NSCoder) {
        fatalError("init(coder:) is not supported")
    }

    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { [.landscapeLeft, .landscapeRight] }
    override var preferredInterfaceOrientationForPresentation: UIInterfaceOrientation { .landscapeRight }

    override func viewDidLoad() {
        super.viewDidLoad()
        // The buffering overlay + subtitle surface live on contentOverlayView:
        // above the video, below AVKit's transport controls.
        if let overlay = contentOverlayView {
            let buffering = TorWatchBufferingView(title: title ?? "TorWatch", posterUrl: posterUrl)
            buffering.translatesAutoresizingMaskIntoConstraints = false
            overlay.addSubview(buffering)
            NSLayoutConstraint.activate([
                buffering.topAnchor.constraint(equalTo: overlay.topAnchor),
                buffering.bottomAnchor.constraint(equalTo: overlay.bottomAnchor),
                buffering.leadingAnchor.constraint(equalTo: overlay.leadingAnchor),
                buffering.trailingAnchor.constraint(equalTo: overlay.trailingAnchor),
            ])
            bufferingView = buffering

            let subtitles = TorWatchSubtitleController(tracks: subtitleTracks, overlayHost: overlay)
            subtitleController = subtitles
        }
    }

    func startPlayback() {
        setUpAudioSession()
        subtitleController?.loadTracksIfNeeded()
        player?.play()
    }

    private func setBufferingVisible(_ visible: Bool) {
        guard let buffering = bufferingView else { return }
        let target: CGFloat = visible ? 1 : 0
        if buffering.alpha != target {
            UIView.animate(withDuration: 0.25) { buffering.alpha = target }
        }
    }

    func seek(toSeconds: Double) {
        player?.seek(
            to: CMTime(seconds: toSeconds, preferredTimescale: 600),
            toleranceBefore: CMTime(seconds: 0.25, preferredTimescale: 600),
            toleranceAfter: CMTime(seconds: 1, preferredTimescale: 600)
        )
    }

    func hasPlayId(_ candidate: String) -> Bool {
        return playId == candidate
    }

    func dismissAndTeardown(completion: (() -> Void)? = nil) {
        if presentingViewController != nil {
            dismiss(animated: true) { [weak self] in
                self?.fullTeardown()
                self?.onDismissed()
                completion?()
            }
        } else {
            fullTeardown()
            onDismissed()
            completion?()
        }
    }

    /// User dismissal (Done button / swipe): notify 'stopped' exactly once so
    /// the JS session client can delete the server session.
    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if presentedViewController == nil && !terminalSent {
            terminalSent = true
            eventSink("playbackState", ["state": "stopped", "playId": playId])
            fullTeardown()
            onDismissed()
        }
    }

    private func fullTeardown() {
        if let timeObserver = timeObserver {
            player?.removeTimeObserver(timeObserver)
        }
        timeObserver = nil
        if let subtitleTimeObserver = subtitleTimeObserver {
            player?.removeTimeObserver(subtitleTimeObserver)
        }
        subtitleTimeObserver = nil
        statusObserver?.invalidate()
        statusObserver = nil
        likelyToKeepUpObserver?.invalidate()
        likelyToKeepUpObserver = nil
        bufferEmptyObserver?.invalidate()
        bufferEmptyObserver = nil
        if let interruptionObserver = interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
        if let endedObserver = endedObserver {
            NotificationCenter.default.removeObserver(endedObserver)
        }
        endedObserver = nil
        bufferingView?.removeFromSuperview()
        bufferingView = nil
        subtitleController = nil
        player?.pause()
        player = nil
    }

    /// Playback category so audio respects the device's silent switch and
    /// interruption contract. No background-audio entitlement is claimed.
    private func setUpAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        try? AVAudioSession.sharedInstance().setActive(true)
    }
}

extension UIFont {
    func bold() -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(.traitBold) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
