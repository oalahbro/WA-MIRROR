"use strict";
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_PATH = process.env.DB_PATH
  ? path.resolve(process.env.DB_PATH)
  : path.resolve(__dirname, "../data/wa.db");

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  jid               TEXT PRIMARY KEY,
  name              TEXT DEFAULT '',
  is_group          INTEGER DEFAULT 0,
  last_message_time INTEGER DEFAULT 0,
  last_text         TEXT DEFAULT '',
  unread            INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  chat_jid  TEXT NOT NULL,
  id        TEXT NOT NULL,
  sender    TEXT DEFAULT '',
  from_me   INTEGER DEFAULT 0,
  text      TEXT DEFAULT '',
  type      TEXT DEFAULT 'text',
  timestamp INTEGER DEFAULT 0,
  PRIMARY KEY (chat_jid, id)
);
CREATE INDEX IF NOT EXISTS idx_msg_chat_time ON messages(chat_jid, timestamp DESC);

CREATE TABLE IF NOT EXISTS contacts (
  jid  TEXT PRIMARY KEY,
  name TEXT DEFAULT ''
);
`);

// Migrasi additif — kolom media + kutipan (reply). Abaikan error jika kolom sudah ada.
for (const col of [
  "thumb TEXT DEFAULT ''", "media_mime TEXT DEFAULT ''",
  "quoted_id TEXT DEFAULT ''", "quoted_text TEXT DEFAULT ''", "quoted_sender TEXT DEFAULT ''",
  "raw TEXT DEFAULT ''", // WebMessageInfo terenkode (base64) utk download media lintas-restart
  "mentioned INTEGER DEFAULT 0", // 1 bila pesan ini men-tag aku ATAU membalas pesanku
  "file_name TEXT DEFAULT ''", // nama berkas (utk pesan dokumen / arsip)
  "file_size INTEGER DEFAULT 0", // ukuran berkas (byte) utk pesan dokumen
  "edited INTEGER DEFAULT 0", // 1 bila pesan ini sudah diedit
  "deleted INTEGER DEFAULT 0", // 1 bila pesan ini dihapus pengirim (delete-for-everyone)
]) {
  try { db.exec(`ALTER TABLE messages ADD COLUMN ${col}`); } catch (e) { /* sudah ada */ }
}
// Pin chat (lokal — hanya memengaruhi urutan di UI mirror, tidak menyentuh WA asli).
try { db.exec("ALTER TABLE chats ADD COLUMN pinned INTEGER DEFAULT 0"); } catch (e) { /* sudah ada */ }

// Penanda "terakhir dibaca" per chat (versi mirror) untuk hitung unread.
// Saat kolom pertama dibuat: anggap semua riwayat lama SUDAH dibaca
// (last_read_ts = last_message_time), supaya tidak banjir unread historis.
try {
  db.exec("ALTER TABLE chats ADD COLUMN last_read_ts INTEGER DEFAULT 0");
  db.exec("UPDATE chats SET last_read_ts = last_message_time");
} catch (e) { /* sudah ada */ }

// ---------- prepared statements ----------
const _insertMsg = db.prepare(`
  INSERT INTO messages (chat_jid, id, sender, from_me, text, type, timestamp, thumb, media_mime, quoted_id, quoted_text, quoted_sender, raw, mentioned, file_name, file_size)
  VALUES (@chat_jid, @id, @sender, @from_me, @text, @type, @timestamp, @thumb, @media_mime, @quoted_id, @quoted_text, @quoted_sender, @raw, @mentioned, @file_name, @file_size)
  ON CONFLICT(chat_jid, id) DO UPDATE SET
    text          = excluded.text,
    type          = excluded.type,
    timestamp     = excluded.timestamp,
    thumb         = CASE WHEN excluded.thumb <> ''         THEN excluded.thumb         ELSE messages.thumb         END,
    media_mime    = CASE WHEN excluded.media_mime <> ''    THEN excluded.media_mime    ELSE messages.media_mime    END,
    quoted_id     = CASE WHEN excluded.quoted_id <> ''     THEN excluded.quoted_id     ELSE messages.quoted_id     END,
    quoted_text   = CASE WHEN excluded.quoted_id <> ''     THEN excluded.quoted_text   ELSE messages.quoted_text   END,
    quoted_sender = CASE WHEN excluded.quoted_id <> ''     THEN excluded.quoted_sender ELSE messages.quoted_sender END,
    raw           = CASE WHEN excluded.raw <> ''           THEN excluded.raw           ELSE messages.raw           END,
    mentioned     = CASE WHEN excluded.mentioned <> 0      THEN excluded.mentioned     ELSE messages.mentioned     END,
    file_name     = CASE WHEN excluded.file_name <> ''     THEN excluded.file_name     ELSE messages.file_name     END,
    file_size     = CASE WHEN excluded.file_size <> 0      THEN excluded.file_size     ELSE messages.file_size     END
