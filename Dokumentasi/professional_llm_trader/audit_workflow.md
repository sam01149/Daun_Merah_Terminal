# Professional LLM Trader — Workflow Audit Setup

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : SOP/checklist hidup untuk MENGAUDIT satu setup auto-entry (atau manual Analisa AI)
           yang dicurigai bermasalah — bukan sekadar kena SL, tapi ada indikasi proses/reasoning
           cacat. Referensi cepat: field mana yang harus dicek, di mana lihatnya, pola bug yang
           SUDAH PERNAH ketahuan (supaya tidak menemukan ulang dari nol).
BOLEH    : Langkah audit, daftar field & artinya, checklist konsistensi, pola bug historis (link
           ke changelog.md folder ini / daun_merah.md). Update in place (bukan changelog per-sesi)
           — WAJIB direvisi begitu ada kelas bug baru ditemukan atau field baru ditambah ke
           dev-auto-entry.html.
DILARANG : Hasil audit satu setup spesifik (-> changelog.md folder ini kalau jadi bugfix, atau
           riset.md kalau observasi murni). Plan perbaikan aktif (-> plan.md folder ini).
FORMAT   : Checklist bernomor + tabel field. Bukan naratif per-sesi.
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Dibuat:** 2026-08-10 (Session 302, sama sesi dengan bugfix [[project-currency-strength-cot-source-leakage-bug]]), diminta user setelah 2 kali audit ad-hoc (EUR/GBP currency-strength-as-evidence, CHF/JPY alignment-vs-entry-inconsistency) menemukan bug nyata dengan cara baca manual satu-per-satu — supaya proses itu terulang lebih cepat & tidak ada langkah kelewat.

---

## 0. Kapan audit dilakukan (filter dulu, jangan audit semua SL)

**Kena SL sendirian BUKAN trigger audit.** Lihat [[feedback-sl-tp-emotional-bias-reminder]] (memori Claude) — sistem yang jalan sesuai desain tetap akan kena SL secara alami (itu bagian dari edge statistik, bukan bug). Audit layak dilakukan HANYA kalau ada salah satu sinyal cacat proses nyata:

- Reasoning di `Alasan Makro Alignment` / commentary kelihatan **kontradiktif** atau **tidak masuk akal** saat dibaca manual (bukan cuma "saya rugi jadi pasti salah").
- Ada **pola berulang** lintas beberapa setup (bukan satu kejadian acak) — mis. beberapa setup pair yang sama semua mengutip sumber data yang sama secara aneh.
- **Mekanisme yang kentara tidak jalan** — field yang menurut dokumentasi/prompt seharusnya berperilaku tertentu (mis. "kalau X maka Y") tapi hasil aktualnya tidak konsisten dengan itu.
- User (atau AI) langsung merasa "ini aneh" saat baca ringkasan eksekutif — insting itu valid sebagai pemicu, tapi WAJIB ditindaklanjuti dengan langkah 1-4 di bawah sebelum disimpulkan bug beneran (jangan asumsi tanpa verifikasi kode).

## 1. Ambil data setup

**Sumber utama (tanpa akses production langsung):** `dev-auto-entry.html` → tab riwayat setup → klik baris setup yang dicurigai → panel detail expand otomatis menampilkan semua field lewat `buildSetupDetail()`. Field terkelompok:

| Kelompok | Field kunci | Kegunaan untuk audit |
|---|---|---|
| Ringkasan | Ringkasan Eksekutif, Kenapa Status Ini Terjadi, Kenapa Bisa SL | Narasi otomatis — titik awal baca cepat |
| Makro & Konflik | Makro Alignment (mentah), Alasan Makro Alignment, Conflict, Catatan Conflict, **Sumber Conflict**, **Sistem Hakim** | Inti audit reasoning — lihat §3 |
| Parameter Trade | Risk/Reward, Horizon, **Model** | Cek model AI yang dipakai (beberapa model lebih rawan salah nalar dari yang lain) |
| Label Hasil | Loss Label, TP Label | Kalau sudah closed — apakah loss/TP sudah dilabeli otomatis dengan benar |
| Invalidasi Teknikal | Trigger AI, Tersentuh | Cek `invalidation_trigger` terstruktur konsisten dengan narasi |
| Intervensi Posisi | Jenis, Alasan, SL Baru | Kalau ada tighten-SL/close reaktif berita — apakah alasannya masuk akal |
| Anomali Data | Breach Tidak Terkonfirmasi | Divergence hold GC=F/XAU — breach terdeteksi tapi tidak dikonfirmasi spot |

