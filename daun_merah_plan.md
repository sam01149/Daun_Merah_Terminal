# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 125):** Seluruh tugas Blok C (C1–C8 audit ketahanan & kualitas AI) **sudah selesai dikerjakan** — dihapus dari dokumen ini. Lihat "Changelog Session 125" di `daun_merah.md` untuk detailnya.
>
> Dokumen ini sekarang hanya berisi **sisa backlog opsional** (carry-over yang sengaja dilewati). Bukan prioritas; ambil hanya kalau diminta user.

---

# D. SISA BACKLOG OPSIONAL

- **[A2.3 Fase 2]** Preferensi kategori push per-user (perluas `push_subs` JSON dengan `categories[]` + UI checkbox). Fase 1 sudah beri 80% manfaat.
- **[B2 4.0c]** Lebih banyak titik swing untuk `ohlcv_analyze` (sekarang cuma 1 swing high + 1 low 4H + top-2 D1) → presisi entry/SL/TP lebih baik.
- **[QUAL-11]** Aturan penutup FX Call 1 dinyatakan 3× (Penutup FX + REMINDER FINAL + CEK SEKALI LAGI) + safety-net `_ensureConfirmasiTag` — over-engineered, boros budget prompt. Aturan **pembuka** ("DILARANG membuka dengan...") justru tanpa penegakan kode. Aksi: rampingkan penutup jadi 1× tegas; pertimbangkan validasi kalimat pembuka di kode. *(prompt + kode, review user)*
- **[QUAL-17]** `userMsg` `ohlcv_analyze` = satu template literal raksasa → pecah jadi array baris seperti `biasPrompt`/`thesisPrompt`. *(refactor maintainability, low-prio)*
- **[QUAL-2]** FRASA TERLARANG mungkin terlalu agresif (konektor normal ikut dilarang) → prosa bisa kaku. **Pantau dulu via `quality_flags` dari C8, jangan ubah tanpa keluhan nyata.**
- **[QUAL-3]** Penutup prosa Call 1 (strongest/weakest currency) bisa beda dari `strongest_currency`/`weakest_currency` Call 3 → selaraskan kalau tampil berdampingan. *(low-prio)*
- **[B3 COR-G]** Tambah BTC / gold-silver ratio / gold-copper ratio ke matriks korelasi (`correlations.js`) — debasement & stretch gauge.
- **[C5 DRAFT]** Bagian teks prompt di C5 (headline mentah ke thesisPrompt) masih berstatus **DRAFT, menunggu review user** sebelum dianggap final. Kode sudah di-push, tapi kualitas output perlu divalidasi live.
- **[C8 Tahap 2 — OPSIONAL]** Kalau `phraseHits.length` sering melewati ambang via log produksi, pertimbangkan satu AI call kecil "tulis ulang kalimat ini tanpa frasa berikut". Tunggu bukti severity nyata dari `provider_log` dulu.
