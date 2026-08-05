# Daun Merah — Riset & Pembelajaran

```
=== ATURAN FILE INI (WAJIB PATUH — SOT: ATURAN.md di root) ===
TUJUAN   : Riset internal proyek — 3 jenis isi: (1) riset aktif, (2) pertanyaan terbuka &
           parkiran ide (belum layak jadi plan), (3) pembelajaran proyek terdistilasi.
BOLEH    : Riset aktif WAJIB tanggal + sumber URL/sesi; pembelajaran = satu prinsip + konteks
           satu baris + rujukan sesi (bukan cerita ulang). Pembelajaran berbentuk aturan
           perilaku universal → usulkan juga masuk ATURAN.md.
DILARANG : Changelog (-> daun_merah.md), kondisi-sekarang AI/vendor (-> daun_merah_ai.md /
           daun_merah_vendor.md), langkah eksekusi (-> daun_merah_plan.md), sitasi paper
           akademis (-> daun_merah_referensi_riset.md), pekerjaan tertunda non-riset
           (-> daun_merah_progress.md).
FORMAT   : Entri bertanggal per bagian (Riset Aktif / Pertanyaan Terbuka / Pembelajaran).
Entri yang melanggar = salah tempat, wajib dipindah.
```

> **Aturan hapus:** riset selesai / ide yang sudah dieksekusi / entri basi → hapus dari sini;
> riwayatnya cukup di changelog + git history. Isi lama dokumen ini (peta jalan "AI lebih
> pintar" session 166, sebagian besar sudah jadi fitur: Tier 1 = setup_log, Tier 4 = AI
> Kritikus) dihapus 2026-07-18 — masih bisa dibaca di git history (`daun_merah_riset_ai_pintar.md`).

---

## Riset Aktif

### [2026-08-05] Audit arah base/quote seluruh 23 setup `setup_log_auto:v1` — bug AUDNZD terkonfirmasi + bocor ke `intervention`, EUR/GBP bersih

Audit read-only atas permintaan user, lanjutan temuan bug penalaran arah base/quote di `makro_alignment_reason` pada `AUDNZD=X:1785849311337`. Data diambil langsung dari Redis produksi (Upstash REST, `.env.local`) — seluruh 23 entri (AUD/NZD 5, EUR/GBP 4, EUR/USD 6, GC=F 7, GBP/USD 1), bukan sampel.

**Bug asal dikonfirmasi ulang:** id `AUDNZD=X:1785849311337`, field `makro_alignment_reason`: *"Fundamental NZD Hawkish (real yield 2.36% vs AUD 1.63%) mendukung NZD, berlawanan dengan bias bearish AUD/NZD yang berarti NZD menguat"* — kontradiksi diri: kalimat sendiri mendefinisikan "bearish AUD/NZD = NZD menguat", lalu bilang "data yang mendukung NZD menguat" itu **berlawanan** dengan kesimpulan yang sama-sama berarti "NZD menguat". Secara matematis (base/quote), NZD hawkish yang mendukung NZD seharusnya **searah**, bukan berlawanan.

**Temuan baru — bug yang sama bocor ke `intervention.reason`, id trade yang SAMA:** field `intervention` pada id ini (`type: tighten_sl`, dibuat AI position-review setelah entry): *"Data tenaga kerja NZ Q2 (terkonfirmasi) jauh lebih kuat dari ekspektasi (+0.5% vs +0.2%), mendukung NZD dan **mengancam** bias bearish AUD/NZD... Untuk melindungi modal dari potensi breakout bullish lebih lanjut, SL diperketat..."* — kesalahan arah yang identik: data NZD kuat (mendukung NZD menguat) mestinya justru **menguatkan** tesis bearish AUD/NZD (bukan mengancamnya). Ini bukan cuma cacat narasi — field ini adalah justifikasi tertulis di balik keputusan **tighten_sl** riil pada posisi virtual berjalan. Kode (`validateTightenSl`) memvalidasi ARAH ANGKA SL baru (harus lebih ketat, tidak melewati zona entry) tapi TIDAK memverifikasi apakah alasan tekstualnya logis — jadi keputusan bisa "benar secara angka, salah secara nalar" tanpa terdeteksi.

**EUR/GBP=X (4 setup, prioritas audit karena cross pair sama seperti AUD/NZD) — SEMUA BERSIH, tidak ditemukan kontradiksi arah:** `1785744976162` (netral, penjelasan JPY-intervention/CB level konsisten), `1785312942388` (netral, COT squeeze EUR searah bullish dijelaskan benar), `1785244550821` (searah, "EUR tertekan + GBP stabil → EUR/GBP turun" — aritmetika benar), `1785140143104` (searah, "IFO kuat + ECB hawkish → EUR naik → EUR/GBP bullish" — benar). Tidak dipaksakan mencari masalah — memang tidak ada.

**GC=F (7), EUR/USD (6), GBP/USD (1) — screening cepat, semua bersih juga:** pola safe-haven vs real yield (GC=F) dan USD vs EUR/GBP (EUR/USD, GBP/USD) konsisten secara arah di semua `makro_alignment_reason`/`conflict_note` yang terisi (7 dari 14 entri di 3 simbol ini punya field kosong/undefined — tak ada reasoning untuk dicek).

**`sistem_hakim` null/undefined di 21 dari 23 setup** — terkonfirmasi sesuai desain (`_computeCbDirServerSide`, `api/admin.js` ~4140): hanya menyala kalau confidence CB **kedua** leg "High" DAN tanpa `divergence_warning`. Mayoritas konflik di data nyata (real yield differential, COT positioning, data ekonomi harian, pidato pejabat, geopolitik) **bukan** dari `cb_bias` level — jadi Sistem Hakim memang tidak pernah punya kesempatan mengecek kasus-kasus ini, termasuk bug AUDNZD di atas. Celah struktural ini sudah diketahui by design (lihat `[[project-sistem-hakim-corrected-branch]]`), audit ini cuma mengonfirmasi cakupannya kecil (2/23 = 9%) relatif ke total data.

**Daftar field teks bebas LLM tanpa pengaman kode (celah struktural), diurut risiko tinggi→rendah:**
1. `makro_alignment_reason` — risiko tertinggi, langsung membentuk keyakinan searah/konflik trader; hanya diverifikasi kode utk sub-kasus cbDir (9% data).
2. `conflict_note` — pasangan `makro_alignment_reason`, sering mengulang klaim yang sama (termasuk mengulang bug di atas pada id yang sama); enum `conflict` divalidasi, isi teksnya tidak.
3. `intervention.reason` (tighten_sl/tighten_sl_preventive/close_early) — risiko tinggi karena mendasari AKSI risk-management riil pasca-entry; kode cuma validasi angka SL baru, bukan logika naratifnya (bukti: bug di atas lolos meski SL numeriknya sah).
4. `invalidation_condition` & `trigger` — tidak tervalidasi isi, dan ikut disuntik balik ke prompt AI berikutnya (`api/admin.js` ~5402/5652 "Invalidation: .../Trigger: ...") sehingga potensi salah nalar bisa merambat ke keputusan AI susulan (refine/position-review) tanpa penyaring.
5. `entry_basis` — cuma dipaksa null kalau kosong/`entry_zone` null; isi (struktur yang diklaim) tidak diverifikasi cocok dengan data.
6. Commentary 5-paragraf (termasuk "KESIMPULAN") — tak dipersist ke `setup_log_auto:v1`, murni tampilan; risiko informasional saja, tidak menggerakkan gate/keputusan kode apa pun.
7. `label_reason`/`canceled_reason`/`data_fix_reason` — bookkeeping statistik pasca-fakta, tidak mempengaruhi entry/exit trade yang sedang berjalan.

### [2026-08-04] Audit total auto-entry vs kriteria Plan U — status & temuan

Audit atas permintaan user ("audit fitur auto entry trade, sesuaikan dengan tujuan plan u... audit total"), diprioritaskan user ke pertanyaan inti: apakah kondisi sekarang sesuai Plan U. Data diambil LANGSUNG dari Redis production (Upstash REST, `.env.local`) via curl — bukan asumsi dari kode/dokumentasi saja.

**Progres n≥100 (`setup_log_auto:v1`):** 22 entri total per 2026-08-04 (status: `open`1, `sl`5, `canceled`8, `tp`7, `expired`1; per pair: GC=F 7, EUR/USD 6, EUR/GBP 4, AUD/NZD 4, GBP/USD 1 legacy). 15 hari sejak deploy (2026-07-20). Laju 7 hari terakhir (S253: n=16 @28/7 → sekarang n=22 @4/8) ≈0,86/hari — jauh di bawah asumsi awal "2 slot/hari/pair". **ETA n≥100 di laju ini ≈90 hari lagi (pertengahan/akhir Oktober-November 2026)**, bukan "±2,5-3 bulan dari 20/7" (≈akhir September) seperti estimasi S209 — konsisten dengan revisi pesimis S230/S253 yang sudah mencatat pola sama, laju belum membaik.

**Win rate mentah:** dari 12 setup closed relevan (tp+sl, exclude expired/canceled/open) — 7 tp, 5 sl = 58,3%. n masih jauh terlalu kecil untuk kesimpulan statistik apa pun, sekadar titik data.