**Kalau butuh data mentah di luar yang dirender** (jarang perlu): `GET /api/admin?action=redis-keys&key=setup_log_auto:v1` (header `x-admin-secret: <CRON_SECRET>`) memberi metadata TTL/existence, BUKAN isi array — untuk isi mentah, satu-satunya jalur terdokumentasi adalah dashboard di atas. Kalau perlu mutasi (override data korup), pakai tab "Setup Override" (`dev-auto-entry.html`) dengan `data_fix` + reason wajib, JANGAN pernah timpa data mentah tanpa jejak (prinsip U-5a).

## 2. Cek konteks call: manual vs auto

Field **Sumber** di tabel utama (kolom `source`) menentukan gate mana yang berlaku:

- **`source: auto`** — lewat cron terjadwal ATAU tombol "Trigger Analisa Manual (auto=1)" di dashboard (server anggap identik). Lolos Gate D/B (audit-guard korelasi/drawdown) → Gate A (AI Kritikus, `_runCriticVerdict`) SEBELUM disimpan permanen sebagai live. Kalau setup ini status `canceled` dengan `canceled_reason: gate_critic_veto` atau `gate_<nama>`, itu justru gate BEKERJA sesuai desain (lihat ghost-tracking `_evaluateCanceledGhost`) — bukan bug.
- **`source: manual`** — dari tombol "Analisa AI" biasa (index.html atau dev dashboard tanpa `auto=1`). **Gate A/D/B TIDAK PERNAH jalan untuk jalur ini** (`ohlcvAnalyzeHandler`, cek `needsGateA = autoGuardConsidered && !autoGuardReason` — `autoGuardConsidered` selalu `false` kalau `isAutoCall` false). Kalau setup manual punya `makro_alignment:"konflik"` tapi tetap tampil entry/SL/TP lengkap, TIDAK ADA lapis kode apa pun yang akan menahannya — murni tanggung jawab pembaca dashboard untuk waspada.

## 3. Checklist konsistensi reasoning (inti audit)

Jalankan SEMUA poin berikut terhadap `Alasan Makro Alignment` + field terkait. Tiap poin merujuk kelas bug yang SUDAH PERNAH ditemukan nyata di proyek ini — kalau kena salah satu, itu bukan spekulasi, itu pola berulang yang sudah punya preseden fix.

### 3a. Alignment vs Entry — konsisten?
**DICOBA lalu DIREVERT Session 303 (2026-08-10) — BUKAN bug yang perlu difix, ini keputusan desain.** `Makro Alignment (mentah) = "konflik"` TIDAK membuat `entry_zone/sl/tp` di-null-kan otomatis — instruksi prompt (`entryZoneInstr`, `api/admin.js`) memang minta itu, tapi TIDAK code-enforced. Sempat dicoba tambah gate keras `makro_conflict` (auto-reject sebelum Gate A dipanggil), TAPI dibatalkan setelah disadari: `CRITIC_SYSTEM_PROMPT` (Gate A/AI Kritikus) SUDAH secara eksplisit diminta "fokus konflik makro" sebagai salah satu 4 hal wajib ditimbang, dan `makro_alignment`/`makro_alignment_reason` SUDAH dikirim ke Gate A sebagai fakta lewat `criticSetupBlock` (Fase 2, `ohlcvAnalyzeHandler`). Gate keras itu MENIMPA keputusan Gate A yang sudah menimbang info yang SAMA, bukan mengisi kekosongan — dan berisiko memperlambat laju entry (preseden Gate E: hard block pernah bikin nol entry hari pertama, dilonggarkan jadi observasi non-blocking, lihat [[gate-e-loosened-critic-veto-gap]]).

