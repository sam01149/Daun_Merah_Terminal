# Deploy — Plan Q-1 (Railway free trial + pinger)

## Riwayat percobaan (2026-07-18, Session 187 lanjutan)

Urutan kandidat semula di `daun_merah_plan.md` (CepatCloud → Render → Oracle
Always Free) **semuanya kena blocker kartu**:
- **CepatCloud**: belum aktif (menunggu approval, di luar kendali kita).
- **Render**: free Web Service TETAP minta verifikasi kartu (hold $1 USD)
  sebelum deploy — beda dari klaim dokumentasi resminya "tanpa kartu". Kartu
  debit BNI user ditolak di titik ini.
- **Oracle Always Free**: kartu yang sama juga ditolak di verifikasi Oracle.

Karena kartu yang sama gagal di 2 platform berbeda, kemungkinan besar
akar masalah ada di kartu/bank (transaksi luar negeri belum aktif di BNI,
atau kartu GPN-only tanpa jaringan Visa/Mastercard) — bukan bug platform.
Menelusuri itu butuh waktu terpisah dan TIDAK boleh memblokir Plan Q lebih
lama, jadi dipilih **Railway** — satu-satunya kandidat yang tidak minta
kartu sama sekali di signup (dikonfirmasi live docs.railway.com per hari
ini, bukan asumsi).

**Trade-off Railway yang disadari (beda dari Render):** bukan "jam gratis"
melainkan **kredit terpakai**: trial $5 sekali habis dalam 30 hari, setelah
itu Free plan cuma dapat $1 kredit/bulan (tidak akumulasi). Kalau kredit
habis, service **langsung berhenti** — ini WAJIB dibedakan dari gap infra
asli saat membaca hasil gate Q-1 (cek dashboard Usage Railway kalau ada gap
mencurigakan, jangan langsung simpulkan daemon/koneksi yang salah).

## 1. Deploy service di Railway

1. https://railway.com → daftar/login (TANPA kartu — kalau di suatu titik
   diminta kartu, itu tanda kita salah alur, berhenti dan laporkan).
2. **New Project** → **Deploy from GitHub repo** → pilih `sam01149/Daun_Merah_Terminal`.
   - Kalau ini pertama kali connect GitHub: authorize **Railway GitHub App**,
     pilih akses ke repo ini (repo PRIVATE, sama seperti Render — App-based
     OAuth, bukan clone URL publik, jadi tidak perlu diubah jadi public).
3. Di service yang baru dibuat → tab **Settings**:
   - **Root Directory**: `vps` (Railway otomatis pakai `vps/Dockerfile`).
   - **Branch**: `main`.
4. Tab **Variables** — HANYA dua ini, TANPA token AI/Deriv/Telegram apa pun:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`
   (nilai sama dengan yang di Vercel env / `.env.local` lokal)
5. Tab **Settings → Networking** → klik **Generate Domain** (Railway TIDAK
   otomatis expose service ke publik, beda dari Render — wajib langkah ini
   supaya pinger cron-job.org bisa menembak URL-nya).
6. Deploy otomatis jalan. Catat domain publik, contoh:
   `https://daun-merah-terminal-production.up.railway.app`.
7. Verifikasi manual: buka domain tsb di browser — harus balas JSON
   `{"status":"up","last_beat_epoch":...}`.

## 2. Pasang pinger cron-job.org (wajib — melawan idle/sleep)

1. https://cron-job.org → daftar/login → **Create cronjob**.
2. URL: domain Railway dari langkah 1 (root path, method GET).
3. Interval: tiap **10 menit**.
4. Simpan, biarkan jalan terus selama masa uji Q-1.

## 3. Pantau kredit Railway (spesifik Railway, tidak ada di Render)

Buka **Usage** di dashboard Railway sesekali selama masa uji 7-14 hari.
Proses `heartbeat.js` sangat ringan (idle + 1 HTTP request tiap 60 detik),
jadi diperkirakan jauh di bawah $1/bulan — tapi Railway tidak publikasikan
tarif per-resource secara eksplisit, jadi ini ASUMSI yang perlu dikonfirmasi
dari data Usage riil, bukan dianggap pasti aman.

## 4. Verifikasi gap via app utama

`GET /api/admin?action=health` (header `x-admin-secret: <CRON_SECRET>`)
melaporkan source `vps_heartbeat` dengan 3 kemungkinan status:
- `UNCONFIGURED` — normal SEBELUM deploy pertama kali (diam, tidak alert).
- `OK` + `age_seconds` — beat terakhir masih segar (<5 menit).
- `DOWN` + `down_since_mins` — daemon SEMPAT aktif tapi sekarang beat hilang
  >5 menit (TTL `EX 300` di `heartbeat.js` menjamin key hilang sendiri kalau
  proses berhenti kirim beat) — ini yang jadi ukuran gap gate Q-1. **Kalau
  DOWN muncul, cek dulu Usage Railway (langkah 3) sebelum menyimpulkan
  infra/koneksi yang gagal — bisa jadi cuma kredit habis.**

## 5. Gate Q-1

**Lolos kalau**: tidak ada gap `vps_heartbeat` >5 menit selama minimal 7 hari
berturut-turut, DAN gap itu bukan disebabkan kredit Railway habis (kalau
disebabkan kredit, itu bukan gagal infra — evaluasi ulang budget/plan
berbayar Railway secara terpisah, bukan otomatis pindah platform lagi).

**Gagal karena infra beneran (bukan billing)** → tunda Fase B sepenuhnya
(Plan P on-demand tetap jalur utama, aplikasi tidak terganggu) sambil cari
kandidat lain di luar yang sudah dicoba.

## Catatan

- Redeploy: push ke `main` yang menyentuh folder `vps/` akan auto-redeploy
  service ini di Railway (auto-deploy dari GitHub aktif secara default).
- Tidak ada langkah SSH manual — Railway deploy sepenuhnya lewat Git +
  dashboard, sama seperti Render.
- Kode (`heartbeat.js`, `Dockerfile`) sengaja platform-agnostic (baca `PORT`
  dari env, bind `0.0.0.0`) — bisa pindah ke Render/platform lain kapan saja
  tanpa ubah kode, kalau blocker kartu di atas nanti selesai ditelusuri.
