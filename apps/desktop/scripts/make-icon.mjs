#!/usr/bin/env node
/**
 * Draws the OpenPulse application icon and writes build/icon.ico (PNG-compressed entries, which
 * Windows Vista and newer read) plus build/icon.png for the installer and the website.
 *
 * Rendering is done by hand into an RGBA buffer so the build needs no image toolchain.
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'build');
const SIZES = [256, 128, 64, 48, 32, 16];

const CORAL = [245, 101, 74];
const CORAL_DEEP = [199, 74, 52];
const LIGHT = [255, 236, 230];

/** Rounded-square mark with a pulse trace through it. */
function draw(size) {
  const pixels = Buffer.alloc(size * size * 4, 0);
  const scale = size / 256;
  const radius = 56 * scale;
  const inset = 8 * scale;
  const box = { x0: inset, y0: inset, x1: size - inset, y1: size - inset };

  // Body: rounded square with a diagonal coral gradient, anti-aliased at the edge.
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = roundedRectDistance(x + 0.5, y + 0.5, box, radius);
      const coverage = clamp(0.5 - distance, 0, 1);
      if (coverage <= 0) continue;
      const t = clamp((x / size) * 0.6 + (y / size) * 0.6, 0, 1);
      const colour = mix(CORAL, CORAL_DEEP, t);
      setPixel(pixels, size, x, y, colour, coverage);
    }
  }

  // Pulse trace: flat, spike up, spike down, flat — drawn as anti-aliased segments.
  const points = [
    [0.16, 0.54],
    [0.34, 0.54],
    [0.44, 0.3],
    [0.56, 0.72],
    [0.66, 0.46],
    [0.84, 0.46],
  ].map(([px, py]) => [px * size, py * size]);
  const stroke = Math.max(1.6, 18 * scale);
  for (let i = 0; i < points.length - 1; i += 1) {
    drawSegment(pixels, size, points[i], points[i + 1], stroke, LIGHT);
  }
  return pixels;
}

function drawSegment(pixels, size, a, b, width, colour) {
  const half = width / 2;
  const minX = Math.max(0, Math.floor(Math.min(a[0], b[0]) - width));
  const maxX = Math.min(size - 1, Math.ceil(Math.max(a[0], b[0]) + width));
  const minY = Math.max(0, Math.floor(Math.min(a[1], b[1]) - width));
  const maxY = Math.min(size - 1, Math.ceil(Math.max(a[1], b[1]) + width));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = segmentDistance(x + 0.5, y + 0.5, a, b);
      const coverage = clamp(half + 0.5 - distance, 0, 1);
      if (coverage > 0) setPixel(pixels, size, x, y, colour, coverage);
    }
  }
}

function setPixel(pixels, size, x, y, colour, alpha) {
  const index = (y * size + x) * 4;
  const existing = pixels[index + 3] / 255;
  const out = alpha + existing * (1 - alpha);
  if (out <= 0) return;
  for (let c = 0; c < 3; c += 1) {
    const src = colour[c];
    const dst = pixels[index + c];
    pixels[index + c] = Math.round((src * alpha + dst * existing * (1 - alpha)) / out);
  }
  pixels[index + 3] = Math.round(out * 255);
}

function roundedRectDistance(x, y, box, radius) {
  const halfW = (box.x1 - box.x0) / 2;
  const halfH = (box.y1 - box.y0) / 2;
  const cx = box.x0 + halfW;
  const cy = box.y0 + halfH;
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

function segmentDistance(x, y, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = x - a[0];
  const wy = y - a[1];
  const lengthSq = vx * vx + vy * vy;
  const t = lengthSq === 0 ? 0 : clamp((wx * vx + wy * vy) / lengthSq, 0, 1);
  return Math.hypot(wx - t * vx, wy - t * vy);
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// ---- encoders -----------------------------------------------------------------------------------

/** Minimal PNG encoder: one IHDR/IDAT/IEND, RGBA, filter type 0 per row. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([length, body, crc]);
}

let CRC_TABLE;
function crc32(buffer) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

/** ICO container holding PNG-compressed images. */
function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const { size, data } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

// ---- run ----------------------------------------------------------------------------------------

await mkdir(outDir, { recursive: true });

const pngs = SIZES.map((size) => ({ size, data: encodePng(size, size, draw(size)) }));
await writeFile(path.join(outDir, 'icon.ico'), encodeIco(pngs));
await writeFile(path.join(outDir, 'icon.png'), pngs[0].data);

process.stdout.write(`desktop: icon.ico (${SIZES.join(', ')}) and icon.png written to build/\n`);
