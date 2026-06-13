"use strict";
const path = require("path");
const pino = require("pino");
const qrcode = require("qrcode");
const store = require("./db");

// Baileys v7 di-load lewat dynamic import (ESM) — sama seperti project WA-TIKET.
let makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, jidNormalizedUser, downloadMediaMessage, proto, WAMessageStubType;
async function loadBaileys() {
  if (makeWASocket) return;
  const b = await import("baileys");
  makeWASocket = b.default?.default ?? b.default ?? b.makeWASocket;
  useMultiFileAuthState = b.useMultiFileAuthState;
  DisconnectReason = b.DisconnectReason;
  fetchLatestBaileysVersion = b.fetchLatestBaileysVersion;
  jidNormalizedUser = b.jidNormalizedUser;
  downloadMediaMessage = b.downloadMediaMessage;
  proto = b.proto;
  WAMessageStubType = b.WAMessageStubType;
}

const AUTH_DIR = process.env.AUTH_DIR
  ? path.resolve(process.env.AUTH_DIR)
  : path.resolve(__dirname, "../auth");

// Notifikasi ke nomor tujuan saat di-tag / dibalas di GRUP (default: aktif).
// Sejak revisi ini notifikasi grup TIDAK langsung diforward — ikut jalur "belum
// dibalas N menit" yang sama dengan chat pribadi (lihat trackPending/sweepPending)
// supaya tidak nge-spam saat grup ramai. OWNER_NOTIFY=0 mematikan jalur grup;
// OWNER_NOTIFY_FORWARD=0 hanya kirim teks tanpa forward pesan asli.
const OWNER_NOTIFY = process.env.OWNER_NOTIFY !== "0";
const OWNER_FORWARD = process.env.OWNER_NOTIFY_FORWARD !== "0";

// Pengingat chat PRIBADI yang belum dibalas dalam N menit (default: aktif, 5 menit).
// Ambang menit ini dipakai BERSAMA oleh jalur grup di atas.
// OWNER_PENDING_NOTIFY=0 mematikan jalur pribadi; OWNER_PENDING_MINUTES mengatur ambang menit.
const OWNER_PENDING_NOTIFY = process.env.OWNER_PENDING_NOTIFY !== "0";
const PENDING_MIN = Number(process.env.OWNER_PENDING_MINUTES) || 5;

// Nomor tujuan notifikasi. Kosongkan = kirim ke diri sendiri (nomor yang login).
// Isi nomor lain (mis. 6281234567890) bila ingin notif dikirim ke HP terpisah.
function toJid(num) {
  const s = String(num || "").trim();
  if (!s) return "";
  if (s.includes("@")) return s;                  // sudah berbentuk jid
  const digits = s.replace(/[^0-9]/g, "");
  return digits ? digits + "@s.whatsapp.net" : "";
}
const OWNER_JID = toJid(process.env.OWNER_JID);
const ownerTarget = () => OWNER_JID || status.me; // JID tujuan notifikasi

let sock = null;
const status = {
  connected: false,
  qr: null,
  me: null,
  meLid: null,          // identitas LID-ku (dipakai di grup utk deteksi tag/reply)
  reconnecting: false,
  lastHistoryAt: 0,   // epoch ms batch history terakhir diterima
  syncedMessages: 0,  // jumlah pesan yang masuk lewat history sync sesi ini
  lastActivityAt: 0,  // epoch ms pesan real-time terakhir
};

// Dianggap "sedang sinkron" jika batch history terakhir < 10 detik lalu.
const SYNC_WINDOW_MS = 10000;

// Cache pesan (id -> waMsg) untuk: (1) download media resolusi penuh on-demand,
// (2) membangun kutipan asli saat membalas (reply). Dibatasi agar memori aman.
const msgCache = new Map();
const MSG_CACHE_MAX = 3000;
function cacheMsg(waMsg) {
  const id = waMsg?.key?.id;
  if (!id || !waMsg.message) return;
  msgCache.set(id, waMsg);
  if (msgCache.size > MSG_CACHE_MAX) {
    msgCache.delete(msgCache.keys().next().value); // buang yang paling lama
  }
}

