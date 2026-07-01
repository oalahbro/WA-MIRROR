"use strict";

const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem("wa_token") || "";
let activeJid = null;
let oldestLoaded = 0;     // timestamp pesan tertua yang sudah dimuat (cursor)
let allChats = [];
let loadingOlderChats = false;  // sedang memuat halaman chat lama (infinite scroll sidebar)
let noMoreChats = false;        // sudah tidak ada chat lebih lama lagi
let chatPollTimer = null;
let msgPollTimer = null;
let chatsLoadedOnce = false;
let lastStats = { chats: -1, messages: -1 };
let lastConnState = "";   // untuk toast transisi koneksi
let loadingOlder = false;
let loadingNewer = false;
let jumpedToHistory = false; // true saat sedang lihat potongan riwayat lama (hasil cari) → poll dipause, tombol ↓ = balik ke live
let myJid = "";           // jid akun sendiri (untuk label "Kamu" pada kutipan)
let myJidLid = "";        // jid LID akun sendiri (di grup) — untuk deteksi "Kamu"
let replyTo = null;       // { id, sender, text } pesan yang sedang dibalas
let editingId = null;     // id pesan yang sedang diedit (null = tidak sedang edit)
let chatFilter = localStorage.getItem("wa_filter") || "all"; // all | private | group
let msgSearchMode = false;   // true saat menampilkan hasil cari ISI pesan
let msgSearchQuery = "";
let groupMembers = [];       // anggota grup chat aktif (untuk @mention); [] di chat pribadi
// State picker @mention: posisi token "@query" di editor + daftar terfilter & indeks aktif.
let mentionState = null;     // { node, start, end } atau null bila picker tertutup
let mentionFiltered = [];
let mentionIdx = 0;
let pendingTasks = [];       // daftar tugas pending (dari server)
let usingPairingCode = false; // true saat tab "Kode Pairing" aktif di QR overlay

// ---------- helpers ----------
async function api(pathname, opts = {}) {
  // opts.timeout (ms): batasi waktu tunggu agar request kirim yang menggantung
  // (koneksi WA lambat) tidak mengunci UI selamanya — gagal-cepat lalu pulih.
  const { timeout, ...fetchOpts } = opts;
  let ctrl, timer;
  if (timeout) { ctrl = new AbortController(); timer = setTimeout(() => ctrl.abort(), timeout); }
  try {
    const res = await fetch(pathname, {
      ...fetchOpts,
      signal: ctrl ? ctrl.signal : undefined,
      headers: { "x-auth-token": TOKEN, "Content-Type": "application/json", ...(fetchOpts.headers || {}) },
    });
    if (res.status === 401) { logout(); throw new Error("unauthorized"); }
    return res.json();
  } catch (err) {
    if (err && err.name === "AbortError") throw new Error("waktu kirim habis (koneksi lambat)");
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function fmtTime(epoch) {
  if (!epoch) return "";
  const d = new Date(epoch * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Kemarin";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "2-digit", year: "2-digit" });
}
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Kunci hari (untuk deteksi pergantian tanggal) + label pembatas tanggal.
function dayKey(epoch) { return new Date((epoch || 0) * 1000).toDateString(); }
function dayLabel(epoch) {
  const d = new Date((epoch || 0) * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "Hari ini";
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return "Kemarin";
  return d.toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" });
}

// ---------- toast ----------
function toast(msg, kind = "", ms = 3000) {
  const el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 250);
  }, ms);
}

// ---------- login ----------
$("loginBtn").onclick = doLogin;
$("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });

function setBtnLoading(btn, loading) {
  btn.disabled = loading;
  btn.querySelector(".btn-label").classList.toggle("hidden", loading);
  btn.querySelector(".btn-spin").classList.toggle("hidden", !loading);
}

async function doLogin() {
  const t = $("tokenInput").value.trim();
  if (!t) return;
  setBtnLoading($("loginBtn"), true);
  $("loginErr").textContent = "";
  try {
    const res = await fetch("/api/login?token=" + encodeURIComponent(t)).then((r) => r.json());
    if (res.ok) {
      TOKEN = t;
      localStorage.setItem("wa_token", t);
      startApp();
    } else {
      $("loginErr").textContent = "Token salah.";
    }
  } catch (e) {
    $("loginErr").textContent = "Gagal terhubung ke server.";
  } finally {
    setBtnLoading($("loginBtn"), false);
  }
}
function logout() {
  localStorage.removeItem("wa_token");
  TOKEN = "";
  clearInterval(chatPollTimer); clearInterval(msgPollTimer);
  chatsLoadedOnce = false;
  lastConnState = "";
  $("app").classList.add("hidden");
  $("qrOverlay").classList.add("hidden");
  $("login").classList.remove("hidden");
}

// ---------- pairing code ----------
function showQrTab() {
  usingPairingCode = false;
  $("tabQr").classList.add("active");
  $("tabPair").classList.remove("active");
  $("qrSection").classList.remove("hidden");
  $("pairSection").classList.add("hidden");
}
function showPairTab() {
  usingPairingCode = true;
  $("tabPair").classList.add("active");
  $("tabQr").classList.remove("active");
  $("pairSection").classList.remove("hidden");
  $("qrSection").classList.add("hidden");
  // Pre-fill nomor dari jid yang diketahui (bila pernah terhubung sebelumnya)
  if (!$("pairPhone").value) {
    const saved = localStorage.getItem("wa_myPhone") || (myJid ? myJid.split("@")[0] : "");
    if (saved) $("pairPhone").value = saved;
  }
}
$("tabQr").addEventListener("click", async () => {
  if (usingPairingCode) {
    // Restart socket kembali ke mode QR
    showQrTab();
    try { await api("/api/reset-pairing", { method: "POST" }); } catch (_) {}
  }
});
$("tabPair").addEventListener("click", () => { if (!usingPairingCode) showPairTab(); });

$("pairBtn").addEventListener("click", async () => {
  const phone = $("pairPhone").value.trim();
  $("pairErr").textContent = "";
  if (!phone) { $("pairErr").textContent = "Masukkan nomor HP terlebih dahulu."; return; }
  setBtnLoading($("pairBtn"), true);
  $("pairWait").classList.remove("hidden");
  $("pairCodeWrap").classList.add("hidden");
  // Simpan nomor untuk pre-fill berikutnya
  const digits = phone.replace(/\D/g, "").replace(/^0/, "62");
  if (digits) localStorage.setItem("wa_myPhone", digits);
  try {
    await api("/api/pairing-mode", { method: "POST", body: JSON.stringify({ phone }) });
    // Kode akan muncul via polling checkStatus → s.pairingCode
  } catch (e) {
    $("pairErr").textContent = e.message || "Gagal meminta kode. Coba lagi.";
    $("pairWait").classList.add("hidden");
  } finally {
    setBtnLoading($("pairBtn"), false);
  }
});

// ---------- status / QR / sync ----------
function setPill(cls, text) {
  const pill = $("statusPill");
  pill.className = "status-pill " + cls;
  $("statusText").textContent = text;
}

async function checkStatus() {
  let s;
  try {
    s = await api("/api/status");
  } catch (e) { return; } // 401 sudah ditangani; error lain → biarkan poll berikutnya

  // --- QR overlay ---
  if (s.connected) {
    $("qrOverlay").classList.add("hidden");
    usingPairingCode = false;
    if (s.me) { myJid = s.me; $("meLabel").textContent = "📱 " + s.me.split("@")[0]; }
    if (s.meLid) myJidLid = s.meLid;
  } else {
    $("qrOverlay").classList.remove("hidden");
    if (usingPairingCode) {
      if (s.pairingError) {
        $("pairErr").textContent = s.pairingError;
        $("pairWait").classList.add("hidden");
        $("pairCodeWrap").classList.add("hidden");
      } else if (s.pairingCode) {
        $("pairErr").textContent = "";
        const fmt = s.pairingCode.match(/.{1,4}/g)?.join("-") || s.pairingCode;
        $("pairCode").textContent = fmt;
        $("pairCodeWrap").classList.remove("hidden");
        $("pairWait").classList.add("hidden");
      } else {
        $("pairCodeWrap").classList.add("hidden");
        // hanya tampil pairWait bila tombol sudah diklik (ada request aktif)
      }
    } else {
      if (s.qr) { $("qrImg").src = s.qr; $("qrImg").classList.remove("hidden"); $("qrWait").classList.add("hidden"); }
      else { $("qrImg").classList.add("hidden"); $("qrWait").classList.remove("hidden"); }
    }
  }

  // --- status pill (prioritas: terputus > sinkron > terhubung > menghubungkan) ---
  let connState;
  if (!s.connected) {
    connState = s.reconnecting ? "reconnecting" : "offline";
    setPill("offline", s.reconnecting ? "Menyambung ulang…" : "Terputus");
    if (s.reconnecting) setPill("connecting", "Menyambung ulang…");
  } else if (s.syncing) {
    connState = "syncing";
    setPill("syncing", "Menyinkronkan…");
  } else {
    connState = "connected";
    setPill("connected", "Terhubung");
  }

  // toast saat status koneksi berubah
  if (lastConnState && lastConnState !== connState) {
    if (connState === "connected" && (lastConnState === "reconnecting" || lastConnState === "offline"))
      toast("Tersambung kembali", "ok");
    else if (connState === "offline") toast("Koneksi terputus", "err");
    else if (connState === "reconnecting") toast("Mencoba menyambung ulang…");
  }
  lastConnState = connState;

  // --- banner sinkron ---
  const banner = $("syncBanner");
  if (s.syncing) {
    banner.classList.remove("hidden");
    $("syncText").textContent = `Menyinkronkan riwayat… ${s.syncedMessages || 0} pesan`;
  } else {
    banner.classList.add("hidden");
  }

  // --- stats line ---
  if (s.stats) updateStats(s.stats);
}

function updateStats(stats) {
  const line = $("statsLine");
  line.classList.remove("hidden");
  const changed = stats.chats !== lastStats.chats || stats.messages !== lastStats.messages;
  $("statChats").textContent = stats.chats;
  $("statMsgs").textContent = stats.messages.toLocaleString("id-ID");
  if (stats.dataBytes != null) $("statSize").textContent = fmtSize(stats.dataBytes);
  if (changed && lastStats.chats !== -1) {
    line.classList.remove("bump"); void line.offsetWidth; line.classList.add("bump");
  }
  lastStats = { chats: stats.chats, messages: stats.messages };
}

// ---------- chat list ----------
function showChatSkeleton() {
  $("chatList").innerHTML = Array.from({ length: 7 }).map(() => `
    <div class="skel-item">
      <div class="skel-line short"></div>
      <div class="skel-line long"></div>
    </div>`).join("");
}

async function loadChats() {
  try {
    const top = await api("/api/chats");
    mergeChats(top);          // merge, bukan replace — pertahankan chat lama yg sudah di-scroll
    chatsLoadedOnce = true;
    renderChats();
  } catch (e) {}
}

// Gabung daftar chat masuk ke allChats (overwrite by jid utk data terbaru), lalu urutkan
// seperti backend: pinned dulu, lalu terbaru. Dipakai poll (top 200) & load chat lama.
function mergeChats(incoming) {
  if (!incoming || !incoming.length) return;
  const byJid = new Map(allChats.map((c) => [c.jid, c]));
  for (const c of incoming) byJid.set(c.jid, c);
  allChats = [...byJid.values()];
  allChats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.last_message_time - a.last_message_time);
}

// Infinite scroll: muat chat lebih lama dari yang tertua saat ini (cursor by last_message_time).
async function loadOlderChats() {
  if (loadingOlderChats || noMoreChats || msgSearchMode || !chatsLoadedOnce || !allChats.length) return;
  const cursor = allChats[allChats.length - 1].last_message_time;
  if (!cursor) { noMoreChats = true; return; }
  loadingOlderChats = true;
  setChatMore();
  try {
    const page = await api(`/api/chats?before=${cursor}&limit=100`);
    const known = new Set(allChats.map((c) => c.jid));
    const fresh = (page || []).filter((c) => !known.has(c.jid));
    if (fresh.length) { mergeChats(fresh); renderChats(); }
    if (!page || page.length < 100) noMoreChats = true;
  } catch (e) {
  } finally { loadingOlderChats = false; setChatMore(); }
}

// Footer status di dasar sidebar (memuat / sudah habis). Dipertahankan reconcileChats.
function ensureChatMore() {
  const list = $("chatList");
  let el = document.getElementById("chatMore");
  if (!el) { el = document.createElement("div"); el.id = "chatMore"; el.className = "chat-more hidden"; }
  list.appendChild(el); // selalu jadi anak terakhir
  setChatMore();
}
function setChatMore() {
  const el = document.getElementById("chatMore");
  if (!el) return;
  if (loadingOlderChats) { el.textContent = "Memuat chat lama…"; el.classList.remove("hidden"); }
  else if (noMoreChats) { el.textContent = "— semua chat dimuat —"; el.classList.remove("hidden"); }
  else { el.textContent = ""; el.classList.add("hidden"); }
}
// Apakah chat ini grup? Andalkan flag dari API, fallback ke suffix jid.
function isGroupChat(c) { return c.is_group ? true : (c.jid || "").endsWith("@g.us"); }
function matchesFilter(c) {
  if (chatFilter === "group") return isGroupChat(c);
  if (chatFilter === "private") return !isGroupChat(c);
  return true;
}

function renderChats() {
  if (msgSearchMode) return;   // tampilan diambil alih hasil "cari isi pesan"
  const q = $("search").value.trim().toLowerCase();
  const list = $("chatList");
  updateFilterCounts();
  if (chatFilter === "pending") { renderPendingList(); return; }
  let filtered = allChats.filter(matchesFilter);
  if (q) filtered = filtered.filter((c) => (c.name || "").toLowerCase().includes(q));

  if (!filtered.length) {
    if (!chatsLoadedOnce) { showChatSkeleton(); return; }
    const msg = q ? "Tidak ada chat cocok."
      : chatFilter === "group" ? "Belum ada grup."
      : chatFilter === "private" ? "Belum ada chat pribadi."
      : "Belum ada chat. Data akan muncul saat tersinkron.";
    list.innerHTML = `<div class="list-msg">${msg}</div>`;
    return;
  }

  // buang node non-chat-item (skeleton / pesan kosong) bila ada; #chatMore dipertahankan
  [...list.children].forEach((n) => { if (n.id !== "chatMore" && !n.classList.contains("chat-item")) n.remove(); });
  reconcileChats(list, filtered);
  ensureChatMore();
}

// Rekonsiliasi: pertahankan node yang ada, hanya update isi yang berubah & atur urutan.
// Menghindari rebuild innerHTML penuh yang bikin daftar berkedip tiap polling.
function reconcileChats(list, items) {
  const existing = new Map();
  list.querySelectorAll(".chat-item").forEach((el) => existing.set(el.dataset.jid, el));
  let prev = null;
  const seen = new Set();
  for (const c of items) {
    seen.add(c.jid);
    let el = existing.get(c.jid);
    if (el) updateChatItem(el, c);
    else el = buildChatItem(c);
    const ref = prev ? prev.nextSibling : list.firstChild;
    if (el !== ref) list.insertBefore(el, ref); // pindah hanya bila posisinya beda
    prev = el;
  }
  existing.forEach((el, jid) => { if (!seen.has(jid)) el.remove(); });
}

// Inisial untuk fallback avatar (2 huruf dari nama). "?" bila nama = jid/kosong.
function avatarInitials(name, isGroup) {
  const n = String(name || "").trim();
  if (!n || n.includes("@")) return isGroup ? "#" : "?";
  const parts = n.split(/\s+/).filter(Boolean);
  let s = parts[0] ? parts[0][0] : "";
  if (parts.length > 1) s += parts[1][0];
  return (s.toUpperCase().slice(0, 2)) || "?";
}
// Warna avatar stabil per-jid (hash → hue) untuk fallback inisial.
function avatarColor(jid) {
  const s = String(jid || "");
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h} 42% 52%)`;
}
function avatarUrl(jid) {
  return `/api/avatar?jid=${encodeURIComponent(jid)}&token=${encodeURIComponent(TOKEN)}`;
}

function buildChatItem(c) {
  const el = document.createElement("div");
  el.className = "chat-item";
  el.dataset.jid = c.jid;
  el.innerHTML = `<span class="avatar"><span class="avatar-initials" style="background:${avatarColor(c.jid)}"></span><img class="avatar-img" alt=""></span><div class="chat-main"><div class="row"><span class="name"></span><span class="time"></span></div><div class="row2"><span class="preview"></span><span class="mention hidden" title="Kamu di-tag / dibalas">@</span><span class="badge hidden"></span></div></div><button class="pin-btn" title="">📌</button>`;
  el.querySelector(".avatar-img").src = avatarUrl(c.jid);   // dimuat sekali; load/error via capture
  el.addEventListener("click", () => openChat(el.dataset.jid, el.querySelector(".name").textContent));
  el.querySelector(".pin-btn").addEventListener("click", (e) => { e.stopPropagation(); togglePin(el.dataset.jid); });
  updateChatItem(el, c);
  return el;
}

// Update field hanya bila nilainya berubah (hindari repaint tak perlu).
function updateChatItem(el, c) {
  el.classList.toggle("active", c.jid === activeJid);
  el.classList.toggle("pinned", !!c.pinned);
  const name = (c.name || "") + (c.is_group ? " 👥" : "");
  const nameEl = el.querySelector(".name");
  if (nameEl.textContent !== name) nameEl.textContent = name;
  const iniEl = el.querySelector(".avatar-initials");
  if (iniEl) { const ini = avatarInitials(c.name, c.is_group); if (iniEl.textContent !== ini) iniEl.textContent = ini; }
  const time = (c.pinned ? "📌 " : "") + fmtTime(c.last_message_time);
  const timeEl = el.querySelector(".time");
  if (timeEl.textContent !== time) timeEl.textContent = time;
  const prevEl = el.querySelector(".preview");
  const previewHtml = bbmify(escapeHtml(c.last_text || ""));
  if (prevEl.innerHTML !== previewHtml) prevEl.innerHTML = previewHtml;
  const pinBtn = el.querySelector(".pin-btn");
  const title = c.pinned ? "Lepas pin" : "Sematkan chat";
  if (pinBtn.title !== title) pinBtn.title = title;

  // @ badge: ada pesan belum dibaca yang men-tag / membalas aku
  const mentions = c.jid === activeJid ? 0 : (c.mentions || 0);
  const mentionEl = el.querySelector(".mention");
  if (mentionEl) mentionEl.classList.toggle("hidden", mentions <= 0);

  // unread: chat yang sedang dibuka tidak pernah ber-badge
  const unread = c.jid === activeJid ? 0 : (c.unread || 0);
  el.classList.toggle("unread", unread > 0);
  const badge = el.querySelector(".badge");
  if (unread > 0) {
    const txt = unread > 99 ? "99+" : String(unread);
    if (badge.textContent !== txt) badge.textContent = txt;
    badge.classList.remove("hidden");
  } else if (!badge.classList.contains("hidden")) {
    badge.classList.add("hidden");
  }
}

async function togglePin(jid) {
  const c = allChats.find((x) => x.jid === jid);
  const newPinned = c ? !c.pinned : true;
  try {
    await api("/api/pin", { method: "POST", body: JSON.stringify({ jid, pinned: newPinned }) });
    if (c) c.pinned = newPinned ? 1 : 0;
    // urutkan ulang lokal seperti backend: pinned dulu, lalu terbaru
    allChats.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.last_message_time - a.last_message_time);
    renderChats();
    toast(newPinned ? "Chat disematkan" : "Pin dilepas", "ok", 1500);
  } catch (e) {
    toast("Gagal mengubah pin: " + e.message, "err");
  }
}
let nameSearchTimer = null;
$("search").addEventListener("input", () => {
  if (msgSearchMode) msgSearchMode = false;   // mulai mengetik → kembali ke filter chat biasa
  renderChats();
  const q = $("search").value.trim();
  clearTimeout(nameSearchTimer);
  if (q.length >= 2) nameSearchTimer = setTimeout(() => searchChatsByName(q), 220);
});
// Cari chat by NAMA lintas DB (chat lama yang belum ke-load) → merge ke allChats lalu render,
// supaya ngetik nama grup/kontak tetap nemu walau chatnya belum ke-scroll di sidebar.
async function searchChatsByName(q) {
  try {
    const hits = await api(`/api/chats/search?q=${encodeURIComponent(q)}`);
    if (hits && hits.length && $("search").value.trim() === q && !msgSearchMode) {
      mergeChats(hits);
      renderChats();
    }
  } catch (e) {}
}
// Enter di kotak cari → cari ISI pesan (lintas chat), bukan cuma nama.
$("search").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  const q = $("search").value.trim();
  if (q.length >= 2) runMsgSearch(q);
});

// ---------- cari isi pesan ----------
function renderSearchShell(bodyHTML, count) {
  $("chatList").innerHTML =
    `<div class="search-head"><span class="search-head-q">🔎 <b>${escapeHtml(msgSearchQuery)}</b>${count != null ? ` · ${count}` : ""}</span>` +
    `<button class="search-exit" title="Tutup pencarian">✕</button></div>` + bodyHTML;
}
async function runMsgSearch(q) {
  msgSearchMode = true; msgSearchQuery = q;
  renderSearchShell(`<div class="list-msg">Mencari…</div>`);
  let results;
  try { results = await api(`/api/search?q=${encodeURIComponent(q)}&limit=80`); }
  catch (e) { if (msgSearchMode && msgSearchQuery === q) renderSearchShell(`<div class="list-msg">Gagal mencari.</div>`); return; }
  if (!msgSearchMode || msgSearchQuery !== q) return; // user keburu ubah/keluar
  if (!results.length) { renderSearchShell(`<div class="list-msg">Tidak ada pesan cocok.</div>`, 0); return; }
  const items = results.map((r) => {
    const who = r.from_me ? "Kamu: " : (r.is_group && r.sender_name ? escapeHtml(r.sender_name) + ": " : "");
    return `<div class="search-result" data-jid="${escapeHtml(r.jid)}" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.chat_name)}" data-ts="${r.timestamp}">
      <div class="sr-row"><span class="sr-name">${escapeHtml(r.chat_name)}${r.is_group ? " 👥" : ""}</span><span class="sr-time">${fmtTime(r.timestamp)}</span></div>
      <div class="sr-snippet">${who}${bbmify(highlightSnippet(r.text, q))}</div></div>`;
  }).join("");
  renderSearchShell(items, results.length);
}
// Potong teks di sekitar kemunculan + tandai kata yang cocok.
function highlightSnippet(text, q) {
  text = String(text || "");
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  let start = idx > 40 ? idx - 30 : 0;
  let snip = text.slice(start, start + 140);
  if (start > 0) snip = "…" + snip;
  if (start + 140 < text.length) snip += "…";
  let esc = escapeHtml(snip);
  const qe = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try { esc = esc.replace(new RegExp("(" + qe + ")", "ig"), "<mark>$1</mark>"); } catch (e) {}
  return esc;
}
function exitMsgSearch() {
  msgSearchMode = false; msgSearchQuery = "";
  $("search").value = "";
  renderChats();
}
// Klik hasil / tombol tutup (delegasi pada chatList; chat-item biasa pakai listener sendiri).
$("chatList").addEventListener("click", (e) => {
  if (e.target.closest(".search-exit")) { exitMsgSearch(); return; }
  const r = e.target.closest(".search-result[data-jid]");
  if (r) openChatToMessage(r.dataset.jid, r.dataset.name, r.dataset.id, Number(r.dataset.ts) || 0);
});
// Infinite scroll sidebar: dekat dasar → muat chat lebih lama.
$("chatList").addEventListener("scroll", () => {
  if (msgSearchMode) return;
  const el = $("chatList");
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 320) loadOlderChats();
});
// Buka chat lalu loncat ke pesan hasil pencarian. Untuk pesan lama, muat langsung
// jendela di sekitar timestamp-nya (1 panggilan) — bukan scroll dari bawah berkali-kali
// (yang gagal untuk pesan jauh, mis. bulan lalu di grup ramai).
async function openChatToMessage(jid, name, id, ts) {
  msgSearchMode = false; msgSearchQuery = ""; $("search").value = "";
  await openChat(jid, name);
  if (locateBubble(id)) return;                 // pesan ada di batch terbaru
  if (ts) await loadAround(jid, ts);            // muat jendela tepat di sekitar pesan
  if (locateBubble(id)) return;
  // cadangan: bila ts meleset / tak ada, gulir ke atas beberapa kali
  for (let i = 0; i < 6 && !locateBubble(id); i++) {
    const lo = $("messages").querySelector(".load-older");
    if (!lo || lo.classList.contains("done")) break;
    await loadOlder();
  }
  if (!locateBubble(id)) toast("Pesan tidak ditemukan — mungkin sudah terhapus");
}

// Muat satu jendela pesan yang memuat pesan dengan timestamp `ts` (target jadi pesan paling
// bawah batch, pesan lebih lama di atasnya). Polling dihentikan supaya refreshNewest tidak
// menempelkan pesan terbaru (yang akan bikin lompatan tak nyambung). Tombol ↓ = kembali ke live.
async function loadAround(jid, ts) {
  try {
    const batch = await api(`/api/messages?jid=${encodeURIComponent(jid)}&before=${ts + 1}&limit=50`);
    if (activeJid !== jid || !batch.length) return;
    clearInterval(msgPollTimer);   // berhenti poll → tak ada pesan terbaru yang ditempel
    jumpedToHistory = true;
    oldestLoaded = 0;              // reset cursor; renderMessages akan set ulang dari batch
    $("messages").innerHTML = "";
    renderMessages(batch, false);
    showJump(false);               // tampilkan tombol ↓ sebagai "kembali ke live"
    await loadNewer();             // muat sebagian pesan SETELAH target → konteks ke bawah
  } catch (e) { /* biarkan; cadangan loadOlder menyusul */ }
}

// Muat pesan LEBIH BARU dari yang terbawah (saat mode riwayat). Append di bawah. Bila batch
// kurang dari limit = sudah nyusul live → keluar mode riwayat & lanjutkan polling.
async function loadNewer() {
  if (!activeJid || !jumpedToHistory || loadingNewer) return;
  loadingNewer = true;
  const jid = activeJid, box = $("messages");
  const bubbles = box.querySelectorAll(".bubble");
  const lastTs = bubbles.length ? Number(bubbles[bubbles.length - 1].dataset.ts) : 0;
  const LIMIT = 50;
  try {
    const newer = await api(`/api/messages?jid=${encodeURIComponent(jid)}&after=${lastTs}&limit=${LIMIT}`);
    if (activeJid !== jid) return;
    const existing = new Set([...box.querySelectorAll(".bubble")].map((b) => b.dataset.id));
    const toAdd = newer.filter((m) => !existing.has(m.id)); // newer sudah ASC (lama→baru)
    if (toAdd.length) {
      box.insertAdjacentHTML("beforeend", toAdd.map(renderBubble).join(""));
      rebuildDaySeparators();
    }
    if (newer.length < LIMIT) {           // tak ada lagi yg lebih baru → sudah live
      jumpedToHistory = false;
      clearInterval(msgPollTimer);
      msgPollTimer = setInterval(refreshNewest, 3000);
      updateJump();
    }
  } catch (e) { /* abaikan; bisa dicoba lagi saat scroll */ }
  finally { loadingNewer = false; }
}
function locateBubble(id) {
  let el = null;
  try { el = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`); } catch (e) {}
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
  return true;
}

