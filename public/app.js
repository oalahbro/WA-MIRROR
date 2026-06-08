"use strict";

const $ = (id) => document.getElementById(id);
let TOKEN = localStorage.getItem("wa_token") || "";
let activeJid = null;
let oldestLoaded = 0;     // timestamp pesan tertua yang sudah dimuat (cursor)
let allChats = [];
let chatPollTimer = null;
let msgPollTimer = null;
let chatsLoadedOnce = false;
let lastStats = { chats: -1, messages: -1 };
let lastConnState = "";   // untuk toast transisi koneksi
let loadingOlder = false;
let myJid = "";           // jid akun sendiri (untuk label "Kamu" pada kutipan)
let replyTo = null;       // { id, sender, text } pesan yang sedang dibalas
let chatFilter = localStorage.getItem("wa_filter") || "all"; // all | private | group
let msgSearchMode = false;   // true saat menampilkan hasil cari ISI pesan
let msgSearchQuery = "";

// ---------- helpers ----------
async function api(pathname, opts = {}) {
  const res = await fetch(pathname, {
    ...opts,
    headers: { "x-auth-token": TOKEN, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (res.status === 401) { logout(); throw new Error("unauthorized"); }
  return res.json();
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
    if (s.me) { myJid = s.me; $("meLabel").textContent = "📱 " + s.me.split("@")[0]; }
  } else {
    $("qrOverlay").classList.remove("hidden");
    if (s.qr) { $("qrImg").src = s.qr; $("qrImg").classList.remove("hidden"); $("qrWait").classList.add("hidden"); }
    else { $("qrImg").classList.add("hidden"); $("qrWait").classList.remove("hidden"); }
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
    allChats = await api("/api/chats");
    chatsLoadedOnce = true;
    renderChats();
  } catch (e) {}
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

  // buang node non-chat-item (skeleton / pesan kosong) bila ada
  [...list.children].forEach((n) => { if (!n.classList.contains("chat-item")) n.remove(); });
  reconcileChats(list, filtered);
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
  const preview = c.last_text || "";
  if (prevEl.textContent !== preview) prevEl.textContent = preview;
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
$("search").addEventListener("input", () => {
  if (msgSearchMode) msgSearchMode = false;   // mulai mengetik → kembali ke filter chat biasa
  renderChats();
});
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
    return `<div class="search-result" data-jid="${escapeHtml(r.jid)}" data-id="${escapeHtml(r.id)}" data-name="${escapeHtml(r.chat_name)}">
      <div class="sr-row"><span class="sr-name">${escapeHtml(r.chat_name)}${r.is_group ? " 👥" : ""}</span><span class="sr-time">${fmtTime(r.timestamp)}</span></div>
      <div class="sr-snippet">${who}${highlightSnippet(r.text, q)}</div></div>`;
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
  if (r) openChatToMessage(r.dataset.jid, r.dataset.name, r.dataset.id);
});
// Buka chat lalu loncat ke pesan hasil pencarian (muat lebih lama bila perlu).
async function openChatToMessage(jid, name, id) {
  msgSearchMode = false; msgSearchQuery = ""; $("search").value = "";
  await openChat(jid, name);
  for (let i = 0; i < 8; i++) {
    if (locateBubble(id)) return;
    const lo = $("messages").querySelector(".load-older");
    if (!lo || lo.classList.contains("done")) break;
    await loadOlder();
  }
  if (!locateBubble(id)) toast("Pesan cukup lama — gulir ke atas untuk memuat lagi");
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
}
function setFilterCount(filter, n) {
  const el = document.querySelector(`.filter-tab[data-filter="${filter}"] .filter-count`);
  if (!el) return;
  if (n > 0) { el.textContent = n > 99 ? "99+" : String(n); el.classList.remove("hidden"); }
  else el.classList.add("hidden");
}

// Avatar: img sukses → tampilkan (.ok); gagal/404 → sembunyikan, inisial tetap terlihat.
// Pakai fase CAPTURE (event load/error tak bubble). Inline handler dihindari (CSP).
function wireAvatarLoaders(container) {
  container.addEventListener("load", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("avatar-img")) t.classList.add("ok");
  }, true);
  container.addEventListener("error", (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains("avatar-img")) { t.classList.remove("ok"); t.style.display = "none"; }
  }, true);
}
wireAvatarLoaders($("chatList"));
wireAvatarLoaders($("convAvatar"));

// ---------- conversation ----------
async function openChat(jid, title) {
  activeJid = jid;
  oldestLoaded = 0;
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
  clearInterval(msgPollTimer);
  activeJid = null;          // lepas active → badge unread jalan normal lagi
  renderChats();
}
$("backBtn").onclick = backToList;

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
const PLACEHOLDER_TEXT = { image: "📷 Foto", video: "🎥 Video", document: "📄 Dokumen" };

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