// ---------- ekstraksi teks dari berbagai tipe pesan ----------
function extractContent(message) {
  if (!message) return { text: "", type: "unknown" };
  const m = message;
  if (m.conversation) return { text: m.conversation, type: "text" };
  if (m.extendedTextMessage?.text) return { text: m.extendedTextMessage.text, type: "text" };
  if (m.imageMessage) return { text: m.imageMessage.caption || "📷 Foto", type: "image" };
  if (m.videoMessage) return { text: m.videoMessage.caption || "🎥 Video", type: "video" };
  if (m.audioMessage) return { text: m.audioMessage.ptt ? "🎤 Voice note" : "🔊 Audio", type: "audio" };
  if (m.documentMessage) return { text: "📄 " + (m.documentMessage.fileName || "Dokumen"), type: "document" };
  if (m.documentWithCaptionMessage) return extractContent(m.documentWithCaptionMessage.message);
  if (m.stickerMessage) return { text: "🌟 Stiker", type: "sticker" };
  if (m.contactMessage || m.contactsArrayMessage) return { text: "👤 Kontak", type: "contact" };
  if (m.locationMessage) return { text: "📍 Lokasi", type: "location" };
  if (m.pollCreationMessage || m.pollCreationMessageV3) return { text: "📊 Polling", type: "poll" };
  if (m.reactionMessage) return { text: m.reactionMessage.text || "", type: "reaction" };
  if (m.protocolMessage) return { text: "", type: "protocol" };
  if (m.ephemeralMessage) return extractContent(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return extractContent(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return extractContent(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension) return extractContent(m.viewOnceMessageV2Extension.message);
  return { text: "", type: "other" };
}

// Cari node media (image/video) di dalam berbagai pembungkus, ambil thumbnail + mimetype.
function extractMedia(message) {
  if (!message) return null;
  const m = message;
  if (m.imageMessage) return { node: m.imageMessage, mime: m.imageMessage.mimetype || "image/jpeg" };
  if (m.videoMessage) return { node: m.videoMessage, mime: m.videoMessage.mimetype || "video/mp4" };
  if (m.stickerMessage) return { node: m.stickerMessage, mime: m.stickerMessage.mimetype || "image/webp" };
  if (m.ephemeralMessage) return extractMedia(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return extractMedia(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return extractMedia(m.viewOnceMessageV2.message);
  if (m.viewOnceMessageV2Extension) return extractMedia(m.viewOnceMessageV2Extension.message);
  if (m.documentWithCaptionMessage) return extractMedia(m.documentWithCaptionMessage.message);
  return null;
}
function thumbToBase64(node) {
  const t = node && node.jpegThumbnail;
  if (!t) return "";
  try { return Buffer.from(t).toString("base64"); } catch (e) { return ""; }
}

// Cari node dokumen (termasuk arsip zip/rar/7z dll — semuanya documentMessage di WA),
// ambil mimetype, nama berkas, dan ukuran.
function extractDoc(message) {
  if (!message) return null;
  const m = message;
  if (m.documentMessage) return docMeta(m.documentMessage);
  if (m.documentWithCaptionMessage) return extractDoc(m.documentWithCaptionMessage.message);
  if (m.ephemeralMessage) return extractDoc(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return extractDoc(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return extractDoc(m.viewOnceMessageV2.message);
  return null;
}
function docMeta(node) {
  return {
    node,
    mime: node.mimetype || "application/octet-stream",
    fileName: node.fileName || node.title || "dokumen",
    fileSize: Number(toEpoch(node.fileLength)) || 0,
  };
}

// Cari node contextInfo dari berbagai tipe/pembungkus pesan.
function findContextInfo(message) {
  if (!message) return null;
  const m = message;
  if (m.ephemeralMessage) return findContextInfo(m.ephemeralMessage.message);
  if (m.viewOnceMessage) return findContextInfo(m.viewOnceMessage.message);
  if (m.viewOnceMessageV2) return findContextInfo(m.viewOnceMessageV2.message);
  const node =
    m.extendedTextMessage || m.imageMessage || m.videoMessage || m.audioMessage ||
    m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage ||
    m.stickerMessage || m.contactMessage || m.locationMessage;
  return (node && node.contextInfo) || null;
}

// Cari node protocolMessage (edit/revoke/dll) di dalam berbagai pembungkus.
function findProtocolMsg(message) {
  if (!message) return null;
  if (message.protocolMessage) return message.protocolMessage;
  if (message.editedMessage?.message) return findProtocolMsg(message.editedMessage.message);
  if (message.ephemeralMessage?.message) return findProtocolMsg(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return findProtocolMsg(message.viewOnceMessage.message);
  return null;
}

// Ambil info kutipan (reply) dari contextInfo bila pesan ini membalas pesan lain.
function extractContext(message) {
  const ctx = findContextInfo(message);
  if (!ctx || !ctx.quotedMessage) return null;
  const q = extractContent(ctx.quotedMessage);
  return {
    id: ctx.stanzaId || "",
    sender: ctx.participant || "",
    text: q.text || "",
  };
}

// Ambil nomor murni dari JID (buang domain & suffix device/lid).
const jidNum = (j) => String(j || "").split("@")[0].split(":")[0];

// Jenis "sebutan" pesan masuk terhadap aku: "tag" (mentionedJid), "reply"
// (membalas pesanku), atau "" (bukan keduanya). Cocokkan terhadap nomor
// telepon DAN LID (di grup WhatsApp pakai @lid).
function mentionKind(message, ctx) {
  const mine = new Set([jidNum(status.me), jidNum(status.meLid)].filter(Boolean));
  if (!mine.size) return "";
  const ci = findContextInfo(message);
  const list = ci?.mentionedJid || [];
  if (list.some((j) => mine.has(jidNum(j)))) return "tag";          // di-tag
  if (ctx && ctx.id && mine.has(jidNum(ctx.sender))) return "reply"; // balas pesanku
  return "";
}

function toEpoch(t) {
  if (!t) return 0;
  if (typeof t === "number") return t;
  if (typeof t.toNumber === "function") return t.toNumber();
  return Number(t) || 0;
}

// Simpan satu pesan WhatsApp ke DB. Lewati pesan kontrol/kosong.
// Return info ringkas { jid, fromMe, isGroup, kind, text, type, sender, ctx,
// timestamp } untuk dipakai pemanggil (mis. notifikasi owner), atau null
// bila pesan dilewati.
function storeWAMessage(waMsg) {
  if (!waMsg || !waMsg.key || !waMsg.message) return null;
  const jid = waMsg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return null;

  const { text, type } = extractContent(waMsg.message);
  if (type === "protocol") return null;     // delete/receipt, bukan pesan nyata
  if (!text && type !== "image" && type !== "video") return null;

  const sender = waMsg.key.fromMe
    ? status.me || ""
    : waMsg.key.participant || jid; // di grup, participant = pengirim

  // Ambil thumbnail (jpegThumbnail) + mimetype untuk foto/video, metadata berkas untuk
  // dokumen, dan simpan pesan terenkode (raw) agar bisa di-download kapan pun (lintas
  // restart). WebMessageInfo hanya berisi metadata + kunci media, BUKAN byte berkasnya,
  // jadi 'raw' tetap kecil meski dokumennya besar.
  let thumb = "", media_mime = "", raw = "", file_name = "", file_size = 0;
  if (type === "image" || type === "video" || type === "document" || type === "sticker") {
    if (type === "document") {
      const doc = extractDoc(waMsg.message);
      if (doc) {
        media_mime = doc.mime; file_name = doc.fileName; file_size = doc.fileSize;
        thumb = thumbToBase64(doc.node); // sebagian dokumen (mis. PDF) punya thumbnail
      }
    } else {
      const media = extractMedia(waMsg.message);
      if (media) { thumb = thumbToBase64(media.node); media_mime = media.mime; }
    }
    try {
      raw = Buffer.from(proto.WebMessageInfo.encode(waMsg).finish()).toString("base64");
    } catch (e) { /* abaikan; thumbnail/teks tetap tampil */ }
  }

  // Cache semua pesan (untuk download media & quote reply).
  cacheMsg(waMsg);

  // Info kutipan bila pesan ini adalah balasan.
  const ctx = extractContext(waMsg.message);

  // Jenis sebutan bila pesan masuk ini men-tag aku / membalas pesanku (badge @).
  const kind = waMsg.key.fromMe ? "" : mentionKind(waMsg.message, ctx);
  const mentioned = !!kind;
  const timestamp = toEpoch(waMsg.messageTimestamp);

  store.recordMessage({
    chat_jid: jid,
    id: waMsg.key.id,
    sender,
    from_me: !!waMsg.key.fromMe,
    text,
    type,
    timestamp,
    chat_name: !jid.endsWith("@g.us") ? waMsg.pushName || "" : "",
    thumb,
    media_mime,
    quoted_id: ctx?.id || "",
    quoted_text: ctx?.text || "",
    quoted_sender: ctx?.sender || "",
    raw,
    mentioned,
    file_name,
    file_size,
  });

  // simpan pushName sebagai nama kontak (display)
  if (!waMsg.key.fromMe && waMsg.pushName) {
    store.upsertContact(sender, waMsg.pushName);
  }

  return {
    jid,
    fromMe: !!waMsg.key.fromMe,
    isGroup: jid.endsWith("@g.us"),
    kind,
    text,
    type,
    sender,
    ctx,
    timestamp,
    pushName: waMsg.pushName || "",
  };
}

// ---------- util format teks notifikasi ----------
function hhmm(epoch) {
  const d = new Date((epoch || 0) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes());
}
function clip(s, n) {
  s = String(s || "");
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// ---------- pengingat "belum dibalas" (chat pribadi & sebutan di grup) ----------
// Map jid -> { waMsg, info, streakStartTs, lastIncomingTs, count }
// "streak" = rentetan pesan masuk yang belum kutanggapi. Untuk chat PRIBADI: tiap
// pesan masuk. Untuk GRUP: hanya pesan yang men-tag aku / membalas pesanku (bukan
// pesan grup biasa). Streak selesai (entry dihapus) begitu aku mengirim sesuatu ke
// chat/grup itu — baik dari mirror maupun langsung dari HP.
const pendingReply = new Map();

function trackPending(waMsg, info) {
  if (!info) return;
  if (info.jid === status.me) return;       // bukan chat ke diri sendiri
  if (info.jid === "status@broadcast") return;

  if (info.fromMe) {                         // aku menanggapi → streak selesai
    pendingReply.delete(info.jid);
    return;
  }
  if (info.isGroup) {
    if (!OWNER_NOTIFY) return;               // jalur grup dimatikan
    if (!info.kind) return;                  // grup: hanya tag/reply, abaikan pesan biasa
  } else {
    if (!OWNER_PENDING_NOTIFY) return;       // jalur pribadi dimatikan
  }

  const ts = info.timestamp || Math.floor(Date.now() / 1000);
  const e = pendingReply.get(info.jid);
  if (!e) {
    pendingReply.set(info.jid, {
      waMsg, info, streakStartTs: ts, lastIncomingTs: ts, count: 1,
    });
  } else {
    e.count++;
    e.lastIncomingTs = ts;
    e.waMsg = waMsg;   // simpan yang terbaru utk diforward
    e.info = info;
  }
}

// Disapu berkala: kirim pengingat untuk chat/grup yang sudah ≥ PENDING_MIN menit
// belum kutanggapi, lalu hapus entry (sebutan/pesan masuk baru memulai streak baru,
// jadi maksimal 1 pengingat per PENDING_MIN menit per chat).
function sweepPending() {
  if (!sock || !status.connected || !status.me) return;
  const now = Date.now();
  for (const [jid, e] of pendingReply) {
    if (now - e.streakStartTs * 1000 >= PENDING_MIN * 60000) {
      pendingReply.delete(jid);
      notifyPending(jid, e).catch((err) => console.error("[wa] notifyPending:", err.message));
    }
  }
}

async function notifyPending(jid, e) {
  if (!sock || !status.connected || !status.me) return;
  const ownerJid = ownerTarget();
  const info = e.info || {};
  let body;

  if (info.isGroup) {
    // Sebutan di grup (tag/reply) yang tak kunjung kutanggapi dalam PENDING_MIN menit.
    const groupName = store.getChatName(jid) || jidNum(jid);
    const senderName = info.pushName || store.getContactName(info.sender) || jidNum(info.sender);
    const header = info.kind === "reply"
      ? `🔔 Balasan di grup belum kamu balas (${PENDING_MIN} menit)`
      : `🔔 Tag di grup belum kamu balas (${PENDING_MIN} menit)`;
    body =
      header + "\n" +
      "👥 " + groupName + "\n" +
      "👤 " + senderName + "\n" +
      "🕒 " + hhmm(e.lastIncomingTs) + "\n";
    if (e.count > 1) body += "📬 " + e.count + " sebutan belum dibalas\n";
    if (info.kind === "reply" && info.ctx && info.ctx.text) {
      body += "\n💬 Pesanmu: " + clip(info.ctx.text, 220);
      body += "\n↪️ Balasan: " + clip(info.text || "(" + info.type + ")", 400);
    } else {
      body += "\n📝 " + clip(info.text || "(" + info.type + ")", 600);
    }
  } else {
    // Chat pribadi belum dibalas.
    const name = info.pushName || store.getContactName(jid) || jidNum(jid);
    body =
      `⏰ Belum kamu balas (${PENDING_MIN} menit)\n` +
      "👤 " + name + "\n" +
      "🕒 " + hhmm(e.lastIncomingTs) + "\n";
    if (e.count > 1) body += "📬 " + e.count + " pesan belum dibalas\n";
    body += "\n📝 " + clip(info.text || "(" + info.type + ")", 600);
  }

  try {
    await sock.sendMessage(ownerJid, { text: body });
    if (OWNER_FORWARD && e.waMsg) {
      // Forward pesan asli (termasuk media) supaya bisa dilihat langsung di HP.
      await sock.sendMessage(ownerJid, { forward: e.waMsg }).catch(() => {});
    }
    console.log(`[wa] notif pending (${PENDING_MIN}m) ${info.isGroup ? "grup" : "pribadi"} jid=${jidNum(jid)}`);
  } catch (err) {
    console.error("[wa] notif pending gagal:", err.message);
  }
}

let sweepTimer = null;

async function start() {
  await loadBaileys();
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false, // biar notifikasi tetap masuk ke HP
    syncFullHistory: true,      // minta history sebanyak yang WhatsApp izinkan
    logger: pino({ level: "silent" }),
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      status.qr = await qrcode.toDataURL(qr).catch(() => null);
      console.log("[wa] QR baru tersedia — buka UI lalu scan.");
    }
    if (connection === "open") {
      status.connected = true;
      status.reconnecting = false;
      status.qr = null;
      status.me = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      status.meLid = sock.user?.lid || null; // mis. "230270494085251:5@lid"
      console.log("[wa] Terhubung sebagai " + status.me + (status.meLid ? " (lid " + status.meLid + ")" : ""));
    }
    if (connection === "close") {
      status.connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("[wa] Koneksi tertutup. status=" + code + " reconnect=" + !loggedOut);
      if (!loggedOut) {
        status.reconnecting = true;
        setTimeout(() => start().catch((e) => console.error("[wa] reconnect gagal:", e.message)), 3000);
      } else {
        status.reconnecting = false;
        console.log("[wa] Logged out. Hapus folder auth lalu scan ulang.");
        status.qr = null;
      }
    }
  });

  // Sinkronisasi history awal (terbatas dari WhatsApp)
  sock.ev.on("messaging-history.set", ({ chats = [], contacts = [], messages = [] }) => {
    for (const c of contacts) {
      store.upsertContact(c.id, c.name || c.notify || c.verifiedName || "");
    }
    for (const c of chats) {
      if (c.name) store.setChatName(c.id, c.name);
    }
    for (const m of messages) storeWAMessage(m);
    status.lastHistoryAt = Date.now();
    status.syncedMessages += messages.length;
    console.log(`[wa] history sync: ${chats.length} chat, ${messages.length} pesan, ${contacts.length} kontak`);
  });

  // Pesan masuk / keluar real-time
  sock.ev.on("messages.upsert", ({ messages, type }) => {
    for (const m of messages) {
      // Edit / hapus bisa datang sbg protocolMessage di sini (mis. edit dari HP) ATAU sbg
      // messages.update (mis. dari WA Web). Tangani di kedua jalur supaya tak ada yg lewat
      // (idempoten bila kena dua-duanya).
      const pm = findProtocolMsg(m.message);
      const tgt = m.key?.remoteJid;
      if (pm && pm.key?.id && tgt) {
        if (pm.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT) {
          const { text } = extractContent(pm.editedMessage || {});
          if (text) store.editMessageText(tgt, pm.key.id, text);
          continue;
        }
        if (pm.type === proto.Message.ProtocolMessage.Type.REVOKE) {
          store.markDeleted(tgt, pm.key.id);
          continue;
        }
      }
      const info = storeWAMessage(m);
      // type "notify" = pesan benar-benar baru (bukan "append" hasil sync lama).
      // Grup (tag/reply) maupun chat pribadi sama-sama lewat pelacak "belum
      // dibalas": diforward ke nomor tujuan hanya bila tak kutanggapi dalam
      // PENDING_MIN menit (lihat trackPending/sweepPending).
      if (type === "notify" && info) {
        trackPending(m, info);
      }
    }
    status.lastActivityAt = Date.now();
  });

  // Pesan diedit / DIHAPUS → Baileys emit messages.update.
  //  - edit  : update.message.editedMessage + key.id = id pesan ASLI → perbarui teks.
  //  - hapus : update.messageStubType = REVOKE (delete-for-everyone), key.id = id pesan
  //            dihapus → tandai deleted (konten asli tetap, anti-delete).
  sock.ev.on("messages.update", (updates) => {
    for (const u of updates || []) {
      const jid = u.key?.remoteJid, id = u.key?.id;
      if (!jid || !id) continue;
      if (WAMessageStubType && u.update?.messageStubType === WAMessageStubType.REVOKE) {
        store.markDeleted(jid, id);
        continue;
      }
      const em = u.update?.message?.editedMessage?.message;
      if (!em) continue;
      const { text } = extractContent(em);
      if (text) store.editMessageText(jid, id, text);
    }
  });

  // Update kontak & metadata
  sock.ev.on("contacts.upsert", (cs) => {
    for (const c of cs) store.upsertContact(c.id, c.name || c.notify || c.verifiedName || "");
  });
  sock.ev.on("contacts.update", (cs) => {
    for (const c of cs) if (c.id) store.upsertContact(c.id, c.name || c.notify || "");
  });
  sock.ev.on("chats.upsert", (cs) => {
    for (const c of cs) if (c.name) store.setChatName(c.id, c.name);
  });

  // Penyapu pengingat "belum dibalas" — dijalankan sekali (tahan reconnect).
  // Aktif bila jalur grup ATAU jalur pribadi dinyalakan.
  if ((OWNER_PENDING_NOTIFY || OWNER_NOTIFY) && !sweepTimer) {
    sweepTimer = setInterval(sweepPending, 30000);
    if (sweepTimer.unref) sweepTimer.unref();
  }
}

// Bangun objek 'quoted' untuk Baileys: pakai pesan asli dari cache bila ada,
// kalau tidak rekonstruksi stub minimal dari DB (kutipan tampil sebagai teks).
// srcJid = jid chat ASAL pesan yang dikutip. Beda dari `jid` (tujuan kirim) hanya pada
// "balas pribadi": pesan asli ada di GRUP tapi dikirim ke chat PRIBADI. Memakai remoteJid
// chat asal membuat Baileys menyusun quote lintas-chat (contextInfo.remoteJid) → WA asli
// menampilkan kutipan (reply-privately). Bila pesan masih di cache, pakai aslinya (termasuk media).
function buildQuoted(jid, quotedId, srcJid) {
  if (!quotedId) return undefined;
  const cached = msgCache.get(quotedId);
  if (cached) return cached;
  const lookupJid = srcJid || jid;
  const row = store.getMessageById(lookupJid, quotedId);
  if (!row) return undefined;
  const isGroup = lookupJid.endsWith("@g.us");
  return {
    key: {
      remoteJid: lookupJid,
      fromMe: !!row.from_me,
      id: quotedId,
      participant: isGroup ? row.sender || undefined : undefined,
    },
    message: { conversation: row.text || "" },
  };
}

// Edit pesan SENDIRI (WhatsApp: hanya pesan sendiri & <15 menit). key = pesan asli.
async function editMessage(jid, id, text) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!jid || !id || !text) throw new Error("jid, id, text wajib");
  const sent = await sock.sendMessage(jid, { text, edit: { remoteJid: jid, fromMe: true, id } });
  return sent?.key?.id || null;
}

// mentions = array jid anggota yang di-tag (mis. ["62812…@s.whatsapp.net"] atau ["…@lid"]).
// Teks harus memuat "@<nomor>" yang cocok dengan tiap jid (lihat getComposeText di frontend).
async function sendMessage(jid, text, quotedId, quotedJid, mentions) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  const opts = {};
  const quoted = buildQuoted(jid, quotedId, quotedJid);
  if (quoted) opts.quoted = quoted;
  const content = { text };
  if (Array.isArray(mentions) && mentions.length) content.mentions = mentions;
  const sent = await sock.sendMessage(jid, content, opts);
  return sent?.key?.id || null;
}

// Kirim foto / video / dokumen. buffer = isi file (Buffer),
// kind = "image" | "video" | "document". fileName dipakai untuk dokumen/arsip.
async function sendMedia(jid, kind, buffer, mimetype, caption, quotedId, fileName, quotedJid, mentions) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!buffer || !buffer.length) throw new Error("file kosong");
  let content;
  if (kind === "image") {
    content = { image: buffer, mimetype: mimetype || "image/jpeg" };
  } else if (kind === "video") {
    content = { video: buffer, mimetype: mimetype || "video/mp4" };
  } else if (kind === "document") {
    content = {
      document: buffer,
      mimetype: mimetype || "application/octet-stream",
      fileName: fileName || "dokumen",
    };
  } else {
    throw new Error("tipe media tidak didukung");
  }
  if (caption) content.caption = caption;
  // Mention hanya bermakna bila ada caption (teks yang memuat "@<nomor>").
  if (caption && Array.isArray(mentions) && mentions.length) content.mentions = mentions;
  const opts = {};
  const quoted = buildQuoted(jid, quotedId, quotedJid);
  if (quoted) opts.quoted = quoted;
  const sent = await sock.sendMessage(jid, content, opts);
  return sent?.key?.id || null;
}

