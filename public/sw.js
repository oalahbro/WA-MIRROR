/* Service worker WA Mirror.
   - app shell (html/css/js/manifest) → network-first (update langsung kebaca, fallback cache saat offline)
   - aset statis (ikon, gambar BBM) → cache-first
   - /api/* → TIDAK PERNAH di-cache (data pribadi)
   Naikkan versi CACHE saat mau paksa bersih-bersih cache lama. */
const CACHE = "wa-mirror-v18";
const SHELL = ["/", "/index.html", "/style.css", "/app.js", "/favicon.svg", "/manifest.json", "/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function putCache(req, res) {
  if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;                        // non-GET → biarkan jaringan
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;              // pihak ketiga → biarkan
  if (url.pathname.startsWith("/api/")) return;            // data privat → JANGAN cache

  const isStatic = url.pathname.startsWith("/bbm/") || url.pathname.startsWith("/icon-") ||
    url.pathname === "/apple-touch-icon.png" || url.pathname === "/favicon.svg";

  if (isStatic) {
    // cache-first
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => putCache(req, res)).catch(() => hit))
    );
    return;
  }

  // app shell → network-first, fallback cache (lalu fallback ke "/")
  e.respondWith(
    fetch(req).then((res) => putCache(req, res))
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/")))
  );
});
