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

-- Reaksi emoji per pesan. Satu baris per (chat, pesan, pengirim-reaksi); emoji
-- kosong = reaksi dilepas (baris dihapus). from_me = 1 bila aku yang bereaksi.
CREATE TABLE IF NOT EXISTS reactions (
  chat_jid TEXT NOT NULL,
  msg_id   TEXT NOT NULL,
  reactor  TEXT NOT NULL DEFAULT '',
  from_me  INTEGER DEFAULT 0,
  emoji    TEXT DEFAULT '',
  ts       INTEGER DEFAULT 0,
  PRIMARY KEY (chat_jid, msg_id, reactor)
);
CREATE INDEX IF NOT EXISTS idx_react_msg ON reactions(chat_jid, msg_id);

-- Tugas pending: pesan yang di-tag sebagai tugas oleh pengguna (lokal, tidak sync ke WA).
CREATE TABLE IF NOT EXISTS pending_tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_jid   TEXT NOT NULL,
  msg_id     TEXT NOT NULL,
  msg_text   TEXT DEFAULT '',
  msg_ts     INTEGER DEFAULT 0,
  msg_sender TEXT DEFAULT '',
  chat_name  TEXT DEFAULT '',
  added_ts   INTEGER DEFAULT 0,
  UNIQUE(chat_jid, msg_id)
);