// Kirim stiker (buffer WebP — mis. dari favorit yang tersimpan; sudah format stiker WA
// jadi tak perlu konversi). Bisa membalas pesan lain (quotedId).
async function sendSticker(jid, buffer, quotedId, quotedJid) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!buffer || !buffer.length) throw new Error("stiker kosong");
  const opts = {};
  const quoted = buildQuoted(jid, quotedId, quotedJid);
  if (quoted) opts.quoted = quoted;
  const sent = await sock.sendMessage(jid, { sticker: buffer }, opts);
  return sent?.key?.id || null;
}

// Download & dekripsi media resolusi penuh berdasarkan id pesan.
// Sumber pesan: cache memori dulu, lalu fallback ke 'raw' tersimpan di DB
// (didekode dari WebMessageInfo) agar tetap bisa lintas restart.
// Return { buffer, mimetype } atau null bila pesan tak ditemukan sama sekali.
async function downloadMedia(jid, id) {
  let waMsg = msgCache.get(id);
  if (!waMsg) {
    const raw = store.getMessageRaw(jid, id);
    if (raw) {
      try { waMsg = proto.WebMessageInfo.decode(Buffer.from(raw, "base64")); } catch (e) { /* korup */ }
    }
  }
  if (!waMsg || !waMsg.message) return null;
  const media = extractMedia(waMsg.message);
  const doc = media ? null : extractDoc(waMsg.message);
  const mimetype = media ? media.mime : (doc ? doc.mime : "application/octet-stream");
  const fileName = doc ? doc.fileName : "";
  const buffer = await downloadMediaMessage(
    waMsg,
    "buffer",
    {},
    { logger: pino({ level: "silent" }), reuploadRequest: sock?.updateMediaMessage }
  );
  return { buffer, mimetype, fileName };
}

