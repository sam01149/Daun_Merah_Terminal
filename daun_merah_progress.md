# DAUN MERAH — PROGRESS & STATUS

> **Last updated:** 2026-04-26
> **Branch:** main — semua deployed ke production

---

## STATUS SEMUA FITUR

```
Task 1   ✅  Risk Regime Indicator          commit a3baa1e
Task 2   ✅  Real Yield Differential        commit bd16d06 + 80030ce
Task 3   ✅  Rate Path Expectations         commit 022dc40 (SOFR heuristic)
Task 4   ✅  Position Sizing Calculator     commit 9e5f7fa
Task 5   ✅  Trade Journal                  commit 022dc40
Task 6   ✅  Structured Trade Thesis AI     commit 022dc40
Task 7   ✅  Regime Gate di Checklist       commit 022dc40
Task 8   ✅  Configurable Playbooks (4)     commit 022dc40
Task 9   ✅  Cross-Asset Correlations       commit 022dc40
Task 10a ✅  Branding Consistency           commit 022dc40
Task 10b ✅  CFTC Parser Robustness         commit 022dc40
Task 10c ✅  RSS Cache to Redis             commit bd16d06
Task 10d ✅  Calendar Refetch 60min         commit bd16d06
Task 10e ✅  Prompt Externalization         commit 022dc40
Task 10f ✅  Health Monitoring              commit 658a1a6
Task 10g ✅  Redis Key Registry             commit 658a1a6
Task 10h ✅  Rate Limiting                  commit 658a1a6

[POST-TASK UPDATES]
FIX      ✅  Vercel 12-function limit       commit 95db702
FIX      ✅  Mobile bottom nav + SVG icon   commit 108ffab
FIX      ✅  market-digest RSS URL broken   commit 6f48bcb
FEAT     ✅  Tab PETUNJUK (SOP)             commit b1729e9
FEAT     ✅  Prompt XAUUSD scalping         (termasuk dalam session konsolidasi)
```

---

## FITUR YANG ADA DI APLIKASI

### 8 Tab Utama
1. **NEWS** — FinancialJuice RSS real-time, filter per kategori, auto-refresh
2. **RINGKASAN** — AI market digest (Bahasa Indonesia) + XAUUSD scalping lens + AI thesis card + Cross-asset correlations
3. **CAL** — Economic calendar + CB tracker (8 currencies) + Real yields + Rate path USD
4. **COT** — CFTC positioning: Leveraged Funds + Asset Manager net untuk 7 pairs
5. **CHECKLIST** — 4 playbook dengan REGIME CHECK gate (auto-tick dari live data)
6. **SIZING** — Position sizing calculator, hard block >2% risk
7. **JURNAL** — Trade journal CRUD, auto-snapshot makro, prefill dari AI thesis
8. **PETUNJUK** — SOP end-to-end, panduan penggunaan aplikasi

### Infrastructure
- PWA: installable, push notifications, service worker
- Icon: dual-leaf SVG (bear merah + bull teal)
- Mobile: fixed bottom nav 8 tombol (≤767px)
- Rate limiting: market-digest 4/min, correlations 5/min
- Health monitoring: probe 6 sumber eksternal, Telegram alert
- Admin: prompts updatable tanpa redeploy, Redis key registry

---

## TIDAK ADA TASK YANG TERTUNDA

Project feature-complete. Constraint utama yang harus dijaga:
- **Vercel Hobby: tepat 12 fungsi** di `api/` (kecuali prefix `_`)
- **Endpoint URLs yang benar:**
  - RSS → `/api/feeds?type=rss` (bukan `/api/rss`)
  - COT → `/api/feeds?type=cot` (bukan `/api/cot`)
  - Push → `/api/admin?action=push` (bukan `/api/push`)
  - Health → `/api/admin?action=health`

---

## CB RATES (Update Manual Setelah Meeting)

File: `api/cb-status.js`, object `CB_DATA`

| CB | Rate | Last Meeting | Decision |
|----|------|-------------|----------|
| Fed | 4.50% | 2026-03-19 | hold |
| ECB | 2.40% | 2026-03-06 | cut -25bps |
| BOE | 4.50% | 2026-02-06 | cut -25bps |
| BOJ | 0.50% | 2026-03-19 | hold |
| BOC | 2.75% | 2026-03-12 | hold |
| RBA | 4.10% | 2026-02-18 | cut -25bps |
| RBNZ | 3.50% | 2026-02-19 | cut -50bps |
| SNB | 0.25% | 2026-03-20 | cut -25bps |

---

## FOMC DATES HARDCODED (Update Tiap Awal Tahun)

File: `api/rate-path.js`

2026: May 7, Jun 18, Jul 30, Sep 17, Nov 5, Dec 17

---

## INFLATION EXPECTATIONS HARDCODED (Update Quarterly)

File: `api/real-yields.js`, object `INFLATION_EXPECTATIONS`

Source: ECB SPF, BoE IAS, BoJ Tankan — cek `as_of` field, update jika > 90 hari.