-- Peta LID <-> nomor telepon (PN). Dipakai untuk mengkanonikalisasi chat DM yang
-- kepecah antara <lidnum>@lid dan <num>@s.whatsapp.net menjadi satu chat (kunci = PN).
CREATE TABLE IF NOT EXISTS lid_map (
  lid_num TEXT PRIMARY KEY,  -- nomor bare dari <lidnum>@lid (tanpa domain/device)
  pn_jid  TEXT NOT NULL,     -- <num>@s.whatsapp.net (ternormalisasi, tanpa device)
  ts      INTEGER DEFAULT 0
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
         COALESCE(
           CASE WHEN c.jid LIKE '%@g.us' THEN NULLIF(c.name, '') END,
           NULLIF(ct.name, ''),
           NULLIF(c.name, ''),
           c.jid
         ) AS name,
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
         COALESCE(
           CASE WHEN m.chat_jid LIKE '%@g.us' THEN NULLIF(c.name, '') END,
           NULLIF(ct.name, ''),
           NULLIF(c.name, ''),
           m.chat_jid
         ) AS chat_name,
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

// ---------- LID <-> PN mapping + gabung chat kepecah ----------
const _upsertLidMap = db.prepare(`
  INSERT INTO lid_map (lid_num, pn_jid, ts) VALUES (@lid_num, @pn_jid, @ts)
  ON CONFLICT(lid_num) DO UPDATE SET pn_jid = excluded.pn_jid, ts = excluded.ts
`);
const _getPnForLidNum = db.prepare("SELECT pn_jid FROM lid_map WHERE lid_num = @lid_num");
const _allLidMap = db.prepare("SELECT lid_num, pn_jid FROM lid_map");
const _lidDmChats = db.prepare("SELECT jid FROM chats WHERE jid LIKE '%@lid'");

function upsertLidMap(lidNum, pnJid) {
  if (!lidNum || !pnJid) return;
  _upsertLidMap.run({ lid_num: String(lidNum), pn_jid: String(pnJid), ts: Math.floor(Date.now() / 1000) });
}
function pnForLidNum(lidNum) {
  if (!lidNum) return "";
  const r = _getPnForLidNum.get({ lid_num: String(lidNum) });
  return r && r.pn_jid ? r.pn_jid : "";
}
function allLidMap() { return _allLidMap.all(); }
function lidDmChats() { return _lidDmChats.all().map((r) => r.jid); }

// Pindahkan seluruh isi chat `fromJid` ke `toJid` lalu hapus `fromJid`. Idempoten.
// Menangani konflik PK messages(chat_jid,id): salinan duplikat di `from` dibuang
// (salinan `to` dipertahankan). Reactions/pending_tasks ikut dipindah (dedupe dulu).
const _msgIdsBoth = db.prepare(
  "SELECT id FROM messages WHERE chat_jid = @from AND id IN (SELECT id FROM messages WHERE chat_jid = @to)"
);
const _delMsgFromId = db.prepare("DELETE FROM messages WHERE chat_jid = @from AND id = @id");
const _moveMsgs = db.prepare("UPDATE messages SET chat_jid = @to WHERE chat_jid = @from");
const _rewriteSenderInChat = db.prepare("UPDATE messages SET sender = @to WHERE chat_jid = @to AND sender = @from");
const _rewriteQuotedInChat = db.prepare("UPDATE messages SET quoted_sender = @to WHERE chat_jid = @to AND quoted_sender = @from");
const _delReactDup = db.prepare(
  "DELETE FROM reactions WHERE chat_jid = @from AND (msg_id, reactor) IN (SELECT msg_id, reactor FROM reactions WHERE chat_jid = @to)"
);
const _moveReact = db.prepare("UPDATE reactions SET chat_jid = @to WHERE chat_jid = @from");
const _delPendDup = db.prepare(
  "DELETE FROM pending_tasks WHERE chat_jid = @from AND msg_id IN (SELECT msg_id FROM pending_tasks WHERE chat_jid = @to)"
);
const _movePend = db.prepare("UPDATE pending_tasks SET chat_jid = @to WHERE chat_jid = @from");
const _getChatRow = db.prepare("SELECT * FROM chats WHERE jid = @jid");
const _cntMsgChat = db.prepare("SELECT COUNT(*) n FROM messages WHERE chat_jid = @jid");
const _ensureChat = db.prepare("INSERT OR IGNORE INTO chats (jid, is_group) VALUES (@to, 0)");
const _delChat = db.prepare("DELETE FROM chats WHERE jid = @jid");
const _mergeChatRow = db.prepare(`
  UPDATE chats SET
    last_message_time = MAX(last_message_time, @lmt),
    last_text    = CASE WHEN @lmt >= last_message_time THEN @ltext ELSE last_text END,
    last_read_ts = MAX(last_read_ts, @lread),
    pinned       = MAX(pinned, @pinned),
    name         = CASE WHEN name = '' THEN @name ELSE name END
  WHERE jid = @to
`);
const _foldContact = db.prepare(`
  INSERT INTO contacts (jid, name)
  SELECT @to, name FROM contacts WHERE jid = @from AND name <> ''
  ON CONFLICT(jid) DO UPDATE SET name = CASE WHEN contacts.name = '' THEN excluded.name ELSE contacts.name END
`);
const _delContact = db.prepare("DELETE FROM contacts WHERE jid = @from");

const mergeChat = db.transaction((fromJid, toJid) => {
  if (!fromJid || !toJid || fromJid === toJid) return 0;
  const from = fromJid, to = toJid;
  const src = _getChatRow.get({ jid: from });
  if (!src && _cntMsgChat.get({ jid: from }).n === 0) return 0; // tidak ada apa-apa utk digabung
  for (const row of _msgIdsBoth.all({ from, to })) _delMsgFromId.run({ from, id: row.id });
  _moveMsgs.run({ from, to });
  _rewriteSenderInChat.run({ from, to });
  _rewriteQuotedInChat.run({ from, to });
  _delReactDup.run({ from, to });
  _moveReact.run({ from, to });
  _delPendDup.run({ from, to });
  _movePend.run({ from, to });
  if (src) {
    _ensureChat.run({ to });
    _mergeChatRow.run({
      to,
      lmt: src.last_message_time || 0,
      ltext: src.last_text || "",
      lread: src.last_read_ts || 0,
      pinned: src.pinned || 0,
      name: src.name || "",
    });
    _delChat.run({ jid: from });
  }
  _foldContact.run({ from, to });
  _delContact.run({ from });
  return 1;
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

// Halaman chat LEBIH LAMA (infinite scroll sidebar): chat dgn last_message_time di bawah
// cursor @before, tanpa yang pinned (pinned selalu ikut di halaman atas getChats).
const _getChatsBefore = db.prepare(`
  SELECT c.jid,
         COALESCE(
           CASE WHEN c.jid LIKE '%@g.us' THEN NULLIF(c.name, '') END,
           NULLIF(ct.name, ''),
           NULLIF(c.name, ''),
           c.jid
         ) AS name,
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
  WHERE c.last_message_time > 0 AND c.last_message_time < @before AND c.pinned = 0
  ORDER BY c.last_message_time DESC
  LIMIT @limit
`);
function getChatsBefore(before, limit = 100) {
  const rows = _getChatsBefore.all({ before, limit });
  for (const r of rows) if (r.last_text) r.last_text = resolveMentions(r.last_text);
  return rows;
}

// Cari chat berdasarkan NAMA (nama grup / kontak) lintas SEMUA chat di DB — supaya chat lama
// yang belum ke-load di sidebar tetap ketemu saat diketik namanya. LIKE pada nama ter-resolve.
const _searchChats = db.prepare(`
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
    AND COALESCE(NULLIF(c.name, ''), NULLIF(ct.name, ''), c.jid) LIKE @q ESCAPE '\\'
  ORDER BY c.pinned DESC, c.last_message_time DESC
  LIMIT @limit
`);
function searchChats(q, limit = 50) {
  const term = String(q || "").trim();
  if (term.length < 2) return [];
  const esc = term.replace(/[\\%_]/g, (c) => "\\" + c);
  const rows = _searchChats.all({ q: "%" + esc + "%", limit: Math.min(Math.max(limit, 1), 100) });
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
  return attachReactions(jid, rows);
}

// Pesan lebih baru dari `after` (epoch), urut ASC. Dipakai loncat-ke-pesan-lama lalu lanjut ke bawah.
function getMessagesNewer(jid, after, limit = 50) {
  const rows = _getMessagesNewer.all({ jid, after: after || 0, limit });
  for (const r of rows) {
    if (r.text) r.text = resolveMentions(r.text);
    if (r.quoted_text) r.quoted_text = resolveMentions(r.quoted_text);
  }
  return attachReactions(jid, rows);
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

// ---------- reaksi emoji ----------
// Set/ubah/hapus reaksi seseorang pada sebuah pesan. emoji kosong = lepas reaksi.
const _setReaction = db.prepare(`
  INSERT INTO reactions (chat_jid, msg_id, reactor, from_me, emoji, ts)
  VALUES (@chat_jid, @msg_id, @reactor, @from_me, @emoji, @ts)
  ON CONFLICT(chat_jid, msg_id, reactor) DO UPDATE SET
    emoji = excluded.emoji, from_me = excluded.from_me, ts = excluded.ts
`);
const _delReaction = db.prepare(
  "DELETE FROM reactions WHERE chat_jid = @chat_jid AND msg_id = @msg_id AND reactor = @reactor"
);
function setReaction({ chat_jid, msg_id, reactor, from_me, emoji, ts }) {
  if (!chat_jid || !msg_id) return;
  const r = reactor || "";
  if (!emoji) { _delReaction.run({ chat_jid, msg_id, reactor: r }); return; }
  _setReaction.run({
    chat_jid, msg_id, reactor: r,
    from_me: from_me ? 1 : 0, emoji, ts: ts || 0,
  });
}

// Ambil reaksi untuk sekumpulan id pesan dalam satu chat. Return peta
// id -> { list: [{emoji,count}], total, mine } (mine = emoji yang KUkirim, "" bila tak ada).
function reactionsForChat(chat_jid, ids) {
  const map = {};
  if (!ids || !ids.length) return map;
  const ph = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT msg_id, emoji, from_me FROM reactions WHERE chat_jid = ? AND msg_id IN (${ph}) AND emoji <> ''`)
    .all(chat_jid, ...ids);
  for (const r of rows) {
    const e = (map[r.msg_id] || (map[r.msg_id] = { counts: {}, total: 0, mine: "" }));
    e.counts[r.emoji] = (e.counts[r.emoji] || 0) + 1;
    e.total++;
    if (r.from_me) e.mine = r.emoji;
  }
  for (const id in map) {
    const e = map[id];
    e.list = Object.keys(e.counts)
      .map((emoji) => ({ emoji, count: e.counts[emoji] }))
      .sort((a, b) => b.count - a.count);
    delete e.counts;
  }
  return map;
}

// Lampirkan field `reactions` (array {emoji,count}), `react_total`, `my_reaction`
// ke tiap baris pesan (in-place). Satu query untuk seluruh batch.
function attachReactions(jid, rows) {
  if (!rows || !rows.length) return rows;
  const map = reactionsForChat(jid, rows.map((r) => r.id));
  for (const r of rows) {
    const e = map[r.id];
    r.reactions = e ? e.list : [];
    r.react_total = e ? e.total : 0;
    r.my_reaction = e ? e.mine : "";
  }
  return rows;
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

// ---------- tugas pending ----------
const _addPending = db.prepare(`
  INSERT OR IGNORE INTO pending_tasks
    (chat_jid, msg_id, msg_text, msg_ts, msg_sender, chat_name, added_ts)
  VALUES (@chat_jid, @msg_id, @msg_text, @msg_ts, @msg_sender, @chat_name, @added_ts)
`);
const _removePending = db.prepare(`DELETE FROM pending_tasks WHERE id = ?`);
const _listPending = db.prepare(`SELECT * FROM pending_tasks ORDER BY added_ts DESC`);

function addPendingTask(chatJid, msgId, msgText, msgTs, msgSender, chatName) {
  return _addPending.run({
    chat_jid: chatJid, msg_id: msgId, msg_text: msgText || '',
    msg_ts: msgTs || 0, msg_sender: msgSender || '',
    chat_name: chatName || '', added_ts: Math.floor(Date.now() / 1000),
  }).changes;
}
function removePendingTask(id) { _removePending.run(id); }
function listPendingTasks() { return _listPending.all(); }

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
  getChatsBefore,
  searchChats,
  setPin,
  markRead,
  getMessages,
  getMessagesNewer,
  getMediaInfo,
  getMessageById,
  editMessageText,
  markDeleted,
  setReaction,
  getMessageRaw,
  getChatName,
  getContactName,
  contactNameByNum,
  searchMessages,
  oldMediaIds,
  clearOldRaw,
  addPendingTask,
  removePendingTask,
  listPendingTasks,
  upsertLidMap,
  pnForLidNum,
  allLidMap,
  lidDmChats,
  mergeChat,
  stats,
};
