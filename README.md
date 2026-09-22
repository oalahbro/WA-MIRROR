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

Semua endpoint **kecuali** `GET /api/login` butuh token, kirim lewat salah satu cara:

- header `x-auth-token: <AUTH_TOKEN>`
- header `Authorization: Bearer <AUTH_TOKEN>`
- query `?token=<AUTH_TOKEN>`

| Endpoint | Keterangan |
|---|---|
| `GET /api/login?token=` | cek token |
| `GET /api/status` | status koneksi + QR (data URL) |
| `GET /api/chats` | daftar chat, urut terbaru |
| `GET /api/messages?jid=&before=&limit=` | pesan, terbaru→lama (cursor `before`) |
| `GET /api/check-number?num=` | cek nomor terdaftar di WhatsApp |
| `POST /api/send` `{jid,text}` | kirim pesan — lihat di bawah |

### `POST /api/send` — kirim pesan dari app lain

Body (JSON):

| Field | Wajib | Keterangan |
|---|---|---|
| `jid` | ya | tujuan — JID lengkap **atau** nomor polos |
| `text` | ya | isi pesan |
| `quotedId` | tidak | id pesan yang dikutip |
| `quotedJid` | tidak | jid chat asal pesan yang dikutip |
| `mentions` | tidak | array jid yang di-tag |

Kolom `jid` menerima beberapa format — server menormalkan sendiri, jadi app lain tidak
perlu menyusun JID:

| Yang dikirim | Hasil |
|---|---|
| `08123456789` | `628123456789@s.whatsapp.net` |
| `6281234567890` | `6281234567890@s.whatsapp.net` |
| `+62 812-3456-7890` | `6281234567890@s.whatsapp.net` |
| `6281234567890@s.whatsapp.net` | dipakai apa adanya |
| `1234567890-1234567890@g.us` | dipakai apa adanya (grup) |

Response sukses:

```json
{ "ok": true, "id": "3EB0A1B2C3D4E5F6" }
```

Gagal → `{ "error": "..." }` dengan HTTP `400` (`jid`/`text` kosong), `401` (token salah),
atau `500` (WhatsApp belum terhubung).

Contoh:

```bash
curl -X POST http://IP-VPS:8088/api/send \
  -H "x-auth-token: $AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jid":"08123456789","text":"Halo dari app lain"}'
```

```js
await fetch("http://IP-VPS:8088/api/send", {
  method: "POST",
  headers: {
    "x-auth-token": process.env.AUTH_TOKEN,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ jid: "08123456789", text: "Halo" }),
});
```

> Kirim ke GRUP juga bisa — pakai JID grup (`...@g.us`) dari `GET /api/chats`.
> `id` bisa tetap terisi walau nomor tujuan tidak terdaftar di WhatsApp; pakai
> `GET /api/check-number?num=08xxx` lebih dulu bila perlu memastikan.
