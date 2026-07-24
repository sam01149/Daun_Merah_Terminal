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

## 8. U-3 — auto-entry virtual (Plan U, fase tes) — 2026-07-20, BELUM DI-PUSH

Dikerjakan di branch lokal `plan-u` (`daun_merah_plan.md` §Plan U — mode
eksekusi khusus, DILARANG push sampai U-1..U-4 selesai + OK user). Bagian ini
BELUM live di Railway — dicatat di sini supaya env var-nya sudah siap begitu
U-6 (fase final Plan U) push ke `main`.

**Yang ditambahkan ke `daemon.js`:**
- **Lapis 0 — scheduler auto-entry**: node-cron memanggil `ohlcv_analyze` HTTP
  dengan `&auto=1` untuk pair di `AUTO_ENTRY_PAIRS`, 2 slot/hari/pair (jam via
  `AUTO_ENTRY_HOURS_UTC`). Setup yang dihasilkan tercatat di `setup_log:v1`
  seperti biasa — `source:'auto'` baru benar-benar ke-tag begitu backend
  `api/admin.js` paket U-2 selesai memahami param `auto=1` (saat modul ini
  ditulis, U-2 belum selesai — lihat komentar besar U-3 di kepala blok kode di
  `daemon.js`). Desain SENGAJA fail-forward: daemon tetap kirim `auto=1`
  sekarang, backend yang belum paham param itu mengabaikannya saja (setup
  tetap tercatat `source:'manual'` sampai U-2 menyusul) — tidak ada yang rusak
  di kedua arah urutan deploy.
- **Lapis 1 — filter berita keras**: sebelum tiap panggilan, daemon cek
  `calendar_v1`+`calendar_next_v1` — ada event *High impact* untuk currency
  kaki pair dalam <4 jam ke depan → slot di-skip, alasan dicatat ke
  `auto_skip_log` (Redis LIST, cap 200).
