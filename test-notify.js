"use strict";
// Uji logika pengingat "belum dibalas" (chat pribadi & sebutan di grup) tanpa
// koneksi WA nyata. Pakai DB sementara + socket tiruan.
// Jalankan: WA_TEST=1 node test-notify.js
process.env.WA_TEST = "1";
process.env.DB_PATH = require("path").resolve(__dirname, "data/_test_notify.db");

const fs = require("fs");
try { fs.unlinkSync(process.env.DB_PATH); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}

const wa = require("./src/wa");
const {
  status, mentionKind, storeWAMessage, setSock,
  trackPending, sweepPending, pendingReply, PENDING_MIN,
} = wa._test;

// --- identitas-ku (seperti saat connection open) ---
status.connected = true;
status.me = "6287858849679@s.whatsapp.net";
status.meLid = "230270494085251:5@lid";

// --- socket tiruan: rekam semua sendMessage ---
const sent = [];
setSock({
  sendMessage: async (jid, content) => {
    sent.push({ jid, content });
    return { key: { id: "FAKE" + sent.length } };
  },
});

const GROUP = "120363000000000000@g.us";
const ME_TEL = "6287858849679@s.whatsapp.net";
const OTHER = "6281111111111@s.whatsapp.net";
const ts = Math.floor(Date.now() / 1000);

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg); } };

// Mundurkan streak entry seolah sudah lewat ambang, lalu sweep + tunggu promise.
async function fastForwardAndSweep(jid) {
  const e = pendingReply.get(jid);
  if (e) e.streakStartTs = ts - (PENDING_MIN * 60 + 5);
  sweepPending();
  await new Promise((r) => setTimeout(r, 30));
}

