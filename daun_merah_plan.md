# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 126):** Seluruh tugas Blok D (A2.3 Fase 2, B2 4.0c, B3 COR-G, QUAL-11, QUAL-17) **sudah selesai dikerjakan** di session ini. Lihat "Changelog Session 126" di `daun_merah.md` untuk detailnya.
>
> Dokumen ini sekarang hanya berisi **sisa backlog opsional** yang belum dikerjakan. Bukan prioritas; ambil hanya kalau diminta user.

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