**Gate A (AI Kritikus) veto rate — UPDATE kekhawatiran S251/S277:** progress.md mencatat kekhawatiran "rasio veto nyaris nol terus-menerus = gate cuma stempel" (S277 pagi: considered=12, critic_veto=0). Dicek ulang sekarang: considered=15, critic_veto=**2** (13,3%) — antara S277 dan sekarang Gate A memveto 2 dari 3 kandidat baru. Sampel masih kecil (n=15), tapi arahnya membaik, TIDAK lagi 0% mutlak. Invarian counter (`considered = saved + correlation_cap + drawdown + critic_veto + conflict_waktu`) dicek: 15 = 10+2+0+2+1 — cocok, tidak ada drift/bug akunting.

**Distribusi alignment (U-4 conviction sizing, item Plan U #8):** `konflik` 17/22 (77%), `searah` 3, `netral` 2 — mayoritas kandidat dapat `riskMultiplier` 0,5. Belum bisa disimpulkan ini kalibrasi benar atau bias sistematis AI menandai 'konflik' terlalu longgar — data untuk item #8 masih terlalu tipis untuk diputuskan, sekadar dicatat sebagai sinyal awal yang perlu diawasi begitu n cukup.

**U-5 (manajemen posisi, syarat n≥10 review event):** baru **1** entri dengan field `intervention` terisi (tighten_sl_preventive, AUD/NZD, proteksi weekend gap) — jauh dari ambang n≥10 yang disyaratkan Plan U untuk evaluasi intervensi vs ghost (saved vs cost).

**Plan X (`surprise_log:v1`, dideploy S280 di hari audit ini):** masih 0 entri — sesuai ekspektasi changelog S280 sendiri (perlu rilis riil pertama dengan forecast valid dalam window 1 jam saat `runAutoEntryCycle` jalan, 08:00/13:00 UTC), bukan bug, terlalu baru untuk dinilai.

**Kesimpulan audit:** seluruh kriteria Plan U yang masih terbuka (n≥100, skor kalibrasi antar-provider ≥80% item #6, breakdown loss_causes item #7, validasi conviction sizing item #8, out-of-sample split item #9, gating rezim item #10, evaluasi U-5 n≥10) **TETAP BENAR tertunda menunggu data** — audit ini tidak menemukan alasan untuk membuka salah satu prematur, dan tidak menemukan bukti sistem menyimpang dari desain Plan U (silent/senyap terjaga, isolasi budget eksperimental masih intak per audit kode terpisah). Item #1-5 (selesai S209) tidak diaudit ulang — di luar scope, tidak ada perubahan kode di area itu sejak selesai.

**Update:** perubahan Gate E (uncommitted saat audit ini ditulis) sudah di-commit+push sesi lain (`fbea3c5`, changelog Session 281) — tidak perlu tindakan lagi.

**Re-cek 2026-08-05 (sesi lain, pertanyaan user "apakah ada fitur yang mengganggu pengumpulan data?"):** angka live konsisten, kesimpulan TIDAK berubah. `setup_log_auto:v1` total=23 (naik dari 22), closed n=13 (7 tp/6 sl, win-rate 54%). `auto_guard_stats`: considered=16, saved=11, correlation_cap=2, drawdown=0, critic_veto=2 (gap 1 dari invarian kemungkinan `race_detected` yang dibuang tanpa counter — lihat komentar `api/admin.js` dekat `gotLock2`, bukan bug baru). Konfirmasi ulang kesimpulan S283 lanjutan (baris di atas): Gate A/B/D/E **bukan** penghambat dominan (67-69% lolos, wajar); yang tetap paling menahan laju n adalah `blockedByOpenPosition` + ketiadaan fallback GH Actions untuk `runAutoEntryCycle` (beda dari watcher TP/SL yang sudah ada cadangan) — dua-duanya sudah tercatat di atas, belum ada perubahan arah.

**Lanjutan sesi sama — sapuan `KEY_REGISTRY` (commit `b48665a`) + resolusi 2 hari kosong:** audit menemukan 7 log + 2 state daemon (`auto_skip_log`, `posreview_skip_log`, `surprise_log:v1`, `calendar_actual_latency_log:v1`, `consistency_log:v1`, `position_review_log:v1`, `xau_history`, `daemon_news_cursor`, `daemon_degraded_alert_ts`) sudah lama ditulis tapi tidak terdaftar di endpoint `redis-keys` resmi — satu-satunya jalan baca sebelumnya cuma akses Redis mentah langsung (di luar API aplikasi, sengaja diblokir alat). Didaftarkan + `getKeyInfo` diperluas baca isi LIST/timestamp (bukan cuma exists/ttl), test 871/871 hijau, live-verified pasca-deploy.

**Manfaat langsung dari sapuan ini:** begitu `auto_skip_log` bisa dibaca, 2 hari kosong `setup_log_auto:v1` yang jadi kekhawatiran (23 & 31 Juli, dicatat di atas sebagai "belum dicek log uptime Railway") **sebagian besar terjawab**: 23 Juli EUR/USD sengaja dilewati (ECB Interest Rate Decision 19:15 WIB), 31 Juli EUR/USD & EUR/GBP sengaja dilewati (EU Inflation Rate YoY Flash 16:00 WIB) — bukti daemon AKTIF & bekerja sesuai desain di kedua hari itu, bukan bukti Railway mati. Tidak ada entri skip untuk XAU/USD/AUD/NZD di 2 hari yang sama (kemungkinan besar `dup`/refine-in-place yang memang tidak pernah tercatat di log manapun, bukan berarti downtime) — jadi keputusan lama "terima risiko" (Track 2b, `daun_merah_progress.md`) makin kuat dasarnya, TIDAK perlu direvisi berdasarkan temuan ini.

### [2026-08-04] Audit lanjutan — skenario "professional trader" vs auto-entry, dan ketepatan jadwal cron

Lanjutan audit di atas, sudut pandang berbeda: user minta dibayangkan sebagai "trader profesional yang agresif tapi defensif" untuk menilai apakah skenario yang di-cover auto-entry sudah merangkum program kerja trader sungguhan. Semua item di bawah **DIPARKIR atas keputusan eksplisit user ("keep itu semua" / "keep lagi semua") — TIDAK dieksekusi, cuma didokumentasikan supaya tidak hilang untuk sesi berikutnya.**

**Celah manajemen posisi (fase "trade sedang berjalan", bukan seleksi/entry — itu sudah matang):**
1. **Trailing stop** — tidak ada. Butuh kalibrasi (ATR multiple dsb) yang belum ada dasarnya di n=22.
2. **Breakeven move** — tidak ada, SENGAJA (komentar kode `vps/daemon.js` baris ~41: hindari whipsaw). Keputusan sadar lama, bukan kelupaan.
3. **Invalidasi tesis teknikal tidak ditegakkan** — AI menulis `invalidation_condition` (teks bebas) saat generate sinyal, tapi tidak pernah dicek ulang otomatis terhadap harga berjalan; satu-satunya jalan keluar dini masih lewat berita (`tighten_sl`/`close_early`), bukan lewat struktur harga. **Ini SATU-SATUNYA dari 4 celah yang direkomendasikan layak dikerjakan lebih dulu**: (a) tidak butuh kalibrasi angka baru (tinggal menegakkan apa yang AI sendiri sudah tulis), (b) punya efek ganda — kualitas (potong trade mati lebih cepat) DAN kecepatan n≥100 (lihat poin cron di bawah, `blockedByOpenPosition` menahan slot pair itu selama posisi masih OPEN), (c) **bisa dibangun TANPA tambahan biaya DeepSeek** kalau kondisi invalidasi diminta terstruktur (level harga/MA, bukan cuma kalimat) di call generate yang SAMA — pengecekan berikutnya jadi fungsi murni (pola sama Gate B/D/E), bukan tanya-AI-ulang.
4. **Partial profit-taking/scaling** — tidak ada, sama seperti #1 butuh kalibrasi.

**Koreksi diri:** sempat menyebut "Gate D correlation cap cuma 1 pasangan (XAU-EUR/USD)" sebagai celah — SALAH, sudah dicek riset lama (r=0,03-0,19 AUD/NZD & EUR/GBP ke pair lain) dan sengaja tidak di-cap karena memang tidak perlu. Bukan celah.

**Mekanisme yang TERBUKTI memperlambat n≥100 (dicek ke kode, bukan kira-kira):** `blockedByOpenPosition` (`api/admin.js` ~5074) skip TOTAL pembuatan sampel baru untuk pair yang sedang OPEN, sampai posisi lama tutup. Kombinasi dengan celah #3 di atas (tidak ada exit dini berbasis struktur) berarti posisi yang "harusnya sudah mati" ikut menahan slot pair itu lebih lama dari perlu. Refine-in-place untuk PENDING searah (S230, sudah lama tercatat) tetap jadi penyebab dominan lain.

**Gate risiko (A/B/D/E) TIDAK terlalu ketat** — considered=15, saved=10 (67% lolos), rasio wajar. Yang justru dominan menahan pertumbuhan n itu bukan gate risiko, tapi mekanisme kebersihan statistik (dup-check, `blockedByOpenPosition`, refine-in-place, flip guard) — sengaja ketat supaya n≥100 nanti tidak berisi sampel yang saling berkorelasi/dobel-hitung. Melonggarkan ini demi kecepatan akan membuat n=100 tercapai lebih cepat tapi jadi tidak berarti secara statistik — kontraproduktif terhadap tujuan Plan U sendiri.

**Ketepatan jadwal cron (`AUTO_ENTRY_HOURS_UTC = '8,13'`, fire 08:15 & 13:15 UTC):** 08:00 UTC ≈ London buka, 13:00 UTC ≈ overlap London-New York (likuiditas tertinggi harian) — TEPAT untuk XAU/USD, EUR/USD, EUR/GBP. **Tapi AUD/NZD paling aktif di sesi Sydney-Tokyo (~22:00-08:00 UTC)** — jadwal sekarang cuma menangkap ekor sesi Asia + jam London/NY yang justru sepi untuk pair ini (selaras temuan lama "AUD/NZD range-bound" — riset di atas). **Temuan reliabilitas terpisah:** pembuatan sinyal (`runAutoEntryCycle`) TIDAK punya fallback GitHub Actions kalau daemon Railway down — beda dari watcher TP/SL yang punya cadangan `setup-tp-sl-watch.yml` tiap 5 menit. Kalau Railway down pas 08:15/13:15 UTC, jatah sinyal hari itu (semua 4 pair) hilang tanpa mekanisme susulan. Belum dicek log uptime Railway untuk konfirmasi seberapa sering ini benar-benar terjadi — kandidat pengecekan kalau dilanjutkan nanti.

**Syarat lanjut kalau user mau eksekusi salah satu:** #3 (invalidasi teknikal terstruktur, nol biaya AI) adalah kandidat paling siap. Jadwal cron AUD/NZD/reliabilitas fallback perlu keputusan eksplisit (geser jam khusus AUD/NZD vs biarkan, tambah fallback GH Actions untuk `runAutoEntryCycle` vs terima risikonya) — belum ada arah dari user, jangan dieksekusi sepihak.

### [2026-08-04] Profil struktural AUD/NZD & EUR/GBP — dasar "kartu spesialis" per pair auto-entry

Riset atas permintaan user (rapat sesi ini): AI Analisa/auto-entry pakai cara baca yang sama untuk 4 pair (`vps/daemon.js` `AUTO_ENTRY_PAIRS`: XAU/USD, EUR/USD, AUD/NZD, EUR/GBP), padahal AUD/NZD & EUR/GBP secara struktural beda kelas dari 2 major itu — dua-duanya cross tanpa kaki USD, jadi modul fundamental USD-sentris (`_labour_market.js`, `rate-path.js`) otomatis tidak relevan buat mereka.

**AUD/NZD** — range-bound/mean-reverting secara struktural: rentang tipikal 400-800 pip (jauh lebih sempit dari major pair) karena ekonomi Australia & New Zealand sangat mirip (dua-duanya komoditas-driven, RBA & RBNZ historisnya sering bergerak searah). Breakout yang kredibel (bukan noise dalam range) biasanya butuh salah satu pemicu jelas: (1) RBA-RBNZ policy diverge tajam, atau (2) harga komoditas kunci berlawanan arah — iron ore (proxy Australia) naik sementara dairy/GDT auction (proxy NZ) turun, atau sebaliknya. Sumber: [Forex For Starters — AUD/NZD Trans-Tasman Pair](https://forexforstarters.com/markets/minors/aud-nzd/), [AvaTrade AUD-NZD](https://www.avatrade.com/trading-info/financial-instruments-index/fxoptions/aud-nzd).

**EUR/GBP** — range-bound juga: rentang harian tipikal cuma 40-70 pip, ATR14 rendah, karena Eropa & Inggris berdekatan geografis dan menyerap shock eksternal (energi, resesi global) dengan cara mirip. Penggerak utama: divergensi kebijakan ECB-BOE + dinamika dagang/fiskal-politik relatif UK-EU (bukan cuma data makro standar). Implikasi biaya: range kecil bikin spread "memakan" porsi lebih besar dari target profit dibanding pair lain — nyambung ke temuan lama soal `SPREAD_PRICE_ESTIMATE` yang sempat bolong untuk AUD/NZD (baris di bawah, sudah diperbaiki). Sumber: [FxPro EUR/GBP Trading Guide 2026](https://www.fxpro.com/help-section/education/beginners/articles/mastering-eur-gbp-forex-trading-complete-guide-to-strategies-and-analysis-for-2026), [FXNX EUR/GBP Trading Guide](https://fxnx.com/en/blog/eur-gbp-trading-guide-mastering-institutional-anchor).

**Sintesis dieksekusi:** kedua cross ini defaultnya range-bound/tenang, breakout hanya kredibel kalau ada pemicu spesifik — beda arah dengan EUR/USD & XAU/USD yang lebih macro-driven/trending (jadi catatan ini SENGAJA tidak ditempel ke 2 pair itu). Diimplementasikan sebagai `structural_profile` di `api/_pair_context.js`, disuntik ke prompt cuma pas rezim volatilitas terdeteksi ekstrem (persentil ATR >70, pola sama `REGIME_INSTRUCTION` existing) — fail-open, bukan always-on, supaya tidak jadi noise di kondisi normal.

**Temuan sampingan (dieksekusi bareng, bukan riset baru — bug lama):** `api/real-yields.js` sebenarnya SUDAH menghitung real yield untuk EUR/GBP/JPY/CAD/AUD/NZD/CHF (bukan cuma USD), tapi `_extractMacroDrivers`/`_formatFundamentalBlock` di `api/admin.js` cuma pernah mengekstrak & menampilkan `currencies.USD`, digerbang `legs.includes('USD')` — jadi AUD/NZD & EUR/GBP tidak pernah dapat baris REAL YIELD walau datanya sudah ada di cache. Digeneralisasi jadi loop per-leg (lihat `daun_merah.md` untuk detail perubahan).

### [2026-07-29] High-Frequency Trading (HFT) — genuine HFT BLOCKER kategorikal, bukan gap usaha

Riset atas permintaan user: "riset HFT dan data yang diperlukan, yang bisa diimplementasikan." Dicek silang ke web (sumber di bawah) DAN ke kode aktual Daun Merah, bukan cuma teori umum.

**HFT institusional asli (market making/latency arbitrage/stat-arb order-book) — TIDAK BISA diimplementasikan, blocker infra+biaya kategorikal:**
- Butuh order book L2/L3 (depth-of-market), bukan cuma harga bid/ask — Deriv (broker Daun Merah) hanya expose `ticks`/`ticks_history` (harga, bukan depth) dan `active_symbols`; tidak ada endpoint DOM publik untuk symbol FX/synthetic.
- Butuh colocation di data center matching-engine broker/exchange + FIX API direct market access. Biaya nyata: setup infra sendiri US$1jt-5jt + opex US$50rb-200rb/bulan; jalur retail FIX access tetap perlu deposit minimum US$10rb-50rb + biaya konektivitas US$300-1.500/bulan. Stack Daun Merah = Railway/Vercel cloud generik (bukan colo), Node.js WebSocket (RTT retail wajar puluhan-ratusan ms, bukan sub-milidetik), budget proyek Rp0 by design ([[project-definisi-selesai-plan-u]]).
- Spread/slippage retail CFD/synthetic (`SPREAD_PRICE_ESTIMATE`, `api/admin.js`) menghapus habis edge di skala sub-detik — edge HFT institusional bergantung pada spread mendekati nol + rebate maker, tidak tersedia di broker retail manapun.
- Deriv ToS TIDAK melarang algo/scalping secara umum (dicek eksplisit — cuma melarang abuse sistem error/swap-arbitrage), jadi ini murni blocker infra & ekonomi, bukan legal.
- **Kesimpulan: sama kelasnya dengan blocker [[project-glm-zai-tos-blocker]] — jangan diusulkan ulang tanpa perubahan infra/modal fundamental (mis. user benar-benar sewa colo+FIX, di luar cakupan proyek gratis ini).**

**Yang SUDAH diimplementasikan & jadi bukti batas atas yang realistis (bukan usulan baru — Q-7, Session 253):** `vps/daemon.js` sudah subscribe `ticks` mentah (streaming tick-level, bukan candle) untuk XAU/USD guna watcher TP/SL real-time; 14 pair FX lain masih di granularity candle 1H (`ticks_history style:candles subscribe:1`). Ini membuktikan daemon Railway TEKNIS sanggup pegang tick stream — jalur ini yang jadi acuan kalau mau naik frekuensi, BUKAN membangun infra HFT baru.

**Ide "HFT-adjacent" yang implementable dalam batas stack sekarang (diparkir, BUKAN untuk dieksekusi tanpa persetujuan eksplisit — [[feedback-minimize-noise-plan-u]] user 2x tolak tambahan mekanisme):**
1. Perluas pola tick-stream Q-7 (yang sudah terbukti jalan di XAU/USD) ke pair lain KALAU ada kebutuhan nyata (mis. watcher TP/SL lebih presisi) — extend pola existing, bukan mekanisme baru.
2. Proxy microstructure dari tick yang sudah mengalir (uptick/downtick ratio, tick velocity per menit) sebagai indikator momentum/volatilitas kasar — tanpa order book asli tidak bisa hitung order-flow imbalance sungguhan, ini cuma aproksimasi kasar dari arah tick.
3. Reaksi event-driven lebih cepat (kalender/berita) — sudah jadi kekuatan inti Daun Merah (`calendar_v1`, `pollCalendarLatency`); mempertajam latensi rilis→sinyal ke skala detik adalah "edge kecepatan" yang realistis tanpa infra mikrodetik, beda dengan HFT sungguhan yang butuh sub-milidetik.
4. Stat-arb/pairs jangka pendek pakai `correlations.js` existing di window lebih pendek — reuse kode, bukan provider data baru.

**Sumber:** [Best Brokers for High-Frequency Trading 2026](https://newyorkcityservers.com/blog/best-hft-brokers-2026), [High-Frequency Trading Platforms: Architecture, Speed & Infrastructure (2026)](https://www.quantvps.com/blog/high-frequency-trading-platform), [Infrastructure Requirements for High-Frequency Trading](https://bluechipalgos.com/blog/infrastructure-requirements-for-high-frequency-trading/), [Deriv API — Ticks Stream](https://developers.deriv.com/docs/data/ticks/), [Deriv Trading Terms & Conditions](https://deriv.com/terms-and-conditions/trading-terms).

#### Katalog sumber data HFT — mode "abaikan constraint proyek" (referensi murni, BUKAN untuk dieksekusi)

Susulan riset di atas atas permintaan eksplisit user: "abaikan semua aturan/constraint proyek dulu, kreatif — data apa saja yang perlu untuk HFT sungguhan, sertakan yang berbayar, urutkan dari gratis." Ini katalog referensi kalau suatu saat modal/infra proyek berubah fundamental — TIDAK mengubah kesimpulan blocker di atas, dan TIDAK ada satupun butir ini yang dieksekusi ke kode Daun Merah.

**Tier 1 — GRATIS:**
- **[Dukascopy Historical Data Export](https://www.dukascopy.com/swiss/english/marketwatch/historical/)** — tick-by-tick FX 15+ tahun dari ECN pool sendiri. Kegunaan: backtest strategi berbasis harga (momentum/mean-reversion/breakout); TIDAK ada depth jadi tidak bisa untuk market making.
- **HistData.com** — alternatif/cross-check kualitas Dukascopy.
- **Binance/Coinbase/OKX WebSocket depth** ([Coinbase](https://docs.cdp.coinbase.com/coinbase-app/advanced-trade-apis/guides/websocket), [Binance](https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams)) — L2 order book real-time gratis tanpa API key. Kegunaan: latihan teknis rekonstruksi order book (snapshot+delta, deteksi sequence gap) sebelum bayar data FX asli; bisa juga jadi strategi riil kalau instrumen dipindah ke crypto.
- **LOBSTER sample gratis** (Humboldt University) — L3 order-by-order 5 ticker NASDAQ (AAPL/AMZN/GOOG/INTC/MSFT). Kegunaan: riset akademik microstructure (iceberg detection, order flow imbalance), bukan produksi.

**Tier 2 — FREEMIUM/MURAH:**
- **Massive/Polygon.io** (rebrand Okt 2025) — L1 multi-asset flat monthly. Kegunaan: sinyal harga skala menengah, dashboard, bukan HFT (L2 saham masih "direncanakan").
- **[Tardis.dev](https://tardis.dev/)** — L2/L3 crypto historis+live, metered murah. Kegunaan: backtest market-making/momentum crypto dengan replay kondisi live persis.
- Twelve Data/Finnhub/Alpha Vantage — L1 murah/gratis. Kegunaan: sinyal makro/teknikal sederhana saja.

**Tier 3 — MENENGAH (quant/prop, bayar-per-pakai):**
- **[Databento](https://databento.com/tick-data)** — L1/L2/L3 (MBO/MBP) futures/options/equities, 60+ venue, 16 PB tick history, ada $125 kredit gratis awal. Kegunaan: titik masuk realistis menguji ide market making/order anticipation/stat-arb dengan data order-by-order asli (bukan FX) tanpa kontrak enterprise.
- **[CoinAPI](https://www.coinapi.io/blog/full-order-book-data-in-crypto)** — tick-level order book crypto lintas-exchange. Kegunaan: strategi arbitrase antar-exchange.
- **LOBSTER komersial** — per-ticker per-hari. Kegunaan: perluasan riset microstructure saham AS di luar 5 sample gratis.

**Tier 4 — MAHAL/INSTITUSIONAL (kontak sales):**
- **[EBS Market (ICE/CME)](https://www.cmegroup.com/markets/ebs/ebs-data-and-analytics.html)** — order book FX interbank ASLI, opsi real-time delay 5ms. Kegunaan: SATU-SATUNYA fondasi data untuk market making FX institusional sungguhan.
- **[LSEG Real-Time-Direct/Refinitiv](https://www.lseg.com/en/data-analytics/financial-data/financial-news-coverage/political-news-feeds-analysis/real-time-news)** — feed sub-50 mikrodetik. Kegunaan: latency arbitrage antar-venue.
- **[LSEG Headlines Direct](https://www.lseg.com/content/dam/data-analytics/en_us/documents/fact-sheets/lseg-headlines-direct-fact-sheet.pdf)**/Bloomberg MRN/[RavenPack](https://www.ravenpack.com/blog/when-news-become-noise/) — ribuan USD/bulan. Kegunaan: strategi reaksi-berita milidetik sebelum tersebar publik; RavenPack tambahkan sentiment score otomatis dari teks.

**Tier 5 — Infrastruktur fisik (prasyarat, bukan data):**
- **Colocation rack** (~US$900-2.500/bulan Tier-3 standar, US$3.000-6.000+ high-density) — server sedekat mungkin ke matching engine, RTT mikrodetik.
- **Cross-connect** (US$50-300/bulan + ~US$750 sekali pasang) — kabel langsung ke rack exchange/vendor, hindari jitter jaringan publik.
- **Bandwidth dedicated** (US$225/bulan 25Mbps s.d. US$10.000/bulan 10Gbps) — tampung burst data order-book penuh multi-simbol tanpa packet loss.
- **[McKay Brothers](https://www.cmegroup.com/solutions/market-tech-and-data-services/technology-vendor-services/mckay-brothers.html) microwave network** — link point-to-point antar-kota bursa (Chicago-NJ, London-Frankfurt), ~40% lebih cepat dari fiber. Kegunaan: latency arbitrage antar-lokasi, disewa prop firm/bank besar.

**Ringkasan tingkat kegunaan:** Tier 1-2 = riset/backtest & belajar infra; Tier 3 = menguji strategi mendekati nyata (mayoritas bukan FX); Tier 4-5 = baru benar-benar dipakai untuk eksekusi HFT FX institusional sungguhan. Tetap terikat kesimpulan blocker kategorikal di atas — dicatat murni sebagai peta referensi, bukan roadmap Daun Merah.

### [2026-07-28] Riset "auto-entry lebih akurat & berkualitas" — 4 celah terukur di pipeline yang sudah ada (BELUM ada kode diubah)

Landasan akademis lengkap + 8 sitasi terverifikasi: `daun_merah_referensi_riset.md` §13 (SL vs volatilitas, periodisitas intraday FX, biaya transaksi, meta-labeling, ensemble LLM). Bagian ini khusus terjemahan temuan itu ke kode Daun Merah aktual — semuanya bisa dijawab dengan MENGANALISIS data yang sudah terkumpul, **tanpa menambah gate/mekanisme baru** (konsisten penutup §11 dan keputusan user 2026-07-28 soal Gate C). Diurutkan dari rasio manfaat-per-usaha tertinggi:

1. **Spread sudah dihitung di NILAI hasil, belum di PENENTUAN hasil.**
   Koreksi penting atas dugaan awal sesi ini (dicek langsung ke kode, bukan diasumsikan): biaya spread SUDAH dimodelkan — `SPREAD_PRICE_ESTIMATE` + `_costAdjustedR` (`api/admin.js`, dibuat 2026-07-20 sebagai item #1 rigor Plan U) mengurangkan `spread/risk` dari R tiap setup closed, jadi `cost_expectancy` gross vs net sudah ada.
   Yang BELUM: `_evaluateSetups` (~baris 2460-2485) menentukan setup itu `tp` atau `sl` murni dari wick candle H1 di harga mid, **tanpa spread sama sekali**. Konsekuensinya spesifik — koreksi biaya hanya memperbaiki BESARAN R, tidak pernah bisa memperbaiki KLASIFIKASI: setup yang di dunia nyata kena SL dulu (karena SL adalah stop order yang tersentuh lebih cepat, TP limit order yang tersentuh lebih lambat) tetap tercatat `tp` dan tetap menaikkan `win_rate_raw`/`win_rate_adjusted`. Jadi expectancy-nya konservatif, tapi **win-rate-nya masih optimis** — dan win-rate itulah yang jadi kriteria gate n≥100. XAU/USD paling terdampak (spread estimasi 0,30 vs EUR/USD 0,00012).
   Filippou dkk. (2024): untuk ukuran retail price impact tidak relevan tapi biaya proporsional spread tetap first-order; Hsu dkk. (2016) tetap menemukan profitabilitas pada biaya 2 bp — jadi ini bukan pembunuh, cuma bias berarah yang wajib dikuantifikasi.
   *Cara ukur (offline, 0 AI call, 0 perubahan runtime):* re-evaluasi entri `setup_log_auto:v1` yang sudah `tp`/`sl` dengan SL/TP digeser sebesar spread berjenjang (0,5x / 1x / 2x nilai `SPREAD_PRICE_ESTIMATE`) — laporkan berapa `tp` berbalik jadi `sl`/`ambiguous`. Kalau stabil di semua tingkat, kekhawatiran ini gugur dengan angka, bukan dengan asumsi.
   **Celah data ditemukan & LANGSUNG DIPERBAIKI sesi ini:** `SPREAD_PRICE_ESTIMATE` tidak punya entri `AUD/NZD`, padahal pair itu masuk `AUTO_ENTRY_PAIRS` sejak redesain 4-pair Session 247 — akibatnya SELURUH setup AUD/NZD diam-diam di-skip dari `cost_expectancy` (fail-open per-entri), jadi angka expectancy net selama ini cuma mewakili 3 dari 4 pair tanpa ada tanda apa pun di payload. Ditambahkan (0,00030, ballpark konsisten tabel: NZD/USD 0,00025, EUR/AUD 0,00035).

2. **Jarak SL tidak pernah dibandingkan ke ATR.**
   ATR14 H1 SUDAH dihitung deterministik (`api/_pair_context.js`, dikirim ke prompt lewat `pairCtx.block`), tapi tidak ada satu pun titik di pipeline yang mengecek "SL ini berapa ATR dari entry" — LLM bebas memilih level dari zona konfluensi, sanity-check di `admin.js` cuma memeriksa arah dan RR≥1. Kaminski & Lo (2014) + Lo & Remorov (2017): stop yang terlalu KETAT merusak expected return secara sistematis, dan manfaat stop bergantung pada ada tidaknya momentum/serial correlation.
   *Cara ukur:* hitung rasio jarak-SL/ATR14 tiap entri `setup_log_auto:v1` lalu bandingkan tingkat kena-SL antar-kuartil rasio. Kalau kuartil terketat SL-nya jauh lebih sering kena tanpa imbalan RR yang sepadan, barulah bicara lantai jarak minimum — jangan pasang ambang lebih dulu.

3. **Label `ambiguous` = lubang informasi, bukan sekadar status netral.**
   Kalau satu candle H1 menyentuh SL DAN TP, `_evaluateSetups` menyerah dan menandai `ambiguous` (jujur, dan itu benar) — tapi entri itu lalu tidak masuk hitungan win-rate manapun, sementara justru kejadian volatil seperti inilah yang paling sering terjadi di jam rilis makro. TIDAK ditemukan paper peer-review soal bias resolusi bar ini (dicari eksplisit, nihil) — jadi ini murni isu pengukuran internal.
   *Cara ukur dulu:* hitung berapa persen entri berakhir `ambiguous`; kalau <5% abaikan permanen, kalau besar baru pertimbangkan resolusi lebih halus untuk pair itu (data M15/M5 Deriv tersedia, tapi itu kerja baru — jangan sebelum angkanya membenarkan).

4. **Keputusan auto-entry berasal dari SATU model, bukan agregasi.**
   Rantai provider yang ada bersifat FALLBACK berurutan (dipakai kalau yang di atas gagal), bukan ensemble; Gate A (AI Kritikus) adalah lapisan veto, bukan agregator. Schoenegger dkk. (2024, *Science Advances*) menunjukkan LLM tunggal sering gagal mengalahkan benchmark tanpa-informasi sementara agregat 12 LLM setara agregat manusia — arah perbaikan yang didukung bukti ada di AGREGASI, bukan di penambahan filter. Biaya: N× call AI per slot.
   *Prasyarat sebelum ini layak dibahas serius:* hasil `runConsistencyCheck` yang sudah berjalan harian (target ≥80% bias identik, `daun_merah_plan.md` §PLAN U) — kalau satu model saja sudah tidak konsisten dengan DIRINYA sendiri, ensemble antar-model tidak akan menolong sebelum itu dibereskan.

**Yang SENGAJA tidak direkomendasikan:** menambah gate/filter baru (tidak ada satu pun paper §13 yang menuntutnya), mengubah jam slot auto-entry (08:15 & 13:15 UTC justru sudah jatuh di jendela aktivitas tinggi/spread tersempit menurut Ito & Hashimoto 2006 — validasi, bukan masalah), dan mengubah perilaku tighten Jumat (Arratia & Dorador 2019: aturan stop tetap efektif walau overnight gap & flash crash dimodelkan).

### [2026-07-23] Evaluasi & Perbandingan Biaya Model AI Kandidat (DeepSeek v4-flash vs GLM 5.2 vs Kimi K3)

Evaluasi komparatif 3 kandidat model AI berbasis kalkulasi penggunaan paling boros Daun Merah (32 call/hari = 704 call/bulan; 22 otomatis + 10 manual):

| Kandidat | Harga per 1M token | Biaya bulanan estimasi | Keunggulan | Kekurangan |
|---|---|---|---|---|
| **DeepSeek v4-flash** (Produksi Saat Ini) | Input $0.14 / Output $0.28 | **~$0.50 (± Rp 8.150/bulan)** | Kecepatan kilat (10–15s, bebas Vercel 60s timeout), presisi JSON 13-field native 100% | Narasi prosa makro terasa lebih kaku |
| **GLM 5.2** (Zhipu AI / Z.ai) | Input $0.77 / Output $2.42 (cached input $0.143) | **~$3.26 (± Rp 52.800/bulan)** | Narasi & sintesis makro Bahasa Indonesia paling kaya, luwes, dan institusional (terbaik untuk Call 1 Briefing FX) | Latensi 18–30s (lebih lambat dari DeepSeek), 6x lebih mahal |
| **Kimi K3** (Moonshot AI) | Input $3.00 / Output $15.00 | **~$15.84 (± Rp 256.600/bulan)** | Long-horizon reasoning kelas frontier (Fable 5 class) dengan kontrol `reasoning_effort: low` | Biaya paling tinggi (30x DeepSeek) |

**Skenario Hybrid dicoba (GLM 5.2 khusus Call 1 + DeepSeek v4-flash untuk Call 2,3 & Auto-Entry):**

- Call 1 (Briefing Prosa, ~132 call/bulan) via GLM 5.2 = $0.84 (± Rp 13.600).
- Non-Call 1 (Call 2,3, Analisa & Auto-Entry, ~572 call/bulan) via DeepSeek = $0.38 (± Rp 6.070).
- Total Hybrid = **~$1.22/bulan (± Rp 19.680/bulan)**.
- **Penemuan utama:** Hybrid TIDAK lebih murah secara nominal (+Rp 11.550/bulan dibanding Full DeepSeek Rp 8.130/bulan). Namun secara *value-for-money*, Hybrid adalah kandidat upgrade arsitektur paling ideal: kualitas narasi briefing terbaik dari GLM 5.2 tanpa mengorbankan kepatuhan JSON & kecepatan Auto-Entry dari DeepSeek v4-flash, dengan total biaya tetap sangat murah (< Rp 20.000/bulan).

### [2026-07-27] Caveat independensi statistik: XAU/USD-EUR/USD tetap korelatif di skema 4-pair baru

Redesain Session 247 (`daun_merah.md`) buang GBP/USD (paling redundan, r=0,827 ke EUR/USD) dan tambah AUD/NZD + EUR/GBP, tapi pasangan **XAU/USD-EUR/USD sendiri dipertahankan apa adanya (r=0,585, tidak berubah)** — keduanya sengaja tetap masuk set final sebagai "anchor major + kelas aset beda". Angka "korelasi rata-rata turun ke r=0,10-0,19" di changelog itu rata-rata SELURUH 4 pair (didilusi oleh AUD/NZD & EUR/GBP yang nyaris nol), bukan bukti pasangan XAU/USD-EUR/USD ikut membaik.

- **Implikasi gate n≥100/n≥30:** kalau XAU/USD dan EUR/USD kebetulan sama-sama open bersamaan (seperti setup 24-27/7/2026), CI/p-value hasil gabungan dua pair itu tetap "lebih presisi dari yang sebenarnya dijamin data" — temuan lama (`analyze_pair_correlation.js`) berlaku penuh untuk pasangan ini, TIDAK tereliminasi oleh redesain 4-pair.
- **Implikasi risiko portofolio:** posisi long XAU/USD + short EUR/USD (atau kombinasi searah lain) secara efektif adalah satu taruhan arah USD yang dobel ukurannya, bukan dua taruhan independen — SL kedua sisi cenderung ke-trigger bersamaan saat rally USD kuat, TP bersamaan saat USD lemah (r=0,585, bukan jaminan 1:1, ~34% variance share).
- **Belum ada tindak lanjut kode** — dicatat sebagai caveat interpretasi, bukan action item.

### Kalibrasi keyakinan berbasis outcome (eks "Tier 2", session 166)

Ikat badge keyakinan Analisa AI ke win-rate historis segmen serupa (pair + bias + rentang skor konfluensi) dari `setup_log:v1`, bukan self-assessment LLM. Prasyarat: sampel setup selesai cukup (indikatif ≥30 per segmen) — data sedang terakumulasi otomatis, cek berkala.

### Re-run backtest konfluensi berkala (`scripts/backtest_confluence.js`)

Angka bergerak antar-run (jendela 60 hari bergeser) — jalankan ulang tiap beberapa minggu dan bandingkan TREN, jangan kutip satu angka sebagai konstanta.

- **Run 2026-07-20 (Session 209, dengan breakdown rezim volatilitas via `computeVolatilityRegime`):** agregat global skor tinggi 918 zona, 369 sentuh (40%) → bounce 54% | break 22% | chop 24%; skor rendah 30 zona, 7 sentuh (23%) → bounce 57%. Kontrol rendah MASIH terlalu kecil (n sentuh tunggal digit) untuk klaim pembanding apa pun, dan run kali ini bounce rendah malah SETARA/lebih tinggi dari tinggi (beda dari run 2026-07-17 yang skor tinggi menang) — JANGAN disimpulkan sebagai "confluence tidak bekerja", cuma bukti n kontrol terlalu kecil untuk stabil antar-run. **Temuan breakdown rezim:** bounce-rate skor TINGGI stabil 51-54% di tenang/normal/bergejolak (54%/54%/51%) — tidak terlihat degradasi jelas di rezim bergejolak seperti dugaan awal. Perlu run lanjutan dengan rentang data lebih panjang (>60 hari, lintas tahun) sebelum ini jadi kesimpulan robust — 60 hari saat ini kemungkinan besar didominasi satu rezim pasar yang sama untuk urutan bulan tertentu.
- **Update 2026-07-22 (rigor statistik, respons riset Scopus AI — `scripts/_stats.js`):** dugaan "n kontrol terlalu kecil" di atas sekarang punya angka formal, bukan cuma feeling. Run ulang: skor tinggi 918 zona, 369 sentuh (40%) → bounce 55% [bootstrap 95% CI: 49,9%-59,9%]; skor rendah 32 zona, 7 sentuh (22%) → bounce 57% [95% CI: 28,6%-85,7%, SANGAT lebar karena n=7]. Permutation test beda observed -2,1 poin, **p=1,000**; Wilcoxon rank-sum z=-0,097, **p=0,891** — beda bounce-rate TINGGI vs RENDAH **BELUM signifikan secara statistik** pada n saat ini (CI kedua bucket tumpang tindih total). Per rezim juga tidak ada yang p<0,05 (tenang p=0,511; normal p=0,223; bergejolak p=1,000). **Kesimpulan: confluence zone BELUM terbukti prediktif secara statistik** — bukan berarti tidak bekerja, tapi klaim "zona skor tinggi lebih reaktif" masih hipotesis, bukan temuan established. Root cause utamanya kemungkinan besar n kontrol (RENDAH) yang kronis kecil (7 sentuh dari 60 hari data) — sampel TINGGI sudah cukup besar (n=369) tapi tidak menolong kalau pembandingnya masih terlalu kecil. Sebelum lanjut Tier 5 atau menaikkan bobot confluence di manapun, perlu perbesar n kontrol (rentang data lebih panjang dan/atau perlonggar ambang LOW_SCORE) supaya test punya daya (power) memadai.

### Backtest carry/yield differential (`scripts/backtest_carry.js`, dibuat 2026-07-20, Session 209)

Signal bulanan dari differential yield 10Y nominal (proxy carry — BUKAN short rate/kebijakan asli, itu tidak tersedia gratis via FRED) EUR/GBP/AUD/JPY vs USD, dibanding kontrol Buy&Hold + Anti-Carry. **BELUM dieksekusi** — butuh `FRED_API_KEY` (tidak ada di `.env.local` lokal sesi ini). Jalankan: `FRED_API_KEY=xxx node scripts/backtest_carry.js`.

### Ide/catatan riset ringan lain (belum jadi plan)

- **Seasonality bulanan/mingguan per pair** — hitung offline dari data Daily yang sudah ada di Redis; 0 AI call. Sajikan sebagai konteks, bukan sinyal.
- **Bobot lebih untuk posisi harga vs option expiry besar H-1** — datanya sudah ada, belum diberi peran di scoring.
- **Carry trade / currency crash risk** — masih tahap riset literatur, BELUM diverifikasi ke sumber primer; jangan dieksekusi sebelum itu (lihat juga catatan "Ditahan" Plan G).

### Latensi field `actual` di `calendar_v1` (Plan U-3, sub-riset 2026-07-20)

Dicek langsung ke `calendar_v1` produksi (read-only, ~01:00 WIB) — event high-impact berikutnya saat itu (CAD Inflation Rate YoY) baru jatuh >18 jam kemudian, sehingga median latensi ≥3 event nyata TIDAK BISA diukur sinkron dalam satu sesi.

**Keputusan:** Lapis 2 (auto-cancel virtual setup `pending` `source:'auto'` saat deviasi actual-vs-forecast berlawanan arah bias) DI-DESCOPE untuk rilis U-3 — sesuai prinsip plan sendiri ("data tidak terverifikasi = jangan dipaksakan"), cukup label pasca-fakta (`fundamental_shock`, U-1) untuk saat ini. Instrumentasi `pollCalendarLatency` (`vps/daemon.js`, poll 10 menit → `calendar_actual_latency_log:v1`) TETAP dibangun & aktif sejak deploy `93b8ceb` (2026-07-20).

**Prasyarat lanjut:** begitu ≥3 sampel nyata terkumpul, evaluasi ulang — aktifkan Lapis 2 kalau median ≤30 menit, descope permanen kalau >30 menit. Detail teknis: `vps/README-deploy.md` §8.

### Roadmap Data Feed & Infra Always-On (hasil diskusi + verifikasi live session 186, 2026-07-18 — menggantikan ide lama "MT5 + Free VPS" session 185)

**Urutan disepakati:**
1. Promosi DeepSeek flash.
2. Fase A: candle on-demand di Vercel (sumber baru, Yahoo jadi fallback).
3. Fase B: daemon VPS event-driven (streaming harga → Redis, alert berita high-impact <1 menit, alert harga-sentuh-level saat app tertutup; semua via web-push existing).

Prinsip: VPS = penambah, bukan tulang punggung — heartbeat di Redis, UI tampilkan umur data, auto-fallback ke tarik-langsung kalau daemon diam.

**MT5: DICORET.** Terminal Windows/Wine di Linux = rapuh; dan akun demo OANDA user ternyata entitas "OANDA Global Markets" (MT5-only, login portal ditolak) → API v20 OANDA TERTUTUP untuk pendaftar Indonesia (verified live 2026-07-18, developer.oanda.com: v20 hanya untuk akun fxTrade).

**Pengganti TERVERIFIKASI LIVE (2026-07-18, tanpa akun):** Deriv API (`ws.derivws.com`, WebSocket) — `active_symbols` mengonfirmasi SEMUA 15 pair Daun Merah ada (termasuk frxGBPAUD, frxGBPCAD, frxXAUUSD "Gold/USD"), dan `ticks_history style:candles granularity:3600` mengembalikan OHLC H1 nyata tanpa autentikasi (app_id publik 1089; untuk produksi daftar app_id sendiri — gratis). Cocok untuk Fase A (WS pendek dari Vercel) DAN Fase B (streaming). Kandidat sumber kedua: Twelve Data (REST, free tier, forex+XAU — limit pastinya cek saat signup, indikatif 800 credit/hari 8/menit).

**VPS:** user sudah daftar + pesan VPS gratis CepatCloud.id (2026-07-18, menunggu aktivasi — review forum: pendaftaran kadang tidak diproses, no technical support, IPv4 private saja [cukup, daemon hanya butuh koneksi keluar]). Kalau aktif: uji heartbeat 1-2 minggu dulu TANPA token apa pun, baru daemon naik. **Plan B HF Spaces GUGUR** (2026-07-18, dicek langsung di huggingface.co/new-space): Docker/Gradio Space kini butuh plan PRO berbayar, free tier tinggal Static (tanpa compute) — info "16GB gratis" di riset Sesi 185 & Gemini SUDAH BASI. Plan B baru: Render free (Docker, tanpa kartu) + pinger cron-job.org 10 menit vs spin-down 15 menit; Cloud Run DITOLAK (butuh kartu + serverless membekukan koneksi WS antar-request, ping tidak menolong), Koyeb perlu verifikasi (kartu? kuota bulanan habis = mati sisa bulan). Alternatif lain: Oracle Always Free (butuh kartu) / VPS murah / tunda Fase B.

**GH Actions:** repo PRIVATE = menit terbatas & cron sering telat (bukti 2026-07-18: run digest terjadwal 00:00 UTC jalan 03:16 dan gagal) — JANGAN tambah frekuensi cron (saran Gemini ditolak); arah justru pensiunkan ohlcv-sync/ta-warm setelah Fase B jalan.

---

## Pembelajaran Proyek

- **Unit test hijau bukan bukti fitur benar.** Bug skala ADP (seri berunit orang vs ribuan) dan filter Inside Bar `mr_co1` hanya ketahuan saat verifikasi data live production, bukan dari test. Selalu uji dengan data/deploy nyata sebelum menyimpulkan. (S154, S180)
  **Varian baru (S204, 2026-07-20):** pure-function unit test bisa hijau terus-menerus padahal PEMANGGILNYA salah — `_formatTrackRecordBlock(log, symbol)` diuji dengan mock yang symbol-nya sengaja konsisten di kedua argumen, sementara kode produksi memanggilnya dengan `data.label` (bukan `symbol`), membuat filter gagal total sejak session 180. Baru ketahuan lewat test end-to-end yang benar-benar memeriksa payload prompt asli. Pure-function test WAJIB didampingi ≥1 test integrasi yang memverifikasi pemanggil pakai argumen yang benar, bukan cuma fungsinya sendiri benar.
- **Masalah model gratis = reliability, bukan kualitas.** Nemotron 3 Ultra outputnya bagus (0 pelanggaran frasa) tapi latency 7-41 detik tak terprediksi → didemote. Memperbaiki struktur input/output (fact sheet deterministik) berdampak jauh lebih besar daripada ganti-ganti model. (S162, S180)
- **Baca ToS sumber primer SEBELUM menulis kode.** NVIDIA API Trial melarang eksplisit penggunaan produksi — ketahuan di desk research dari PDF resmi (bukan artikel pihak ketiga), menghemat seluruh siklus uji live yang hasilnya tidak akan bisa dipakai. (Plan N, 2026-07-18; precedent: Kimi K2.6 403, S144)
- **Korupsi di luar tag `<script>` lolos semua lapis test.** Teks nyasar sebelum `<!DOCTYPE html>` tampil sebagai "judul palsu" di semua tab dan tidak tertangkap parse-check maupun `npm test`. Mitigasi: test integritas statis (Plan M3). (S181)
- **Timeout client harus lebih panjang dari timeout server.** Root cause NEWS mobile gagal: client abort sebelum server `maxDuration` selesai — pola yang sama bisa menular ke endpoint lain kalau tidak diperiksa saat menambah fitur lambat. (S161)
- **Env var Sensitive di Vercel selalu terbaca kosong via `vercel env ls/pull`.** Itu bukan bukti var tidak ter-set — verifikasi harus FUNGSIONAL (call kecil yang memakai key-nya). (S163+, terbukti lagi di Plan N saat konfirmasi nama var aktual)
- **File `.env*` bisa menyimpan value dengan tanda kutip literal di sekitarnya** (`KEY="isi"`) — `.trim()` saja tidak menghapus kutip itu, cuma whitespace. Kalau value dipakai sebagai header/token ke request nyata, kutip ikut terkirim dan diam-diam gagal match tanpa error jelas (bukan 401, cuma jatuh ke jalur tanpa-auth). Selalu strip kutip eksplisit saat parsing manual file env di luar dotenv. (Plan U-6, 2026-07-20 — call `auto=1` uji senyap sempat false-negative karena ini sebelum ketahuan & diperbaiki)
- **PWA bisa nyangkut di versi lama berhari-hari.** Auto-reload hanya terpicu perubahan byte `sw.js`; fix `index.html`-only tidak pernah sampai ke device yang tidak di-force-close — sebelum menyimpulkan "belum difix", pastikan versi yang dilihat user memang versi terbaru. Mitigasi permanen: probe versi Plan M3. (S179, S48b)
- **Keyword list klasifikasi berita sengaja statis, bukan adaptif.** `POSREVIEW_CURRENCY_KEYWORDS` & kategori `newscat.js` murni daftar kata kunci tetap (bukan AI/adaptif) karena gerbang pre-entry harus cepat & deterministik — konsekuensinya butuh maintenance manual tiap ada skenario makro baru yang belum tercakup (contoh nyata: linkage minyak→emas baru ditambahkan S219 dipicu kasus Iran-Gulf). Kategori generik konflik (`military`/`attack*`/dst) relatif tahan lama; `POSREVIEW_CURRENCY_KEYWORDS` (relevansi kausal berita→mata uang) jauh lebih rapuh dan perlu direview tiap ada kasus makro baru yang lolos tanpa terdeteksi. (S219, S220)

---

## Riset Provider AI Baru: Gemini / Mistral / NVIDIA NIM (2026-07-18)

> Eksekusi Plan N (`daun_merah_plan.md` bagian N). Tujuan: cari kandidat gratis baru untuk Call 1/2/3 Ringkasan yang lebih stabil dari saga Nemotron/GLM/Qwen (lihat memory proyek).
> Env var Vercel aktual (dikonfirmasi `vercel env ls`, BUKAN nama tebakan di plan): `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `NVIDIA_API_KEY` (bukan `NVIDIA_NIM_API_KEY`).

### Tahap 0 — Desk Research

| | Gemini (AI Studio) | Mistral (La Plateforme) | NVIDIA NIM (build.nvidia.com) |
|---|---|---|---|
| Endpoint OpenAI-compatible | `generativelanguage.googleapis.com/v1beta/openai/` | `api.mistral.ai/v1` | `integrate.api.nvidia.com/v1` |
| Model kandidat Call 1 (prosa) | `gemini-2.5-flash` (10 RPM/1.500 RPD) atau `gemini-2.5-flash-lite` (15 RPM/1.000 RPD) | `mistral-medium-3.5-26.04` (frontier, agentic) atau `mistral-small-4-0-26-03` | model DeepSeek yang di-host NIM (cek daftar model saat eksekusi Tahap 2 — endpoint `/v1/models`) |
| Limit resmi (indikatif, BUKAN dari akun user) | Flash: 10 RPM / 250K TPM / 1.500 RPD. Flash-Lite: 15 RPM / 250K TPM / 1.000 RPD. **Per PROJECT**, bukan per key | Tier "Experiment": ±1 miliar token/bulan, RPS tidak dipublikasi resmi lagi (estimasi non-resmi 1-5 RPS) — wajib cek Admin Console → Limits saat eksekusi, jangan pakai angka riset ini sebagai kepastian | 40 RPM baseline (bisa apply upgrade ke 200 RPM). Bukan sistem kredit-habis-sekali untuk hosted catalog gratis — dibatasi RPM, bukan kredit |
| JSON mode native | Ya — `response_format` didukung | Endpoint OpenAI-compatible umumnya mendukung `response_format` — verifikasi saat implementasi | Tergantung model — banyak NIM model OpenAI-compatible mendukung `response_format` |
| **ToS produksi** | Free tier BOLEH dipakai (bukan cuma evaluasi), TAPI prompt/output dipakai Google untuk training + human reviewer bisa membaca isi prompt (dikonfirmasi `ai.google.dev/gemini-api/terms`). Isi prompt proyek ini = berita pasar publik, tidak sensitif → **diterima** | Ambigu — ToS komersial tidak eksplisit melarang produksi di tier gratis, tapi klausul training-data menyebut data pada free subscription dipakai untuk training kecuali opt-out. Tidak ditemukan larangan produksi eksplisit → **BOLEH dicoba, catat sebagai fallback-risiko-training-data** | **DILARANG EKSPLISIT.** PDF resmi *NVIDIA API Trial Terms of Service* (v. 19 Sep 2025) §1.2 & §1.4: akses hanya untuk *"limited trial purposes"*, **tanpa penggunaan produksi** kecuali beli Subscription |

**Keputusan gate awal (sebelum satu baris kode pun ditulis):** NVIDIA NIM TIDAK BISA di-PROMOTE ke chain produksi, apapun hasil tesnya — ToS resmi melarang eksplisit "not in production" untuk yang belum beli Subscription berbayar. Ini larangan kontraktual jelas, bukan risiko/probabilitas seperti kandidat lain. NVIDIA turun status jadi riset/dokumentasi saja sebelum Tahap 1 dimulai — TIDAK dilanjutkan ke uji live 5-sampel (Tahap 3). Kode diagnostik `?test_nvidia=1` tetap dibuat (murah, konsisten pola kandidat lain yang ditolak) untuk jaga-jaga kalau NVIDIA suatu saat merilis tier produksi gratis, tapi TIDAK dijalankan sebagai bagian gate promosi.

Gemini & Mistral: lanjut ke Tahap 1-4 sesuai plan.

### Tahap 1 — Verifikasi Fungsional Key

Dites live 2026-07-18 via `?test_gemini=1` / `?test_mistral=1` / `?test_nvidia=1` di `financial-feed-app.vercel.app/api/market-digest` (jalur diagnostik terisolasi, TIDAK menimpa `latest_article`):

- **Gemini** — key valid. Model awal `gemini-2.5-flash` → HTTP 404 (generasi model sudah bergeser ke Gemini 3.x per riset ulang saat itu). Diganti alias resmi `gemini-flash-latest` (hot-swap otomatis, resolve ke `gemini-3.5-flash`) → OK. Masalah kedua: `finish_reason=length` dengan output cuma 109 karakter di percobaan pertama — Gemini 3.x selalu "thinking" (tidak bisa dimatikan total, beda dari 2.5 yang bisa `reasoning_effort:'none'`), budget token 1300 habis untuk reasoning trace. Fix: `reasoning_effort:'low'` + `max_tokens` naik ke 3000 → OK, output 2.900-3.100 karakter konsisten setelahnya.
- **Mistral** — key valid, model `mistral-medium-latest` sukses di percobaan PERTAMA, tanpa perlu iterasi.
- **NVIDIA NIM** — key valid (tidak pernah dapat error auth), TAPI 3 model id dicoba (`deepseek-ai/deepseek-v3.2`, `deepseek-ai/deepseek-v3.1`, `deepseek-ai/deepseek-v3.1-terminus` — id terakhir dikonfirmasi dari `docs.api.nvidia.com/nim/reference/`) semuanya HTTP 404 (~40ms, kemungkinan ditolak di layer gateway/routing sebelum sampai model backend, bukan auth/network gagal). **Tidak diselidiki lebih lanjut** — NVIDIA sudah REJECT permanen by ToS, jadi menyelesaikan model id yang benar tidak mengubah keputusan promosi apapun hasilnya. Kalau suatu saat NVIDIA membuka tier produksi gratis dan riset ini dibuka kembali, cek daftar model AKTUAL via `GET /v1/models` dengan key asli (butuh akses key plaintext yang tidak tersedia dari sesi eksekusi ini).

### Tahap 2 — Tier Diagnostik Call 1

Ditambahkan di `api/market-digest.js`: `?test_gemini=1`, `?test_mistral=1`, `?test_nvidia=1` (pola persis `?test_nemotron=1`, `isIsolatedTest` — hasil TIDAK ditulis ke `latest_article`).

### Tahap 3 — Sampel Live Call 1

**STATUS: SELESAI (2026-07-18). Gemini dipromosikan (PROMOTE) sebagai fallback di Call 1/2/3, Mistral dan NVIDIA NIM ditolak (REJECT).**

**Gemini (`gemini-flash-latest`, 6 sampel Call 1):**

| # | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| 1 | 5.4s | Ya | 2.993c | 0 | ID penuh | |
| 2 | 6.5s | Ya | 2.940c | 0 | ID penuh | |
| 3 | 7.8s | Ya | 3.091c | 1 ("di tengah") | ID penuh | |
| 4 | 6.3s | Ya | 2.599c | 1 ("di tengah") | ID penuh | |
| 5 | 10.2s | Ya | 2.677c | 1 ("di tengah") | ID penuh | |
| 6 | 22.7s | Ya | 2.332c | 0 | ID penuh | Uji ulang (server cold-start/network latency) |

6/6 sukses di Call 1, latency rata-rata di bawah 10s (satu kali 22.7s akibat cold start, tetap di bawah timeout 25s). Format `{{TAG: X}}` dan struktur FX/XAUUSD dipatuhi 100%. Rate leak forbidden-phrase "di tengah" sebesar 50% (3/6 sampel) — setara/sedikit lebih tinggi dibanding DeepSeek, tetapi kualitas prosa makronya sangat superior dibanding model free tier lainnya.

**Call 2 & Call 3 Integration (JSON Mode):**
- **Call 2 (JSON Stance):** Sukses (1/1). Sempat kena JSON parse error akibat truncation karena `max_tokens` di-hardcode 700. Setelah dinaikkan ke 3000 dan dikirim `reasoning_effort: 'low'`, output JSON bias CB terurai dengan sempurna.
- **Call 3 (JSON Thesis):** Sukses (1/1). Sama seperti Call 2, sempat truncated pada `max_tokens` 800. Setelah diperbaiki dengan `maxTokens: 3000` + `reasoning_effort: 'low'`, skema thesis terurai 100% valid dan disimpan sukses di Redis.

**Mistral (`mistral-medium-latest`, 4 sampel Call 1):**

| # | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| 1 | 6.6s | Ya | 1.578c | 0 | ID penuh | |
| 2 | 11.8s | Ya | 1.656c | 1 ("di tengah") | Campur | "Fed's Hammack" (posesif Inggris) |
| 3 | 13.1s | Ya | 1.916c | 0 | Campur | "Fed's Hammack" lagi |
| 4 | 7.6s | Gagal | 925c | 0 | ID penuh | **Format Failure:** FX di-skip total, hanya menulis bagian XAUUSD tanpa header |

**NVIDIA NIM (1 sampel per model, Call 1):**

| Model | Latency | Sukses | Panjang | Forbidden phrase | Bahasa | Keterangan |
|---|---|---|---|---|---|---|
| `nvidia/nemotron-3-ultra-550b-a55b` | 20.9s | Gagal | 1.733c | 0 | ID penuh | **Format Failure:** Bagian FX dilewatkan total, hanya menulis ulasan XAU/USD |
| `deepseek-ai/deepseek-v4-flash` | 24.1s | Ya | 2.915c | 2 ("di tengah", "sejalan dengan") | ID penuh | Ulasan FX dan XAU/USD sangat lengkap dan tajam. Namun latency kritis dekat timeout |

**Evaluasi:**
- **Nemotron 3 Ultra:** Mengalami kegagalan format kritis dengan mengabaikan bagian FX sepenuhnya (mirip seperti Mistral). Latency 20.9s terlalu dekat batas timeout 25s.
- **DeepSeek v4 Flash:** Kualitas prosa dan struktur analisisnya sangat luar biasa (mengulas EUR/USD, GBP/USD, USD/JPY, AUD/USD, dan XAU/USD secara tajam dan runut). Namun, latency mencapai 24.1s (sangat riskan mengalami timeout Vercel yang dipotong di 25s) dan membocorkan 2 frasa terlarang.

### Tahap 6 — Keputusan Final (2026-07-18)

- **Gemini (gemini-flash-latest): PROMOTE** ke chain produksi sebagai Fallback 2 di Call 1 (di antara Cerebras gpt-oss dan Groq) dan Fallback 1 di Call 2 & Call 3 (di antara SambaNova dan Groq karena mendukung JSON mode native `response_format`).
  *Pelajaran penting:* Gemini 3.x selalu "thinking" dan tidak bisa dinonaktifkan. Selalu set `max_tokens` minimal 2500-3000 untuk Call JSON agar tidak terpotong (truncated) di tengah jalan, serta kirim parameter `reasoning_effort: 'low'`.
- **Mistral (mistral-medium-latest): REJECT.** Gagal format (mengabaikan instruksi FX) dan gagal JSON Call 3 (HTTP 400).
- **NVIDIA NIM: REJECT.**
  - *Hambatan Hukum:* Ketentuan Layanan (Terms of Service) trial melarang penggunaan di produksi.
  - *Hambatan Teknis:* Latency sangat tinggi (20.9s–24.1s) yang mendekati batas maksimal timeout Vercel 25s, sehingga tidak andal sebagai fallback yang stabil. Nemotron juga gagal format (mengabaikan FX). DeepSeek v4 Flash sangat baik dari segi konten, namun latency 24.1s dan leak kata terlarang menggugurkannya sebagai kandidat produksi.

---

## Riset Sesi 185 — Polishing Chain AI & VPS/Data Gratis (2026-07-18)

### 0. Hasil tes live DeepSeek v4-flash vs V3.2 (Session 186, 2026-07-18)

Follow-up langsung dari ide #1 di bawah. User top-up US$2 (saldo top-up TIDAK expire), tes via `?test_deepseek=1` (jalur terisolasi baru, pola Plan N) — 3 sampel flash + 2 sampel V3.2 (SambaNova) dari data berita yang sama. Detail penuh di changelog `daun_merah.md` Session 186.

- **Kualitas:** flash unggul — FX per-pair lengkap 3/3 sampel + lebih padat angka (skew, CFTC, level), V3.2 kedapatan menipiskan bagian FX 1/2 sampel. Leak frasa terlarang setara.
- **Latency:** setara dan sama-sama bervariasi (flash 7.5-23.1s, V3.2 6.3-21.4s).
- **Biaya nyata:** 3 generate penuh = US$0.01 (verifikasi endpoint `user/balance`). Proyeksi cron 3x/hari 3 bulan ≈ US$0.90 → saldo $2 cukup untuk flash primary market-digest 3 bulan.
- **Catatan pra-promosi:** thesis Call 3 null 1/3 sampel (perlu cek log saat terulang); outlier 23.1s dekat timeout 25s. Pagar biaya sudah dipasang: `_ai_guard.js` deepseek=50/hari.
- **Status waktu itu: belum dipromosikan — menunggu keputusan user.** Ide GLM-5.2-via-NIM sebagai copywriter (ide #1) tetap GUGUR untuk produksi (ToS NIM, lihat Keputusan Gate Awal Plan N).

### 1. Polishing Chain: DeepSeek v4 Pro + GLM-5.2

- **Ide:** Memisahkan peran AI. **DeepSeek v4 Pro** (API Resmi) sebagai *Data Analyst* (sangat cerdas logikanya untuk menghitung angka teknikal Entry/SL/TP). Hasilnya dikirim ke **GLM-5.2** (NVIDIA NIM) sebagai *Copywriter* untuk ditulis ulang menjadi Bahasa Indonesia yang luwes dan natural (karena bakat linguistik alami GLM-5.2 sangat tinggi).
- **Keuntungan:** Mendapatkan ulasan trading dengan data presisi tinggi sekaligus bahasa yang natural.
- **Hambatan Latency:** Akumulasi waktu pengerjaan 2 model berurutan mencapai 20–25+ detik (DeepSeek ~6s + GLM-5.2 ~15s). Ini pasti memicu Gateway Timeout di Vercel, sehingga wajib dijalankan secara Asinkron (Background Job di GitHub Actions) atau di-host di VPS always-on.
- **Alternatif:** Prompt Engineering pada DeepSeek v4 Pro (Few-Shot) dengan memberikan contoh teks GLM-5.2 agar ditiru secara langsung dalam satu kali panggilan (menghemat waktu & token).

### 2. Provider Data Real-time & Gratis

- **MT5 (MetaTrader 5) Broker Demo Account (Rekomendasi Utama):** Menghubungkan script backend ke terminal MT5 dengan akun demo gratis broker Forex retail. Ini menyediakan data feed harga & candle (OHLCV) yang 100% real-time milidetik, gratis selamanya, legal, bebas rate-limit, dan harganya dijamin presisi 100% sama dengan platform trading.
- **Finnhub.io:** Opsi API WebSocket gratis instan, namun rentan rate-limit jika dinyalakan 24 jam non-stop.

### 3. Layanan VPS Gratis Always-On (Tanpa Kartu Kredit)

- **CepatCloud.id:** VPS Linux murni gratis selamanya (1 vCPU, 2GB RAM) khusus untuk developer Indonesia. Hanya butuh verifikasi Email & WhatsApp.
- **Hugging Face Spaces (Docker SDK):** ~~Container virtual gratis 2 vCPU/16GB~~ **BASI — per 2026-07-18 Docker/Gradio Space butuh plan PRO berbayar (verified langsung di halaman new-space); free tier tinggal Static tanpa compute.**
