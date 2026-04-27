# DAUN MERAH — HANDOFF DOKUMEN
> **Diupdate:** 2026-04-26
> **Branch:** main — semua perubahan deployed
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`
> **Production URL:** https://financial-feed-app.vercel.app
> **Context file terlengkap:** `daun_merah.md`

---

## STATUS: FEATURE-COMPLETE + PRODUCTION STABLE ✅

Semua fitur dan perbaikan terbaru sudah deployed.

| Commit | Konten |
|--------|--------|
| `b1729e9` | Fitur PETUNJUK — SOP end-to-end penggunaan aplikasi |
| `6f48bcb` | Fix bug: market-digest internal RSS URL masih pakai `/api/rss` yang sudah dihapus |
| `108ffab` | Mobile bottom nav + SVG icon (dual-leaf loop design) |
| `95db702` | Konsolidasi API ke 12 fungsi (Vercel Hobby limit) |
| `658a1a6` | Task 10f/g/h — Health Monitoring, Redis Registry, Rate Limiting |
| `022dc40` | Task 7-9, 10a/b/e — Regime Gate, Journal, Thesis, Playbooks, Correlations |
| `9e5f7fa` | Task 4 — Position Sizing Calculator |

---

## PERUBAHAN TERBARU (Session Ini)

### ✅ Konsolidasi API (12 fungsi)
Vercel Hobby = max 12 serverless functions. Dari 17 → 12:
- **`api/feeds.js`** = menggantikan `api/rss.js` + `api/cot.js` (dihapus)
  - `GET /api/feeds?type=rss` — RSS proxy
  - `GET /api/feeds?type=cot` — COT scraper
- **`api/admin.js`** = menggantikan `api/health.js` + `api/redis-keys.js` + `api/admin-prompts.js` + `api/push.js` (dihapus)
  - `GET /api/admin?action=health`
  - `GET /api/admin?action=redis-keys` (+ `?cleanup=true`)
  - `GET/POST/DELETE /api/admin?action=admin-prompts&key=...`
  - `POST /api/admin?action=push`
- `api/fundamentals.js` dihapus (tidak ada tab di UI, deprecated)

### ✅ Bug Fix: RINGKASAN "0 berita"
`market-digest.js` memanggil `/api/rss` (sudah dihapus). Diupdate ke `/api/feeds?type=rss`.

### ✅ Icon SVG
- `icon.svg` ditambahkan — dual-leaf loop (bear merah `#b23030` + bull teal `#0d4d4d`), viewBox="0 20 680 680"
- `manifest.json` diupdate: referensi ke `icon.svg` (ganti inline "DM" text)
- `sw.js` diupdate: icon push notif → `icon.svg`
- `index.html` head: `<link rel="icon" href="icon.svg" type="image/svg+xml">`

### ✅ Mobile Bottom Nav
- `.nav-views` (top tabs) disembunyikan di ≤767px
- `<nav class="bot-nav" id="botNav">` — fixed bottom bar, 8 tombol: News/Digest/Cal/COT/Check/Sizing/Jurnal/SOP
- Active state disinkronkan dua arah antara top nav dan bottom nav
- `.feed-scroll` dan `.ck-sections` dapat `padding-bottom: calc(60px + env(safe-area-inset-bottom))` di mobile
- **Event listener pakai event delegation pada `document`** — `#botNav` HTML ada setelah `</script>`, jadi `querySelectorAll` saat parse time hasilnya kosong

### ✅ Checklist Mobile Layout
- `ck-wrap` adalah `display:flex` (row) — di mobile `.ck-sidebar` (232px fixed) mengambil sebagian besar layar
- Fix: di ≤767px, `ck-wrap` diubah ke `flex-direction:column` dan `.ck-sidebar` di-`display:none`
- Verdict/progress di mobile ditangani oleh `.ck-mobile-bar` yang sudah ada di `.ck-sections`

### ✅ Tab PETUNJUK
- Tab ke-8: `data-view="petunjuk"`, warna `#60a5fa`
- Panel statis (tidak ada API call) berisi SOP end-to-end:
  1. Alur keputusan (flow diagram)
  2. Pre-Session (4 langkah)
  3. Live Session (4 langkah)
  4. Post-Trade (2 langkah)
  5. 6 Aturan Kunci
- Mobile-optimized: kolom "kenapa" hilang di ≤767px, font/spacing disesuaikan
- Accessible di bottom nav dengan label "SOP"

### ✅ Prompt XAUUSD Scalping
Ditambahkan ke `DIGEST_INSTR_DEFAULT` di `market-digest.js` — paragraf terpisah "XAUUSD:" setelah analisis utama dengan 3 poin: driver dominan, bias sesi, risiko spike 24 jam.

---

## STRUKTUR FILE LENGKAP (Current)

