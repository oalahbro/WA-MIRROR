"use strict";
// Muat .env sederhana tanpa dependency tambahan
require("./loadenv");

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const store = require("./db");
const wa = require("./wa");

const PORT = parseInt(process.env.PORT, 10) || 8088;
// Alamat bind. Default 0.0.0.0 (semua interface) untuk lokal.
// Di VPS dgn akses via SSH tunnel, set HOST=127.0.0.1 agar port hanya di loopback
// (tidak terjangkau dari internet sama sekali).
const HOST = process.env.HOST || "0.0.0.0";

// Folder cache media (foto/video) yang sudah di-download.
const MEDIA_DIR = path.resolve(__dirname, "../data/media");
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const safeName = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

// Folder stiker favorit (WebP). Disimpan dengan nama = hash isi (dedupe stiker identik).
const STICKER_DIR = path.resolve(__dirname, "../data/stickers");
fs.mkdirSync(STICKER_DIR, { recursive: true });
const stickerFile = (hash) => path.join(STICKER_DIR, safeName(hash) + ".webp");

// Retensi media chat: file cache media (foto/video/dokumen/stiker) untuk pesan yang umurnya
// > N hari dihapus dari disk + kolom `raw` dikosongkan (hemat ruang; media WA juga sudah
// kedaluwarsa di server). TIDAK menyentuh stiker favorit (data/stickers) maupun avatar.
// MEDIA_RETENTION_DAYS di .env mengatur ambang (default 30; set 0 untuk mematikan).
const MEDIA_RETENTION_DAYS = Number(process.env.MEDIA_RETENTION_DAYS ?? 30);
async function cleanupOldMedia() {
  if (!(MEDIA_RETENTION_DAYS > 0)) return { filesDeleted: 0, rawsCleared: 0, disabled: true };
  const cutoff = Math.floor(Date.now() / 1000) - MEDIA_RETENTION_DAYS * 86400;
  let filesDeleted = 0, rawsCleared = 0;
  try {
    // file dinamai safeName(id); cocokkan ke set id media lama (sudah di-safeName).
    const oldSet = new Set(store.oldMediaIds(cutoff).map(safeName));
    let files = [];
    try { files = await fs.promises.readdir(MEDIA_DIR); } catch (e) { /* folder belum ada */ }
    for (const f of files) {
      if (oldSet.has(f)) {
        try { await fs.promises.unlink(path.join(MEDIA_DIR, f)); filesDeleted++; } catch (e) {}
      }
    }
    rawsCleared = store.clearOldRaw(cutoff);
  } catch (e) {
    console.error("[cleanup] media gagal:", e.message);
  }
  if (filesDeleted || rawsCleared) {
    console.log(`[cleanup] media >${MEDIA_RETENTION_DAYS}h: ${filesDeleted} file dihapus, ${rawsCleared} raw dibersihkan`);
  }
  return { filesDeleted, rawsCleared };
}

// Folder cache foto profil (avatar). TTL disk 30 hari; negative-cache (jid tanpa foto)
// 6 jam agar tidak terus memanggil WA. Fetch ke WA dibatasi konkurensinya (anti ban).
const AVATAR_DIR = path.resolve(__dirname, "../data/avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_TTL = 30 * 24 * 3600 * 1000;
const AVATAR_NEG_TTL = 6 * 3600 * 1000;
const noAvatar = new Map();           // jid -> epoch ms kedaluwarsa entry negatif
// PNG transparan 1x1 untuk kasus "tanpa foto/privasi": dikirim 200 (BUKAN 404) supaya
// <img> tidak memunculkan error 404 di console browser. Frontend mendeteksi sentinel ini
// via naturalWidth<=1 → sembunyikan img, inisial tetap tampil.
const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);
function sendNoAvatar(res) {
  res.type("image/png");
  res.setHeader("Cache-Control", "private, max-age=21600"); // 6 jam (samakan dgn negative-cache)
  res.send(BLANK_PNG);
}
let avActive = 0;
const avQueue = [];
const AV_MAX = 3;                     // maksimal fetch avatar paralel ke WA
function avPump() {
  if (avActive >= AV_MAX || !avQueue.length) return;
  const { task, resolve } = avQueue.shift();
  avActive++;
  Promise.resolve().then(task).then(
    (v) => { avActive--; resolve(v); avPump(); },
    () => { avActive--; resolve(null); avPump(); }
  );
}
function avRun(task) { return new Promise((resolve) => { avQueue.push({ task, resolve }); avPump(); }); }