// Daftar anggota grup untuk fitur tag (@mention). Hasil di-cache singkat agar tidak
// memanggil groupMetadata berulang saat user mengetik "@". Tiap anggota: { id, num, name,
// admin }. Pengaddressan (id) dipakai apa adanya dari WhatsApp — bila grup pakai @lid maka
// id ber-@lid, dan itulah yang harus masuk ke array `mentions` saat kirim supaya orangnya
// benar-benar ke-notif. Nama diambil via nomor (cocok untuk @lid maupun @s.whatsapp.net).
const groupMetaCache = new Map(); // jid -> { at, members }
const GROUP_META_TTL = 60000;     // 1 menit
async function getGroupMembers(jid) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!jid || !jid.endsWith("@g.us")) return [];
  const cached = groupMetaCache.get(jid);
  if (cached && Date.now() - cached.at < GROUP_META_TTL) return cached.members;
  const meta = await sock.groupMetadata(jid);
  const me = new Set([jidNum(status.me), jidNum(status.meLid)].filter(Boolean));
  const members = [];
  for (const p of meta.participants || []) {
    const id = p.id;
    if (!id) continue;
    const num = jidNum(id);
    if (me.has(num)) continue; // jangan tampilkan diri sendiri
    const name = store.contactNameByNum(num) || num;
    members.push({ id, num, name, admin: p.admin || "" });
  }
  members.sort((a, b) => a.name.localeCompare(b.name, "id"));
  groupMetaCache.set(jid, { at: Date.now(), members });
  return members;
}