// Tab filter: Semua / Pribadi / Grup (preferensi disimpan di localStorage).
$("chatFilters").addEventListener("click", (e) => {
  const tab = e.target.closest(".filter-tab");
  if (!tab || tab.dataset.filter === chatFilter) return;
  chatFilter = tab.dataset.filter;
  localStorage.setItem("wa_filter", chatFilter);
  document.querySelectorAll(".filter-tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === chatFilter));
  if (chatFilter === "pending") loadPendingTasks();
  renderChats();
});

// Badge jumlah chat ber-pesan-baru (unread/mention) per kategori pada tiap tab.
function updateFilterCounts() {
  let priv = 0, grp = 0;
  for (const c of allChats) {
    if (c.jid === activeJid) continue;          // chat yang sedang dibuka tidak dihitung
    if (!((c.unread || 0) > 0 || (c.mentions || 0) > 0)) continue;
    if (isGroupChat(c)) grp++; else priv++;
  }
  setFilterCount("all", priv + grp);
  setFilterCount("private", priv);
  setFilterCount("group", grp);
  setFilterCount("pending", pendingTasks.length);
}
function setFilterCount(filter, n) {
  const el = document.querySelector(`.filter-tab[data-filter="${filter}"] .filter-count`);
  if (!el) return;
  if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

// Avatar: img foto asli → tampilkan (.ok); "tanpa foto" (server kirim sentinel PNG 1x1,
// naturalWidth<=1) atau error → sembunyikan, inisial tetap terlihat. Server tak lagi balas
// 404 untuk avatar kosong supaya console browser bersih. Pakai fase CAPTURE (load/error tak
// bubble). Inline handler dihindari (CSP).
function wireAvatarLoaders(container) {
  container.addEventListener("load", (e) => {
    const t = e.target;
    if (!t.classList || !t.classList.contains("avatar-img")) return;
    if (t.naturalWidth <= 1) { t.classList.remove("ok"); t.style.display = "none"; } // sentinel = tanpa foto
    else { t.style.display = ""; t.classList.add("ok"); }
  }, true);
  container.addEventListener("error", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("avatar-img")) { t.classList.remove("ok"); t.style.display = "none"; }
  }, true);
}
wireAvatarLoaders($("chatList"));
wireAvatarLoaders($("convAvatar"));

// Swipe chat ke KIRI (mobile) → sematkan / lepas pin. Item ikut jari; lepas lewat ambang → toggle.
// Tap normal tak terpengaruh (buka chat sekali tap) — preventDefault hanya saat ada gestur swipe.
let spEl = null, spX = 0, spY = 0, spDx = 0, spActive = false;
$("chatList").addEventListener("touchstart", (e) => {
  if (window.innerWidth > 768 || e.touches.length > 1) return;
  const item = e.target.closest(".chat-item");
  if (!item) return;
  const t = e.touches[0];
  spEl = item; spX = t.clientX; spY = t.clientY; spDx = 0; spActive = false;
}, { passive: true });
$("chatList").addEventListener("touchmove", (e) => {
  if (!spEl) return;
  const t = e.touches[0];
  const dx = t.clientX - spX, dy = t.clientY - spY;
  if (!spActive) {
    if (Math.abs(dy) > Math.abs(dx)) { spEl = null; return; }  // vertikal → biarkan scroll list
    if (dx > -8) return;                                        // belum cukup ke kiri
    spActive = true; spEl.style.transition = "none"; spEl.classList.add("sw-pin");
  }
  if (dx < 0) { spDx = Math.max(dx, -96); e.preventDefault(); spEl.style.transform = "translateX(" + spDx + "px)"; }
}, { passive: false });
function endSwipePin(e) {
  if (!spEl) return;
  const el = spEl, dx = spDx, acted = spActive;
  el.style.transition = ""; el.style.transform = ""; el.classList.remove("sw-pin");
  spEl = null; spDx = 0; spActive = false;
  if (acted) {                                   // ada gestur swipe → jangan buka chat
    if (e && e.cancelable) e.preventDefault();
    if (dx < -55) togglePin(el.dataset.jid);
  }
}
$("chatList").addEventListener("touchend", endSwipePin, { passive: false });
$("chatList").addEventListener("touchcancel", endSwipePin);

