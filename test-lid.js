// Uji kanonikalisasi LID<->nomor (PN) + penggabungan chat DM kepecah.
// Jalankan: WA_TEST=1 node test-lid.js   (pakai DB throwaway, tidak menyentuh data asli)
process.env.WA_TEST = "1";
process.env.DB_PATH = require("path").resolve(__dirname, "data/_test_lid.db");

const fs = require("fs");
for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }

const wa = require("./src/wa");
const store = require("./src/db");
const db = store.db;
const t = wa._test;
const q1 = (sql, ...p) => db.prepare(sql).get(...p);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log("  ✓", m); } else { fail++; console.log("  ✗ GAGAL:", m); } };

t.status.me = "628999@s.whatsapp.net";
const LID = "555000111@lid";
const PN = "628123456789@s.whatsapp.net";

console.log("[1] canonicalDmJid dasar");
ok(t.canonicalDmJid(PN) === PN, "PN passthrough");
ok(t.canonicalDmJid("120363@g.us") === "120363@g.us", "grup passthrough");
ok(t.canonicalDmJid("status@broadcast") === "status@broadcast", "status passthrough");
ok(t.canonicalDmJid(LID) === LID, "@lid belum diketahui -> tetap @lid");

console.log("[2] learnLidMapping menggabungkan chat @lid kepecah ke PN");
store.recordMessage({ chat_jid: LID, id: "OLD1", sender: LID, text: "lama", timestamp: 1000 });
store.recordMessage({ chat_jid: PN, id: "OUT1", sender: t.status.me, from_me: 1, text: "keluar", timestamp: 900 });
t.learnLidMapping(LID, PN);
ok(t.canonicalDmJid(LID) === PN, "setelah learn: @lid -> PN");
ok(!q1("SELECT 1 x FROM chats WHERE jid=?", LID), "chat @lid hilang (tergabung)");
ok(!!q1("SELECT 1 x FROM messages WHERE chat_jid=? AND id='OLD1'", PN), "pesan @lid lama pindah ke PN");
ok(q1("SELECT COUNT(*) n FROM messages WHERE chat_jid=?", PN).n === 2, "PN punya kedua pesan (masuk+keluar)");

console.log("[3] DM masuk baru beralamat @lid -> chat PN");
t.storeWAMessage({ key: { remoteJid: LID, id: "NEW1", fromMe: false }, message: { conversation: "halo" }, messageTimestamp: 2000, pushName: "Budi" });
ok(!!q1("SELECT 1 x FROM messages WHERE chat_jid=? AND id='NEW1'", PN), "DM @lid baru tersimpan di PN");
ok(!q1("SELECT 1 x FROM messages WHERE chat_jid=? AND id='NEW1'", LID), "tidak tersimpan di @lid");
ok(q1("SELECT sender s FROM messages WHERE chat_jid=? AND id='NEW1'", PN).s === PN, "sender DM dikanonikalkan ke PN");

console.log("[4] grup: participant @lid TIDAK dikanonikalkan");
t.storeWAMessage({ key: { remoteJid: "120363@g.us", id: "G1", fromMe: false, participant: LID }, message: { conversation: "grup" }, messageTimestamp: 3000, pushName: "Budi" });
ok(q1("SELECT sender s FROM messages WHERE chat_jid='120363@g.us' AND id='G1'").s === LID, "participant @lid tetap mentah di grup");

console.log("[4b] panen mapping dari participantAlt pesan grup -> gabung DM @lid orang itu");
const LID2 = "777888999@lid";
const PN2 = "628777888999@s.whatsapp.net";
store.recordMessage({ chat_jid: LID2, id: "DM_OLD", sender: LID2, text: "dm lama", timestamp: 500 });
t.storeWAMessage({
  key: { remoteJid: "120999@g.us", id: "GX", fromMe: false, participant: LID2, participantAlt: PN2 },
  message: { conversation: "di grup" }, messageTimestamp: 600, pushName: "Cici",
});
ok(t.canonicalDmJid(LID2) === PN2, "mapping dipanen dari participantAlt");
ok(!q1("SELECT 1 x FROM chats WHERE jid=?", LID2), "chat DM @lid orang itu ikut tergabung");
ok(!!q1("SELECT 1 x FROM messages WHERE chat_jid=? AND id='DM_OLD'", PN2), "pesan DM lama pindah ke PN");
// bersihkan
db.prepare("DELETE FROM messages WHERE chat_jid IN (?,?)").run(PN2, "120999@g.us");
db.prepare("DELETE FROM chats WHERE jid IN (?,?)").run(PN2, "120999@g.us");
db.prepare("DELETE FROM contacts WHERE jid IN (?,?)").run(PN2, LID2);

console.log("[5] mergeChat: dedup konflik PK (chat_jid,id)");
const A = "aaa@lid", B = "bbb@s.whatsapp.net";
store.recordMessage({ chat_jid: A, id: "DUP", sender: A, text: "dari-lid", timestamp: 100 });
store.recordMessage({ chat_jid: B, id: "DUP", sender: B, text: "dari-pn", timestamp: 200 });
store.recordMessage({ chat_jid: A, id: "UNI", sender: A, text: "unik", timestamp: 150 });
store.mergeChat(A, B);
ok(q1("SELECT text tt FROM messages WHERE chat_jid=? AND id='DUP'", B).tt === "dari-pn", "id duplikat: salinan PN (to) dipertahankan");
ok(q1("SELECT COUNT(*) n FROM messages WHERE chat_jid=?", B).n === 2, "to punya 2 pesan (DUP+UNI)");
ok(q1("SELECT COUNT(*) n FROM messages WHERE chat_jid=?", A).n === 0, "from kosong");

console.log("[6] idempotensi & guard");
ok(store.mergeChat(A, B) === 0, "merge ulang (from kosong) -> 0");
ok(store.mergeChat("x@lid", "x@lid") === 0, "guard from===to -> 0");
ok(store.mergeChat("", "y@s.whatsapp.net") === 0, "guard from kosong -> 0");

for (const s of ["", "-wal", "-shm"]) { try { fs.unlinkSync(process.env.DB_PATH + s); } catch {} }
console.log(`\n=== HASIL: ${pass} lulus, ${fail} gagal ===`);
process.exit(fail ? 1 : 0);