- **Lapis 2 — auto-cancel virtual: DI-DESCOPE untuk rilis ini.** Sub-riset
  wajib (plan §U-3 langkah 3a: ukur median latensi field `actual` di
  `calendar_v1`, butuh ≥3 event high-impact nyata) tidak bisa dituntaskan
  sinkron dalam satu sesi kerja — dicek langsung ke `calendar_v1` produksi
  (read-only) saat kode ini ditulis (2026-07-20 dini hari WIB): event
  high-impact berikutnya baru jatuh malam harinya, >18 jam dari waktu
  penulisan, di luar jangkauan satu sesi. Sesuai klausul plan sendiri ("kalau
  median >30 menit, descope Lapis 2, jangan dipaksakan") — data yang tidak
  bisa diverifikasi diperlakukan sama dengan "belum terbukti aman". Instrumen
  pengumpulan sampel (poin berikut) tetap jalan begitu daemon live, supaya
  keputusan berikutnya berbasis data asli.
- **Sub-riset 3a — instrumentasi latensi `actual`**: poll `calendar_v1`+`next`
  tiap 10 menit (murni observasi, tidak memicu aksi apa pun); begitu event
  *High impact* yang sudah lewat jadwal rilisnya (s/d 4 jam) punya `actual`
  terisi, latensi (waktu-terdeteksi − waktu-jadwal) dicatat ke
  `calendar_actual_latency_log:v1` (cap 100), sekali per event (dedup via
  `SET NX`). Setelah ≥3 sampel nyata terkumpul, keputusan Lapis 2 (aktifkan
  atau descope permanen) bisa diambil ulang di sesi berikutnya.
- **Uji konsistensi LLM**: 1x/hari (`AUTO_CONSISTENCY_HOUR_UTC`), panggil
  `ohlcv_analyze` pair pertama `AUTO_ENTRY_PAIRS` 3x berturut dengan
  `&test_deepseek=1` — flag diagnostik existing yang (a) memaksa model
  `deepseek-v4-flash`, SAMA dengan primary produksi, dan (b) `isDiagnosticOnly`
  sehingga TIDAK menulis cache produksi/`setup_log` (tidak mengotori data
  auto-entry Lapis 0). Hasil (bias identik? entry/SL/TP dalam toleransi 0.5%?)
  disimpan ke `consistency_log:v1` (cap 60).
- **Tighten preventif weekend gap** (U-3 lanjutan, 2026-07-24): 1x/minggu, Jumat
  jam `FRIDAY_TIGHTEN_HOUR_UTC`, GET `friday_tighten` — semua posisi eksperimen
  OPEN di `setup_log_auto:v1` yang belum punya `intervention` digeser SL-nya ke
  titik tengah antara SL lama & harga sekarang (`computePreventiveTightenSl`,
  murni kode, TIDAK ada call AI). Beda filosofi dari `position_review` di atas:
  itu reaktif per-berita, ini jadwal buta — market tutup 2 hari (weekend) berarti
  tidak ada cara react apa pun kalau ada gap besar Senin, jadi risikonya
  dikurangi duluan Jumat sore. Default 4 jam sebelum tutup (bukan 1 jam) karena
  jam terakhir sebelum close FX cenderung choppy/likuiditas tipis — tighten pas
  di jam itu justru rawan whipsaw, bukan lebih aman. Ditandai `intervention.type:
  'tighten_sl_preventive'` (field terpisah dari `tighten_sl` reaktif di stats
  `management.tighten_preventive`), data mentah/status tetap tidak disentuh.

**Env var baru (opsional, fail-open — kosong = pakai default di atas):**

| Env var | Default | Keterangan |
|---|---|---|
| `AUTO_ENTRY_PAIRS` | `frxXAUUSD,frxEURUSD,frxGBPUSD` | Daftar pair (penamaan Deriv, dipetakan ke symbol/label Yahoo di `AUTO_ENTRY_SYMBOL_MAP`) yang ikut auto-entry + jadi pair uji konsistensi (elemen pertama). **Golden Trio (2026-07-22):** 3 pair mempercepat akumulasi sampel gate Plan U n≥100 dari ~50 hari ke ~16 hari (6 setup/hari), dengan kedalaman n≈33/pair tetap lolos ambang CLT n≥30 — lihat `daun_merah_riset.md`. |
| `AUTO_ENTRY_HOURS_UTC` | `8,13` | Jam UTC slot auto-entry (perkiraan buka London/NY) — sengaja digeser dari jadwal digest Q-6 (00:00/07:00/12:30) supaya tidak tertelan dedup 30 menit `ohlcv_analyze`. |
| `AUTO_CONSISTENCY_HOUR_UTC` | `10` | Jam UTC uji konsistensi LLM (1x/hari). |
| `FRIDAY_TIGHTEN_HOUR_UTC` | `17` | Jam UTC tighten preventif weekend gap, HANYA Jumat (4 jam sebelum tutup 21:00 UTC — lihat alasan choppy-hour di atas kalau mau menggeser lebih mepet). |

Tidak ada env var WAJIB baru untuk U-3 — semua opsional dengan default masuk
akal; `CRON_SECRET` yang sudah ada (§6) dipakai ulang untuk trigger HTTP-nya.

**Verifikasi setelah U-6 push (belum bisa dilakukan sekarang):**
- Log Railway menunjukkan baris `daemon: U-3 auto-entry aktif` +
  `daemon: U-3 uji konsistensi aktif` saat boot.
- `setup_log:v1` mulai berisi entri `source:'auto'` (butuh U-2 sudah live).
- `consistency_log:v1` & `calendar_actual_latency_log:v1` bertambah entri
  harian (`admin?action=redis-keys` atau Upstash console).
- Gate fase tes penuh: lihat `daun_merah_plan.md` §"Kriteria Fase Tes".

## 9. U-5b — trigger review posisi event-driven (Plan U, WAVE 2) — 2026-07-20, BELUM DI-PUSH

Sama seperti §8: dikerjakan di branch lokal `plan-u`, BELUM live di Railway.
Dicatat di sini supaya env var-nya sudah siap begitu U-6 push ke `main`.

**Yang ditambahkan ke `daemon.js`:**
- Hook di `pollNews` (dalam loop item `news_history`, SETELAH `cat` dihitung,
  SEBELUM gate `isHighImpactCategory` yang khusus alert Q-4): tiap item
  kategori `market-moving` ATAU `geopolitical` dicek `detectCurrencyLegs` (peta
  keyword lokal 9 currency termasuk XAU) — tidak match currency apa pun = skip
  (fail-closed, hemat budget).
- Kandidat yang match currency dicek `isCorroborated` (duplikasi SADAR dari
  `api/_position_review.js`, pola sama `newscat.js`): `market-moving` selalu
  corroborated; `geopolitical` butuh >=1 item lain (guid beda) dalam +-30
  menit dengan overlap >=2 token signifikan. Geopolitical UNCONFIRMED TIDAK
  memicu review — dicatat ke `posreview_skip_log` (LPUSH cap 50) + diantre di
  memori (`posReviewRecheckQueue`), dicoba ulang tiap `pollNews` tick s/d 30
  menit sejak `pubDate` asli (lewat itu = hangus, diskon permanen).
- Kandidat yang lolos (market-moving atau geopolitical corroborated): `GET
  setup_log:v1` (HANYA di titik ini, bukan tiap poll), cari setup
  `status==='open'` yang leg currency label-nya match. Per posisi match:
  cooldown `posreview_cd:<id>` (SET NX EX, default 6 jam) menahan review
  dobel dari burst headline; cap harian `posreview_daily:<yyyymmdd>` (INCR,
  default 3) dicek PER call (bukan per trigger) supaya satu headline yang
  match banyak posisi tidak melompati cap.
- Posisi yang lolos cooldown+cap dipicu `POST
  /api/admin?action=position_review` (header `x-cron-secret`, TANPA retry
  agresif — review telat lebih baik daripada dobel) dengan timeout client
  65 detik (> `maxDuration` 60 detik `api/admin.js` di `vercel.json` — S161).

**Env var baru (opsional, fail-open — kosong = pakai default di atas):**

| Env var | Default | Keterangan |
|---|---|---|
| `POSREVIEW_COOLDOWN_SECS` | `21600` (6 jam) | Cooldown per posisi (`posreview_cd:<id>`) — satu review per posisi per window. |
| `POSREVIEW_DAILY_CAP` | `3` | Cap panggilan `position_review` per hari (dicek per call, bukan per trigger). |

Tidak ada env var WAJIB baru — `CRON_SECRET`/`APP_BASE_URL` yang sudah ada
(§6) dipakai ulang.

**Verifikasi setelah U-6 push (belum bisa dilakukan sekarang):**
- Log Railway menunjukkan baris `daemon: U-5b position_review <id> -> HTTP
  200` saat headline market-moving/geopolitical-corroborated menyentuh
  currency pair yang punya setup `open`.
- `posreview_skip_log` bertambah entri `reason:'unconfirmed'` saat headline
  geopolitical belum terkonfirmasi.
- `position_review_log:v1` (ditulis `api/admin.js`) bertambah entri
  `decision`/`confidence`/`downgraded` setelah review berjalan.
- Simulasi lokal (mock Redis+endpoint, dijalankan manual sesi ini
  2026-07-20): trigger match currency+open setup memanggil endpoint;
  cooldown menahan trigger kedua untuk posisi sama; cap harian 3 menahan
  panggilan ke-4 dari 4 posisi kandidat sekaligus; geopolitical unconfirmed
  di-skip lalu jalan begitu korroborasi datang <=30 menit — SUKSES, semua
  skenario OK (skrip tidak dicommit, pola sama U-3).
