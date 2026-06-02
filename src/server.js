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
app.get("/api/login", (req, res) => {
  const token = req.query.token || req.get("x-auth-token");
  res.json({ ok: token === AUTH_TOKEN });
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

app.post("/api/send", requireAuth, async (req, res) => {
  const { jid, text, quotedId } = req.body || {};
  if (!jid || !text) return res.status(400).json({ error: "jid & text wajib" });
  try {
    const id = await wa.sendMessage(jid, text, quotedId);
    res.json({ ok: true, id });
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
      const id = await wa.sendMedia(jid, kind, req.body, mimetype, caption, quotedId, fileName);
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
