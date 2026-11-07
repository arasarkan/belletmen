#!/usr/bin/env node
/*
 * Eklenti ikonlarını (PNG) bağımlılıksız üretir: lacivert yuvarlak kare
 * üzerinde beyaz onay işareti. Çalıştır: npm run icons
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const BG = [28, 28, 30];    // #1c1c1e
const FG = [255, 255, 255];

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const p = pixel(x, y);
      raw.set(p, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))
  ]);
}

// İşaretli uzaklık fonksiyonları (birim kare koordinatlarında)
function sdRoundRect(x, y, half, r) {
  const qx = Math.abs(x) - half + r, qy = Math.abs(y) - half + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}
function sdSegment(px, py, ax, ay, bx, by) {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay)));
  return Math.hypot(pax - bax * h, pay - bay * h);
}

function render(size) {
  const S = 4; // süper örnekleme
  return png(size, (x, y) => {
    let bg = 0, fg = 0;
    for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
      const u = ((x + (i + 0.5) / S) / size) * 2 - 1;
      const v = ((y + (j + 0.5) / S) / size) * 2 - 1;
      if (sdRoundRect(u, v, 0.96, 0.44) <= 0) {
        bg++;
        const w = 0.12;
        const d = Math.min(sdSegment(u, v, -0.48, 0.02, -0.14, 0.38), sdSegment(u, v, -0.14, 0.38, 0.5, -0.36));
        if (d <= w) fg++;
      }
    }
    const n = S * S;
    const a = bg / n, f = bg ? fg / bg : 0;
    const c = BG.map((b, k) => Math.round(b * (1 - f) + FG[k] * f));
    return [c[0], c[1], c[2], Math.round(a * 255)];
  });
}

const out = path.join(__dirname, '..', 'extension', 'icons');
fs.mkdirSync(out, { recursive: true });
for (const s of [16, 32, 48, 128]) {
  fs.writeFileSync(path.join(out, `icon${s}.png`), render(s));
  console.log(`icon${s}.png`);
}
