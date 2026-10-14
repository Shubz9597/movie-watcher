// Windows-only icon generation. Phone branding/build assets are untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = fs.readFileSync(path.join(root, 'src/assets/torwatch-app-icon.png')).toString('base64');
const browser = await puppeteer.launch({ headless: true, pipe: true });
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><html><body></body></html>');
  const icon = async (size) => {
    const data = await page.evaluate(async ({ source, size }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${source}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      const context = canvas.getContext('2d');
      context.fillStyle = '#0a0a0a';
      context.fillRect(0, 0, size, size);
      const scale = Math.min(size * 0.78 / image.width, size * 0.78 / image.height);
      const width = image.width * scale;
      const height = image.height * scale;
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
      return canvas.toDataURL('image/png').split(',')[1];
    }, { source, size });
    return Buffer.from(data, 'base64');
  };
  const directory = path.join(root, 'build', 'torwatch-icons');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(root, 'build', 'torwatch-icon.png'), await icon(256));
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
  fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([header, ...frames]));
  console.log('Generated Windows icons; mobile assets were not written.');
} finally { await browser.close(); }
