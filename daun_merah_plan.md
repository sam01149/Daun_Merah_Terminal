# DAUN MERAH — SYSTEM CONTEXT & TASK PLAN

## CONTEXT
Daun Merah adalah forex news PWA untuk trader forex Indonesia. Stack: single `index.html` frontend + Vercel Serverless Functions di `api/` + Upstash Redis. Deployed di https://financial-feed-app.vercel.app.

**Semua fitur utama (Task 1-10) sudah selesai.** Sistem saat ini dalam fase **bug fix & stabilisasi** berdasarkan gap analysis tanggal 2026-04-27.

Baca `daun_merah.md` untuk full reference (stack, endpoints, Redis keys, fungsi JS kunci, known bugs).
Baca `daun_merah_handoff.md` untuk status fix terbaru dan apa yang masih perlu dikerjakan.
Baca `daun_merah_progress.md` untuk tracking semua tasks.

---

## ROLE
Senior full-stack engineer. Kode production, bukan prototipe. Setiap perubahan kecil, testable, deployable independent. Tidak refactor yang tidak rusak. Tidak introduce framework baru.

---

## ABSOLUTE CONSTRAINTS

1. **No new npm dependencies.** Stack: vanilla JS frontend, Node.js Vercel functions, Upstash Redis REST, web-push.
2. **No build step.** Frontend tetap single `index.html` dengan inline JS.
3. **Vercel Hobby: TEPAT 12 serverless functions** di `api/` (prefix `_` tidak dihitung). Tambah file baru = hapus yang lain.
4. **Caching mandatory.** Setiap external API call harus Redis cache dengan explicit TTL.
5. **Cold-start safe.** Gunakan Redis untuk semua state yang perlu persist antar invocation. Tidak ada module-level cache.
6. **No silent failures.** Setiap fetch failure log ke console dengan context.
7. **Honest data.** Jika data tidak tersedia: tampilkan "unavailable". Jika heuristic/estimate: label jelas di UI.
8. **Mobile-first.** Setiap UI addition harus kerja di 380px viewport.
9. **Indonesian UI text, English code/comments/variables.**
10. **One feature per PR.** Tidak bundle perubahan tidak related.

---

## ENDPOINT URLS YANG BENAR

```
RSS:     /api/feeds?type=rss     (BUKAN /api/rss — sudah dihapus)
COT:     /api/feeds?type=cot     (BUKAN /api/cot — sudah dihapus)
Push:    /api/admin?action=push  (BUKAN /api/push — sudah dihapus)
Health:  /api/admin?action=health
```

---

## STATUS BUGS (2026-04-27)

### SELESAI (P0 + sebagian P1-P3)
| # | File | Bug | Status |
|---|------|-----|--------|
| P0-1 | `sw.js` | FETCH_URL Netlify endpoint mati | ✅ Fixed |
| P0-2 | `index.html` | rc4: `ev.impact !== 'high'` lowercase | ✅ Fixed |
| P0-3 | `index.html` | rc4: `ev.datetime` undefined → NaN | ✅ Fixed |
| P0-4 | `api/calendar.js` | convertToWIB: UTC asumsi salah (seharusnya EST/EDT) | ✅ Fixed |
| P0-5 | `api/rate-path.js` + `index.html` | Rate path heuristic tidak honest di UI | ✅ Fixed |
| P1-1 | `api/_ratelimit.js` | INCR/EXPIRE race condition → orphan keys | ✅ Fixed |
| P1-2 | `api/subscribe.js` | Push endpoint base64 slice(0,80) collision risk | ✅ Fixed |
| P2-1 | `api/market-digest.js` | digest_history read-modify-write race condition | ✅ Fixed |
| P2-2 | `api/feeds.js` | rssMemCache module-level violates cold-start constraint | ✅ Fixed |
| P3-1 | `index.html` | _lastThesis tidak persist → tombol jurnal fail | ✅ Fixed |