**Kesimpulan untuk audit:** kalau ketemu setup `source:auto` dengan `makro_alignment:"konflik"` tapi tetap `pending`/`open`, itu KEMUNGKINAN BESAR berarti Gate A SUDAH menimbang info itu dan memutuskan verdict `tunda`/`lanjut` (bukan celah yang belum tertangani) — BUKAN otomatis bug. Untuk verifikasi, tidak ada field per-setup yang merekam objection Gate A saat verdict bukan `batalkan` (celah observability terpisah, lihat `progress.md` folder ini kalau mau dibangun) — proxy terdekat: cek `confidence` (biasanya "rendah" untuk kasus begini) dan pola historis `auto_guard_stats:critic_veto` vs `saved` secara agregat, bukan per-setup.

### 3b. Reasoning kontradiktif arah — mata uang yang sama disebut menguat DAN melemah?
Baca `Alasan Makro Alignment` kata per kata — kalau ada currency code yang sama disebut "menguat" di satu klausa dan "melemah" di klausa lain TANPA jeda "terhadap/vs" yang jelas, itu tanda AI salah nalar arah base/quote. Guard kode (`_detectAlignmentReasonContradiction`, Session 301) sudah otomatis mengoreksi pola ini ke `konflik` + prefix `[CEK KONTRADIKSI]` — TAPI ini heuristik regex jarak-kata, bukan pemahaman makna penuh, jadi PARAFRASE lain (tidak pakai kata persis "menguat/melemah") bisa lolos. Kalau `Sumber Conflict` BUKAN `contradiction_guard` tapi reasoning-nya tetap kelihatan kontradiktif ke mata manusia, itu kandidat kuat celah baru di regex — laporkan dengan kutip teks persis.

**Update (audit end-to-end 2026-08-16, lihat §5 baris Session 316 lanjutan):** kalau `conflict` setup ini sudah `'waktu'` SEBELUM guard jalan, `Sumber Conflict` (`conflict_source`) SEBELUM fix di atas selalu `null` walau guard beneran aktif (guard sengaja tidak menimpa `conflict:'waktu'` jadi `'arah'`, tapi lama field `conflict_source` cuma diisi kalau `conflict==='arah'`) — SUDAH DIFIX, cek versi kode sebelum menyimpulkan "bug lama" kalau ketemu pola ini lagi. **Celah TERPISAH yang MASIH TERBUKA:** guard cuma mengoreksi field terstruktur (`makro_alignment`/`makro_alignment_reason`/`conflict`) — paragraf `commentary` (narasi bebas yang jadi "Ringkasan Eksekutif"/KESIMPULAN di dashboard) DITULIS SEBELUM koreksi ini dan TIDAK PERNAH disentuh guard manapun. Kalau ketemu setup dengan `makro_alignment_reason` berprefix `[CEK KONTRADIKSI]`/`[SISTEM HAKIM]` TAPI `commentary`-nya masih bilang "konflik tidak terdeteksi"/"searah" secara eksplisit (contoh nyata: `CHFJPY=X:1786436246374`), itu BUKAN bug baru untuk dilaporkan ulang — sudah tercatat di sini sebagai keputusan desain yang menunggu user (opsi: regenerasi commentary, tempel catatan koreksi, atau biarkan dengan syarat auditor selalu baca field terstruktur juga, bukan cuma commentary).

### 3c. Sumber bukti salah kategori — price-derived dikutip sebagai fundamental?
Cek apakah `Alasan Makro Alignment` mengutip **ranking currency strength** (pola teks "currency terkuat #N", "rezim volatilitas") sebagai bukti searah/konflik — itu data teknikal (turunan %perubahan harga), BUKAN fundamental catalyst, sama pola bug headline "Currency Strength Chart" (Session 152) yang baru diperluas fix-nya ke jalur ini di Session 302 (commit `d499a71`). Kalau masih lolos SETELAH commit itu, prompt-nya belum cukup kuat — perlu diperkuat lagi atau ditambah guard kode (pola sama `_detectAlignmentReasonContradiction`).

