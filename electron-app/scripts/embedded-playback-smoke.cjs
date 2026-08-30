const { app, BrowserWindow, screen } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const native = require(path.join(__dirname, '..', '..', 'native', 'mpv-embed'));

function nativeWindowId(window) {
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.length < 4) {
    throw new Error('Electron did not return a native window handle');
  }
  return handle.length >= 8
    ? handle.readBigUInt64LE(0).toString()
    : BigInt(handle.readUInt32LE(0)).toString();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeChildScreenBounds(mainWindow, state) {
  const contentBounds = mainWindow.getContentBounds();
  const probeWindow = new BrowserWindow({
    parent: mainWindow,
    x: contentBounds.x,
    y: contentBounds.y,
    width: contentBounds.width,
    height: contentBounds.height,
    frame: false,
    show: false,
    backgroundColor: '#f00050',
  });
  await probeWindow.loadURL('data:text/html,<body style="margin:0;background:%23f00050"></body>');
  const childBounds = probeWindow.getBounds();
  const screenOriginAligns = ['x', 'y', 'width', 'height'].every((key) => childBounds[key] === contentBounds[key]);
  const result = {
    ok: screenOriginAligns,
    state,
    screenOriginAligns,
    parentBounds: mainWindow.getBounds(),
    contentBounds,
    childBounds,
  };
  probeWindow.destroy();
  return result;
}