// Nama pengirim untuk label kutipan: "Kamu" bila itu akun sendiri.
function quotedLabel(senderJid) {
  if (!senderJid) return "";
  if (myJid && senderJid.split("@")[0] === myJid.split("@")[0]) return "Kamu";
  return senderJid.split("@")[0];
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
  }
  const bodyHTML = bodyText ? `<div class="body">${linkify(escapeHtml(bodyText))}</div>` : "";
  // pesan yang isinya hanya emoji → tampil besar tanpa bubble (ala WA)
  const emojiOnly = bodyText && !mediaHTML && !m.quoted_id && isEmojiOnly(bodyText);

  // blok kutipan bila pesan ini membalas pesan lain
  let quotedHTML = "";
  if (m.quoted_id) {
    const qs = quotedLabel(m.quoted_sender);
    quotedHTML = `<div class="quoted" data-qid="${escapeHtml(m.quoted_id)}">${qs ? `<div class="q-sender">${escapeHtml(qs)}</div>` : ""}<div class="q-text">${escapeHtml(m.quoted_text || "(media)")}</div></div>`;
  }

  // preview untuk dipakai saat pesan ini DIBALAS
  const replyPreview = bodyText || PLACEHOLDER_TEXT[m.type] || m.text || "";
  const replySender = m.from_me ? "Kamu" : (m.sender_name || "").split("@")[0];

  return `<div class="bubble ${side}${emojiOnly ? " emoji-only" : ""}" data-ts="${m.timestamp}" data-id="${escapeHtml(m.id)}" data-sender="${escapeHtml(m.sender || "")}" data-rtext="${escapeHtml(replyPreview)}" data-rsender="${escapeHtml(replySender)}">
    <button class="reply-btn" title="Balas">↩</button>
    ${senderLabel}${quotedHTML}${mediaHTML}${bodyHTML}
    <div class="meta">${fmtTime(m.timestamp)}</div>
  </div>`;
}

// Event delegation untuk pesan: tombol balas, klik kutipan, klik media.
$("messages").addEventListener("click", (e) => {
  const rbtn = e.target.closest(".reply-btn");
  if (rbtn) {
    const b = rbtn.closest(".bubble");
    if (b) startReply(b.dataset.id, b.dataset.rsender, b.dataset.rtext);
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
  if (e.target.classList && e.target.classList.contains("media-loader")) imgFailed(e.target);
}, true);

// ---------- menu konteks pesan (klik-kanan / long-press) ----------
function openMsgMenu(b, x, y) {
  const id = b.dataset.id, name = b.dataset.rsender || "", text = b.dataset.rtext || "", sender = b.dataset.sender || "";
  const fromMe = b.classList.contains("me");
  const inGroup = activeJid && activeJid.endsWith("@g.us");
  const items = [];
  if (text) items.push({ label: "📋 Salin teks", act: () => copyText(text) });
  items.push({ label: "↩️ Balas", act: () => startReply(id, name, text) });
  // Balas pribadi: di GRUP, pada pesan orang lain dengan pengirim ber-jid
  // (@s.whatsapp.net atau @lid — yang @lid di-resolve ke nomor asli saat diklik).
  if (inGroup && !fromMe && (sender.endsWith("@s.whatsapp.net") || sender.endsWith("@lid"))) {
    items.push({ label: "👤 Balas pribadi", act: () => replyPrivately(sender, name, id, text) });
  }
  const menu = $("msgMenu");
  menu.innerHTML = "";
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
  startReply(msgId, name || title, text);
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

// ---------- reply (balas/kutip) ----------
function startReply(id, sender, text) {
  replyTo = { id, sender: sender || "", text: text || "" };
  $("replySender").textContent = sender || "Pesan";
  $("replyText").textContent = text || "";
  $("replyBar").classList.remove("hidden");
  $("sendInput").focus();
}
function clearReply() {
  replyTo = null;
  $("replyBar").classList.add("hidden");
}
$("replyCancel").onclick = clearReply;

function scrollToMessage(id) {
  let el = null;
  try { el = $("messages").querySelector(`.bubble[data-id="${CSS.escape(id)}"]`); } catch (e) {}
  if (!el) { toast("Pesan asli belum dimuat di layar"); return; }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}
function quoteBlockHTML(quote) {
  if (!quote) return "";
  return `<div class="quoted" data-qid="${escapeHtml(quote.id || "")}"><div class="q-sender">${escapeHtml(quote.sender || "")}</div><div class="q-text">${escapeHtml(quote.text || "")}</div></div>`;
}

function openLightbox(url, kind) {
  const lb = $("lightbox");
  const content = $("lightboxContent");
  content.innerHTML = `<div class="lb-loading"><span class="spinner"></span></div>`;
  lb.classList.remove("hidden");
  if (kind === "image") {
    const img = new Image();
    img.className = "lb-media";
    img.onload = () => { content.innerHTML = ""; content.appendChild(img); };
    img.onerror = lightboxError;
    img.src = url;
  } else {
    const v = document.createElement("video");
    v.className = "lb-media";
    v.controls = true; v.autoplay = true;
    v.onloadeddata = () => { content.innerHTML = ""; content.appendChild(v); };
    v.onerror = lightboxError;
    v.src = url;
  }
}
function closeLightbox() { $("lightbox").classList.add("hidden"); $("lightboxContent").innerHTML = ""; }
function lightboxError() { closeLightbox(); toast("Media tidak tersedia (mungkin sudah kedaluwarsa)", "err"); }
$("lightboxClose").onclick = closeLightbox;
$("lightbox").addEventListener("click", (e) => { if (e.target.id === "lightbox") closeLightbox(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("lightbox").classList.contains("hidden")) closeLightbox(); });
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
  const box = $("messages");
  if (box.scrollHeight - box.scrollTop - box.clientHeight > 200) $("jumpBtn").classList.remove("hidden");
  else hideJump();
}
$("jumpBtn").onclick = scrollToBottom;

// load lebih lama saat scroll ke paling atas + atur tampil/sembunyi tombol gulir
$("messages").addEventListener("scroll", () => {
  const box = $("messages");
  if (box.scrollTop < 40) {
    const lo = box.querySelector(".load-older");
    if (lo && lo.textContent.startsWith("↑")) loadOlder();
  }
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
  return (b / 1024 / 1024).toFixed(1) + " MB";
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
  $("sendInput").placeholder = "Tambah keterangan…";
  $("sendInput").focus();
}
function clearAttach() {
  if (pendingFile?.url) URL.revokeObjectURL(pendingFile.url);
  pendingFile = null;
  $("attachThumb").innerHTML = "";
  $("attachPreview").classList.add("hidden");
  $("sendInput").placeholder = "Ketik pesan…";
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

$("sendForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!activeJid) return;
  const text = $("sendInput").value.trim();
  if (pendingFile) { sendMediaMsg(text); return; }
  if (text) sendTextMsg(text);
});

// Enter = kirim, Shift+Enter = baris baru (seperti WA Web).
$("sendInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("sendForm").requestSubmit();
  }
});
// Auto-tinggi textarea mengikuti isi (sampai max-height di CSS).
function autoGrowInput() {
  const t = $("sendInput");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 120) + "px";
}
$("sendInput").addEventListener("input", autoGrowInput);