`);

// Insert/refresh chat row. Hanya naikkan last_message_time/last_text bila lebih baru.
const _touchChat = db.prepare(`
  INSERT INTO chats (jid, name, is_group, last_message_time, last_text)
  VALUES (@jid, @name, @is_group, @timestamp, @text)
  ON CONFLICT(jid) DO UPDATE SET
    last_message_time = CASE WHEN excluded.last_message_time > chats.last_message_time
                             THEN excluded.last_message_time ELSE chats.last_message_time END,
    last_text         = CASE WHEN excluded.last_message_time >= chats.last_message_time
                             THEN excluded.last_text ELSE chats.last_text END,
    name              = CASE WHEN chats.name = '' THEN excluded.name ELSE chats.name END
`);

const _setChatName = db.prepare(`
  INSERT INTO chats (jid, name, is_group) VALUES (@jid, @name, @is_group)
  ON CONFLICT(jid) DO UPDATE SET name = @name
`);

const _upsertContact = db.prepare(`
  INSERT INTO contacts (jid, name) VALUES (@jid, @name)
  ON CONFLICT(jid) DO UPDATE SET name = CASE WHEN @name <> '' THEN @name ELSE contacts.name END
`);

const _getChats = db.prepare(`
  SELECT c.jid,
         COALESCE(NULLIF(c.name, ''), NULLIF(ct.name, ''), c.jid) AS name,
         c.is_group, c.last_message_time, c.last_text, c.pinned,
         CASE WHEN c.last_message_time > c.last_read_ts THEN (
           SELECT COUNT(*) FROM messages m
           WHERE m.chat_jid = c.jid AND m.from_me = 0 AND m.timestamp > c.last_read_ts
         ) ELSE 0 END AS unread,
         CASE WHEN c.last_message_time > c.last_read_ts THEN (
           SELECT COUNT(*) FROM messages m
           WHERE m.chat_jid = c.jid AND m.from_me = 0 AND m.mentioned = 1 AND m.timestamp > c.last_read_ts
         ) ELSE 0 END AS mentions
  FROM chats c
  LEFT JOIN contacts ct ON ct.jid = c.jid
  WHERE c.last_message_time > 0
  ORDER BY c.pinned DESC, c.last_message_time DESC
  LIMIT @limit
`);

const _setPin = db.prepare("UPDATE chats SET pinned = @pinned WHERE jid = @jid");

// Tandai chat sudah dibaca: last_read_ts = timestamp pesan terbaru di chat itu.
const _markRead = db.prepare(`
  UPDATE chats
  SET last_read_ts = (SELECT COALESCE(MAX(timestamp), 0) FROM messages WHERE chat_jid = @jid)
  WHERE jid = @jid