// ---------- conversation ----------
async function openChat(jid, title) {
  activeJid = jid;
  oldestLoaded = 0;
  jumpedToHistory = false;   // buka chat normal = mode live (poll jalan)
  closeChatInfo();           // tutup panel info bila terbuka dari chat sebelumnya
  $("app").classList.add("chat-open");   // mobile: geser ke tampilan percakapan
  $("convEmpty").classList.add("hidden");
  $("convView").classList.remove("hidden");
  $("convTitle").textContent = title;
  // avatar header
  const isGrp = jid.endsWith("@g.us");
  const cIni = $("convAvatar").querySelector(".avatar-initials");
  cIni.textContent = avatarInitials(title, isGrp);
  cIni.style.background = avatarColor(jid);
  const cImg = $("convAvatar").querySelector(".avatar-img");
  cImg.classList.remove("ok"); cImg.style.display = "";
  cImg.src = avatarUrl(jid);
  $("messages").innerHTML = "";
  $("jumpBtn").classList.add("hidden");
  $("convLoading").classList.remove("hidden");
  clearAttach();
  clearReply();
  closeMentionPicker();
  loadGroupMembers(jid);   // siapkan daftar anggota utk @mention (hanya grup)
  // tandai chat ini sudah dibaca (hapus badge unread)
  const curChat = allChats.find((x) => x.jid === jid);
  if (curChat) curChat.unread = 0;
  api("/api/read", { method: "POST", body: JSON.stringify({ jid }) }).catch(() => {});
  renderChats();

  // auto-fokus kolom ketik (desktop) supaya bisa langsung mengetik tanpa klik dulu;
  // di mobile (≤768px) dilewati agar keyboard tidak nongol tiba-tiba saat buka chat.
  if (window.innerWidth > 768) $("sendInput").focus();

  clearInterval(msgPollTimer);
  try {
    const msgs = await api(`/api/messages?jid=${encodeURIComponent(jid)}&limit=50`);
    if (activeJid !== jid) return; // user keburu pindah chat
    renderMessages(msgs, false);
    if (!msgs.length) $("messages").innerHTML = `<div class="list-msg">Belum ada pesan di chat ini.</div>`;
    scrollToBottom();
  } catch (e) {
    toast("Gagal memuat pesan", "err");
  } finally {
    if (activeJid === jid) $("convLoading").classList.add("hidden");
  }

  msgPollTimer = setInterval(refreshNewest, 3000);
}

// Mobile: kembali ke daftar chat
function backToList() {
  $("app").classList.remove("chat-open");
  closeChatInfo();
  clearInterval(msgPollTimer);
  activeJid = null;          // lepas active → badge unread jalan normal lagi
  groupMembers = [];
  jumpedToHistory = false;
  closeMentionPicker();
  renderChats();
}
$("backBtn").onclick = backToList;

// Gestur swipe dari TEPI KIRI → kembali ke daftar chat (ala WA/iOS). Hanya mobile + chat terbuka.
// Panel chat mengikuti jari; lepas melewati ambang → kembali, kurang → snap balik.
(function setupEdgeSwipeBack() {
  const conv = document.querySelector(".conversation");
  if (!conv) return;
  let active = false, startX = 0, startY = 0, dx = 0;
  const mobile = () => window.innerWidth <= 768;
  const reset = () => { conv.style.transition = ""; conv.style.transform = ""; active = false; dx = 0; };

  document.addEventListener("touchstart", (e) => {
    if (!mobile() || !$("app").classList.contains("chat-open")) return;
    const t = e.touches[0];
    if (t.clientX > 28) return;          // harus mulai dari tepi kiri
    active = true; startX = t.clientX; startY = t.clientY; dx = 0;
    conv.style.transition = "none";
  }, { passive: true });

  document.addEventListener("touchmove", (e) => {
    if (!active) return;
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (Math.abs(my) > Math.abs(mx) && Math.abs(my) > 12) { reset(); return; } // gerak vertikal → batal (scroll jalan)
    if (mx > 0) { dx = mx; e.preventDefault(); conv.style.transform = "translateX(" + mx + "px)"; }
  }, { passive: false });

  document.addEventListener("touchend", () => {
    if (!active) return;
    const moved = dx;
    reset();
    if (moved > Math.min(90, window.innerWidth * 0.28)) backToList();
  });
})();

// msgs datang DESC (terbaru dulu). Render dibalik jadi ASC (lama -> baru ke bawah).
function renderMessages(msgs, prepend) {
  if (!msgs.length) return;
  const box = $("messages");
  const asc = [...msgs].reverse();
  const minTs = Math.min(...msgs.map((m) => m.timestamp));
  if (!oldestLoaded || minTs < oldestLoaded) oldestLoaded = minTs;
  const html = asc.map(renderBubble).join("");
  if (prepend) {
    const prevH = box.scrollHeight;
    const lo = box.querySelector(".load-older");
    if (lo) lo.insertAdjacentHTML("afterend", html);
    else box.insertAdjacentHTML("afterbegin", html);
    ensureLoadOlder();
    rebuildDaySeparators();
    box.scrollTop = box.scrollHeight - prevH; // pertahankan posisi setelah load lama
  } else {
    box.insertAdjacentHTML("beforeend", html);
    ensureLoadOlder();
    rebuildDaySeparators();
  }
}

// Sisipkan pembatas tanggal ("Hari ini"/"Kemarin"/tanggal) tiap pergantian hari.
// Idempoten: hapus semua lalu pasang ulang berdasarkan urutan bubble saat ini.
function rebuildDaySeparators() {
  const box = $("messages");
  box.querySelectorAll(".date-sep").forEach((s) => s.remove());
  let prevKey = null;
  box.querySelectorAll(".bubble").forEach((b) => {
    const ts = Number(b.dataset.ts) || 0;
    const key = dayKey(ts);
    if (key !== prevKey) {
      const sep = document.createElement("div");
      sep.className = "date-sep";
      sep.innerHTML = `<span>${escapeHtml(dayLabel(ts))}</span>`;
      b.parentNode.insertBefore(sep, b);
      prevKey = key;
    }
  });
}
const PLACEHOLDER_TEXT = { image: "📷 Foto", video: "🎥 Video", document: "📄 Dokumen", sticker: "🌟 Stiker" };

