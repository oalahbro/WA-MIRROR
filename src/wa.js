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
let pairingMode = false;        // true saat mode pairing code (ganti scan QR)
let pairingPhone = null;        // nomor HP (digit) saat pairing code
let pairingCodePending = false; // true saat requestPairingCode sedang berjalan (cegah double-call)
let ignoreNextClose = false;    // cegah auto-reconnect saat sengaja restart socket

const status = {
  connected: false,
  qr: null,
  pairingCode: null,  // kode 8 karakter saat mode pairing code aktif
  pairingError: null, // error dari WA saat minta pairing code (mis. 429 rate-overlimit)
  loggedOut: false,   // true setelah DisconnectReason.loggedOut — auth stale, perlu fresh-pair
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
  // deviceSentMessage = pesan dari device kita yang lain (mis. edit/hapus dari HP sendiri).
  if (message.deviceSentMessage?.message) return findProtocolMsg(message.deviceSentMessage.message);
  if (message.editedMessage?.message) return findProtocolMsg(message.editedMessage.message);
  if (message.ephemeralMessage?.message) return findProtocolMsg(message.ephemeralMessage.message);
  if (message.viewOnceMessage?.message) return findProtocolMsg(message.viewOnceMessage.message);
  if (message.viewOnceMessageV2?.message) return findProtocolMsg(message.viewOnceMessageV2.message);
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
    // chat asal pesan yg dikutip. Diisi Baileys saat kutipan LINTAS-CHAT (mis. "balas
    // pribadi": pesan asli di grup, dikirim ke DM). Kosong untuk reply biasa (satu chat).
    chat: ctx.remoteJid || "",
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

// ---------- Kanonikalisasi LID <-> nomor (PN) untuk chat DM ----------
// WhatsApp bisa mengalamati orang yang sama sebagai <num>@s.whatsapp.net (PN) DAN
// <lidnum>@lid (LID) → tanpa penyatuan, satu kontak jadi DUA chat. Chat DM kita simpan
// kanonik ke PN. Lookup di jalur panas HARUS sinkron (getPNForLID Baileys async), jadi
// pakai Map in-memory yang di-prime dari tabel lid_map + event lid-mapping.update.
const lidToPn = new Map(); // nomor-bare-LID -> "<num>@s.whatsapp.net"

// SINKRON. PN / @g.us / status passthrough. @lid -> PN bila mapping diketahui; bila
// belum → biarkan @lid (digabung nanti saat mapping dipelajari; merge idempoten).
function canonicalDmJid(jid) {
  if (!jid || !jid.endsWith("@lid")) return jid;
  return lidToPn.get(jidNum(jid)) || jid;
}

// Pelajari satu pasangan LID<->PN: simpan ke Map + DB; bila baru, gabungkan chat @lid
// yang mungkin sudah kepecah ke chat PN-nya.
function learnLidMapping(lidJid, pnJid) {
  if (!lidJid || !pnJid) return;
  const lidNum = jidNum(lidJid);
  const pn = jidNormalizedUser ? jidNormalizedUser(pnJid) : pnJid;
  if (!lidNum || !pn || !pn.endsWith("@s.whatsapp.net")) return;
  const prev = lidToPn.get(lidNum);
  lidToPn.set(lidNum, pn);
  store.upsertLidMap(lidNum, pn);
  if (prev !== pn) {
    try { store.mergeChat(lidNum + "@lid", pn); }
    catch (e) { console.error("[wa] mergeChat:", e.message); }
  }
}

// Panen pasangan LID<->nomor dari dua jid apa pun (mis. key.participant + key.participantAlt,
// atau key.remoteJid + key.remoteJidAlt) — WhatsApp menyertakan alt PN pada pesan ber-LID.
// Ini sumber pemetaan yang ANDAL & tanpa jaringan (lebih lengkap dari getPNForLID lokal).
function harvestJidPair(a, b) {
  if (!a || !b) return;
  if (a.endsWith("@lid") && b.endsWith("@s.whatsapp.net")) learnLidMapping(a, b);
  else if (b.endsWith("@lid") && a.endsWith("@s.whatsapp.net")) learnLidMapping(b, a);
}

// Saat connect: prime Map dari DB + gabung yang sudah diketahui, lalu sweep async semua
// chat @lid tersisa lewat resolveLidToPn (lokal, tanpa jaringan) untuk temukan PN-nya.
function primeLidMap() {
  try {
    for (const r of store.allLidMap()) {
      lidToPn.set(r.lid_num, r.pn_jid);
      store.mergeChat(r.lid_num + "@lid", r.pn_jid);
    }
  } catch (e) { console.error("[wa] prime lid_map:", e.message); }
  (async () => {
    let merged = 0;
    for (const jid of store.lidDmChats()) {
      try {
        const pn = await resolveLidToPn(jid); // getPNForLID: lokal, "" bila tak diketahui
        if (pn) { learnLidMapping(jid, pn); merged++; }
      } catch (e) { /* lanjut chat berikutnya */ }
    }
    if (merged) console.log("[wa] LID sweep: " + merged + " chat @lid digabung ke nomor");
  })().catch((e) => console.error("[wa] LID sweep:", e.message));
}

// Simpan satu pesan WhatsApp ke DB. Lewati pesan kontrol/kosong.
// Return info ringkas { jid, fromMe, isGroup, kind, text, type, sender, ctx,
// timestamp } untuk dipakai pemanggil (mis. notifikasi owner), atau null
// bila pesan dilewati.
function storeWAMessage(waMsg) {
  if (!waMsg || !waMsg.key || !waMsg.message) return null;
  const jid = waMsg.key.remoteJid;
  if (!jid || jid === "status@broadcast") return null;
  // Panen pemetaan LID<->nomor dari key pesan (alt fields). Dilakukan SEBELUM
  // kanonikalisasi agar pesan ini pun langsung dipetakan ke nomor bila mungkin.
  harvestJidPair(waMsg.key.remoteJid, waMsg.key.remoteJidAlt);
  harvestJidPair(waMsg.key.participant, waMsg.key.participantAlt);
  // Kanonikalisasi DM @lid -> nomor (PN) agar satu kontak = satu chat.
  const chatJid = canonicalDmJid(jid);

  const { text, type } = extractContent(waMsg.message);
  if (type === "protocol") return null;     // delete/receipt, bukan pesan nyata
  if (type === "reaction") return null;     // reaksi emoji → ditangani lewat event messages.reaction
  if (!text && type !== "image" && type !== "video") return null;

  const rawSender = waMsg.key.fromMe
    ? status.me || ""
    : waMsg.key.participant || jid; // di grup, participant = pengirim
  // Kanonikalisasi sender HANYA untuk DM. Di grup, participant @lid HARUS tetap mentah
  // (dipakai untuk deteksi tag/mention & pencocokan nama anggota).
  const sender = jid.endsWith("@g.us") ? rawSender : canonicalDmJid(rawSender);

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
    chat_jid: chatJid,
    id: waMsg.key.id,
    sender,
    from_me: !!waMsg.key.fromMe,
    text,
    type,
    timestamp,
    chat_name: (!waMsg.key.fromMe && !chatJid.endsWith("@g.us")) ? waMsg.pushName || "" : "",
    thumb,
    media_mime,
    quoted_id: ctx?.id || "",
    quoted_text: ctx?.text || "",
    quoted_sender: ctx?.sender || "",
    quoted_chat: canonicalDmJid(ctx?.chat || ""), // chat asal (kutipan lintas-chat) → kanonik

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
    jid: chatJid,
    fromMe: !!waMsg.key.fromMe,
    isGroup: chatJid.endsWith("@g.us"),
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
  // Pastikan folder auth ada sebelum useMultiFileAuthState — terutama setelah
  // setPairingMode menghapusnya. saveCreds() crash ENOENT bila folder tidak ada.
  require("fs").mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    markOnlineOnConnect: false, // biar notifikasi tetap masuk ke HP
    syncFullHistory: true,      // minta history sebanyak yang WhatsApp izinkan
    usePairingCode: pairingMode, // true = pakai kode 8 char, bukan scan QR
    // Level log Baileys via .env (default silent). Set WA_LOG_LEVEL=warn/debug
    // sementara untuk diagnosa (mis. konteks gagal decrypt / Bad MAC), lalu balikin.
    logger: pino({ level: process.env.WA_LOG_LEVEL || "silent" }),
    getMessage: async () => undefined,
  });

  sock.ev.on("creds.update", saveCreds);

  // Pelajari pemetaan LID<->nomor saat Baileys menemukannya (contact sync / pnForLid /
  // linked-profiles) → mengkanonikalisasi & menggabungkan chat DM yang kepecah.
  sock.ev.on("lid-mapping.update", (u) => {
    try {
      const items = Array.isArray(u) ? u : [u];
      for (const it of items) if (it) learnLidMapping(it.lid, it.pn);
    } catch (e) { console.error("[wa] lid-mapping.update:", e.message); }
  });

  sock.ev.on("connection.update", async (u) => {
    const { connection, lastDisconnect, qr } = u;
    if (qr) {
      if (pairingMode && pairingPhone) {
        // Event qr = sinyal socket sudah connect ke server WA dan siap pairing.
        // Hanya panggil sekali — QR bisa fire berulang tiap ~20 detik (expire),
        // tanpa guard ini requestPairingCode terpanggil terus → kode ganti-ganti → HP loop.
        if (!pairingCodePending && !status.pairingCode) {
          pairingCodePending = true;
          console.log("[wa] Minta pairing code untuk JID: " + pairingPhone + "@s.whatsapp.net");
          // Tangkap error IQ dari WA (mis. 429 rate-overlimit saat terlalu banyak
          // pairing code di-request dalam waktu singkat). Baileys pakai sendNode
          // (fire-and-forget), jadi error response perlu di-intercept manual.
          if (!sock.__pairingErrHooked) {
            sock.__pairingErrHooked = true;
            sock.ws.on("CB:iq,,", (node) => {
              if (node?.attrs?.type === "error") {
                const errNode = (node.content || []).find((c) => c.tag === "error");
                const code = errNode?.attrs?.code;
                const text = errNode?.attrs?.text || "unknown";
                console.error("[wa] Pairing IQ error dari WA: code=" + code + " text=" + text);
                if (code === "429" || text === "rate-overlimit") {
                  status.pairingCode = null;
                  status.pairingError = "Rate limit WA — terlalu banyak percobaan. Tunggu beberapa jam lalu coba lagi.";
                  pairingCodePending = false;
                }
              }
            });
          }
          sock.requestPairingCode(pairingPhone)
            .then((code) => {
              status.pairingCode = code;
              pairingCodePending = false;
              console.log("[wa] Pairing code tersedia: " + code);
            })
            .catch((e) => {
              pairingCodePending = false;
              console.error("[wa] requestPairingCode gagal:", e.message);
            });
        }
      } else {
        status.qr = await qrcode.toDataURL(qr).catch(() => null);
        console.log("[wa] QR baru tersedia — buka UI lalu scan.");
      }
    }
    if (connection === "open") {
      status.connected = true;
      status.reconnecting = false;
      status.qr = null;
      status.pairingCode = null;
      status.pairingError = null;
      status.loggedOut = false;
      pairingMode = false;
      pairingPhone = null;
      status.me = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
      status.meLid = sock.user?.lid || null; // mis. "230270494085251:5@lid"
      console.log("[wa] Terhubung sebagai " + status.me + (status.meLid ? " (lid " + status.meLid + ")" : ""));
      primeLidMap(); // prime peta LID<->nomor + gabung chat DM yang kepecah
    }
    if (connection === "close") {
      status.connected = false;
      if (ignoreNextClose) { ignoreNextClose = false; return; }
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      console.log("[wa] Koneksi tertutup. status=" + code + " reconnect=" + !loggedOut);
      if (!loggedOut) {
        status.reconnecting = true;
        setTimeout(() => start().catch((e) => console.error("[wa] reconnect gagal:", e.message)), 3000);
      } else {
        status.reconnecting = false;
        status.loggedOut = true;
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
      // Edit / hapus bisa datang sbg protocolMessage di sini (mis. dari HP, kadang dibungkus
      // deviceSentMessage) ATAU sbg messages.update (mis. dari WA Web). Tangani di kedua jalur
      // supaya tak ada yang lewat (idempoten bila kena dua-duanya).
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

  // Reaksi emoji. Baileys emit `messages.reaction` = [{ key, reaction }]:
  //  - key       = pesan YANG DIBERI reaksi (key.remoteJid = chat, key.id = id pesan).
  //  - reaction  = { text: emoji ("" = dilepas), key: pesan REAKSI (key.fromMe = aku?,
  //                  key.participant = pe-reaksi di grup), senderTimestampMs }.
  sock.ev.on("messages.reaction", (items) => {
    for (const it of items || []) {
      const chatJid = it.key?.remoteJid;
      const msgId = it.key?.id;
      if (!chatJid || !msgId) continue;
      const rk = it.reaction?.key || {};
      const fromMe = !!rk.fromMe;
      const reactor = fromMe ? (status.me || "me") : (rk.participant || chatJid);
      const ts = toEpoch(it.reaction?.senderTimestampMs);
      store.setReaction({
        chat_jid: chatJid,
        msg_id: msgId,
        reactor,
        from_me: fromMe,
        emoji: it.reaction?.text || "",
        ts,
      });
    }
    status.lastActivityAt = Date.now();
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

// Hapus pesan SENDIRI untuk semua (delete-for-everyone / revoke). WA kirim protocolMessage
// REVOKE ke chat; mirror sendiri tandai `deleted` (sama seperti anti-delete pesan masuk)
// supaya konten asli tetap kebaca di mirror.
async function deleteMessage(jid, id) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!jid || !id) throw new Error("jid, id wajib");
  await sock.sendMessage(jid, { delete: { remoteJid: jid, fromMe: true, id } });
  store.markDeleted(jid, id);
  return true;
}

// Kirim / ubah / lepas reaksi emoji pada sebuah pesan. emoji "" = lepas reaksi.
// Key pesan diambil dari cache (paling akurat, termasuk addressing @lid) atau direkonstruksi
// dari DB. Reaksi-ku langsung dicatat lokal supaya tampil seketika (echo idempoten).
async function sendReaction(jid, id, emoji) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!jid || !id) throw new Error("jid, id wajib");
  let key = msgCache.get(id)?.key;
  if (!key) {
    const row = store.getMessageById(jid, id);
    const isGroup = jid.endsWith("@g.us");
    key = {
      remoteJid: jid,
      fromMe: row ? !!row.from_me : false,
      id,
      participant: isGroup ? row?.sender || undefined : undefined,
    };
  }
  await sock.sendMessage(jid, { react: { text: emoji || "", key } });
  store.setReaction({
    chat_jid: jid, msg_id: id, reactor: status.me || "me",
    from_me: true, emoji: emoji || "", ts: Math.floor(Date.now() / 1000),
  });
  return true;
}

// Info kontak / grup untuk panel detail. Grup: subjek, deskripsi, dibuat, daftar
// anggota (+ admin). Kontak: nomor + "info"/about (via fetchStatus, bila tak privasi).
async function getChatInfo(jid) {
  if (!sock || !status.connected) throw new Error("WhatsApp belum terhubung");
  if (!jid) throw new Error("jid wajib");

  if (jid.endsWith("@g.us")) {
    const meta = await sock.groupMetadata(jid);
    const me = new Set([jidNum(status.me), jidNum(status.meLid)].filter(Boolean));
    const rank = (x) => (x.admin === "superadmin" ? 0 : x.admin ? 1 : 2);
    const participants = (meta.participants || [])
      .map((p) => {
        const num = jidNum(p.id);
        return { id: p.id, num, name: store.contactNameByNum(num) || num, admin: p.admin || "", me: me.has(num) };
      })
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "id"));
    return {
      type: "group",
      jid,
      subject: meta.subject || store.getChatName(jid) || jidNum(jid),
      desc: meta.desc || "",
      creation: toEpoch(meta.creation),
      owner: meta.owner || meta.ownerPn || "",
      size: participants.length,
      participants,
    };
  }

  // Kontak / DM
  const num = jidNum(jid);
  const name = store.getContactName(jid) || store.contactNameByNum(num) || num;
  let about = "", aboutAt = 0;
  try {
    const res = await sock.fetchStatus(jid);
    const first = Array.isArray(res) ? res[0] : res;
    const s = first?.status;
    if (s && typeof s === "object") {
      about = s.status || "";
      if (s.setAt) aboutAt = Math.floor(new Date(s.setAt).getTime() / 1000) || 0;
    } else if (typeof s === "string") {
      about = s;
    }
  } catch (e) { /* privasi / tak tersedia */ }
  return { type: "contact", jid, name, num, about, aboutAt };
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

// Alihkan ke mode pairing code: restart socket dengan usePairingCode:true, lalu
// requestPairingCode akan dipanggil otomatis saat socket siap. Hasil kode tersimpan
// di status.pairingCode dan dikembalikan via /api/status polling.
// Bila sesi sebelumnya sudah logout (status.loggedOut), auth/ dibersihkan dulu agar
// socket bisa memulai registrasi baru — tanpa ini WA server menolak dan "Connection Closed".
async function setPairingMode(phone) {
  if (status.connected) throw new Error("Sudah terhubung ke WhatsApp");
  const digits = String(phone || "").replace(/\D/g, "").replace(/^0/, "62");
  if (digits.length < 7) throw new Error("Nomor HP tidak valid");
  pairingMode = true;
  pairingPhone = digits;
  status.pairingCode = null;
  status.pairingError = null;
  // Selalu hapus auth saat minta pairing code — auth lama (logout, unregistered,
  // atau kode sebelumnya tidak dipakai) bikin WA server reject "Connection Closed".
  const fs = require("fs");
  try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
  status.loggedOut = false;
  console.log("[wa] Auth dihapus untuk fresh pairing.");
  if (sock) {
    ignoreNextClose = true;
    try { sock.end(new Error("pairing mode restart")); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  await start();
}

// Kembali ke mode QR (dari mode pairing code). Restart socket dengan usePairingCode:false.
async function resetToQR() {
  if (status.connected) throw new Error("Sudah terhubung ke WhatsApp");
  pairingMode = false;
  pairingPhone = null;
  status.pairingCode = null;
  if (sock) {
    ignoreNextClose = true;
    try { sock.end(new Error("QR mode restart")); } catch (_) {}
    await new Promise((r) => setTimeout(r, 300));
  }
  await start();
}

function getStatus() {
  const syncing = Date.now() - status.lastHistoryAt < SYNC_WINDOW_MS;
  return {
    connected: status.connected,
    qr: status.qr,
    pairingCode: status.pairingCode,
    pairingError: status.pairingError,
    me: status.me,
    meLid: status.meLid,
    reconnecting: status.reconnecting,
    syncing,
    syncedMessages: status.syncedMessages,
    lastActivityAt: status.lastActivityAt,
  };
}

module.exports = { start, setPairingMode, resetToQR, sendMessage, sendMedia, sendSticker, editMessage, deleteMessage, sendReaction, getChatInfo, downloadMedia, getAvatarUrl, resolveLidToPn, checkNumber, getGroupMembers, getStatus };

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
    canonicalDmJid,
    learnLidMapping,
    lidToPn,
    setSock: (s) => { sock = s; },
  };
}
