# DAUN MERAH — HANDOFF DOKUMEN

> **Diupdate:** 2026-04-27
> **Branch:** main
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`
> **Production URL:** https://financial-feed-app.vercel.app
> **Context file terlengkap:** `daun_merah.md`

---

## STATUS: BUG FIX SESSION — P0 SELESAI, P1-P3 SEBAGIAN

Gap analysis eksternal menemukan bug kritis. Semua P0 sudah diverifikasi dan difix dalam session 2026-04-27.

---

## APA YANG SUDAH DIFIX (SESSION INI)

### P0-1 — sw.js FETCH_URL mati
**File:** `sw.js` line 2
**Bug:** `FETCH_URL = '/.netlify/functions/rss'` — endpoint Netlify tidak ada sejak migrasi ke Vercel
**Fix:** `FETCH_URL = '/api/feeds?type=rss'`
**Impact:** Background fetch / periodicSync sebelumnya silent fail. Sekarang berfungsi.

### P0-2 + P0-3 — rc4 Regime Check false positive sistemik
**File:** `index.html`, fungsi `ckAutoTickRegimeCheck()`
**Bug 1:** `ev.impact !== 'high'` — lowercase, tapi API return `'High'` (kapitalized). Filter selalu skip semua event.
**Bug 2:** `new Date(ev.datetime)` — field `datetime` tidak ada di response `api/calendar.js`. `NaN` selalu skip semua event.
**Hasil:** `dangerous.length === 0` selalu → rc4 selalu auto-tick PASS palsu. Trader entry tanpa filter event high-impact.
**Fix:** `ev.impact !== 'High'` + construct timestamp dari `ev.date` + `ev.time_wib` (WIB = UTC+7).

### P0-4 — convertToWIB timezone salah
**File:** `api/calendar.js`, fungsi `convertToWIB()`
**Bug:** Comment bilang "FF XML stores time in UTC" tapi ForexFactory pakai **US/Eastern (EST/EDT)**. Offset `+7` salah: seharusnya `+12` (EST→WIB) atau `+11` (EDT→WIB).
**Contoh nyata:** NFP 8:30 AM EST = seharusnya 20:30 WIB, tapi tampil 15:30 WIB — off 5 jam.
**Fix:** Deteksi DST US otomatis, terapkan offset yang benar.

### P0-5 — rate-path heuristic tidak honest
**File:** `api/rate-path.js` + `index.html` render CB card
**Bug:** UI tampilkan "Hold X% / Cut Y%" tanpa indikasi bahwa ini step-function heuristic, bukan probabilitas pasar (CME FedWatch).
**Fix:** Tambah label "(Est.)" + tooltip "Estimasi — bukan probabilitas pasar" di render rate path.

### P1-1 — rate limiter race condition
**File:** `api/_ratelimit.js`
**Bug:** `INCR` lalu `EXPIRE` fire-and-forget. Window kecil antara keduanya bisa create orphan key tanpa TTL.
**Fix:** Gunakan `SET key 1 NX EX window` untuk set pertama, atomic.

### P1-2 — push subscription base64 truncation
**File:** `api/subscribe.js`
**Bug:** `Buffer.from(subscription.endpoint).toString('base64').slice(0,80)` — 80-char prefix bisa collision untuk FCM endpoints yang identik di prefix.
**Fix:** Ganti ke SHA-256 hash dari endpoint URL.

### P2-1 — digest_history race condition
**File:** `api/market-digest.js`
**Bug:** GET history → push → SET. Multi-tab concurrent write bisa lose entries.
**Fix:** LPUSH + LTRIM (atomic list operations).

### P2-2 — feeds.js rssMemCache module-level
**File:** `api/feeds.js`
**Bug:** `const rssMemCache = { xml: null, fetchedAt: 0 }` di module scope. Cold start reset cache. Violates constraint #5.
**Fix:** Hapus in-memory cache, andalkan Redis `rss_cache` saja.

### P3-1 — _lastThesis tidak persist
**File:** `index.html`
**Bug:** `_lastThesis` global reset saat refresh. Tombol "Gunakan untuk jurnal" silently fail jika halaman di-refresh.
**Fix:** Pada init app, fetch `latest_thesis` dari Redis dan set `_lastThesis`.

---

## APA YANG BELUM DIFIX (PERLU SESSION BERIKUTNYA)

### P1 — Perlu difix sebelum next trading session
1. **Pip value cross-pair** — `calcPipValueUSD` error 10-30% untuk EUR/JPY, GBP/JPY, dll. Solusi: tambah disclaimer di UI untuk cross-pair, atau fetch spot untuk konversi.
2. **CB rates stale** — Cek ECB April 2026, BOE March 2026. Update `api/cb-status.js` object `CB_DATA` manual.
3. **Real yields stale** — EUR `as_of` 2026-01-15 = >100 hari. Update setelah ECB SPF Q2.

### P2 — Robustness
4. **cb_bias race condition** — `market-digest.js` merge HGET cb_bias → merge → HSET. Rare tapi ada.
5. **Groq error isolation** — jika Call 1 timeout, partial response tidak dikembalikan. Pertimbangkan return partial.
6. **Service Worker update flow** — tidak ada update prompt, cache tidak pernah dibaca.

### P3 — Polish
7. **Checklist state per-pair** — manual items carry over saat ganti pair.
8. **Journal N+1** — 51 Redis calls untuk 50 entries. Gunakan MGET.
9. **SOP update** — Petunjuk masih sebut 2 playbook, sekarang 4.

---

## TECHNICAL DEBT & TIME BOMBS (Teridentifikasi 2026-06-02)

Ini bukan bug aktif hari ini — tapi akan meledak jika dibiarkan. Prioritas berdasarkan kapan "bom" meledak.

---

### TB-1 — Journal N+1 Query ⚠️ MELEDAK saat >80 trade
**Lokasi:** `api/journal.js` baris 158–160 (GET list) dan 222–225 (GET analyze)
**Masalah:** `ZRANGE` ambil semua ID, lalu loop individual `GET journal:{device_id}:{id}` per entry. 100 trade = 101 Redis calls sequentially.
**Estimasi ledak:** ~80 trade × 80ms = 6.4s. Vercel akan timeout (10–60s tergantung plan), jurnal tidak bisa dibuka.
**Fix:** Ganti loop GET dengan satu `MGET` call.
```js
// Sekarang:
for (const id of ids) { const raw = await redisCmd('GET', `journal:${deviceId}:${id}`); ... }
// Fix:
const keys = ids.map(id => `journal:${deviceId}:${id}`);
const raws = await redisCmd('MGET', ...keys);
```
**Effort:** 30 menit, dua tempat di `journal.js`.

---

### TB-2 — AI Fallback Chain Melebihi Vercel Timeout ⚠️ MELEDAK saat SambaNova lambat
**Lokasi:** `api/market-digest.js` — Call 1 chain
**Masalah:** SambaNova timeout 28s + OpenRouter timeout 28s = 56s total sebelum Groq sempat dicoba. Jika Vercel membatasi eksekusi di <60s (atau SambaNova sedikit over), seluruh chain mati sebelum fallback aktif.
**Catatan:** Berbeda dari deskripsi awal — bukan 25s limit, tapi 28s+28s tidak ada buffer.
**Fix:** Turunkan timeout Call 1 per provider: SambaNova 12s, OpenRouter 12s, Groq 14s. Total worst case 38s — aman di semua plan.
```js
const raw = await aiCall(SAMBANOVA_URL_CALL1, ..., 12000); // was 28000
const raw = await aiCall(OPENROUTER_URL, ..., 12000);      // was 28000
const raw = await aiCall(GROQ_URL, ..., 14000);            // was 20000
```
**Effort:** 3 baris ganti angka di `market-digest.js`.

---

### TB-3 — Model AI Gratisan Bisa Didepresiasi Kapan Saja 🔴 SUDAH TERJADI SEKALI (Cerebras)
**Lokasi:** `api/market-digest.js` baris 15–22
**Model yang rentan:**
- `DeepSeek-V3.2` di SambaNova (preview, bisa diganti versi baru)
- `openai/gpt-oss-120b:free` di OpenRouter (free tier bisa hilang tanpa notis)
- `qwen3-32b` di Groq (model open-source dirotasi)
**Cara deteksi dini:** Cek admin logs — jika semua Call 1 tiba-tiba fallback ke template, kemungkinan model expired.
**Fix saat terjadi:** Update string konstanta di baris 15–22, redeploy. Tidak perlu ubah logika.
**Catatan:** `GROQ_MODEL = 'llama-3.3-70b-versatile'` (Call 2–4) relatif stabil karena flagship Groq.

---

### TB-4 — Data Kalender FOMC & Inflasi Hardcoded Akan Expired 📅 MELEDAK April 2027 (FOMC) + SUDAH STALE (inflasi)
**Lokasi:**
- `api/rate-path.js` baris 84–88: tanggal FOMC terakhir `'2027-04-29'`
- `api/real-yields.js` baris 16–28: inflation expectations CHF `refresh Mar 2026` (sudah 3 bulan lewat), EUR `as_of 2026-01-15`
**Masalah FOMC:** Setelah April 2027, `getNextFOMCMeetings()` return array kosong → rate path UI kosong.
**Masalah inflasi:** CHF real yield pakai estimasi SNB Dec 2025 — sudah stale. EUR pakai ECB SPF Q1 2026.
**Fix FOMC:** Update `FOMC_DATES` array di `rate-path.js` setiap awal tahun (Fed rilis jadwal resmi Jan/Feb).
**Fix inflasi:** Update nilai di `INFLATION_EXPECTATIONS` object setiap kuartal. Source: ECB SPF, BoC MPR, SNB quarterly forecast.
**Update segera untuk CHF:** SNB meeting Juni 2026 sudah lewat — cek SNB.ch untuk forecast terbaru.

---

### TB-5 — Vercel Limit 12 Serverless Functions 🚨 DEPLOYMENT GAGAL jika ditambah 1 file
**Lokasi:** `api/` folder — **saat ini tepat 12 file aktif**
```
feeds.js, journal.js, market-digest.js, admin.js, cb-status.js,
calendar.js, rate-path.js, real-yields.js, correlations.js,
risk-regime.js, sizing-history.js, subscribe.js
```
**File helper (aman, tidak dihitung):** prefix `_` — `_ratelimit.js`, `_circuit_breaker.js`, `_retry.js`, `_fundamental_parser.js`, `_push_keywords.js`
**Aturan:** File baru di `api/` WAJIB pakai prefix `_` (helper) atau gabung ke fungsi existing.
**Cara merge jika perlu tambah endpoint:** Tambah branch `?type=xxx` di `feeds.js` atau `admin.js` (sudah punya pola ini).
**Effort fix jika terlanjur:** Hapus/rename file, push ulang. Deploy otomatis sembuh.

---

### TB-6 — FinancialJuice RSS adalah Single Point of Failure 🔴 LUMPUH TOTAL jika mati
**Lokasi:** `api/feeds.js` baris 39: `RSS_URL = 'https://www.financialjuice.com/feed.ashx?xy=rss'`
**Masalah:** Satu-satunya sumber news feed utama. Jika FinancialJuice down, paywall, atau block Vercel IP → aplikasi bisu total.
**Mitigasi yang sudah ada:** Redis cache 50s + stale fallback jika Redis punya data lama.
**Fix jangka menengah:** Tambah 1–2 sumber backup di fallback chain, contoh:
- `https://forexlive.com/feed/news` (RSS publik, news forex)
- `https://www.fxstreet.com/rss/news` (RSS publik)
**Implementasi:** Di `rssHandler()`, jika FinancialJuice gagal dan cache stale → coba source backup, merge items, de-dup by title.
**Effort:** ~2 jam implementasi + testing.

