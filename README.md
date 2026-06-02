# WA Mirror

WhatsApp **always-on** di VPS pakai [Baileys](https://github.com/WhiskeySockets/Baileys), dengan UI sederhana mirip WhatsApp Web untuk akses cepat dari PC lokal.

## Konsep

```
VPS (24/7)  →  Baileys connect terus  →  simpan tiap pesan ke SQLite  →  Express API
PC lokal    →  buka browser ke VPS    →  data sudah ada, TANPA loading sync dari nol
```

Karena VPS tidak pernah disconnect, pesan tersimpan real-time. Saat kamu buka UI,
yang terjadi cuma **query database** — bukan sync ke WhatsApp. Jadi langsung muncul,
chat terbaru dulu, scroll ke atas untuk memuat yang lebih lama.

## Setup

```bash
npm install
cp .env.example .env
# edit .env -> ganti AUTH_TOKEN dengan token acak:
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npm start
```

Buka `http://IP-VPS:PORT`, login pakai `AUTH_TOKEN`, lalu **scan QR** yang muncul
(WhatsApp HP → Perangkat tertaut → Tautkan perangkat).

## Jalan permanen di VPS (pm2)

```bash
npm install -g pm2
pm2 start src/server.js --name wa-mirror
pm2 save && pm2 startup
```

## ⚠️ Keamanan (PENTING)

Ini meng-expose isi WhatsApp kamu lewat HTTP. Wajib:

1. **Ganti `AUTH_TOKEN`** dengan string panjang & acak (server menolak start kalau masih default).
2. **Jangan buka port mentah ke internet.** Pilih salah satu:
   - Akses via **SSH tunnel**: `ssh -L 8088:localhost:8088 user@vps` lalu buka `localhost:8088`
   - Atau pasang **reverse proxy (Nginx/Caddy) + HTTPS** di depannya.
3. Folder `auth/` = kredensial sesi WhatsApp. **Jangan dibagikan / commit.**

## Catatan penting

- **Baileys unofficial** → ada risiko nomor di-ban. Pakai nomor sekunder.
- **History awal terbatas**: WhatsApp hanya mengirim sebagian riwayat saat device baru
  ditautkan. Pesan **sejak VPS connect** tersimpan lengkap; makin lama jalan makin kaya.
- **HP harus online sesekali**: kalau HP offline >14 hari, semua device tertaut logout.
- `markOnlineOnConnect=false` → notifikasi tetap masuk ke HP.

## Struktur

```
src/db.js        skema + query SQLite (better-sqlite3)
src/wa.js        koneksi Baileys + simpan pesan ke DB
src/server.js    Express API + serve UI + auth token
src/loadenv.js   loader .env minimalis
public/          UI (index.html, style.css, app.js)
```

## API

| Endpoint | Keterangan |
|---|---|
| `GET /api/login?token=` | cek token |
| `GET /api/status` | status koneksi + QR (data URL) |
| `GET /api/chats` | daftar chat, urut terbaru |
| `GET /api/messages?jid=&before=&limit=` | pesan, terbaru→lama (cursor `before`) |
| `POST /api/send` `{jid,text}` | kirim pesan |
