# Deploy — Plan Q-1 (Render free tier)

Prasyarat CepatCloud tidak terpenuhi (2026-07-18) — jalur yang dipakai adalah
**Plan B: Render free tier** (Docker Web Service, tanpa kartu, deploy dari
GitHub) + pinger `cron-job.org` untuk melawan spin-down 15 menit. Trade-off
yang disadari: cold start 30-50 detik sesekali setelah idle — ini yang mau
diukur lewat gate heartbeat Q-1, bukan diasumsikan aman.

## 1. Deploy service di Render

1. https://dashboard.render.com → **New +** → **Web Service**.
2. Connect repo GitHub `Daun_Merah` (repo yang sama dengan app utama).
3. Isi:
   - **Root Directory**: `vps`
   - **Runtime**: Docker (otomatis terdeteksi dari `vps/Dockerfile`)
   - **Instance Type**: Free
4. **Environment Variables** (tab Environment) — HANYA dua ini, TANPA token AI/Deriv/Telegram apa pun:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   (nilai sama dengan yang di Vercel env — lihat `.env.local` lokal atau Vercel dashboard)
5. Deploy. Catat URL publik yang diberikan Render, contoh: `https://daun-merah-vps.onrender.com`.
6. Verifikasi manual: buka URL tsb di browser — harus balas JSON `{"status":"up","last_beat_epoch":...}`.

## 2. Pasang pinger cron-job.org (wajib — melawan spin-down 15 menit)

1. https://cron-job.org → daftar/login → **Create cronjob**.
2. URL: URL Render dari langkah 1 (root path, method GET).
3. Interval: tiap **10 menit** (di bawah ambang spin-down 15 menit Render free tier).
4. Simpan, biarkan jalan terus selama masa uji Q-1.

## 3. Verifikasi gap via app utama

`GET /api/admin?action=health` (header `x-admin-secret: <CRON_SECRET>`) sekarang
melaporkan source `vps_heartbeat` — status `OK`/`DOWN` + `down_since_mins` kalau
gap terdeteksi. Source ini otomatis DOWN kalau key `vps:heartbeat` di Redis
belum ada atau lebih tua dari 5 menit (TTL `EX 300` di `heartbeat.js` sudah
menjamin key hilang sendiri kalau proses berhenti kirim beat).

## 4. Gate Q-1

**Lolos kalau**: tidak ada gap `vps_heartbeat` >5 menit selama minimal 7 hari
berturut-turut (pantau `down_since_mins` di `admin?action=health`, atau alert
Telegram otomatis yang terkirim kalau source DOWN >2 jam).

**Gagal** → coba Oracle Always Free / VPS murah berikutnya di urutan kandidat
(`daun_merah_plan.md` §Plan Q), atau tunda Fase B sepenuhnya (Plan P on-demand
tetap jadi jalur utama, aplikasi tidak terganggu).

## Catatan

- Redeploy: push ke `main` yang menyentuh folder `vps/` akan auto-redeploy
  service ini di Render (auto-deploy dari GitHub aktif secara default).
- Tidak ada langkah SSH manual — beda dari asumsi awal (VPS tradisional),
  Render deploy sepenuhnya lewat Git + dashboard.
