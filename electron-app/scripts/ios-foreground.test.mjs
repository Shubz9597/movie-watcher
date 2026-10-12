// Compile and execute the production Swift lifecycle methods with a fake
// UIKit/VLC boundary. This checks ordering/races, not actual EAGL decoding.
// Run with swiftc, or TORWATCH_SWIFT_DOCKER=1 to use the pinned Linux image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('iOS video preparation waits for fresh output, stays silent and paused, and rejects stale activation', () => {
  const source = readFileSync(new URL('../ios/App/App/TorWatchNativePlugin.swift', import.meta.url), 'utf8');
  // Use the actual method bodies, so changes to native ordering are exercised.
  const method = name => {
    const start = source.indexOf(`func ${name}(`);
    assert.ok(start >= 0, `missing native method ${name}`);
    const open = source.indexOf('{', start);
    let depth = 1, end = open + 1;
    while (depth && end < source.length) {
      if (source[end] === '{') depth++;
      if (source[end] === '}') depth--;
      end++;
    }
    assert.equal(depth, 0);
    return source.slice(start, end);
  };
  const directory = mkdtempSync(path.join(tmpdir(), 'torwatch-ios-foreground-'));
  try {
    writeFileSync(path.join(directory, 'main.swift'), `
import Foundation
import Dispatch

var calls: [String] = []
var events: [(String, [String: Any])] = []
var fixtures: [Player] = []
class UIApplication {
    enum State { case active, background }
    static let shared = UIApplication()
    var applicationState: State = .active
}
class AVAudioSession {
    static let shared = AVAudioSession()
    static func sharedInstance() -> AVAudioSession { shared }
    func setActive(_ active: Bool) throws {}
}
class UIView {
    var superview: UIView?
    var subviews: [UIView] = []
    var onLayout: (() -> Void)?
    var dirty = false
    var bounds = CGRect(x: 0, y: 0, width: 640, height: 360)
    var window: UIView?
    func setNeedsLayout() { dirty = true }
    func layoutIfNeeded() { if dirty { dirty = false; onLayout?() } }
    static func performWithoutAnimation(_ work: () -> Void) { work() }
}
class VideoSurfaceView: UIView {
    let drawableView = UIView()
    ${method('refreshDrawableAfterBackground')}
}
class VLCTime {
    let intValue: Int32
    init(int: Int32) { intValue = int }
}
struct MediaStats { var decodedVideo: Int32 = 100; var displayedPictures: Int32 = 100 }
class VLCMedia {
    var length = VLCTime(int: 1_400_000)
    var statistics = MediaStats()
}
class VLCAudio { var isMuted = false }
class VLCMediaPlayer {
    enum State { case playing, paused }
    var state: State = .playing
    var media: VLCMedia? = VLCMedia()
    var audio = VLCAudio()
    var hasVideoOut = true
    var videoSize = CGSize(width: 640, height: 360)
    var isSeekable = true
    var isPlaying = true
    var drawableReady = false
    var displayedResumeFrame = false
    var audioTrack = 2, subtitleTrack = 4
    var audioDelay = 0.1, subtitleDelay = -4.0
    var storedTime = VLCTime(int: 250_000)
    var time: VLCTime {
        get { storedTime }
        set {
            calls.append("seek:\\(newValue.intValue)")
            storedTime = newValue
            displayedResumeFrame = isPlaying && drawableReady && UIApplication.shared.applicationState == .active
        }
    }
    func play() { calls.append("play"); isPlaying = true; state = .playing }
    func pause() { calls.append("pause"); isPlaying = false; state = .paused }
}
class CAPPluginCall {
    func getString(_ name: String) -> String? { "current" }
    func resolve() {}
}
class Player {
    var mediaPlayer: VLCMediaPlayer?
    var surfaceView: VideoSurfaceView?
    var terminalSent = false
    var playId = "current"
    var pendingSeek: Double?
    var pausedPositionMs: Int32?
    var playbackRequested = true
    var needsForegroundRefresh = false
    var activationGeneration: UInt64 = 0
    var videoReady = true
    var videoPreparationTimer: Timer?
    var videoPreparationStarted: Date?
    var preparationDecodedBaseline = 0
    var preparationDisplayedBaseline = 0
    var preparationTargetMs: Int32 = 0
    var preparationRetried = false
    var awaitingPreparationPause = false
    var preparationAudioWasMuted: Bool?
    func notifyListeners(_ name: String, data: [String: Any]) { events.append((name, data)) }
    func emitTracks() {}
    func applyVideoScale(_ player: VLCMediaPlayer) {}
    ${['togglePlayback', 'pausePlayback', 'pauseForBackground', 'resumePlayback', 'applyPendingSeek', 'recoverForegroundPlayback', 'refreshForegroundSurface', 'beginVideoPreparation', 'checkVideoPreparation', 'completeVideoPreparation', 'cancelVideoPreparation'].map(method).join('\n')}
}
func fixture() -> (Player, VLCMediaPlayer, UIView) {
    for previous in fixtures { previous.cancelVideoPreparation() }
    calls = []; events = []
    UIApplication.shared.applicationState = .active
    let player = Player(), engine = VLCMediaPlayer(), surface = VideoSurfaceView(), output = UIView()
    output.onLayout = { calls.append("refresh"); engine.drawableReady = true }
    surface.drawableView.subviews = [output]
    fixtures.append(player)
    surface.window = UIView()
    player.mediaPlayer = engine
    player.surfaceView = surface
    return (player, engine, output)
}
func drainActivation() { RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.03)) }
func background(_ player: Player) {
    UIApplication.shared.applicationState = .background
    player.pauseForBackground()
}
func activate(_ player: Player) {
    UIApplication.shared.applicationState = .active
    player.recoverForegroundPlayback()
}

func freshFrames(_ player: Player, _ engine: VLCMediaPlayer) {
    engine.media!.statistics.decodedVideo = Int32(player.preparationDecodedBaseline + 2)
    engine.media!.statistics.displayedPictures = Int32(player.preparationDisplayedBaseline + 2)
    engine.storedTime = VLCTime(int: player.preparationTargetMs + 100)
}
func confirmPausedPreparation(_ player: Player, _ engine: VLCMediaPlayer) {
    freshFrames(player, engine)
    player.checkVideoPreparation(engine)
    assert(!player.videoReady && engine.audio.isMuted, "wait for pause confirmation")
    player.checkVideoPreparation(engine)
    assert(player.videoReady && !player.playbackRequested && !engine.isPlaying)
}

// Playing -> Home -> app: preroll is silent; public intent stays paused.
do {
    let (player, engine, output) = fixture()
    let originalBounds = output.bounds
    background(player); player.pauseForBackground()
    activate(player)
    assert(calls == ["pause"], "no decoder work during notification delivery")
    drainActivation()
    assert(calls == ["pause", "refresh", "play", "seek:250000"])
    assert(!player.videoReady && !player.playbackRequested && engine.audio.isMuted)
    player.togglePlayback(CAPPluginCall())
    assert(calls.filter { $0 == "play" }.count == 1, "ignore Play while preparing")
    confirmPausedPreparation(player, engine)
    assert(!engine.audio.isMuted && output.bounds == originalBounds)
    assert(engine.audioTrack == 2 && engine.subtitleTrack == 4)
    assert(engine.audioDelay == 0.1 && engine.subtitleDelay == -4)
    let seeks = calls.filter { $0.hasPrefix("seek:") }.count
    player.togglePlayback(CAPPluginCall())
    assert(engine.isPlaying && player.playbackRequested)
    assert(calls.filter { $0.hasPrefix("seek:") }.count == seeks, "ready Play must not force another keyframe seek")
}
// Paused -> Home -> app has the same silent preparation and paused result.
do {
    let (player, engine, _) = fixture()
    engine.audio.isMuted = true
    player.togglePlayback(CAPPluginCall())
    background(player); activate(player); drainActivation()
    confirmPausedPreparation(player, engine)
    assert(engine.audio.isMuted, "retain the viewer's original mute")
    activate(player); drainActivation()
    assert(player.videoReady && !engine.isPlaying)
}
// Audio clock and redisplaying old pictures cannot unlock Play.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player); drainActivation()
    engine.storedTime = VLCTime(int: 250_500)
    player.checkVideoPreparation(engine)
    assert(!player.videoReady)
    engine.media!.statistics.displayedPictures += 20
    player.checkVideoPreparation(engine)
    assert(!player.videoReady && engine.audio.isMuted)
    engine.media!.statistics.decodedVideo += 2
    engine.hasVideoOut = false
    player.checkVideoPreparation(engine)
    assert(!player.videoReady)
    engine.hasVideoOut = true
    player.surfaceView!.window = nil
    player.checkVideoPreparation(engine)
    assert(!player.videoReady)
    player.surfaceView!.window = UIView()
    confirmPausedPreparation(player, engine)
}
// Startup audio stays muted until fresh decoded pictures reach output.
do {
    let (player, engine, _) = fixture()
    engine.storedTime = VLCTime(int: 0)
    player.pendingSeek = 600
    player.beginVideoPreparation(engine)
    player.checkVideoPreparation(engine)
    assert(!player.videoReady && engine.audio.isMuted)
    freshFrames(player, engine)
    player.checkVideoPreparation(engine)
    assert(player.videoReady && player.playbackRequested && engine.isPlaying && !engine.audio.isMuted)
}
// Inactive Play is rejected; explicit seek waits for foreground preparation.
do {
    let (player, engine, _) = fixture()
    background(player)
    player.togglePlayback(CAPPluginCall())
    player.pendingSeek = 420
    player.applyPendingSeek(engine)
    assert(calls == ["pause"])
    activate(player)
    player.applyPendingSeek(engine)
    assert(calls == ["pause"])
    drainActivation()
    assert(engine.storedTime.intValue == 420_000 && engine.audio.isMuted)
    confirmPausedPreparation(player, engine)
}
// Rapid switching/background during preroll never creates audible autoplay.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player)
    background(player); activate(player); drainActivation()
    assert(calls.filter { $0 == "play" }.count == 1 && engine.audio.isMuted)
    engine.storedTime = VLCTime(int: 255_000) // preroll catch-up is not watched progress
    background(player)
    assert(!engine.isPlaying && player.videoPreparationStarted == nil)
    assert(player.pausedPositionMs == 250_000, "keep the requested position through interrupted preroll")
    activate(player); drainActivation()
    confirmPausedPreparation(player, engine)
    assert(!engine.isPlaying && !player.playbackRequested && !engine.audio.isMuted)
}
// Old queued activation cannot touch a closed or replaced engine.
for stopped in [false, true] {
    let (player, oldEngine, _) = fixture()
    background(player); activate(player)
    if stopped { player.terminalSent = true } else { player.mediaPlayer = VLCMediaPlayer() }
    drainActivation()
    assert(calls == ["pause"] && !oldEngine.isPlaying)
}
// Late seekability cannot accept old frames from the wrong timestamp.
do {
    let (player, engine, _) = fixture()
    engine.isSeekable = false
    background(player); activate(player); drainActivation()
    freshFrames(player, engine)
    player.checkVideoPreparation(engine)
    assert(player.pendingSeek == 250 && !player.videoReady)
    engine.isSeekable = true
    player.checkVideoPreparation(engine)
    assert(!player.videoReady, "seek resets old readiness counters")
    confirmPausedPreparation(player, engine)
}
// Cold decoding that advances too far is returned to the target once, hidden.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player); drainActivation()
    freshFrames(player, engine)
    engine.storedTime = VLCTime(int: 255_000)
    player.checkVideoPreparation(engine)
    assert(player.preparationRetried && !player.videoReady && engine.audio.isMuted)
    assert(engine.storedTime.intValue == 250_000)
    confirmPausedPreparation(player, engine)
}
// Failed video output errors instead of becoming ready because a timer expired.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player); drainActivation()
    player.videoPreparationStarted = Date(timeIntervalSinceNow: -16)
    player.checkVideoPreparation(engine)
    assert(player.terminalSent && !player.videoReady && !engine.isPlaying)
    assert(events.contains { $0.0 == "playbackState" && ($0.1["state"] as? String) == "error" })
}
for player in fixtures { player.cancelVideoPreparation() }
print("Swift foreground lifecycle passed: silent decoded/output readiness, both Home scenarios paused, no seek on ready Play, startup, inactive requests, rapid switching, replacement, late seekability, catch-up, and timeout.")

`);
    const docker = process.env.TORWATCH_SWIFT_DOCKER === '1';
    const args = docker
      ? ['run', '--rm', '--network', 'none', '--memory', '768m', '--cpus', '2', '-v', `${directory}:/work:Z`, '-w', '/work', 'swift:6.0.3-bookworm', 'swiftc', '-swift-version', '5', 'main.swift', '-o', 'foreground-test']
      : ['-swift-version', '5', 'main.swift', '-o', 'foreground-test'];
    execFileSync(docker ? 'docker' : 'swiftc', args, {cwd: directory, stdio: 'pipe'});
    const output = docker
      ? execFileSync('docker', ['run', '--rm', '--network', 'none', '--memory', '128m', '-v', `${directory}:/work:Z`, '-w', '/work', 'swift:6.0.3-bookworm', './foreground-test'], {encoding: 'utf8'})
      : execFileSync(path.join(directory, 'foreground-test'), {encoding: 'utf8'});
    assert.match(output, /Swift foreground lifecycle passed/);
    console.log(output.trim());
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
