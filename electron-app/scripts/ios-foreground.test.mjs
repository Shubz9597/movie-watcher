// Compile and execute the production Swift lifecycle methods with a fake
// UIKit/VLC boundary. This checks ordering/races, not actual EAGL decoding.
// Run with swiftc, or TORWATCH_SWIFT_DOCKER=1 to use the pinned Linux image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('iOS foreground recovery orders surface refresh, play and seek, and rejects stale activation', () => {
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
    var bounds = [0, 0, 640, 360]
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
class VLCMedia { var length = VLCTime(int: 1_400_000) }
class VLCMediaPlayer {
    var media: VLCMedia? = VLCMedia()
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
    func play() { calls.append("play"); isPlaying = true }
    func pause() { calls.append("pause"); isPlaying = false }
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
    func applyVideoScale(_ player: VLCMediaPlayer) {}
    ${['togglePlayback', 'pausePlayback', 'pauseForBackground', 'resumePlayback', 'applyPendingSeek', 'recoverForegroundPlayback', 'refreshForegroundSurface'].map(method).join('\n')}
}
func fixture() -> (Player, VLCMediaPlayer, UIView) {
    calls = []
    UIApplication.shared.applicationState = .active
    let player = Player(), engine = VLCMediaPlayer(), surface = VideoSurfaceView(), output = UIView()
    output.onLayout = { calls.append("refresh"); engine.drawableReady = true }
    surface.drawableView.subviews = [output]
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

// Home -> app: the GPU reset happens even when the viewport is unchanged.
do {
    let (player, engine, output) = fixture()
    let originalBounds = output.bounds
    background(player)
    player.pauseForBackground() // duplicate notification keeps the pause anchor
    activate(player)
    assert(calls == ["pause"], "no decoder work during notification delivery")
    drainActivation()
    assert(calls == ["pause", "refresh"])
    assert(!engine.isPlaying && !player.playbackRequested)
    assert(output.bounds == originalBounds)
    assert(engine.audioTrack == 2 && engine.subtitleTrack == 4)
    assert(engine.audioDelay == 0.1 && engine.subtitleDelay == -4)
    activate(player); drainActivation()
    assert(calls.filter { $0 == "play" }.count == 0, "foreground must never autoplay")
    player.togglePlayback(CAPPluginCall())
    assert(calls == ["pause", "refresh", "play", "seek:250000"])
    assert(engine.displayedResumeFrame)
    assert(calls.filter { $0 == "play" }.count == 1)
}
// A manual pause before leaving must remain paused on return.
do {
    let (player, engine, _) = fixture()
    player.togglePlayback(CAPPluginCall())
    background(player); activate(player); drainActivation()
    assert(!engine.isPlaying && !player.playbackRequested)
    assert(calls == ["pause", "refresh"])
}
// Explicit Play followed by Pause remains paused after queued refresh work.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player)
    player.togglePlayback(CAPPluginCall()); player.togglePlayback(CAPPluginCall())
    drainActivation()
    assert(!engine.isPlaying)
    assert(calls.filter { $0 == "play" }.count == 1)
}
// A Play request delivered while inactive cannot create foreground autoplay.
do {
    let (player, engine, _) = fixture()
    background(player)
    player.togglePlayback(CAPPluginCall())
    activate(player); drainActivation()
    assert(calls == ["pause", "refresh"])
    assert(!engine.isPlaying && !player.playbackRequested)
}
// An explicit scrub is retained, and inactive seek requests are deferred.
do {
    let (player, engine, _) = fixture()
    background(player)
    player.pendingSeek = 420
    player.applyPendingSeek(engine)
    assert(calls == ["pause"])
    activate(player)
    player.applyPendingSeek(engine) // a native time/state callback during activation
    assert(calls == ["pause"], "activation callbacks must wait for surface recovery")
    drainActivation()
    assert(!engine.isPlaying && !player.playbackRequested)
    assert(engine.storedTime.intValue == 420_000)
    player.togglePlayback(CAPPluginCall())
    assert(engine.storedTime.intValue == 420_000 && engine.displayedResumeFrame)
}
// Home -> app -> Home -> app before a queued activation can execute.
do {
    let (player, engine, _) = fixture()
    background(player); activate(player)
    background(player); activate(player)
    drainActivation()
    assert(calls == ["pause", "refresh"])
    assert(!engine.isPlaying && !player.playbackRequested)
    player.togglePlayback(CAPPluginCall())
    assert(engine.displayedResumeFrame)
    assert(calls == ["pause", "refresh", "play", "seek:250000"])
}
// Closing playback or replacing its engine makes the old callback harmless.
for stopped in [false, true] {
    let (player, oldEngine, _) = fixture()
    background(player); activate(player)
    if stopped { player.terminalSent = true } else { player.mediaPlayer = VLCMediaPlayer() }
    drainActivation()
    assert(calls == ["pause"] && !oldEngine.isPlaying)
}
// Non-seekable startup retains its pending position until VLC is ready.
do {
    let (player, engine, _) = fixture()
    engine.isSeekable = false
    background(player); activate(player); drainActivation()
    assert(calls == ["pause", "refresh"] && !engine.isPlaying)
    player.togglePlayback(CAPPluginCall())
    assert(calls == ["pause", "refresh", "play"])
    assert(player.pendingSeek == 250)
    engine.isSeekable = true
    player.applyPendingSeek(engine)
    assert(engine.displayedResumeFrame && player.pendingSeek == nil)
}
print("Swift foreground lifecycle passed: both Home scenarios stay paused, explicit play/seek ordering, inactive play rejected, deferred scrub, rapid switching, replacement, and late seekability.")
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
