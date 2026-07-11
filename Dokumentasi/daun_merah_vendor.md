# Daun Merah — Inventaris Vendor & Layanan Eksternal

> **Dibuat:** 2026-07-11 (session 157)
> **Tujuan dokumen:** daftar lengkap semua layanan pihak ketiga yang dipakai app ini — siapa, buat apa, gratis/berbayar, dan env var mana yang terkait. Untuk detail pemakaian AI secara spesifik (limit, frekuensi, fallback), lihat [daun_merah_ai.md](daun_merah_ai.md).

---

## 1. Infrastruktur Inti

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **Vercel** | Hosting serverless functions (`api/*.js`) + static frontend + 1 cron bawaan (`gdpnow`) | Hobby (gratis) | — |
| **GitHub Actions** | Cron scheduler pengganti — dipindah dari `vercel.json` karena Vercel Hobby plan tidak menjamin >1 cron/hari jalan konsisten (lihat §2) | Gratis (public repo) | `secrets.CRON_SECRET` (GitHub Secrets) |
| **Upstash Redis** | Database cache utama — REST API (bukan koneksi TCP langsung), dipakai HAMPIR SEMUA endpoint (`api/*.js`) untuk cache, rate limit counter, circuit breaker state, jatah harian AI | Free tier | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |

### Cron aktif di GitHub Actions (`.github/workflows/`)

| Workflow | Jadwal | Yang dipanggil |
|---|---|---|
| `market-digest.yml` | 07:00, 14:00, 19:30 WIB | Generate Ringkasan Berita penuh + Analisa AI XAU/USD |
| `ohlcv-sync.yml` | Tiap jam | Sinkron candle OHLCV (H1/H4/D1) untuk semua pair terlacak |
| `ta-warm.yml` | Tiap jam | Pre-warm cache indikator teknikal 8 pair utama |
| `retail-sentiment-warm.yml` | Tiap 15 menit | Paksa refresh cache retail sentiment (COT-adjacent) |
| `btc-sync.yml` | **Nonaktif** (schedule dimatikan 2026-06-22) | Riset BTC ML — diasingkan ke folder gitignored, `workflow_dispatch` manual saja kalau mau diaktifkan lagi |
| `btc-backfill.yml` | Manual (`workflow_dispatch`) | Backfill data historis BTC (riset, sama nasibnya dengan `btc-sync.yml`) |
| `test-deribit.yml` | Manual (`workflow_dispatch`) | Diagnostik koneksi Deribit API (BTC options), bukan fitur produksi |

Semua workflow di atas autentikasi ke `api/*.js` lewat header `x-cron-secret`, dicocokkan ke `CRON_SECRET` di kode (`api/_app_key.js`, `api/_ratelimit.js` — whitelist otomatis, tidak kena rate limit per-IP).

---

## 2. AI Providers (ringkas — detail penuh di [daun_merah_ai.md](daun_merah_ai.md))

| Provider | Env var | Tier |
|---|---|---|
| OpenRouter | `OPENROUTER_API_KEY` | Free (persisten) |
| Cerebras | `CEREBRAS_API_KEY` | Free (persisten) |
| SambaNova (2 akun terpisah) | `SAMBANOVA_API_KEY`, `SAMBANOVA_API_KEY_CALL1` | Free (persisten) |
| Groq | `GROQ_API_KEY` | Free (persisten) |
| Ollama Cloud | `OLLAMA_API_KEY` | Free |

---

## 3. Data Makro & Bank Sentral

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **FRED (Federal Reserve Economic Data, St. Louis Fed)** | Sumber data utama seri makro AS (yield, inflasi, GDPNow, labour market rule-based, dll) — dipakai di `real-yields.js`, `risk-regime.js`, `_labour_market.js`, `admin.js` | Free (API key wajib) | `FRED_API_KEY` |
| **ECB Data API** (`data-api.ecb.europa.eu`) | Yield Eropa + suku bunga acuan ECB | Free, tanpa API key | — |
| **Bank of England, Bank of Japan, Bank of Canada, RBA, RBNZ, SNB** (situs resmi masing-masing) | Suku bunga acuan live per bank sentral non-Fed/ECB (`_cb_rates.js`) | Free, scraping halaman publik | — |
| **CFTC** (`cftc.gov`) | Commitment of Traders (COT) — positioning institusional | Free, file publik | — |
| **CME Group** (`cmegroup.com`) | FedWatch Tool (probabilitas keputusan FOMC) + CVOL (implied volatility FX) — via `rate-path.js`, `correlations.js` | Free, tapi **diblokir Akamai WAF untuk IP Vercel** → wajib lewat proxy ScraperAPI (lihat §5) | — |
| **Barchart OnDemand** | Fallback sumber risk-reversal FX kalau CME CVOL gagal | Free (signup manual) | `BARCHART_API_KEY` |
| **Polymarket (Gamma API)** | Data prediction market untuk sinyal sentimen | Free, publik | — |