// Jadikan URL & "www." pada teks (SUDAH di-escape) sebagai tautan yang bisa diklik.
// Aman: dijalankan pada string ter-escape, jadi tak ada injeksi. Tanda baca di ujung dipangkas.
function linkify(escaped) {
  return escaped.replace(/\b(https?:\/\/[^\s<]+|www\.[^\s<]+)/gi, (m) => {
    let url = m, tail = "";
    const tm = url.match(/(?:&amp;|[.,!?:;)\]'"]+)$/);
    if (tm) { tail = tm[0]; url = url.slice(0, -tail.length); }
    if (!url) return m;
    const href = url.startsWith("http") ? url : "http://" + url;
    return `<a href="${href}" target="_blank" rel="noopener noreferrer">${url}</a>${tail}`;
  });
}

// Ganti token :bNNN: menjadi gambar emoji BBM (kosmetik mirror). Dijalankan pada teks
// yang SUDAH di-escape (token hanya berisi ':','b',angka → aman, tak terpengaruh escaping).
function bbmify(escaped) {
  return escaped.replace(/:b(\d{3}):/g, '<img class="bbm-emo" src="/bbm/b$1.png" alt=":b$1:" loading="lazy">');
}

// Deteksi pesan yang isinya HANYA emoticon BBM (≤6 token) → tampil besar tanpa bubble.
function isBbmOnly(text) {
  return !!text && /^(?:\s*:b\d{3}:\s*)+$/.test(text) && (text.match(/:b\d{3}:/g) || []).length <= 6;
}
// Deteksi pesan yang isinya HANYA emoji (untuk ditampilkan besar ala WA).
function isEmojiOnly(text) {
  const t = (text || "").trim();
  if (!t) return false;
  try {
    if (!/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u.test(t)) return false;
    return Array.from(t.replace(/\s/g, "")).length <= 8;
  } catch (e) { return false; }
}

// Gambar masuk: thumbnail (img.show) tampil SEKETIKA → box langsung berukuran benar,
// tak pernah blank putih. img.media-loader (tersembunyi) memuat resolusi penuh; saat siap
// di-swap ke img.show (crisp, sudah ter-cache). Spinner saat memuat; tombol "muat ulang" bila gagal.
// `full` = URL /api/media, `thumb` = data URL base64 jpegThumbnail.
function imgHTML(full, thumb) {
  return `<div class="media-img loading" data-full="${escapeHtml(full)}">
    <img class="media show" alt="" src="${thumb}">
    <img class="media-loader" alt="" src="${escapeHtml(full)}">
    <span class="media-spin spinner sm"></span>
    <button type="button" class="media-retry">⟳ Muat ulang</button>
  </div>`;
}
// onload loader: full-res sudah ter-cache → tukar src thumbnail jadi full (crisp), buang loading.
function imgLoaded(loader) {
  const w = loader.closest(".media-img");
  if (!w) return;
  const show = w.querySelector("img.show");
  if (show && show.src !== loader.src) show.src = loader.src;
  w.classList.remove("loading", "failed");
  w.classList.add("loaded");
}
// onerror loader: tandai gagal → spinner hilang, tombol muat ulang muncul (thumbnail tetap tampil).
function imgFailed(loader) {
  const w = loader.closest(".media-img");
  if (w) { w.classList.remove("loading", "loaded"); w.classList.add("failed"); }
}
// Coba muat ulang full-res (cache-bust agar tak mengambil hasil gagal dari cache browser).
function retryImg(w) {
  const loader = w && w.querySelector("img.media-loader");
  if (!loader || !w.dataset.full) return;
  w.classList.remove("failed");
  w.classList.add("loading");          // spinner tampil lagi
  const full = w.dataset.full;
  loader.src = full + (full.includes("?") ? "&" : "?") + "_r=" + Date.now();
}

// Chip dokumen yang bisa diklik untuk mengunduh (dipakai render & bubble optimistik).
// `full` = URL /api/media (atau blob: lokal saat optimistik).
function docChipHTML({ name, size, full }) {
  const ext = fileExt(name);
  const meta = (ext ? ext.toUpperCase() : "FILE") + (size ? " · " + fmtSize(size) : "");
  return `<div class="doc-chip" data-full="${escapeHtml(full)}" data-name="${escapeHtml(name)}" title="Unduh ${escapeHtml(name)}">
    <span class="doc-ic">${docIcon(ext)}</span>
    <span class="doc-info"><span class="doc-name">${escapeHtml(name)}</span><span class="doc-meta">${escapeHtml(meta)}</span></span>
    <span class="doc-dl">⬇</span></div>`;
}

// Unduh dokumen via fetch → blob, supaya 401/404 ditangani rapi (bukan navigasi keluar).
async function downloadDoc(url, name) {
  toast("Mengunduh…", "", 1500);
  try {
    const res = await fetch(url, { headers: { "x-auth-token": TOKEN } });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name || "dokumen";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    toast("Dokumen tidak tersedia (mungkin sudah kedaluwarsa)", "err");
  }
}

// Nama pengirim untuk label kutipan: "Kamu" bila akun sendiri (cocokkan nomor & LID),
// kalau bukan pakai nama kontak; fallback ke nomor bila nama tak diketahui.
function quotedLabel(senderJid, senderName) {
  if (!senderJid) return "";
  const num = senderJid.split("@")[0].split(":")[0];
  if (myJid && num === myJid.split("@")[0].split(":")[0]) return "Kamu";
  if (myJidLid && num === myJidLid.split("@")[0].split(":")[0]) return "Kamu";
  if (senderName && !senderName.includes("@")) return senderName;
  return num;
}

function renderBubble(m) {
  const side = m.from_me ? "me" : "other";
  const isGroup = activeJid && activeJid.endsWith("@g.us");
  const senderLabel = (!m.from_me && isGroup)
    ? `<div class="sender">${escapeHtml((m.sender_name || "").split("@")[0])}</div>` : "";

  let mediaHTML = "";
  let bodyText = m.text;
  if (m.type === "document") {
    const full = `/api/media?jid=${encodeURIComponent(activeJid)}&id=${encodeURIComponent(m.id)}&token=${encodeURIComponent(TOKEN)}`;
    const name = m.file_name || (bodyText && bodyText.startsWith("📄 ") ? bodyText.slice(2) : "Dokumen");
    mediaHTML = docChipHTML({ name, size: m.file_size, full });
    if (bodyText && bodyText.startsWith("📄 ")) bodyText = ""; // nama berkas sudah di chip; sisakan caption saja
  } else if ((m.type === "image" || m.type === "video") && m.thumb) {
    const src = `data:image/jpeg;base64,${m.thumb}`;
    const full = `/api/media?jid=${encodeURIComponent(activeJid)}&id=${encodeURIComponent(m.id)}&token=${encodeURIComponent(TOKEN)}`;
    if (m.type === "image") {
      mediaHTML = imgHTML(full, src);
    } else {
      mediaHTML = `<div class="media-video" data-full="${escapeHtml(full)}" data-kind="video"><img class="media" loading="lazy" src="${src}" alt=""><span class="play">▶</span></div>`;
    }
    if (bodyText === PLACEHOLDER_TEXT[m.type]) bodyText = ""; // jangan tampilkan placeholder sbg caption
  } else if (m.type === "sticker") {
    const full = `/api/media?jid=${encodeURIComponent(activeJid)}&id=${encodeURIComponent(m.id)}&token=${encodeURIComponent(TOKEN)}`;
    mediaHTML = `<div class="sticker"><img class="sticker-img" loading="lazy" src="${full}" alt="stiker"></div>`;
    bodyText = ""; // jangan tampilkan "🌟 Stiker"
  }
  const bodyHTML = bodyText ? `<div class="body">${bbmify(linkify(escapeHtml(bodyText)))}</div>` : "";
  // pesan yang isinya hanya emoji → tampil besar tanpa bubble (ala WA)
  const emojiOnly = bodyText && !mediaHTML && !m.quoted_id && isEmojiOnly(bodyText);
  const bbmOnly = bodyText && !mediaHTML && !m.quoted_id && isBbmOnly(bodyText);

  // blok kutipan bila pesan ini membalas pesan lain
  let quotedHTML = "";
  if (m.quoted_id) {
    const qs = quotedLabel(m.quoted_sender, m.quoted_sender_name);
    quotedHTML = `<div class="quoted" data-qid="${escapeHtml(m.quoted_id)}">${qs ? `<div class="q-sender">${escapeHtml(qs)}</div>` : ""}<div class="q-text">${bbmify(escapeHtml(m.quoted_text || "(media)"))}</div></div>`;
  }

  // preview untuk dipakai saat pesan ini DIBALAS
  const replyPreview = bodyText || PLACEHOLDER_TEXT[m.type] || m.text || "";
  const replySender = m.from_me ? "Kamu" : (m.sender_name || "").split("@")[0];

  const metaMark = m.deleted ? `<span class="del-mark">🚫 dihapus</span> · ` : (m.edited ? "diedit · " : "");

  // reaksi emoji (chip di bawah bubble) — data utk deteksi perubahan saat poll.
  const reactList = m.reactions || [];
  const reactTotal = m.react_total || 0;
  const myReact = m.my_reaction || "";
  const reactChip = reactTotal
    ? `<button type="button" class="reactions${myReact ? " mine" : ""}">${reactionsInner(reactList, reactTotal)}</button>` : "";

  return `<div class="bubble ${side}${emojiOnly ? " emoji-only" : ""}${bbmOnly ? " bbm-only" : ""}${m.type === "sticker" ? " sticker-msg" : ""}${m.deleted ? " deleted" : ""}${reactTotal ? " has-react" : ""}" data-ts="${m.timestamp}" data-id="${escapeHtml(m.id)}" data-sender="${escapeHtml(m.sender || "")}" data-text="${escapeHtml(m.text || "")}" data-deleted="${m.deleted ? 1 : 0}" data-rtext="${escapeHtml(replyPreview)}" data-rsender="${escapeHtml(replySender)}" data-react="${escapeHtml(reactSig(reactList, myReact))}" data-reactjson="${escapeHtml(JSON.stringify(reactList))}" data-myreact="${escapeHtml(myReact)}">
    <button class="menu-btn" title="Menu pesan">⋮</button>
    ${senderLabel}${quotedHTML}${mediaHTML}${bodyHTML}
    <div class="meta">${metaMark}${fmtTime(m.timestamp)}</div>
    ${reactChip}
  </div>`;
}

// ---------- reaksi emoji ----------
const QUICK_REACTS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

// Tanda-tangan reaksi (untuk deteksi perubahan saat poll): daftar emoji+jumlah + emoji-ku.
function reactSig(list, mine) {
  return (list || []).map((r) => r.emoji + ":" + r.count).join(",") + "|" + (mine || "");
}
// Isi chip reaksi: maks 3 emoji unik + total bila > 1.
function reactionsInner(list, total) {
  const emojis = (list || []).slice(0, 3).map((r) => `<span class="re-emo">${escapeHtml(r.emoji)}</span>`).join("");
  const cnt = total > 1 ? `<span class="re-count">${total}</span>` : "";
  return emojis + cnt;
}
// Perbarui chip reaksi sebuah bubble di tempat (dipakai poll & optimistik).
function setBubbleReactions(b, list, mine) {
  list = (list || []).filter((r) => r.count > 0);
  const total = list.reduce((s, r) => s + r.count, 0);
  b.dataset.react = reactSig(list, mine);
  b.dataset.reactjson = JSON.stringify(list);
  b.dataset.myreact = mine || "";
  let chip = b.querySelector(":scope > .reactions");
  if (!total) { if (chip) chip.remove(); b.classList.remove("has-react"); return; }
  if (!chip) { chip = document.createElement("button"); chip.type = "button"; chip.className = "reactions"; b.appendChild(chip); }
  chip.classList.toggle("mine", !!mine);
  chip.innerHTML = reactionsInner(list, total);
  b.classList.add("has-react");
}
// Sesuaikan reaksi lokal seketika (sebelum server balas): geser jumlah emoji-ku.
function applyReactionOptimistic(b, oldEmoji, newEmoji) {
  let list = [];
  try { list = JSON.parse(b.dataset.reactjson || "[]"); } catch (e) { list = []; }
  if (oldEmoji) {
    const it = list.find((x) => x.emoji === oldEmoji);
    if (it) { it.count--; if (it.count <= 0) list = list.filter((x) => x !== it); }
  }
  if (newEmoji) {
    const it = list.find((x) => x.emoji === newEmoji);
    if (it) it.count++; else list.push({ emoji: newEmoji, count: 1 });
  }
  setBubbleReactions(b, list, newEmoji);
}
// Kirim/ubah/lepas reaksi-ku pada sebuah pesan (klik emoji yg sama = lepas).
async function react(id, emoji) {
  if (!activeJid) return;
  let b = null;
  try { b = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`); } catch (e) {}
  const mine = b ? (b.dataset.myreact || "") : "";
  const next = (mine === emoji) ? "" : emoji;
  if (b) applyReactionOptimistic(b, mine, next);
  try {
    await api("/api/react", { method: "POST", body: JSON.stringify({ jid: activeJid, id, emoji: next }) });
  } catch (e) {
    if (b) applyReactionOptimistic(b, next, mine); // balikkan bila gagal
    toast("Gagal reaksi: " + e.message, "err");
  }
}

// Event delegation untuk pesan: tombol menu (⋮), klik kutipan, klik media.
$("messages").addEventListener("click", (e) => {
  const mbtn = e.target.closest(".menu-btn");
  if (mbtn) {
    e.stopPropagation();
    const b = mbtn.closest(".bubble");
    if (b) { const r = mbtn.getBoundingClientRect(); openMsgMenu(b, r.left, r.bottom + 2); }
    return;
  }
  const rchip = e.target.closest(".reactions");
  if (rchip) {
    e.stopPropagation();
    const b = rchip.closest(".bubble");
    if (b) { const r = rchip.getBoundingClientRect(); openMsgMenu(b, r.left, r.top - 6); }
    return;
  }
  const q = e.target.closest(".quoted[data-qid]");
  if (q) { scrollToMessage(q.dataset.qid); return; }
  const dc = e.target.closest(".doc-chip[data-full]");
  if (dc) { downloadDoc(dc.dataset.full, dc.dataset.name); return; }
  const rt = e.target.closest(".media-retry");
  if (rt) { e.stopPropagation(); retryImg(rt.closest(".media-img")); return; }
  const vid = e.target.closest(".media-video[data-full]");
  if (vid) { openLightbox(vid.dataset.full, "video"); return; }
  const imgWrap = e.target.closest(".media-img[data-full]");
  if (imgWrap) { if (!imgWrap.classList.contains("failed")) openLightbox(imgWrap.dataset.full, "image"); return; }
  const img = e.target.closest("img.media[data-full]");   // bubble optimistik (blob lokal)
  if (img) openLightbox(img.dataset.full, "image");
});

// Load/error gambar full-res. Event load/error TIDAK bubble → pakai fase CAPTURE di
// container (satu listener, menangani semua .media-loader). Inline onload/onerror tak
// dipakai karena diblokir CSP (script-src 'self' tanpa unsafe-inline).
$("messages").addEventListener("load", (e) => {
  if (e.target.classList && e.target.classList.contains("media-loader")) imgLoaded(e.target);
}, true);
$("messages").addEventListener("error", (e) => {
  const t = e.target;
  if (t.classList && t.classList.contains("media-loader")) imgFailed(t);
  else if (t.classList && t.classList.contains("sticker-img")) {
    const wrap = t.closest(".sticker");          // stiker lama (tanpa raw) / kedaluwarsa
    if (wrap) wrap.innerHTML = `<div class="sticker-fallback">🌟 Stiker</div>`;
  }
}, true);

// ---------- menu konteks pesan (klik-kanan / long-press) ----------
function openMsgMenu(b, x, y) {
  const id = b.dataset.id, name = b.dataset.rsender || "", text = b.dataset.rtext || "", sender = b.dataset.sender || "";
  const fromMe = b.classList.contains("me");
  const inGroup = activeJid && activeJid.endsWith("@g.us");
  const isSticker = b.classList.contains("sticker-msg");
  const items = [];
  if (text && !isSticker) items.push({ label: "📋 Salin teks", act: () => copyText(text) });
  items.push({ label: "↩️ Balas", act: () => startReply(id, name, text) });
  items.push({ label: "📌 Tandai sebagai tugas", act: () => addTaskPending(id, text, ts, name, $("convTitle").textContent) });
  if (isSticker) items.push({ label: "⭐ Simpan stiker", act: () => saveSticker(activeJid, id) });
  // Edit: hanya pesan SENDIRI, berupa teks (tanpa media), & masih < 15 menit (batas WhatsApp).
  const ts = Number(b.dataset.ts) || 0;
  const hasMedia = b.querySelector(".media-img, .media-video, .doc-chip");
  if (fromMe && b.querySelector(".body") && !hasMedia && (Date.now() / 1000 - ts) < 900) {
    items.push({ label: "✏️ Edit", act: () => startEdit(id, b.dataset.text || text) });
  }
  // Balas pribadi: di GRUP, pada pesan orang lain dengan pengirim ber-jid
  // (@s.whatsapp.net atau @lid — yang @lid di-resolve ke nomor asli saat diklik).
  if (inGroup && !fromMe && (sender.endsWith("@s.whatsapp.net") || sender.endsWith("@lid"))) {
    items.push({ label: "👤 Balas pribadi", act: () => replyPrivately(sender, name, id, text) });
  }
  // Hapus untuk semua (delete-for-everyone): hanya pesan SENDIRI yang sudah punya
  // tanda dihapus dilewati. WA membatasi sekitar 2 hari; di luar itu server akan menolak.
  if (fromMe && b.dataset.deleted !== "1") {
    items.push({ label: "🗑️ Hapus untuk semua", act: () => deleteForEveryone(id) });
  }
  const menu = $("msgMenu");
  menu.innerHTML = "";
  // Bar reaksi cepat di atas menu (berlaku utk semua pesan, termasuk media/stiker/pesan orang).
  // Klik emoji yang sama dengan reaksi-ku = lepas reaksi.
  const mine = b.dataset.myreact || "";
  const bar = document.createElement("div");
  bar.className = "react-bar";
  QUICK_REACTS.forEach((em) => {
    const rb = document.createElement("button");
    rb.type = "button";
    rb.className = "react-pick" + (em === mine ? " active" : "");
    rb.textContent = em;
    rb.onclick = () => { closeMsgMenu(); react(id, em); };
    bar.appendChild(rb);
  });
  menu.appendChild(bar);
  items.forEach((it) => {
    const btn = document.createElement("button");
    btn.textContent = it.label;
    btn.onclick = () => { closeMsgMenu(); it.act(); };
    menu.appendChild(btn);
  });
  menu.classList.remove("hidden");
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(x, window.innerWidth - mw - 8)) + "px";
  menu.style.top = Math.max(8, Math.min(y, window.innerHeight - mh - 8)) + "px";
}
function closeMsgMenu() { $("msgMenu").classList.add("hidden"); }

// ---------- tugas pending ----------
async function loadPendingTasks() {
  try { pendingTasks = await api("/api/pending"); } catch (e) { return; }
  setFilterCount("pending", pendingTasks.length);
  if (chatFilter === "pending") renderPendingList();
}

function renderPendingList() {
  const list = $("chatList");
  // Bersihkan semua anak kecuali #chatMore; sembunyikan footer infinite-scroll.
  [...list.children].forEach((n) => { if (n.id !== "chatMore") n.remove(); });
  const cm = document.getElementById("chatMore");
  if (cm) cm.classList.add("hidden");

  if (!pendingTasks.length) {
    const msg = document.createElement("div");
    msg.className = "list-msg";
    msg.textContent = "Belum ada tugas. Klik kanan pesan mana pun → Tandai sebagai tugas.";
    list.insertBefore(msg, cm || null);
    return;
  }
  const frag = document.createDocumentFragment();
  const myNum = myJid ? myJid.split("@")[0] : "";
  for (const t of pendingTasks) {
    const isGrp = (t.chat_jid || "").endsWith("@g.us");
    const chatNameRaw = t.chat_name || t.chat_jid;
    const preview = (t.msg_text || "").length > 80 ? (t.msg_text || "").slice(0, 80) + "…" : (t.msg_text || "—");
    const senderIsMe = !t.msg_sender || (myNum && t.msg_sender.startsWith(myNum)) || t.msg_sender === "Kamu";
    const senderHtml = isGrp && !senderIsMe ? `<div class="pending-sender">${escapeHtml(t.msg_sender)}</div>` : "";
    const el = document.createElement("div");
    el.className = "pending-item";
    el.dataset.pid = t.id;
    el.innerHTML =
      `<span class="avatar"><span class="avatar-initials" style="background:${avatarColor(t.chat_jid)}">${avatarInitials(chatNameRaw, isGrp)}</span><img class="avatar-img" alt=""></span>` +
      `<div class="pending-main">` +
        `<div class="pending-row"><span class="pending-name">${escapeHtml(chatNameRaw)}</span><span class="pending-time">${fmtTime(t.added_ts)}</span></div>` +
        senderHtml +
        `<div class="pending-preview">${escapeHtml(preview)}</div>` +
      `</div>` +
      `<button class="pending-done" title="Selesai / hapus tugas">✓</button>`;
    el.querySelector(".avatar-img").src = avatarUrl(t.chat_jid);
    const pid = t.id;
    el.querySelector(".pending-done").addEventListener("click", (e) => { e.stopPropagation(); markTaskDone(pid); });
    el.addEventListener("click", () => openChatFromPending(t.chat_jid, chatNameRaw, t.msg_id, t.msg_ts));
    frag.appendChild(el);
  }
  list.insertBefore(frag, cm || null);
  // Listener load/error avatar sudah ada via wireAvatarLoaders($("chatList")) di bawah.
}

async function markTaskDone(id) {
  try {
    await api("/api/pending/remove", { method: "POST", body: JSON.stringify({ id }) });
    pendingTasks = pendingTasks.filter((t) => t.id !== id);
    setFilterCount("pending", pendingTasks.length);
    if (chatFilter === "pending") renderPendingList();
    toast("✓ Tugas selesai", "ok");
  } catch (e) { toast("Gagal menghapus tugas", "err"); }
}

async function addTaskPending(msgId, msgText, msgTs, msgSender, chatName) {
  try {
    const r = await api("/api/pending", {
      method: "POST",
      body: JSON.stringify({ jid: activeJid, msgId, msgText, msgTs, msgSender, chatName }),
    });
    if (r.added) {
      toast("📌 Ditambahkan ke tugas pending");
      await loadPendingTasks();
    } else {
      toast("Sudah ada di daftar tugas");
    }
  } catch (e) { toast("Gagal menambahkan tugas", "err"); }
}

// Buka chat dan loncat ke pesan yang di-tag pending. Keluar dari mode pending (kembali ke "all").
async function openChatFromPending(jid, name, msgId, msgTs) {
  chatFilter = "all";
  localStorage.setItem("wa_filter", "all");
  document.querySelectorAll(".filter-tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === "all"));
  await openChatToMessage(jid, name, msgId, msgTs || 0);
}

// Hapus pesan sendiri untuk semua. Konten asli tetap tampil di mirror (anti-delete),
// hanya diberi tanda "🚫 dihapus" — sama seperti saat orang lain menarik pesan.
async function deleteForEveryone(id) {
  if (!confirm("Hapus pesan ini untuk semua orang?")) return;
  try {
    await api("/api/delete", { method: "POST", body: JSON.stringify({ jid: activeJid, id }) });
    let b = null;
    try { b = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`); } catch (e) {}
    if (b) markDeletedBubble(b);
    toast("Pesan dihapus", "ok", 1500);
  } catch (e) {
    toast("Gagal hapus: " + e.message, "err");
  }
}

async function copyText(t) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(t);
    else { const ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    toast("Teks disalin", "ok", 1200);
  } catch (e) { toast("Gagal menyalin", "err"); }
}

