// Package the app icon artwork at native icon/splash sizes.
// Source: src/assets/torwatch-app-icon.png — the user-generated retro-TV mark,
// already background-removed, trimmed and centered on a transparent square
// (produced from icon-clean.png). It is designed to read directly on the
// black identity background: no invert/opacity treatment.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'src/assets/torwatch-app-icon.png')).toString('base64');
const browser = await puppeteer.launch({ headless: true, pipe: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  const render = async (width, height, markWidth, markHeight, background = true, round = false) => {
    const data = await page.evaluate(async (opts) => {
      const img = new Image();
      img.src = `data:image/png;base64,${opts.source}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = opts.width;
      canvas.height = opts.height;
      const ctx = canvas.getContext('2d');
      if (opts.background) {
        ctx.fillStyle = '#0a0a0a';
        if (opts.round) {
          ctx.beginPath();
          ctx.arc(opts.width / 2, opts.height / 2, opts.width / 2, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(0, 0, opts.width, opts.height);
      }
      const scale = Math.min(opts.markWidth / img.width, opts.markHeight / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      ctx.drawImage(img, (opts.width - w) / 2, (opts.height - h) / 2, w, h);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, width, height, markWidth, markHeight, background, round });
    return Buffer.from(data, 'base64');
  };
  const write = (relative, data) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
  };
  const icon = (size, round = false) => render(size, size, size * 0.78, size * 0.78, true, round);
  write('src/assets/torwatch-app-icon-512.png', await icon(512));
  write('build/torwatch-icon.png', await icon(256));
  // Canvas exports RGBA even after painting an opaque background. Encode the
  // iOS app icon explicitly as RGB; splash and adaptive assets retain alpha.
  const iosIcon = PNG.sync.write(PNG.sync.read(await icon(1024)), { colorType: 2 });
  // PNG IHDR byte 25 is the color type: 2 = RGB without an alpha channel.
  if (iosIcon[25] !== 2) throw new Error('The iOS app icon must be exported as an RGB PNG without alpha.');
  write('ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png', iosIcon);

  // ICO entries contain PNG payloads at every Windows shell size.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const size of sizes) frames.push(await icon(size));
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  write('build/torwatch-icons/icon.ico', Buffer.concat([header, ...frames]));

  const res = 'android/app/src/main/res';
  for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
    const size = 48 * scale;
    write(`${res}/mipmap-${density}/ic_launcher.png`, await icon(size));
    write(`${res}/mipmap-${density}/ic_launcher_round.png`, await icon(size, true));
    // Keep the whole square mark inside Android's 66dp adaptive safe zone.
    write(`${res}/mipmap-${density}/ic_launcher_foreground.png`, await render(108 * scale, 108 * scale, 62 * scale, 62 * scale, false));
  }
  // Android's system splash uses a 288dp canvas with a centered square mark.
  write(`${res}/drawable-nodpi/torwatch_splash_mark.png`, await render(1152, 1152, 512, 512, false));
  for (const dir of fs.readdirSync(path.join(root, res))) {
    const relative = `${res}/${dir}/splash.png`;
    if (!fs.existsSync(path.join(root, relative))) continue;
    const png = fs.readFileSync(path.join(root, relative));
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const density = dir.split('-').at(-1);
    const scale = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }[density] ?? 1;
    write(relative, await render(width, height, 80 * scale, 80 * scale));
  }
  for (const [name, scale] of [['splash-2732x2732-2.png', 1], ['splash-2732x2732-1.png', 2], ['splash-2732x2732.png', 3]]) {
    write(`ios/App/App/Assets.xcassets/Splash.imageset/${name}`, await render(80 * scale, 80 * scale, 80 * scale, 80 * scale, false));
  }
  console.log('Generated TorWatch app icons and native splash assets from the app icon.');
} finally {
  await browser.close();
}