**Perluasan cek (audit end-to-end 2026-08-16):** larangan Session 302 SETELAH dicek ulang cuma menutup jalur `makro_alignment_reason` (field terstruktur) — cek JUGA paragraf `commentary` (narasi bebas paragraf "integrasi"), pola yang sama masih bisa lolos di situ karena bukan jalur yang sama yang dilarang di prompt. Contoh nyata lolos: `CHFJPY=X:1786436246374` — `commentary` menulis "...JPY muncul sebagai currency terkuat hari ini... Konteks makro mendukung skenario ini..." padahal `makro_alignment_reason` setup yang sama bersih dari pola ini. Kalau ketemu lagi setelah tanggal ini, ini pola BERULANG (bukan cuma n=1) — layak eskalasi ke bugfix (perluas larangan prompt ke seluruh output, bukan cuma bagian JSON terstruktur).

### 3d. Data basi — kesimpulan berdiri di atas data kedaluwarsa?
Cek umur data yang dikutip: `bias CB ... update Nj lalu` (cb_bias), `COT ... laporan N hari lalu` (Session 302, sebelumnya cuma label generik "mingguan" tanpa angka), umur `KONTEKS MAKRO (dari Ringkasan Nj lalu)`. Horizon trading sistem ini cuma ~3 hari (`time_horizon_days`) — kalau data pendukung alignment lebih basi dari itu (terutama COT yang bisa lag berhari-hari), pertimbangkan apakah kesimpulannya masih valid saat setup benar-benar dieksekusi.

### 3e. Gate A (Kritikus) — kalau `source:auto`, apa verdictnya?
Kalau conflict jelas tapi setup TETAP `pending`/`open` (bukan `canceled`), itu berarti AI Kritikus (call AI KEDUA, terpisah, `_runCriticVerdict`) sudah mengevaluasi ULANG fakta yang sama dan memutuskan verdict `tunda`/`lanjut`, BUKAN `batalkan` — Kritikus memang dirancang "skeptis tapi tidak memblokir kecuali keberatan fundamental", jadi ini KEPUTUSAN AI YANG SAH, bukan otomatis bug. Untuk lihat alasannya, cek counter `auto_guard_stats:critic_veto` (frekuensi murni, bukan per-setup) — detail objection per-setup saat ini TIDAK disimpan ke `setup_log_auto:v1` kalau verdict-nya bukan `batalkan` (celah observability, catat di `progress.md` folder ini kalau ingin dibangun).

## 4. Eskalasi temuan

- **Satu kejadian, tidak jelas polanya:** catat di `riset.md` folder ini sebagai observasi, jangan buru-buru ubah kode.
- **Pola berulang atau cacat mekanisme jelas (bukan cuma hasil buruk sesekali):** ini bugfix — ikuti alur normal proyek: perbaiki kode, tambah test regresi, `npm test` 100% hijau, tulis changelog. **Routing dokumentasi:** kalau perbaikannya di logika/prompt yang SAMA dipakai manual+auto (mis. `ohlcvAnalyzeHandler`, `_formatFundamentalBlock`, `_pair_context.js`) → `daun_merah.md` (preseden Session 301/302, dianggap infra bersama walau soal keputusan trading). Kalau eksklusif auto-entry (Gate A-E, `setup_log_auto:v1` khusus, Track 1-3) → `changelog.md` folder ini.
- **Butuh keputusan desain/trade-off** (bukan sekadar "kode salah vs benar", ada beberapa opsi valid dengan konsekuensi beda) — mis. kasus 3a di atas — JANGAN diputuskan sepihak, tulis opsi + rekomendasi ke user dulu.

## 5. Pola bug historis (referensi cepat)

