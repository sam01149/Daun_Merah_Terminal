# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 126):** Seluruh tugas Blok D (A2.3 Fase 2, B2 4.0c, B3 COR-G, QUAL-11, QUAL-17) **sudah selesai dikerjakan** di session ini. Lihat "Changelog Session 126" di `daun_merah.md` untuk detailnya.
>
> **Status (2026-07-01, Session 134):** Section G (Session Strip di REGIME bar) dan penambahan Retail Sentiment mini-strip di dashboard **sudah selesai dikerjakan** — lihat "Changelog Session 134" di `daun_merah.md` untuk detailnya. Bagian yang sudah selesai dihapus dari dokumen ini. Sisanya (F, E) tetap **sisa backlog opsional** — bukan prioritas, diabaikan kecuali diminta user.
>
> **Status (2026-07-01, Session 135):** Fix kategorisasi berita `econ-data` vs `market-moving`/`indexes`/`macro`/`bonds` **sudah selesai dikerjakan & terverifikasi** — lihat "Changelog Session 135" di `daun_merah.md` untuk detailnya.
>
> **Status (2026-07-03, Session 140):** Thesis alert (headline kontra buy/sell limit di JURNAL/CHECKLIST/SIZING) yang sempat **ditunda** karena reliability sudah di-hardening dan **diaktifkan kembali** — lihat "Changelog Session 140" di `daun_merah.md` untuk detailnya. Bagian scenario/progress-nya dihapus dari dokumen ini.
>
> **Update workflow (`CLAUDE.md`):** Plan-first di dokumen ini sekarang HANYA dipakai kalau user eksplisit minta "buatkan plan" atau perintahnya ditujukan untuk AI lain (bukan eksekusi langsung). Untuk perintah eksekusi langsung, kerjakan → evaluasi mandiri → uji → update `daun_merah.md` → push, tanpa gate plan terpisah.
>
> **Status (2026-07-07, Session 145):** Plan "Re-arsitektur Distribusi Model AI per Fitur (Nemotron 3 Ultra + realokasi existing)" **sudah dieksekusi & dideploy** (gpt-oss:120b untuk journal/fundamental disumber dari Cerebras, bukan OpenRouter, per keputusan user saat eksekusi) — lihat "Changelog Session 145" di `daun_merah.md` untuk detail lengkap termasuk hasil tes live Nemotron 3 Ultra (belum 100% reliable, user pilih tetap primary + terus dipantau) dan follow-up investigasi NVIDIA NIM direct sebagai kandidat sumber alternatif. Bagian plan-nya dihapus dari dokumen ini.

---

# F. INFRASTRUKTUR

- **[INFRA-1] cron-job.org sebagai backup OHLCV sync**
  - **Masalah:** Vercel cron hourly (`30 * * * *`) tidak diizinkan di Hobby plan → dihapus session 130. Kalau GitHub Actions gagal 2-3 run berturut, data OHLCV bisa stale 2+ jam (penyebab "⚠ 2.8 jam lalu" di session 128).
  - **Solusi:** Daftarkan akun di [cron-job.org](https://cron-job.org) (gratis), buat job yang hit `https://financial-feed-app.vercel.app/api/admin?action=ohlcv_sync` tiap 30 menit. Request datang dari luar Vercel → tidak kena batasan Hobby plan.
  - **Cara setup:** Buat akun → New cronjob → URL endpoint → schedule `*/30 * * * *` → Save. Tidak perlu perubahan kode.

---

# E. SISA BACKLOG OPSIONAL

- **[QUAL-2]** FRASA TERLARANG mungkin terlalu agresif (konektor normal ikut dilarang) → prosa bisa kaku. **Pantau dulu via `quality_flags` dari C8, jangan ubah tanpa keluhan nyata.**
- **[C5 DRAFT]** Bagian teks prompt di C5 (headline mentah ke thesisPrompt) masih berstatus **DRAFT, menunggu review user** sebelum dianggap final. Kode sudah di-push, tapi kualitas output perlu divalidasi live.
- **[C8 Tahap 2 — OPSIONAL]** Kalau `phraseHits.length` sering melewati ambang via log produksi, pertimbangkan satu AI call kecil "tulis ulang kalimat ini tanpa frasa berikut". Tunggu bukti severity nyata dari `provider_log` dulu.