async function sendTextMsg(text) {
  const quote = replyTo;          // snapshot lalu bersihkan bar reply
  clearReply();
  $("sendInput").value = "";
  autoGrowInput();
  setBtnLoading($("sendBtn"), true);
  const box = $("messages");
  const tmpId = "tmp-" + Date.now();
  box.insertAdjacentHTML("beforeend",
    `<div class="bubble me pending" data-ts="${Math.floor(Date.now()/1000)}" data-id="${tmpId}" data-rtext="${escapeHtml(text)}" data-rsender="Kamu"><button class="reply-btn" title="Balas">↩</button>${quoteBlockHTML(quote)}<div class="body">${escapeHtml(text)}</div><div class="meta">mengirim…</div></div>`);
  rebuildDaySeparators();
  scrollToBottom();
  try {
    const res = await api("/api/send", { method: "POST", body: JSON.stringify({ jid: activeJid, text, quotedId: quote?.id || "" }) });
    finalizeBubble(tmpId, res.id);
    setTimeout(refreshNewest, 600);
  } catch (err) {
    removeBubble(tmpId);
    $("sendInput").value = text; // kembalikan teks supaya tidak hilang
    autoGrowInput();
    if (quote) startReply(quote.id, quote.sender, quote.text); // kembalikan bar reply
    toast("Gagal kirim: " + err.message, "err");
  } finally {
    setBtnLoading($("sendBtn"), false);
    $("sendInput").focus();
  }
}

