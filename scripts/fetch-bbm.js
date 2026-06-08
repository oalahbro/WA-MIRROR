"use strict";
// Unduh 200 emoticon BBM (set 2018) ke public/bbm/bNNN.png untuk dipakai sebagai
// emoji kustom di mirror (kosmetik lokal). Idempoten: melewati file yang sudah ada.
// Jalankan: node scripts/fetch-bbm.js   (perlu Node 18+ untuk global fetch)
// Catatan: gambar BBM hak cipta BlackBerry — dipakai pribadi, TIDAK di-commit (lihat .gitignore).
const fs = require("fs");
const path = require("path");

const dir = path.resolve(__dirname, "../public/bbm");
fs.mkdirSync(dir, { recursive: true });
const BASE = "http://emoji.digital/bbm/emoticon/emoticon_";
const COUNT = 200;

(async () => {
  let ok = 0, skip = 0, fail = 0;
  for (let i = 1; i <= COUNT; i++) {
    const n = String(i).padStart(3, "0");
    const dest = path.join(dir, "b" + n + ".png");
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { skip++; ok++; continue; }
    try {
      const r = await fetch(BASE + n + ".png");
      if (!r.ok) throw new Error("HTTP " + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Error("kosong");
      fs.writeFileSync(dest, buf);
      ok++;
    } catch (e) { fail++; console.error("gagal b" + n + ":", e.message); }
  }
  console.log(`selesai → ${ok}/${COUNT} ok (skip ${skip}), gagal ${fail}. folder: ${dir}`);
})();