```
Financial_Feed_App/
├── index.html              # UI + JS — ~3500+ baris
├── manifest.json           # PWA — icon: icon.svg, purpose: any maskable
├── sw.js                   # Service Worker — push notif icon: icon.svg
├── icon.svg                # App icon — dual-leaf loop
├── vercel.json             # Security headers
├── package.json            # name: "daun-merah", deps: web-push
└── api/                    # TEPAT 12 fungsi
    ├── _ratelimit.js       # Shared rate limiter (bukan route publik — prefix _)
    ├── admin.js            # health + redis-keys + admin-prompts + push
    ├── calendar.js
    ├── cb-status.js
    ├── correlations.js     # Rate limited 5/min
    ├── feeds.js            # rss + cot
    ├── journal.js
    ├── market-digest.js    # Rate limited 4/min
    ├── rate-path.js
    ├── real-yields.js
    ├── risk-regime.js
    ├── sizing-history.js
    └── subscribe.js
```

---

## CRON-JOB.ORG SETUP

Job saat ini seharusnya:
- **URL:** `https://financial-feed-app.vercel.app/api/admin?action=push`
- **Method:** GET
- **Headers:** `x-cron-secret: <nilai CRON_SECRET>` dan `x-admin-secret: <nilai CRON_SECRET>`
- **Interval:** setiap 30 menit (atau sesuai preferensi)

---

## REDIS KEYS LENGKAP

| Key | Isi | TTL |
|-----|-----|-----|
| `rss_cache` | `{xml, fetchedAt}` | 60s |
| `cot_cache_v2` | Full COT payload | no TTL |
| `cb_bias` | CB bias per currency | no TTL |
| `digest_history` | Array max 7 digest AI | no TTL |
| `latest_thesis` | Structured thesis JSON | 21600s |
| `risk_regime` | VIX/MOVE/HY payload | 1800s |
| `real_yields` | Real yield per currency | 21600s |
| `rate_path` | USD rate path heuristic | 14400s |
| `correlations` | Correlation matrix | 86400s |
| `health_last_ok` | HSET source → last OK | no TTL |
| `sizing_history:{device_id}` | Sorted set sizing | no TTL |
| `journal:{device_id}:{id}` | Full journal entry | no TTL |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL |
| `prompt_digest` | Override Groq prompt | no TTL |
| `prompt_bias` | Override Groq prompt | no TTL |
| `prompt_thesis` | Override Groq prompt | no TTL |
| `push_subs` | HSET subscriptions | no TTL |
| `seen_guids` | Set GUID berita | 86400s |
| `rl:{endpoint}:{ip}:{window}` | Rate limit counter | auto 2×window |

**Deprecated (hapus via `POST /api/admin?action=redis-keys&cleanup=true`):** `cot_cache`, `fundamentals_cache`

---

## CATATAN IMPLEMENTASI PENTING

- **`/api/rss` dan `/api/cot` TIDAK ADA** — gunakan `/api/feeds?type=rss` dan `/api/feeds?type=cot`
- **`/api/push` TIDAK ADA** — gunakan `/api/admin?action=push`
- **`/api/health`, `/api/redis-keys`, `/api/admin-prompts` TIDAK ADA** — gunakan `/api/admin?action=...`
- **Rate Path bukan CME FedWatch** — SPA tidak bisa di-scrape. Pakai SOFR/EFFR FRED + heuristic.
- **Correlations on-demand** — tombol "Muat Korelasi", bukan auto-fetch. Cache Redis 24 jam.
- **Device ID** — `szGetDeviceId()` dari localStorage `daun_merah_device_id`. Dipakai di journal, sizing, checklist.
- **Thesis → Journal** — `_lastThesis` global, tombol prefill → `jnPrefillFromThesis()`.
- **Prompts** — update tanpa redeploy: `POST /api/admin?action=admin-prompts&key=prompt_digest` dengan `x-admin-secret`.
- **Rate limiter fail-open** — jika Redis unavailable, request tetap dilayani.
- **sendTelegram naming** — di `admin.js` fungsinya `sendHealthTelegram()` dan `sendPushTelegram()` (bukan `sendTelegram` — conflict saat merge).

---

## ENVIRONMENT

```
Stack:  Vanilla JS + HTML, Vercel Serverless Functions (Node.js CommonJS), Upstash Redis REST
AI:     Groq llama-3.3-70b-versatile (max 25s Vercel timeout)
Font:   Syne (heading) + DM Mono (body)
Colors: --accent: #c0392b (red), --pink: #f472b6 (jurnal), #60a5fa (petunjuk)
Redis:  Upstash REST — pattern: async function redisCmd(...args) di setiap api/*.js
Env:    GROQ_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
        FRED_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET
```

---

## CONSTRAINT ABSOLUT

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. **Vercel Hobby: TEPAT 12 serverless functions** — files dengan prefix `_` tidak dihitung. Tambah fitur baru = harus hapus atau konsolidasi yang lama
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport, bottom nav di ≤767px
9. Indonesian UI text, English code/comments/variables