`);

// Pesan diurutkan terbaru -> lama. Pakai cursor `before` (timestamp) untuk load lebih lama.
const _getMessages = db.prepare(`
  SELECT m.id, m.sender,
         COALESCE(NULLIF(ct.name, ''), m.sender) AS sender_name,
         m.from_me, m.text, m.type, m.timestamp, m.thumb,
         m.quoted_id, m.quoted_text, m.quoted_sender,
         COALESCE(NULLIF(qc.name, ''), '') AS quoted_sender_name,
         m.media_mime, m.file_name, m.file_size, m.edited, m.deleted
  FROM messages m
  LEFT JOIN contacts ct ON ct.jid = m.sender
  LEFT JOIN contacts qc ON qc.jid = m.quoted_sender
  WHERE m.chat_jid = @jid AND m.timestamp < @before
  ORDER BY m.timestamp DESC
  LIMIT @limit
`);

// Pesan LEBIH BARU dari cursor `after` (untuk lanjut ke bawah saat loncat ke pesan lama
// hasil cari). ASC = yang tepat setelah target dulu. Kolom sama dengan _getMessages.
const _getMessagesNewer = db.prepare(`
  SELECT m.id, m.sender,
         COALESCE(NULLIF(ct.name, ''), m.sender) AS sender_name,
         m.from_me, m.text, m.type, m.timestamp, m.thumb,
         m.quoted_id, m.quoted_text, m.quoted_sender,
         COALESCE(NULLIF(qc.name, ''), '') AS quoted_sender_name,
         m.media_mime, m.file_name, m.file_size, m.edited, m.deleted
  FROM messages m
  LEFT JOIN contacts ct ON ct.jid = m.sender
  LEFT JOIN contacts qc ON qc.jid = m.quoted_sender
  WHERE m.chat_jid = @jid AND m.timestamp > @after
  ORDER BY m.timestamp ASC
  LIMIT @limit
`);

const _getMediaInfo = db.prepare(
  `SELECT type, media_mime, file_name FROM messages WHERE chat_jid = @jid AND id = @id`
);

const _getMessageById = db.prepare(
  `SELECT id, sender, from_me, text, type FROM messages WHERE chat_jid = @jid AND id = @id`
);

const _getMessageRaw = db.prepare(
  `SELECT raw FROM messages WHERE chat_jid = @jid AND id = @id`
);

const _getChatName = db.prepare(`SELECT name FROM chats WHERE jid = @jid`);
const _getContactName = db.prepare(`SELECT name FROM contacts WHERE jid = @jid`);

// Cari nama kontak dari BAGIAN NOMOR jid (cocok utk @s.whatsapp.net maupun @lid,
// dengan/ tanpa suffix device). Prefix match → bisa pakai indeks primary key jid.
const _contactByNum = db.prepare(
  `SELECT name FROM contacts WHERE (jid LIKE @p1 OR jid LIKE @p2) AND name <> '' LIMIT 1`
);
// Ganti mention "@<nomor/id>" pada teks → "@<nama kontak>" (best-effort). WA menyimpan
// mention sebagai @nomor; nama hanya dirender klien. Hanya digit ≥5 yang dianggap mention.
function resolveMentions(text) {
  if (!text || text.indexOf("@") < 0) return text;
  return text.replace(/@(\d{5,})/g, (full, num) => {
    const r = _contactByNum.get({ p1: num + "@%", p2: num + ":%" });
    return r && r.name ? "@" + r.name : full;
  });
}

// Cari ISI pesan (teks) lintas semua chat. LIKE %q% (tanpa indeks → full scan, tapi
// cukup cepat utk skala personal). Sertakan nama chat + nama pengirim utk ditampilkan.
const _searchMessages = db.prepare(`
  SELECT m.chat_jid AS jid,
         COALESCE(NULLIF(c.name, ''), NULLIF(ct.name, ''), m.chat_jid) AS chat_name,
         c.is_group AS is_group,
         m.id, m.from_me, m.text, m.timestamp,
         COALESCE(NULLIF(sc.name, ''), '') AS sender_name
  FROM messages m
  LEFT JOIN chats c     ON c.jid  = m.chat_jid
  LEFT JOIN contacts ct ON ct.jid = m.chat_jid
  LEFT JOIN contacts sc ON sc.jid = m.sender
  WHERE m.text LIKE @q ESCAPE '\\'
  ORDER BY m.timestamp DESC
  LIMIT @limit