| Sesi | Bug | Fix |
|---|---|---|
| 152 (`daun_merah.md`) | Headline "Currency Strength Chart" salah dibaca sebagai bukti kontradiksi thesis | Instruksi eksplisit "abaikan, price-derived bukan fundamental" — waktu itu HANYA di `checkThesisContradictions` (`market-digest.js`) |
| 301 (`daun_merah.md`) | Reasoning kontradiktif arah (mata uang sama disebut menguat+melemah) lolos jadi `makro_alignment:"searah"` | Guard kode `_detectAlignmentReasonContradiction`, independen dari Sistem Hakim |
| 302 (`daun_merah.md`) | (a) Currency strength ranking dikutip sebagai bukti makro_alignment — pola sama Sesi 152, baru diperluas ke `ohlcvAnalyzeHandler`. (b) Catatan staleness COT cuma muncul kalau `hasCmeData` — pair tanpa CME tidak dapat peringatan | (a) Larangan eksplisit di prompt (dua lapis). (b) Catatan dasar staleness selalu muncul + umur laporan konkret dalam hari |
| 303 (`changelog.md` folder ini) | `makro_alignment:"konflik"` tidak menghasilkan entry_zone null — TERNYATA BUKAN bug, Gate A (AI Kritikus) memang sudah menimbang info ini secara case-by-case by design (lihat §3a) | TIDAK ada — gate keras sempat dicoba lalu DIREVERT. Commentary AI (terpisah, tetap dipertahankan) sekarang disimpan ke setup_log |
| 303 (`changelog.md` folder ini) | Commentary AI (penjelasan "kenapa bias tetap X walau makro konflik") TIDAK PERNAH disimpan ke `setup_log_auto:v1` — hilang permanen begitu response dibalas, tidak ada penonton live saat cron jalan | `commentary` ditambah ke `buildNewSetupEntry`, ditampilkan di dashboard (`fldLong`) |
| 316 lanjutan (`daun_merah.md`) | `conflict_source` ("Sumber Conflict") jatuh diam-diam ke `null` kapan pun Sistem Hakim/guard kontradiksi aktif pada setup yang `conflict`-nya SUDAH `'waktu'` sebelum guard jalan (guard sengaja mempertahankan `'waktu'`, tidak ditimpa `'arah'` — tapi field `conflict_source` lama cuma diisi kalau `conflict==='arah'`) — jejak audit "siapa yang menandai" hilang padahal `makro_alignment_reason` sudah membawa prefix `[CEK KONTRADIKSI]`/`[SISTEM HAKIM]`. Ditemukan dari setup live nyata `CHFJPY=X:1786436246374` | `conflict_source` sekarang diprioritaskan dari flag guard (independen dari nilai akhir `conflict`), fallback ke `'ai'`/`null` kalau tak ada guard aktif — 2 lokasi (`buildNewSetupEntry` + refine-in-place) |
| 316 lanjutan (BELUM DIFIX — lihat §3b/§3c) | (a) `commentary` (narasi bebas) tidak ikut dikoreksi saat guard mengubah `makro_alignment` terstruktur — pembaca yang cuma baca commentary bisa dapat kesimpulan berlawanan dari field resmi. (b) Larangan "currency strength bukan fundamental" (Session 302) cuma menutup `makro_alignment_reason`, `commentary` masih bisa mengutip pola yang sama. Sample n=1 tiap poin (`CHFJPY=X:1786436246374`) — dicatat sebagai observasi/keputusan desain, BUKAN dieksekusi sepihak | TIDAK ADA — perlu keputusan user (opsi tercatat di §3b) sebelum eksekusi |
| 318 lanjutan (BELUM DIFIX — butuh keputusan user, lihat `riset.md` folder ini §Audit menyeluruh 2026-08-18 poin A1) | Gate D (`correlation_cap`) cuma menghitung partner ber-`status:'open'`, sehingga dua setup korelatif yang sama-sama masih `pending` (limit order belum kesentuh) lolos cap dan bisa fill bersamaan — padahal `pending` justru state terlama di sistem berbasis limit order zona konfluensi. Kelas bug baru: **cakupan gate vs siklus hidup setup** (bukan salah hitung korelasi) — saat mengaudit gate lain, cek juga status apa saja yang dia lihat | TIDAK ADA — opsi (hitung pending / hitung pending muda saja / counter observasi dulu) menunggu keputusan user |
