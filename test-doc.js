"use strict";
// Uji alur dokumen (simpan/kirim) tanpa koneksi WA nyata. Pakai DB sementara + sock tiruan.
// Jalankan: WA_TEST=1 node test-doc.js
process.env.WA_TEST = "1";
process.env.DB_PATH = require("path").resolve(__dirname, "data/_test_doc.db");

const fs = require("fs");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const wa = require("./src/wa");
const store = require("./src/db");
const { status, storeWAMessage, setSock, loadBaileys } = wa._test;

status.connected = true;
status.me = "6287858849679@s.whatsapp.net";

const sent = [];
setSock({ sendMessage: async (jid, content, opts) => { sent.push({ jid, content, opts }); return { key: { id: "DOCID1" } }; } });

const CHAT = "6281111111111@s.whatsapp.net";
const ts = Math.floor(Date.now() / 1000);
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓ " + m); } else { fail++; console.log("  ✗ " + m); } };

async function run() {
  await loadBaileys(); // memuat proto (utk encode raw) tanpa membuka koneksi WA

  // ---------- 1. Simpan pesan dokumen masuk (PDF) ----------
  console.log("\n[1] Simpan documentMessage (PDF) masuk");
  const docMsg = {
    key: { remoteJid: CHAT, fromMe: false, id: "DOC_IN_1" },
    pushName: "Andi", messageTimestamp: ts,
    message: {
      documentMessage: {
        fileName: "Laporan Q2.pdf",
        mimetype: "application/pdf",
        fileLength: 123456,
        url: "https://mmg.whatsapp.net/x", mediaKey: Buffer.from([1, 2, 3]),
      },
    },
  };
  const info = storeWAMessage(docMsg);
  ok(info && info.type === "document", "info.type = document");
  const row = store.getMessages(CHAT, 0, 10).find((r) => r.id === "DOC_IN_1");
  ok(row && row.type === "document", "tersimpan di DB sebagai document");
  ok(row && row.file_name === "Laporan Q2.pdf", "file_name tersimpan");
  ok(row && row.file_size === 123456, "file_size tersimpan");
  ok(row && row.media_mime === "application/pdf", "media_mime tersimpan");
  const mi = store.getMediaInfo(CHAT, "DOC_IN_1");
  ok(mi && mi.type === "document" && mi.file_name === "Laporan Q2.pdf", "getMediaInfo kembalikan type+file_name");
  ok(store.getMessageRaw(CHAT, "DOC_IN_1").length > 0, "raw (WebMessageInfo) tersimpan utk download lintas-restart");

  // ---------- 2. Simpan arsip masuk (ZIP) lewat documentWithCaptionMessage ----------
  console.log("\n[2] Simpan arsip (ZIP) via documentWithCaptionMessage");
  const zipMsg = {
    key: { remoteJid: CHAT, fromMe: false, id: "DOC_IN_2" },
    pushName: "Andi", messageTimestamp: ts + 1,
    message: {
      documentWithCaptionMessage: {
        message: {
          documentMessage: {
            fileName: "backup.zip", mimetype: "application/zip", fileLength: 999,
            url: "https://mmg.whatsapp.net/y", mediaKey: Buffer.from([4, 5, 6]),
          },
        },
      },
    },
  };
  const info2 = storeWAMessage(zipMsg);
  ok(info2 && info2.type === "document", "ZIP terdeteksi sebagai document");
  const row2 = store.getMessages(CHAT, 0, 10).find((r) => r.id === "DOC_IN_2");
  ok(row2 && row2.file_name === "backup.zip" && row2.media_mime === "application/zip", "nama & mime arsip tersimpan");

  // ---------- 3. Kirim dokumen (sendMedia kind=document) ----------
  console.log("\n[3] Kirim dokumen via sendMedia");
  sent.length = 0;
  const buf = Buffer.from("PK\x03\x04 dummy zip");
  const id = await wa.sendMedia(CHAT, "document", buf, "application/zip", "ini arsipnya", "", "data.zip");
  ok(id === "DOCID1", "sendMedia kembalikan id pesan");
  ok(sent.length === 1, "satu sendMessage dipanggil");
  const c = sent[0].content;
  ok(Buffer.isBuffer(c.document) && c.document.length === buf.length, "konten = document buffer");
  ok(c.fileName === "data.zip", "fileName diteruskan");
  ok(c.mimetype === "application/zip", "mimetype diteruskan");
  ok(c.caption === "ini arsipnya", "caption diteruskan");

  // ---------- 4. Kirim dokumen tanpa nama → fallback ----------
  console.log("\n[4] Kirim dokumen tanpa fileName → fallback");
  sent.length = 0;
  await wa.sendMedia(CHAT, "document", buf, "", "", "");
  ok(sent[0].content.fileName === "dokumen", "fallback fileName = 'dokumen'");
  ok(sent[0].content.mimetype === "application/octet-stream", "fallback mimetype = octet-stream");

  console.log(`\n=== HASIL: ${pass} lulus, ${fail} gagal ===`);
  for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
  process.exit(fail ? 1 : 0);
}
run().catch((e) => { console.error(e); process.exit(1); });
