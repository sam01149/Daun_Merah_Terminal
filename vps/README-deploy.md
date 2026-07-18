# Deploy — Plan Q-1 (Railway free trial)

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
   supaya bisa verifikasi manual & pantau `admin?action=health` dari luar).
6. Deploy otomatis jalan. Catat domain publik, contoh:
   `https://daun-merah-terminal-production.up.railway.app`.
7. Verifikasi manual: buka domain tsb di browser — harus balas JSON
   `{"status":"up","last_beat_epoch":...}`.

## 2. Pinger cron-job.org — TIDAK diperlukan untuk Railway (beda dari Render)

Dicek live ke `docs.railway.com/reference/app-sleeping`: fitur sleep Railway
(nama resminya **Serverless**) itu **opt-in** (harus diaktifkan manual di
Settings, TIDAK nyala otomatis untuk service baru) — beda dari Render yang
spin-down otomatis tiap 15 menit idle. Pemicunya pun beda: Railway melihat
**outbound traffic** (bukan ada/tidaknya request masuk), sleep baru terjadi
kalau tidak ada outbound packet sama sekali selama >10 menit. `heartbeat.js`
sendiri mengirim outbound request ke Upstash Redis **tiap 60 detik** — jauh
di bawah ambang 10 menit itu, jadi daemon otomatis mencegah dirinya sendiri
tertidur, tanpa bantuan pinger eksternal.

**Yang tetap perlu dicek manual sekali:** buka tab **Settings** service ini
di Railway → pastikan toggle **"Serverless"** dalam keadaan **OFF** (default
seharusnya begitu untuk service baru, tapi konfirmasi langsung supaya pasti).

Kalau nanti pindah balik ke Render/platform lain yang spin-down berbasis
inbound traffic, baru pinger cron-job.org jadi wajib lagi — endpoint HTTP di
`heartbeat.js` sudah disiapkan generic untuk kebutuhan itu.

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

## 6. Q-2..Q-6 — daemon penuh (2026-07-18, sesi lanjutan)

Entry point service pindah dari `heartbeat.js` ke **`daemon.js`** (Dockerfile
sudah diupdate, `CMD ["node", "daemon.js"]`) — proses ini SUDAH mencakup fungsi
heartbeat Q-1 di dalamnya (jalan di proses yang sama), jadi gate uptime yang
sedang berjalan TIDAK terputus, cuma proses yang menjalankannya bertambah
tanggung jawab. `heartbeat.js` tetap ada di repo sebagai referensi/rollback
cepat (tinggal ganti CMD Dockerfile balik kalau perlu).

**Yang ditambahkan:**
- Q-3: streaming candle 1H 14 pair FX dari Deriv WebSocket langsung ke Redis
  (`ohlcv:<symbol>:1h`, key & shape SAMA dengan `ohlcv_sync` — Plan P/cron tetap
  jalan sebagai fallback kalau daemon mati).
- Q-4: alert berita high-impact (kategori `market-moving` dari `newscat.js`) —
  web-push + Telegram, dedup 48 jam per `guid`.
- Q-5: alert level harga (harga live vs zona konfluensi `ohlcv_analysis:<symbol>`)
  — cooldown 4 jam per zona. Opsional-terpisah: kalau cache konfluensi pair
  tertentu belum pernah dihitung (pair itu belum dibuka di tab Analisa), pair
  itu di-skip diam-diam, bukan error.
- Q-6: scheduler `node-cron` memicu `market-digest` (3 jadwal) + `ohlcv_sync`
  (tiap jam) lewat HTTP — **jalan PARALEL dengan workflow GitHub Actions**
  (`market-digest.yml`, `ohlcv-sync.yml` TIDAK dimatikan). `ohlcv_sync` sudah
  men-warm cache TA sendiri di akhir handler-nya, jadi tidak ada trigger
  `ta-warm` terpisah dari daemon.

**Env var BARU yang wajib ditambah di Railway dashboard (tab Variables),
selain 2 yang sudah ada:**

| Env var | Sumber nilai | Wajib untuk |
|---|---|---|
| `DERIV_APP_ID` | sama dengan Vercel env (`1089` interim, lihat backlog `[DERIV-APPID]` di `daun_merah_plan.md`) | Q-3 |
| `CRON_SECRET` | sama dengan Vercel env / GitHub Actions secret | Q-4 (baca `news_history` tidak butuh ini, tapi Q-6 wajib), Q-6 |
| `TELEGRAM_BOT_TOKEN` | sama dengan Vercel env (bot sudah ada dari Plan M) | Q-3 (alert degraded), Q-4, Q-5 |
| `TELEGRAM_CHAT_ID` | sama dengan Vercel env | Q-3, Q-4, Q-5 |
| `VAPID_PUBLIC_KEY` | sama dengan Vercel env | Q-4, Q-5 (web-push) |
| `VAPID_PRIVATE_KEY` | sama dengan Vercel env | Q-4, Q-5 |
| `VAPID_SUBJECT` | sama dengan Vercel env (opsional, ada default) | Q-4, Q-5 |
| `APP_BASE_URL` | opsional, default `https://financial-feed-app.vercel.app` | Q-5, Q-6 |