// Balas pribadi: buka chat pribadi pengirim lalu siapkan kutipan pesan grupnya.
// Anggota grup yang ber-jid @lid (alamat tersembunyi) di-resolve dulu ke nomor asli via
// server; bila tak ada mapping, fallback kirim langsung ke @lid. Kutipan native nyambung
// bila pesan asli masih di cache server, kalau tidak tetap terkirim sebagai teks.
async function replyPrivately(senderJid, name, msgId, text) {
  const groupJid = activeJid;                  // jid grup ASAL (sebelum pindah chat) → utk quote lintas-chat
  const title = name || senderJid.split("@")[0];
  let target = senderJid;
  if (senderJid.endsWith("@lid")) {
    toast("Mencari nomor…", "", 1200);
    try {
      const r = await api(`/api/resolve-jid?jid=${encodeURIComponent(senderJid)}`);
      if (r && r.jid) target = r.jid;          // ketemu nomor asli
      else toast("Nomor tersembunyi — coba kirim via alamat grup", "", 2200);
    } catch (e) { /* pakai jid asli sebagai fallback */ }
  }
  toast("Balas pribadi ke " + title, "", 1500);
  await openChat(target, title);
  startReply(msgId, name || title, text, groupJid);  // bawa jid grup biar quote nyambung di WA asli
}

$("messages").addEventListener("contextmenu", (e) => {
  const b = e.target.closest(".bubble");
  if (!b) return;
  e.preventDefault();
  openMsgMenu(b, e.clientX, e.clientY);
});
// Long-press untuk sentuh (mobile).
let lpTimer = null;
$("messages").addEventListener("touchstart", (e) => {
  const b = e.target.closest(".bubble");
  if (!b) return;
  const t = e.touches[0];
  lpTimer = setTimeout(() => openMsgMenu(b, t.clientX, t.clientY), 500);
}, { passive: true });
const cancelLp = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
$("messages").addEventListener("touchend", cancelLp);
$("messages").addEventListener("touchmove", cancelLp);
document.addEventListener("click", (e) => { if (!e.target.closest("#msgMenu")) closeMsgMenu(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMsgMenu(); });
$("messages").addEventListener("scroll", closeMsgMenu);

// Swipe bubble ke KANAN → balas cepat (mobile). Bubble ikut jari; lepas lewat ambang → reply.
let swEl = null, swX = 0, swY = 0, swDx = 0, swActive = false;
$("messages").addEventListener("touchstart", (e) => {
  if (window.innerWidth > 768 || e.touches.length > 1) return;
  const t = e.touches[0];
  if (t.clientX <= 30) return;                 // sisakan tepi kiri utk gestur "kembali"
  const b = e.target.closest(".bubble");
  if (!b) return;
  swEl = b; swX = t.clientX; swY = t.clientY; swDx = 0; swActive = false;
}, { passive: true });
$("messages").addEventListener("touchmove", (e) => {
  if (!swEl) return;
  const t = e.touches[0];
  const dx = t.clientX - swX, dy = t.clientY - swY;
  if (!swActive) {
    if (Math.abs(dy) > Math.abs(dx)) { swEl = null; return; } // vertikal → biarkan scroll
    if (dx < 8) return;
    swActive = true; swEl.style.transition = "none";
  }
  if (dx > 0) { swDx = Math.min(dx, 96); e.preventDefault(); swEl.style.transform = "translateX(" + swDx + "px)"; }
}, { passive: false });
function endSwipeReply() {
  if (!swEl) return;
  const el = swEl, dx = swDx;
  el.style.transition = ""; el.style.transform = "";
  swEl = null; swDx = 0; swActive = false;
  if (dx > 55) startReply(el.dataset.id, el.dataset.rsender, el.dataset.rtext);
}
$("messages").addEventListener("touchend", endSwipeReply);
$("messages").addEventListener("touchcancel", endSwipeReply);

// ---------- reply (balas/kutip) ----------
// srcJid: jid chat ASAL pesan yg dikutip (dipakai saat "balas pribadi" — pesan asli di grup,
// dikirim ke chat pribadi). Kosong = kutip pesan di chat yang sama.
function startReply(id, sender, text, srcJid) {
  replyTo = { id, sender: sender || "", text: text || "", srcJid: srcJid || "" };
  $("replySender").textContent = sender || "Pesan";
  $("replyText").innerHTML = bbmify(escapeHtml(text || ""));
  $("replyBar").classList.remove("hidden");
  $("sendInput").focus();
}
function clearReply() {
  replyTo = null;
  $("replyBar").classList.add("hidden");
}
$("replyCancel").onclick = clearReply;

// ---------- edit pesan ----------
function startEdit(id, text) {
  clearReply();
  editingId = id;
  $("editText").textContent = text || "";
  $("editBar").classList.remove("hidden");
  setComposeText(text || "");
  $("sendInput").focus();
}
function cancelEdit() {
  editingId = null;
  $("editBar").classList.add("hidden");
  clearCompose();
}
$("editCancel").onclick = cancelEdit;
function markEdited(b) {
  const meta = b.querySelector(".meta");
  if (meta && !meta.dataset.edited) { meta.dataset.edited = "1"; meta.textContent = "diedit · " + meta.textContent; }
}
// Tandai bubble sebagai dihapus pengirim (konten asli tetap tampil — anti-delete).
function markDeletedBubble(b) {
  if (b.dataset.deleted === "1") return;
  b.dataset.deleted = "1";
  b.classList.add("deleted");
  const meta = b.querySelector(".meta");
  if (meta) {
    const ts = Number(b.dataset.ts) || 0;
    meta.innerHTML = `<span class="del-mark">🚫 dihapus</span> · ${fmtTime(ts)}`;
  }
}
async function submitEdit() {
  const text = getComposeText().trim();
  const id = editingId;
  if (!text || !id) { cancelEdit(); return; }
  setBtnLoading($("sendBtn"), true);
  try {
    await api("/api/edit", { method: "POST", body: JSON.stringify({ jid: activeJid, id, text }) });
    const b = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`);
    if (b) {
      b.dataset.text = text; b.dataset.rtext = text;
      const body = b.querySelector(".body");
      if (body) body.innerHTML = bbmify(linkify(escapeHtml(text)));
      markEdited(b);
    }
    cancelEdit();
    toast("Pesan diedit", "ok", 1500);
  } catch (e) {
    toast("Gagal edit: " + e.message, "err");
  } finally {
    setBtnLoading($("sendBtn"), false);
  }
}

function scrollToMessage(id) {
  let el = null;
  try { el = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`); } catch (e) {}
  if (!el) { toast("Pesan asli belum dimuat di layar"); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
function quoteBlockHTML(quote) {
  if (!quote) return "";
  return `<div class="quoted" data-qid="${escapeHtml(quote.id || "")}"><div class="q-sender">${escapeHtml(quote.sender || "")}</div><div class="q-text">${bbmify(escapeHtml(quote.text || ""))}</div></div>`;
}

// ---- lightbox + zoom gambar ----
const LB_MIN = 1, LB_MAX = 6, LB_STEP = 0.5;
let lbImg = null, lbScale = 1, lbTx = 0, lbTy = 0;

function openLightbox(url, kind) {
  const lb = $("lightbox");
  const content = $("lightboxContent");
  content.innerHTML = `<div class="lb-loading"><span class="spinner"></span></div>`;
  lb.classList.remove("hidden");
  lbImg = null;
  if (kind === "image") {
    const img = new Image();
    img.className = "lb-media zoomable";
    img.draggable = false;
    img.onload = () => {
      content.innerHTML = ""; content.appendChild(img);
      lbImg = img; lbSetZoom(1, true);
      $("lbZoom").classList.remove("hidden");
    };
    img.onerror = lightboxError;
    img.src = url;
  } else {
    $("lbZoom").classList.add("hidden");
    const v = document.createElement("video");
    v.className = "lb-media";
    v.controls = true; v.autoplay = true;
    v.onloadeddata = () => { content.innerHTML = ""; content.appendChild(v); };
    v.onerror = lightboxError;
    v.src = url;
  }
}
function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lightboxContent").innerHTML = "";
  $("lbZoom").classList.add("hidden");
  lbImg = null; lbScale = 1; lbTx = 0; lbTy = 0;
}
function lightboxError() { closeLightbox(); toast("Media tidak tersedia (mungkin sudah kedaluwarsa)", "err"); }

function applyLbTransform() {
  if (!lbImg) return;
  lbImg.style.transform = `translate(${lbTx}px, ${lbTy}px) scale(${lbScale})`;
  lbImg.classList.toggle("zoomable", lbScale <= LB_MIN);
}
function lbSetZoom(scale, reset) {
  lbScale = Math.min(LB_MAX, Math.max(LB_MIN, Math.round(scale * 100) / 100));
  if (reset || lbScale <= LB_MIN) { lbTx = 0; lbTy = 0; }
  applyLbTransform();
  $("lbZoomLevel").textContent = Math.round(lbScale * 100) + "%";
  $("lbZoomOut").disabled = lbScale <= LB_MIN;
  $("lbZoomIn").disabled = lbScale >= LB_MAX;
}
function lbZoomBy(delta) { if (lbImg) lbSetZoom(lbScale + delta); }

$("lbZoomOut").onclick = () => lbZoomBy(-LB_STEP);
$("lbZoomIn").onclick = () => lbZoomBy(LB_STEP);
$("lbZoomLevel").onclick = () => lbSetZoom(1, true);

$("lightboxContent").addEventListener("wheel", (e) => {
  if (!lbImg) return;
  e.preventDefault();
  lbZoomBy(e.deltaY < 0 ? LB_STEP : -LB_STEP);
}, { passive: false });

$("lightboxContent").addEventListener("dblclick", (e) => {
  if (!lbImg) return;
  e.preventDefault();
  lbSetZoom(lbScale > LB_MIN ? 1 : 2.5, lbScale > LB_MIN);
});

// geser (pan) saat ter-zoom — pointer + cubit (pinch) di sentuh
let lbPan = null;
const lbPointers = new Map();
let lbPinchDist = 0;
$("lightboxContent").addEventListener("pointerdown", (e) => {
  if (!lbImg) return;
  lbPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lbPointers.size === 2) {
    const p = [...lbPointers.values()];
    lbPinchDist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    lbPan = null;
  } else if (lbScale > LB_MIN) {
    lbPan = { x: e.clientX, y: e.clientY, tx: lbTx, ty: lbTy };
    lbImg.classList.add("grabbing");
    lbImg.setPointerCapture(e.pointerId);
  }
});
$("lightboxContent").addEventListener("pointermove", (e) => {
  if (!lbImg) return;
  if (lbPointers.has(e.pointerId)) lbPointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (lbPointers.size === 2 && lbPinchDist) {
    const p = [...lbPointers.values()];
    const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
    lbSetZoom(lbScale * (d / lbPinchDist));
    lbPinchDist = d;
    return;
  }
  if (lbPan) {
    lbTx = lbPan.tx + (e.clientX - lbPan.x);
    lbTy = lbPan.ty + (e.clientY - lbPan.y);
    applyLbTransform();
  }
});
function lbPointerUp(e) {
  lbPointers.delete(e.pointerId);
  if (lbPointers.size < 2) lbPinchDist = 0;
  if (lbPan) { lbPan = null; if (lbImg) lbImg.classList.remove("grabbing"); }
}
$("lightboxContent").addEventListener("pointerup", lbPointerUp);
$("lightboxContent").addEventListener("pointercancel", lbPointerUp);

$("lightboxClose").onclick = closeLightbox;
$("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if ($("lightbox").classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  else if (lbImg && (e.key === "+" || e.key === "=")) lbZoomBy(LB_STEP);
  else if (lbImg && (e.key === "-" || e.key === "_")) lbZoomBy(-LB_STEP);
});
function ensureLoadOlder() {
  const box = $("messages");
  if (box.querySelector(".load-older")) return;
  const el = document.createElement("div");
  el.className = "load-older";
  el.textContent = "↑ Muat pesan lebih lama";
  el.onclick = loadOlder;
  box.insertBefore(el, box.firstChild);
}
async function loadOlder() {
  if (!activeJid || loadingOlder) return;
  const lo = $("messages").querySelector(".load-older");
  if (lo && (lo.classList.contains("done") || lo.classList.contains("busy"))) return;
  loadingOlder = true;
  if (lo) { lo.classList.add("busy"); lo.innerHTML = `<span class="spinner sm"></span><span>Memuat…</span>`; }
  try {
    const older = await api(`/api/messages?jid=${encodeURIComponent(activeJid)}&before=${oldestLoaded}&limit=50`);
    if (!older.length) {
      if (lo) { lo.classList.remove("busy"); lo.classList.add("done"); lo.textContent = "— awal percakapan —"; }
      return;
    }
    renderMessages(older, true);
    const lo2 = $("messages").querySelector(".load-older");
    if (lo2 && !lo2.classList.contains("done")) { lo2.classList.remove("busy"); lo2.textContent = "↑ Muat pesan lebih lama"; }
  } catch (e) {
    if (lo) { lo.classList.remove("busy"); lo.textContent = "↑ Muat pesan lebih lama"; }
    toast("Gagal memuat pesan lama", "err");
  } finally {
    loadingOlder = false;
  }
}
async function refreshNewest() {
  if (!activeJid) return;
  const box = $("messages");
  const bubbles = box.querySelectorAll(".bubble");
  const lastTs = bubbles.length ? Number(bubbles[bubbles.length - 1].dataset.ts) : 0;
  let msgs;
  try { msgs = await api(`/api/messages?jid=${encodeURIComponent(activeJid)}&limit=20`); }
  catch (e) { return; }
  // Pesan yang teksnya berubah (diedit) / dihapus pengirim → perbarui bubble di tempat.
  for (const m of msgs) {
    let ex = null;
    try { ex = box.querySelector(`.bubble[data-id="${CSS.escape(m.id)}"]`); } catch (e2) {}
    if (!ex) continue;
    if (m.deleted && ex.dataset.deleted !== "1") markDeletedBubble(ex); // hapus = tandai (konten tetap)
    if ((m.text || "") !== (ex.dataset.text || "")) {
      ex.dataset.text = m.text || ""; ex.dataset.rtext = m.text || "";
      const body = ex.querySelector(".body");
      if (body) body.innerHTML = bbmify(linkify(escapeHtml(m.text || "")));
      if (m.edited && !m.deleted) markEdited(ex);
    }
    // reaksi berubah (orang react/lepas) → perbarui chip di tempat
    const sig = reactSig(m.reactions, m.my_reaction);
    if ((ex.dataset.react || "") !== sig) setBubbleReactions(ex, m.reactions, m.my_reaction);
  }
  const fresh = msgs.filter((m) => m.timestamp > lastTs).reverse();
  if (fresh.length) {
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    // hindari duplikat dgn pesan optimistik yg sudah ada (match by id)
    const existingIds = new Set([...box.querySelectorAll(".bubble")].map((b) => b.dataset.id));
    const toAdd = fresh.filter((m) => !existingIds.has(m.id));
    if (!toAdd.length) return;
    box.insertAdjacentHTML("beforeend", toAdd.map(renderBubble).join(""));
    rebuildDaySeparators();
    if (nearBottom) scrollToBottom();
    else {
      const incoming = toAdd.filter((m) => !m.from_me).length;
      if (incoming) showJump(true);
    }
    // chat sedang dibuka → langsung tandai dibaca supaya tidak jadi unread saat pindah
    api("/api/read", { method: "POST", body: JSON.stringify({ jid: activeJid }) }).catch(() => {});
  }
}
function scrollToBottom() { const b = $("messages"); b.scrollTop = b.scrollHeight; hideJump(); }
function hideJump() { $("jumpBtn").classList.add("hidden"); $("jumpDot").classList.add("hidden"); }
function showJump(newMsg) { $("jumpBtn").classList.remove("hidden"); if (newMsg) $("jumpDot").classList.remove("hidden"); }
// Tampilkan tombol gulir-ke-bawah kapan pun user tidak di dekat dasar chat.
function updateJump() {
  if (jumpedToHistory) { $("jumpBtn").classList.remove("hidden"); return; } // selalu tampil = balik ke live
  const box = $("messages");
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 200) $("jumpBtn").classList.remove("hidden");
  else hideJump();
}
$("jumpBtn").onclick = () => {
  // Saat lihat potongan riwayat lama (hasil cari), ↓ = muat ulang chat ke pesan terbaru (live).
  if (jumpedToHistory) { jumpedToHistory = false; openChat(activeJid, $("convTitle").textContent); return; }
  scrollToBottom();
};