---

## 4. Data Harga & Teknikal

| Vendor | Fungsi | Tier |
|---|---|---|
| **Yahoo Finance** (`query1.finance.yahoo.com`, tidak resmi/unofficial) | Sumber utama candle OHLCV semua pair FX + XAU/USD | Free, tanpa API key (endpoint publik tidak resmi) |
| **Binance API** | Fallback harga (PAXG untuk proxy XAU, dan referensi crypto) | Free, publik |
| **Stooq** | Data VIX/index tambahan (`risk-regime.js`) | Free, publik |
| **TradingView** (`economic-calendar.tradingview.com`) | Kalender ekonomi (alternatif/tambahan) | Free, endpoint publik tidak resmi |

---

## 5. Proxy

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **ScraperAPI** | Proxy residential IP — dipakai KHUSUS untuk fetch CME (FedWatch + CVOL) karena CME memblokir IP datacenter Vercel lewat Akamai WAF | **Berbayar** (satu-satunya vendor berbayar murni di app ini) | `SCRAPER_API_KEY` |

---

## 6. Berita & RSS

| Vendor | Fungsi | Tier |
|---|---|---|
| **FinancialJuice** (`financialjuice.com`) | Sumber RSS berita utama untuk headline real-time | Free, RSS publik |
| **ForexFactory data mirror** (`nfs.faireconomy.media`) | Kalender ekonomi high-impact (format XML ala ForexFactory) | Free, publik |
| **InvestingLive** (`investinglive.com`) | RSS berita tambahan | Free, publik |
| **ActionForex** (`actionforex.com`) | RSS analisis teknikal tambahan | Free, publik |
| **ForexBenchmark** (`forexbenchmark.com`) | Sumber tambahan (kemungkinan data benchmark rate) | Free, publik |
| **ING Think** (`think.ing.com`) | RSS riset makro tambahan | Free, publik |
| **rss2json** (`api.rss2json.com`) | Proxy konversi RSS→JSON untuk feed yang butuh parsing khusus | Free, publik |
| **Federal Reserve, ECB, BIS press release feeds** | RSS resmi rilis kebijakan bank sentral | Free, publik |

---

## 7. Notifikasi

| Vendor | Fungsi | Tier | Env var |
|---|---|---|---|
| **Telegram Bot API** | Kirim notifikasi/alert ke channel/chat admin | Free | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| **Web Push (VAPID)** | Push notification browser (thesis alert, dll) — standar Web Push, bukan layanan pihak ketiga berbayar, tapi butuh key pair VAPID sendiri | Free (protokol terbuka) | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` |

---

## 8. Ringkasan Env Var (semua vendor)

```
# AI Providers
OPENROUTER_API_KEY
CEREBRAS_API_KEY
SAMBANOVA_API_KEY
SAMBANOVA_API_KEY_CALL1
GROQ_API_KEY
OLLAMA_API_KEY

# Data
FRED_API_KEY
BARCHART_API_KEY
SCRAPER_API_KEY

# Infra
UPSTASH_REDIS_REST_URL
UPSTASH_REDIS_REST_TOKEN
CRON_SECRET
APP_KEY

# Notifikasi
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
```

**Catatan:** daftar env var di `daun_merah.md § Environment` (blok lama) sudah tidak lengkap — tidak menyebut `SCRAPER_API_KEY`, `BARCHART_API_KEY`, `APP_KEY`, atau env var AI selain `GROQ_API_KEY`. File ini (§8 di atas) adalah daftar terlengkap saat ini, disusun langsung dari grep `process.env.*` di seluruh `api/*.js`.

---

## 9. Satu-satunya Vendor Berbayar

Dari semua vendor di atas, **hanya ScraperAPI** yang murni berbayar (proxy residential untuk bypass blokir CME). Semua vendor lain — termasuk semua AI provider — beroperasi di tier gratis persisten (bukan trial credit). Kalau suatu saat ScraperAPI tidak tersedia/kena limit, fallback-nya adalah fetch langsung ke CME tanpa proxy (`cmeFetch()` di `rate-path.js`/`correlations.js`), yang kemungkinan besar diblokir WAF — jadi fitur FedWatch/CVOL akan otomatis jatuh ke sumber fallback berikutnya (Barchart untuk CVOL) atau kosong dengan graceful degradation, bukan crash.