---

## CARA MELANJUTKAN

1. Baca `daun_merah.md` untuk full context proyek.
2. Baca `daun_merah_progress.md` untuk status lengkap.
3. Cek checklist di atas — items dengan [ ] belum selesai.
4. Constraint absolut ada di `daun_merah.md` bagian bawah — **jangan violate**, terutama 12-function limit.
5. Endpoint URL yang benar: `/api/feeds?type=rss` (bukan `/api/rss`), `/api/admin?action=push` (bukan `/api/push`).

---

## CATATAN TEKNIS PENTING

- **`/api/rss` dan `/api/cot` TIDAK ADA** — gunakan `/api/feeds?type=rss` dan `/api/feeds?type=cot`
- **`/api/push` TIDAK ADA** — gunakan `/api/admin?action=push`
- **`/api/health`, `/api/redis-keys`, `/api/admin-prompts` TIDAK ADA** — gunakan `/api/admin?action=...`
- **Rate Path bukan CME FedWatch** — SPA tidak bisa di-scrape. Pakai SOFR/EFFR FRED + heuristic. UI sudah diberi label.
- **Correlations on-demand** — tombol "Muat Korelasi", bukan auto-fetch. Cache Redis 24 jam.
- **Device ID** — `szGetDeviceId()` dari localStorage `daun_merah_device_id`.
- **Thesis → Journal** — `_lastThesis` global. Sekarang di-init dari Redis `latest_thesis` saat app load.
- **Prompts** — update tanpa redeploy: `POST /api/admin?action=admin-prompts&key=prompt_digest` dengan `x-admin-secret`.
- **Rate limiter fail-open** — jika Redis unavailable, request tetap dilayani.
- **sendTelegram naming** — di `admin.js`: `sendHealthTelegram()` dan `sendPushTelegram()` (bukan `sendTelegram`).
- **calendar.js response** — TIDAK ADA field `datetime`. Ada: `{ date, time_wib, currency, event, impact, forecast, previous, actual }`.
- **convertToWIB** — ForexFactory pakai US/Eastern (EST/EDT), bukan UTC. Offset ke WIB: EST+12, EDT+11. DST otomatis terdeteksi.
