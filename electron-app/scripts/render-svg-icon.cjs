const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const input = path.resolve(process.argv[2] || '');
const output = path.resolve(process.argv[3] || '');
const size = Math.max(16, Number(process.argv[4]) || 1024);

if (!input || !output || !fs.existsSync(input)) {
  console.error('Usage: electron scripts/render-svg-icon.cjs <input.svg> <output.png> [size]');
  process.exit(1);
}

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
  });

  await window.loadFile(input);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, image.toPNG());
  window.destroy();
  app.quit();
});