async function run() {
  // ---------- Kasus 1: di-tag pakai LID di grup -> tunda, baru forward ----------
  console.log("\n[1] Di-tag (mention LID) di grup — jalur tunda");
  sent.length = 0; pendingReply.clear();
  const tagMsg = {
    key: { remoteJid: GROUP, fromMe: false, id: "TAG1", participant: OTHER },
    pushName: "Budi",
    messageTimestamp: ts,
    message: {
      extendedTextMessage: {
        text: "@230270494085251 tolong cek ya",
        contextInfo: { mentionedJid: ["230270494085251@lid"] },
      },
    },
  };
  ok(mentionKind(tagMsg.message, null) === "tag", "mentionKind = tag (cocok via LID)");
  const info1 = storeWAMessage(tagMsg);
  ok(info1 && info1.kind === "tag" && info1.isGroup, "storeWAMessage info kind=tag, isGroup");
  trackPending(tagMsg, info1);
  ok(pendingReply.has(GROUP), "entry pending terbuat utk grup");
  sweepPending(); // belum lewat ambang
  ok(sent.length === 0, "sebelum " + PENDING_MIN + " menit: belum ada notif");
  await fastForwardAndSweep(GROUP);
  ok(sent.length >= 1 && sent[0].jid === ME_TEL, "notif terkirim ke nomor sendiri");
  ok(sent[0].content.text.includes("Tag di grup") && sent[0].content.text.includes("belum kamu balas"), "teks notif: tag di grup belum dibalas");
  ok(sent[0].content.text.includes("Budi"), "teks notif berisi nama pengirim (Budi)");
  ok(sent.length === 2 && sent[1].content.forward === tagMsg, "pesan asli ikut di-forward");
  ok(!pendingReply.has(GROUP), "entry grup dihapus setelah notif");

  // ---------- Kasus 2: balas pesanku di grup -> tunda, baru forward ----------
  console.log("\n[2] Balas pesanku (reply) di grup — jalur tunda");
  sent.length = 0; pendingReply.clear();
  const replyMsg = {
    key: { remoteJid: GROUP, fromMe: false, id: "REP1", participant: OTHER },
    pushName: "Sari",
    messageTimestamp: ts,
    message: {
      extendedTextMessage: {
        text: "Sudah aku kerjakan bos",
        contextInfo: {
          stanzaId: "MYMSG1",
          participant: "230270494085251:5@lid", // pesan yg dibalas dikirim oleh LID-ku
          quotedMessage: { conversation: "Tolong selesaikan laporan" },
        },
      },
    },
  };
  const ctx2 = { id: "MYMSG1", sender: "230270494085251:5@lid", text: "Tolong selesaikan laporan" };
  ok(mentionKind(replyMsg.message, ctx2) === "reply", "mentionKind = reply (quoted_sender = LID-ku)");
  const info2 = storeWAMessage(replyMsg);
  ok(info2 && info2.kind === "reply", "storeWAMessage info kind=reply");
  trackPending(replyMsg, info2);
  await fastForwardAndSweep(GROUP);
  ok(sent.length >= 1 && sent[0].content.text.includes("Balasan di grup"), "teks notif: balasan di grup");
  ok(sent[0].content.text.includes("Pesanmu") && sent[0].content.text.includes("laporan"), "notif tampilkan kutipan pesanku");

  // ---------- Kasus 3: pesan grup biasa (bukan tag/reply) -> TIDAK dilacak ----------
  console.log("\n[3] Pesan grup biasa (tanpa sebutan)");
  sent.length = 0; pendingReply.clear();
  const plain = {
    key: { remoteJid: GROUP, fromMe: false, id: "PLAIN1", participant: OTHER },
    pushName: "Budi", messageTimestamp: ts,
    message: { conversation: "halo semua" },
  };
  trackPending(plain, storeWAMessage(plain));
  ok(pendingReply.size === 0, "pesan grup biasa tidak membuat entry pending");

  // ---------- Kasus 4: di-tag di grup lalu aku balas di grup -> entry bersih ----------
  console.log("\n[4] Di-tag di grup lalu aku kirim ke grup (fromMe) -> bersih");
  sent.length = 0; pendingReply.clear();
  trackPending(tagMsg, storeWAMessage(tagMsg));
  ok(pendingReply.has(GROUP), "pending grup terbuat");
  const myGroupMsg = { key: { remoteJid: GROUP, fromMe: true, id: "GMINE1" }, messageTimestamp: ts + 10, message: { conversation: "siap, aku cek" } };
  trackPending(myGroupMsg, storeWAMessage(myGroupMsg));
  ok(!pendingReply.has(GROUP), "pending grup dihapus setelah aku menanggapi di grup");
  sweepPending();
  ok(sent.length === 0, "tidak ada notif untuk grup yang sudah kutanggapi");

  // ---------- Kasus 5: re-remind — sebutan baru setelah notif memulai streak baru ----------
  console.log("\n[5] Sebutan baru setelah notif memulai streak baru");
  sent.length = 0; pendingReply.clear();
  trackPending(tagMsg, info1);
  await fastForwardAndSweep(GROUP);
  ok(sent.length >= 1, "notif pertama terkirim");
  ok(!pendingReply.has(GROUP), "entry bersih setelah notif");
  const tag2 = { key: { remoteJid: GROUP, fromMe: false, id: "TAG2", participant: OTHER }, pushName: "Budi", messageTimestamp: ts, message: { extendedTextMessage: { text: "@230270494085251 halo lagi", contextInfo: { mentionedJid: ["230270494085251@lid"] } } } };
  trackPending(tag2, storeWAMessage(tag2));
  ok(pendingReply.has(GROUP), "sebutan baru memulai streak baru (entry terbuat lagi)");

  // ---------- Kasus 6: pesanku sendiri (fromMe) di grup -> tidak dilacak ----------
  console.log("\n[6] Pesan dari diriku sendiri di grup (tanpa entry awal)");
  sent.length = 0; pendingReply.clear();
  const mine = {
    key: { remoteJid: GROUP, fromMe: true, id: "MINE1" },
    messageTimestamp: ts,
    message: { extendedTextMessage: { text: "@6281111111111 oke", contextInfo: { mentionedJid: ["6281111111111@s.whatsapp.net"] } } },
  };
  trackPending(mine, storeWAMessage(mine));
  ok(pendingReply.size === 0, "pesan dari diri sendiri tidak membuat entry");

  // ---------- Kasus 7: chat pribadi belum dibalas 5 menit -> notif pengingat ----------
  console.log("\n[7] Chat pribadi belum dibalas " + PENDING_MIN + " menit");
  sent.length = 0; pendingReply.clear();
  const pmsg = {
    key: { remoteJid: OTHER, fromMe: false, id: "PEND1" },
    pushName: "Andi", messageTimestamp: ts,
    message: { conversation: "Pak, invoice nya gimana?" },
  };
  const pinfo = storeWAMessage(pmsg);
  trackPending(pmsg, pinfo);
  ok(pendingReply.has(OTHER), "entry pending terbuat utk chat pribadi");
  sweepPending(); // belum 5 menit
  ok(sent.length === 0, "sebelum " + PENDING_MIN + " menit: belum ada pengingat");
  await fastForwardAndSweep(OTHER);
  ok(sent.length >= 1 && sent[0].jid === ME_TEL, "pengingat terkirim ke nomor sendiri");
  ok(sent[0].content.text.includes("Belum kamu balas"), "teks berisi 'Belum kamu balas'");
  ok(sent[0].content.text.includes("Andi"), "teks berisi nama kontak (Andi)");
  ok(!pendingReply.has(OTHER), "entry dihapus setelah pengingat terkirim");

  // ---------- Kasus 8: chat pribadi yang sudah dibalas -> tidak ada pengingat ----------
  console.log("\n[8] Chat pribadi sudah dibalas sebelum " + PENDING_MIN + " menit");
  sent.length = 0; pendingReply.clear();
  const inMsg = { key: { remoteJid: OTHER, fromMe: false, id: "IN2" }, pushName: "Andi", messageTimestamp: ts, message: { conversation: "halo pak" } };
  trackPending(inMsg, storeWAMessage(inMsg));
  ok(pendingReply.has(OTHER), "pending terbuat");
  const myReply = { key: { remoteJid: OTHER, fromMe: true, id: "OUT2" }, messageTimestamp: ts + 10, message: { conversation: "iya halo" } };
  trackPending(myReply, storeWAMessage(myReply));
  ok(!pendingReply.has(OTHER), "pending dihapus setelah aku membalas");
  sweepPending();
  ok(sent.length === 0, "tidak ada pengingat untuk chat yang sudah dibalas");

  // ---------- Kasus 9: chat ke diri sendiri tidak dilacak ----------
  console.log("\n[9] Chat ke diri sendiri tidak dilacak");
  pendingReply.clear();
  const selfm = { key: { remoteJid: ME_TEL, fromMe: false, id: "S9" }, messageTimestamp: ts, message: { conversation: "catatan" } };
  trackPending(selfm, storeWAMessage(selfm));
  ok(pendingReply.size === 0, "chat diri sendiri tidak membuat entry pending");

  console.log(`\n=== HASIL: ${pass} lulus, ${fail} gagal ===`);
  try { fs.unlinkSync(process.env.DB_PATH); } catch {}
  try { fs.unlinkSync(process.env.DB_PATH + "-wal"); } catch {}
  try { fs.unlinkSync(process.env.DB_PATH + "-shm"); } catch {}
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
