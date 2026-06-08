"use strict";
// Bikin ikon PNG dari logo (untuk apple-touch-icon iOS + manifest Android/Chrome).
// Full-bleed (hijau penuh tanpa rounded) — iOS/Android menerapkan mask sudut sendiri.
// Jalankan: node scripts/gen-icons.js
const sharp = require("sharp");
const path = require("path");
const pub = path.resolve(__dirname, "../public");

const SVG = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="512" height="512">
  <rect width="64" height="64" fill="#25d366"/>
  <path d="M32 14c-10.5 0-19 7.6-19 17 0 3.5 1.2 6.7 3.2 9.4L13 50l10-3.1c2.7 1.4 5.8 2.1 9 2.1 10.5 0 19-7.6 19-17S42.5 14 32 14z" fill="#fff"/>
  <path d="M22.5 31.5l4 4 7-8" fill="none" stroke="#25d366" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M30 31.5l4 4 7-8" fill="none" stroke="#128c4a" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`);

const targets = [
  { file: "apple-touch-icon.png", size: 180 },
  { file: "icon-192.png", size: 192 },
  { file: "icon-512.png", size: 512 },
];

(async () => {
  for (const t of targets) {
    await sharp(SVG).resize(t.size, t.size).png().toFile(path.join(pub, t.file));
    console.log("ok →", t.file, t.size + "px");
  }
})();