async function run() {
  const mainWindow = new BrowserWindow({
    width: 960,
    height: 540,
    show: true,
    backgroundColor: '#000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await mainWindow.loadURL('data:text/html,<body style="margin:0;background:black"></body>');

  mainWindow.setBounds({ x: 160, y: 120, width: 800, height: 500 });
  await delay(200);
  const contentWithMenu = mainWindow.getContentBounds();
  mainWindow.removeMenu();
  await delay(200);
  const contentWithoutMenu = mainWindow.getContentBounds();
  const menuBandRemoved = contentWithoutMenu.y < contentWithMenu.y
    && contentWithoutMenu.height > contentWithMenu.height;
  const windowedOrigin = await probeChildScreenBounds(mainWindow, 'windowed');
  mainWindow.maximize();
  await delay(300);
  const maximizedOrigin = await probeChildScreenBounds(mainWindow, 'maximized');
  const framedLayoutOk = menuBandRemoved && windowedOrigin.ok && maximizedOrigin.ok;
  console.log(`FRAMED_PLAYER_LAYOUT_SMOKE=${JSON.stringify({ ok: framedLayoutOk, menuBandRemoved, contentWithMenu, contentWithoutMenu, windowedOrigin, maximizedOrigin })}`);
  if (!framedLayoutOk) process.exitCode = 1;

  if (process.platform === 'win32') {
    mainWindow.setKiosk(true);
  } else {
    mainWindow.setFullScreen(true);
  }
  await delay(500);
  const fullscreen = mainWindow.isFullScreen() || mainWindow.isKiosk();
  const mainBounds = mainWindow.getBounds();
  const displayBounds = screen.getDisplayMatching(mainBounds).bounds;
  const windowMatchesDisplay = ['x', 'y', 'width', 'height'].every((key) => mainBounds[key] === displayBounds[key]);

  const [width, height] = mainWindow.getContentSize();
  const parentId = nativeWindowId(mainWindow);
  console.log('SMOKE_STAGE=parent-window-ready');
  const videoHostId = native.createVideoHost(parentId, 0, 0, width, height);
  console.log('SMOKE_STAGE=video-host-created');
  const mpv = native.MpvHandle.create();
  console.log('SMOKE_STAGE=mpv-handle-created');
  let firstSessionDestroyed = false;

  try {
    mpv.attachWindow(videoHostId);
    console.log('SMOKE_STAGE=video-host-attached');
    mpv.init({});
    console.log('SMOKE_STAGE=mpv-initialized');
    native.showVideoHost(videoHostId, true);
    mpv.load('av://lavfi:testsrc2=duration=8:size=640x360:rate=30', 3);
    console.log('SMOKE_STAGE=test-video-loaded');
    mpv.pause(false);
    console.log('SMOKE_STAGE=playback-started');

    // Match the app's canonical fullscreen surface: the display-sized outer
    // bounds, not a potentially stale decorated content inset.
    const controlsBounds = fullscreen ? mainWindow.getBounds() : mainWindow.getContentBounds();
    const { createPlayerSurfaceController } = await import(pathToFileURL(
      path.join(__dirname, '..', 'electron', 'windows', 'player-surface-controller.js'),
    ).href);
    const controlsUrl = `${pathToFileURL(path.join(__dirname, '..', 'dist', 'player-controls.html')).href}?preview=playback`;
    const playerSurface = createPlayerSurfaceController({
      appDirectory: path.join(__dirname, '..'),
      controlsDevUrl: controlsUrl,
      getMainWindow: () => mainWindow,
      getMpvSession: () => ({ resizeVideoHost: () => {} }),
      sleep: delay,
    });
    await playerSurface.showLoadingOverlay(
      { title: 'The Last Horizon', kind: 'series', season: 1, episode: 7 },
      { year: 2026 },
    );
    const controlsWindow = playerSurface.controlsWindow;
    await delay(700);

    const controlsResult = await controlsWindow.webContents.executeJavaScript(`(async () => {
      document.body.style.background = 'linear-gradient(135deg, #14212b, #755241 48%, #111820)';
      const fullscreenButton = document.getElementById('fullscreenBtn');
      fullscreenButton.focus();
      fullscreenButton.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
      const pointerFocusReleased = document.activeElement !== fullscreenButton;

      const press = async (code, options = {}) => {
        document.dispatchEvent(new KeyboardEvent('keydown', { code, key: options.key || '', shiftKey: Boolean(options.shiftKey), bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      };
      window.__playerPreviewInvocations.length = 0;
      await press('ArrowRight', { key: 'ArrowRight', shiftKey: true });
      await press('KeyJ', { key: 'j' });
      await press('KeyX', { key: 'x' });
      await press('KeyX', { key: 'X', shiftKey: true });
      await press('KeyA', { key: 'a' });

      const episodeCode = document.getElementById('episodeCode');
      const episodeIdentity = {
        code: episodeCode.textContent,
        label: episodeCode.getAttribute('aria-label'),
        visible: !episodeCode.hidden,
      };
      renderPlaybackIdentity({ title: 'A Feature Film' });
      const movieEpisodeHidden = episodeCode.hidden;
      renderPlaybackIdentity({ title: 'The Last Horizon', season: 1, episode: 7 });

      return {
        pointerFocusReleased,
        invocations: window.__playerPreviewInvocations,
        toast: document.getElementById('aspectToast').textContent,
        episodeCode: episodeIdentity.code,
        episodeLabel: episodeIdentity.label,
        episodeVisible: episodeIdentity.visible,
        movieEpisodeHidden,
      };
    })()`);
    const controlsScreenshot = path.join(os.tmpdir(), 'movie-watcher-controls-smoke.png');
    const controlsImage = await controlsWindow.webContents.capturePage();
    fs.writeFileSync(controlsScreenshot, controlsImage.toPNG());
    const overlayBounds = controlsWindow.getBounds();
    const overlayMatches = ['x', 'y', 'width', 'height'].every((key) => overlayBounds[key] === controlsBounds[key]);
    const shortcutCalls = controlsResult.invocations.filter((entry) => entry.channel !== 'mpv:state');
    const shortcutOk = JSON.stringify(shortcutCalls) === JSON.stringify([
      { channel: 'mpv:seek', args: [1, true] },
      { channel: 'mpv:seek', args: [-10, true] },
      { channel: 'mpv:setSubtitleDelay', args: [0.1] },
      { channel: 'mpv:setAudioDelay', args: [0.1] },
      { channel: 'mpv:cycleAspect', args: [] },
    ]);
    const episodeIdentityOk = controlsResult.episodeVisible
      && controlsResult.episodeCode === 'S01E07'
      && controlsResult.episodeLabel === 'Season 1, Episode 7'
      && controlsResult.movieEpisodeHidden;
    const controlsOk = fullscreen && windowMatchesDisplay && overlayMatches && controlsResult.pointerFocusReleased && shortcutOk && episodeIdentityOk;
    console.log(`PLAYER_CONTROLS_SMOKE=${JSON.stringify({ ok: controlsOk, fullscreen, windowMatchesDisplay, overlayMatches, controlsBounds, overlayBounds, pointerFocusReleased: controlsResult.pointerFocusReleased, shortcutOk, episodeIdentityOk, episodeCode: controlsResult.episodeCode, episodeLabel: controlsResult.episodeLabel, toast: controlsResult.toast, screenshot: controlsScreenshot })}`);
    if (!controlsOk) process.exitCode = 1;
    controlsWindow.destroy();

    await delay(1500);
    const first = mpv.getState();
    await delay(1000);
    const second = mpv.getState();
    const resumed = Number(first.time) >= 3;
    const advanced = Number(second.time) > Number(first.time);

    const result = {
      ok: resumed && advanced,
      resumed,
      sameWindowHost: true,
      parentWindowId: parentId,
      videoHostId,
      firstTime: Number(first.time),
      secondTime: Number(second.time),
      duration: Number(second.duration),
      paused: Boolean(second.paused),
      videoOutput: mpv.getVo(),
    };
    console.log(`EMBEDDED_PLAYBACK_SMOKE=${JSON.stringify(result)}`);
    if (!resumed || !advanced) process.exitCode = 1;

    mpv.stop();
    mpv.shutdown();
    native.destroyVideoHost(videoHostId);
    firstSessionDestroyed = true;
    console.log('SMOKE_STAGE=first-session-destroyed');

    const replacementHostId = native.createVideoHost(parentId, 0, 0, width, height);
    const replacementMpv = native.MpvHandle.create();
    try {
      replacementMpv.attachWindow(replacementHostId);
      replacementMpv.init({});
      native.showVideoHost(replacementHostId, true);
      replacementMpv.load('av://lavfi:testsrc2=duration=4:size=640x360:rate=30');
      replacementMpv.pause(false);
      await delay(1200);
      const replacementState = replacementMpv.getState();
      const replacementOk = Number(replacementState.time) > 0.5;
      console.log(`EMBEDDED_RECREATE_SMOKE=${JSON.stringify({ ok: replacementOk, replacementHostId, time: Number(replacementState.time) })}`);
      if (!replacementOk) process.exitCode = 1;
    } finally {
      try { replacementMpv.stop(); } catch {}
      try { replacementMpv.shutdown(); } catch {}
      try { native.destroyVideoHost(replacementHostId); } catch {}
    }
  } finally {
    console.log('SMOKE_STAGE=cleanup-started');
    if (!firstSessionDestroyed) {
      try { mpv.stop(); } catch {}
      try { mpv.shutdown(); } catch {}
      try { native.destroyVideoHost(videoHostId); } catch {}
    }
    mainWindow.destroy();
  }
}

app.whenReady()
  .then(run)
  .catch((error) => {
    console.error('EMBEDDED_PLAYBACK_SMOKE_ERROR', error);
    process.exitCode = 1;
  })
  .finally(() => app.quit());
