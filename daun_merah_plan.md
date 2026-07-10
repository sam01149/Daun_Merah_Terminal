# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Aturan dokumen ini (2026-07-10):** item yang statusnya sudah SELESAI langsung DIHAPUS dari dokumen ini — riwayat lengkap selalu ada di changelog `daun_merah.md`, jadi tidak perlu disimpan ganda di sini.
>
> **Update workflow (`CLAUDE.md`):** Plan-first di dokumen ini sekarang HANYA dipakai kalau user eksplisit minta "buatkan plan" atau perintahnya ditujukan untuk AI lain (bukan eksekusi langsung). Untuk perintah eksekusi langsung, kerjakan → evaluasi mandiri → uji → update `daun_merah.md` → push, tanpa gate plan terpisah.

## Ide mentah (belum dibahas/direncanakan)

- **Split fitur per branch** — masih ide mentah, belum ada plan.
- **Opsi B Plan K (build step minifikasi index.html)** — sengaja tidak dikerjakan; hanya kalau user minta eksplisit (infra change, deterrent bukan proteksi absolut).
- **Fase 2 Plan I (sparkline drift korelasi historis)** — hanya kalau user merasa chart COR-H Fase 1 kurang "storytelling"; butuh state Redis baru, jangan dikerjakan tanpa konfirmasi.

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
