# Deploy WA Mirror ke VPS (Ubuntu/Debian)

Skenario: akses lewat **SSH tunnel** (port tidak dibuka ke internet), **pindah `auth/` + `data/wa.db`** dari PC ini, proses **always-on pakai systemd**.

> ⚠️ **PENTING soal sesi WhatsApp:** satu nomor = satu set kredензial. Menjalankan
> dua instance Baileys dengan `auth/` yang sama **secara bersamaan akan bentrok**
> (salah satu di-logout). Jadi setelah pindah ke VPS, **matikan permanen** instance
> di PC lokal. Pilih satu yang aktif.

Ganti `USER`, `IP_VPS`, dan path sesuai punyamu.

---

## 0. Di PC lokal: matikan server & rapikan DB

Hentikan server lokal lebih dulu (biar tidak bentrok sesi & file DB konsisten).

```powershell
# PowerShell di PC: cari PID yang listen 8088 lalu matikan
# (jangan pakai $pid — itu variabel bawaan PowerShell yang read-only)
$listenPid = (Get-NetTCPConnection -LocalPort 8088 -State Listen).OwningProcess
if ($listenPid) { Stop-Process -Id $listenPid -Force }
```

Setelah server mati, gabungkan WAL ke `wa.db` supaya cukup pindah 1 file DB:

```powershell
cd $HOME\Documents\EKADATA\PROJ\wa-mirror
node -e "const d=require('better-sqlite3')('./data/wa.db'); d.pragma('wal_checkpoint(TRUNCATE)'); d.close(); console.log('checkpoint OK')"
```

---

## 1. Di VPS: pasang Node.js + tools

```bash
# Node.js 20 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Tools untuk kompilasi better-sqlite3 (native module) bila tak ada prebuilt
sudo apt-get install -y build-essential python3

node -v   # pastikan v20.x
which node # catat path-nya (untuk file service), biasanya /usr/bin/node
```

---

## 2. Dari PC lokal: kirim project ke VPS

`node_modules` **JANGAN** dikirim (berisi binary Windows; `better-sqlite3` harus
dikompilasi ulang di Linux). Auth & DB **harus** ikut.

Cara paling rapi pakai `scp` dari PowerShell (OpenSSH bawaan Windows):

```powershell
cd $HOME\Documents\EKADATA\PROJ\wa-mirror

# 2a. Kode sumber + konfigurasi (TANPA node_modules)
scp -r src public package.json package-lock.json .env README.md DEPLOY.md deploy USER@IP_VPS:~/wa-mirror/

# 2b. Sesi login WhatsApp (WAJIB, biar tidak perlu scan QR ulang)
scp -r auth USER@IP_VPS:~/wa-mirror/

# 2c. Database history (~71 MB)
ssh USER@IP_VPS "mkdir -p ~/wa-mirror/data"
scp data/wa.db USER@IP_VPS:~/wa-mirror/data/
```

> Folder `auth/` itu rahasia (kunci akun WhatsApp). Kirim hanya lewat SSH seperti
> di atas; jangan taruh di tempat publik.

---

## 3. Di VPS: install dependency & sesuaikan .env

```bash
cd ~/wa-mirror
npm install --omit=dev      # kompilasi better-sqlite3 untuk Linux

# Edit .env: tambahkan HOST loopback (port hanya bisa diakses via SSH tunnel)
echo "HOST=127.0.0.1" >> .env
# Pastikan baris lain tetap ada: PORT, AUTH_TOKEN, DB_PATH, AUTH_DIR, OWNER_JID, dst.
nano .env
```

Uji manual dulu (Ctrl+C untuk stop setelah lihat "Terhubung"):

```bash
node src/server.js
# Harusnya:
#   [server] UI + API jalan di http://127.0.0.1:8088
#   [wa] Terhubung sebagai 62878...@s.whatsapp.net (lid ...)
# Kalau muncul QR / minta scan = auth tidak terbawa. Cek folder auth/.
```

---

## 4. Always-on dengan systemd

```bash
# Sesuaikan User, WorkingDirectory, dan path node di file ini lebih dulu:
nano ~/wa-mirror/deploy/wa-mirror.service

sudo cp ~/wa-mirror/deploy/wa-mirror.service /etc/systemd/system/wa-mirror.service
sudo systemctl daemon-reload
sudo systemctl enable --now wa-mirror

# Cek status & log
systemctl status wa-mirror
journalctl -u wa-mirror -f      # log live (Ctrl+C keluar)
```

Perintah harian:

```bash
sudo systemctl restart wa-mirror   # restart (mis. setelah ubah .env)
sudo systemctl stop wa-mirror      # stop
journalctl -u wa-mirror --since "10 min ago"
```

---

## 5. Firewall: jangan buka 8088

Karena akses via SSH tunnel, cukup izinkan SSH saja.

```bash
sudo ufw allow OpenSSH
sudo ufw enable
sudo ufw status        # 8088 TIDAK ada di daftar allow = benar
```

Server sudah bind ke `127.0.0.1` (langkah 3), jadi 8088 memang tak terjangkau dari luar.

---

## 6. Akses UI dari PC via SSH tunnel

Di PC (PowerShell), buka tunnel: port lokal 8088 → 127.0.0.1:8088 di VPS.

```powershell
ssh -N -L 8088:127.0.0.1:8088 USER@IP_VPS
```

Biarkan jendela itu terbuka, lalu di browser buka:

```
http://localhost:8088
```

Login pakai `AUTH_TOKEN` yang ada di `.env`. Selesai — UI jalan, data dari VPS.

> Tutup tunnel = tutup jendela `ssh`. Mau lebih praktis nanti bisa dibuat shortcut
> / config `~/.ssh/config`.

---

## Checklist aman

- [ ] Server lokal sudah dimatikan permanen (anti-bentrok sesi).
- [ ] `auth/` terkirim & "Terhubung" tanpa QR di VPS.
- [ ] `.env` punya `HOST=127.0.0.1` dan `AUTH_TOKEN` kuat.
- [ ] `ufw` aktif, hanya SSH yang diizinkan.
- [ ] `systemctl enable` aktif (auto-start saat VPS reboot).
- [ ] HP utama tetap online minimal sekali tiap < 14 hari (syarat WhatsApp linked device).

## Troubleshooting

- **Minta scan QR di VPS** → `auth/` tak terbawa / korup. Ulangi `scp -r auth`.
- **`better-sqlite3` error saat `npm install`** → pasang `build-essential python3`, lalu
  `npm rebuild better-sqlite3`.
- **"stream errored / conflict" lalu logout** → ada instance lain (PC lokal?) pakai
  sesi sama. Matikan yang satunya.
- **Service mati terus** → `journalctl -u wa-mirror -n 50` untuk lihat error; cek path
  node di `ExecStart`.