### BELUM DIFIX
| # | File | Bug | Priority |
|---|------|-----|----------|
| P1 | `index.html` | Pip value cross-pair error 10-30% | High |
| P1 | `api/cb-status.js` | CB rates stale, perlu update manual | High |
| P1 | `api/real-yields.js` | Inflation expectations >90 hari stale | Medium |
| P2 | `api/market-digest.js` | cb_bias race condition (HGET-merge-HSET) | Medium |
| P2 | `api/market-digest.js` | Groq 3 calls no partial response handling | Medium |
| P2 | `sw.js` | Service Worker update flow tidak ada | Low |
| P3 | `index.html` | Checklist state tidak per-pair | Low |
| P3 | `api/journal.js` | N+1 Redis query (51 calls untuk 50 entries) | Low |
| P3 | `index.html` (PETUNJUK) | SOP stale, sebut 2 playbook padahal 4 | Low |

---

## TASK BERIKUTNYA (URUTAN PRIORITAS)

### TASK A: Update CB Rates (Manual, ~5 menit)
Update `api/cb-status.js` object `CB_DATA` dengan meeting terbaru:
- Cek ECB April 2026 (cycle 6 minggu dari 2026-03-06 → ekspektasi ~Apr 17)
- Cek BOE meeting terbaru
- Cek RBA, RBNZ jika ada meeting setelah Feb 2026

### TASK B: Fix Pip Value Cross-Pair
File: `index.html`, fungsi `calcPipValueUSD`
Opsi 1 (quick): tambah disclaimer UI untuk cross-pair bahwa nilai pip approximate.
Opsi 2 (proper): fetch USD/quote spot dari `/api/risk-regime` atau endpoint baru untuk konversi.
Rekomendasikan Opsi 1 dulu (non-breaking), Opsi 2 sebagai follow-up.

### TASK C: Update Real Yields
File: `api/real-yields.js`, object `INFLATION_EXPECTATIONS`
ECB SPF Q2 2026 biasanya release April. Cek dan update `EUR.value` + `as_of` jika sudah ada.

### TASK D: Fix Checklist State Per-Pair
File: `index.html`
`ckState` saat ini shared semua pair. Manual items (rc5, gates teknikal) carry over saat ganti pair.
Solusi: scope `ckState` ke `ckState[pairKey]` atau clear manual items saat pair change.

### TASK E: Fix Journal N+1 Query
File: `api/journal.js`
Pattern: ZRANGE → GET per-id = N+1 Redis calls.
Fix: ZRANGE → MGET untuk batch fetch semua entries sekaligus.

### TASK F: Update SOP/Petunjuk
File: `index.html`, section `petunjukPanel`
Update teks yang masih sebut "2 playbook (SMC/ICT atau Macro Momentum)" → daftar 4 playbook.

---

## CODE STYLE

1. Match existing style: indent 2 spaces, single quotes, CommonJS `module.exports`.
2. Comment the why, not the what. Hanya saat logic non-obvious.
3. Error messages di `console.warn/error` harus include context.
4. Redis keys ikuti konvensi existing: `snake_case`, prefix per domain.
5. No async/await di top-level event handlers — pakai `.then().catch()` atau wrapped IIFE.
6. Semua UI strings Bahasa Indonesia.

---

## OUTPUT FORMAT

Saat diminta mengerjakan task:
1. Baca file yang relevan. State file mana yang dibaca.
2. Identifikasi kode existing yang menyentuh area yang dimodifikasi.
3. Propose smallest viable change.
4. Show diff-style changes, bukan full file rewrite.
5. List Redis keys yang dibuat/dimodifikasi.
6. List external API endpoints yang dipanggil + rate limits.
7. State apa yang perlu manual testing sebelum deploy.
8. State apa yang bisa break di production dan cara detect.

---

## FORBIDDEN

- Jangan tambah tracking, analytics, atau telemetry tanpa approval
- Jangan tambah user authentication beyond device-id (sistem single-user / personal use)
- Jangan scrape sites yang block scraping tanpa test User-Agent strategy
- Jangan simpan API keys di code — Vercel env vars only
- Jangan tambah fitur di luar task list tanpa explicit approval
- Jangan violate 12-function limit Vercel Hobby
