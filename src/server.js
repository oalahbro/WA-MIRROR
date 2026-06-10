"use strict";
// Muat .env sederhana tanpa dependency tambahan
require("./loadenv");

const express = require("express");
const path = require("path");
const fs = require("fs");
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

// Folder cache foto profil (avatar). TTL disk 30 hari; negative-cache (jid tanpa foto)
// 6 jam agar tidak terus memanggil WA. Fetch ke WA dibatasi konkurensinya (anti ban).
const AVATAR_DIR = path.resolve(__dirname, "../data/avatars");
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_TTL = 30 * 24 * 3600 * 1000;
const AVATAR_NEG_TTL = 6 * 3600 * 1000;
const noAvatar = new Map();           // jid -> epoch ms kedaluwarsa entry negatif
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
  res.json(store.getChats(limit));
});

// Pesan terbaru -> lama. ?before=<epoch> untuk load yang lebih lama (scroll ke atas).
app.get("/api/messages", requireAuth, (req, res) => {
  const jid = req.query.jid;
  if (!jid) return res.status(400).json({ error: "jid wajib" });
  const before = parseInt(req.query.before, 10) || 0;
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
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

  // 2) negative-cache: diketahui tak ada foto → 404 cepat tanpa panggil WA
  const neg = noAvatar.get(jid);
  if (neg && neg > Date.now()) return res.status(404).end();

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
    return res.status(404).end();
  }
  fs.writeFile(file, buf, () => {});
  res.type("image/jpeg");
  res.setHeader("Cache-Control", "private, max-age=86400");
  res.send(buf);
});

app.post("/api/send", requireAuth, async (req, res) => {
  const { jid, text, quotedId, quotedJid } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: "jid & text wajib" });
  try {
    const id = await wa.sendMessage(jid, text, quotedId, quotedJid);
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
      const id = await wa.sendMedia(jid, kind, req.body, mimetype, caption, quotedId, fileName, quotedJid);
      res.json({ ok: true, id });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ---------- static UI ----------
app.use(express.static(path.resolve(__dirname, "../public")));

app.listen(PORT, HOST, () => {
  console.log(`[server] UI + API jalan di http://${HOST}:${PORT}`);
});

// ---------- start WhatsApp ----------
wa.start().catch((e) => console.error("[wa] gagal start:", e.message));