// Tebak mimetype dokumen/arsip dari ekstensi bila browser tak menyertakannya.
const EXT_MIME = {
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", rtf: "application/rtf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  zip: "application/zip", rar: "application/vnd.rar", "7z": "application/x-7z-compressed",
  tar: "application/x-tar", gz: "application/gzip", tgz: "application/gzip", bz2: "application/x-bzip2",
};
function guessMime(fileName, fallback) {
  const ext = String(fileName || "").split(".").pop().toLowerCase();
  return EXT_MIME[ext] || fallback || "application/octet-stream";
}
// Header untuk menyajikan media; dokumen dipaksa diunduh (attachment + nama berkas).
function setMediaHeaders(res, info, mime) {
  res.type(mime || (info && info.media_mime) || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=86400");
  if (info && info.type === "document") {
    const fn = (info.file_name || "dokumen").replace(/["\r\n]/g, "_");
    res.setHeader("Content-Disposition",
      `attachment; filename="${fn}"; filename*=UTF-8''${encodeURIComponent(fn)}`);
  }
}

if (!AUTH_TOKEN || AUTH_TOKEN === "ganti-dengan-token-rahasia-panjang") {
  console.error("FATAL: AUTH_TOKEN belum diset di .env. Lihat .env.example.");
  process.exit(1);
}

const app = express();
app.use(express.json());

// ---------- header keamanan ----------
// Diterapkan ke semua respons. CSP disetel agar fitur tetap jalan: QR (data:),
// thumbnail base64 (data:), media/bubble optimistik (blob:), /api/media (self),
// dan warna swatch inline (style 'unsafe-inline').
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");                 // anti-clickjacking
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  res.setHeader("Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; " +
    "base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  next();
});

// ---------- rate-limit login (anti brute-force, tanpa dependency) ----------
// Hanya percobaan GAGAL yang dihitung (global, jendela 60 dtk). Token benar tak
// pernah kena limit, jadi polling normal & login sah aman. Lewat ambang → 429.
const failedLogins = [];
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_FAIL = 15;
function loginLimiter(req, res, next) {
  const now = Date.now();
  while (failedLogins.length && now - failedLogins[0] > LOGIN_WINDOW_MS) failedLogins.shift();
  if (failedLogins.length >= LOGIN_MAX_FAIL) {
    return res.status(429).json({ ok: false, error: "terlalu banyak percobaan, coba lagi sebentar" });
  }
  next();
}

// ---------- auth middleware ----------
function requireAuth(req, res, next) {
  const token =
    req.get("x-auth-token") ||
    (req.get("authorization") || "").replace(/^Bearer\s+/i, "") ||
    req.query.token;
  if (token !== AUTH_TOKEN) return res.status(401).json({ error: "unauthorized" });
  next();
}

// ---------- API ----------
app.get("/api/login", loginLimiter, (req, res) => {
  const token = req.query.token || req.get("x-auth-token");
  const okToken = token === AUTH_TOKEN;
  if (!okToken) failedLogins.push(Date.now()); // catat hanya yang gagal
  res.json({ ok: okToken });
});

app.get("/api/status", requireAuth, (req, res) => {
  res.json({ ...wa.getStatus(), stats: store.stats() });
});

app.get("/api/chats", requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const before = parseInt(req.query.before, 10);
  // ?before=<epoch> -> halaman chat lebih lama (infinite scroll sidebar)
  if (before > 0) return res.json(store.getChatsBefore(before, Math.min(limit, 200)));
  res.json(store.getChats(limit));
});

// Cari chat by NAMA lintas semua chat (untuk nemu chat lama yang belum ke-load di sidebar).
app.get("/api/chats/search", requireAuth, (req, res) => {
  res.json(store.searchChats(req.query.q || "", 50));
});

// Pesan terbaru -> lama. ?before=<epoch> untuk load yang lebih lama (scroll ke atas).
// ?after=<epoch> untuk load yang lebih BARU (scroll ke bawah saat loncat ke pesan lama).
app.get("/api/messages", requireAuth, (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const after = parseInt(req.query.after, 10) || 0;
  if (after) return res.json(store.getMessagesNewer(jid, after, limit));
  const before = parseInt(req.query.before, 10) || 0;
  res.json(store.getMessages(jid, before, limit));
});

// Cari ISI pesan lintas chat. ?q=<kata> (min 2 huruf), ?limit=.
app.get("/api/search", requireAuth, (req, res) => {
  const q = req.query.q || "";
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 100);
  res.json(store.searchMessages(q, limit));
});