// load lebih lama saat scroll ke paling atas + atur tampil/sembunyi tombol gulir
$("messages").addEventListener("scroll", () => {
  const box = $("messages");
  if (box.scrollTop < 40) {
    const lo = box.querySelector(".load-older");
    if (lo && lo.textContent.startsWith("↑")) loadOlder();
  }
  // mode riwayat: dekat dasar → muat pesan lebih baru (lanjut ke bawah sampai nyusul live)
  if (jumpedToHistory && box.scrollHeight - box.scrollTop - box.clientHeight < 80) loadNewer();
  updateJump();
});

// ---------- lampiran media ----------
let pendingFile = null;        // { file, kind, url }
const MAX_MB = 64;

// Ekstensi dokumen & arsip (kompres) yang diizinkan sebagai lampiran dokumen.
const DOC_EXT = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "odt", "ods", "odp"];
const ARCHIVE_EXT = ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2"];
const fileExt = (name) => (String(name || "").split(".").pop() || "").toLowerCase();

// Ikon emoji per jenis berkas (dipakai di preview lampiran & bubble dokumen).
function docIcon(ext) {
  if (ext === "pdf") return "📕";
  if (["doc", "docx", "rtf", "odt", "txt"].includes(ext)) return "📄";
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return "📊";
  if (["ppt", "pptx", "odp"].includes(ext)) return "📈";
  if (ARCHIVE_EXT.includes(ext)) return "🗜️";
  return "📎";
}

$("attachBtn").onclick = () => $("fileInput").click();
$("attachCancel").onclick = clearAttach;
$("fileInput").addEventListener("change", () => {
  const f = $("fileInput").files[0];
  $("fileInput").value = "";    // reset agar file yang sama bisa dipilih ulang
  acceptFile(f);
});

// Terima sebuah File (dari picker, paste, atau drop) → validasi → jadikan lampiran.
function acceptFile(f) {
  if (!f) return false;
  const isImg = f.type.startsWith("image/");
  const isVid = f.type.startsWith("video/");
  let kind;
  if (isImg) kind = "image";
  else if (isVid) kind = "video";
  else {
    const ext = fileExt(f.name);
    if (DOC_EXT.includes(ext) || ARCHIVE_EXT.includes(ext)) kind = "document";
    else { toast("Format tak didukung (hanya foto, video, dokumen, atau arsip)", "err"); return false; }
  }
  if (f.size > MAX_MB * 1024 * 1024) { toast(`File terlalu besar (maks ${MAX_MB} MB)`, "err"); return false; }
  if (kind !== "document" && f.size > 16 * 1024 * 1024) toast("File >16 MB, WhatsApp mungkin menolaknya");
  if (pendingFile?.url) URL.revokeObjectURL(pendingFile.url);
  pendingFile = { file: f, kind, url: URL.createObjectURL(f) };
  showAttachPreview();
  return true;
}

// Paste gambar dari clipboard → langsung jadi lampiran (siap kirim).
document.addEventListener("paste", (e) => {
  if (!activeJid) return;                 // hanya saat ada chat terbuka (sudah login)
  const items = e.clipboardData && e.clipboardData.items;
  if (!items) return;
  for (const it of items) {
    if (it.kind === "file" && it.type.startsWith("image/")) {
      const f = it.getAsFile();
      if (f) {
        e.preventDefault();               // cegah paste data mentah ke input
        if (acceptFile(f)) toast("Gambar dari clipboard ditempel", "ok", 1500);
      }
      return;
    }
  }
  // tidak ada gambar → biarkan paste teks biasa berjalan normal
});

function fmtSize(b) {
  if (b < 1024) return b + " B";
  if (b < 1024 * 1024) return (b / 1024).toFixed(0) + " KB";
  if (b < 1024 * 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + " MB";
  return (b / 1024 / 1024 / 1024).toFixed(2) + " GB";
}
function showAttachPreview() {
  const p = pendingFile;
  if (p.kind === "document") {
    const ext = fileExt(p.file.name);
    $("attachThumb").innerHTML = `<span class="doc-emoji">${docIcon(ext)}</span>`;
    $("attachName").textContent = p.file.name || "dokumen";
    $("attachMeta").textContent = (ext ? ext.toUpperCase() : "Dokumen") + " · " + fmtSize(p.file.size);
  } else {
    $("attachThumb").innerHTML = p.kind === "image"
      ? `<img src="${p.url}" alt="">`
      : `<video src="${p.url}" muted></video>`;
    $("attachName").textContent = p.file.name || (p.kind === "image" ? "gambar-tempel.png" : "video");
    $("attachMeta").textContent = (p.kind === "image" ? "Foto" : "Video") + " · " + fmtSize(p.file.size);
  }
  $("attachPreview").classList.remove("hidden");
  setComposePlaceholder("Tambah keterangan…");
  $("sendInput").focus();
}
function clearAttach() {
  if (pendingFile?.url) URL.revokeObjectURL(pendingFile.url);
  pendingFile = null;
  $("attachThumb").innerHTML = "";
  $("attachPreview").classList.add("hidden");
  setComposePlaceholder("Ketik pesan…");
}

// ---------- send ----------
function finalizeBubble(tmpId, realId) {
  const el = $("messages").querySelector(`[data-id="${tmpId}"]`);
  if (!el) return;
  el.classList.remove("pending");
  if (realId) el.dataset.id = realId; // pakai id asli → tidak digandakan saat polling
  const meta = el.querySelector(".meta");
  if (meta) meta.textContent = fmtTime(Math.floor(Date.now() / 1000));
}
function removeBubble(tmpId) {
  const el = $("messages").querySelector(`[data-id="${tmpId}"]`);
  if (el) { el.remove(); rebuildDaySeparators(); }
}

// ---------- kolom ketik (contenteditable: bisa muat gambar emoticon BBM) ----------
// Serialisasi isi editor → teks polos: <img> emoticon → kode :bNNN:, <br>/<div> → newline.
function getComposeText() {
  const root = $("sendInput");
  let out = "";
  (function walk(node) {
    node.childNodes.forEach((n) => {
      if (n.nodeType === 3) out += n.nodeValue;
      else if (n.nodeType === 1) {
        if (n.classList && n.classList.contains("mention")) out += "@" + (n.dataset.num || "");
        else if (n.tagName === "IMG") out += n.dataset.code || n.getAttribute("alt") || "";
        else if (n.tagName === "BR") out += "\n";
        else {
          if (n.tagName === "DIV" && out && !out.endsWith("\n")) out += "\n";
          walk(n);
        }
      }
    });
  })(root);
  return out;
}
// Kumpulkan jid anggota yang masih ter-tag di editor (chip mention). Unik.
function getComposeMentions() {
  const set = new Set();
  $("sendInput").querySelectorAll(".mention[data-jid]").forEach((s) => {
    if (s.dataset.jid) set.add(s.dataset.jid);
  });
  return [...set];
}
function clearCompose() { $("sendInput").innerHTML = ""; }
// Isi editor dari teks (kode :bNNN: → gambar) — dipakai saat mengembalikan teks gagal kirim.
function setComposeText(text) {
  $("sendInput").innerHTML = bbmify(linkify(escapeHtml(text))).replace(/\n/g, "<br>");
}
function setComposePlaceholder(txt) { $("sendInput").dataset.ph = txt; }
function autoGrowInput() {}   // contenteditable tumbuh sendiri (CSS min/max-height)

// Kunci anti kirim-ganda: selama satu kirim masih berjalan (mis. koneksi WA
// lambat dan request menggantung), submit berikutnya ditolak agar pesan yang
// sama tidak menumpuk lalu ter-flush beberapa sekaligus saat koneksi pulih.
let sending = false;

$("sendForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!activeJid) return;
  if (editingId) { submitEdit(); return; }   // mode edit → simpan editan, bukan kirim baru
  if (sending) { toast("Tunggu, pesan sebelumnya masih dikirim…", "", 1500); return; } // teks dibiarkan utuh
  const text = getComposeText().trim();
  if (pendingFile) { sendMediaMsg(text); return; }
  if (text) sendTextMsg(text);
});

// Desktop: Enter = kirim, Shift+Enter = baris baru (seperti WA Web).
// Mobile (≤768px): Enter = baris baru (keyboard layar tak punya Shift) →
// biarkan default menyisipkan newline; kirim lewat tombol ➤.
// Saat picker @mention terbuka, tombol navigasi/pilih "ditelan" lebih dulu.
$("sendInput").addEventListener("keydown", (e) => {
  if (handleMentionKeydown(e)) return;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.innerWidth > 768) {
    e.preventDefault();
    $("sendForm").requestSubmit();
  }
});
// Paste sebagai teks polos (cegah HTML/format ikut masuk ke editor).
$("sendInput").addEventListener("paste", (e) => {
  const items = e.clipboardData && e.clipboardData.items;
  if (items) { for (const it of items) if (it.kind === "file" && it.type.startsWith("image/")) return; } // gambar → biar handler attach
  e.preventDefault();
  const t = (e.clipboardData || window.clipboardData).getData("text");
  if (t) document.execCommand("insertText", false, t);
});

async function sendTextMsg(text) {
  sending = true;                          // kunci anti kirim-ganda
  const mentions = getComposeMentions();   // baca chip mention SEBELUM editor dibersihkan
  const quote = replyTo;          // snapshot lalu bersihkan bar reply
  clearReply();
  clearCompose();
  closeMentionPicker();
  setBtnLoading($("sendBtn"), true);
  const box = $("messages");
  const tmpId = "tmp-" + Date.now();
  const disp = mentionifyText(text);        // @nomor → @nama untuk tampilan
  // samakan dgn renderBubble: pesan tanpa kutipan yg isinya hanya emoji / emoticon BBM → tampil besar tanpa bubble
  const bigCls = !quote ? (isEmojiOnly(disp) ? " emoji-only" : isBbmOnly(disp) ? " bbm-only" : "") : "";
  box.insertAdjacentHTML("beforeend",
    `<div class="bubble me pending${bigCls}" data-ts="${Math.floor(Date.now()/1000)}" data-id="${tmpId}" data-text="${escapeHtml(disp)}" data-rtext="${escapeHtml(disp)}" data-rsender="Kamu"><button class="menu-btn" title="Menu pesan">⋮</button>${quoteBlockHTML(quote)}<div class="body">${bbmify(linkify(escapeHtml(disp)))}</div><div class="meta">mengirim…</div></div>`);
  rebuildDaySeparators();
  scrollToBottom();
  try {
    const res = await api("/api/send", { method: "POST", timeout: 30000, body: JSON.stringify({ jid: activeJid, text, quotedId: quote?.id || "", quotedJid: quote?.srcJid || "", mentions }) });
    finalizeBubble(tmpId, res.id);
    setTimeout(refreshNewest, 600);
  } catch (err) {
    removeBubble(tmpId);
    setComposeText(text); // kembalikan teks supaya tidak hilang
    if (quote) startReply(quote.id, quote.sender, quote.text, quote.srcJid); // kembalikan bar reply
    toast("Gagal kirim: " + err.message, "err");
  } finally {
    sending = false;
    setBtnLoading($("sendBtn"), false);
    $("sendInput").focus();
  }
}

