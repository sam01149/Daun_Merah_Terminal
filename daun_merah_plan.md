# Daun Merah — Plan Handoff (Sisa Backlog Opsional)

> **Status (2026-06-30, Session 126):** Seluruh tugas Blok D (A2.3 Fase 2, B2 4.0c, B3 COR-G, QUAL-11, QUAL-17) **sudah selesai dikerjakan** di session ini. Lihat "Changelog Session 126" di `daun_merah.md` untuk detailnya.
>
> Dokumen ini sekarang hanya berisi **sisa backlog opsional** yang belum dikerjakan. Bukan prioritas; ambil hanya kalau diminta user.

---

# E. SISA BACKLOG OPSIONAL

- **[QUAL-2]** FRASA TERLARANG mungkin terlalu agresif (konektor normal ikut dilarang) → prosa bisa kaku. **Pantau dulu via `quality_flags` dari C8, jangan ubah tanpa keluhan nyata.**
- **[QUAL-3]** Penutup prosa Call 1 (strongest/weakest currency) bisa beda dari `strongest_currency`/`weakest_currency` Call 3 → selaraskan kalau tampil berdampingan. *(low-prio)*
- **[C5 DRAFT]** Bagian teks prompt di C5 (headline mentah ke thesisPrompt) masih berstatus **DRAFT, menunggu review user** sebelum dianggap final. Kode sudah di-push, tapi kualitas output perlu divalidasi live.
- **[C8 Tahap 2 — OPSIONAL]** Kalau `phraseHits.length` sering melewati ambang via log produksi, pertimbangkan satu AI call kecil "tulis ulang kalimat ini tanpa frasa berikut". Tunggu bukti severity nyata dari `provider_log` dulu.
