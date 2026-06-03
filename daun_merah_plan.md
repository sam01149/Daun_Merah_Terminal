# Daun Merah — Implementation Plan

> **Dibuat:** 2026-06-03
> **Status:** Backlog aktif — dikerjakan secara bertahap

---

## Prioritas 1 — Data Accuracy (HIGH VALUE, Gratis)

### 1.1 Cleveland Fed Inflation Nowcast
**Problem:** `api/real-yields.js` — inflation expectations 7 currency non-USD hardcoded manual.
EUR sudah stale >100 hari (as_of 2026-01-15), CHF >180 hari (as_of 2025-12-12).

**Solusi:** Fetch Cleveland Fed Inflation Nowcast — update otomatis bulanan, tanpa API key.
- Endpoint target: `https://www.clevelandfed.org` (scrape/CSV)
- Ganti object `INFLATION_EXPECTATIONS` dari hardcoded → live fetch
- Cache Redis `cleveland_inflation` TTL 24h
- Fallback ke nilai hardcoded lama jika fetch gagal

**File:** `api/real-yields.js`
**Effort:** Rendah | **Impact:** Tinggi — real yield semua currency lebih akurat

---

### 1.2 GDPNow Atlanta Fed
**Problem:** Tidak ada nowcast GDP real-time. AI hanya opini dari headline tanpa angka.

**Solusi:** Atlanta Fed GDPNow — estimasi GDP quarter berjalan, update setiap 1-2 hari kerja.
- Endpoint: `https://www.atlantafed.org` (scrape/CSV file publik)
- Simpan ke `fundamental:USD` Redis hash sebagai field `GDP Nowcast`
- Tampil di tab FUNDAMENTAL, card USD

**File:** `api/admin.js` (fundamental_refresh) + `index.html` (display)
**Effort:** Rendah | **Impact:** Tinggi — leading indicator USD fundamental

---

### 1.3 TGA + Fed Balance Sheet via FRED
**Problem:** Tidak ada indikator likuiditas USD sistemik. TGA drain/refill = driver besar cross-asset.

**Solusi:** Pakai `FRED_API_KEY` yang sudah ada. Tambah 2 series:
- `WTREGEN` — Treasury General Account balance (weekly)
- `WALCL` — Fed Total Assets / balance sheet (weekly)

Tampil di FUNDAMENTAL card USD sebagai `TGA Balance` dan `Fed Assets`.
TGA naik = serap likuiditas (bearish risk). TGA turun = inject likuiditas (bullish risk).

**File:** `api/real-yields.js` atau `api/admin.js`
**Effort:** Rendah | **Impact:** Medium-Tinggi — context macro USD lebih lengkap

---

## Prioritas 2 — Fix Data yang Broken (HIGH VALUE)

### 2.1 CME FedWatch — Rate Path Market-Implied
**Problem:** `api/rate-path.js` — CME endpoint tidak berfungsi. Saat ini pakai heuristic SOFR.
UI sudah jujur label "Estimasi" tapi data tidak akurat.

**Solusi:** Investigasi endpoint CME yang benar:
- Candidate 1: `https://www.cmegroup.com/markets/interest-rates/cme-fedwatch-tool.html` (scrape)
- Candidate 2: Futures settlement prices via CME FTP
- Candidate 3: Lihat implementasi OpenBB sebagai referensi

**File:** `api/rate-path.js` — replace heuristic logic
**Effort:** Medium (butuh investigasi endpoint dulu) | **Impact:** Tinggi — rate path jadi market-implied benar

---

## Prioritas 3 — Known Issues Existing (P1-P2)

### 3.1 CB Rates Update Manual (P1)
**Problem:** `api/cb-status.js` — `CB_DATA` terakhir diverifikasi 2026-05-05.
Beberapa CB kemungkinan sudah ada meeting baru.

**Action:** Cek kalender meeting CB dan update `CB_DATA` + `CB_FALLBACK`.
**File:** `api/cb-status.js`

---

### 3.2 Real Yields Inflation Stale (P1)
**Problem:** EUR (as_of 2026-01-15), CAD (2026-01-29), CHF (2025-12-12) — semua >90 hari.

**Action:** Akan resolved otomatis oleh item 1.1 (Cleveland Fed Nowcast).
Sebelum 1.1 selesai: update manual dari sumber resmi masing-masing CB.
**File:** `api/real-yields.js`

---

### 3.3 Groq Call Isolation (P2)
**Problem:** Call 1/2/3 sequential. Jika Call 1 timeout, Call 2 dan 3 skip seluruhnya.

**Solusi:** Independent try/catch per-call. Call 2 dan 3 tetap jalan meski Call 1 gagal.
**File:** `api/market-digest.js`

---

## Prioritas 4 — UX & Completeness

### 4.1 Checklist State Per-Pair
**Problem:** `ckState` shared semua pair. Manual items carry over saat ganti pair.
**Solusi:** Key localStorage per pair, e.g. `daunmerah_v2_EURUSD`.

### 4.2 Journal N+1 Query
**Problem:** ZRANGE + GET per-id = 51 Redis roundtrips untuk 50 entries.
**Solusi:** Ganti ke MGET batch.
**File:** `api/journal.js`

### 4.3 VIX Term Structure
**Problem:** Hanya VIX spot. Tidak bisa lihat backwardation/contango untuk sentiment.
**Solusi:** Tambah VIX1M, VIX3M dari Yahoo (`^VIX1M`, `^VIX3M`).
Tampil di tab COT atau FUNDAMENTAL.

---

## Urutan Pengerjaan yang Disarankan

```
[1] 1.3  TGA + Fed Balance Sheet  →  paling cepat, FRED sudah ada
[2] 1.1  Cleveland Fed Nowcast    →  fix EUR/CHF stale >90 hari
[3] 1.2  GDPNow Atlanta Fed       →  tambah card USD
[4] 2.1  CME FedWatch investigasi →  research endpoint dulu
[5] 3.1  CB Rates update manual   →  cek kalender meeting
[6] 3.3  Call isolation           →  robustness
[7] 4.x  UX polish                →  kapan sempat
```

---

## Constraint Tidak Berubah

- Vercel Hobby: TEPAT 12 serverless functions (prefix `_` tidak dihitung)
- No new npm dependencies
- Frontend tetap single `index.html`
- Setiap external call wajib Redis cache + explicit TTL
- Fallback ke nilai lama jika fetch gagal (no silent failures)