async function sendMediaMsg(caption) {
  sending = true;                                       // kunci anti kirim-ganda
  const mentions = caption ? getComposeMentions() : []; // chip mention di caption
  const { file, kind, url } = pendingFile;
  const jid = activeJid;
  const quote = replyTo;          // snapshot lalu bersihkan bar reply
  const dispCap = mentionifyText(caption); // @nomor → @nama untuk tampilan
  clearReply();
  closeMentionPicker();
  setBtnLoading($("sendBtn"), true);
  const box = $("messages");
  const tmpId = "tmp-" + Date.now();
  let mediaHTML;
  if (kind === "image") {
    mediaHTML = `<img class="media" src="${url}" data-full="${url}" data-kind="image" alt="">`;
  } else if (kind === "video") {
    mediaHTML = `<div class="media-video" data-full="${url}" data-kind="video"><video class="media" src="${url}" muted></video><span class="play">▶</span></div>`;
  } else {
    mediaHTML = docChipHTML({ name: file.name, size: file.size, full: url });
  }
  const capHTML = caption ? `<div class="body">${bbmify(linkify(escapeHtml(dispCap)))}</div>` : "";
  const rtext = dispCap || (kind === "image" ? "📷 Foto" : kind === "video" ? "🎥 Video" : "📄 " + file.name);
  box.insertAdjacentHTML("beforeend",
    `<div class="bubble me pending" data-ts="${Math.floor(Date.now()/1000)}" data-id="${tmpId}" data-rtext="${escapeHtml(rtext)}" data-rsender="Kamu"><button class="menu-btn" title="Menu pesan">⋮</button>${quoteBlockHTML(quote)}${mediaHTML}${capHTML}<div class="meta">mengirim…</div></div>`);
  rebuildDaySeparators();
  scrollToBottom();

  // lepas preview (object URL masih dipakai bubble optimistik, jangan di-revoke)
  pendingFile = null;
  $("attachThumb").innerHTML = "";
  $("attachPreview").classList.add("hidden");
  clearCompose();
  setComposePlaceholder("Ketik pesan…");

  try {
    const qs = new URLSearchParams({ jid, kind, caption, quotedId: quote?.id || "", quotedJid: quote?.srcJid || "", fileName: kind === "document" ? file.name : "", mentions: mentions.join(",") });
    const fallbackType = kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/octet-stream";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90000); // gagal-cepat bila upload/koneksi menggantung
    let res;
    try {
      res = await fetch("/api/send-media?" + qs.toString(), {
        method: "POST",
        signal: ctrl.signal,
        headers: { "x-auth-token": TOKEN, "Content-Type": file.type || fallbackType },
        body: file,
      });
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? "waktu kirim habis (koneksi lambat)" : e.message);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 401) { logout(); throw new Error("unauthorized"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
    finalizeBubble(tmpId, data.id);
    toast(kind === "image" ? "Foto terkirim" : kind === "video" ? "Video terkirim" : "Dokumen terkirim", "ok", 1800);
  } catch (err) {
    removeBubble(tmpId);
    URL.revokeObjectURL(url);
    if (quote) startReply(quote.id, quote.sender, quote.text, quote.srcJid);
    toast("Gagal kirim media: " + err.message, "err");
  } finally {
    sending = false;
    setBtnLoading($("sendBtn"), false);
    $("sendInput").focus();
  }
}

// ---------- tema + warna aksen ----------
// Tema (Terang/Gelap/Senja) = base palette via data-theme di <html>.
// Warna aksen = override --green/--green-dark (+ tint bubble di tema terang).
// Aksen dibuat theme-aware: di tema gelap varian aksen dibikin LEBIH TERANG
// supaya tetap terbaca saat --green-dark dipakai sebagai warna teks.
const THEMES = ["light", "dark", "senja", "bbm"];
const DARK_THEMES = new Set(["dark", "senja", "bbm"]);
const ACCENTS = {
  green:  { base: "#00a884", light: "#008069", dark: "#21c7a8", bubble: "#d9fdd3" },
  blue:   { base: "#2f80ed", light: "#1c63c9", dark: "#53bdeb", bubble: "#d7e9ff" },
  purple: { base: "#7b5cff", light: "#5b3fd6", dark: "#b9a3ff", bubble: "#e9e1ff" },
  orange: { base: "#f0900c", light: "#c9760a", dark: "#f6a93b", bubble: "#ffe7c7" },
  rose:   { base: "#ff4f8b", light: "#d62e6a", dark: "#ff8fbb", bubble: "#ffe2ef" },
  teal:   { base: "#0d9488", light: "#0b7268", dark: "#2dd4bf", bubble: "#cdeee9" },
  maroon: { base: "#9b2335", light: "#7a1c2a", dark: "#cf6e7c", bubble: "#f1d6db" },
  ocean:  { base: "#087099", light: "#065d7d", dark: "#3aa6cc", bubble: "#d2ecf6" }, // biru header BBM
};
let curTheme = "light";
let curAccent = localStorage.getItem("wa_accent") || ""; // "" = ikut bawaan tema

function applyAccent() {
  const root = document.documentElement;
  const a = ACCENTS[curAccent];
  if (!a) {
    root.style.removeProperty("--green");
    root.style.removeProperty("--green-dark");
    root.style.removeProperty("--bubble-me");
  } else {
    root.style.setProperty("--green", a.base);
    root.style.setProperty("--green-dark", DARK_THEMES.has(curTheme) ? a.dark : a.light);
    if (DARK_THEMES.has(curTheme)) root.style.removeProperty("--bubble-me"); // tema gelap pakai bubble gelapnya
    else root.style.setProperty("--bubble-me", a.bubble);
  }
  document.querySelectorAll(".accent-swatches .swatch").forEach((s) =>
    s.classList.toggle("active", (s.dataset.accent || "") === curAccent));
}

function applyTheme(name) {
  curTheme = THEMES.includes(name) ? name : "light";   // nilai lama (green/blue/…) → light
  document.documentElement.setAttribute("data-theme", curTheme);
  localStorage.setItem("wa_theme", curTheme);
  document.querySelectorAll(".theme-opt").forEach((o) => o.classList.toggle("active", o.dataset.theme === curTheme));
  applyAccent(); // turunkan ulang aksen sesuai terang/gelap tema baru
}

$("themeBtn").onclick = (e) => { e.stopPropagation(); $("newChatPopover").classList.add("hidden"); $("themePopover").classList.toggle("hidden"); };
document.querySelectorAll(".theme-opt").forEach((o) => {
  o.onclick = () => {
    if (o.dataset.theme === curTheme) return;   // tema yang sama → tidak usah apa-apa
    applyTheme(o.dataset.theme);                // simpan pilihan ke localStorage
    location.reload();                          // reload → UI & status bar iOS paint fresh sesuai tema
  };
});
document.querySelectorAll(".accent-swatches .swatch").forEach((s) => {
  s.onclick = () => { curAccent = s.dataset.accent || ""; localStorage.setItem("wa_accent", curAccent); applyAccent(); };
});
// Tutup popover saat tap di luar. pointerdown (bukan click) → di iOS klik pada div/area kosong
// sering tak memicu; pointerdown selalu jalan. Bila tap-luar ini menutup popover, "telan" klik
// yang menyusul (fase capture) supaya TIDAK ikut membuka chat di belakangnya.
let _swallowClick = false;
document.addEventListener("pointerdown", (e) => {
  _swallowClick = false;
  const tp = $("themePopover"), np = $("newChatPopover");
  let closed = false;
  if (!tp.classList.contains("hidden") && !e.target.closest("#themePopover") && !e.target.closest("#themeBtn")) {
    tp.classList.add("hidden"); closed = true;
  }
  if (!np.classList.contains("hidden") && !e.target.closest("#newChatPopover") && !e.target.closest("#newChatBtn")) {
    np.classList.add("hidden"); closed = true;
  }
  if (closed) _swallowClick = true;
});
document.addEventListener("click", (e) => {
  if (_swallowClick) { _swallowClick = false; e.stopPropagation(); e.preventDefault(); }
}, true); // capture → jalan sebelum handler chat, jadi klik penutup popover tidak membuka chat
applyTheme(localStorage.getItem("wa_theme") || "light");

// ---------- chat baru ke nomor manual ----------
function setNewChatErr(msg) { $("newChatErr").textContent = msg || ""; }
async function startNewChat() {
  const raw = $("newChatNum").value.trim();
  if (!raw) return;
  setNewChatErr("");
  setBtnLoading($("newChatGo"), true);
  try {
    const r = await api(`/api/check-number?num=${encodeURIComponent(raw)}`);
    if (r && r.exists && r.jid) {
      $("newChatPopover").classList.add("hidden");
      $("newChatNum").value = "";
      const existing = allChats.find((c) => c.jid === r.jid);
      openChat(r.jid, existing ? existing.name : r.jid.split("@")[0]);
    } else {
      setNewChatErr(r && r.error ? r.error : "Nomor tidak terdaftar di WhatsApp.");
    }
  } catch (e) {
    setNewChatErr("Gagal memeriksa nomor.");
  } finally {
    setBtnLoading($("newChatGo"), false);
  }
}
$("newChatBtn").onclick = (e) => {
  e.stopPropagation();
  $("themePopover").classList.add("hidden");
  const willOpen = $("newChatPopover").classList.contains("hidden");
  $("newChatPopover").classList.toggle("hidden");
  if (willOpen) { setNewChatErr(""); $("newChatNum").focus(); }
};
$("newChatGo").onclick = startNewChat;
$("newChatClose").onclick = () => { $("newChatPopover").classList.add("hidden"); setNewChatErr(""); };
$("newChatNum").addEventListener("keydown", (e) => { if (e.key === "Enter") startNewChat(); });
// (tutup-di-luar untuk newChatPopover sudah ditangani handler pointerdown gabungan di atas)
// Pulihkan tab filter terakhir yang dipilih.
document.querySelectorAll(".filter-tab").forEach((t) => t.classList.toggle("active", t.dataset.filter === chatFilter));

// ---------- emoji picker ----------
// Kumpulan emoji per kategori (tanpa dependency; hindari ZWJ/skin-tone agar aman lintas platform).
const EMOJI = {
  smileys: "😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🥳 😏 😒 😞 😔 😟 😕 🙁 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🥴 🤢 🤮 🤧 😷 🤒 🤕 🤑 🤠 😈 👿 👻 💀 👽 🤖 💩".split(" "),
  gestures: "👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 ✍️ 💪 🦾 👏 🙌 👐 🤲 🫶 🤜 🤛 ✊ 👊 🫵 👀 👁️ 👅 👂 👃 🧠 🫀".split(" "),
  hearts: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ✨ ⭐ 🌟 💫 🔥 💥 💯 ✅ ❌ ⚠️ ❗ ❓ 💤 💬 👌".split(" "),
  animals: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🐤 🦆 🦉 🐴 🦄 🐝 🐛 🦋 🐢 🐍 🐙 🦀 🐬 🐳 🐟 🌹 🌷 🌸 🌺 🌻 🌼 🌳 🌲 🌴 🌵 🍀 🍂 🌍 🌙 ☀️ ⛅ ☁️ 🌧️ ⛈️ ❄️ 🌈 💧".split(" "),
  food: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥕 🌽 🌶️ 🥦 🍄 🥜 🍞 🧀 🍗 🍖 🌭 🍔 🍟 🍕 🌮 🌯 🥗 🍜 🍣 🍱 🍙 🍚 🍦 🍰 🎂 🍫 🍬 🍩 🍪 ☕ 🍵 🍺 🍻 🥂 🍷 🥤".split(" "),
  activity: "⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 🏆 🥇 🥈 🥉 🎯 🎮 🎲 🎸 🎤 🎧 🎬 🎨 🚗 🚕 🚙 🚌 🏍️ 🚲 ✈️ 🚀 🚁 🛵 🏠 🏢 🏖️ ⛰️ 🎉 🎊 🎁 🎈".split(" "),
  objects: "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 📷 📸 🎥 📺 🔋 🔌 💡 🔦 📔 📚 💰 💵 💳 ✉️ 📧 📦 📅 📌 📎 ✂️ 🔒 🔑 🔨 🛠️ ⚙️ 🧲 💉 💊 🚽 🧹 🛒 ⏰ ⏳".split(" "),
  symbols: "💯 🔔 🔕 ➕ ➖ ✖️ ➗ ♾️ ✔️ ☑️ 🔘 ⚫ ⚪ 🔴 🟠 🟡 🟢 🔵 🟣 🟤 🔺 🔻 ⬆️ ⬇️ ⬅️ ➡️ ↗️ ↘️ 🔁 🔄 🆗 🆕 🆒 🚫 ©️ ®️ ™️ #️⃣ 🇮🇩".split(" "),
};
const EMOJI_TABS = [
  { key: "recent",   icon: "🕒" },
  { key: "smileys",  icon: "😀" },
  { key: "gestures", icon: "👍" },
  { key: "hearts",   icon: "❤️" },
  { key: "animals",  icon: "🐶" },
  { key: "food",     icon: "🍔" },
  { key: "activity", icon: "⚽" },
  { key: "objects",  icon: "💡" },
  { key: "symbols",  icon: "🔣" },
  { key: "bbm",      icon: "🅱️" },
  { key: "sticker",  icon: "🌟" },
];
// Emoji BBM (kosmetik lokal): token :bNNN: ↔ gambar /bbm/bNNN.png (lihat scripts/fetch-bbm.js).
const BBM_TOKENS = Array.from({ length: 200 }, (_, i) => ":b" + String(i + 1).padStart(3, "0") + ":");
const bbmFile = (token) => { const m = /^:b(\d{3}):$/.exec(token); return m ? `/bbm/b${m[1]}.png` : ""; };
let emojiCat = "smileys";
let emojiBuilt = false;

function recentEmojis() {
  try { return JSON.parse(localStorage.getItem("wa_emoji_recent") || "[]"); } catch (e) { return []; }
}
function pushRecentEmoji(emo) {
  let list = recentEmojis().filter((x) => x !== emo);
  list.unshift(emo);
  list = list.slice(0, 24);
  localStorage.setItem("wa_emoji_recent", JSON.stringify(list));
}

function buildEmojiTabs() {
  $("emojiTabs").innerHTML = EMOJI_TABS.map(
    (t) => `<button type="button" class="etab" data-cat="${t.key}" title="${t.key}">${t.icon}</button>`
  ).join("");
}
// Tombol emoji: gambar untuk token BBM (:bNNN:), teks untuk emoji unicode.
function emojiButton(val) {
  const f = bbmFile(val);
  if (f) return `<button type="button" data-emo="${val}" title="${val}"><img class="bbm-pick" src="${f}" alt="" loading="lazy"></button>`;
  return `<button type="button" data-emo="${val}">${val}</button>`;
}
function renderEmojiGrid() {
  const grid = $("emojiGrid");
  document.querySelectorAll("#emojiTabs .etab").forEach((t) => t.classList.toggle("active", t.dataset.cat === emojiCat));
  grid.classList.toggle("stickers", emojiCat === "sticker"); // grid 4-kolom utk stiker
  if (emojiCat === "sticker") { renderStickerGrid(grid); return; }
  let list = emojiCat === "recent" ? recentEmojis()
    : emojiCat === "bbm" ? BBM_TOKENS
    : (EMOJI[emojiCat] || []);
  if (emojiCat === "recent" && !list.length) {
    grid.innerHTML = `<div class="egroup-label">Belum ada emoji yang sering dipakai</div>`;
  } else {
    grid.innerHTML = list.map(emojiButton).join("");
  }
}

// Render grid stiker favorit di dalam panel emoji (tab terakhir).
async function renderStickerGrid(grid) {
  grid.innerHTML = `<div class="sticker-empty">Memuat…</div>`;
  let list;
  try { list = await api("/api/stickers"); } catch (e) { grid.innerHTML = `<div class="sticker-empty">Gagal memuat.</div>`; return; }
  if (emojiCat !== "sticker") return; // user keburu pindah tab
  if (!Array.isArray(list) || !list.length) {
    grid.innerHTML = `<div class="sticker-empty">Belum ada stiker favorit.<br>Simpan dari stiker yang masuk: menu ⋮ pada stiker → Simpan stiker.</div>`;
    return;
  }
  grid.innerHTML = list.map((s) =>
    `<div class="sticker-cell" data-hash="${escapeHtml(s.hash)}" title="Kirim stiker">` +
      `<img loading="lazy" src="/api/sticker?hash=${encodeURIComponent(s.hash)}&token=${encodeURIComponent(TOKEN)}" alt="stiker">` +
      `<button type="button" class="sticker-rm" title="Hapus dari favorit">✕</button>` +
    `</div>`).join("");
}

// Sisipkan node pada posisi kursor di editor (contenteditable). Fallback ke akhir.
function insertAtCaret(node) {
  const root = $("sendInput");
  root.focus();
  const sel = window.getSelection();
  let range;
  if (sel && sel.rangeCount && root.contains(sel.anchorNode)) range = sel.getRangeAt(0);
  else { range = document.createRange(); range.selectNodeContents(root); range.collapse(false); }
  range.deleteContents();
  range.insertNode(node);
  range.setStartAfter(node); range.collapse(true);
  if (sel) { sel.removeAllRanges(); sel.addRange(range); }
}
// Sisipkan emoji: token BBM → gambar (biar tampil langsung, bukan kode), unicode → teks.
function insertEmoji(emo) {
  const f = bbmFile(emo);
  if (f) {
    const img = document.createElement("img");
    img.className = "bbm-emo"; img.src = f; img.dataset.code = emo; img.alt = emo;
    insertAtCaret(img);
  } else {
    insertAtCaret(document.createTextNode(emo));
  }
  pushRecentEmoji(emo);
}

function toggleEmojiPanel() {
  const panel = $("emojiPanel");
  const willOpen = panel.classList.contains("hidden");
  if (willOpen) {
    if (!emojiBuilt) { buildEmojiTabs(); emojiBuilt = true; }
    if (emojiCat !== "sticker") {                 // pertahankan tab stiker bila tadinya dibuka di situ
      if (recentEmojis().length) emojiCat = "recent";
      else if (emojiCat === "recent") emojiCat = "smileys";
    }
    renderEmojiGrid();
  }
  panel.classList.toggle("hidden");
}

$("emojiBtn").onclick = (e) => { e.stopPropagation(); toggleEmojiPanel(); };
$("emojiTabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".etab");
  if (!tab) return;
  emojiCat = tab.dataset.cat;
  renderEmojiGrid();
});
$("emojiGrid").addEventListener("click", (e) => {
  const rm = e.target.closest(".sticker-rm");
  if (rm) { e.stopPropagation(); const cell = rm.closest(".sticker-cell"); if (cell) removeStickerFav(cell.dataset.hash, cell); return; }
  const cell = e.target.closest(".sticker-cell");
  if (cell) { sendStickerFav(cell.dataset.hash); return; }   // klik stiker favorit → kirim
  const b = e.target.closest("button[data-emo]");
  if (b) insertEmoji(b.dataset.emo);   // panel tetap terbuka → bisa pilih beberapa
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#emojiPanel") && !e.target.closest("#emojiBtn")) $("emojiPanel").classList.add("hidden");
});

