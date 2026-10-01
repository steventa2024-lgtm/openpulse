import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from 'playwright-core';

/**
 * Renders the brand assets from the SVG sources in assets/brand:
 *   apps/desktop/build/icon.ico + icon.png   — the Windows app icon
 *   assets/brand/app-icon.png                — the app icon for the README
 *   assets/brand/banner.png                  — the README banner (uses the real Chat screenshot)
 *
 *   pnpm --filter @openpulse/web exec tsx scripts/render-brand.ts
 *
 * Needs Microsoft Edge or Google Chrome installed (BROWSER_CHANNEL=chrome to pick Chrome).
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const brandDir = path.join(root, 'assets', 'brand');
const desktopBuild = path.join(root, 'apps', 'desktop', 'build');
const ICO_SIZES = [256, 128, 64, 48, 32, 24, 16];

async function renderSvg(page: Page, svg: string, size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace(
      '<svg ',
      `<svg width="${size}" height="${size}" `,
    )}</body></html>`,
  );
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

/** ICO container holding PNG-compressed images, which Windows Vista and newer read. */
function encodeIco(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries: Buffer[] = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

async function banner(page: Page): Promise<Buffer> {
  const icon = await fs.readFile(path.join(brandDir, 'app-icon.svg'), 'utf8');
  const shot = await fs.readFile(path.join(root, 'apps', 'web', 'public', 'img', 'chat.png'));
  const shotUri = `data:image/png;base64,${shot.toString('base64')}`;
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.setContent(`<!doctype html><html><head><style>
    * { box-sizing: border-box; }
    body {
      margin: 0; width: 1280px; height: 640px; overflow: hidden; color: #e8eaff;
      font-family: 'Segoe UI Variable', 'Segoe UI', system-ui, sans-serif;
      background:
        radial-gradient(520px 360px at 900px 300px, rgb(99 102 241 / 0.35), transparent 65%),
        radial-gradient(420px 300px at 120px 600px, rgb(124 58 237 / 0.28), transparent 65%),
        radial-gradient(360px 240px at 1180px 560px, rgb(34 211 238 / 0.18), transparent 65%),
        #070b1d;
    }
    .copy { position: absolute; left: 80px; top: 150px; width: 520px; }
    .brand { display: flex; align-items: center; gap: 22px; }
    .brand svg { width: 104px; height: 104px; filter: drop-shadow(0 0 24px rgb(99 102 241 / 0.6)); }
    .name { font-size: 76px; font-weight: 700; letter-spacing: -0.03em; }
    .name span { background: linear-gradient(90deg, #60a5fa, #22d3ee); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .tag { margin-top: 34px; font-size: 21px; letter-spacing: 0.32em; text-transform: uppercase; color: #c7cbf2; line-height: 1.7; }
    .sub { margin-top: 26px; font-size: 19px; color: #8f96c8; }
    .sub b { color: #22d3ee; font-weight: 600; }
    .device { position: absolute; left: 660px; top: 120px; width: 700px; perspective: 1400px; }
    .screen { transform: rotateY(-20deg) rotateX(6deg) rotateZ(-2deg); padding: 14px; border-radius: 16px;
      background: linear-gradient(160deg, #20264a, #0b0f24 70%); border: 1px solid rgb(139 124 255 / 0.5);
      box-shadow: 0 0 60px -6px rgb(99 102 241 / 0.75), 0 40px 80px -30px #000; }
    .screen img { display: block; width: 100%; border-radius: 5px; }
    .arc { position: absolute; border-radius: 50%; border: 3px solid transparent;
      filter: drop-shadow(0 0 6px rgb(129 140 248)) drop-shadow(0 0 18px rgb(99 102 241 / 0.8)); }
    .a1 { left: 560px; top: 40px; width: 820px; height: 520px; border-top-color: rgb(96 165 250 / 0.9); border-right-color: rgb(168 85 247 / 0.7); transform: rotate(-16deg); }
    .a2 { left: 640px; top: 150px; width: 700px; height: 420px; border-bottom-color: rgb(168 85 247 / 0.8); border-left-color: rgb(34 211 238 / 0.6); transform: rotate(10deg); }
  </style></head><body>
    <div class="arc a1"></div><div class="arc a2"></div>
    <div class="device"><div class="screen"><img src="${shotUri}" /></div></div>
    <div class="copy">
      <div class="brand">${icon}<div class="name">Open<span>Pulse</span></div></div>
      <div class="tag">Your machine.<br />Your models.<br />Your AI workforce.</div>
      <div class="sub"><b>Local-first AI developer platform</b> · Windows · Open source</div>
    </div>
  </body></html>`);
  await page.waitForTimeout(300);
  return page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 640 } });
}

const browser = await chromium.launch({
  channel: process.env.BROWSER_CHANNEL ?? 'msedge',
  headless: true,
});
try {
  const page = await browser.newPage();
  const appIcon = await fs.readFile(path.join(brandDir, 'app-icon.svg'), 'utf8');

  const pngs = [];
  for (const size of ICO_SIZES) pngs.push({ size, data: await renderSvg(page, appIcon, size) });
  await fs.mkdir(desktopBuild, { recursive: true });
  await fs.writeFile(path.join(desktopBuild, 'icon.ico'), encodeIco(pngs));
  const large = await renderSvg(page, appIcon, 512);
  await fs.writeFile(path.join(desktopBuild, 'icon.png'), large);
  await fs.writeFile(path.join(brandDir, 'app-icon.png'), large);
  console.log(`desktop icon.ico (${ICO_SIZES.join(', ')}) and icon.png, assets/brand/app-icon.png`);

  await fs.writeFile(path.join(brandDir, 'banner.png'), await banner(page));
  console.log('assets/brand/banner.png');
} finally {
  await browser.close();
}