// Cek nomor terdaftar di WhatsApp (untuk "chat baru"). ?num=628xxx → { exists, jid }.
app.get("/api/check-number", requireAuth, async (req, res) => {
  const num = req.query.num;
  if (!num) return res.status(400).json({ error: "num wajib" });
  try { res.json(await wa.checkNumber(num)); }
  catch (e) { res.json({ exists: false, error: e.message }); }
});

// Daftar anggota grup (untuk autocomplete @mention). ?jid=<grup@g.us> → [{ id, num, name, admin }].
app.get("/api/group-members", requireAuth, async (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  try { res.json(await wa.getGroupMembers(jid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Resolve jid @lid (anggota grup) → nomor asli @s.whatsapp.net. { jid: "" } bila tak ada mapping.
app.get("/api/resolve-jid", requireAuth, async (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  try { res.json({ jid: (await wa.resolveLidToPn(jid)) || "" }); }
  catch (e) { res.json({ jid: "" }); }
});

// Tandai chat sudah dibaca (hapus unread). Body: { jid }
app.post("/api/read", requireAuth, (req, res) => {
  const { jid } = req.body || {};
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  store.markRead(jid);
  res.json({ ok: true });
});

// Pin / lepas pin chat (lokal). Body: { jid, pinned: bool }
app.post("/api/pin", requireAuth, (req, res) => {
  const { jid, pinned } = req.body || {};
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  store.setPin(jid, !!pinned);
  res.json({ ok: true });
});

// Media resolusi penuh. Token boleh lewat query (?token=) agar bisa dipakai di src <img>/<video>.
app.get("/api/media", requireAuth, async (req, res) => {
  const { jid, id } = req.query;
  if (!jid || !id) return res.status(400).json({ error: "jid & id wajib" });

  const info = store.getMediaInfo(jid, id);
  const cacheFile = path.join(MEDIA_DIR, safeName(id));

  // Sajikan dari cache disk bila ada.
  if (fs.existsSync(cacheFile)) {
    setMediaHeaders(res, info, info && info.media_mime);
    return fs.createReadStream(cacheFile).pipe(res);
  }

  try {
    const result = await wa.downloadMedia(jid, id);
    if (!result || !result.buffer) {
      return res.status(404).json({ error: "media tidak tersedia (mungkin sudah kedaluwarsa)" });
    }
    fs.writeFile(cacheFile, result.buffer, () => {}); // cache async, abaikan error tulis
    setMediaHeaders(res, info, result.mimetype || (info && info.media_mime));
    res.send(result.buffer);
  } catch (e) {
    res.status(502).json({ error: "gagal mengambil media: " + e.message });
  }
});

// Foto profil (avatar) kontak/grup. Token boleh via query (dipakai di <img src>).
// Urutan: cache disk segar → negative-cache → fetch ke WA (terbatas konkurensi) → cache.
// 404 = tak ada foto/privasi (frontend jatuh ke inisial).
app.get("/api/avatar", requireAuth, async (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  const file = path.join(AVATAR_DIR, safeName(jid) + ".jpg");

  // 1) cache disk masih segar
  try {
    const st = fs.statSync(file);
    if (Date.now() - st.mtimeMs < AVATAR_TTL) {
      res.type("image/jpeg");
      res.setHeader("Cache-Control", "private, max-age=86400");
      return fs.createReadStream(file).pipe(res);
    }
  } catch (e) { /* belum ada cache */ }

  // 2) negative-cache: diketahui tak ada foto → kirim sentinel cepat tanpa panggil WA
  const neg = noAvatar.get(jid);
  if (neg && neg > Date.now()) return sendNoAvatar(res);

  // 3) ambil dari WA (dibatasi AV_MAX paralel)
  const buf = await avRun(async () => {
    const url = await wa.getAvatarUrl(jid);
    if (!url) return null;
    const r = await fetch(url);
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  });
  if (!buf || !buf.length) {
    noAvatar.set(jid, Date.now() + AVATAR_NEG_TTL);
    return sendNoAvatar(res);
  }
  fs.writeFile(file, buf, () => {});
  res.type("image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(buf);
});

app.post("/api/send", requireAuth, async (req, res) => {
  const { jid, text, quotedId, quotedJid, mentions } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: "jid & text wajib" });
  try {
    const ment = Array.isArray(mentions) ? mentions.filter((m) => typeof m === "string" && m) : undefined;
    const id = await wa.sendMessage(jid, text, quotedId, quotedJid, ment);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Edit pesan sendiri. Body: { jid, id, text }
app.post("/api/edit", requireAuth, async (req, res) => {
  const { jid, id, text } = req.body || {};
  if (!jid || !id || !text) return res.status(400).json({ error: "jid, id, text wajib" });
  try {
    await wa.editMessage(jid, id, text);
    store.editMessageText(jid, id, text); // langsung sinkron di DB (echo edit juga akan update, idempoten)
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Hapus pesan SENDIRI untuk semua (delete-for-everyone). Body: { jid, id }
// wa.deleteMessage sekaligus markDeleted di DB; echo REVOKE yang masuk idempoten.
app.post("/api/delete", requireAuth, async (req, res) => {
  const { jid, id } = req.body || {};
  if (!jid || !id) return res.status(400).json({ error: "jid, id wajib" });
  try {
    await wa.deleteMessage(jid, id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reaksi emoji pada pesan. Body: { jid, id, emoji } (emoji "" = lepas reaksi).
app.post("/api/react", requireAuth, async (req, res) => {
  const { jid, id, emoji } = req.body || {};
  if (!jid || !id) return res.status(400).json({ error: "jid, id wajib" });
  try {
    await wa.sendReaction(jid, id, typeof emoji === "string" ? emoji : "");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Info kontak / grup (panel detail). ?jid= → { type, ... }.
app.get("/api/chat-info", requireAuth, async (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  try { res.json(await wa.getChatInfo(jid)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Kirim media (foto/video). Body = biner mentah file; metadata via query.
const MAX_MEDIA = 64 * 1024 * 1024; // 64 MB
app.post(
  "/api/send-media",
  requireAuth,
  express.raw({ type: "*/*", limit: MAX_MEDIA }),
  async (req, res) => {
    const jid = req.query.jid;
    const kind = req.query.kind; // "image" | "video" | "document"
    const caption = req.query.caption || "";
    const quotedId = req.query.quotedId || "";
    const quotedJid = req.query.quotedJid || "";
    const fileName = req.query.fileName || "";
    // mentions = jid anggota yang di-tag di caption, dipisah koma.
    const mentions = String(req.query.mentions || "").split(",").map((s) => s.trim()).filter(Boolean);
    let mimetype = req.get("content-type") || "";
    // Dokumen: pastikan mimetype masuk akal (browser sering kirim octet-stream/kosong).
    if (kind === "document" && (!mimetype || mimetype === "application/octet-stream")) {
      mimetype = guessMime(fileName, mimetype);
    }
    if (!jid || !kind) return res.status(400).json({ error: "jid & kind wajib" });
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "file kosong" });
    }
    try {
      const id = await wa.sendMedia(jid, kind, req.body, mimetype, caption, quotedId, fileName, quotedJid, mentions);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ---------- stiker favorit ----------
// Simpan stiker yang masuk ke favorit. Body { jid, id } → download WebP → hash → tulis file.
app.post("/api/sticker/save", requireAuth, async (req, res) => {
  const { jid, id } = req.body || {};
  if (!jid || !id) return res.status(400).json({ error: "jid & id wajib" });
  try {
    const result = await wa.downloadMedia(jid, id);
    if (!result || !result.buffer || !result.buffer.length) {
      return res.status(404).json({ error: "stiker tidak tersedia (mungkin sudah kedaluwarsa)" });
    }
    const hash = crypto.createHash("sha256").update(result.buffer).digest("hex").slice(0, 24);
    fs.writeFileSync(stickerFile(hash), result.buffer);
    res.json({ ok: true, hash });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Daftar stiker favorit (hash + waktu simpan), terbaru dulu.
app.get("/api/stickers", requireAuth, (req, res) => {
  let files;
  try { files = fs.readdirSync(STICKER_DIR).filter((f) => f.endsWith(".webp")); } catch (e) { files = []; }
  const list = files.map((f) => {
    const hash = f.replace(/\.webp$/, "");
    let at = 0;
    try { at = fs.statSync(path.join(STICKER_DIR, f)).mtimeMs; } catch (e) {}
    return { hash, at };
  }).sort((a, b) => b.at - a.at);
  res.json(list);
});

// Sajikan WebP stiker favorit. ?hash= (token boleh via query agar bisa dipakai di <img src>).
app.get("/api/sticker", requireAuth, (req, res) => {
  const hash = req.query.hash;
  if (!hash) return res.status(400).json({ error: "hash wajib" });
  const file = stickerFile(hash);
  if (!fs.existsSync(file)) return res.status(404).end();
  res.type("image/webp");
  res.setHeader("Cache-Control", "private, max-age=604800"); // 7 hari (isi stiker tetap = hash)
  fs.createReadStream(file).pipe(res);
});

// Hapus stiker favorit. Body { hash }.
app.post("/api/sticker/remove", requireAuth, (req, res) => {
  const { hash } = req.body || {};
  if (!hash) return res.status(400).json({ error: "hash wajib" });
  try { fs.unlinkSync(stickerFile(hash)); } catch (e) { /* sudah tak ada */ }
  res.json({ ok: true });
});

// Kirim stiker favorit ke sebuah chat. Body { jid, hash, quotedId, quotedJid }.
app.post("/api/sticker/send", requireAuth, async (req, res) => {
  const { jid, hash, quotedId, quotedJid } = req.body || {};
  if (!jid || !hash) return res.status(400).json({ error: "jid & hash wajib" });
  const file = stickerFile(hash);
  if (!fs.existsSync(file)) return res.status(404).json({ error: "stiker tidak ada" });
  try {
    const buf = fs.readFileSync(file);
    const id = await wa.sendSticker(jid, buf, quotedId, quotedJid);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Jalankan bersih-bersih media lama sekarang (manual). Return jumlah yang dibersihkan.
app.post("/api/cleanup", requireAuth, async (req, res) => {
  try { res.json({ ok: true, ...(await cleanupOldMedia()) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- static UI ----------
app.use(express.static(path.resolve(__dirname, "../public")));

app.listen(PORT, HOST, () => {
  console.log(`[server] UI + API jalan di http://${HOST}:${PORT}`);
});

// ---------- start WhatsApp ----------
wa.start().catch((e) => console.error("[wa] gagal start:", e.message));

// ---------- bersih-bersih media lama (otomatis) ----------
// 20 dtk setelah boot (jangan ganggu sinkronisasi awal), lalu tiap 24 jam.
setTimeout(() => cleanupOldMedia().catch(() => {}), 20000);
const cleanupTimer = setInterval(() => cleanupOldMedia().catch(() => {}), 24 * 3600 * 1000);
if (cleanupTimer.unref) cleanupTimer.unref();