// ---------- stiker (tampilkan masuk + favorit) ----------
// Simpan stiker yang masuk ke favorit (server unduh WebP-nya lalu cache by hash).
async function saveSticker(jid, id) {
  toast("Menyimpan stiker…", "", 1200);
  try {
    const r = await api("/api/sticker/save", { method: "POST", body: JSON.stringify({ jid, id }) });
    if (r && r.ok) toast("Stiker disimpan ke favorit ⭐", "ok", 1600);
    else toast((r && r.error) || "Gagal simpan stiker", "err");
  } catch (e) { toast("Gagal simpan stiker", "err"); }
}

async function removeStickerFav(hash, cell) {
  try {
    await api("/api/sticker/remove", { method: "POST", body: JSON.stringify({ hash }) });
    cell.remove();
    if (!$("emojiGrid").querySelector(".sticker-cell")) renderEmojiGrid(); // tampilkan empty state
  } catch (e) { toast("Gagal hapus stiker", "err"); }
}

async function sendStickerFav(hash) {
  if (!activeJid) return;
  const jid = activeJid;
  const quote = replyTo; clearReply();
  const url = `/api/sticker?hash=${encodeURIComponent(hash)}&token=${encodeURIComponent(TOKEN)}`;
  const box = $("messages");
  const tmpId = "tmp-" + Date.now();
  box.insertAdjacentHTML("beforeend",
    `<div class="bubble me pending sticker-msg" data-ts="${Math.floor(Date.now()/1000)}" data-id="${tmpId}" data-rtext="🌟 Stiker" data-rsender="Kamu"><button class="menu-btn" title="Menu pesan">⋮</button>${quoteBlockHTML(quote)}<div class="sticker"><img class="sticker-img" src="${url}" alt="stiker"></div><div class="meta">mengirim…</div></div>`);
  rebuildDaySeparators();
  scrollToBottom();
  try {
    const res = await api("/api/sticker/send", { method: "POST", body: JSON.stringify({ jid, hash, quotedId: quote?.id || "", quotedJid: quote?.srcJid || "" }) });
    finalizeBubble(tmpId, res.id);
    setTimeout(refreshNewest, 600);
  } catch (e) {
    removeBubble(tmpId);
    if (quote) startReply(quote.id, quote.sender, quote.text, quote.srcJid);
    toast("Gagal kirim stiker: " + e.message, "err");
  }
}

// ---------- tag anggota grup (@mention) ----------
// Muat daftar anggota grup aktif (untuk autocomplete @). Chat pribadi → kosong.
async function loadGroupMembers(jid) {
  groupMembers = [];
  if (!jid || !jid.endsWith("@g.us")) return;
  try {
    const list = await api(`/api/group-members?jid=${encodeURIComponent(jid)}`);
    if (activeJid === jid && Array.isArray(list)) groupMembers = list;
  } catch (e) { /* fitur tag nonaktif utk grup ini bila gagal */ }
}

// "@<nomor>" → "@<nama>" memakai daftar anggota (untuk bubble optimistik; server juga
// melakukannya via resolveMentions saat memuat ulang, jadi bubble tetap konsisten).
function mentionifyText(text) {
  if (!text || text.indexOf("@") < 0 || !groupMembers.length) return text;
  return text.replace(/@(\d{5,})/g, (full, num) => {
    const mb = groupMembers.find((x) => x.num === num);
    return mb ? "@" + mb.name : full;
  });
}

function closeMentionPicker() {
  mentionState = null; mentionFiltered = []; mentionIdx = 0;
  $("mentionPicker").classList.add("hidden");
}

// Cari token "@query" tepat sebelum kursor. Return { node, start, end, query } atau null.
// Hanya cocok bila "@" di awal teks atau didahului spasi (hindari trigger pada email).
function detectMentionToken() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return null;
  const node = sel.anchorNode;
  if (!node || node.nodeType !== 3 || !$("sendInput").contains(node)) return null;
  const offset = sel.anchorOffset;
  const before = node.nodeValue.slice(0, offset);
  const m = before.match(/(^|[\s ])@([^\s@ ]*)$/);
  if (!m) return null;
  const query = m[2];
  return { node, start: offset - query.length - 1, end: offset, query };
}

function renderMentionPicker() {
  const picker = $("mentionPicker");
  if (!mentionFiltered.length) { picker.classList.add("hidden"); return; }
  picker.innerHTML = mentionFiltered.map((mb, i) =>
    `<button type="button" class="mention-item${i === mentionIdx ? " active" : ""}" data-i="${i}">` +
      `<span class="mention-av" style="background:${avatarColor(mb.id)}">${escapeHtml(avatarInitials(mb.name, false))}</span>` +
      `<span class="mention-name">${escapeHtml(mb.name)}</span>` +
      `<span class="mention-num">${escapeHtml(mb.num)}</span>` +
    `</button>`).join("");
  picker.classList.remove("hidden");
}

// Dipanggil tiap input/gerak kursor: tampilkan/segarkan picker bila ada token "@".
function updateMentionPicker() {
  if (!activeJid || !activeJid.endsWith("@g.us") || !groupMembers.length) { closeMentionPicker(); return; }
  const tok = detectMentionToken();
  if (!tok) { closeMentionPicker(); return; }
  const q = tok.query.toLowerCase();
  // Tampilkan SEMUA anggota yang cocok (picker scrollable, max-height 240px).
  // Tanpa query (baru ketik "@") = seluruh anggota grup, urut nama.
  mentionFiltered = groupMembers
    .filter((mb) => !q || mb.name.toLowerCase().includes(q) || mb.num.includes(q));
  if (!mentionFiltered.length) { closeMentionPicker(); return; }
  mentionState = { node: tok.node, start: tok.start, end: tok.end };
  mentionIdx = 0;
  renderMentionPicker();
}

// Sisipkan chip mention (non-editable, atomik) menggantikan token "@query".
function insertMention(mb) {
  if (!mb) return;
  const st = mentionState;
  const root = $("sendInput");
  root.focus();
  const range = document.createRange();
  try {
    if (st && root.contains(st.node)) {
      range.setStart(st.node, Math.max(0, st.start));
      range.setEnd(st.node, Math.min(st.node.nodeValue.length, st.end));
    } else { range.selectNodeContents(root); range.collapse(false); }
  } catch (e) { range.selectNodeContents(root); range.collapse(false); }
  range.deleteContents();
  const chip = document.createElement("span");
  chip.className = "mention";
  chip.contentEditable = "false";
  chip.dataset.jid = mb.id;
  chip.dataset.num = mb.num;
  chip.textContent = "@" + mb.name;
  range.insertNode(chip);
  const space = document.createTextNode(" ");
  chip.after(space);
  const after = document.createRange();
  after.setStartAfter(space); after.collapse(true);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(after);
  closeMentionPicker();
}

// Navigasi keyboard saat picker terbuka. Return true bila tombol "ditelan".
function handleMentionKeydown(e) {
  if ($("mentionPicker").classList.contains("hidden") || !mentionFiltered.length) return false;
  if (e.key === "ArrowDown") { mentionIdx = (mentionIdx + 1) % mentionFiltered.length; renderMentionPicker(); e.preventDefault(); return true; }
  if (e.key === "ArrowUp") { mentionIdx = (mentionIdx - 1 + mentionFiltered.length) % mentionFiltered.length; renderMentionPicker(); e.preventDefault(); return true; }
  if (e.key === "Enter" || e.key === "Tab") { insertMention(mentionFiltered[mentionIdx]); e.preventDefault(); return true; }
  if (e.key === "Escape") { closeMentionPicker(); e.preventDefault(); return true; }
  return false;
}

$("sendInput").addEventListener("input", updateMentionPicker);
$("sendInput").addEventListener("keyup", (e) => {
  if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) updateMentionPicker();
});
$("sendInput").addEventListener("click", updateMentionPicker);
$("mentionPicker").addEventListener("mousedown", (e) => e.preventDefault()); // jaga fokus editor
$("mentionPicker").addEventListener("click", (e) => {
  const b = e.target.closest(".mention-item");
  if (b) insertMention(mentionFiltered[Number(b.dataset.i)]);
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#mentionPicker") && !e.target.closest("#sendInput")) closeMentionPicker();
});

// ---------- panel info kontak / grup ----------
let infoJid = null;

// Avatar besar (header info) + avatar baris anggota memakai pola yang sama dgn list chat.
function infoAvatarHTML(jid, name, isGroup, cls) {
  return `<span class="avatar ${cls}"><span class="avatar-initials" style="background:${avatarColor(jid)}">${escapeHtml(avatarInitials(name, isGroup))}</span><img class="avatar-img" alt="" src="${avatarUrl(jid)}"></span>`;
}
// "+628…" sederhana (tanpa pemformatan rumit; cukup tambah + di depan digit).
function prettyNum(num) { const n = String(num || "").replace(/\D/g, ""); return n ? "+" + n : ""; }

function memberRowHTML(p) {
  const adminBadge = p.admin === "superadmin"
    ? `<span class="mem-admin">Admin utama</span>`
    : (p.admin ? `<span class="mem-admin">Admin</span>` : "");
  const nm = p.me ? "Kamu" : escapeHtml(p.name);
  return `<div class="mem-row" data-jid="${escapeHtml(p.id)}">
    ${infoAvatarHTML(p.id, p.name, false, "mem-av")}
    <span class="mem-main"><span class="mem-name">${nm}</span><span class="mem-num">${escapeHtml(prettyNum(p.num) || p.num)}</span></span>
    ${adminBadge}
  </div>`;
}

function renderChatInfo(info) {
  const body = $("infoBody");
  if (info.type === "group") {
    const created = info.creation
      ? new Date(info.creation * 1000).toLocaleDateString("id-ID", { day: "numeric", month: "long", year: "numeric" })
      : "";
    const members = info.participants.map(memberRowHTML).join("");
    body.innerHTML = `
      <div class="info-top">
        ${infoAvatarHTML(info.jid, info.subject, true, "info-avatar")}
        <div class="info-name">${escapeHtml(info.subject)}</div>
        <div class="info-sub">Grup · ${info.size} anggota</div>
      </div>
      ${info.desc ? `<div class="info-section"><div class="info-label">Deskripsi</div><div class="info-desc">${bbmify(linkify(escapeHtml(info.desc)))}</div></div>` : ""}
      ${created ? `<div class="info-section"><div class="info-meta-line">Dibuat ${escapeHtml(created)}</div></div>` : ""}
      <div class="info-section">
        <div class="info-label">${info.size} Anggota</div>
        <div class="mem-list">${members}</div>
      </div>`;
  } else {
    body.innerHTML = `
      <div class="info-top">
        ${infoAvatarHTML(info.jid, info.name, false, "info-avatar")}
        <div class="info-name">${escapeHtml(info.name)}</div>
        <div class="info-sub">${escapeHtml(prettyNum(info.num))}</div>
      </div>
      ${info.about ? `<div class="info-section"><div class="info-label">Info</div><div class="info-about">${bbmify(linkify(escapeHtml(info.about)))}</div></div>` : ""}
      <div class="info-section"><div class="info-actions"><button type="button" class="info-act" data-act="message">💬 Kirim pesan</button></div></div>`;
  }
}

async function openChatInfo(jid) {
  if (!jid) return;
  infoJid = jid;
  $("infoPanel").classList.remove("hidden");
  $("infoBody").innerHTML = `<div class="conv-loading"><span class="spinner"></span></div>`;
  try {
    const info = await api(`/api/chat-info?jid=${encodeURIComponent(jid)}`);
    if (infoJid !== jid) return;            // user keburu tutup / pindah
    renderChatInfo(info);
  } catch (e) {
    if (infoJid === jid) $("infoBody").innerHTML = `<div class="list-msg">Gagal memuat info: ${escapeHtml(e.message)}</div>`;
  }
}
function closeChatInfo() { infoJid = null; $("infoPanel").classList.add("hidden"); }

// Klik anggota grup → buka chat pribadinya (resolve @lid → nomor asli bila perlu).
async function openMemberChat(jid, name) {
  if (!jid) return;
  let target = jid;
  if (jid.endsWith("@lid")) {
    try { const r = await api(`/api/resolve-jid?jid=${encodeURIComponent(jid)}`); if (r && r.jid) target = r.jid; } catch (e) {}
  }
  closeChatInfo();
  openChat(target, name || target.split("@")[0]);
}

wireAvatarLoaders($("infoBody"));
$("infoClose").onclick = closeChatInfo;
$("convAvatar").addEventListener("click", () => { if (activeJid) openChatInfo(activeJid); });
$("convTitle").addEventListener("click", () => { if (activeJid) openChatInfo(activeJid); });
$("infoBody").addEventListener("click", (e) => {
  const row = e.target.closest(".mem-row[data-jid]");
  if (row) {
    const nameEl = row.querySelector(".mem-name");
    const nm = nameEl && nameEl.textContent !== "Kamu" ? nameEl.textContent : "";
    if (nameEl && nameEl.textContent === "Kamu") return; // jangan buka chat ke diri sendiri
    openMemberChat(row.dataset.jid, nm);
    return;
  }
  if (e.target.closest(".info-act[data-act='message']")) { closeChatInfo(); if (window.innerWidth > 768) $("sendInput").focus(); }
});

// ---------- boot ----------
function startApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  showChatSkeleton();
  setPill("connecting", "Menghubungkan…");
  checkStatus();
  loadChats();
  loadPendingTasks();
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => { checkStatus(); loadChats(); }, 4000);
}

if (TOKEN) {
  fetch("/api/login?token=" + encodeURIComponent(TOKEN)).then((r) => r.json()).then((res) => {
    if (res.ok) startApp(); else logout();
  }).catch(() => {});
}

// Daftarkan service worker (PWA: installable + launch lebih cepat). Hanya di konteks aman (https/localhost).
if ("serviceWorker" in navigator) {
  // Saat versi SW baru aktif (deploy baru), iOS PWA sering masih menyajikan shell lama.
  // controllerchange = SW baru sudah mengambil alih → reload sekali agar konten versi baru kebaca.
  let _swRefreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (_swRefreshing) return;
    _swRefreshing = true;
    location.reload();
  });
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").then((reg) => reg.update()).catch(() => {});
  });
}

// iOS: 100dvh TIDAK menyusut saat keyboard muncul → .app tetap setinggi layar penuh &
// compose kedorong di belakang keyboard (muncul "space tebal"). Fix: kecilkan tinggi .app
// ke tinggi visualViewport saat keyboard naik → compose nempel pas di atas keyboard.
if (window.visualViewport) {
  const vv = window.visualViewport;
  const app = $("app");
  let maxVH = 0;
  const onVV = () => {
    maxVH = Math.max(maxVH, vv.height);
    // Keyboard terdeteksi via offsetTop melonjak (device ini) ATAU height menyusut (device lain).
    const kbOpen = vv.offsetTop > 50 || (maxVH - vv.height) > 120;
    document.documentElement.classList.toggle("kb-open", kbOpen);
    if (kbOpen) {
      // pin .app tepat ke area terlihat → compose nempel di atas keyboard, tanpa gap
      app.style.position = "fixed";
      app.style.left = vv.offsetLeft + "px";
      app.style.top = vv.offsetTop + "px";
      app.style.width = vv.width + "px";
      app.style.height = (vv.height + 8) + "px";   // dorong compose nempel ke keyboard (pas)
    } else {
      app.style.position = ""; app.style.left = ""; app.style.top = ""; app.style.width = ""; app.style.height = "";
    }
  };
  vv.addEventListener("resize", onVV);
  vv.addEventListener("scroll", onVV);
  onVV();
}