**Desain fail-open**: tiap modul (Q-3/Q-4/Q-5/Q-6) cek env var-nya sendiri di
awal — kalau kosong, modul itu SKIP dengan log warning, heartbeat (Q-1) dan
modul lain tetap jalan normal. Jadi env var di atas BOLEH ditambah bertahap
(misal cuma `DERIV_APP_ID` dulu untuk uji Q-3 saja) tanpa mematikan yang sudah
jalan — tapi setiap kali menambah/mengubah Variables, klik **Redeploy** manual
di Railway (env var baru tidak otomatis ke-pick-up proses yang sedang jalan).

**Verifikasi setelah deploy:**
- `GET /` (domain publik) → field `deriv_stream` harus `connecting_or_up`
  (bukan `disabled`) kalau `DERIV_APP_ID` sudah diisi.
- Redis key `ohlcv:EURUSD=X:1h` (dan 13 pair lain) harus ter-update dengan
  `source.1h == "deriv_stream"` dalam 1 jam pertama (candle H1 baru close di
  awal jam) — cek via `admin?action=redis-keys` atau Upstash console.
- Kirim 1 pesan Telegram test manual dari akun bot yang sama untuk pastikan
  `TELEGRAM_BOT_TOKEN`/`CHAT_ID` benar SEBELUM mengandalkan alert Q-4/Q-5 (kalau
  token salah, daemon diam saja — tidak ada error yang terlihat dari luar).
- Pantau Usage Railway (§3) — daemon penuh (WS + poll 30s + cek zona 60s +
  cron) tetap jauh lebih ringan dari cap 1 vCPU/0.5GB, tapi volume command
  Redis naik dari sekadar heartbeat; kalau ada tanda mendekati limit bulanan
  Upstash (500K command/bulan, cek dashboard Upstash), evaluasi ulang interval
  poll sebelum menambah pair/fitur lagi.

**Kriteria selesai terukur (dari `daun_merah_plan.md`, BUTUH WAKTU, bukan cuma
kode jalan) — belum bisa dicentang di hari yang sama dengan deploy:**
- Q-3: candle H1 di Redis ter-update ≤60 detik setelah close, 3 hari berturut.
- Q-4: alert berita high-impact sampai <60 detik dari `pubDate`, 3 kejadian nyata.
- Q-6: 3 hari berturut digest jalan tepat waktu ±2 menit dari jadwal.
Kalau salah satu gagal konsisten, modul itu (bukan seluruh daemon) yang
dievaluasi ulang — heartbeat Q-1 dan fallback Plan P/cron tidak terpengaruh.

## 7. Lapisan self-healing (2026-07-18, sesi lanjutan malam)

Daemon sekarang menyembuhkan dirinya sendiri di 4 lapis (detail teknis di
komentar `daemon.js`, changelog `daun_merah.md`):

- **Lapis 0 — proses**: `uncaughtException` → alert Telegram best-effort →
  `exit(1)`; `vps/railway.json` (`restartPolicyType: ALWAYS`) menyuruh Railway
  restart container-nya. `unhandledRejection` cuma di-log, tidak mematikan
  proses. TIDAK perlu setting manual di dashboard — file config ikut repo.
- **Lapis 1 — Redis**: gagal beruntun >=5 (network/429 quota Upstash) → mode
  degraded: tulis candle, poll berita, GET zona, dan supervisor di-backoff
  (cooldown 60s menggandakan diri s/d 30 menit); heartbeat tetap jadi probe
  pemulihan tiap 60 detik. Alert Telegram saat masuk degraded & saat pulih.
- **Lapis 2 — WebSocket zombie**: ping aplikasi Deriv (`{"ping":1}`) tiap 60
  detik; kalau TIDAK ada pesan apa pun >3 menit padahal status masih OPEN
  (TCP putus diam-diam), koneksi dibunuh paksa dan reconnect backoff jalan.
- **Lapis 3 — data**: (a) scheduler yang gagal (timeout/5xx) di-retry SEKALI
  setelah 5 menit sebelum menyerah + alert; (b) supervisor tiap 10 menit cek
  umur candle sentinel `EURUSD=X` — basi >3 jam saat market FX buka → trigger
  `ohlcv_sync` otomatis (lock `selfheal:ohlcv_sync` NX 1 jam), masih basi
  setelah itu → alert Telegram (dedup 6 jam).

Lapisan kembar di sisi Vercel (`admin?action=health` probe `data_freshness`)
melakukan hal yang sama dari luar — tetap ada penyembuhan data walau daemon
Railway mati total. Kunci lock-nya SAMA (`selfheal:ohlcv_sync`), jadi dua
lapisan tidak saling dobel-trigger.

Verifikasi observability: `GET /` domain publik daemon sekarang ikut memuat
`ws_last_activity_age_s` (umur pesan WS terakhir), `redis_guard`
(degraded/failures), dan `last_supervisor_heal_at`.