// Petakan jid @lid (alamat tersembunyi anggota grup) → jid nomor asli (@s.whatsapp.net),
// pakai mapping LID↔PN yang dipelihara Baileys. Return "" bila tak ada mapping.
// jid @s.whatsapp.net dikembalikan apa adanya; selain itu "".
async function resolveLidToPn(jid) {
  if (!sock || !jid) return "";
  if (jid.endsWith("@s.whatsapp.net")) return jid;
  if (!jid.endsWith("@lid")) return "";
  try {
    const norm = jidNormalizedUser(jid); // buang suffix device → user@lid
    const pn = await sock.signalRepository?.lidMapping?.getPNForLID(norm);
    return pn ? jidNormalizedUser(pn) : ""; // getPNForLID balikin pakai suffix device → bersihkan jadi nomor@s.whatsapp.net
  } catch (e) { return ""; }
}

// Normalisasi nomor: ambil digit, awalan "0" → "62" (default Indonesia).
function normNum(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "62" + d.slice(1);
  return d;
}
// Cek apakah nomor terdaftar di WhatsApp + ambil jid kanoniknya (untuk "chat baru").
// Return { exists, jid } atau { exists:false }.
async function checkNumber(num) {
  if (!sock || !status.connected) return { exists: false, error: "WhatsApp belum terhubung" };
  const d = normNum(num);
  if (d.length < 7) return { exists: false };
  try {
    const res = await sock.onWhatsApp(d);
    const hit = Array.isArray(res) ? res.find((r) => r && r.exists) : null;
    if (hit) return { exists: true, jid: jidNormalizedUser(hit.jid) };
    return { exists: false };
  } catch (e) { return { exists: false, error: e.message }; }
}

