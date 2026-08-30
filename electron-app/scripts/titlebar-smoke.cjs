const { app, BrowserWindow } = require('electron');
const path = require('path');

const rendererPath = path.join(__dirname, '..', 'dist', 'index.html');
const controlsPath = path.join(__dirname, '..', 'dist', 'player-controls.html');
const setupPath = path.join(__dirname, '..', 'dist', 'setup.html');
const startupPath = path.join(__dirname, '..', 'dist', 'startup.html');
const page = process.env.TORWATCH_SMOKE_PAGE || 'main';
const subtitlePreview = process.env.TORWATCH_SMOKE_SUBTITLES || '1';
const width = Number(process.env.TORWATCH_SMOKE_WIDTH || (page === 'controls' ? 1280 : 760));
const height = Number(process.env.TORWATCH_SMOKE_HEIGHT || (page === 'controls' ? 720 : 600));
const screenshotPath = path.join(__dirname, '..', 'release', `ui-smoke-${page}-${width}.png`);

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#111214',
      symbolColor: '#dadbdf',
      height: 40,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: page === 'runtime' ? path.join(__dirname, 'runtime-smoke-preload.cjs') : undefined,
    },
  });
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.log(`UI_CONSOLE=${message}`);
  });

  if (page === 'setup') {
    await window.loadFile(setupPath);
  } else if (page === 'startup') {
    await window.loadFile(startupPath);
  } else if (page === 'controls') {
    await window.loadFile(controlsPath, {
      query: { preview: 'controls', subtitles: subtitlePreview },
    });
  } else {
    await window.loadFile(rendererPath);
  }
  await new Promise((resolve) => setTimeout(resolve, ['search', 'runtime'].includes(page) ? 1_400 : 800));

  if (page === 'runtime') {
    await window.webContents.executeJavaScript(`window.electronAPI.emitRuntimeState()`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  if (page === 'search') {
    await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Search titles"]')?.click()`);
    await new Promise((resolve) => setTimeout(resolve, 1_400));
  }

  const layout = await window.webContents.executeJavaScript(`(async () => {
    if (${JSON.stringify(page)} === 'controls') {
      const hud = document.querySelector('.hud');
      const skipButton = document.querySelector('#segmentSkipBtn');
      await new Promise((resolve) => setTimeout(resolve, 4_800));
      const fadedSkipButtonStyle = skipButton ? getComputedStyle(skipButton) : null;
      const skipButtonFadedBeforeReveal = Boolean(skipButton
        && !skipButton.classList.contains('visible')
        && fadedSkipButtonStyle?.pointerEvents === 'none');
      if (skipButton) skipButton.style.transition = 'none';
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 400));
      const skipButtonRect = skipButton?.getBoundingClientRect();
      const skipButtonStyle = skipButton ? getComputedStyle(skipButton) : null;
      const timelineRect = document.querySelector('.timeline-wrap')?.getBoundingClientRect();
      const controlRowRect = document.querySelector('.control-row')?.getBoundingClientRect();
      const skipButtonVisible = Boolean(skipButtonRect
        && skipButtonRect.width >= 120
        && skipButtonRect.height === 44
        && skipButton?.classList.contains('visible')
        && skipButton?.getAttribute('aria-hidden') === 'false'
        && !skipButton?.disabled
        && skipButton?.textContent.includes('Skip intro'));
      const skipButtonRightAligned = Boolean(skipButtonRect
        && skipButtonRect.right <= document.documentElement.clientWidth
        && skipButtonRect.left > document.documentElement.clientWidth * 0.7);
      const skipButtonUsesLightTreatment = skipButtonStyle?.backgroundColor === 'rgb(255, 255, 255)'
        && skipButtonStyle?.color === 'rgb(10, 10, 10)';
      const skipButtonIsOpaque = Number(skipButtonStyle?.opacity) >= 0.99;
      const overflowing = [...document.querySelectorAll('*')]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.left < 0 || rect.right > document.documentElement.clientWidth)
        .slice(0, 12)
        .map(({ element, rect }) => ({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          left: rect.left,
          right: rect.right,
          width: rect.width,
        }));
      const internallyOverflowing = [...document.querySelectorAll('*')]
        .filter((element) => element.scrollWidth > element.clientWidth)
        .slice(0, 12)
        .map((element) => ({
          tag: element.tagName,
          className: typeof element.className === 'string' ? element.className : '',
          clientWidth: element.clientWidth,
          scrollWidth: element.scrollWidth,
          overflowX: getComputedStyle(element).overflowX,
        }));
      return {
        ok: Boolean(hud)
          && document.documentElement.scrollWidth === document.documentElement.clientWidth
          && skipButtonFadedBeforeReveal
          && skipButtonVisible
          && skipButtonRightAligned
          && skipButtonUsesLightTreatment
          && skipButtonIsOpaque
          && Boolean(timelineRect && skipButtonRect.bottom < timelineRect.top)
          && (${JSON.stringify(subtitlePreview)} !== 'missing' || document.body.innerText.includes('Add OpenSubtitles')),
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        hudVisible: Boolean(hud),
        overflowing,
        internallyOverflowing,
        bodyClientWidth: document.body.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
        contextualSubtitleSetup: document.body.innerText.includes('Add OpenSubtitles'),
        skipButtonVisible,
        skipButtonFadedBeforeReveal,
        skipButtonRightAligned,
        skipButtonUsesLightTreatment,
        skipButtonIsOpaque,
        skipButtonOpacity: skipButtonStyle?.opacity,
        skipButtonRect: skipButtonRect ? {
          left: skipButtonRect.left,
          top: skipButtonRect.top,
          right: skipButtonRect.right,
          bottom: skipButtonRect.bottom,
        } : null,
        skipButtonBackground: skipButtonStyle?.backgroundColor,
        skipButtonColor: skipButtonStyle?.color,
        skipButtonText: skipButton?.textContent.trim() || '',
        skipButtonAboveTimeline: Boolean(timelineRect && skipButtonRect?.bottom < timelineRect.top),
        skipButtonAboveControls: Boolean(controlRowRect && skipButtonRect?.bottom < controlRowRect.top),
      };
    }

    if (${JSON.stringify(page)} === 'startup') {
      const mark = document.querySelector('.mark, main img');
      const markRect = mark?.getBoundingClientRect();
      const bodyText = document.body.innerText;
      return {
        ok: Boolean(mark)
          && document.documentElement.scrollWidth === document.documentElement.clientWidth
          && bodyText.includes('Starting application')
          && (
            bodyText.includes('Preparing TorWatch')
            || bodyText.includes('Checking TMDb')
            || bodyText.includes('Starting playback services')
          ),
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        markVisible: Boolean(markRect && markRect.width > 0 && markRect.height > 0),
        bodyText,
      };
    }

    const chrome = document.querySelector('.window-chrome');
    const header = document.querySelector('header.sticky');
    const icon = document.querySelector('.window-chrome__icon, .window-chrome img');
    if (!chrome || !icon) return { ok: false, error: 'Window chrome or icon was not rendered' };

    const controls = [...(header?.querySelectorAll('button') || [])]
      .filter((button) => button.getBoundingClientRect().width > 0)
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { label: button.getAttribute('aria-label') || button.textContent.trim(), left: rect.left, right: rect.right };
      });
    const chromeRect = chrome.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    const rightmostControl = controls.length ? Math.max(...controls.map((control) => control.right)) : 0;
    const searchDialog = document.querySelector('[role="dialog"]');
    const searchDialogRect = searchDialog?.getBoundingClientRect();
    const searchDialogStyle = searchDialog ? getComputedStyle(searchDialog) : null;
    const setupCopy = ${JSON.stringify(page)} === 'setup' ? document.body.innerText : '';
    const runtimeStatus = [...document.querySelectorAll('[role="alert"], [role="status"]')]
      .find((element) => element.textContent.includes('Playback services could not start'));
    const runtimeStatusRect = runtimeStatus?.getBoundingClientRect();
    const setupCopyIsConsumerFacing = !setupCopy || (
      setupCopy.includes('Application storage location')
      && setupCopy.includes('Start TorWatch')
      && !setupCopy.includes('Application storage' + String.fromCharCode(10) + 'Not checked')
      && !setupCopy.includes('PostgreSQL')
      && !setupCopy.includes('Prowlarr')
      && !setupCopy.includes('Go backend')
    );
    const searchDialogVisible = Boolean(searchDialogRect
      && searchDialogRect.width > 0
      && searchDialogRect.height > 0
      && searchDialogStyle?.visibility !== 'hidden'
      && searchDialogStyle?.display !== 'none'
      && searchDialogStyle?.opacity !== '0');
    return {
      ok: document.documentElement.scrollWidth === document.documentElement.clientWidth
        && chromeRect.height === 40
        && (!headerRect || headerRect.top === 40)
        && icon.complete
        && icon.naturalWidth > 0
        && rightmostControl <= document.documentElement.clientWidth
        && setupCopyIsConsumerFacing
        && (${JSON.stringify(page)} !== 'search' || searchDialogVisible),
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      chromeHeight: chromeRect.height,
      navigationTop: headerRect?.top,
      iconLoaded: icon.complete && icon.naturalWidth > 0,
      rightmostControl,
      searchDialogVisible,
      searchDialogRect: searchDialogRect ? {
        left: searchDialogRect.left,
        top: searchDialogRect.top,
        width: searchDialogRect.width,
        height: searchDialogRect.height,
      } : null,
      searchDialogState: searchDialog?.getAttribute('data-state'),
      searchDialogDisplay: searchDialogStyle?.display,
      searchDialogVisibility: searchDialogStyle?.visibility,
      searchDialogOpacity: searchDialogStyle?.opacity,
      searchDialogZIndex: searchDialogStyle?.zIndex,
      searchDiscoveryVisible: document.body.innerText.includes('Worth a look'),
      runtimeStateVisible: document.body.innerText.includes('Playback services could not start'),
      runtimeStatusRect: runtimeStatusRect ? {
        top: runtimeStatusRect.top,
        left: runtimeStatusRect.left,
        width: runtimeStatusRect.width,
        height: runtimeStatusRect.height,
      } : null,
      electronApiMethods: window.electronAPI ? Object.keys(window.electronAPI) : [],
      runtimeBridgeState: window.electronAPI?.getRuntimeState ? await window.electronAPI.getRuntimeState() : null,
      setupCopyIsConsumerFacing,
      scrollbarColor: getComputedStyle(document.documentElement).scrollbarColor,
      controls,
    };
  })()`);

  const image = await window.webContents.capturePage();
  await require('fs').promises.writeFile(screenshotPath, image.toPNG());
  console.log(`UI_SMOKE=${JSON.stringify({ page, width, height, ...layout, screenshot: screenshotPath })}`);

  window.destroy();
  app.quit();
});