async function sendMediaMsg(caption) {
  const { file, kind, url } = pendingFile;
  const jid = activeJid;
  const quote = replyTo;          // snapshot lalu bersihkan bar reply
  clearReply();
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
  const capHTML = caption ? `<div class="body">${escapeHtml(caption)}</div>` : "";
  const rtext = caption || (kind === "image" ? "📷 Foto" : kind === "video" ? "🎥 Video" : "📄 " + file.name);
  box.insertAdjacentHTML("beforeend",
    `<div class="bubble me pending" data-ts="${Math.floor(Date.now()/1000)}" data-id="${tmpId}" data-rtext="${escapeHtml(rtext)}" data-rsender="Kamu"><button class="reply-btn" title="Balas">↩</button>${quoteBlockHTML(quote)}${mediaHTML}${capHTML}<div class="meta">mengirim…</div></div>`);
  rebuildDaySeparators();
  scrollToBottom();

  // lepas preview (object URL masih dipakai bubble optimistik, jangan di-revoke)
  pendingFile = null;
  $("attachThumb").innerHTML = "";
  $("attachPreview").classList.add("hidden");
  $("sendInput").value = "";
  $("sendInput").placeholder = "Ketik pesan…";
  autoGrowInput();

  try {
    const qs = new URLSearchParams({ jid, kind, caption, quotedId: quote?.id || "", fileName: kind === "document" ? file.name : "" });
    const fallbackType = kind === "image" ? "image/jpeg" : kind === "video" ? "video/mp4" : "application/octet-stream";
    const res = await fetch("/api/send-media?" + qs.toString(), {
      method: "POST",
      headers: { "x-auth-token": TOKEN, "Content-Type": file.type || fallbackType },
      body: file,
    });
    if (res.status === 401) { logout(); throw new Error("unauthorized"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error(data.error || ("HTTP " + res.status));
    finalizeBubble(tmpId, data.id);
    toast(kind === "image" ? "Foto terkirim" : kind === "video" ? "Video terkirim" : "Dokumen terkirim", "ok", 1800);
  } catch (err) {
    removeBubble(tmpId);
    URL.revokeObjectURL(url);
    if (quote) startReply(quote.id, quote.sender, quote.text);
    toast("Gagal kirim media: " + err.message, "err");
  } finally {
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
  rose:   { base: "#e0526a", light: "#c23a55", dark: "#ff8fa0", bubble: "#ffe1e7" },
  teal:   { base: "#0d9488", light: "#0b7268", dark: "#2dd4bf", bubble: "#cdeee9" },
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

$("themeBtn").onclick = (e) => { e.stopPropagation(); $("themePopover").classList.toggle("hidden"); };
document.querySelectorAll(".theme-opt").forEach((o) => {
  o.onclick = () => { applyTheme(o.dataset.theme); }; // popover tetap terbuka biar bisa atur aksen
});
document.querySelectorAll(".accent-swatches .swatch").forEach((s) => {
  s.onclick = () => { curAccent = s.dataset.accent || ""; localStorage.setItem("wa_accent", curAccent); applyAccent(); };
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#themePopover") && !e.target.closest("#themeBtn")) $("themePopover").classList.add("hidden");
});
applyTheme(localStorage.getItem("wa_theme") || "light");
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
];
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
function renderEmojiGrid() {
  const grid = $("emojiGrid");
  let list = emojiCat === "recent" ? recentEmojis() : (EMOJI[emojiCat] || []);
  if (emojiCat === "recent" && !list.length) {
    grid.innerHTML = `<div class="egroup-label">Belum ada emoji yang sering dipakai</div>`;
  } else {
    grid.innerHTML = list.map((e) => `<button type="button" data-emo="${e}">${e}</button>`).join("");
  }
  document.querySelectorAll("#emojiTabs .etab").forEach((t) => t.classList.toggle("active", t.dataset.cat === emojiCat));
}

// Sisipkan emoji pada posisi kursor di textarea (atau di akhir bila tak fokus).
function insertEmoji(emo) {
  const t = $("sendInput");
  const s = typeof t.selectionStart === "number" ? t.selectionStart : t.value.length;
  const e = typeof t.selectionEnd === "number" ? t.selectionEnd : t.value.length;
  t.value = t.value.slice(0, s) + emo + t.value.slice(e);
  const pos = s + emo.length;
  t.focus();
  t.setSelectionRange(pos, pos);
  autoGrowInput();
  pushRecentEmoji(emo);
}

function toggleEmojiPanel() {
  const panel = $("emojiPanel");
  const willOpen = panel.classList.contains("hidden");
  if (willOpen) {
    if (!emojiBuilt) { buildEmojiTabs(); emojiBuilt = true; }
    if (recentEmojis().length) emojiCat = "recent";
    else if (emojiCat === "recent") emojiCat = "smileys";
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
  const b = e.target.closest("button[data-emo]");
  if (b) insertEmoji(b.dataset.emo);   // panel tetap terbuka → bisa pilih beberapa
});
document.addEventListener("click", (e) => {
  if (!e.target.closest("#emojiPanel") && !e.target.closest("#emojiBtn")) $("emojiPanel").classList.add("hidden");
});

// ---------- boot ----------
function startApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  showChatSkeleton();
  setPill("connecting", "Menghubungkan…");
  checkStatus();
  loadChats();
  clearInterval(chatPollTimer);
  chatPollTimer = setInterval(() => { checkStatus(); loadChats(); }, 4000);
}

if (TOKEN) {
  fetch("/api/login?token=" + encodeURIComponent(TOKEN)).then((r) => r.json()).then((res) => {
    if (res.ok) startApp(); else logout();
  }).catch(() => {});
}