`);

// ---------- transactions / helpers ----------
const recordMessage = db.transaction((msg) => {
  _insertMsg.run({
    chat_jid: msg.chat_jid,
    id: msg.id,
    sender: msg.sender || "",
    from_me: msg.from_me ? 1 : 0,
    text: msg.text || "",
    type: msg.type || "text",
    timestamp: msg.timestamp || 0,
    thumb: msg.thumb || "",
    media_mime: msg.media_mime || "",
    quoted_id: msg.quoted_id || "",
    quoted_text: msg.quoted_text || "",
    quoted_sender: msg.quoted_sender || "",
    raw: msg.raw || "",
    mentioned: msg.mentioned ? 1 : 0,
    file_name: msg.file_name || "",
    file_size: msg.file_size || 0,
  });
  _touchChat.run({
    jid: msg.chat_jid,
    name: msg.chat_name || "",
    is_group: msg.chat_jid.endsWith("@g.us") ? 1 : 0,
    timestamp: msg.timestamp || 0,
    text: msg.text || "",
  });
});

function setChatName(jid, name) {
  if (!jid || !name) return;
  _setChatName.run({ jid, name, is_group: jid.endsWith("@g.us") ? 1 : 0 });
}

function upsertContact(jid, name) {
  if (!jid) return;
  _upsertContact.run({ jid, name: name || "" });
}

function getChats(limit = 200) {
  const rows = _getChats.all({ limit });
  for (const r of rows) if (r.last_text) r.last_text = resolveMentions(r.last_text);
  return rows;
}

function setPin(jid, pinned) {
  if (!jid) return;
  _setPin.run({ jid, pinned: pinned ? 1 : 0 });
}

function markRead(jid) {
  if (!jid) return;
  _markRead.run({ jid });
}

function getMessages(jid, before, limit = 50) {
  const rows = _getMessages.all({
    jid,
    before: before && before > 0 ? before : Number.MAX_SAFE_INTEGER,
    limit,
  });
  for (const r of rows) {
    if (r.text) r.text = resolveMentions(r.text);
    if (r.quoted_text) r.quoted_text = resolveMentions(r.quoted_text);
  }
  return rows;
}

// Pesan lebih baru dari `after` (epoch), urut ASC. Dipakai loncat-ke-pesan-lama lalu lanjut ke bawah.
function getMessagesNewer(jid, after, limit = 50) {
  const rows = _getMessagesNewer.all({ jid, after: after || 0, limit });
  for (const r of rows) {
    if (r.text) r.text = resolveMentions(r.text);
    if (r.quoted_text) r.quoted_text = resolveMentions(r.quoted_text);
  }
  return rows;
}

function getMediaInfo(jid, id) {
  return _getMediaInfo.get({ jid, id });
}

function getMessageById(jid, id) {
  return _getMessageById.get({ jid, id });
}

// Ganti teks pesan (saat diedit) + tandai edited. Update preview chat bila pesan ini yang terbaru.
const _editMsg = db.prepare("UPDATE messages SET text = @text, edited = 1 WHERE chat_jid = @jid AND id = @id");
const _editChatLast = db.prepare(
  "UPDATE chats SET last_text = @text WHERE jid = @jid AND last_message_time = (SELECT timestamp FROM messages WHERE chat_jid = @jid AND id = @id)"
);
function editMessageText(jid, id, text) {
  if (!jid || !id) return 0;
  const r = _editMsg.run({ jid, id, text: text || "" });
  try { _editChatLast.run({ jid, id, text: text || "" }); } catch (e) { /* abaikan */ }
  return r.changes;
}

function getMessageRaw(jid, id) {
  const row = _getMessageRaw.get({ jid, id });
  return row ? row.raw : "";
}

// Tandai pesan dihapus pengirim (delete-for-everyone). Konten ASLI tetap disimpan
// (anti-delete: tetap kebaca di mirror), hanya diberi penanda.
const _markDeleted = db.prepare("UPDATE messages SET deleted = 1 WHERE chat_jid = @jid AND id = @id");
function markDeleted(jid, id) {
  if (!jid || !id) return;
  _markDeleted.run({ jid, id });
}

// ---------- bersih-bersih media lama (>N hari) ----------
// id media (image/video/document/sticker) yang lebih lama dari cutoff (epoch detik) —
// dipakai untuk menghapus file cache di data/media.
const _oldMediaIds = db.prepare(
  `SELECT id FROM messages WHERE timestamp < @cutoff AND type IN ('image','video','document','sticker')`
);
function oldMediaIds(cutoff) {
  return _oldMediaIds.all({ cutoff }).map((r) => r.id);
}
// Kosongkan kolom raw (WebMessageInfo terenkode) untuk pesan lebih lama dari cutoff.
// Hemat DB; media memang tak bisa di-download ulang setelah kedaluwarsa di server WA.
const _clearOldRaw = db.prepare(`UPDATE messages SET raw = '' WHERE timestamp < @cutoff AND raw <> ''`);
function clearOldRaw(cutoff) {
  return _clearOldRaw.run({ cutoff }).changes;
}

// Nama tampilan grup (dari chats.name). "" bila belum tersinkron.
function getChatName(jid) {
  const r = _getChatName.get({ jid });
  return r && r.name ? r.name : "";
}

// Nama tampilan kontak (dari contacts.name). "" bila tak ada.
function getContactName(jid) {
  const r = _getContactName.get({ jid });
  return r && r.name ? r.name : "";
}

// Nama kontak dari BAGIAN NOMOR (cocok utk @s.whatsapp.net maupun @lid). Dipakai
// daftar anggota grup: nama anggota mungkin tersimpan di bawah jid @lid maupun nomor.
function contactNameByNum(num) {
  const n = String(num || "").replace(/\D/g, "");
  if (!n) return "";
  const r = _contactByNum.get({ p1: n + "@%", p2: n + ":%" });
  return r && r.name ? r.name : "";
}

// Cari isi pesan. Minimal 2 karakter. Escape wildcard LIKE (% _ \) agar literal.
function searchMessages(q, limit = 50) {
  const term = String(q || "").trim();
  if (term.length < 2) return [];
  const esc = term.replace(/[\\%_]/g, (c) => "\\" + c);
  return _searchMessages.all({ q: "%" + esc + "%", limit: Math.min(Math.max(limit, 1), 100) });
}

// Total ukuran folder data (DB + WAL + media + avatar). Di-cache 60 dtk (dipanggil tiap poll).
let _sizeCache = { at: 0, bytes: 0 };
function dirSize(dir) {
  let total = 0, entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try { total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size; } catch (_) {}
  }
  return total;
}
function dataSize() {
  const now = Date.now();
  if (now - _sizeCache.at < 60000) return _sizeCache.bytes;
  _sizeCache = { at: now, bytes: dirSize(path.dirname(DB_PATH)) };
  return _sizeCache.bytes;
}

function stats() {
  const c = db.prepare("SELECT COUNT(*) n FROM chats").get().n;
  const m = db.prepare("SELECT COUNT(*) n FROM messages").get().n;
  return { chats: c, messages: m, dataBytes: dataSize() };
}

module.exports = {
  db,
  recordMessage,
  setChatName,
  upsertContact,
  getChats,
  setPin,
  markRead,
  getMessages,
  getMessagesNewer,
  getMediaInfo,
  getMessageById,
  editMessageText,
  markDeleted,
  getMessageRaw,
  getChatName,
  getContactName,
  contactNameByNum,
  searchMessages,
  oldMediaIds,
  clearOldRaw,
  stats,
};