// URL foto profil sebuah jid (kontak/grup). "preview" = thumbnail kecil (ringan, cukup
// untuk avatar di list); null bila tak ada foto / privasi / belum siap. Tak melempar.
async function getAvatarUrl(jid, kind) {
  if (!sock || !status.connected || !jid) return null;
  try {
    return await sock.profilePictureUrl(jid, kind === "full" ? "image" : "preview");
  } catch (e) {
    return null;
  }
}

function getStatus() {
  const syncing = Date.now() - status.lastHistoryAt < SYNC_WINDOW_MS;
  return {
    connected: status.connected,
    qr: status.qr,
    me: status.me,
    meLid: status.meLid,
    reconnecting: status.reconnecting,
    syncing,
    syncedMessages: status.syncedMessages,
    lastActivityAt: status.lastActivityAt,
  };
}

module.exports = { start, sendMessage, sendMedia, sendSticker, editMessage, downloadMedia, getAvatarUrl, resolveLidToPn, checkNumber, getGroupMembers, getStatus };

// Hook uji internal — hanya aktif saat WA_TEST=1 (tidak memengaruhi produksi).
if (process.env.WA_TEST === "1") {
  module.exports._test = {
    status,
    loadBaileys,   // hanya dynamic import (memuat proto), TIDAK membuka koneksi
    mentionKind,
    storeWAMessage,
    trackPending,
    sweepPending,
    notifyPending,
    pendingReply,
    PENDING_MIN,
    setSock: (s) => { sock = s; },
  };
}
