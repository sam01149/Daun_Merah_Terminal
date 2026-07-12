# Daun Merah — Project Context (Full Reference)

> **Last updated:** 2026-07-12 (session 158 lanjutan 6 — audit kurasan vendor: temuan data zero-cost yang masih dibuang + backlog RRP/ECB SPF/COT percentile)
> **Branch:** main — semua perubahan deployed ke production
> **Working directory:** `c:\Users\sam\Documents\kerja\Daun_Merah`
> **Production URL:** https://financial-feed-app.vercel.app
> **Struktur dokumentasi:** file `daun_merah*.md` sekarang di folder [Dokumentasi/](Dokumentasi/) (dipindah dari root). Referensi khusus: [daun_merah_ai.md](daun_merah_ai.md) (pemakaian AI: fitur, provider, limit, estimasi frekuensi) dan [daun_merah_vendor.md](daun_merah_vendor.md) (inventaris semua vendor/layanan eksternal).

---

## Changelog Session 158 lanjutan 6 (2026-07-12) — Audit Kurasan Vendor: Data yang Sudah Kita Fetch tapi Dibuang

**Konteks:** user minta audit semua vendor — "apakah informasi yang mereka sediakan sudah kita kuras habis untuk keuntungan kita, tanpa noise?" Audit READ-ONLY: belum ada kode yang diubah; temuan di bawah adalah backlog kandidat, menunggu keputusan user.

**Metode:** baca seluruh integrasi di `api/*.js` + cross-check [daun_merah_vendor.md](daun_merah_vendor.md), lalu verifikasi live 4 endpoint dari mesin lokal: CFTC ✅, TradingView ✅, Polymarket ❌ (diblokir Kominfo/Internet Positif dari jaringan Indonesia — redirect `internet-positif.info`; produksi Vercel tidak terpengaruh), CME ❌ (403 Akamai, IP lokal juga diblokir seperti IP Vercel).

### Grup A — Zero-cost: field sudah ada di response yang kita fetch, tapi dibuang

1. **CFTC COT (`feeds.js` cotHandler) — TERVERIFIKASI LIVE.** Blok teks yang sudah kita download & parse juga memuat baris `Open Interest is X` **dan** baris `Percent of Open Interest Represented by Each Category of Trader` (persentase per kategori sudah dihitung CFTC). Saat ini kita hanya ambil AM/Lev long-short-net + perubahan mingguan. Net sebagai % of OI = normalisasi ekstremitas standar (net 50k kontrak beda makna saat OI 200k vs 700k). Nol fetch tambahan.
2. **TradingView calendar (`calendar.js`) — TERVERIFIKASI LIVE.** Event object punya field yang tidak kita ambil: `actualRaw`/`forecastRaw`/`previousRaw` (angka mentah → **beat/miss bisa dihitung numerik** tanpa parsing string berformat), `period` (mis. "Jun" — menghilangkan ambigu rilis bulan apa), `comment` (penjelasan 1 kalimat indikatornya — bahan tooltip), `referenceDate`, `category`, `ticker`.
3. **Polymarket Gamma (`admin.js` polymarket handler) — PERLU VERIFIKASI VIA PRODUKSI.** Kita hanya ambil level probabilitas + volume; response `/markets` kemungkinan besar juga berisi `oneDayPriceChange`/`oneWeekPriceChange` + `liquidity`. Momentum ("prob turun 62→48 semalam") justru sinyal paling berharga dari prediction market — level saja tidak menunjukkannya. Verifikasi field harus dari IP non-Indonesia (endpoint diblokir Kominfo dari lokal).
4. **CME FedWatch (`rate-path.js`) — masalah parsing, bukan fetch.** (a) Meeting yang tidak ketemu di response **difabrikasi 50/50** (`prob_hold: 0.5, prob_cut25: 0.5`) dan tampil seolah data pasar — harusnya ditandai null/absen. (b) Response FedWatch aslinya berisi distribusi bucket penuh (termasuk ±50bp) yang kita kempiskan jadi 3 kategori ±25bp. Konfirmasi bentuk penuh butuh 1 credit ScraperAPI (tidak bisa dites dari lokal, 403).

### Grup B — Butuh call baru, murah, high-signal (bukan noise)

1. **FRED `RRPONTSYD` (Reverse Repo).** Kartu likuiditas sekarang cuma WALCL (Fed assets) + WDTGAL (TGA). Formula net liquidity standar = WALCL − TGA − **RRP** — tanpa RRP, drain TGA yang diserap RRP terbaca keliru. 1 call FRED tambahan di `fetchLiquidityIndicators()`, TTL sama.
2. **ECB SPF via ECB Data API.** `INFLATION_EXPECTATIONS.EUR` di `real-yields.js` hardcode dengan refresh manual kuartalan; ECB Data API (yang sudah kita pakai untuk yield) juga mem-publish seri SPF → EUR bisa otomatis, menghapus 1 dari 7 titik maintenance manual. (6 mata uang lain tetap hardcode — surveinya memang tanpa API.)
3. **COT percentile jangka panjang.** `cot_history` internal baru 90 hari — terlalu pendek untuk klaim "positioning ekstrem". CFTC menyediakan file historis tahunan lengkap → fetch mingguan bisa hitung persentil ~3 tahun ("Lev net USD di persentil 95"). Effort sedang.

### Grup C — Sengaja TIDAK disarankan (noise / bertentangan keputusan lama)

- Seri makro FRED tambahan (CPI, retail sales, dll) sebagai sinyal — bertentangan prinsip labour assessment ("konteks bukan sinyal") dan keputusan STOP riset NFP.
- Polymarket CLOB/order book — presisi berlebih untuk fungsi konteks sentimen.
- Yahoo interval <1h historis — scope per-jam sudah keputusan sadar (lihat komentar `_ohlcv_fetch.js`).
- Barchart — bukan untuk digali, justru kandidat cleanup: `call_iv`/`put_iv` kini sudah didapat dari CVOL (0 credit), `BARCHART_API_KEY` tak pernah di-set, path ~40 baris mati dalam praktik. Dipertahankan hanya kalau mau tetap ada fallback terdokumentasi.

### Vendor yang sudah terkuras habis (tidak ada sisa bernilai tanpa noise)

CME CVOL (dikuras tuntas sesi 157 lanj. 6–7: skew, upvar/dnvar, skewPercentChange, cvolPrice, convexInd — semua dari 1 response), FinancialJuice RSS (title/desc/link/date = semua isi RSS), Yahoo OHLCV + VIX/VIX1M/VIX3M term structure, Binance PAXG, Stooq MOVE, scrape 6 bank sentral (deliberate minimal — makin banyak field makin rapuh), ForexFactory XML (semua field diambil), RSS lain (InvestingLive/ActionForex/ING/Fed/ECB/BIS — headline memang isinya), rss2json & ScraperAPI (proxy murni), Telegram/WebPush (kanal keluar).

---

## Changelog Session 158 lanjutan 5 (2026-07-12) — Kartu "Distribusi Berita" Jadi Drawdown Toggle

**Konteks:** user minta kartu distribusi berita di tab NEWS dibuat seperti drawdown/accordion: bisa ditekan untuk membuka jumlah distribusi, ditekan lagi untuk menutup, dan saat reload kondisi awal harus tersembunyi.

**Perubahan di [index.html](../index.html):**
- `.news-dist-card` sekarang punya state `collapsed` default, jadi detail jumlah kategori tersembunyi saat halaman pertama kali dibuka atau reload.
- Ditambah header interaktif (`.news-dist-head` + tombol `Buka/Tutup`) yang memanggil `toggleNewsDist()`.
- Saat dibuka, baris statistik tetap memakai hitungan yang sama dari `updateStats()`; saat ditutup, yang terlihat hanya judul kartu.

**Catatan perilaku:** state ini sengaja tidak dipersist ke storage, jadi reload selalu kembali ke kondisi tertutup seperti yang diminta.

**Diverifikasi:** perubahan markup, CSS, dan handler sudah disambungkan ke kartu yang sama dengan stat bar lama, tanpa mengubah logika hitung distribusinya.

## Changelog Session 158 lanjutan 4 (2026-07-12) — Audit Filter Kategori vs Feed FJ ASLI: Fallback 27/100 → 2/100

**Konteks:** setelah deploy lanjutan 3, user menangkap kelolosan nyata di production: "EUR/AUD/JPY/GBP/CHF/NZD/CAD CFTC Positions Week Ended July 7th" semua ke-tag MACRO (harusnya FOREX), plus "MOC Imbalance" dan "US State Dept: Rubio spoke with Saudi Foreign Minister" juga MACRO. Akar masalah: semuanya **fallback** — nol keyword yang match, dan default fallback memang 'macro'. Pelajaran metodologis: verifikasi lanjutan 3 pakai korpus sintetis (headline yang saya karang), bukan feed asli — jenis headline khas FJ (rilis positioning per-ticker, insiden maritim UKMTO/Centcom, diplomasi Teluk) tidak terwakili.

**Metode kali ini:** tarik **feed FinancialJuice production asli** (100 headline live), klasifikasikan semua, audit khusus item ber-skor nol. Hasil awal: **27/100 fallback** + 1 salah kategori nyata ("Iran's foreign minister … U.S. treasury secretary breaching …" → bonds via `treasury`).

**Perluasan tabel [newscat.js](../newscat.js) (semua dites):**
1. **Kode ISO mata uang bare → forex:** `usd`,`eur`,`gbp`,`jpy`,`aud`,`nzd`,`chf`,`cad` + ~20 minor (`mxn`,`zar`,`krw`,`idr`,…) — aman sekarang karena word-boundary. Yang ambigu sengaja di-skip: `try`/`won`/`rub`/`cop`/`all` (kata Inggris biasa). Ini yang membuat "EUR CFTC Positions" → forex.
2. **Ticker futures CFTC lain per asset class:** `zn`/`zt`/`zb`/`zf` → bonds; `nq`/`ym`/`rty`/`e-mini*`/frasa `es cftc` (ES bare terlalu ambigu) → equities; GOLD/Copper/WTI/DXY/BTC sudah tertangkap keyword lama.
3. **`moc`/`moc imbalance`/`market wrap`/`vix` → equities.**
4. **Insiden militer/maritim & diplomasi → geopolitical:** `ukmto`, `centcom`, `irgc`, `armed forces`, `navy`/`naval`/`warship*`/`vessel*`, `airspace`, `air defense*`, `siren*`, `explosion*`/`blast*`, `hostile`, `intercept*`, `security alert*`, frasa `strikes on`/`military strike*`; negara Teluk & aktor yang hilang: `saudi*`,`kuwait*`,`qatar*`,`bahrain*`,`oman*`,`uae`,`yemen`,`syria*`,`iraq*`,`turkey`,`pakistan*`,`mexico*`; pejabat/institusi: `state department`/`rubio`/`secretary of state`, `foreign minister*`/`foreign ministry`, `netanyahu`,`idf`,`lavrov`,`peskov`,`kim jong un`, `senate`,`congress`,`parliament*`, `trade pact*`/`trade talk*`.
5. **Fix salah kategori pejabat fiskal:** `treasury secretary` (bobot 2) + `bessent` + `finance minister*` → macro, menang atas `treasury` (bobot 1, bonds); headline Iran-nya sendiri kini geopolitical (skor iran*+foreign minister* lebih tinggi).
6. Kecil: `fitch`/`moody's`/`credit rating*` → bonds; `aramco`/`natgas`/`oil depot*` → energy; `sugar`/`oats`/`cattle`/`hogs` → commodities; `philly fed`/`empire state`/`budget deficit` → econ-data.

**Hasil re-audit feed asli yang sama:** fallback **27 → 2** (sisanya memang berita umum tanpa kategori jelas: pengangkatan ketua audit watchdog UK, pembukaan jembatan Kanada); semua CFTC positioning jatuh ke asset class-nya masing-masing; grup Hormuz shipping tetap energy (keputusan lama: `hormuz` = chokepoint energi — bukan regresi). Distribusi feed live: geopolitical dominan (70/100) karena memang isi feed-nya sedang krisis militer AS-Iran.

**Diverifikasi:** korpus test +16 kasus dari audit (total 55 test newscat), seluruh suite repo **258/258 hijau**; sintaks inline `<script>` bersih. Cache-buster naik serempak: `NewsCat.VERSION`/`?v=`/`NEWSCAT_VERSION`/`APP_VERSION` → `2026.07.12.2`.

**Catatan untuk perubahan keyword berikutnya:** jangan validasi pakai korpus karangan saja — jalankan juga audit feed asli (`fetch feed.ashx?xy=rss` → klasifikasikan → periksa yang skor nol), lalu tambahkan temuan ke korpus `test/newscat.test.js` sebelum ubah keyword.

---

## Changelog Session 158 lanjutan 3 (2026-07-12) — Perombakan Total Filter Kategori NEWS: Engine `newscat.js` (Word-Boundary + Scoring, Single Source of Truth)

**Konteks:** eksekusi "item terbuka" dari entry sebelumnya — bug `detectCat()` substring-tanpa-boundary (repro nyata user: headline shipping Selat Hormuz ke-tag ECON DATA karena "ppi" ⊂ "shi**ppi**ng"). User minta perbaikan menyeluruh: "cek segala kemungkinan agar berita memang layak ke kategori ini", bebas pilih pendekatan. Investigasi menemukan masalahnya lebih luas dari satu fungsi: ada **4 klasifikator keyword terpisah yang saling drift** — `detectCat()` di [index.html](../index.html) (paling lengkap), salinan berbeda di [sw.js](../sw.js) (notifikasi background), salinan berbeda lagi di [api/market-digest.js](../api/market-digest.js) (grouping headline untuk prompt AI Ringkasan), dan `detectPushCat()` di [api/admin.js](../api/admin.js) (filter push device/Telegram, keyword di `_push_keywords.js`) — semuanya `t.includes(k)` polos. False positive sistemik yang terdokumentasi: "shipping"→`ppi`→econ-data, "Goldman"→`gold`→commodities, "turmoil"→`oil`→energy, "software"/"warning"→`war`→market-moving, "Boeing"→`boe`→macro, "Bundesbank"→`bund`→bonds, "won (menang)"→`won`→forex, "Taiwan Strait"→`strait`→energy.

**Keputusan pendekatan:** rule-based engine yang di-test, BUKAN model ML — konsisten prinsip plan G ("kalau bisa dihitung pasti di kode, hitung di kode"), zero dependency, zero latency, bisa jalan identik di browser+SW+Node, dan setiap keputusan kategorinya bisa diaudit. Preseden internal: `kwTest()` di `_cb_keywords.js` sudah lebih dulu pakai `\b` word-boundary untuk masalah yang sama.

**1. Library baru [newscat.js](../newscat.js) (root repo, UMD) — single source of truth:** satu file dipakai 4 konsumen: `<script src="/newscat.js?v=…">` di index.html (`window.NewsCat`), `importScripts` di sw.js (dibungkus try/catch + typeof-guard fallback 'macro' supaya SW tidak mati kalau fetch gagal), `require('../newscat')` di market-digest.js & admin.js (Vercel nft otomatis bundle relative require). Isinya:
- **Mini-DSL keyword → RegExp:** `'stock'` → `\bstock(?:e?s)?\b` (boundary dua sisi + plural otomatis, match "stocks" TANPA kena "stockpile"); plural `-y`→`-ies` (`'treasury'` match "treasuries"); wildcard eksplisit `'iran*'` (match "Iranian" — prefix match harus ditulis sadar, bukan efek samping); notasi pair FX `'eur/'`/`'/usd'` (sisi slash terbuka); metachar di-escape (`'opec+'`, `'s&p'`). Apostrof otomatis jadi boundary ("Fed's" tetap match `'fed'`).
- **Normalisasi tipografi feed:** kutip melengkung/dash panjang/spasi ganda disamakan dulu sebelum match (pelajaran dari insiden PDF session 157).
- **Scoring berbobot antar kategori, bukan first-match-wins:** semua kategori dihitung skornya (frasa multi-kata & notasi pair berbobot 2, kata tunggal 1), skor tertinggi menang, seri jatuh ke urutan prioritas lama (perilaku headline satu-topik tidak berubah). Efek: "Trump: China tariffs will rise" → geopolitical (skor 3) walau menyebut steel; "US debt ceiling standoff" → macro (`debt ceiling` bobot 2 di macro) bukan bonds (`debt` bobot 1).
- **Hard rule dipertahankan di depan:** format rilis kalender (Actual + Forecast/Previous) SELALU econ-data (keputusan session 135); marker urgensi eksplisit (BREAKING, urgent, trading halt, circuit breaker, market turmoil, …) SELALU market-moving.
- **Kurasi keyword:** `'war'` DIPINDAH dari market-moving ke geopolitical (dulu cuma "kerja" karena substring, dan ikut menjerat "warning"/"software"); `'won'`→`'korean won'`, `'rand'`→`'south african rand'`, `'strait'` bare dibuang (cukup `'hormuz'`; "Taiwan Strait" kini geopolitical), `'sentiment'` bare dibuang; tambahan yang hilang: `'bundesbank'`, `'btp'`, `'jgb'`, varian `'cut rates'`/`'hike rates'` (urutan kata kebalikan `'rate cut'`), dsb.

**2. Empat konsumen dipangkas jadi pemanggil tipis:** index.html & sw.js → wrapper `detectCat()` 1 baris + typeof-guard; market-digest.js → require langsung (salinan lokal ~20 baris dihapus); admin.js `detectPushCat()` → daftar `_push_keywords.js` tetap (tuning kebisingan push sengaja beda dari filter feed) tapi dikompilasi lewat engine yang sama, plus hard rule kalender ditambahkan (tanpa itu "Korea Trade Balance Actual …" nyangkut di geopolitical via `korea*`). `_push_keywords.js` dimigrasi ke DSL: trailing-space trick lama (`'fed '`, `'qe '`) dihapus, wildcard eksplisit (`'iran*'`, `'korea*'`, `'ukrain*'`, `'sanction*'`, `'refiner*'`), + marker halt/urgent disamakan dengan feed.

**3. Infra:** `vercel.json` header `Cache-Control: no-cache` untuk `/newscat.js`; cache-buster `?v=` di index.html & sw.js (`NEWSCAT_VERSION`, naikkan tiap newscat.js berubah); `APP_VERSION` → 2026.07.12.

**Diverifikasi:**
- Test baru [test/newscat.test.js](../test/newscat.test.js) — 39 test, 3 lapis: engine (boundary/plural/wildcard/pair/normalisasi), korpus headline gaya FJ (semua false positive terdokumentasi + regresi perilaku lama per kategori + hard rule), dan `detectPushCat` (diekspor dari admin.js). Total suite repo **242/242 hijau**.
- Simulasi korpus 40 headline realistis campuran (rilis kalender, CB, forex, energi, geopolitik, jebakan substring) — semua jatuh ke kategori yang layak; sweep regresi false-positive bersih (mis. "Warsaw stock exchange" → equities bukan market-moving, "Investors won over by earnings" → equities bukan forex).
- Jalur non-Node diverifikasi via `vm.createContext` (emulasi `self` browser/SW): UMD mendaftar `NewsCat` global dengan benar; `node --check` bersih untuk semua file yang diubah.
- **Belum diverifikasi di browser sungguhan** (kendala sandbox yang sama — tidak ada chromium). Yang perlu dicek user di production: badge kategori di tab NEWS + kartu "Distribusi Berita" masuk akal, dan push notif masih terkirim (cron `?action=push`).

---

## Changelog Session 158 lanjutan 2 (2026-07-12) — Stat Bar NEWS Jadi Kartu "Distribusi Berita" + Ikut Hitung Load-More

**Konteks:** user tanya apakah stat bar 6-angka (Total/Mkt Moving/Forex/Macro/Energy/Geopolit.) di atas tab NEWS itu perlu. Setelah diskusi objektif ditemukan 2 masalah nyata: (1) tampilannya angka mentah nempel langsung di bawah header tanpa label/konteks; (2) begitu fitur load-more (entry sebelumnya) dipakai, angkanya jadi bohong — `updateStats()` cuma hitung `allItems` (100 item live), tidak ikut `historyItems`. User sempat juga curiga soal **akurasi kategorinya sendiri** (apakah GEOPOLIT. beneran isinya berita geopolitik) — dicek dan terbukti benar ada bug: `detectCat()` di [index.html:3784-3791](../index.html#L3784-L3791) pakai `.includes()` tanpa word-boundary, jadi keyword pendek nyangkut di substring kata lain (**contoh reproduksi nyata dari user**: headline soal kapal di Selat Hormuz ke-tag "ECON DATA" karena kata "ppi" — keyword econ-data buat Producer Price Index — kebetulan jadi substring dari "shi**ppi**ng"). **Perbaikan kategorisasi ini SENGAJA TIDAK dikerjakan** — user eksplisit mau delegasikan "tugas filter news" itu ke model/AI lain terpisah; scope sesi ini cuma 2 hal di bawah.

**1. Restyle jadi kartu berlabel — [index.html](../index.html):** `.stats-bar` (flat, full-bleed, tanpa judul) diganti `.news-dist-card` — kartu bordered dengan judul kecil uppercase **"Distribusi Berita"** di atasnya, gaya konsisten dengan caption "Max Drawdown: X.XXR" di panel equity curve Jurnal (referensi eksplisit dari user). Class `.stat`/`.stat-val`/`.stat-label` di dalamnya dipertahankan, id `statsBar` dipertahankan di wrapper (kompatibel dengan `setFeedUI()` yang toggle `display` via ID). Dua selector responsive (`@media 768px`/`480px`) yang tadinya target `.stats-bar .stat` ikut di-rename ke `.news-dist-card .stat`.

**2. Fix hitungan supaya ikut load-more — [index.html](../index.html) `_combinedNewsItems()`:** helper baru (dipakai bareng `renderFeed()` dan `updateStats()`) — gabung `allItems + historyItems` dengan dedupe by guid (guard yang sama dipakai `renderFeed()` sejak fitur load-more). `updateStats()` sekarang hitung dari gabungan ini, dan dipanggil ulang di `loadMoreHistory()` (sebelumnya cuma `renderFeed()` yang dipanggil ulang, stat bar tidak update sama sekali setelah klik "Muat Berita Lebih Lama").

**Diverifikasi:**
- CSS brace balance 1214/1214, inline `<script>` syntax check bersih (`new Function()`), test suite tetap 203/203 hijau (tidak ada test yang menyentuh stat bar/kategori — murni UI, tidak ada regresi logic lain).
- Simulasi manual `_combinedNewsItems`/`updateStats` di Node: total naik benar setelah simulasi load-more (2→4 untuk 3 item baru + 1 duplikat guid yang benar-benar ke-exclude), breakdown per-kategori ikut update.
- **Belum diverifikasi di browser sungguhan** — kendala sandbox yang sama (Redis/`APP_KEY` Sensitive-masked, `chromium-cli` tidak ada).

**Item terbuka (bukan tugas sesi ini):** bug `detectCat()` substring-tanpa-boundary di atas — akan dikerjakan lewat AI/model lain sesuai arahan user. Lihat juga pola serupa yang sudah pernah diperbaiki di `kwTest()` (`api/_cb_keywords.js`) yang secara sengaja pakai `\b` word-boundary untuk keyword satu kata — pola yang sama bisa dicontoh untuk `detectCat()`/`CATS` kalau nanti dikerjakan.

---

## Changelog Session 158 lanjutan (2026-07-12) — Tab NEWS: "Muat Berita Lebih Lama" (Load-More Read-Only atas Archive 36 Jam)

**Konteks:** lanjutan diskusi entry sebelumnya (evidence trail CB bias) — user tanya apakah headline 36 jam yang sudah disimpan di Redis bisa dijadikan fitur lihat "berita kemarin". Setelah beberapa putaran klarifikasi (user secara eksplisit menahan eksekusi awal saya yang kebablasan menaikkan retensi ke 7 hari + nyimpan isi lengkap semua berita — dikoreksi user, lalu disepakati versi final yang jauh lebih sederhana), disain final: **load-more murni tampilan, nol perubahan ke window/retensi/perilaku AI.**

**1. Endpoint baru read-only — [api/feeds.js](../api/feeds.js) `newsHistoryHandler` (`type=news_history&before=<ms>&limit=100`):** pagination mundur atas `news_history` (Redis, sudah ada, dipakai bareng Call 2 CB bias) via `ZREVRANGEBYSCORE key (before -inf LIMIT 0 <limit>` — cursor eksklusif, urutan terbaru-dulu per halaman. **Retensi TETAP 36 jam, tidak diubah** — `market-digest.js` (AI) baca key yang sama dengan cutoff 36 jam miliknya sendiri, terpisah total dan sama sekali tidak disentuh perubahan ini.

**2. `parseRSSItems` — description disimpan untuk SEMUA headline, bukan cuma CB/option-expiry:** perubahan session 158 sebelumnya membatasi `<description>` cuma untuk headline bank sentral & option-expiry (demi hemat storage). User klarifikasi: load-more ini untuk baca isi berita juga (bukan cuma judul kosong), jadi gate `isCbHeadline()` di titik ini dibuang — semua item sekarang bawa `description` kalau ada di XML sumber. Karena retensi tetap 36 jam (bukan naik ke 7 hari seperti rencana awal saya yang dibatalkan user), pertambahan storage-nya terbatas/wajar.

**3. UI tab NEWS — [index.html](../index.html):** tombol **"⌄ Muat Berita Lebih Lama"** di bawah list. Klik → tarik 100 headline lebih tua lewat endpoint baru, **ditambahkan** ke bawah (bukan replace) — `_feedItemHtml()` diekstrak jadi helper bersama dari `renderFeed()`'s inline map biar dipakai render item live maupun item archive. State (`historyItems`/`historyBefore`/`historyExhausted`) murni di memori browser, sengaja tidak dipersist — refresh halaman balik ke tampilan awal (behavior yang diminta eksplisit). Mentok ke ujung 36 jam → tombol berubah jadi pesan "— Sudah mencapai ujung arsip berita (36 jam) —". Live-poll (AUTO refresh) tidak menghapus histori yang sudah di-load — `renderFeed()` selalu re-gabung `allItems + historyItems` (dengan dedupe by guid, guard kalau feed live kebetulan menarik ulang guid yang sudah ada di histori). Load-more disembunyikan saat filter kategori aktif (arsip tidak dipisah kategori server-side, jadi hanya ditawarkan di tab "All").

**Diverifikasi:**
- `node -e "require(...)"` bersih, inline `<script>` (satu blok, seluruh app) lolos syntax check via `new Function()`.
- Test suite **203/203 hijau** (190 sebelumnya + 8 evidence-trail + 5 baru di [test/news_history.test.js](../test/news_history.test.js)): `parseRSSItems` simpan description untuk headline non-CB, pagination 2-halaman tanpa overlap/kehilangan data sampai archive habis (mock Redis dengan `ZREVRANGEBYSCORE`+`LIMIT`, pola sama seperti test retail_history existing), `before` tidak valid → 400, `limit` di-cap 100 meski diminta lebih besar. Sempat ketemu & diperbaiki 1 bug di mock test-nya sendiri (ZADD multi-pair cuma kebaca 1 pasang) — bukan bug di kode produksi.
- Simulasi manual `_feedItemHtml`/`loadMoreHistory` logic di Node: dedupe guid antara `allItems` dan `historyItems` bekerja benar, item tanpa description tetap render title-only tanpa error, flag `historyExhausted` berubah benar saat halaman kosong.
- **Belum diverifikasi di browser sungguhan** — kendala sama seperti entry sebelumnya (kredensial Redis/`APP_KEY` Sensitive-masked di sandbox ini, `chromium-cli` tidak tersedia). User disarankan coba klik "Muat Berita Lebih Lama" di tab NEWS langsung di production setelah deploy.

---

## Changelog Session 158 (2026-07-12) — CB Bias "Dasar AI" Jadi Evidence Trail Akumulatif + Simpan Description Headline

**Konteks:** user tanya soal tab kalender/dashboard CENTRAL BANKS — bias NZD "Hawkish" cuma didukung 1 headline "RBNZ Interest Rate Probabilities" di kotak "Dasar AI", yang isinya template judul tanpa sinyal arah sama sekali. Investigasi kode menemukan dua lapis masalah nyata, bukan sekadar tampilan:
1. `cb_bias.source_headlines` (Redis) **ditimpa penuh setiap siklus Call 2**, bukan diakumulasi — begitu headline substantif asli (mis. statement rapat RBNZ) keluar dari window `news_history` 36 jam, jejaknya hilang permanen dan digantikan headline generik apa pun yang kebetulan re-trigger keyword match siklus berikutnya. Bias-nya sendiri kemungkinan tetap akurat (mekanisme "PRIOR STANCE" di prompt mempertahankan bias lama kalau cuma dikonfirmasi ulang), tapi evidence yang ditampilkan ke user salah merepresentasikan alasannya.
2. Parser RSS (`parseRSS`/`parseRSSItems`) dari awal **cuma menyimpan `title`**, tidak pernah `<description>`, kecuali untuk headline "options expiry" (dipakai fitur lain). Jadi Call 2 (dan kotak "Dasar AI") memang tidak pernah punya lebih dari judul mentah untuk dianalisis.

**1. Shared keyword module — [api/_cb_keywords.js](../api/_cb_keywords.js) (baru):** `CB_KW`, `kwTest`, `isCbHeadline`, `stripHtml` dipindah dari `market-digest.js` ke modul bersama supaya bisa dipakai juga oleh `feeds.js` tanpa duplikasi/drift.

**2. Simpan description untuk headline CB-relevant (bukan cuma option-expiry) — [api/feeds.js](../api/feeds.js) `parseRSSItems()`, [api/market-digest.js](../api/market-digest.js) `parseRSS()` lokal:** headline yang match `isCbHeadline()` (bank sentral mana pun) sekarang ikut simpan `<description>` mentah, disaring lewat `stripHtml()` baru dipakai di titik konsumsi (bukan di titik simpan — jalur `options expiry` yang sudah ada tetap butuh HTML mentah untuk parsing `<li><strong>PAIR:</strong>...`, jadi tidak disentuh).

**3. Prompt Call 2 dapat konteks lebih dari sekadar judul — [api/market-digest.js](../api/market-digest.js) `biasHeadlines`:** tiap baris headline yang dikirim ke AI sekarang menyertakan snippet description (di-`stripHtml`, dipotong 200 char) kalau tersedia, bukan cuma judul.

**4. `source_headlines` jadi evidence trail akumulatif, bukan overwrite — [api/market-digest.js](../api/market-digest.js) `mergeSourceHeadlines()` (baru, diekspor untuk test):** format berubah dari array-of-string ke array-of-object `{title, description, matched_at}`. Tiap siklus, headline baru di-merge dengan `prevEntry.source_headlines` (dedupe by title, cap 8 entri, urutan terbaru dulu) — bukan ditimpa. Back-compat: entri lama format string (data Redis sebelum fix ini) dinormalisasi otomatis, baik di backend (`mergeSourceHeadlines`) maupun frontend (`cbToggleDetail`). Jalur `divergence_warning` SENGAJA tetap pakai list fresh (tidak di-merge) — itu bukti untuk sinyal pergeseran yang BELUM diadopsi, tidak boleh campur dengan trail bias yang sudah established.

**5. UI kotak "Dasar AI" — [index.html](../index.html) `cbToggleDetail()`:** tiap headline sekarang tampil dengan tanggal (`matched_at`, format `YYYY-MM-DD`) dan snippet description (kalau ada) di baris terpisah, CSS baru `.cb-hl-date`/`.cb-hl-desc`. Aman untuk XSS (tetap lewat `escHtml`) dan back-compat kalau `cb.source_headlines` masih format string lama.

**Diverifikasi:**
- `node -e "require(...)"` bersih untuk ketiga file backend (tidak ada syntax/require error).
- Test suite penuh **198/198 hijau** (190 lama + 8 baru di [test/cb_bias_evidence.test.js](../test/cb_bias_evidence.test.js)): reproduksi persis skenario NZD (headline lama format-string dipertahankan saat siklus baru cuma nemu headline generik), dedupe judul identik (versi fresh dengan description menang), cap 8 entri prioritas terbaru, `prevList` kosong/undefined/null tidak crash, `isCbHeadline` & `kwTest` konsisten (word-boundary "orr" vs "worrying"), `stripHtml` aman untuk null/HTML/plain text, dan `CB_KW` tidak kehilangan mata uang saat dipindah ke modul shared.
- Simulasi manual render `cbToggleDetail` di Node (bukan browser sungguhan): headline string lama, object baru dengan description+tanggal, XSS payload di title, dan array kosong — semua render sesuai ekspektasi tanpa crash.
- **Belum diverifikasi:** live browser test tidak bisa dilakukan dari sandbox ini — kredensial Redis/`APP_KEY` di Vercel ditandai *Sensitive* (selalu kosong lewat `vercel env pull`, lihat catatan lama soal ini) dan `chromium-cli` tidak tersedia di environment. Perubahan bentuk data `source_headlines` baru akan benar-benar terlihat di UI production setelah siklus Call 2 berikutnya jalan (tombol "Ringkas Berita" atau cron) — user disarankan cek tab dashboard CENTRAL BANKS → ⓘ setelah itu.

---

## Changelog Session 157 (2026-07-11) — Dokumentasi Baru: Pemakaian AI + Inventaris Vendor

**Konteks:** permintaan user untuk dua dokumen referensi baru terpisah dari `daun_merah.md` yang sudah sangat panjang: `daun_merah_ai.md` (khusus AI — limit detail + estimasi "paling banyak dipakai berapa kali", bahasa sederhana) dan `daun_merah_vendor.md` (semua vendor/layanan eksternal, AI maupun bukan).

**[daun_merah_ai.md](daun_merah_ai.md)** — disusun dari pembacaan langsung kode (`api/market-digest.js`, `api/admin.js`, `api/journal.js`, `api/_ai_guard.js`), bukan asumsi:
- Peta 4 fitur AI (Ringkasan Berita, Analisa AI per Pair, Analisa Fundamental, AI Coach Jurnal): tombol, trigger otomatis, cache, rate limit.
- **Temuan penting saat penyusunan:** dugaan awal (Nemotron 3 Ultra via OpenRouter jadi primary Call 1/2/3) TERNYATA SALAH — kode menunjukkan Nemotron **didemote dari jalur produksi** (session 145 lanjutan 4, 4/4 tes live gagal), SambaNova kembali jadi primary asli. OpenRouter (45/hari) dan Ollama Cloud (150/hari) saat ini **idle** — nyaris tidak terpakai kecuali dites manual via `?test_nemotron=1`. Draft awal dokumen sempat menulis rantai fallback yang salah, dikoreksi sebelum difinalkan.
- Rantai fallback provider yang benar per fitur, tabel jatah harian per pool (`_ai_guard.js` `DEFAULT_LIMITS`), dan identifikasi **SambaNova akun-1** sebagai pool paling ramai (dipakai primary oleh 2 fitur sekaligus: Ringkasan Berita Call 2/3/4 DAN Analisa AI per Pair).
- Estimasi pemakaian harian dalam bahasa sederhana: Ringkasan Berita manual ±97×/hari (kalau sendirian), Analisa AI per Pair ±60-75×/hari, Analisa Fundamental **maksimal mutlak 4×/hari** (cache global 6 jam, tanpa tombol paksa refresh), kombinasi akun-1 di hari ramai ±100-125 dari jatah 200/hari.

**[daun_merah_vendor.md](daun_merah_vendor.md)** — inventaris lengkap via grep `process.env.*` di seluruh `api/*.js` + `.github/workflows/*.yml`:
- Infrastruktur inti (Vercel, GitHub Actions cron, Upstash Redis), AI providers (ringkas, cross-ref ke daun_merah_ai.md), data makro/bank sentral (FRED, ECB, BoE/BoJ/BoC/RBA/RBNZ/SNB, CFTC, CME, Barchart, Polymarket), data harga (Yahoo Finance, Binance, Stooq, TradingView), proxy (ScraperAPI), RSS/berita (FinancialJuice, InvestingLive, ActionForex, dll), notifikasi (Telegram, VAPID).
- **Temuan:** daftar env var lama di § Environment (blok "Stack" di bawah) sudah tidak lengkap — tidak menyebut `SCRAPER_API_KEY`, `BARCHART_API_KEY`, `APP_KEY`, atau env var AI selain `GROQ_API_KEY`. Daftar terlengkap sekarang ada di daun_merah_vendor.md §8.
- **ScraperAPI** teridentifikasi sebagai satu-satunya vendor berbayar murni di seluruh app (proxy residential IP untuk bypass blokir Akamai WAF milik CME Group).

**Tidak ada perubahan kode** — murni dokumentasi baru berdasarkan audit kode yang sudah ada.

---

## Changelog Session 157 lanjutan 15 (2026-07-11) — Download PDF Langsung via jsPDF + Rapihkan Label Jam Analisa

**Konteks:** user lapor nama file "Save as PDF" tetap kosong walau sudah ada trik `document.title` (lanjutan 14) — ternyata bukan bug kode kita: dialog di screenshot user adalah **"Microsoft Print to PDF"** (driver printer Windows), bukan destination "Save as PDF" bawaan Chrome. Windows 11 memang menghapus fitur auto-nama-file untuk driver itu (dikonfirmasi via web search, bug Microsoft, bukan hal yang bisa diperbaiki dari sisi web/JS). Solusi yang dipilih user: skip printer/dialog OS sama sekali, download PDF langsung — opsi jsPDF (vector text asli, bukan screenshot) dipilih di atas html2pdf.js (screenshot-based) karena dokumen resmi ini idealnya teksnya bisa di-select/copy.

**1. Download PDF langsung — [index.html](../index.html):**
- Library `jsPDF 2.5.2` dimuat via CDN (`jsdelivr`), satu-satunya dependency eksternal baru di app ini selain Google Fonts.
- `_pdfBuilder()`: builder kecil di atas jsPDF — letterhead (brand + judul + meta), heading/subheading, paragraf ber-justify + auto page-break, key-value block, box KESIMPULAN bergaris tepi, footer disclaimer. Font Times (serif bawaan jsPDF, padanan Georgia versi print lama, tanpa perlu embed font custom), tetap monokrom sesuai keputusan lama user ("JANGAN ADA WARNA" di dokumen resmi).
- `downloadRingkasanPdf()` & `downloadAnalisaPdf()`: compose ulang dari data cache (`ringkasanCache` / `analisaDataCache` / `analisaAiCache`) langsung ke PDF — bukan screenshot dari DOM. Ringkasan PDF sekarang eksplisit menyertakan **"Ringkasan dibuat: HH:MM WIB"** di letterhead (permintaan user), terpisah dari "Diunduh: [waktu sekarang]". Analisa PDF menyertakan "Dianalisa: HH:MM WIB", harga saat data, dan sumber (teknikal/makro/fundamental).
- Tombol "Cetak PDF" (3 lokasi: 2× Ringkasan, 1× Analisa) diganti jadi "Download PDF" — `onclick` ke fungsi baru, ikon SVG printer diganti ikon download panah-bawah. `doc.save(filename)` trigger download langsung dari browser, sama sekali tidak lewat dialog print/OS — menghilangkan bug filename kosong secara total.
- Alur `window.print()` lama (letterhead print, CSS `@media print`, hook Ctrl+P) **tetap dipertahankan apa adanya** sebagai fallback buat yang tetap mau print fisik via Ctrl+P — cuma tidak lagi terhubung ke tombol utama.

**2. Rapihkan baris meta Analisa AI (on-screen) — [index.html](../index.html):**
- Baris `AI · model · sumber · (cached) · di analisa jam HH:MM` sebelumnya semua bagian sama besar/tebal (9-10px bold uppercase), padat dan berat dibaca. Sekarang dipisah 2 tingkat: **primer** ("AI · model · sumber", tanpa qualifier umur) tetap bold-uppercase-accent 9px; **sekunder** (umur ringkasan makro, status cache, jam analisa — digabung jadi `.analisa-ai-meta`) dikecilkan ke 8px, non-kapital, warna muted, lebih ringan dibanding sekelilingnya (permintaan eksplisit user: "kecilin bagian yang kurang dilihat").
- Helper `_makroAgeLabel(makroAt)` diekstrak (dipakai bareng oleh baris meta on-screen & letterhead PDF Analisa) — hilangkan duplikasi logic umur makro yang sebelumnya ada 2x.

**Diverifikasi:**
- `node --check` bersih (extract inline `<script>`, 518KB), CSS balanced (1204/1204 brace), test suite 190/190 hijau (1 test lama `_renderStructuredAi` sempat merah gara-gara dependency baru ke `_makroAgeLabel` belum di-extract di test — [test/esc_html.test.js](../test/esc_html.test.js) diperbaiki).
- Smoke test terpisah (Node + paket `jspdf` npm sementara, `--no-save`, dihapus lagi setelah tes): jalankan `downloadRingkasanPdf`/`downloadAnalisaPdf` versi persis dari index.html dengan data mock realistis (thesis, thesis alert, artikel FX+XAU dengan tag, structured AI bias mixed + KESIMPULAN) — kedua fungsi menghasilkan PDF valid (`%PDF` magic bytes, >7KB, teks vector asli ketemu secara literal di content stream: "DAUN MERAH", "KESIMPULAN", "EUR/USD", dst — bukan gambar), filename match format `ringkasan_DD-MM-YYYY_HH-mm.pdf` / `analisa_...`. Edge case data kosong: toast muncul, tidak crash, tidak ada file ke-save.

---

## Changelog Session 157 lanjutan 16 (2026-07-11) — Fix Bug Spasi-Antar-Huruf di PDF (justify jsPDF dibuang)

**Konteks:** user langsung coba download PDF hasil lanjutan 15 (screenshot PDF asli, bukan simulasi) — ketemu bug visual nyata: paragraf tertentu (contoh: bagian "Korelasi" di Ringkasan XAU) tampil dengan **spasi antar-HURUF melebar parah** ("A n o m a l i   k o r e l a s i..."), bukan cuma spasi antar-kata yang wajar untuk teks rata kanan-kiri.

**Root cause:** `_pdfBuilder().para()` pakai `doc.text(line, x, y, { maxWidth, align: 'justify' })` bawaan jsPDF untuk efek rata kanan-kiri ala dokumen resmi. Implementasi justify jsPDF 2.5.2 ternyata meregangkan named-width lewat operator PDF `Tz`/`Tc` yang mendistribusikan sisa lebar ke **setiap karakter**, bukan cuma ke spasi antar-kata — di baris pendek/sedikit kata jadi terlihat rusak parah. Dikonfirmasi lewat inspeksi content stream PDF asli: versi lama pakai `Tz`/`Tc`, sedangkan `doc.text()` polos (tanpa `align`) cuma pakai `Tj` biasa.

**Fix — [index.html](../index.html):** opsi `justify` dibuang total dari `para()` di `_pdfBuilder()` — semua paragraf PDF (Ringkasan & Analisa) sekarang rata kiri (ragged-right) polos, bukan full-justify. Tiga call-site (`{ justify: true }` di artikel FX/XAU dan komentar Analisa) ikut dibersihkan.

**Diverifikasi:** `node --check` bersih, test suite 190/190 hijau, inspeksi langsung content stream PDF hasil generate (jsPDF npm sementara, `--no-save`) — konfirmasi tidak ada lagi operator `Tz`/`Tc` di teks paragraf, cuma `Tj` polos.

---

## Changelog Session 157 lanjutan 17 (2026-07-11) — Kop PDF Pakai Warna Brand, Badan Tetap Monokrom

**Konteks:** setelah fix bug justify (lanjutan 16), user minta cek juga Analisa PDF punya bug spasi yang sama (sudah tercakup fix sebelumnya karena satu fungsi `para()` dipakai bareng, diverifikasi ulang), lalu usul: kop suratnya saja yang ikut warna primer brand, badan dokumen tetap monokrom.

**[index.html](../index.html):** `_pdfBuilder().letterhead()` — teks "DAUN MERAH" + garis pembatas kop sekarang pakai `BRAND_COLOR` (`#c0392b`, sama dengan `--accent` CSS di app), sementara judul dokumen, baris meta, dan seluruh badan (paragraf, thesis, kv, dst) tetap grayscale seperti sebelumnya. Ini konvensi kop surat resmi umum (identitas/logo berwarna, badan surat monokrom) — bukan pelanggaran aturan lama "JANGAN ADA WARNA" (itu soal badan dokumen). Berlaku otomatis untuk Ringkasan & Analisa karena satu builder yang sama.

**Diverifikasi:** `node --check` bersih, test suite 190/190 hijau, regenerate PDF asli (jsPDF npm sementara) + inspeksi content stream mentah — konfirmasi operator warna `0.753 0.224 0.169 rg`/`RG` cuma di teks "DAUN MERAH" & garis kop, judul/meta/isi tetap `g` (grayscale). Analisa PDF juga diregenerate ulang & dicek — tidak ada lagi operator `Tz`/`Tc`/`Tw` (bug justify lanjutan 16 sudah bersih di kedua fitur).

---

## Changelog Session 157 lanjutan 18 (2026-07-11) — Fix Karakter Tipografi Hilang di Footer Disclaimer PDF (Bukan Bug Spasi Baru)

**Konteks:** user lapor teks footer disclaimer PDF ("⚠ Ringkasan dihasilkan AI... Detail di tab PETUNJUK › Disclaimer.") tampak "merenggang". Bug ini beda akar dari lanjutan 16 (justify sudah dibuang total sejak itu).

**Root cause:** `pdfSafe()` (filter karakter sebelum ditulis ke jsPDF) meng-whitelist em/en dash (–—), kutip pintar (‘’“”), ellipsis (…), dan guillemet (‹›) sebagai "aman" karena resminya masuk WinAnsiEncoding/Windows-1252. Ternyata **asumsi ini salah** — dikonfirmasi lewat repro langsung (generate PDF asli via jsPDF npm sementara, inspeksi content stream mentah byte-per-byte): jsPDF 2.5.2 dengan font standar Times **membuang total** karakter-karakter itu dari string `Tj` (bukan cuma render glyph salah — karakternya lenyap), menyisakan celah/spasi ganda yang di layar kelihatan seperti teks renggang. Terverifikasi persis di teks disclaimer footer karena baris itu pendek dan padat memuat `—` dan `›` sekaligus, jadi celahnya paling kentara. Karakter Latin-1 murni (é, ñ, ü, °, dst, U+00A0–U+00FF) tetap aman, tidak kena masalah ini.

**Fix — [index.html](../index.html):** `_PDF_SYMBOL_MAP` ditambah mapping ke padanan ASCII (`–`/`—` → `-`, `‘`/`’` → `'`, `“`/`”` → `"`, `…` → `...`, `›`/`‹` → `>`/`<`); `_PDF_UNSAFE_RE` disempitkan jadi cuma ASCII (`\x00-\x7F`) + Latin-1 supplement (` -ÿ`) — karakter tipografi Windows-1252 di luar itu tidak lagi diklaim "aman" tanpa verifikasi render nyata.

**Diverifikasi:** test suite 190/190 hijau. Repro langsung 3 tahap pakai `jspdf` npm sementara (`--no-save`, dihapus lagi setelah tes — sempat kehapus bareng seluruh `node_modules` proyek karena `rm -rf` ceroboh, dipulihkan via `npm ci`, test suite dicek ulang hijau): (1) buktikan karakter dash/kutip/guillemet lenyap dari `Tj` string di font Times sebelum fix (bukan cuma di footer — berlaku semua paragraf, tapi paling kentara di baris pendek), (2) setelah fix, `pdfSafe()` pada teks disclaimer asli menghasilkan string ASCII bersih tanpa karakter hilang, (3) generate ulang PDF footer sungguhan — content stream `Tj` sekarang utuh, tidak ada celah/spasi ganda.

---

## Changelog Session 157 lanjutan 2 (2026-07-11) — Single-Flight Lock Market Digest + Label Jam Analisa

**Konteks:** diskusi lanjutan soal rate limit AI dari audit dokumentasi sebelumnya. User menanyakan kenapa tiap device generate ringkasan sendiri-sendiri padahal hasilnya sama untuk semua orang. Setelah dibahas (usulan "device admin" → disederhanakan jadi cache freshness gate → user menemukan celah: gate waktu doang tidak cegah burst request BERSAMAAN), solusi final: **single-flight lock** — pola yang sudah ada di `api/_fetch_lock.js` (dipakai untuk fetch XAU spot), sekarang diterapkan juga ke generate digest utama.

**1. Single-flight lock — [api/market-digest.js](../api/market-digest.js):**
- `lock:market_digest_generate` (Redis `SET NX EX 55`) dipasang tepat setelah rate limit check, sebelum RSS/calendar/Call 1-4 mulai. Request yang gagal dapat lock (karena ada request lain sedang generate ATAU baru saja selesai) langsung disajikan `latest_article` apa adanya (`from_cache: 'busy'`, `thesis_alerts: null`) — nol tambahan panggilan AI.
- **Beda dari `withSingleFlight()` generik**: helper itu didesain untuk fetch cepat (~1-2 detik, polling pendek cukup) — generate digest bisa sampai 45-55 detik, jadi di sini losers TIDAK polling sama sekali, langsung serve cache lama (bisa dari cron beberapa jam lalu). Lock TIDAK di-release manual — TTL 55 detik dibiarkan berfungsi ganda: mutex selama generate aktif + cooldown pendek setelah selesai.
- Cron dikecualikan total (selalu generate fresh, 3 jadwal berjam-jam terpisah, tidak pernah tabrakan).
- Edge case: kalau `latest_article` kosong total (cold start), request tetap lanjut generate walau lock dipegang — supaya user tidak dapat respons kosong.
- **Diverifikasi** via simulasi isolated (mock Redis, 3 skenario: lock kosong → lanjut generate; lock dipegang + ada cache → short-circuit; lock dipegang + cold start → tetap generate) — semua PASS. Test suite 190/190 tetap hijau, `node --check` bersih.

**2. Label "di analisa jam HH:MM WIB" — fitur Analisa AI per Pair:**
- `_renderStructuredAi()` ([index.html](../index.html)) dapat parameter baru `analyzedAt` (dari `resultPayload.loaded_at` yang sudah ada di `api/admin.js`, cuma belum pernah dikirim ke render) — ditampilkan di header hasil pakai `fmtCBTime()` yang sudah ada (reuse, bukan formatter baru).
- Berlaku di 3 jalur: klik manual "Analisa AI", auto-load XAU/USD dari cache cron, dan restore dari localStorage — device tahu persis kapan hasil yang dilihat benar-benar di-generate server, bukan cuma kapan browser menerimanya, terutama penting saat badge "(cached)" muncul.
- **Diverifikasi** via ekstraksi fungsi langsung dari `index.html` + 3 skenario test (fresh dengan jam, tanpa `analyzedAt` label tidak muncul, kombinasi cached+jam) — semua PASS.

---

## Changelog Session 157 lanjutan 3 (2026-07-11) — Koreksi Status Berbayar ScraperAPI & Barchart

**Konteks:** user menanyakan limit persis ScraperAPI (satu-satunya vendor yang ditandai "berbayar" di `daun_merah_vendor.md` §9). Saat dicek ke docs.scraperapi.com resmi + catatan lama project sendiri (Session 47, baris 3101 & 3113 dokumen ini), ketemu 2 klaim yang salah di draft `daun_merah_vendor.md` sebelumnya:

1. **ScraperAPI kemungkinan besar sebenarnya GRATIS, bukan berbayar.** Free tier resmi (dikonfirmasi docs.scraperapi.com): **1.000 credit/bulan permanen** (bukan cuma trial 7 hari), maks 5 concurrent connection. Pemakaian aktual app ini ~120-180 request/bulan (dicatat Session 47) = 12-18% dari jatah gratis — request-nya standar (tanpa `render`/geotargeting yang menambah biaya credit). Catatan lama Session 47 yang bilang "5.000 credits/bulan" kemungkinan mengacu ke jatah trial 7-hari, bukan jatah bulanan permanen (1.000) — tapi kesimpulannya sama: pemakaian jauh di bawah kapasitas gratis manapun.
2. **Barchart OnDemand sebenarnya BERBAYAR (enterprise), bukan gratis** — draft sebelumnya salah menyimpulkan "free (signup manual)" dari komentar kode, padahal Session 47 (baris 3113 dokumen ini) SUDAH mengonfirmasi lebih dulu "enterprise berbayar (bukan free)". `BARCHART_API_KEY` kemungkinan besar tidak pernah benar-benar di-set.

**Kesimpulan baru:** kemungkinan besar **tidak ada vendor berbayar yang aktif dipakai** di app ini — ScraperAPI di jatah gratisnya, Barchart path mati/tidak dipakai. Tidak bisa dipastikan 100% tanpa cek langsung dashboard billing ScraperAPI. §9 `daun_merah_vendor.md` ditulis ulang total untuk mencerminkan ini. **Pelajaran:** draft dokumentasi awal sempat menyimpulkan tier dari komentar kode ("free signup") tanpa cross-check ke catatan riwayat project sendiri yang sudah pernah verifikasi langsung — akan lebih hati-hati grep changelog lama dulu sebelum menulis klaim tier vendor.

---

## Changelog Session 157 lanjutan 4 (2026-07-11) — Fix Pemakaian ScraperAPI: TTL CVOL 1h→6h + Staleness Note

**Konteks:** user cek langsung dashboard ScraperAPI dan menemukan **417/1.000 credit terpakai dalam ~5 hari** — proyeksi ~2.500 credit/bulan (2,5x jatah gratis), bakal habis hari ke-12 dari 30. Root cause: fitur Risk Reversal/CVOL (`correlations.js`) menghabiskan 6 credit/refresh (1 per pair CME CVOL, paralel) dengan TTL cuma 1 jam — bisa sampai 144 credit/hari kalau panel korelasi/vol ramai. Estimasi lama Session 47 ("~120-180 request/bulan") ditulis SEBELUM fitur CVOL 6-pair ditambahkan di sesi yang sama, jadi tidak terupdate.

**Riset vendor alternatif (diminta user, "cari vendor baru" sebelum eksekusi fix):** dicek 7 provider (ScrapingAnt 10.000 credit/bulan, Scrapfly 1.000 credit/bulan, Scrape.do, ScrapingBee, Crawlbase, WebScrapingAPI, Zyte) — **tidak ada yang lebih baik**. Semua kompetitor (kecuali klaim tak terverifikasi WebScrapingAPI) menerapkan pengali 25-30x credit untuk fitur residential-proxy/anti-WAF yang dibutuhkan buat lolos Akamai (dipakai CME) — kapasitas efektif untuk kasus spesifik ini jadi lebih kecil dari ScraperAPI (yang base rate 1 credit-nya sudah residential-grade tanpa toggle premium, terbukti dari kode yang polos tanpa parameter tambahan tapi tetap berhasil). Temuan tambahan: akun Scrapfly yang sempat dibuat user punya toggle **"PAG" (Pay As you Go) auto-billing overage aktif by default** — user diingatkan untuk mematikan ini demi menghindari risiko tagihan tak terduga.

**Fix yang diterapkan** (perbaiki pola pemakaian, bukan ganti vendor):
- [api/correlations.js](../api/correlations.js): `RR_CACHE_TTL` 3600 (1h) → **21600 (6h)** — konsisten dengan TTL `rate-path.js` (4h) dan `fundamental_analysis` (6h). Data ini juga inherently lambat bergerak (positioning institusional options, bukan harga real-time) jadi 6h freshness masuk akal.
- [api/market-digest.js](../api/market-digest.js): blok SKEW OPSI (dipakai Call 1 & Call 3, variabel `riskReversalBlock` yang sama) sekarang dapat penanda umur eksplisit `[data X jam lalu]` (pola sama seperti `makroAgeH` di `ohlcv_analyze`), dan CATATAN STALENESS yang sebelumnya cuma cover REAL YIELD/RISK REGIME/RATE PATH diperluas mencakup SKEW OPSI juga — dipindah posisinya ke setelah blok SKEW OPSI supaya urutan logis. Ini menutup celah akurasi: AI sekarang diinstruksikan eksplisit memberi bobot lebih ke headline segar kalau skew yang di-cache lebih lama (sampai 6h) ternyata bertentangan dengan berita terbaru.
- **Diverifikasi**: `node --check` bersih di kedua file, test suite 190/190 tetap hijau, plus simulasi isolated 4 skenario untuk logic age-tag (data segar, data 3.5 jam, tanpa computed_at/legacy, data unavailable) — semua PASS.

**Verifikasi ulang (diminta user setelah draft pertama):** cek baris-per-baris ulang rantai fallback tiap fitur langsung dari kode (bukan dari draft sebelumnya). Ketemu 1 koreksi lagi: **Analisa AI per Pair (`ohlcv_analyze`) TIDAK punya Groq di rantainya** — cuma 2 tingkat (SambaNova akun-1 → akun-2), berbeda dari 3 fitur AI lain yang semuanya punya Groq sebagai jaring pengaman terakhir. Groq & Ollama Cloud sengaja dicoret dari rantai ini 2026-07-10 (Ollama timeout konsisten 15s, kualitas Groq/llama-3.3 dinilai di bawah DeepSeek-V3.2 akun-2). Juga ditambahkan: Ringkasan Berita Call 1 punya fallback ke-4 non-AI (template deterministik berbasis kategori berita) kalau semua provider AI gagal — jadi fitur itu tidak pernah benar-benar kosong.

---

## Changelog Session 157 lanjutan 5 (2026-07-11) — CVOL Di-batch Jadi 1 Request, TTL Balik ke 1 Jam Tanpa Tambah Biaya

**Konteks:** setelah fix TTL 1h→6h (lanjutan 4), user push balik: "harusnya makin cepat kita menerima info itu makin bagus ga sih?" lalu "emang ga ada cara yang bisa kita usahakan?". Alih-alih trade-off freshness-vs-biaya, dicari cara motong BIAYA per refresh alih-alih frekuensinya.

**Temuan kunci:** endpoint CME `/services/cvol` ternyata **support multi-symbol dalam satu request** (`?symbol=EUVL,GBVL,JPVL,...` comma-separated) — awalnya dites dari environment saya sendiri (403, ternyata IP saya juga diblokir WAF CME, bukan cuma Vercel), jadi user yang menjalankan test langsung pakai `SCRAPER_API_KEY` sendiri via `curl.exe` di PowerShell. Hasilnya: 1 request balikin array 3 entry (EUVL, GBVL, JPVL) dengan field `skew` masing-masing utuh — dikonfirmasi CME support batching.

**Fix — [api/correlations.js](../api/correlations.js):** fetch CVOL direfactor dari **6 request paralel terpisah (6 credit/refresh)** jadi **1 request batch (1 credit/refresh)** — cost turun 6x. Mapping balik ke pair dilakukan lewat field `symbol` di tiap entry response (bukan posisi array — CME tidak menjamin urutan sama dengan query). `RR_CACHE_TTL` **dibalikin dari 21600 (6h) ke 3600 (1 jam)** — dengan cost baru, 1 jam TTL cuma ~720 credit/bulan (CVOL) + ~180 (FedWatch, rate-path.js TTL 4h terpisah) = ~900/bulan skenario TERBURUK (trafik nonstop 24 jam), masih di bawah jatah 1.000/bulan. Sempat dihitung opsi 30/45 menit tapi keduanya lewat budget bahkan di skenario batched ini — 1 jam jadi titik seimbang.

**Bonus temuan:** user tanya di mana bisa lihat angka skew XAU/USD — jawabannya ada di tab "Fundamental Data", kotak "RISK REVERSAL 25-DELTA" di bagian atas (bukan di panel Analisa AI per pair). Kode render (`renderRiskReversal()` di index.html) tidak meng-exclude XAU/USD — render generik dari `Object.entries(rrData.pairs)` — jadi kalau XAU/USD tidak muncul di sana, kemungkinan besar fetch GCVL (kode CME untuk gold) sedang gagal di siklus tertentu, bukan bug UI. Belum diinvestigasi lebih lanjut (di luar scope fix TTL/batching ini).

**Diverifikasi:** simulasi parsing pakai data JSON ASLI dari live test user (termasuk kasus symbol tak dikenal & skew rusak — di-drop dengan benar, tidak crash), `node --check` bersih, test suite 190/190 tetap hijau. Penanda umur `[data X jam lalu]` + perluasan CATATAN STALENESS dari fix sebelumnya (lanjutan 4) tetap dipertahankan — sekarang biasanya menunjukkan "<1 jam" alih-alih "beberapa jam".

---

## Changelog Session 157 lanjutan 6 (2026-07-11) — Risk Reversal Pindah ke Panel Teknikal Per-Pair + Call/Put IV Gratis

**Konteks:** user bingung XAU/USD skew tidak ketemu di tab Fundamental (dicek lewat curl live: datanya sebenarnya ADA dan segar — murni user cari di lokasi yang salah, XAU tidak masuk 8 kartu currency karena bukan currency). Dari situ user mengusulkan: "mending dibuat ke pair teknikal aja la, biar cocok aja gitu" + "sesuaikan dengan pairnya" — RR itu metrik per-pair, jadi lebih pas ditaruh di panel Analisa (RSI/SMA/MACD/ATR) yang memang per-pair, bukan di tab Fundamental yang terorganisir per-currency.

**Perubahan — [index.html](../index.html):**
- Kotak "RISK REVERSAL 25-DELTA" generik (6 pair sekaligus) di tab Fundamental **dihapus** (`fundRRSection`/`fundRRGrid`/`fundRRSource` + fungsi `renderRiskReversal()`).
- `fetchRiskReversal()` sekarang dipicu dari `loadAnalisa()` (sekali per sesi, `rrData` dicache global), bukan dari `fetchFundamental()`.
- `renderAnalisa()` — kartu "INDIKATOR" (dulu "RSI / SMA / MACD / ATR", sekarang **"... / RR"**) dapat blok baru: RR value pair aktif (`rrData.pairs[analisaActive.label]`), dengan label Call Bias/Put Bias/Neutral sama seperti sebelumnya. NZD/USD & USD/CHF (2 pair tanpa data CVOL karena options terlalu illiquid) otomatis skip blok ini, tidak crash.

**Bonus temuan user (di tengah kerjaan ini) — Call IV / Put IV ternyata GRATIS:** user tanya "bisa ga masing-masing pair dipanggil put/call-nya, tetap 1 credit?" — dicek ulang JSON respons CME CVOL yang sudah didapat sebelumnya, ternyata field `upvarMetric` dan `dnvarMetric` **sudah ada di respons yang sama** (0 credit tambahan) dan secara matematis **persis** `upvarMetric − dnvarMetric = skew` (diverifikasi exact match 3/3 pair dari data live). `upvarMetric` = komponen upside/call, `dnvarMetric` = komponen downside/put — padanan `call_iv`/`put_iv` yang sebelumnya cuma tersedia dari fallback Barchart (yang sendirinya tidak aktif). Sekarang diekstrak di [api/correlations.js](../api/correlations.js) dan ditampilkan sebagai baris "CALL IV / PUT IV" di kartu indikator.

**Diverifikasi:** simulasi end-to-end backend-parsing + frontend-render pakai data JSON asli (EUR/USD → put bias -0.45, call/put IV 5.35/5.81; USD/JPY → call bias +2.40, call/put IV 9.26/6.85; NZD/USD → di-skip aman tanpa data) — semua PASS. `node --check` bersih di kedua file, grep memastikan tidak ada sisa referensi ke elemen DOM yang dihapus, test suite 190/190 tetap hijau.

---

## Changelog Session 157 lanjutan 7 (2026-07-11) — Sentimen Options CME (Momentum/Vol/Convexity) Masuk Prompt AI Analisa

**Konteks:** user tanya "ada info lain yang bisa ditarik, 0-1 credit tambahan, penting tapi tanpa noise?" dari respons CME CVOL yang sama. Ditemukan 3 field belum kepakai: `skewPercentChange` (momentum sentimen), `cvolPrice`+`%chg` (level volatilitas implied — axis beda dari arah skew), `convexInd`+`%chg` (convexity — "kelengkungan" smile, antisipasi gerakan besar 2 arah sekaligus, independen dari arah skew). Diverifikasi konseptual: level/arah/convexity itu 3 sumbu matematis ortogonal dari volatility smile yang sama, bukan turunan satu sama lain — dan data live (JPY convexity 1.15 > EUR 1.06 > GBP 1.04) konsisten dengan realita (JPY memang rawan gerakan ekstrem, carry unwind/intervensi BOJ).

**Keputusan penempatan:** user minta "masukin ke analisa aja" (bukan UI, karena butuh interpretasi) untuk skew momentum + vol level + convexity — 3 metrik ini masuk **prompt AI** (fitur Analisa AI per pair), bukan jadi baris stat mentah baru di kartu indikator (yang user sendiri sadar berisiko jadi "noise" kalau numpuk angka tanpa konteks). RR/skew dasar + Call/Put IV (dari session sebelumnya) tetap di UI karena sudah cukup jelas dibaca langsung tanpa interpretasi tambahan.

**Perubahan:**
- [api/correlations.js](../api/correlations.js): tangkap `skewPercentChange`, `cvolPrice`/`cvolPricePercentChange`, `convexInd`/`convexIndPercentChange` per pair dari respons CME yang SAMA (0 credit tambahan) — disimpan di `rr_cache_v2` sebagai `skew_change_pct`, `vol_level`/`vol_change_pct`, `convexity`/`convexity_change_pct`.
- [api/admin.js](../api/admin.js): fungsi baru `_formatOptionsSentimentBlock()` menerjemahkan 3 metrik itu ke **bahasa Indonesia sederhana** (bukan istilah "skew"/"convexity" mentah) — contoh: "Ada tanda pasar mulai WASPADA kemungkinan kejutan mendadak ke arah manapun... kalau ada rilis data/event besar dalam waktu dekat, sebut ini sebagai alasannya." Dibaca read-only dari cache `rr_cache_v2` (tidak memicu fetch CME baru), masuk ke `ctxParts` prompt `ohlcvAnalyzeHandler` dengan instruksi eksplisit "cross-check tambahan, BUKAN sinyal utama — jangan mengubah bias, cuma catatan risiko".
- [index.html](../index.html): 1 kompromi UI minimal (bukan baris baru) — panah ▲/▼ kecil nempel di angka Risk Reversal yang sudah ada, nunjukin momentum tanpa nambah clutter.

**Diverifikasi:** simulasi wording pakai data live asli (EUR/USD → pesimis+mereda+vol naik+waspada kejutan; USD/JPY → optimis+menguat+vol naik+tidak ada tanda kejutan; skew netral → baris momentum di-skip; pair tanpa data → blok kosong tanpa crash) — semua PASS, termasuk cek arah panah UI konsisten dengan logic backend. `node --check` bersih di 2 file JS, test suite 190/190 tetap hijau.

---

## Changelog Session 157 lanjutan 8 (2026-07-11) — Tambah Paragraf 5 KESIMPULAN di Commentary Analisa AI

**Konteks:** user cek live output Analisa AI XAU/USD — label "di analisa jam 12:34 WIB" dan blok sentimen options (lanjutan 7) sudah kebaca AI ("Sentimen options yang pesimis (skor -0.85) juga mengisyaratkan kekhawatiran pasar" muncul di paragraf integrasi). User lalu minta paragraf baru khusus "kesimpulan" — sebelumnya paragraf terdekat yang mirip cuma Paragraf 4 ("Integrasi"), tapi nadanya analitis (gabungan faktor), bukan verdict tegas yang berdiri sendiri.

**Perubahan — [api/admin.js](../api/admin.js)** (`ohlcvAnalyzeHandler`, prompt Call AI Analisa per pair): commentary sekarang **5 paragraf wajib** (sebelumnya "4-5"). Paragraf 5 (KESIMPULAN) instruksinya eksplisit: 3-4 kalimat MAKSIMAL, tidak boleh mengulang detail/angka paragraf 1-4, harus bisa berdiri sendiri untuk trader yang cuma sempat baca 1 paragraf — isi wajib: (1) bias akhir + level keyakinan + alasan singkat, (2) satu trigger utama yang ditunggu (dengan levelnya), (3) satu risiko/pembatal utama. Aturan "minimal 2 angka konkret per paragraf" disesuaikan jadi minimal 1 angka khusus untuk Paragraf 5 (levelnya trigger) supaya tetap ringkas, tidak dipaksa padat data seperti paragraf analitis lainnya.

**Catatan ketemu sekaligus saat investigasi:** live cache `rr_cache_v2` sempat masih versi lama (tanpa field momentum/vol/convexity dari lanjutan 7) saat user generate analisa pertama kali — jadi AI cuma dapat skor dasar RR, bukan elaborasi lengkap. Setelah TTL 1 jam refresh (dipicu manual via curl saat investigasi), field baru sudah lengkap di cache — tidak perlu perubahan kode, cuma soal timing cache alami.

**Diverifikasi:** perubahan murni teks prompt (instruksi AI), tidak menyentuh logic — `node --check` bersih, test suite 190/190 tetap hijau (tidak ada assertion otomatis untuk kualitas output AI generatif; verifikasi kualitas Paragraf 5 perlu dicek manual oleh user di run berikutnya).

---

## Changelog Session 157 lanjutan 9 (2026-07-11) — Fix Label "Paragraf N" Bocor ke Output + Styling KESIMPULAN

**Konteks:** user cek live output Paragraf 5 (dari lanjutan 8) — ternyata SEMUA paragraf (1-5) muncul dengan prefix literal "Paragraf 1 —", "Paragraf 2 —" dst di output AI, bukan cuma "KESIMPULAN:" yang dimaksud untuk paragraf 5. Root cause: instruksi prompt di [api/admin.js](../api/admin.js) memakai label "Paragraf 1 —", "Paragraf 2 —" dst sebagai penanda urutan untuk AI, tapi tidak eksplisit bilang itu HANYA panduan internal — AI mengutipnya literal ke output.

**Fix — [api/admin.js](../api/admin.js):** instruksi diperjelas — "label paragraf 1-5 di bawah HANYA panduan urutan penulisan, BUKAN teks yang boleh muncul di output". 4 paragraf pertama diinstruksikan WAJIB tanpa header/judul apapun (langsung prosa mengalir); paragraf 5 SATU-SATUNYA pengecualian yang harus mulai literal dengan "KESIMPULAN:".

**Perubahan — [index.html](../index.html):** paragraf yang diawali "KESIMPULAN:" sekarang dirender dalam box terpisah (border kiri warna accent, label bold berwarna) via deteksi regex `/^kesimpulan:\s*(.*)$/i` di `_renderStructuredAi()` — supaya benar-benar menonjol dan gampang ditemukan sesuai tujuan awal fitur ini (lanjutan 8), bukan cuma teks biasa yang menyatu dengan paragraf lain.

**Bonus bug ditemukan saat investigasi (tidak berhubungan, diperbaiki sekalian):** variabel CSS `--fg` dipakai di 5 tempat (`_renderStructuredAi()`, label trigger/makro/dasar/invalidasi) tapi tidak pernah didefinisikan di `:root` — fallback diam-diam ke warna inherited, bukan warna yang dimaksud. Diganti ke `--text` (variabel yang benar-benar terdefinisi) di semua 5 lokasi.

**Diverifikasi:** `node --check` bersih, test suite 190/190 tetap hijau.

---

## Changelog Session 157 lanjutan 10 (2026-07-11) — Fitur Cetak PDF Profesional untuk Ringkasan & Analisa AI

**Konteks:** user minta fitur cetak PDF untuk panel Ringkasan Berita dan Analisa AI, dengan tampilan profesional, tombol ikon dokumen warna app (`--accent`), dan diminta ikuti protokol CLAUDE.md penuh (evaluasi mandiri, uji, dokumentasi).

**Strategi:** `window.print()` bawaan browser (bukan library tambahan seperti jsPDF/html2pdf) — user pilih "Simpan sebagai PDF" di dialog print browser. Pendekatan "print hanya elemen ini": `visibility:hidden` di seluruh `body`, lalu `visibility:visible` cuma untuk panel yang lagi dicetak (ditandai lewat class `body.printing-ringkasan`/`body.printing-analisa`) — standar pola print-scoped-element yang tidak merusak layout flow dibanding `display:none`.

**Perubahan — [index.html](../index.html):**
- CSS `@media print` baru: palet terang profesional (override `:root` — putih/hitam dengan aksen warna disesuaikan kontras kertas, bukan dark theme app), font serif (Georgia) untuk kesan dokumen resmi, `page-break-inside:avoid` di kartu-kartu supaya tidak terpotong aneh antar halaman.
- Letterhead dinamis (`.print-letterhead`, div `#printLetterheadRingkasan` & `#printLetterheadAnalisa`): brand "DAUN MERAH" + judul dokumen + timestamp cetak (WIB), di-generate ulang tiap klik cetak.
- Class `.no-print` disematkan ke elemen interaktif yang tidak relevan dicetak: tombol generate/refresh, chip pemilih pair, link "↻ refresh · auto 5m" di header Analisa, widget Polymarket — disclaimer AI SENGAJA tetap tercetak (bukan no-print).
- Tombol cetak baru (ikon dokumen SVG, warna `--accent`) di sebelah tombol "Ringkas Berita"/"Ringkas Ulang" dan "Analisa AI", pakai class `.print-btn` + `.print-btn-row` (flex layout).
- Fungsi baru: `_printPanel()` (helper generate letterhead + toggle body class + `window.print()`), `cetakRingkasan()`, `cetakAnalisa()` — dua-duanya guard "belum ada data" (toast, bukan cetak halaman kosong) sebelum lanjut cetak. Cleanup class via listener `afterprint` (jalan baik user benar-benar cetak maupun batal dialog).

**Diverifikasi:** `node --check` bersih di semua inline script, brace CSS seimbang (1183/1183), simulasi letterhead (format tanggal WIB benar untuk Ringkasan & Analisa) + guard belum-ada-data (4 skenario: cache null, cache tanpa article, symbol null, data belum load) — semua PASS, test suite 190/190 tetap hijau. Verifikasi visual output PDF asli (hasil "Save as PDF" browser) belum dilakukan — perlu dicek manual oleh user karena environment ini tidak punya browser untuk render print preview sungguhan.

---

## Changelog Session 157 lanjutan 14 (2026-07-11) — Font Serif Klasik untuk PDF + Nama File Otomatis

**Konteks:** kelanjutan penyempurnaan PDF. Saya audit jujur kesesuaian dengan standar "surat/laporan profesional" atas pertanyaan user — 3 gap ketemu: (1) font isi masih monospace (kesan "printout terminal", bukan laporan; laporan resmi lazim serif/sans proporsional), (2) nomor halaman bergantung setting browser, (3) belum ada baris identitas sumber data. User memilih **serif klasik** dari 3 opsi yang ditawarkan (serif klasik / sans modern / tetap mono). Dua permintaan tambahan: nama file default `ringkasan{tgl-jam}.pdf` dan `analisa{tgl-jam}.pdf`.

**Perubahan — [index.html](../index.html):**
- **Font isi PDF → Georgia/Times serif** via rule ber-ID (`#ringkasanPanel *`, `#analisaPanel *` + `!important`) supaya menang melawan `'DM Mono'` yang menempel eksplisit di banyak class; heading dikembalikan ke Syne (identitas brand) via `:is()` ber-ID yang specificity-nya lebih tinggi. Body 11px→12px (serif terbaca lebih kecil dari mono di ukuran sama). Disclaimer jadi italic kecil (konvensi catatan kaki laporan).
- **Nama file PDF otomatis:** browser memakai `document.title` sebagai nama default "Save as PDF" — di-set sementara ke `ringkasan_DD-MM-YYYY_HH-mm` / `analisa_DD-MM-YYYY_HH-mm` (karakter `/` dan `:` tidak valid di nama file, diganti `-`/`_`) saat print dimulai (baik via tombol maupun Ctrl+P), dipulihkan di `afterprint`. Helper `_printWibNow()` menyatukan format timestamp display + filename.
- **Baris identitas sumber:** kop sekarang mencantumkan "Dokumen otomatis · Sumber: CME · FRED · FinancialJuice · Yahoo Finance" (8.5px, di bawah timestamp).
- Catatan nomor halaman: tidak bisa dijamin dari CSS (Chrome tidak dukung `@page` margin-box counters) — user perlu aktifkan "Headers and footers" di dialog print kalau mau nomor halaman.

**Diverifikasi:** syntax bersih, CSS balanced (1202/1202), simulasi nama file (`ringkasan_11-07-2026_13-46` — karakter aman), test suite 190/190 hijau.

---

## Changelog Session 157 lanjutan 13 (2026-07-11) — PDF Jadi Dokumen Resmi Monokrom + Fix Letterhead Bocor ke Layar

**Konteks:** user kirim screenshot layar tab RINGKASAN dan bertanya "fungsi daun merah di atas itu apa (bukan bagian header)" — itu ternyata **BUG: letterhead PDF bocor tampil di layar app**. Root cause: rule dasar `.print-letterhead` yang seharusnya `display:none` di layar tertimpa oleh rule kedua di bawahnya (layout flex dari lanjutan 11) yang menyetel `display:flex` tanpa scope print — CSS same-specificity, yang terakhir menang. **Fix:** properti `display` dihapus dari rule layout dasar (properti flex lain tetap), `display:flex !important` dipindah ke dalam `@media print`. Diverifikasi via inspeksi rule (bukan cuma regex — cek pertama sempat positif palsu karena kata "display:flex" ada di komentar CSS sendiri).

**Permintaan desain user di pesan yang sama (semuanya untuk DOKUMEN CETAK, layar app tidak diubah):**
1. **"JANGAN ADA WARNA" — monokrom total:** palet `:root` di `@media print` sekarang hitam/putih/abu murni — semua warna sinyal (green/red/yellow/pink/purple/accent) dipetakan ke `#1a1a1a`/`#5a5a5a`. Arah bias tetap terbaca dari TEKSNYA (LONG/SHORT/BULLISH/BEARISH), bukan warna. Highlight artikel (`.hl-num/.hl-cur/.hl-bull/.hl-bear`) dinetralkan ke `color:inherit`. Letterhead (brand + garis) ikut hitam.
2. **Bintang ★★★☆☆ → teks resmi:** `renderThesisCard`/`renderXauThesisCard` sekarang merender DUA versi — `.conf-stars` (bintang, tampil di layar) + `.conf-text` ("Keyakinan: Tinggi/Sedang/Rendah (n/5)", tampil HANYA di print). CSS pasangan yang memilih mana yang tampil per konteks; layar app tidak berubah.
3. **Section header lebih besar di print:** `.ringkasan-fx-label`/`.ringkasan-xau-label`/`.thesis-section-label` (class baru ditambahkan ke label inline thesis card) 9px → 13px bold hitam di print; `.analisa-ai-label` → 12px.
4. **Analisa PDF = analisa tertulis SAJA:** kartu Daily/4H/1H, tabel candle, dan kartu indikator (`#analisaD1Card/H4/H1/IndCard`) disembunyikan total saat print — angka pentingnya sudah dinarasikan AI di paragraf. Konsekuensi: guard `cetakAnalisa()`/`_printMeta()` sekarang mewajibkan **hasil Analisa AI sudah ada** (bukan cuma data OHLCV) — tanpa itu dokumennya kosong, toast "Jalankan Analisa AI dulu".

**Diverifikasi:** syntax bersih, CSS balanced (1201/1201), inspeksi manual rule letterhead (display hanya di 2 tempat yang benar), test suite 190/190 hijau.

---

## Changelog Session 157 lanjutan 12 (2026-07-11) — Polish PDF Berdasarkan Hasil Cetak Nyata User

**Konteks:** user kirim 2 PDF hasil cetak asli (ringkasan.pdf + analisa.pdf) — "aneh banget, kayak ga professional". Dari PDF-nya keliatan 4 masalah konkret yang tidak ketahuan dari simulasi kode (butuh render print nyata):
1. **Tombol interaktif ikut tercetak** — "Ringkas Ulang", "Analisa AI", "Mulai ke Sizing Calc →" muncul di kertas. Fix: `button { display:none !important }` global di `@media print` (tombol tidak pernah relevan di kertas, apapun itu).
2. **Informasi dobel 3x di halaman 1 Ringkasan** — letterhead menyebut "150 berita · 0 event", baris meta menyebut lagi, lalu 2 kotak statistik besar (`.ringkasan-stats`) menyebut hal yang sama ketiga kalinya. Fix: `.ringkasan-stats`, `.ringkasan-ts` (baris "Data: N headline..."), `.ringkasan-method` (badge model ber-emoji yang tercetak jadi blob), `.ringkasan-provider-log` semua disembunyikan di print.
3. **Spasi kosong raksasa** (page 2 analisa nyaris kosong; bagian bawah page 1 ringkasan kosong separuh) — kombinasi padding section 10mm kegedean + `page-break-inside:avoid` diterapkan ke SEMUA kartu termasuk yang panjang (artikel/hasil AI lebih dari 1 halaman, avoid memaksa mulai di halaman baru). Fix: padding diturunkan ke 5mm, `avoid` sekarang HANYA untuk kartu pendek (thesis/indikator/alert) — kartu teks panjang dibiarkan mengalir lintas halaman.
4. **Emoji 🧠 di label hasil AI tercetak** sebagai blob pink — dibungkus `<span class="no-print">`.

Bonus: badan teks laporan (paragraf artikel + commentary AI) sekarang `text-align: justify` di print — rata kiri-kanan ala dokumen resmi; tabel candle dikecilkan ke 9px.

**Catatan untuk hasil cetak user berikutnya:** label "Paragraf 1 —" dst yang masih muncul di analisa.pdf user itu **hasil AI CACHED jam 12:44** (di-generate sebelum fix prompt lanjutan 9 deploy) — bukan bug baru; klik "Analisa AI" lagi untuk hasil bersih. Letterhead analisa.pdf juga masih layout lama (dicetak sebelum deploy lanjutan 11 selesai).

**Diverifikasi:** syntax bersih, CSS balanced (1193/1193), test suite 190/190 hijau. Verifikasi visual final tetap butuh cetak ulang oleh user.

---

## Changelog Session 157 lanjutan 11 (2026-07-11) — Fix Tombol Cetak Hilang Setelah Generate + Redesign CSS Print + Hook Ctrl+P

**Konteks:** 3 masalah ditemukan berurutan saat user coba fitur cetak dari lanjutan 10:
1. **Tombol cetak Ringkasan hilang setelah klik "Ringkas Berita".** Root cause: tombol cetak cuma ditambahkan ke HTML statis awal (state kosong) — begitu `renderRingkasan()` jalan dan mengisi `#ringkasanInner` dengan `innerHTML =` (mengganti total, bukan menambah), tombol cetak ikut terhapus karena template dinamisnya belum di-update.
2. **"Kok kayak gini sih, sama aja dong dengan ctrl+p"** — styling profesional (letterhead, palet terang, sembunyikan tombol) SEBELUMNYA cuma ter-trigger kalau klik tombol kita, karena logic setup-nya ada di dalam `onclick` handler. Ctrl+P/menu browser langsung bypass semua itu, hasilnya print biasa dark-theme mentah — user kemungkinan besar sempat coba Ctrl+P karena tombolnya sendiri hilang (masalah #1).
3. **User ingat ada sesi lama soal redesign tab RINGKASAN jadi "laporan profesional flat & minimal"** — dicek riwayat: redesign itu SEMPAT dibuat (Session ~104) tapi KEMUDIAN DI-REVERT total balik ke tampilan card berwarna/rounded (Session ~106+, "Revert total redesign RINGKASAN — balik ke tampilan awal"). CSS print di lanjutan 10 pakai font serif (Georgia) yang justru merupakan opsi yang TIDAK dipilih user dulu (dipilih: flat-minimal, bukan serif-body) — inkonsistensi ditemukan sendiri, dikoreksi.

**Fix #1 — [index.html](../index.html):** tombol cetak (+ `.print-btn-row`) ditambahkan ke KEDUA branch template `renderRingkasan()` (state kosong DAN state ada data), bukan cuma HTML statis awal.

**Fix #2 — hook `beforeprint`:** logic setup letterhead + `body.printing-*` class diekstrak ke helper `_setupPrintLetterhead()` + `_printMeta()` (deteksi tab aktif via `activeView` + validasi data tersedia), dipanggil dari DUA jalur: tombol (`cetakRingkasan()`/`cetakAnalisa()`, seperti sebelumnya) DAN listener `window.addEventListener('beforeprint', ...)` baru yang auto-detect tab aktif — kalau body belum punya class `printing-*` (artinya bukan dari tombol kita), cek `activeView` dan setup otomatis. Ctrl+P sekarang dapat treatment yang sama persis dengan tombol.

**Fix #3 — redesain CSS print (bukan pakai gaya dashboard, bukan pakai serif yang direjek dulu):** karena redesign flat-minimal DI-APP sudah pernah di-revert (keputusan lama, tidak diusik lagi), PDF dirancang sebagai konteks TERPISAH — dokumen cetak butuh nada "laporan resmi" yang beda dari dashboard interaktif berwarna:
- Font: `'DM Mono'` (body/data, konsisten dengan identitas app — bukan Georgia serif asing) + `'Syne'` (heading/label, sudah jadi font brand app).
- Kartu (`.ringkasan-card`, `.thesis-card`, dll) di-flatkan KHUSUS untuk print: `border-radius:0`, bar warna 3px (`::before`) disembunyikan, diganti `border-top` tipis + spacing — gaya "section laporan" bukan "widget kartu". Badge/pill (thesis-dir, ringkasan-method) juga diflatkan jadi outline/teks polos.
- Letterhead diperkaya: sekarang tampilkan metadata kontekstual (Ringkasan: jumlah berita + event kalender; Analisa: harga saat data + bias AI kalau sudah ada) via `_printMeta()`, bukan cuma judul+tanggal generik.
- `@page { margin: 14mm 12mm }` — margin kertas proper alih-alih mengandalkan default browser.

**Diverifikasi:** `node --check` bersih, brace CSS seimbang (1189/1189), simulasi `_printMeta()` 6 skenario (Ringkasan ada/tanpa data, Analisa lengkap/tanpa hasil AI/belum pilih pair, tab lain) — semua PASS termasuk guard yang benar (tidak memaksa print halaman kosong dari Ctrl+P di tab yang belum siap), test suite 190/190 tetap hijau.

---

## Changelog Session 156 (2026-07-11) — Audit SIMULASI Kalender: Fix Jebakan BEAT/MISS Indikator Terbalik + Transparansi "Dasar Bertumpu"

**Konteks:** audit atas pertanyaan user "apakah blok simulasi cukup informatif dan bisa jadi dasar memilih pair?". Kesimpulan audit: informatif sebagai konteks latar, tapi ada 1 jebakan serius + beberapa klaim yang overclaim. Semua temuan diperbaiki (fitur S143 lanjutan 3).

**Temuan #1 (paling serius) — jebakan "▲ BEAT" pada indikator terbalik:** untuk event macam Unemployment Rate, BEAT (bagus untuk currency) = angka LEBIH RENDAH dari forecast, tapi tombol hardcoded "▲ BEAT" menyiratkan angka naik — user yang mensimulasikan "unemployment naik" bisa klik ▲ BEAT dan dapat rekomendasi pair yang **persis terbalik**. Fix: panah tombol & header hasil kini mengikuti arah ANGKA rilis via `CAL_INVERSE_INDICATOR_RE` (regex yang sudah dipakai pewarnaan actual di kalender) — indikator terbalik jadi "▼ BEAT" / "▲ MISS", header hasil diberi keterangan "(angka turun)"/"(angka naik)", plus catatan penjelas `.cal-scenario-inv-note` di panel.

**Temuan lain yang diperbaiki di `scenarioConfluence`/`scenarioRenderResults` (index.html):**
- **Baris Retail selalu dirender** — sebelumnya diam-diam hilang untuk pair yang tak tercakup data retail, bikin jumlah faktor verdict badge tidak apples-to-apples antar pair (#1 dinilai 5 faktor vs #3 dinilai 6). Kini ada 3 status: tersedia / "tidak tersedia untuk pair ini — tidak ikut dinilai" (netral −) / "belum dimuat…".
- **Tag `⚡ reaksi langsung`** di pair mayor mata uang event (mis. USD/CAD untuk event CAD; tidak dipakai untuk event USD) — menandai instrumen tempat reaksi awal kejutan biasanya paling cepat & likuid, karena ranking dasar-bertumpu berbasis konteks latar bisa menempatkannya lebih rendah dari cross.
- **Caption diperbaiki** — klaim "faktor independen" dihapus (bias CB/makro/COT saling berkaitan); ditegaskan ranking mengukur konteks latar, BUKAN seberapa responsif pair terhadap rilis; dicatat teknikal dimuat menyusul tanpa mengubah urutan.
- **Footer warn** ditambah: besaran deviasi actual vs forecast ikut menentukan kekuatan reaksi (beat/miss tipis sering diabaikan pasar).
- **Bias CB ortogonal** (Data Dependent/On Hold/Split) diberi tanda "(≈netral)" di baris Bias CB — konsisten dengan `HAWK_DOVE_AXIS` yang memang mengecualikan label ini dari axis hawk-dove, supaya "divergensi vs Data Dependent" tidak overclaim.
- **Hardening `escJs()`** (helper baru di samping `escHtml`): nama event ber-apostrof/kutip tidak lagi bisa mematahkan literal JS di atribut `onclick` tombol SIMULASI/BEAT/MISS; subheading hasil kini `escHtml(eventName)`.

**Sengaja TIDAK diubah:** logika ranking (CB gap + bonus konfluensi) — perilaku skor tetap sama persis; perbaikan ini murni koreksi label yang menyesatkan + kejujuran presentasi. Faktor "reaksi historis pair terhadap event" dicatat sebagai kandidat backlog (butuh dataset event-reaction baru).

**Verifikasi:** test baru [test/cal_scenario_sim.test.js](../test/cal_scenario_sim.test.js) (12 test: regex terbalik, header BEAT/MISS dua mode, tag reaksi langsung ada/absen, caption/footer, 3 status baris retail, tanda ≈netral, escJs round-trip eval) — full suite **190/190 hijau**; syntax check seluruh blok script inline bersih; grep memastikan tidak ada label "▲ BEAT" hardcoded tersisa.

---

## Changelog Session 155 lanjutan 5 (2026-07-10) — Plan G6: FOMC/Central Bank Shock Detector (plan G selesai seluruhnya)

**Konteks:** item terakhir plan G (`daun_merah_plan.md`), dikerjakan setelah G1-G5. Rule-based SEPENUHNYA — **nol panggilan AI** (klasifikasi dihitung pasti di kode, narasi Bahasa Indonesia dari template deterministik, pola persis labour market S154). Kerangka teori: Nakamura & Steinsson (poin 7 file referensi riset) — reaksi pasar atas keputusan bank sentral dipilah jadi *policy shock* vs *information shock*.

**Langkah persiapan (sesuai plan):**
- [api/rate-path.js](../api/rate-path.js) di-refactor: logic cache→compute→stale dipisah jadi `getRatePathData({ force, cacheOnly })` (reusable/importable, pola `_cb_rates.js`), handler HTTP tinggal wrapper tipis. Perilaku endpoint `/api/rate-path` tidak berubah (X-Cache HIT/MISS/STALE + shape response sama). Opsi `cacheOnly: true` ditambah dari evaluasi mandiri: konsumen sekunder (shock) TIDAK boleh memicu rantai fallback CME (bisa puluhan detik) di tengah request user — cache miss cukup return `null`.
- Modul shared baru [api/_ohlcv_fetch.js](../api/_ohlcv_fetch.js): `fetchYahooOhlcv1h()` + `fetchBinancePaxg1h()` diekstrak dari `admin.js` (perilaku tidak berubah, `admin.js` sekarang require dari sini), dipakai bersama cb-status shock.

**Fitur inti — [api/_cb_shock.js](../api/_cb_shock.js) + branch `?section=shock` di [api/cb-status.js](../api/cb-status.js)** (bukan file api baru — 12/12 limit tetap):
- `classifyCbShock()` (pure function): 4 kelas — `policy_shock` (keputusan berubah + harga bergerak searah arah keputusan), `information_shock` (hold tapi harga bergerak signifikan; ATAU keputusan berubah tapi harga berlawanan arah; ATAU perubahan lebih kecil dari yang di-price-in `rate-path` pre-meeting), `no_shock` (dalam band noise), `insufficient_data` (gap candle → "jangan menebak").
- Band noise ±0,3% FX = **heuristik tahap pertama, ditulis eksplisit di kode sebagai perlu kalibrasi dari observasi live** (pola flat-band labour market).
- Reaksi harga: `computeHourlyReaction()` dari candle 1 jam (Redis `ohlcv:{symbol}:1h` hasil ohlcv_sync, fallback fetch Yahoo via `_ohlcv_fetch`) — close candle terakhir pre-announce → close +3 jam. Jam pengumuman per bank di-approx per-currency (`CB_ANNOUNCE_HOUR_UTC`). Proxy pair per currency (`CB_SHOCK_PROXY`, USD via EUR/USD inverted dst; dedupe fetch per simbol).
- Ekspektasi pre-meeting (`expected_change_bps`): hanya USD via `getRatePathData({cacheOnly:true})`, dan hanya kalau cache rate_path masih memuat meeting tsb sebagai meeting mendatang — pasca-rapat jujur `null` (ekspektasi historis tidak pernah disimpan, tidak direka ulang).
- Response di-cache `cb_shock_cache` TTL 1 jam; jendela rapat = 8 hari terakhir (batas jangkauan data 1h range=10d).

**UI (index.html):** blok "Reaksi Rapat CB Terakhir" di bawah tabel CB Tracker (`_buildCbShockHtml`, fetch fire-and-forget `fetchCbShock()` dari `fetchCBStatus()`, TTL klien 1 jam). Badge per kelas selalu disertai label teks (bukan warna saja). **Disclaimer wajib tampil** (sesuai plan): resolusi 1 jam bukan 30-60 menit presisi, reaksi keputusan vs konferensi pers bisa tercampur, band noise masih heuristik — "Konteks, bukan sinyal".

**Verifikasi:** unit test baru [test/cb_shock.test.js](../test/cb_shock.test.js) (14 test: 4 kelas klasifikasi, invert quote-currency, reaksi per-jam, gap→null, narasi per kelas, proxy map 8 currency) + 6 test tambahan `applyRegimeConfidenceGuard` (G5) di `test/market_digest_thesis.test.js`. Full suite **178/178 hijau**. Integration smoke test lokal dengan Redis mock: FOMC cut -25bps + USD menguat +1% → `information_shock` dengan narasi benar, nol network call eksternal. **Verifikasi live menunggu rapat bank sentral mayor berikutnya: FOMC 2026-07-30** (dari `getNextFOMCMeetings`) — dicatat sesuai kriteria selesai plan.

**Plan file:** seksi G6 dihapus dari `daun_merah_plan.md` (SELESAI) — seluruh plan G G1-G6 kini selesai; yang tersisa di sana hanya item "Ditahan" (pembobotan nowcasting, carry trade) + backlog F/E.

---

## Changelog Session 155 lanjutan 4 (2026-07-10) — Plan G1-G5 (Riset Akademis → Fitur) + Retail Sentiment Auto-Refresh

**Konteks:** lanjutan `daun_merah_plan.md` seksi G (roadmap 6 fitur dari riset akademis, lihat entri "Perpustakaan Rujukan Riset Akademis" di atas). G1-G5 dikerjakan di sesi yang ke-`/clear` sebelum sempat commit/push — diverifikasi ulang di sesi ini (164/164 test hijau) sebelum di-push. G6 (FOMC Shock Detector, scope terbesar) sengaja belum dikerjakan.

**G1 — Convergence Score (kartu Labour Market):** `buildAssessment()` di [api/_labour_market.js](../api/_labour_market.js) sekarang expose `agreement.convergence_score` (rasio `aligned/total`, ordinal 0-1, `null` saat `insufficient`) — sebelumnya rasio ini dihitung untuk ambang label lalu dibuang. UI (`_buildLabourMergedHtml` di `index.html`) menambah bar horizontal "Tingkat kesepakatan" di bawah label existing, disembunyikan total kalau `null` (bukan tampilkan "0,00" menyesatkan). Logic label STRONG/MODERATE/MIXED tidak berubah.

**G2 — Logging Histori Retail Sentiment:** `retailHandler()` di [api/feeds.js](../api/feeds.js) sekarang menyimpan snapshot harian ke Redis (`storeRetailHistory()`, fire-and-forget, lock per-hari `retail_hist_lock:{YYYYMMDD}`, rolling window 90 hari) — mirror pola `storeCOTHistory()` yang sudah ada. Endpoint baru `GET /api/feeds?type=retail_history&n=` untuk baca histori. **Belum ada analisis/UI** dari histori ini (di luar scope G2) — data baru mulai terkumpul sejak deploy, evaluasi kill-gate menyusul setelah sampel cukup (bulanan).

**G3 — Sign Effect (bobot severitas data rilis, Call 4 saja):** fungsi murni `classifyDataSurpriseSeverity(actual, forecast, indicatorKey)` di [api/market-digest.js](../api/market-digest.js) — data yang menunjukkan pelemahan ekonomi (NFP/retail sales miss, unemployment naik) dapat tag `[SEVERITAS: TINGGI]` yang ditempel ke headline SEBELUM masuk prompt `checkThesisContradictions()` (Call 4). CPI/inflasi sengaja tidak di-mapping (ambigu dovish, bukan "lemah"). Verifikasi live menunggu rilis data nyata pasca-deploy.

**G4 — Horizon Disclaimer:** teks statis "Horizon: fundamental, relevan untuk pergerakan menengah-panjang — bukan sinyal entry presisi jangka pendek." ditambahkan di `renderThesisCard()` DAN duplikatnya `renderDashDigest()` (dua lokasi disinkronkan, riwayat proyek pernah bug karena cuma edit satu tempat).

**G5 — Regime Cross-Check (downgrade confidence berbasis VIX ground-truth):** fungsi murni `applyRegimeConfidenceGuard(thesis, riskRegimeData)` di `api/market-digest.js`, dipanggil setelah `validateThesis()` lolos, sebelum cache/return. Kalau `riskRegimeData.regime === 'risk_off'` (4-tier ground truth dari `/api/risk-regime`, BUKAN `dominant_regime` 3-tier hasil restate AI) DAN thesis efektif long currency risk-sensitive (AUD/NZD) vs safe haven (USD/JPY/CHF) → `confidence_1_to_5` di-cap maksimum 2 + field baru `regime_note` (dirender di UI dengan warna kuning). Scope MVP cuma tier `risk_off` paling ekstrem — `elevated` ditahan, pantau dulu frekuensi trigger via log. Fail-open kalau `riskRegimeData` tidak tersedia. Trigger di-log eksplisit (`Regime guard TRIGGERED: ...`) untuk evaluasi sebelum diperluas.

**Retail Sentiment — auto-refresh 15 menit (di luar plan G, permintaan user sesi ini):** user tanya apakah retail sentiment (`ForexBenchmark`, tab COT) selalu update — ternyata sebelumnya HANYA ter-refresh saat ada user buka app (cache 2 jam, dipicu `window load`/switch tab COT), jadi bisa basi berhari-hari kalau tidak ada trafik. **Fix:** cache TTL server (`RETAIL_CACHE_TTL`) dan client (`RETAIL_CLIENT_TTL`) diturunkan dari 2 jam → 15 menit, plus workflow baru [.github/workflows/retail-sentiment-warm.yml](../.github/workflows/retail-sentiment-warm.yml) (cron `*/15 * * * *`, pola sama seperti `ta-warm.yml`) yang force-refresh (`?type=retail&force=1`) via `x-cron-secret` terlepas ada trafik atau tidak. Diverifikasi live: `fetched_at` berubah 14:25→14:46 UTC antar dua `force=1` call sebelum fix di-deploy, konfirmasi scraping/parsing masih sehat.

**Verifikasi:** `node --test "test/*.test.js"` — 164/164 hijau (termasuk test baru G1 `test/labour_market.test.js`, G2 `test/feeds_retail.test.js`, G3/G5 `test/market_digest_severity.test.js`). Plan file `daun_merah_plan.md` di-update — G1-G5 dihapus dari sana (SELESAI), G6 tetap.

---

## Changelog Session 155 lanjutan 3 (2026-07-10) — Fix Journal AI Coach Kepotong + Placeholder Catatan Attribution

**Request user:** user tempel hasil AI Coach jurnal yang kepotong di tengah section 5 dari 6 ("Kelemahan Utama").

**Root cause 1 — truncation:** `aiCall(messages, 1400)` di [api/journal.js](api/journal.js) — `max_tokens=1400` tidak cukup untuk output 6 section + instruksi "maksimal 650 kata", apalagi kalau model pakai tabel markdown (boros token) di salah satu section seperti yang terjadi. **Fix:** `max_tokens` 1400→2200, prompt sekarang eksplisit melarang tabel markdown dan menegaskan 650 kata itu total gabungan 6 section, plus logging `finish_reason=length` di `callProvider()` (pola sama seperti `aiCall()` di market-digest.js) supaya truncation ke depan kelihatan di log, bukan diam-diam kepotong.

**Root cause 2 — user tanya "AI gabisa baca alasan exit?":** investigasi menunjukkan bukan bug baca data — `exit_reason` di prompt cuma kode generik dropdown (`tp_hit/sl_hit/manual_close/time_exit/news_exit`, [index.html:2808-2814](index.html#L2808-L2814)), tanpa teks bebas. Satu-satunya kolom teks bebas (`attribution_notes`/"Catatan Attribution") placeholder-nya cuma nanya "Apa yang benar/salah dari thesis ini?" — user (dikonfirmasi langsung) memakainya untuk nulis alasan ENTRY, bukan alasan EXIT, karena tidak ada indikasi field itu juga dimaksudkan untuk itu. AI Coach jadi cuma bisa menebak dari data MFE/MAE ("kemungkinan panic-exit") tanpa konteks nyata. **Fix:** placeholder diperjelas jadi "Kenapa kamu exit di titik ini (bukan di TP/SL rencana)? Apa yang benar/salah dari thesis ini?" — berlaku untuk trade baru; trade lama (termasuk contoh yang ditanyakan user) tidak bisa diperbaiki retroaktif karena datanya sudah tersimpan.

**Verifikasi:** 138/138 test lokal hijau, deployed ke production. Cache lama `journal_analysis:{deviceId}` (TTL 1 jam) tetap menyajikan hasil kepotong sampai user klik tombol "Refresh" (force=1) di panel AI Coach.

---

## Changelog Session 155 lanjutan 2 (2026-07-10) — `ohlcv_analyze` (fitur Analisa): Fallback 1 Ollama/Groq → SambaNova Akun 2

**Request user:** ganti fallback 1 `ohlcv_analyze` (panel "Analisa" per-pair) jadi DeepSeek-V3.2, lalu drop fallback 2 (Groq llama-3.3, user "gasuka").

**Live test dulu sebelum eksekusi** (per instruksi user "coba test dulu ollama yang gpt-oss:120b itu"): 2x curl production `?test_ollama=1` (bypass primary) untuk EUR/USD dan GBP/USD — dua-duanya jatuh ke `"model":"llama-3.3"` (Groq), bukan Ollama. Cek `vercel logs` produksi mengonfirmasi akar masalah: `ohlcv_analyze Ollama failed: The operation was aborted due to timeout`, dan circuit breaker `ai:ollama` sampai OPEN (3 kegagalan beruntun, di-pause 5 menit). Ollama Cloud `gpt-oss:120b` terbukti timeout konsisten di 15 detik, bukan sekadar lambat sesekali.

**Masalah budget waktu:** `api/admin.js` (`ohlcv_analyze`) punya `maxDuration: 60` (vercel.json). Kalau SambaNova akun 2 (30s) disisipkan SEBELUM Ollama (15s), total 30+30+15=75s — melewati limit 60s bahkan sebelum Ollama sempat dicoba di skenario terburuk.

**Keputusan (dikonfirmasi user):** drop Ollama & Groq sepenuhnya dari rantai ini, jadi 2 tingkat: Primary SambaNova akun 1 DeepSeek-V3.2 (30s) → Fallback 1 SambaNova akun 2 DeepSeek-V3.2 via `SAMBANOVA_API_KEY_CALL1` (25s, circuit `ai:sambanova:c1` — sudah ada, dipakai bersama `fundamental_analysis`/`journal.js`). Total 55s, aman di bawah limit.

**Perubahan kode (`api/admin.js`):**
- Blok fallback Ollama (`OLLAMA_URL`, `OLLAMA_MODEL`, fungsi `_callOllama`) dan blok Groq last-resort di `ohlcvAnalyzeHandler` dihapus — sudah tidak dipakai fitur manapun lagi di file ini (beda dari Ollama di `market-digest.js` yang independen, untuk diagnostik Nemotron).
- `ai:ollama` dihapus dari `KNOWN_CIRCUITS` (sudah tidak pernah disentuh); `ai:ollama:nemotron` tetap (masih dipakai `market-digest.js`).
- Diagnostik `?test_ollama=1` diganti `?test_samba_c1=1` (bypass primary untuk test fallback akun 2 langsung), pola sama seperti sebelumnya.
- `test/ollama.test.js` dihapus (menguji `_callOllama` yang sudah tidak ada) — 138/138 test lain tetap hijau.

**Belum di-deploy saat entry ini ditulis** — commit + push berikutnya di sesi yang sama, lalu diverifikasi live sekali lagi pasca-deploy.

---

## Changelog Session 155 lanjutan (2026-07-10) — Perpustakaan Rujukan Riset Akademis Makro/Forex

**Konteks:** user konsultasi dengan LLM lain soal riset seperti Klein (2022) yang bisa jadi "paper pembatas" (constraint paper) untuk proyek forex/makro Daun Merah ke depan, lalu minta pendapat. Diikuti follow-up "riset apa saja yang dibutuhkan, cukup itu saja kah?" — jawabannya tidak: 7 paper dari LLM konsultasi itu cuma menutup satu wilayah (prediktabilitas FX/NFP umum), sementara Daun Merah punya fitur lain yang masing-masing butuh rujukan sendiri, termasuk satu fitur LIVE yang mendorong sinyal trading nyata.

**Kerja:** setiap sitasi (dari LLM konsultasi user MAUPUN yang saya tambahkan sendiri) diverifikasi via web search terhadap sumber primer (NBER/JSTOR/RePEc/jurnal) sebelum dipakai — bukan ditelan mentah, karena bibliografi hasil LLM punya risiko sitasi fabrikasi (nama/tahun/jurnal salah).

**Hasil — file baru [Dokumentasi/daun_merah_referensi_riset.md](Dokumentasi/daun_merah_referensi_riset.md)**, 7 kategori dipetakan ke fitur spesifik Daun Merah (bukan daftar generik):
1. Prediktabilitas FX (Meese & Rogoff 1983; Cheung/Chinn/Pascual 2005+2019; Rossi 2013 JEL; Kwas/Beckmann/Rubaszek 2024 IJF) → Thesis AI `pair_recommendation`/`direction`.
2. Data makro vs konsensus (Klein 2022) → sudah dipakai penuh di riset NFP (STOP).
3. Nowcasting (Giannone/Reichlin/Small 2008 JME) → dasar metodologis retroaktif untuk [[labour-market-assessment-pivot]] yang sudah dieksekusi S154.
4. Kombinasi forecast (Bates & Granger 1969; Timmermann 2006; forecast-combination-puzzle) → validasi desain `buildAssessment()` labour market pakai agreement count sederhana, BUKAN pembobotan statistik — literatur bilang simple average sering menang vs optimal weighting.
5. Central bank information effect (Nakamura & Steinsson 2018 QJE) → invalidation trigger seputar FOMC/rate decision (belum diimplementasi eksplisit, dicatat sebagai referensi masa depan).
6. Reaksi pasar terhadap rilis makro (Andersen/Bollerslev/Diebold/Vega 2003 AER) → mengonfirmasi arsitektur kalender existing (surprise vs consensus, bukan level harga) sudah benar; relevan langsung ke bug Session 152 (Thesis Alert salah baca headline "Currency Strength Chart") & Session 155 (invalidation trigger currency salah pair).
7. **⚠️ Positioning retail sebagai sinyal kontrarian** (Klitgaard & Weir 2004, NY Fed Economic Policy Review) → **fitur LIVE** (Retail Sentiment `api/feeds.js`, dipakai Journal/Sizing/Scenario Comparison sejak session 134). Temuan: data CFTC net position spekulan berkorelasi kontemporer kuat dengan pergerakan FX TAPI **tidak terbukti prediktif** ke depan. Pencarian literatur akademik (bukan blog trading) untuk klaim "retail positioning ekstrem → reversal" mayoritas hanya menemukan konten praktisi tanpa validasi statistik formal. **Bukan rekomendasi hapus fitur** — murni dicatat supaya user sadar belum ada bukti akademis kuat yang ditemukan untuk edge statistik ini, beda dengan prinsip surprise-vs-consensus (poin 6) yang dukungan literaturnya jelas. Kalau mau diuji rigor gaya kill-gate NFP, ini titik awal yang tepat.

**Cara pakai (didokumentasikan di file):** sebelum proyek makro/forex baru, cek dulu apakah topiknya sudah ada constraint paper relevan → kalau constraint-nya negatif, pertimbangkan pivot tujuan riset dari "cari edge" ke "assessment kontekstual" (pola nowcasting) SEBELUM investasi waktu besar seperti yang terjadi di proyek NFP.

**Tidak ada perubahan kode/fitur** — sesi ini murni riset & dokumentasi, tidak menyentuh `api/*.js` atau `index.html`.

---

## Changelog Session 155 (2026-07-10) — Fix Bug Thesis Call 3: Invalidation Trigger Currency Tidak Konsisten dengan Pair (CAD di Thesis USD/JPY)

**Konteks:** User menempel screenshot dashboard RINGKASAN — kartu AI Thesis USD/JPY SHORT dengan `INVALIDASI: "Pengumuman CAD Employment Change dan Unemployment Rate dalam 2 jam ke depan"`. CAD bukan bagian pair USD/JPY sama sekali, tanya "ini hubungannya apa?".

**Root cause:** Call 3 (`thesisPrompt` di [api/market-digest.js](api/market-digest.js#L1716)) mengirim `calBlock` berisi SEMUA event kalender high-impact 3 hari ke depan dari 8 major currency (tidak difilter per pair) ke model, lalu cuma menyuruh lewat instruksi teks "if a high-impact event for one of the pair currencies is scheduled... name it as the primary invalidation trigger" — tanpa validasi pasca-generate. Model (SambaNova DeepSeek-V3.2 / fallback Groq) bisa salah comot event currency yang tidak relevan dengan pair yang direkomendasikan (event kalender paling menonjol/terdekat waktu, bukan yang relevan ke pair). `validateThesis()` lama cuma cek enum field (regime/currency/direction/confidence/xau_*), tidak pernah cek konsistensi currency dalam `invalidation_condition` terhadap `pair_recommendation`.

**Fix (2 lapis, [api/market-digest.js](api/market-digest.js)):**
1. **Prompt diperkuat** — instruksi CRITICAL eksplisit: calBlock berisi event 8 currency, hanya boleh kutip event yang currency-nya benar-benar salah satu dari dua currency di `pair_recommendation`; kalau tidak ada event yang cocok, dasarkan `invalidation_condition` pada price/technical/fundamental, jangan pinjam event currency lain.
2. **Validasi pasca-generate (jaring pengaman)** — helper murni baru di module scope (bukan lagi nested di handler, supaya unit-testable): `thesisPairCurrencies()` (parse "USD/JPY" → `['USD','JPY']`, null kalau format rusak/currency sama/bukan major) dan `thesisInvalidationCurrencyConsistent()` (ekstrak currency code eksplisit dari teks `invalidation_condition` via regex, tolak kalau ada currency di luar pair; `direction:'no_trade'` selalu lolos karena tak ada pair yang benar-benar ditradingkan). Diplug ke `validateThesis()` — kalau gagal, sama seperti schema-invalid lain: loop lanjut ke provider fallback (SambaNova→Groq), kalau dua-duanya gagal thesis tetap `null` dan UI sajikan `latest_thesis` lama dari Redis (tak fatal, pola existing).

**Keterbatasan yang disadari:** regex cuma menangkap currency ditulis sebagai kode eksplisit (USD/CAD/dst) — kalau model menulis dalam Bahasa Indonesia tanpa kode currency (mis. "data ketenagakerjaan Kanada" tanpa kata "CAD"), validator tidak menangkap. Prompt yang diperkuat adalah lapis pencegahan utama; validator adalah jaring pengaman untuk kasus paling jelas (termasuk bug asli yang ditemukan, yang eksplisit menulis "CAD").

**Pengujian:** [test/market_digest_thesis.test.js](test/market_digest_thesis.test.js) baru — 8 test (parse pair valid/rusak, invalidation lolos kalau currency in-pair, GAGAL persis reproduksi bug asli CAD-di-USD/JPY, no_trade selalu lolos, pair rusak pada direction aktif gagal, no-regression field lain). `npm test` penuh: **144/144 pass** (136 lama + 8 baru), tidak ada regresi dari pemindahan `validateThesis`/const terkait dari block-scope handler ke module-scope.

**Konteks:** Perintah user "kerjakan daun_merah_plan.md (H, I, J, K) dengan framework claude.md". Keempat plan dieksekusi berurutan dalam satu sesi; seluruh section H/I/J/K dihapus dari `daun_merah_plan.md` setelah selesai.

**H — US Labour Market Assessment (kartu tab FUNDAMENTAL, rule-based, BUKAN prediksi/ML).** Pivot pasca kill-gate riset NFP (S150/151/153), 3 syarat wajib dipenuhi: confidence ordinal "X dari Y indikator searah" tanpa persen; narasi antar-indikator dibingkai teori ("Secara teori..."); label jujur "Konteks, bukan sinyal — data sudah priced-in".
- **BARU** [api/_labour_market.js](api/_labour_market.js) — 8 seri FRED (JTSJOL, JTSQUR, ADPMNUSNERSA, TEMPHELPS, ICSA, CCSA, JTSLDR, CES0500000003; NFIB di-skip, berbayar) dalam 3 dimensi HIRING/LAYOFFS/WAGE. Pure functions: `classifyIndicator()` (5 metode window + flat band per indikator; arah dibalik utk klaim/layoffs; field `raw` = arah data mentah TERPISAH dari `status` supaya panah UI tidak menyesatkan utk indikator terbalik — mis. klaim naik = panah ↑ warna merah), `buildAssessment()` (agreement count; label STRONG ≥3/4 & total ≥6, MODERATE ≥55%, sisanya MIXED; <4 tersedia = "DATA TIDAK CUKUP"), narasi deterministik Bahasa Indonesia (bukan LLM — nol biaya/latensi provider), `fetchLabourSeries(fetchImpl)` injectable + filter `'.'` + `Promise.allSettled` (gagal per-seri → unavailable, denominator menyesuaikan). Stale flag: mingguan >21 hari, bulanan >75 hari (JOLTS lag 2 bulan = normal).
- **EDIT** [api/real-yields.js](api/real-yields.js) — branch `?section=labour` (menumpang function existing, limit 12/12 Vercel Hobby tidak bertambah): cache Redis `labour_market` TTL 6 jam → single-flight `lock:labour_market` (try/catch: Redis down = compute langsung, jangan gagal karena cache) → gagal semua → cache stale → 502.
- **EDIT** `index.html` — kartu `#fundLabourSection` (setelah RR section), CSS `.fund-labour-*`, JS `fetchLabourMarket()`/`renderLabourMarket()` (escHtml semua string API; gagal fetch → section disembunyikan), hook di `switchView('fundamental')` + tombol refresh.
- **BARU** [test/labour_market.test.js](test/labour_market.test.js) — 21 test (naik/turun/flat per metode, arah terbalik, raw vs status, stale, agreement/label ordinal, missing/insufficient, filter `'.'`, narasi teori+priced-in tanpa persen, end-to-end payload).
- **Verifikasi live produksi (pasca deploy):** endpoint `GET /api/real-yields?section=labour` LIVE — 8/8 indikator terisi data FRED asli, label `MIXED` "3 dari 8 indikator searah", narasi & disclaimer benar. Verifikasi live menemukan 1 bug asli: **seri `ADPMNUSNERSA` ternyata berunit ORANG (level ~134 juta), bukan ribuan** → display "+108333rb/bln" & flat band ±25 efektif nol. Fix commit kedua: `scale: 0.001` per-indikator di config (dinormalisasi ke ribuan saat fetch), cache key bust `labour_market` → `labour_market_v2`, +2 test regresi (total test 135).
- **Revisi lanjutan (sesi sama, atas permintaan user):** (1) **NFP resmi ditambahkan sebagai indikator ke-9** — seri FRED `PAYEMS` (level total nonfarm BLS, ribuan; Δ MoM terakhir = angka headline NFP), dim HIRING, metode delta3m sama dengan ADP tapi `showLatest: true` (chip menampilkan Δ rilis terakhir mis. "+147rb/bln", status tetap dari perbandingan rata-rata 3 bulan karena satu rilis bising/kena revisi). Konsisten dengan kill-gate: ini menampilkan rilis historis, bukan prediksi pre-rilis. Cache bust → `labour_market_v3`. (2) **Kartu dipindah dari section standalone di atas tab FUNDAMENTAL → blok di dalam detail USD** (`fdOverlay`, yang terbuka saat kartu USD di-tap; punya tab per-currency) — render via `_buildLabourFdHtml()` dipanggil `_renderFundDetail()` khusus `cur==='USD'`, styling mengikuti `.fd-extra-block` (pola Yield Curve/Likuiditas USD), fetch lazy dari `_renderFundDetail` + prefetch `switchView('fundamental')`. `renderLabourMarket()` & `#fundLabourSection` lama dihapus. Test: 136/136 unit + 31 check browser (termasuk assert NFP chip, blok hanya di USD bukan EUR, overlay 390px tanpa overflow). **Terverifikasi live produksi:** 9/9 indikator tersedia, NFP tampil "Rilis terakhir +57rb/bln · rata-rata Δ 3 bln +111rb vs +73rb → strengthening" (as_of 2026-06-01), label keseluruhan `MIXED` "4 dari 9 indikator searah".
- **Revisi kedua (kritik user "pemborosan fitur — sudah ada golongan Ketenagakerjaan di card USD"):** blok "US Labour Market" terpisah DIHAPUS, assessment **dilebur ke section Ketenagakerjaan** di detail USD via `_buildLabourMergedHtml(rowKeys)`: badge + "X dari 9 searah" + narasi tampil di bawah header section, chip "TREN FRED" hanya utk indikator yang TIDAK punya baris headline (dedupe via `LABOUR_ROW_MAP`: PAYEMS→NFP, JTSJOL→JOLTS Job Openings, ADP, ICSA→Jobless Claims, CCSA→Continuing Claims, CES→Wage Growth; chip unavailable di-skip); section tetap dirender walau baris headline kosong (FRED deterministik). Sekaligus ide user kedua dieksekusi: **chip filter golongan di detail currency** (`#fdSecTabs`: SEMUA default | Inflasi | ... | hanya section berisi) — mengurangi scroll panjang; pilihan nempel saat pindah currency (fallback tampil SEMUA jika section tak tersedia), blok ekstra Yield Curve/Likuiditas hanya tampil di SEMUA. Test akhir: 136/136 unit + 34 check browser.
- **Revisi ketiga (keluhan user "ukuran detail mata uang kayak jelek"):** overlay detail di desktop ≥1024px dilebarkan 600px → 920px + baris indikator per section jadi grid 2 kolom (wrapper `.fd-sec-rows`) supaya lebar benar-benar terpakai (bukan baris renggang) & scroll makin pendek; HP/tablet kecil tidak berubah. Ringkasan labour/narasi/chip TREN FRED tetap bentang penuh.

**I — COR-H: Cross-Asset Correlation jadi visual chart + narasi (lanjutan COR-B..G; murni presentasi, `api/correlations.js` TIDAK disentuh).** Skill `dataviz` di-invoke sebelum menulis kode chart; palet diverging existing lolos validator skill (hijau `#27ae60` vs merah `#c0392b` di surface `#111110`: CVD ΔE 21,4 ≥ 12, kontras ≥3:1; abu = midpoint netral by design).
- `index.html`: helper `_corrBarHtml()` (track diverging skala tetap −1..+1, bar = r20 warna semantik `corrColor()` existing, tick terang = norma r60, null-safe), `_buildAnomalyNarrative()` (deterministik; kosong → string kosong TANPA section; isi → sorot `anomalies[0]` + klausa arah sign-flip/melemah/menguat + ringkasan "+N hubungan lain"), CSS `.corr-chart-*`/`.corr-narrative`/`.corr-anomaly-more`.
- `renderCorrelations()`: narasi di atas kedua chart; gold correlation table (XAUUSD) → bar chart (urutan `goldOrder` tetap, aset tanpa data di-skip, angka 20d/60d + Δ kuning >0.3); section ANOMALI → kartu visual per anomali dengan track bar, top 5 + `<details>` "lihat semua (N)". **Empty state anti-noise dipertahankan persis**: teks "Tidak ada anomali korelasi signifikan saat ini." dan NOL elemen chart/narasi di DOM (di-assert browser test, bukan cuma display:none). Tabel korelasi per-pair TEK (non-XAU) tidak diubah.

**J — Dead-code pass (scoped, terukur, reversibel).** Baseline `index.html` 13.798 → **13.756 baris (−42)**; `api/*.js` audit = **0 fungsi mati** (bersih). Dihapus (semua diverifikasi manual, single-occurrence CSS-only / provably-unreachable): CSS `.corr-val`, `.cot-section`, `.cot-title`, `.cot-subtitle`, `.cot-row-wrap`, `.cal-scenario-pair-reason`, `.cb-grid/.cb-card/.cb-updated` (legacy "kept for JS compat" yang JS-nya sudah tidak ada), `.dash-digest-label`, `.tek-pair-select` (2 rule; digantikan `.tek-pair-combo/trigger`); JS aparatus deferred-reveal orphan di IIFE topChrome (`schedulePendingReveal` tak pernah dipanggil → `pendingTopReveal` selalu null → `cancelPendingReveal` no-op; fungsi + variabel + 2 call site). **TIDAK dihapus** (sesuai prinsip "ragu = jangan"): 38 kandidat false-positive — class data-driven (`.BIS/.FED/...` via `riset-badge ${source}`, `.cat-*/.tag-*/.cal-cur-*/.impact-*` via template literal prefix dinamis). Audit via skrip statis + verifikasi manual per item; 134 unit test + 28 check browser tetap hijau setelah penghapusan.

**K — Audit anti-copy (Opsi A: audit + dokumentasi, TANPA perubahan kode).** Hasil audit kebocoran: **BERSIH** — nol API key/secret di `index.html`/`sw.js` (match pola `sk-` hanya false positive "ri**sk-o**n"), nama provider AI muncul HANYA sebagai label badge UI, **nol `fetch()` client langsung ke domain eksternal** (semua via `/api/*` server-side), satu-satunya string panjang = `VAPID_PUBLIC_KEY` (memang publik by design utk Web Push). Ekspektasi jujur tertulis: proteksi frontend sempurna itu MUSTAHIL (view-source/DevTools selalu bisa); nilai nyata aplikasi (prompt AI, logic parsing/sizing, API key) sudah di server + gate `APP_KEY` membatasi pemakaian kuota. **Opsi B (build step minifikasi) TIDAK dieksekusi** — infra change, butuh persetujuan eksplisit user; bisa diminta kapan saja. Disable klik-kanan/DevTools sengaja TIDAK dikerjakan (security theater, trivial dibypass, merusak UX).

**Pengujian:** `npm test` 134/134 (113 lama + 21 baru). Smoke test browser otomatis (Puppeteer + Chrome sistem, pola S152): 28 check lulus — kartu Labour (fetch path asli + mock API, badge/chip/panah raw/narasi/footer), chart anomali (7 anomali → 5 + details), gold chart, empty state DOM-kosong, viewport 390px tanpa overflow horizontal (TEK + FUNDAMENTAL), screenshot desktop/mobile diperiksa visual.

## Changelog Session 153 (2026-07-10) — Riset NFP Celah 2 (Kalshi) Akhirnya Dieksekusi Penuh via VPN: GAGAL

**Konteks:** Melunasi action item Session 151 ("jalankan `fetch_kalshi.py` via VPN"). User mengaktifkan VPN → probe sukses (exchange aktif, S3 reporting HTTP 200) → pipeline penuh `python fetch_kalshi.py` dieksekusi sampai selesai (exit 0). Sebelumnya terverifikasi juga bahwa tanpa VPN akses masih terblokir (probe → SSL error internetpositif), jadi blokir Kominfo masih aktif — reproduksi selalu butuh VPN. Semua tetap terisolasi di `NFP_PROYEK/` (gitignored), nol perubahan kode app.

**Hasil: GAGAL.** Dari 40 rilis dicoba (ref 2023-02..2026-06), 33 ber-harga: jalur S3 dump reporting harian (2023-03..2025-08, file 0,4–32 MB) + jalur API candlesticks (2026-04..06). Gap jujur: 6 rilis ref 2025-09..2026-03 (file S3 meledak 435 MB–1,9 GB karena market sports, > limit 120 MB → skip terdokumentasi) + 1 rilis 2023-02 (strike terdekat terlalu jauh dari konsensus). Evaluasi pola Fase 1 (pred = sign(P_implied H-1 − 0,5) vs `tgt_surprise_dir`, baseline max(majority, alternation), permutation circular-shift): **hit-rate 45,45% vs baseline 60,61%, p_perm 0,9005 → tidak lolos**. Implied probability pasar Kalshi H-1 bahkan di bawah coin-flip pada sampel ini. Label "INDIKASI AWAL" (n=33 kecil + gap) tapi arah temuan konsisten dengan 0/25 Fase 1 dan SPF skill 0/6. KYC ternyata TIDAK dibutuhkan — data publik S3 + API cukup.

**Kill-gate gabungan (final untuk 3 celah): Celah 1 GAGAL, Celah 2 GAGAL, Celah 3 bukan unit kill-gate → akumulasi lolos tetap 0 dari syarat ≥3 → STOP proyek utama TETAP BERLAKU.** Satu-satunya yang masih hidup: tracking observasional Celah 3 (`predict_live.py`, prediksi pertama H-1 rilis NFP 2026-08-07) + action item opsional WARN via ICPSR. Tetap TIDAK ada integrasi ke app, TIDAK ada angka prediksi NFP di UI, TIDAK ada sinyal trading.

**Output & dokumentasi:** `NFP_PROYEK/data/kalshi_h1_prob.csv` (40 baris berformat final source/note/status, menimpa CSV parsial 3-baris dari sesi VPN 07-07/08), `data/kalshi_s3/` (cache 31 dump H-1), `results/kalshi_relationship.csv` (baru). `REPORT.md` §8.2, `STATUS.md` (section Celah 2 + kill-gate), dan `daun_merah_plan.md` diperbarui dari "TIDAK BISA DIUJI / action item" → "GAGAL, dieksekusi 2026-07-10".

## Changelog Session 152 (2026-07-10) — Fix Bug Thesis Alert: Salah Baca Ranking "Currency Strength Chart"

**Konteks:** User menempel contoh output Thesis Alert yang janggal di `daun_merah_plan.md` lalu konfirmasi "ada bug disitu". Thesis Alert (Call 4, `checkThesisContradictions()` di [api/market-digest.js](api/market-digest.js#L480)) menandai posisi jurnal terbuka XAU/USD LONG sebagai kontra headline: `"Currency Strength Chart: Strongest: NZD, CHF, CAD, AUD, EUR, GBP, USD, JPY - Weakest"`, dengan alasan "USD is one of the strongest currencies, directly contradicting the LONG XAU/USD thesis which requires USD weakness".

**Bug:** Headline itu adalah daftar terurut kuat→lemah. USD ada di posisi ke-7 dari 8 (cuma di atas JPY) — nyaris paling LEMAH, bukan salah satu yang terkuat. Model (SambaNova DeepSeek-V3.2 / fallback Groq) salah menghitung posisi dalam list bertingkat lalu membuat alert kontradiksi palsu — padahal posisi asli USD di situ justru MENDUKUNG thesis LONG XAU/USD (butuh USD lemah), bukan membantahnya. Headline ranking seperti ini juga seharusnya sudah kena aturan existing "ignore price-level headlines" (ini price-derived technical snapshot, bukan fundamental catalyst) tapi tidak konsisten dipatuhi.

**Fix:** Perkuat prompt Call 4 di `checkThesisContradictions()` — tambah instruksi eksplisit: abaikan headline "Currency Strength Chart" / ranking mata uang sepenuhnya sebagai bukti kontradiksi, karena (a) itu price-derived bukan fundamental catalyst, dan (b) urutan "Strongest: A, B, C... - Weakest" gampang salah baca posisi oleh model.

**Keterbatasan verifikasi:** Ini fix di level prompt untuk pemanggilan LLM eksternal (SambaNova/Groq) — API key provider tidak tersedia di environment lokal untuk test langsung end-to-end. Sudah divalidasi: `node --check` syntax OK, struktur JSON contract & validasi verbatim-headline (`entryById`, `headlineSet`) di Call 4 tidak berubah. Perilaku aktual model terhadap instruksi baru ini baru bisa dikonfirmasi dari output live berikutnya — pantau apakah headline "Currency Strength Chart" masih muncul jadi alasan Thesis Alert di sesi mendatang.

**Bonus (bukan bug, verifikasi user):** User cek SSL certificate myfxbook.com (sumber retail sentiment) — hasil: sertifikat sah (Google Trust Services WE1 → GTS Root R4 → GlobalSign Root CA, di belakang Cloudflare), tool checker sendiri konfirmasi "correctly installed". "Not issued by DigiCert/GeoTrust/Thawte/RapidSSL" cuma disclaimer promosi tool, bukan red flag. Tidak ada indikasi situs palsu. Detail di `daun_merah_plan.md`.

### Lanjutan sesi yang sama — 2 bug lagi ditemukan & diperbaiki

**Bug #2 — Retail Sentiment parser ambil kolom yang salah (fatal, bukan cuma soal realtime).** User bertanya apakah retail positioning realtime dan melacak sumber intinya ke myfxbook — dikonfirmasi benar: `api/feeds.js` scrape `forexbenchmark.com/quant/retail_positions/`, yang setiap barisnya link ke `myfxbook.com/community/outlook/{PAIR}`. Investigasi lanjut (download HTML live halaman itu) menemukan struktur tabel asli: `Symbol | Currency difference | Percentage long | Percentage/max | ...`. `parseRetailPositions()` lama mengambil "angka pertama yang ditemukan di teks baris" sebagai `long_pct` — itu jatuh ke kolom **"Currency difference"**, BUKAN kolom **"Percentage long"** yang benar (index ke-2, 0-based). Contoh nyata dari data live (2026-07-10): AUDUSD ditampilkan 61.1% long padahal sebenarnya **5.2%** (sinyal kontrarian terbalik total, LONG↔SHORT); XAUUSD ditampilkan 6% (trigger CONTRARIAN_LONG palsu) padahal sebenarnya **44%** (harusnya NETRAL). Bug ini sudah ada sejak fitur retail sentiment dibuat (session 134), memengaruhi sinyal kontrarian yang dipakai di Journal/Sizing/Scenario Comparison. **Fix:** parser ditulis ulang di [api/feeds.js](api/feeds.js) — parse per-`<td>` berdasarkan index kolom (cocok dengan `<thead>` asli), bukan regex tebak posisi. Diverifikasi terhadap HTML live asli (angka sekarang cocok kolom "Percentage long" yang benar) + 4 test regresi baru di `test/feeds_retail.test.js` (113/113 test suite pass, termasuk 4 test baru).

**Bug #3 — Menu HP (mobile) tumpang tindih klik dengan REGIME banner.** User laporan lama: di HP, klik item menu (mis. Notifikasi/Kategori Push) kadang malah membuka daftar lengkap REGIME/VIX. Root cause dikonfirmasi lewat browser test otomatis (Puppeteer, viewport 390×844): `.header` punya `z-index:100` dideklarasikan TAPI TANPA `position` — CSS mengabaikan `z-index` tanpa `position` (atau flex/grid item). Ditambah `backdrop-filter: blur(12px)` di `.header` membuat stacking context terisolasi sendiri, sehingga `.header-menu-dropdown` (z-index:500) di dalamnya cuma menang lokal — `.header` sebagai satu kesatuan tetap kalah tumpuk melawan `.regime-banner` (sibling setelahnya di DOM, z-index:auto). Efek nyata: pada rentang tinggi layar tertentu (terverifikasi y=115–125px @ 390×844 saat item "Kategori Push" aktif), `elementFromPoint` mengembalikan `.regime-sess-next` (bagian dari regime banner) alih-alih tombol menu, walau visual menu terlihat di atas. **Fix:** tambah `position: relative;` di `.header` ([index.html](index.html)) — satu baris, mengaktifkan `z-index:100` yang sudah ada supaya seluruh stacking context `.header` (termasuk dropdown) menang tumpuk melawan `.regime-banner`. Diverifikasi end-to-end via Puppeteer: sweep seluruh tinggi dropdown (y=55–190) sekarang selalu resolve ke item menu yang benar, klik simulasi di koordinat yang dulu bocor (279,115) sekarang benar memicu `pushUpdateCategories()` tanpa menyentuh `toggleRegimeDetail()`, dan klik langsung ke regime banner (menu tertutup) tetap berfungsi normal (tidak ada regresi).

## Changelog Session 151 (2026-07-07) — Riset NFP Lanjutan "3 Celah Pasca Kill-Gate": 1 Gagal, 1 Terblokir Jaringan, 1 Live Tracking Aktif

**Konteks:** Eksekusi plan `daun_merah_plan.md` section G revisi ("3 Celah Lanjutan Pasca Kill-Gate Fase 1") — tiga mekanisme yang genuinely beda dari 25 uji yang gagal di Session 150. Semua tetap terisolasi di `NFP_PROYEK/` (gitignored), nol perubahan kode app. Metodologi dipertahankan sama ketat dengan Fase 1: walk-forward temporal, permutation circular-shift, baseline max(majority, alternation), laporan jujur. Detail lengkap: `NFP_PROYEK/results/REPORT.md` §8 + `NFP_PROYEK/STATUS.md` section "RISET LANJUTAN 3 CELAH".

**Celah 1 — SPF forecaster-skill weighting: GAGAL (0/6 varian).** `analyze_spf_skill.py` baru: struktur SPF microdata diverifikasi dulu (91 survei 2003Q4–2026Q2, EMP1 base prefilled spread max 0,68%, median hitung sendiri == file resmi), spec pre-registered di header (skill = mean percentile-rank error growth per survei, era-neutral, partisipasi ≥8, warm-up 16 kuartal, main spec EMP2 K=10%), permutation me-re-run SELURUH pipeline (skoring→seleksi→evaluasi) — bukan cuma evaluasi akhir. Main spec: 55,3% vs baseline 47,4%, p=0,778. Temuan metodologis penting: varian dengan hit-rate nominal 64–65% pun TIDAK signifikan (p=0,09–0,30) karena null permutation terpusat ~61% — prediksi top-K dan target surprise sama-sama skew positif, "akurasi" itu produk skew searah, bukan alignment waktu (kelas jebakan yang sama dengan alternation-proxy Fase 1). Power check sintetis: skill buatan disisipkan → 78,1%, p≈0 → mesin uji punya power, sinyalnya memang tidak ada. Konsisten (lagi) dengan Klein (2022).

**Celah 2 — Kalshi prediction market: TIDAK BISA DIUJI dari environment ini.** Go/no-go berhenti di akses: seluruh domain kalshi.com di-DNS-hijack ISP ke `aduankonten.id` (cert `internetpositif.id` = blokir Kominfo; berlaku juga untuk query ke 8.8.8.8 dan fetcher remote sesi ini; upaya probe lewat IP langsung ditolak permission classifier — memang keputusan user). Verifikasi sekunder via web search: market NFP Kalshi ADA (series `KXPAYROLLS`, `KXUSNFP`, `PAYROLLS` legacy; jejak minimal sejak awal 2023 → n ~30–40, hasil kelak wajib berlabel "indikasi awal"). `fetch_kalshi.py` siap-pakai ditulis (probe → settled markets → candle H-1 → P(actual>konsensus) → evaluasi reuse `cross_validation.py`) tapi belum pernah jalan sukses. **Action item user: jalankan `python fetch_kalshi.py --probe` via VPN/jaringan bebas blokir.** Status: BELUM TERUJI (bukan gagal).

**Celah 3 — Live validation model dua-sisi: AKTIF.** Temuan sekunder Fase 1 (logistic 9 fitur, 64,5% vs majority 57,7% in-sample) di-pre-register: spec BEKU v1 2026-07-07 di header `predict_live.py` (fitur diimpor langsung dari `train_models.py`, bukan disalin; dilarang dituning — perubahan = tracking ulang dari nol). Konsistensi diverifikasi: prediksi spec beku untuk 3 bulan test terakhir identik dengan langkah walk-forward Fase 1. Alur harian otomatis: deteksi window H-1 (36 jam pra-rilis, jadwal live dari kalender TV) → refresh incremental semua sumber (ALFRED vintage = state-of-knowledge; NFIB PDF bulanan auto-download, pola URL terverifikasi) → rebuild panel (`build_panel()` sekarang berindeks dinamis; default hari ini identik lama) → prediksi → `results/live_predictions.csv` → settle otomatis pasca-rilis; checkpoint statistik di n≥12, final n≥18. Aturan integritas: `late_reconstruction` dikeluarkan dari evaluasi headline, fitur hilang = gap jujur, baris ber-prediksi tak pernah ditimpa. Prediksi pertama: H-1 rilis NFP 2026-08-07. **Action item user: daftarkan Task Scheduler harian 22:00 WIB** — perintah satu baris ada di `NFP_PROYEK/STATUS.md` (pembuatan otomatis `schtasks /create` ditolak permission classifier sesi otomatis, wajar untuk persistensi).

**Kriteria gabungan kill-gate:** akumulasi hubungan genuinely-baru yang lolos = 0 dari syarat ≥3 (Celah 1 gagal, Celah 2 belum teruji, Celah 3 bukan unit kill-gate) → **status STOP proyek utama TETAP BERLAKU**; yang hidup hanya tracking observasional Celah 3 + dua action item user (Kalshi via VPN, WARN via ICPSR). Tetap TIDAK ada integrasi ke app, TIDAK ada angka prediksi NFP di UI, TIDAK ada sinyal trading.

## Changelog Session 150 (2026-07-07) — Riset NFP Kausal Fase 1: Dieksekusi Penuh Satu Sesi, Kill-Gate TIDAK Lolos → STOP

**Konteks:** Eksekusi penuh plan `daun_merah_plan.md` section G (riset kausal NFP, pivot dari plan ML lama). Seluruh pipeline Minggu 1–6 dikerjakan dalam satu sesi di folder terisolasi `project_delay/machine learning/ml/NFP_PROYEK/` (folder ini gitignored — deliverable lengkap ada lokal, tidak ter-push). Tidak ada satu pun perubahan ke `api/*.js` (sesuai constraint isolasi).

**Verdict: KILL-GATE TIDAK LOLOS — 0/25 uji hubungan indikator→NFP memenuhi kriteria (syarat lanjut Fase 2: ≥3). Proyek STOP, hasil negatif dilaporkan jujur (pola sama dengan riset ML BTC "direction = dead end").** Detail lengkap: `NFP_PROYEK/results/REPORT.md` + `NFP_PROYEK/STATUS.md`.

**Yang dibangun (semua tervalidasi & reproducible):**
- **Pipeline data first-release (anti look-ahead):** vintage walk ALFRED via endpoint publik `alfredgraph.csv` (FRED_API_KEY tidak terpakai — penarikan credential Vercel diblok kebijakan sesi, endpoint publik terbukti cukup). First print ICSA/CCSA (2009+), PAYEMS (1998+), JOLTS (2010+; ditarik ulang via vintage setelah EDA membuktikan revisi JOLTS median 3,8%). Validasi kunci: first print NFP hasil rekonstruksi vintage vs `actual` TradingView = median selisih 0K di 161 bulan overlap.
- **NFIB hiring plans + job openings 2003–2026** di-scrape dari 5 PDF SBET (sebagian via Wayback Machine) — termasuk komponen ETI "% positions not able to fill" yang di plan dikira proprietary murni. Nilai antar-PDF identik (NFIB tidak merevisi histori SA).
- **SEC EDGAR full-text search:** count bulanan filing 8-K per 4 frasa layoff, 2001–2026 (306 bulan).
- **Konsensus NFP TradingView** (reuse sumber `api/calendar.js`): 164 rilis 2013–2026. **SPF microdata** Philadelphia Fed (kuarteran, robustness only). Panel final: 342 bulan × 31 kolom.
- **Metodologi:** walk-forward temporal + permutation test circular-shift 1000× + expected sign dikunci a priori dari mekanisme + BH-FDR 10% + baseline naive max(majority, alternation).
- **Ticker ETI yang tadinya belum dicari — ketemu:** `TEMPHELPS`, `LNS12032194` (+`CE16OV`).

**Hasil:** (1) Target utama — arah surprise vs konsensus: SEMUA 13 indikator gagal (best 52,3% vs baseline 57,7%) → konsisten Klein (2022), konsensus sudah mengimpound indikator publik. (2) Target sekunder — akselerasi first-print: 2 hubungan claims signifikan permutation (p≤0,018) tapi kalah dari baseline alternation ~61–64% (target mekanis anti-persisten) → jebakan false-positive terdeteksi di evaluasi mandiri, baseline diperkuat sebelum verdict. (3) Satu temuan sekunder positif: model logistic dua-sisi 9 fitur = 64,5% vs 57,7% (permutation p≈0) di target surprise — BUKAN kelolosan gate (unit gate = hubungan individual; ada fitur revised; belum pre-registered), dicatat sebagai kandidat hipotesis baru dengan syarat validasi live 12–18 bulan.

**Kendala akses terdokumentasi:** Cleveland Fed WARN factor terkunci login ICPSR (gratis; action item user kalau mau menambahkan indikator ini), HWOL Conference Board tidak tersedia gratis di era Lightcast (gap diterima, JOLTS meng-cover), ADP vintage cuma 2022+ (dipakai revised + caveat).

**Keputusan produk:** tidak ada integrasi apa pun ke app (kill-gate gagal DAN plan memang mensyaratkan permintaan eksplisit user). Causal read TIDAK dibangun. Sesuai penolakan lama "hard-multiplier sizing berbasis kalender buta" — tidak ada jalur baru yang menghidupkan ide itu.

## Changelog Session 149 (2026-07-07) — Fix: Post Gambar CFTC (FJElite) Nyasar ke Tab ARTIKEL Tanpa Gambar

**Ditemukan user:** di tab ARTIKEL, muncul beberapa entry dari FinancialJuice yang isinya cuma menampilkan data CFTC positioning dalam bentuk gambar — bukan artikel/riset asli. Asumsi user: karena title-nya bertag "FJElite" maka otomatis masuk fitur artikel, padahal isinya cuma gambar dan gambarnya sendiri tidak ditampilkan (beda dari headline chart lain di tab NEWS yang punya tombol "Lihat Chart").

**Root cause (dikonfirmasi lewat fetch RSS live, bukan dugaan):** tab ARTIKEL (`fjResearchItems`, `index.html`) me-reroute semua item RSS FinancialJuice yang title-nya diakhiri suffix "- FJElite" dengan asumsi semuanya adalah catatan analis panjang (body teks di `<description>`). Fetch langsung `financialjuice.com/feed.ashx?xy=rss` menemukan 15 item "XXX CFTC Positions Week Ended June 30th - FJElite" (per currency/instrument: USD, EUR, AUD, JPY, GBP, CHF, NZD, CAD, ZN, ZT, NQ, ES, Copper ×2, Gold) yang `<description>`-nya **benar-benar kosong** (`<description />`) — isi aslinya cuma gambar chart di `financialjuice.com/images/{guid}.png` (dikonfirmasi HTTP 200 ~60KB per guid). Karena suffix "- FJElite" tetap match, ke-15 nya ikut ter-reroute ke ARTIKEL sebagai "artikel" tanpa teks dan tanpa gambar — `renderResearch()` (tab ARTIKEL) memang tidak punya mekanisme render gambar sama sekali, beda dengan `renderFeed()` (tab NEWS) yang sudah punya toggle "Lihat Chart" + `<img>` untuk post gambar sejenis (`chart`/`matrix`/`heatmap`/`probabilities` di title).

**Fix (`index.html`):**
1. `fetchFeed()` — item FJElite sekarang hanya di-reroute ke ARTIKEL kalau body teksnya (setelah `sanitizeDescMultiline`) benar-benar berisi. Item FJElite dengan description kosong tetap di NEWS, dengan suffix "- FJElite" dibersihkan dari title (`cleanFJEliteTitle`).
2. `fjImageType()` — ditambah pengenalan pola "CFTC Positions Week Ended" supaya item ini dapat tombol "Lihat Chart" yang sama seperti post gambar lain. Regex sengaja dibuat spesifik ke frasa "Week Ended" (bukan "CFTC Positions" saja) — ada 1 post ringkasan non-FJElite ("CFTC Positions in the Week Ended June 30th") dengan title mirip tapi **tidak** punya gambar (dikonfirmasi 404); regex longgar akan memberi post ini tombol chart palsu.

**Verifikasi:**
1. **Replay logika murni** (fungsi `isFJElite`/`isFJEliteNote`/`cleanFJEliteTitle`/`fjImageType` disalin persis dari `index.html`) terhadap snapshot RSS asli (100 item nyata dari FinancialJuice, termasuk 15 item CFTC) via Node — hasil: 0 item CFTC nyasar ke ARTIKEL, ke-15 nya tetap di NEWS dengan title bersih + `fjImageType` = `'chart'`; post ringkasan palsu-positif "CFTC Positions in the Week Ended" tetap `null` (tanpa tombol). Kontrol tambahan: item FJElite sintetis dengan body teks asli tetap benar ter-reroute ke ARTIKEL — jalur catatan analis asli tidak rusak.
2. **End-to-end di browser sungguhan:** server lokal (Node http shim yang menjalankan `api/feeds.js` asli, endpoint `type=rss` disajikan dari fixture snapshot RSS nyata di atas) + headless Chrome (`puppeteer-core` + Chrome yang sudah terpasang). Load `index.html` asli → tutup welcome modal → tab ARTIKEL: 0 item FJElite/CFTC (cuma 50 item riset institusional asli ING/FED/ECB/BIS/dst, sesuai ekspektasi). Tab NEWS: 100 item termasuk ke-15 CFTC dengan tombol "Lihat Chart" ter-render dan title sudah bersih dari suffix. Klik tombol salah satu item ("USD CFTC Positions Week Ended") → wrap gambar berubah `display:block` dengan `src` yang benar (`financialjuice.com/images/9666271.png`, independen dikonfirmasi valid via curl). Nol console error sepanjang alur.
3. `node --check` atas seluruh inline `<script>` di `index.html` bersih setelah perubahan (file ini murni HTML+vanilla JS tanpa build step/test suite otomatis untuk UI-nya).

**Catatan:** feed live FinancialJuice ternyata cukup fluktuatif (jumlah item & isi berubah antar-fetch dalam hitungan menit, kadang batch CFTC hilang dari window feed) — makanya verifikasi end-to-end pakai snapshot RSS nyata yang di-fixture-kan, bukan bolak-balik fetch live, supaya hasil deterministik dan tidak membebani upstream FinancialJuice.

---

## Changelog Session 148 (2026-07-07) — Fix: Output Analisa Fundamental Kepotong (`max_tokens` Terlalu Kecil)

**Ditemukan user:** generate Analisis Fundamental (ranking 8 currency + terkuat/terlemah + divergensi), output kepotong persis di tengah kalimat pertama bagian "DIVERGENSI TERBESAR" — bukan error, responsnya HTTP 200 normal tapi teksnya tidak selesai.

**Root cause #1:** `fundamentalAnalysisHandler` (`api/admin.js`, dipakai ketiga provider fallback-nya — Cerebras gpt-oss-120b, SambaNova DeepSeek-V3.2, Groq llama-3.3) pakai `max_tokens: 700`, padahal format jawaban yang diminta prompt (8 baris ranking + 2 paragraf terkuat/terlemah + 3 baris divergensi) secara konsisten butuh lebih dari itu. Fitur lain di file yang sama (`ohlcv_analyze`, JSON + commentary 4-5 paragraf) sudah pakai `max_tokens: 1500` untuk output yang setara kayanya dan terbukti stabil — disamakan.

**Root cause #2 (ketemu setelah tes live pertama):** menaikkan `max_tokens` ke 1500 saja TIDAK cukup — tes pertama justru kepotong lebih awal (item 6 dari 8 ranking). Penyebabnya: `gpt-oss-120b` (Cerebras) adalah model reasoning, hidden thinking token-nya ikut makan `max_tokens` budget yang sama dengan jawaban visible, dengan panjang yang variatif tiap request (dikonfirmasi dokumentasi resmi Cerebras: `reasoning_effort` param, default bukan "low"). Task ranking fundamental ini murni summarize data terstruktur, tidak butuh reasoning dalam — ditambahkan `reasoning_effort: 'low'` khusus panggilan Cerebras.

**Fix final:** `max_tokens` 700→1500 di ketiga provider + `reasoning_effort: 'low'` di panggilan Cerebras + log `console.warn` kalau `finish_reason === 'length'` di ketiganya (deteksi dini kalau terulang, tanpa perlu user lapor manual).

**Verifikasi:** `node -c api/admin.js` bersih tiap iterasi, full suite 109/109 tetap lulus. Deploy commit `91164ff` (max_tokens) lalu `452fe0c` (reasoning_effort). Tes live `?action=fundamental_analysis&force=true` di production: iterasi 1 (cuma max_tokens) → **masih kepotong** (bukti root cause #2 di atas); iterasi 2 (+ reasoning_effort) → **2x berturut-turut selesai lengkap** (8 ranking + terkuat/terlemah + 3 divergensi utuh, ~2s response time, `from_cache:false`).

---

## Changelog Session 147 lanjutan (2026-07-07) — Nemotron 3 Super Ronde 3: `chat_template_kwargs` Native Param, TETAP Timeout Penuh

**Konteks:** user berhipotesis kegagalan Nemotron 3 Super sebelumnya (Ronde 1-2) mungkin karena thinking-nya belum benar-benar mati, bukan soal resource contention — kalau `reasoning:{effort:'none'}` (parameter abstraksi OpenRouter) tidak diterjemahkan dengan benar untuk model hybrid Mamba-Transformer yang masih sangat baru ini, model bisa jadi tetap full-thinking diam-diam. Karena kode kita pakai `stream:false`, skenario itu **tidak terbedakan** dari resource contention murni — dua-duanya sama-sama kelihatan sebagai "timeout, nol konten". User usulkan parameter native model sendiri: `extra_body={"chat_template_kwargs":{"enable_thinking": False}}` — dikonfirmasi riset ini memang cara resmi NVIDIA (`build.nvidia.com`, dokumentasi Unsloth), bukan trik blog.

**Perubahan (`api/market-digest.js`, tier diagnostik `?test_nemotron_super=1` saja):** satu variabel per eksperimen — `withNoThink()` dan `reasoning:{effort:'none'}` dilepas semua, diganti `chat_template_kwargs:{enable_thinking:false}` murni. `max_tokens` 1300→4096, timeout 20s→30s, supaya constraint kita sendiri tidak lagi jadi kandidat penyebab kalau gagal lagi. Test suite 109/109 tetap lulus (`node --check` bersih), deploy commit `07f2064`.

**Hasil tes live:** `nemotron_super:The operation was aborted due to timeout(30006ms)` — **timeout PENUH lagi**, di batas waktu yang sudah dilonggarkan 50%, dengan parameter yang lebih "benar" dari yang pernah dicoba, dan token budget 3x lebih besar. `method:"fallback"` (semua fallback sengaja di-skip di tier diagnostik ini, by design, supaya hasil murni Nemotron Super saja yang kelihatan).

**Kesimpulan (lebih konklusif dari sebelumnya):** sekarang ada **3 ronde, 3 mekanisme disable-thinking yang benar-benar berbeda** (directive teks `/no_think`, parameter abstraksi OpenRouter `reasoning.effort`, parameter native model `chat_template_kwargs`), dengan config token/timeout berbeda-beda tiap ronde — **semua gagal**. Karena percobaan paling "benar secara teknis" (native param, resmi NVIDIA) dengan ruang paling longgar yang pernah dikasih tetap timeout penuh, hipotesis "reasoning belum benar-benar mati" bisa dicoret. Kesimpulan yang tersisa dan paling konsisten dengan semua data: **resource contention di sisi OpenRouter untuk model 120B yang masih baru dan berat**, bukan sesuatu yang bisa diperbaiki dari konfigurasi/parameter di sisi aplikasi ini.

**Status:** saga Nemotron 3 Super (dan Ultra) tetap **ditutup** — DeepSeek-V3.2/SambaNova tetap primary `market-digest` Call 1. Tidak ada rencana ronde 4 kecuali muncul sinyal baru (mis. kapasitas free-tier OpenRouter membaik, atau Nemotron dirilis ulang dengan endpoint berbeda).

---

## Changelog Session 147 (2026-07-07) — FIX Bug Produksi: Cache `latest_article` Tercemar Output Mentah Nemotron 3 Super

**Ditemukan user:** buka app pagi ini (09:28 WIB), badge model nampilkan `nemotron-3-super` dan isi artikel adalah chain-of-thought mentah bahasa Inggris ("We need to produce a pre-session briefing in Indonesian...") — bukan briefing Bahasa Indonesia yang seharusnya. Padahal per kesimpulan Session 145 lanjutan 6, Nemotron 3 Super seharusnya **inert** di produksi, cuma aktif lewat bypass diagnostik `?test_nemotron_super=1`.

**Root cause (dikonfirmasi baca kode, bukan dugaan):** `api/market-digest.js` baris ~1877 nulis hasil generate ke Redis key `latest_article` (key yang sama dibaca SEMUA user via `mode=cached`) dengan kondisi `article && method !== 'fallback' && method !== 'fallback_quota'` — **tidak ada pengecualian untuk request diagnostik**. Waktu tes live Nemotron 3 Super kemarin (Session 145 lanjutan 6, Ronde 1) dapat respons "HTTP-successful" (`method:"nemotron-3-super"`) walau isinya cuma reasoning trace mentah yang kepotong di `max_tokens=1300` — kondisi cache-write itu tetap terpenuhi, jadi ikut ter-`SET ... EX 21600` (6 jam) ke `latest_article`, menimpa artikel bagus sebelumnya. Efek sampingnya lebih luas dari sekadar cache: baris yang sama juga memicu `notifyDigestReady()` (push notification ke semua subscriber) — kemungkinan sempat mengirim notifikasi berisi konten rusak juga.

**Fix (`api/market-digest.js`):** kondisi cache-write + push notification sekarang tambah `&& !testNemotronOnly && !testNemotronSuperOnly` — kedua flag diagnostik itu (`?test_nemotron=1`, `?test_nemotron_super=1`) sekarang benar-benar terisolasi dari state produksi, sesuai desain awal yang dimaksud ("tidak pernah masuk jalur produksi normal") tapi belum pernah benar-benar dijamin di kode sampai sesi ini.

**Verifikasi:** `node --check` bersih, full suite 109/109 lulus (tidak ada test yang meng-cover cache-write ini secara spesifik — konsisten dengan catatan lama di `test/market_digest_nemotron.test.js` bahwa handler penuh sengaja tidak dites end-to-end karena terlalu banyak dependency eksternal; fix ini scope-nya kecil/jelas jadi tidak dipaksakan bikin test-infra baru). Deploy via commit `be70ff5`.

**Pembersihan cache yang sudah terlanjur rusak:** trigger 1x request biasa (GET polos ke `/api/market-digest`, tanpa parameter diagnostik apapun, tidak perlu secret — `APP_KEY` belum di-set jadi endpoint ini fail-open persis seperti akses user biasa) supaya jalur fallback normal (SambaNova/DeepSeek-V3.2) generate ulang dan menimpa cache. Hasil: `method:"deepseek-v3.2"`, artikel Bahasa Indonesia normal, HTTP 200 (17.3s). Diverifikasi ulang lewat `mode=cached` — `from_cache:true` dengan isi yang sama. Cache bersih, user yang reload app sekarang akan melihat versi yang benar.

**Catatan:** durasi sebenarnya cache yang rusak ini aktif (dari kapan tes Ronde 1 kemarin sampai ditemukan+diperbaiki pagi ini) tidak diketahui pasti — TTL 6 jam berarti kalaupun tidak ditemukan user, akan otomatis expire dengan sendirinya. Tidak berdampak ke saga demote Nemotron 3 Super itu sendiri (keputusan demote tetap berlaku, ini murni bug caching yang independen dari kualitas model).

---

## Changelog Session 146 lanjutan 2 (2026-07-07) — ⚠️ Temuan Belum Tuntas: Akun SambaNova Produksi Kemungkinan Bukan Free Tier

**Konteks:** user tanya balik kenapa SambaNova dikategorikan "truly free" (Tier 1) sementara Fireworks AI "tidak free" (Tier 3) — pertanyaan valid karena klaim SambaNova itu berasal dari riset lama (Session sebelum ini, 2026-05-28) yang belum diverifikasi ulang di sesi ini, sementara klaim Fireworks baru saja di-riset fresh. Verifikasi ulang dokumentasi resmi SambaNova (`docs.sambanova.ai/docs/en/models/rate-limits`) menemukan struktur tier yang jauh lebih ketat dari catatan lama: **Free Tier resmi cuma 20 RPM / 20 RPD / 200K TPD** (bukan "10 RPM" tanpa batas harian seperti tercatat sebelumnya) — dan ada thread komunitas resmi SambaNova di mana staf sempat bilang "tidak ada rencana pertahankan free tier".

**User share screenshot Billing dashboard SambaNova produksi (`cloud.sambanova.ai/plans/billing`):**
- 3 invoice historis (Mei, Jun, Jul-Agu 2026) semuanya **Total due: $0.00** — tapi bukan karena tidak ada charge, melainkan charge riil (`Signup` line item, unit price $3.00 dan $4.50 per unit — pola harga per-juta-token khas tier berbayar) yang **di-offset oleh kredit signup** ("Signup consumed").
- Ini pola berbeda dari "Free Tier" resmi di dokumentasi (yang seharusnya cuma dibatasi rate limit, tanpa mekanisme invoice/charge/kredit sama sekali) — indikasi kuat akun ini jalan di **Developer Tier (berbayar)** dengan kartu pembayaran kemungkinan sudah terpasang, cuma belum kena tagihan nyata karena kredit signup awal belum habis.
- **Belum dikonfirmasi 100%** — perlu cek halaman "Commits and Credits" (sisa saldo kredit) dan "Manage Billing" (ada/tidaknya kartu terpasang) untuk memastikan.

**Keputusan user:** "biarin saja dulu" / "nanti ku pikirkan caranya" — **investigasi & keputusan ditunda**, tidak ada perubahan kode maupun konfirmasi lebih lanjut di sesi ini.

**Risiko kalau tidak ditindaklanjuti:** kalau akun ini benar Developer Tier berbayar, begitu kredit signup habis, `market-digest` (yang pakai SambaNova/DeepSeek-V3.2 sebagai primary, akun2 juga dipakai sebagai fallback fitur lain) akan **mulai kena biaya nyata otomatis** tanpa peringatan eksplisit selain invoice bulanan — bukan gagal/fallback ke provider lain, karena secara teknis request tetap berhasil (cuma jadi berbayar). Perlu dicek ulang di sesi mendatang kalau user sudah siap.

**How to apply next session:** jangan asumsikan lagi provider manapun "truly free" hanya dari dokumentasi/riset lama tanpa re-verifikasi — pola sesi ini (Together AI berubah kebijakan sejak Juli 2025, SambaNova ternyata ambigu) menunjukkan status free-tier provider AI berubah-ubah dan gampang stale. Kalau user tanya soal biaya AI atau minta cek billing lagi, mulai dari sini: cek "Commits and Credits" + "Manage Billing" SambaNova dulu sebelum bahas provider lain.

---

## Changelog Session 146 (2026-07-07) — Riset: Qwen 3.7 Max + Together AI / Fireworks AI / DeepInfra

**Konteks:** user minta riset 3 halaman model marketplace (`api.together.ai/models`, `app.fireworks.ai/models`, `deepinfra.com/dash/models`) plus model baru "Qwen 3.7 Max" — lanjutan eksplorasi provider AI setelah saga Nemotron (Session 145) demote DeepSeek-V3.2/SambaNova tetap primary. Ketiga URL dashboard yang di-share ternyata React app client-side-rendered, WebFetch cuma dapat shell/loading state (bukan bug — memang butuh JS eksekusi penuh), jadi info diambil via WebSearch + halaman model publik (non-dashboard) masing-masing provider.

**Qwen 3.7 Max — spesifikasi:**
- Rilis 19 Mei 2026 oleh Alibaba, flagship proprietary (BUKAN open-weight — beda dari Qwen3.5/3.6 series yang Apache 2.0, weights-nya tidak ada di Hugging Face).
- Context 1M token, max output 65,536 token.
- Harga: $1.25/1M token input, $3.75/1M token output, cached input $0.13/1M. **Tidak ada free tier di mana pun** (Alibaba Cloud Model Studio, Together AI, OpenRouter — semua berbayar).
- Benchmark kuat: GPQA Diamond 92.4 (unggul Claude Opus 4.6 Max 91.3), SWE-Bench Verified 80.4%, Apex 44.5 (vs DeepSeek V4 Pro 38.3). Fokus agentic/coding/office automation, bukan dirancang untuk task briefing teks sederhana.

**Ketersediaan di 3 provider yang diminta:**
| Provider | Qwen 3.7 Max? | Catatan |
|----------|--------------|---------|
| **Together AI** | Ya | Model ID `Qwen/Qwen3.7-Max`, sama persis $1.25/$3.75 per 1M, tidak ada free credit disebutkan untuk model ini. |
| **Fireworks AI** | Belum — cuma Qwen 3.7 **Plus** (varian lebih kecil) yang sudah live serverless; Max masih "coming soon", early-access by request. |
| **DeepInfra** | Tidak ada | DeepInfra konsisten hanya serve model open-weight (Qwen3.5-397B-A17B, Qwen3.6-35B-A3B/27B, dll, Apache 2.0) — cocok karena Qwen3.7-Max memang bukan open-weight sehingga tidak bisa mereka host. |

**Kesimpulan — tidak relevan untuk Daun Merah:** kebutuhan project untuk `market-digest` adalah model **truly-free** (persistent, bukan credit trial) dengan output berkualitas Bahasa Indonesia — lihat kriteria di riset [Session sebelumnya, "Research: Free AI Inference API Providers"](#research-free-ai-inference-api-providers-2026-05-28) di bawah. Qwen 3.7 Max berbayar penuh tanpa free tier di provider manapun, jadi tidak mengubah rekomendasi yang sudah ada: **DeepSeek-V3.2/SambaNova tetap primary**, tidak ada tindak lanjut kode. Kalau suatu saat mau eksplorasi Qwen generasi terbaru lagi, varian open-weight (`Qwen3.6-35B-A3B`/`Qwen3.6-27B`, Apache 2.0) di DeepInfra pay-per-use murah adalah kandidat yang lebih masuk akal dibanding Max — tapi tetap bukan truly-free, jadi bukan prioritas dibanding provider free-tier yang sudah didokumentasikan (Cerebras, OpenRouter, SambaNova).

---

## Changelog Session 145 lanjutan 7 (2026-07-07) — Fix: CRON_SECRET Production Dirotasi & Diverifikasi

**Konteks:** temuan sampingan dari sesi tes Nemotron 3 Super (lanjutan 6, di bawah) — `vercel env pull` menunjukkan `CRON_SECRET` production sebagai string kosong (`""`). Klarifikasi user: variabel ini di-set **Sensitive** di Vercel — begitu nilai Sensitive disimpan, Vercel tidak pernah menampilkannya lagi ke dashboard/API/CLI manapun (write-only by design), jadi tampilan kosong via `env pull` **bukan bukti nilainya benar-benar kosong**. Kesimpulan awal saya salah — butuh verifikasi fungsional, bukan baca-nilai.

**Karena user sendiri juga lupa nilai aslinya** (dan GitHub Actions secret juga write-only, tidak bisa dibaca ulang dari sisi manapun), opsi yang realistis adalah **rotasi**: generate token baru, pasang nilai yang identik di kedua tempat (Vercel env `CRON_SECRET` + GitHub Actions repo secret `CRON_SECRET`) supaya sinkron kembali — bukan usaha memulihkan nilai lama.

**Verifikasi (bukan asumsi):** `ohlcv-sync.yml` workflownya sendiri strict (`curl -w "%{http_code}"` lalu `exit 1` kalau bukan 200 — dicek dulu isi workflow-nya untuk mastiin centang hijau GitHub Actions memang representasi HTTP 200 asli, bukan false-positive dari exit code shell yang tidak mengecek response). Run hijau di 7:03 pagi ternyata terjadi **sebelum** rotasi sesi ini (tidak valid sebagai bukti pasangan baru) — user diminta trigger manual via tombol **"Run workflow"** (`workflow_dispatch`) setelah rotasi selesai dipasang di kedua sisi. Hasil manual run: **hijau (HTTP 200)** — pasangan `CRON_SECRET` baru dikonfirmasi cocok Vercel↔GitHub.

**Dampak fix:** karena semua konsumer memakai `process.env.CRON_SECRET` yang sama persis (bukan variabel terpisah per fitur), satu verifikasi ini otomatis mengonfirmasi semuanya kembali normal: `ohlcvSyncHandler` (sync OHLCV/TA per jam), `runCronThesisSweep` (alert invalidasi thesis otomatis di tiap siklus digest terjadwal), serta endpoint admin yang sebelumnya diduga terkunci (`health`, `redis-keys`, `admin-prompts`, `push`, `fundamental_seed`, `journal_import`, `circuit-status`). Tidak ada perubahan kode di sesi ini — murni rotasi credential + verifikasi.

**Catatan:** durasi sebenarnya masalah ini aktif (kalau memang genuinely rusak, bukan cuma Sensitive-mask) tidak diketahui pasti — tidak ada cara menelusuri riwayat nilai `CRON_SECRET` dari log manapun. Tidak berdampak ke pengujian Nemotron 3 Super (lanjutan 6) karena gate `_app_key.js` fail-open (APP_KEY belum diset), jadi endpoint `market-digest` generate tetap 200 sepanjang sesi itu.

---

## Changelog Session 145 lanjutan 6 (2026-07-07) — Nemotron 3 Super: Tes Live, 0/6 Gagal di 2 Konfigurasi, Didemote

**Konteks:** lanjutan langsung dari lanjutan 5 (di bawah) — kode diagnostik `?test_nemotron_super=1` sudah siap tapi belum pernah dites live. User minta dites sekarang.

**Metode:** `vercel env pull` (izin eksplisit user, untuk ambil `CRON_SECRET` — dipakai bypass gate `x-cron-secret`) lalu `curl` langsung ke production (`https://financial-feed-app.vercel.app/api/market-digest?test_nemotron_super=1`). File `.env.production.local` dihapus lagi setelah tiap sesi tarik, tidak pernah masuk git (sudah di `.gitignore` via `.env*`).

**Ronde 1 — konfigurasi asli (`/no_think` di system prompt, 3x percobaan):**
1. Timeout penuh di batas 20 detik.
2. HTTP 200 / `method:"nemotron-3-super"` (dianggap sukses oleh kode), tapi **isi `article` adalah chain-of-thought mentah berbahasa Inggris** ("We need to produce a briefing in Indonesian...") — model sama sekali tidak comply `/no_think`, malah menulis proses berpikirnya secara verbatim sebagai output, lalu terpotong di tengah kalimat karena kehabisan `max_tokens` (1300). `quality_flags.forbidden_phrases` sempat mendeteksi 22 frasa terlarang — tapi ini artefak (reasoning trace-nya mengutip ulang daftar frasa terlarang dari prompt, bukan pelanggaran nyata di artikel).
3. Pola identik dengan #2 — reasoning trace bahasa Inggris lagi, terpotong lagi.

**Ronde 2 — ganti mekanisme ke `reasoning:{effort:'none'}` (parameter API resmi OpenRouter untuk reasoning models, lebih terstruktur dari directive teks manual):**
- `api/market-digest.js` baris ~1420: `aiCall(...)` sekarang kirim `extraBody: { reasoning: { effort: 'none' } }` di tier diagnostik Nemotron Super (`/no_think` di system prompt tetap dipertahankan juga, tidak saling mengganggu). Deploy via commit `559cc0e`.
4. Timeout penuh 20 detik lagi.
5. Timeout penuh 20 detik lagi → circuit breaker `ai:openrouter:nemotron-super` OPEN (ambang `AI_CB_THRESHOLD=2` tercapai).

**Kesimpulan: 0/6 percobaan live menghasilkan artikel yang bisa dipakai**, dengan 2 mekanisme disable-reasoning yang sama sekali berbeda (directive teks vs parameter API terstruktur) sama-sama gagal — cuma beda gejala kegagalan (content leak vs timeout murni). Pola timeout persis di batas 20 detik pada Ronde 2 mengindikasikan ini kemungkinan besar **resource contention di sisi OpenRouter untuk model yang masih baru/besar**, pola yang sama persis dengan Nemotron 3 Ultra — bukan sesuatu yang bisa diperbaiki lewat prompt engineering atau parameter reasoning. Pertanyaan awal soal dukungan Bahasa Indonesia (Nemotron 3 Super resminya tidak listed support ID) **masih belum terjawab** — tidak ada satu pun percobaan yang sampai ke tahap menghasilkan jawaban final untuk dinilai.

**Keputusan (dikonfirmasi user, 2 opsi ditawarkan: demote sekarang / tunggu circuit reset lalu coba 1-2x lagi):** **Demote — stop eksperimen ini.** Kode diagnostik dibiarkan seperti sebelumnya (sudah inert by design sejak awal — cuma aktif via `?test_nemotron_super=1`, tidak pernah masuk jalur produksi Call1 normal, jadi tidak perlu perubahan kode lebih lanjut). `NEMOTRON_SUPER_MODEL` const, circuit `ai:openrouter:nemotron-super`, dan diagnostik tetap ada kalau suatu saat mau dites ulang (mis. kapasitas free-tier OpenRouter membaik), tapi tidak dikejar lagi sekarang.

**Temuan sampingan (di luar scope, ditandai belum diinvestigasi/diperbaiki):** saat `vercel env pull`, env `CRON_SECRET` di production **kosong** (`""`). Berpotensi bikin auth cron GitHub Actions (`market-digest.yml` dan workflow lain yang pakai secret sama) gagal 401 secara diam-diam — gate `_app_key.js` sendiri masih fail-open (karena `APP_KEY` juga belum diset) jadi request market-digest tetap lolos meski cron-secret kosong, tapi endpoint yang mewajibkan match eksplisit (`circuit-status`, dll) langsung 401 walau dengan secret yang "benar". Belum dikonfirmasi apakah ini regresi baru atau CRON_SECRET memang sengaja dikosongkan; belum disentuh sama sekali sesi ini — perlu keputusan/verifikasi user sebelum ada perubahan.

---

## Changelog Session 145 lanjutan 5 (2026-07-07) — Persiapan Diagnostik Nemotron 3 Super (Belum Dites Live)

**Konteks:** setelah Nemotron 3 Ultra didemote (lanjutan 4, di bawah), user share halaman OpenRouter untuk `nvidia/nemotron-3-super-120b-a12b:free` — model NVIDIA lain, jauh lebih ringan (120B total/12B active vs Ultra 550B/55B) — dan minta perbandingan dengan DeepSeek-V3.2 (primary sekarang).

**Perbandingan (analisis, belum ada data live kita sendiri):**
- Nemotron 3 Super py **statistik produksi nyata** dari OpenRouter (beda dari Ultra yang datanya nol berhasil): p50 latency 1.82s, E2E rata-rata 11.2s, uptime 97.85% (rolling 3 hari) — terlihat genuinely berfungsi.
- GPQA Diamond 80.0%, Intelligence Index 25.4 (cuma lebih baik dari 46% model pembanding) — biasa saja, bukan model unggulan.
- ⚠️ **Structured Output Error Rate 17.76%** — ~1 dari 6 request JSON gagal ter-parse. Red flag besar untuk Call2/Call3 (butuh JSON ketat) — DeepSeek-V3.2 sudah proven kuat justru di titik ini.
- ⚠️ **Riset tambahan (bahasa):** daftar bahasa yang secara resmi didukung model ini (varian utama): English, French, German, Italian, Japanese, Spanish, Chinese. Varian Base menambah beberapa bahasa lagi (Arab, Ibrani, Hindi, Korea, dll) — **Bahasa Indonesia TIDAK ada di daftar manapun**. Ini belum tentu berarti outputnya buruk (banyak model tetap bisa berbahasa Indonesia meski tidak "resmi" didukung), tapi ini sinyal risiko tambahan yang perlu dipertimbangkan mengingat use case app ini 100% Bahasa Indonesia — DeepSeek-V3.2 & gpt-oss-120b sudah proven fasih Bahasa Indonesia di app ini, Nemotron 3 Super belum ada bukti sama sekali untuk ini.
- Kesimpulan sementara: JANGAN ganti DeepSeek-V3.2 untuk Call2/Call3. Untuk Call1 (prosa), model ini MUNGKIN punya niche (uptime/latency real bagus), tapi 2 concern (JSON error rate — tidak relevan utk Call1 sih — dan dukungan Bahasa Indonesia yang tidak resmi) perlu dicek live dulu, bukan diasumsikan dari benchmark/dokumentasi (pelajaran dari saga Nemotron Ultra di atas).

**Persiapan kode (BELUM dijalankan live, user minta ditunda ke sesi berikutnya):**
- `market-digest.js`: tier baru Nemotron 3 Super, **Call 1 SAJA** (sengaja dibatasi dari Call2/3 karena Structured Output Error Rate). Const `NEMOTRON_SUPER_MODEL`, circuit `ai:openrouter:nemotron-super` (terpisah dari Ultra), reuse counter `openrouter` + `withNoThink()`.
- Diagnostik terisolasi `?test_nemotron_super=1` (pola sama seperti `?test_nemotron=1`) — skip semua tier lain di Call1 (termasuk Nemotron Ultra). Call2/Call3 **tidak terpengaruh** flag ini, tetap jalan normal (SambaNova primary) karena Nemotron Super memang tidak diuji di sana.
- `KNOWN_CIRCUITS` (admin.js): tambah `ai:openrouter:nemotron-super`.
- Test baru untuk konstanta + request body. Full suite 109/109 lulus, `node --check` bersih.

**Status:** Deployed ke production (commit `cf3c23e`) tapi **inert** — kode ini cuma aktif kalau dipanggil eksplisit via `?test_nemotron_super=1`, tidak mempengaruhi jalur produksi normal sama sekali. **Untuk sesi berikutnya:** jalankan `?test_nemotron_super=1` beberapa kali, perhatikan khususnya (a) apakah benar-benar bebas 403/empty/timeout seperti Ultra, (b) kualitas Bahasa Indonesia-nya (concern baru yang belum pernah relevan untuk model lain di app ini), baru putuskan apakah layak jadi tambahan/pengganti tier di Call1.

---

## Changelog Session 145 lanjutan 2-4 (2026-07-07) — Nemotron 3 Ultra: Coba Ollama Cloud, Coba Matikan Reasoning, Akhirnya Didemote

**Konteks:** lanjutan langsung dari Session 145 (di bawah) — setelah 2 ronde tes live via OpenRouter menunjukkan 0/3 bersih (respons kosong + timeout, tapi TIDAK 403), user minta dicoba beberapa pendekatan lagi sebelum menyerah.

**Lanjutan 2 — coba sumber Ollama Cloud:** User share `ollama.com/library/nemotron-3-ultra` — dicek, model tersedia di tag `nemotron-3-ultra:cloud`. Diimplementasikan sebagai sumber Nemotron BARU (bukan ganti OpenRouter, ditaruh di depannya) di `market-digest.js`: `callOllama()` baru (pola sama seperti `_callOllama()` di admin.js, API native `/api/chat` bukan OpenAI-compatible), model id **TANPA suffix `:cloud`** (pelajaran langsung dari bug GLM-5.2 session 144 lanjutan 5 — suffix itu konvensi lokal, bukan nama API cloud). Reuse `OLLAMA_API_KEY` yang sudah ada (akun sama dipakai `ohlcv_analyze`), circuit breaker baru `ai:ollama:nemotron`. Timeout tier lain di Call 1 dipangkas across-the-board (SambaNova 22s→15s, gpt-oss 15s→10s, Groq 15s→8s) supaya total worst-case tetap wajar walau nambah tier. **Sempat dicek juga: apakah model ini genuinely gratis di Ollama Cloud (bukan cuma "teknisnya bisa diakses tapi sebenarnya perlu subscription" seperti GLM-5.2/Kimi K2.6)?** Dikonfirmasi via web search: YA, ada di Free tier (bukan Pro $20/bulan atau Max $100/bulan), meski ditandai "High Usage" (makan kuota mingguan ~5 juta token lebih cepat dari model kecil) — beda struktural dari GLM-5.2/Kimi K2.6 yang memang butuh Pro/Max.

**Hasil tes live Ollama Cloud:** timeout di batas 18 detik — beda gejala dari OpenRouter (yang tadinya kosong/timeout 25 detik), tapi tetap gagal.

**Lanjutan 3 — hipotesis user: reasoning trace bikin lambat, coba matikan:** User curiga model mungkin punya "thinking mode"/"effort high" (seperti kasus GLM-5.2 dengan `think:'high'` session 144) yang bikin lambat. Riset konfirmasi: Nemotron 3 pakai directive **`/think` dan `/no_think`** di system prompt (konvensi NVIDIA, mirip steering token Qwen3) untuk kontrol reasoning — BUKAN parameter API terpisah. Diimplementasikan `withNoThink(messages)` — tambah `/no_think` ke system message (bikin baru kalau belum ada), diterapkan ke SEMUA call site Nemotron (Ollama + OpenRouter, Call1/2/3), TIDAK ke provider lain (SambaNova/Groq/gpt-oss tidak paham konvensi ini). Timeout diagnostik `?test_nemotron=1` juga diperpanjang jauh (Ollama 45s, OpenRouter fallback 12s — aman karena tier lain sudah di-skip semua di mode test, total 57s masih di bawah limit 60s Vercel) untuk memastikan apakah model "butuh waktu lebih" atau "tidak akan pernah selesai".

**Hasil tes live dengan `/no_think`:** masih gagal — kali ini **respons kosong setelah 27.1 detik** (bukan timeout, request beneran selesai duluan sebelum batas 45s, tapi `message.content` kosong). Gejala ketiga yang berbeda lagi.

**Kesimpulan setelah 4 percobaan live nyata (2 sumber × berbagai config, semua 0% sukses):**

| # | Sumber | Config | Hasil |
|---|---|---|---|
| 1 | OpenRouter | timeout 25s | kosong (912ms) |
| 2 | OpenRouter | timeout 25s | timeout (25007ms) |
| 3 | Ollama Cloud | timeout 18s | timeout (18006ms) |
| 4 | Ollama Cloud | timeout 45s, `/no_think` | kosong (27137ms) |

Tiga gejala kegagalan berbeda (kosong-cepat, timeout, kosong-lambat) di 2 provider berbeda dengan config berbeda-beda — pola ini konsisten dengan **resource contention di sisi provider** (model 550B baru rilis ~sebulan, kemungkinan besar traffic gratis diprioritaskan paling rendah di kedua host), bukan bug di kode kita, dan bukan juga soal reasoning-mode. User setuju untuk stop iterasi dan demote.

**Lanjutan 4 — demote Nemotron dari primary:** `market-digest.js` Call1/2/3 — Nemotron (Ollama Cloud + OpenRouter) sekarang **hanya dipanggil saat `?test_nemotron=1`**, tidak lagi di jalur produksi normal. **SambaNova/DeepSeek-V3.2 kembali jadi primary asli** (proven, reliable berbulan-bulan sebelum session 145). Timeout SambaNova/gpt-oss/Groq di Call 1 dikembalikan ke nilai asli (22s/15s/15s) karena trimming sebelumnya cuma perlu selama Nemotron ada di jalur produksi. **Kode Nemotron TIDAK dihapus** (consts, `callOllama`, `withNoThink`, circuit breaker tetap ada) — bisa dites ulang kapan pun via `?test_nemotron=1` kalau serving membaik di masa depan, tanpa perlu ditulis ulang dari nol.

**Follow-up (belum dieksekusi, masih diskusi):** User tanya perbandingan `nvidia/nemotron-3-super-120b-a12b:free` (OpenRouter, 120B/12B active, model NVIDIA lain yang lebih kecil) vs DeepSeek-V3.2. Beda dari Nemotron 3 Ultra, Nemotron 3 Super punya **statistik produksi nyata** dari OpenRouter (bukan cuma spec kertas): p50 latency 1.82s, E2E latency rata-rata 11.2s, uptime 97.85% (rolling 3 hari) — terlihat genuinely berfungsi. Tapi **Structured Output Error Rate 17.76%** (~1 dari 6 request JSON gagal ter-parse) jadi red flag besar untuk Call2/Call3 yang butuh JSON ketat — dan DeepSeek-V3.2 sudah proven kuat justru di titik itu. Rekomendasi: JANGAN ganti DeepSeek-V3.2, tapi Nemotron 3 Super bisa jadi kandidat untuk dites live khusus Call 1 (prosa, tidak butuh JSON) kalau user mau — belum dieksekusi, menunggu keputusan user.

**Pelajaran untuk sesi berikutnya:** "Katanya gratis" + benchmark bagus di kertas ≠ benar-benar bisa diandalkan di production — ini precedent KEDUA di project ini (setelah GLM-5.2/Kimi K2.6 session 144) di mana model besar yang baru rilis gagal saat dites live, meski kali ini bukan soal subscription-gate (403) tapi soal reliability/capacity. Pola yang mulai terlihat: model FLAGSHIP BESAR yang BARU RILIS di free tier manapun (OpenRouter, Ollama Cloud) berisiko tinggi tidak stabil untuk beberapa waktu setelah rilis — pertimbangkan model yang sudah "battle-tested" beberapa bulan, atau uji live secara eksplisit dulu (pola `?test_X=1`) sebelum jadi primary, jangan pernah anggap otomatis siap produksi hanya dari dokumentasi/marketing.

**Status:** Deployed ke production (commit `0a6eeed`). Full test suite 106/106 lulus, `node --check` bersih. Smoke test manual pasca-demote: `method:"deepseek-v3.2"` dengan artikel nyata — jalur produksi kembali normal.

---

## Changelog Session 145 (2026-07-06) — Re-arsitektur Distribusi Model AI: Nemotron 3 Ultra (Ringkasan) + Cerebras gpt-oss-120b (Jurnal/Fundamental)

**Request user:** eksekusi plan re-distribusi 4 fitur AI yang sudah ditulis di `daun_merah_plan.md` (ide asli: Nemotron 3 Ultra untuk `market-digest`, DeepSeek-V3.2 akun 1 untuk `ohlcv_analyze` — tidak berubah, gpt-oss:120b untuk journal/fundamental, DeepSeek-V3.2 akun 2 sebagai fallback bersama).

**Verifikasi ulang sebelum eksekusi (user minta "AKU BUTUH VERIFIKASI DARI IDE YANG KUBUAT"):**
- Dikonfirmasi via web search (openrouter.ai/docs + artikel pihak ketiga): limit gratis OpenRouter itu **account-wide, bukan per-model** — 50 request/hari kalau akun belum pernah top-up kredit $10+ seumur hidup, 1000/hari kalau sudah (persisten walau saldo habis lagi).
- Temuan baru yang mengubah rencana awal: gpt-oss-120b ternyata JUGA di-host asli oleh **Cerebras Cloud** (`api.cerebras.ai/v1/chat/completions`, model id `gpt-oss-120b`, OpenAI-compatible, free tier genuinely persistent — 1 juta token/hari + 5 RPM/30K TPM, bukan trial sekali pakai) — pool **terpisah total** dari OpenRouter. User mengonfirmasi ini memang niat awal ("kan memang itu niatnya") — jadi gpt-oss:120b untuk `journal_analysis` + `fundamental_analysis` dipindah ke Cerebras (bukan OpenRouter seperti draft plan sebelumnya), supaya tidak berebut kuota harian dengan Nemotron 3 Ultra yang wajib lewat OpenRouter (satu-satunya provider yang punya model ini — NVIDIA NIM langsung juga tersedia tapi ditolak sebagai alternatif karena riset project ini sebelumnya mencatat kuota gratis NIM berbasis kredit sekali pakai non-renewing, bukan reset harian seperti OpenRouter/Cerebras).

**Implementasi:**
- `api/market-digest.js` Call1/Call2/Call3: tambah Nemotron 3 Ultra (`nvidia/nemotron-3-ultra-550b-a55b:free` via OpenRouter) sebagai tier **primary baru**, di depan SambaNova/OpenRouter-gpt-oss/Groq yang sudah ada (semua dipertahankan sebagai fallback berurutan, tidak ada yang dihapus). Circuit breaker baru `ai:openrouter:nemotron` (terpisah dari circuit generic `ai:openrouter` yang sudah ada di `KNOWN_CIRCUITS` tapi tak pernah benar-benar dipakai) karena sekarang dipanggil di setiap request sebagai primary, bukan fallback jarang. `providerOverride:'openrouter'` tetap reuse counter kuota yang sudah ada (bukan bikin counter baru per-model).
- Diagnostik `?test_nemotron=1` (pola sama seperti `?test_ollama=1` session 144): skip SEMUA tier lain sama sekali (bukan cuma dicoba kalau Nemotron gagal) supaya hasil tes murni mencerminkan Nemotron sendiri.
- `api/journal.js` (`aiCall()`, AI Coach) & `api/admin.js` (`fundamentalAnalysisHandler`): dulu masing-masing single-provider rapuh (journal.js: Groq-only, tanpa fallback/circuit breaker sama sekali; admin.js: Groq → SambaNova akun 1, tanpa circuit breaker) — sekarang sama-sama 3-tier: **Cerebras gpt-oss-120b (primary, baru) → SambaNova akun 2/`sambanova_c1` (fallback1, baru untuk journal.js / geser dari akun 1 di admin.js) → Groq (fallback2, tetap ada sebagai jaring pengaman terakhir)**. Circuit breaker baru `ai:cerebras:gptoss` ditambahkan ke keduanya.
- `ohlcv_analyze` (Analisa Teknikal) **tidak disentuh** — sudah cocok dengan ide user sejak awal.
- `api/_ai_guard.js`: `DEFAULT_LIMITS.openrouter` diturunkan 150→45 (buffer aman di bawah cap gratis asli 50/hari — status top-up akun OpenRouter belum dikonfirmasi user, jadi diasumsikan konservatif belum top-up; sekarang Nemotron satu-satunya fitur yang pakai pool ini). Counter `cerebras` (scaffolding lama yang tidak pernah benar-benar dipakai) diaktifkan.
- `KNOWN_CIRCUITS` (admin.js) + `healthHandler` `getUsage` list: tambah circuit/counter baru supaya termonitor di `?action=circuit-status`/`?action=health` dan bisa direset via `?action=circuit-reset`.
- `index.html`: badge method baru untuk `nemotron-3-ultra` (hijau NVIDIA, `#76b900`).

**Test baru:** `test/journal_ai.test.js`, `test/admin_fundamental.test.js`, `test/market_digest_nemotron.test.js` (fallback chain tiap fitur, HTTP-level via fetch stub) + tambahan regression di `test/guards.test.js` (limit `openrouter` ≤45, counter `cerebras` aktif). Full suite **97/97 lulus**, `node --check` bersih untuk keempat file yang diubah.

**Hasil tes live `?test_nemotron=1` di production (2 ronde, total 7 request, 3 di antaranya "fresh circuit"):**
- **Tidak ada HTTP 403 subscription-required** — beda dari precedent GLM-5.2/Kimi K2.6 (Session 144 lanjutan 5) — Nemotron 3 Ultra via OpenRouter memang genuinely accessible di free tier, bukan model berbayar yang disamarkan gratis.
- Tapi reliability lemah: 2× respons **kosong** dalam ~1 detik (HTTP 200 tapi content kosong — kemungkinan besar OpenRouter tidak ada replica gratis yang available saat itu, bukan bug kode), 1× **timeout penuh** di batas 25 detik. 0 dari 3 percobaan fresh berhasil dapat konten nyata dari Nemotron di Call 1.
- Circuit breaker `ai:openrouter:nemotron` konsisten kembali OPEN tak lama setelah reset (5 menit) — mengindikasikan Call 2/Call 3 (berbagi circuit yang sama, tidak kelihatan langsung di `provider_log` yang hanya mencakup Call 1) kemungkinan juga gagal di window yang sama.
- **Kriteria selesai plan ("3x sukses berturut-turut tanpa error") belum terpenuhi.** Dikonfirmasi ke user dengan data lengkap + 3 opsi (demote jadi fallback / tetap primary & terus pantau / naikkan timeout dulu sebelum putuskan). **User memilih: tetap primary, terus dipantau** — sadar menerima risiko bahwa circuit breaker akan sering OPEN (membatasi kerusakan ke jendela 5 menit tiap kali, bukan tak terbatas) dan Nemotron kemungkinan besar belum benar-benar melayani konten nyata sampai kapasitas free-tier OpenRouter untuk model ini membaik.

**Status:** Deployed ke production (`main`, commit `0df43db`). Semua kriteria selesai LAINNYA di plan sudah terpenuhi (test, `node --check`, dokumentasi) — kecuali kriteria live-test Nemotron yang secara sadar diterima user sebagai risiko yang terus dipantau, bukan gate blocking. **Untuk sesi berikutnya:** pantau `?action=health` (`aiBudget`, field `openrouter`) dan `?action=circuit-status` (`ai:openrouter:nemotron`) dari waktu ke waktu — kalau makin sering CLOSED+sukses (bukan cuma `nemotron:empty`/timeout di `provider_log`), tandanya kapasitas OpenRouter untuk model ini sudah membaik dan Nemotron mulai benar-benar melayani konten. Kalau setelah beberapa hari masih 0% sukses, pertimbangkan opsi "demote ke fallback" yang sempat ditawarkan tapi ditolak user di sesi ini.

---

## Changelog Session 144 lanjutan 5 (2026-07-06) — Ollama Cloud (GLM-5.2) sebagai Fallback Tambahan `ohlcv_analyze`

**Request user:** riset apakah GLM-5.2 (`ollama.com/library/glm-5.2`) bisa dipakai di app. Sempat direkomendasikan tidak dipakai (lihat alasan di bawah) dan diarahkan ke DeepSeek-V3.2 versi Ollama Cloud sebagai alternatif, tapi user tetap mau coba GLM-5.2 duluan ("glm dulu dong" / "kita coba aja dulu") dengan syarat eksplisit: `reasoning_effort`/`think` di-set **"high"**, bukan **"max"** (default model, mode reasoning terdalam & paling lambat).

**Riset GLM-5.2 (Z.ai, 756B, 1M context, lisensi MIT):** benchmark yang dipamerkan semuanya coding (Terminal-Bench, SWE-bench), tidak ada sinyal kemampuan Bahasa Indonesia/penulisan finansial secara eksplisit; dan modelnya reasoning-capable ("effort levels" High/Max) — riset lanjutan (web search) mengkonfirmasi ini parameter `reasoning_effort`/`think`, default **max** (reasoning terdalam, paling lambat) kalau thinking dinyalakan, `high` adalah opsi lebih cepat. User memilih tetap eksperimen dengan `think:'high'` meski ada risiko latency untuk kebutuhan Bahasa Indonesia/finansial yang belum terbukti — keputusan sadar user, bukan rekomendasi saya.

**Kendala teknis:** API Ollama Cloud pakai format native (`POST https://ollama.com/api/chat`, body `{model,messages,stream:false,think,options:{temperature,num_predict}}`, response `message.content`) — **bukan** format OpenAI (`/v1/chat/completions`) yang dipakai semua provider lain, jadi tidak bisa reuse helper fetch yang ada. `think` di top-level body (bukan di dalam `options`).

**Implementasi (`api/admin.js`, `ohlcvAnalyzeHandler` saja — scope sengaja dibatasi ke fitur Analisa, bukan Ringkasan/`market-digest.js`):**
- `_callOllama(apiKey, model, messages, maxTokens, temperature, timeoutMs, think=null)` baru: request/response native Ollama, `think` opsional (dikirim di top-level body kalau diisi). Throw `HTTP {status}` atau `Empty response` konsisten dengan pola provider lain (caller yang tangkap & lanjut ke fallback berikutnya). Diekspor untuk unit test.
- Chain fallback jadi 3 tingkat, urutan diubah lagi atas permintaan user ("coba glm dulu yang primary") supaya GLM-5.2 benar-benar kepakai di tiap request (bukan cuma tereksekusi kalau SambaNova kebetulan gagal — sulit dievaluasi kalau posisinya cuma fallback jarang ke-trigger): **Ollama Cloud GLM-5.2 (`think:'high'`, 30s, PRIMARY sementara) → SambaNova DeepSeek-V3.2 (15s, fallback, dipangkas dari 30s) → Groq llama-3.3 (10s, last resort, dipangkas dari 25s)**. Circuit breaker baru `ai:ollama` (masuk `KNOWN_CIRCUITS`) + budget guard `allowAiCall('ollama')` (`DEFAULT_LIMITS.ollama = 150`, konservatif karena free tier Ollama Cloud berbasis GPU-time bukan RPM/token, belum ada data pasti).
- **Trade-off timeout disadari & didokumentasikan di kode:** total GLM-5.2+SambaNova+Groq = 55s, masih di bawah hard limit 60s Vercel (GLM-5.2 dapat porsi terbesar/30s karena posisinya sekarang primary dan belum ada data latency real untuk model reasoning ini — SambaNova yang historisnya terbukti cepat/~13-20s dipangkas ke 15s untuk kasih ruang).
- **Fail-safe sampai `OLLAMA_API_KEY` diisi:** tanpa env var itu, `OLLAMA_KEY` falsy → seluruh blok Ollama di-skip, perilaku identik dengan sebelum perubahan ini (SambaNova → Groq langsung). Nol risiko sampai user isi env var + redeploy.
- `model` yang dikembalikan ke frontend: `'glm-5.2'` kalau lewat Ollama (beda dari SambaNova yang `'deepseek-v3.2'` — modelnya memang beda, badge UI harus mencerminkan sumber sebenarnya).

**Update (masih sesi yang sama):** dua perubahan lagi sebelum sempat dites live —
1. **Urutan dibalik jadi GLM-5.2 primary**, bukan fallback ("coba glm dulu yang primary") — supaya benar-benar kepakai tiap request dan bisa dievaluasi, bukan cuma jalan kalau SambaNova kebetulan gagal. Urutan akhir: **GLM-5.2 (30s, primary) → SambaNova (15s, fallback, dipangkas dari 30s) → Groq (10s, last resort, dipangkas dari 25s)**, total tetap 55s.
2. **`think:'high'` → `think:false`** — user minta deepthink dimatikan total demi kecepatan, bukan cuma dikurangi ke "high" (sempat dikonfirmasi: `think:'high'` masih menyalakan reasoning, cuma lebih ringan dari default "max"; `reasoning_effort` otomatis tidak berlaku lagi begitu thinking di-disable, konsekuensi yang disadari).
3. **Logging usage** ditambah di `_callOllama`: `console.log` per call berisi `wall` (durasi diukur klien), `server` (dari `total_duration` response Ollama, nanodetik dikonversi ke ms), `eval_count`/`prompt_eval_count` (token output/input) — supaya ada data nyata buat kalibrasi timeout & memantau pemakaian kuota GPU-time Ollama Cloud, kelihatan di Vercel function logs.

**Verifikasi:** 6 test (`test/ollama.test.js`, fetch di-stub): body request native terkirim benar (model/messages/stream:false/options), `think` terkirim di top-level (bukan di `options`) kalau diisi, `think:false` eksplisit tetap terkirim (beda dari default `null` yang di-drop), HTTP non-OK → error berisi status, response kosong/tanpa field `message` → error `Empty response` tanpa throw TypeError. Full suite 78/78 lulus, `node --check` bersih.

**Bug ditemukan setelah `OLLAMA_API_KEY` aktif + redeploy:** trigger live tetap balik ke `deepseek-v3.2` (SambaNova) berkali-kali, bukan `glm-5.2`. Root cause: `OLLAMA_MODEL = 'glm-5.2:cloud'` — suffix `:cloud` itu **konvensi Ollama LOKAL** (kasih tahu daemon `ollama run` di mesin sendiri "jalankan di cloud, bukan lokal"), **bukan** nama model yang valid kalau manggil `https://ollama.com/api/chat` langsung dari server (tanpa Ollama lokal di antaranya) — riset ulang konfirmasi contoh resmi Ollama pakai model polos tanpa suffix (`gpt-oss:120b`) untuk direct cloud API, `-cloud`/`:cloud` cuma untuk local client. Salah tag ini bikin "model not found" di setiap request. **Fix:** `OLLAMA_MODEL` → `'glm-5.2'` (tanpa suffix).

**Efek samping bug ini:** 3+ percobaan live berturut-turut gagal → circuit breaker `ai:ollama` berulang kali OPEN (`FAILURE_THRESHOLD=3`, `_circuit_breaker.js`, 5 menit tiap kali), bikin verifikasi lambat karena tiap window OPEN baru butuh nunggu 5 menit lagi sebelum probe berikutnya.

**Root cause sebenarnya (setelah fix nama model tetap gagal):** dicek log Vercel langsung (user share screenshot Runtime Logs) — `ohlcv_analyze Ollama failed: HTTP 403`. Bukan salah nama model — riset lanjutan (GitHub issues `ollama/ollama` #15707/#15741/#16773) konfirmasi 403 ini artinya **"this model requires a subscription, upgrade for access"**: GLM-5.2 (756B, flagship) ternyata model **berbayar** (Pro $20/bln atau Max $100/bln), tidak termasuk Free tier Ollama Cloud sama sekali — bukan soal konfigurasi kode.

**Ganti model ke `gpt-oss:120b`** (bukan DeepSeek-V3.2 yang sempat jadi opsi cadangan — DeepSeek-V4 kemungkinan sama-sama berbayar per riset tier, dan `gpt-oss:120b` py alasan lebih kuat): model open-weight OpenAI ini **sudah terbukti stabil untuk output Bahasa Indonesia di app ini** — dipakai via OpenRouter sebagai fallback Ringkasan Call 1 sejak lama ("proven stabil, output Bahasa Indonesia" per catatan project). `gpt-oss:20b` dikonfirmasi gratis di riset publik; `120b` belum 100% pasti gratis — ini yang sedang diuji live.

**User tanya perbandingan kualitas gpt-oss:120b vs DeepSeek-V3.2:** DeepSeek-V3.2 (671B, arsitektur lebih baru/sparse attention) di kelas *frontier* lebih atas dari gpt-oss:120b (120B, didesain OpenAI untuk efisiensi bukan kekuatan mutlak) — dan DeepSeek-V3.2 sudah proven langsung di app ini (primary Analisa berbulan-bulan), sedangkan gpt-oss:120b baru proven untuk prosa Ringkasan, belum untuk output JSON terstruktur Analisa. **Kesimpulan: gpt-oss:120b BUKAN upgrade dari DeepSeek-V3.2** — jadi tidak masuk akal jadi primary yang mengalahkan model yang sudah terbukti lebih kuat.

**Revert urutan:** SambaNova DeepSeek-V3.2 dikembalikan jadi **primary** (timeout kembali 30s), Ollama Cloud jadi **fallback 1** (15s, sebelum Groq llama-3.3 last-resort 10s) — total tetap 55s. `model` badge yang dikembalikan ke frontend sekarang dinamis (`OLLAMA_MODEL.replace(':', '-')`) bukan string hardcoded, supaya tidak perlu diubah manual tiap kali ganti kandidat model Ollama.

**Riset lanjutan (permintaan opsional user): cari model Ollama Cloud lebih besar dari DeepSeek-V3.2 tapi tetap gratis.** Kandidat ditemukan: **Kimi K2.6** (Moonshot AI) — **1.04 triliun parameter** (MoE, 32B aktif), context **256K token** — lebih besar dari DeepSeek-V3.2 di kedua dimensi. Sumber soal tier gratis-nya kontradiktif (blog tidak otoritatif: ada yang bilang "kimi akan cepat kena limit" tersirat bisa dipakai gratis, ada yang mengelompokkan sebagai butuh Pro/Max) — mengingat polanya sama seperti GLM-5.2 (model flagship raksasa), kemungkinan besar **juga** 403 subscription-required. User pilih tetap dites live untuk kepastian (bukan tebak dari blog).

**`OLLAMA_MODEL` sementara di-set ke `'kimi-k2.6'`** (tag tanpa `:cloud` suffix, konsisten dengan konvensi direct-API yang sudah dikonfirmasi) untuk pengujian ini. Kalau terbukti 403 (subscription required, sesuai dugaan), turunkan balik ke `gpt-oss:120b` yang sudah terbukti gratis & proven Bahasa Indonesia.

**Kendala baru:** karena SambaNova sudah kembali jadi primary (dan biasanya sukses), jalur Ollama tidak akan pernah tereksekusi lewat request normal — tidak bisa ditest organik. **Fix diagnostik:** tambah bypass `?test_ollama=1` (atau `body.test_ollama===true`) di `ohlcvAnalyzeHandler` — skip SambaNova untuk request itu SAJA, tidak mengubah urutan fallback produksi. Berguna juga untuk uji kandidat model Ollama berikutnya tanpa perlu re-order kode tiap kali.

**Hasil tes live `kimi-k2.6` via `?test_ollama=1`:** gagal — response balik `model:"llama-3.3"` (SambaNova ke-bypass sesuai rencana, tapi Ollama sendiri gagal, jatuh sampai ke Groq last-resort). Dugaan terkonfirmasi: 2 dari 2 model flagship raksasa (GLM-5.2 756B, Kimi K2.6 1.04T) gagal dengan pola sama. **Keputusan final (user setuju "seperti saran kamu saja"):** stop coba model raksasa lain, `OLLAMA_MODEL` dikunci ke `'gpt-oss:120b'` — kandidat yang confirmed gratis + sudah proven Bahasa Indonesia di app ini, bukan model terbesar yang bisa dicari tapi model yang REALISTIS bisa dipakai gratis & sudah terbukti cocok untuk kebutuhan app ini.

**Belum bisa dites end-to-end** — nunggu redeploy + circuit breaker `ai:ollama` clear dari window OPEN sebelumnya. Kalau `gpt-oss:120b` juga ternyata berbayar, `gpt-oss:20b` (dikonfirmasi gratis) atau `gemma4:31b` (disebut riset publik sebagai "strongest confirmed free model") jadi kandidat berikutnya — cukup ganti `OLLAMA_MODEL`, tidak perlu ubah struktur lain.

---

## Changelog Session 144 lanjutan 4 (2026-07-06) — Fix Budget SambaNova Tercampur 2 Akun (Penyebab Analisa AI Jatuh ke Groq llama-3.3)

**Request user:** komplain hasil Analisa AI pakai badge `llama-3.3` ("aku gamau sama ai jelek ini") lalu minta dicari tahu akar masalahnya ("kenapa gagal, cari tahu la") dan menegaskan primary harus tetap DeepSeek-V3.2 (SambaNova) — model paling berkualitas yang sudah dipakai.

**Investigasi:** sempat dicek apakah ini efek sesi 144 sebelumnya (integrasi Ringkasan↔Analisa, gate APP_KEY) — bukan; diff sesi itu cuma menambah isi prompt `ohlcv_analyze`, tidak menyentuh logika pemilihan provider/fallback.

**Root cause (ditemukan lewat pembacaan kode, bukan dugaan):** SambaNova dipakai dari **2 akun berbeda** — akun 2 untuk Call 1 (prosa Ringkasan) dan akun 1 untuk Call 2/3/4 (bias/thesis) + `fundamental_analysis` + `ohlcv_analyze` (Analisa). Circuit breaker sudah dipisah per akun sejak **Session 125** (`ai:sambanova:c1` vs `ai:sambanova:main`), tapi **guard kuota harian (`allowAiCall`, `api/_ai_guard.js`) tidak pernah ikut dipisah** — kedua akun berbagi satu counter Redis `ai_budget:sambanova:{hari}` (limit gabungan 200). `providerFromUrl(url)` juga tidak bisa membedakan akun karena `SAMBANOVA_URL` dan `SAMBANOVA_URL_CALL1` string-nya identik. Efeknya: makin sering Call 1 (Ringkasan, akun 2) jalan/di-generate-ulang, makin cepat kuota gabungan itu terpakai — begitu lewat limit, `ohlcv_analyze` (akun 1) ikut ditolak "AI daily budget exceeded" walau akun 1-nya sendiri belum tentu penuh, lalu jatuh ke fallback Groq `llama-3.3-70b-versatile`.

**Fix:**
- `api/_ai_guard.js`: `DEFAULT_LIMITS.sambanova` (200, gabungan) → `sambanova_main` (200, akun 1) + `sambanova_c1` (200, akun 2) — 2 counter independen, total headroom efektif dobel dan tidak saling starve.
- `api/market-digest.js`: `aiCall(...)` dapat parameter baru `providerOverride` (karena URL tidak bisa dipakai membedakan akun) — semua 4 titik panggil SambaNova (Call 1 akun 2, Call 2/3/4 akun 1) sekarang eksplisit kirim `'sambanova_c1'` atau `'sambanova_main'`, tidak lagi mengandalkan inferensi dari URL.
- `api/admin.js`: 2 titik `allowAiCall('sambanova')` (fundamental_analysis fallback, ohlcv_analyze) → `allowAiCall('sambanova_main')`; diagnostik `healthHandler` (`aiBudget`) sekarang laporkan `sambanova_main` + `sambanova_c1` terpisah, bukan `sambanova` gabungan.

**Verifikasi:** 2 test baru di `test/guards.test.js` (DEFAULT_LIMITS punya 2 counter terpisah + counter lama sudah tidak ada, `allowAiCall` fail-open untuk kedua nama baru tanpa Redis). Full suite 72/72 lulus, `node --check` bersih untuk ketiga file yang diubah.

**Catatan:** ini kemungkinan besar kontributor utama, tapi tidak bisa dikonfirmasi 100% tanpa akses log/Redis produksi (endpoint diagnostik `circuit-status`/`health` sekarang digate APP_KEY). Kalau badge `llama-3.3` masih muncul setelah fix ini di-deploy, kemungkinan berikutnya: circuit breaker `ai:sambanova:main` sedang OPEN (3 kegagalan beruntun akun 1 → pause 5 menit) — cek via `GET /api/admin?action=circuit-status` dengan header `x-app-key`.

---

**Request user:** melaporkan screenshot error `Error: (s || "").replace is not a function` yang muncul di hasil Analisa AI (XAU/USD) tepat setelah cooldown request AI selesai.

**Root cause:** `escHtml(s)` di `index.html` pakai pola `(s||'').replace(...)` — ini cuma aman kalau `s` falsy (`undefined`/`null`/`''`/`0`/`false`). Begitu `s` truthy tapi bukan string (number, boolean, array), `s||''` balikin `s` apa adanya (bukan string), jadi `.replace` di atasnya throw persis seperti pesan yang dilaporkan. Field `structured.sl` / `structured.tp` / `structured.entry_zone` dari JSON hasil AI (`ohlcv_analyze`) kadang dikembalikan sebagai number murni (mis. `sl: 4155.50`), bukan string — `_renderStructuredAi()` manggil `escHtml(structured.sl)` langsung tanpa `String(...)` dulu (beda dari `risk_reward`/`time_horizon_days` di fungsi yang sama, yang sudah dibungkus `String(...)` lebih dulu). Crash terjadi di dalam try-block `analyzeOhlcvAi()`, tertangkap `catch(e)`, dan `e.message` (pesan error JS mentah) itu sendiri yang ditampilkan ke user — makanya pesannya kebaca seperti pesan sistem, bukan Bahasa Indonesia biasa.

**Fix:** `escHtml` sekarang `String(s ?? '').replace(...)` — `null`/`undefined` tetap jadi string kosong, tapi number/boolean/array dikonversi ke string dulu sebelum di-escape. Diperbaiki di satu titik sumber supaya otomatis aman untuk 90+ titik pemanggilan `escHtml(...)` di seluruh file tanpa perlu sentuh satu-satu.

**Verifikasi:** `test/esc_html.test.js` baru (4 test): escHtml tidak throw untuk number/boolean/array, null/undefined/`''` tetap `''`, escape `&`/`<`/`>` masih benar untuk string normal, dan reproduksi end-to-end `_renderStructuredAi()` dengan `sl`/`tp`/`entry_zone` berupa number (persis skenario di screenshot). Full suite 70/70 lulus, semua `api/*.js` + inline script `index.html` lolos parse (`node --check` / `new Function`).

---

## Changelog Session 144 lanjutan 2 (2026-07-06) — Gate APP_KEY: Proteksi Kuota AI dari Link Bocor

**Request user:** "saya ingin agar orang lain tidak bisa dengan enaknya menghabiskan limit AI kalau kebetulan dia mendapatkan link aplikasi saya" — implementasi opsi app-key dari evaluasi mitigasi sebelumnya.

**Desain (keputusan penting):**
- **Fail-open sampai dikonfigurasi:** gate hanya aktif kalau env `APP_KEY` diset di Vercel — deploy kode ini duluan 100% aman, tidak mengubah perilaku apapun sampai user set env + redeploy. (Konsisten dengan filosofi `_ai_guard`/`_ratelimit` yang juga fail-open saat Redis tidak ada.)
- **Lapisan di depan proteksi yang sudah ada**, bukan pengganti: rate limit per-IP, budget AI harian (`_ai_guard`), dan circuit breaker tetap jalan seperti sebelumnya.
- **Satu pengecualian sadar:** `GET /api/feeds?type=rss` TIDAK digate — service worker (`sw.js`) polling notifikasi via `periodicsync` di background tanpa akses localStorage/key; endpoint ini cache-first 50s, tanpa AI, residual abuse murah. Semua endpoint lain (termasuk semua jalur AI: market-digest, ohlcv_analyze, fundamental_analysis, journal analyze) digate.

**Backend:**
- `api/_app_key.js` baru: `requireAppKey(req,res)` — cocokkan header `x-app-key` vs env `APP_KEY` pakai `crypto.timingSafeEqual` (guard panjang beda); OPTIONS selalu lolos (preflight tidak bawa custom header); bypass cron/admin via `x-vercel-cron` / `x-cron-secret`/`x-admin-secret` === `CRON_SECRET` (pola auth yang sama dengan gate cron existing di admin.js) — GitHub Actions & cron-job.org tidak putus.
- Gate dipasang di baris pertama handler **12 endpoint**: admin, calendar, cb-status, correlations, feeds (minus rss), journal, market-digest, rate-path, real-yields, risk-regime, sizing-history, subscribe.
- `fetchOrWarm()` di market-digest.js (panggilan internal server→server ke risk-regime/rate-path/correlations) sekarang mengirim `x-cron-secret` — tanpa ini warm call bakal 401 saat gate aktif.

**Frontend (`index.html`):**
- `window.fetch` dibungkus `_wrapFetchWithAppKey` (factory murni, dites di Node): semua request string `/api/*` otomatis diberi header `x-app-key` dari localStorage; fetch non-API (MT5 bridge localhost, TradingView) tidak disentuh; header bawaan call site (Content-Type dsb.) dipertahankan. Response 401 `{error:'app_key_required'}` → `showAppKeyGate()` (overlay input kunci, guard tampil-sekali, Enter/tombol → simpan localStorage + reload); 401 dari gate lain (mis. admin secret) tidak memicu overlay.
- Section PETUNJUK baru "🔒 Kunci Akses (APP_KEY)": penjelasan cara aktivasi + tombol MASUKKAN/UBAH KUNCI (`ptOpenAppKey()`) + catatan rotasi kunci (ganti env = cabut akses semua device).

**Cara aktivasi (belum aktif sampai ini dilakukan):** Vercel dashboard → Settings → Environment Variables → tambah `APP_KEY` (nilai bebas, panjang) → redeploy. Setelah itu tiap device diminta kunci sekali. Rotasi: ganti nilai env kapan saja.

**Verifikasi:** 66 unit test lulus (10 baru di `test/app_key.test.js`): fail-open tanpa env, kunci benar/salah/kosong, panjang beda tidak throw, OPTIONS lolos, 3 jalur bypass cron + secret salah tetap diblok, **integrasi in-process handler asli** (calendar & market-digest 401 sebelum kerja apapun; feeds type=cot diblok vs type=rss lolos dengan fetch upstream di-stub), wrapper client diekstrak dari index.html (header terpasang, non-API tidak disentuh, header bawaan dipertahankan, 401 selektif memicu overlay, body non-JSON tidak throw). Seluruh 22 file api/ lolos `node --check`; satu-satunya blok script inline index.html (478KB) lolos parse `new Function`.

---

## Changelog Session 144 lanjutan (2026-07-06) — Integrasi Ringkasan (Fundamental/Konteks) ↔ Analisa (Teknikal)

**Request user:** evaluasi integrasi antara fitur Ringkasan dan Analisa, lalu "kerjakan semuanya" (5 rekomendasi hasil evaluasi).

**Temuan evaluasi:** integrasi ada tapi timpang — arah teknikal→Ringkasan sudah sehat (price action multi-TF + anchor 6M), tapi arah fundamental→Analisa cuma kutipan prosa 700 char yang (1) pair-blind untuk FX (selalu "3 paragraf pertama" apapun pair-nya), (2) turunan artikel, bukan data terstruktur yang sudah ada di Redis (cb_bias, COT, risk regime tidak pernah sampai ke Analisa), (3) tanpa penanda umur padahal digest cuma 3x/hari, (4) fallback server hanya GC=F, (5) konflik makro-vs-teknikal cuma di prosa, tidak terstruktur.

**Implementasi (5 poin):**
1. **Blok FUNDAMENTAL TERSTRUKTUR di prompt Analisa** (`_formatFundamentalBlock`, pure): server baca langsung `cb_bias` (bias CB + confidence + umur, dirawat Call 2 digest), `cot_cache_v2` (COT leveraged net + perubahan w/w kedua leg; USD = Dollar Index), `risk_regime` (VIX/MOVE) — bukan turunan prosa. XAU dapat catatan khusus "pakai bias Fed + risk regime sebagai proxy". Best-effort: cache kosong = blok dilewati.
2. **Excerpt tertarget per pair** (`_extractRingkasanExcerpt` server + mirror `_extractRingkasanExcerptJs` client di index.html — ada unit test yang memastikan keduanya identik): bagian FX dipecah per marker `{{TAG: NAMA}}` yang memang sudah disisipkan AI digest → ambil jangkar (tema utama) + segmen yang tag-nya menyebut salah satu leg pair + blok Konfirmasi. Tag gabungan ("JPY/CHF") match per-leg. Artikel tanpa tag → fallback perilaku lama (3 paragraf). Cap 900 char (tertarget = minim noise; 700 tetap untuk XAU & fallback).
3. **Umur konteks makro:** client kirim `ringkasanGeneratedAt` (dari `ringkasanCache.generated_at`); header prompt jadi "KONTEKS MAKRO (dari Ringkasan X jam lalu)" + peringatan eksplisit kalau >4 jam ("beri bobot lebih rendah kalau ada rilis besar setelahnya"). Umur juga tampil di label hasil UI: "teknikal + makro (3.2j lalu) + fundamental".
4. **Field `makro_alignment` di kontrak JSON** (searah/konflik/netral + `makro_alignment_reason` satu kalimat) — padanan verdict "dasar bertumpu" SIMULASI. Normalisasi server: canon 3 nilai (+ alias EN), dipaksa null kalau blok makro & fundamental dua-duanya memang tidak dikirim (AI tidak boleh mengaku menilai dari data yang tidak ada). UI: chip outline ✓ MAKRO SEARAH (hijau) / ⚠ MAKRO KONFLIK (oranye) / – MAKRO NETRAL (muted) di samping badge bias + baris alasan (di-escape).
5. **Fallback server `latest_article` untuk SEMUA pair** (dulu GC=F saja): user yang belum pernah buka tab Ringkasan tetap dapat konteks makro selama key-nya hidup; `hasMakro` di frontend sekarang dibaca dari response server (bukan `!!ringkasanContext` lokal) karena makro bisa disuplai server-side. Response baru: `hasFund`, `makro_generated_at`.

**Hardening kecil:** `ringkasanContext` dari body request (input publik) di-cap server-side (non-string → null, >1200 char dipotong) supaya tidak bisa dipakai menggelembungkan prompt AI.

**Kompatibilitas:** client lama→server baru (tanpa generatedAt → header polos), server lama→client baru (tanpa hasFund → badge fundamental tidak tampil), payload cached pra-deploy tanpa field baru → renderer aman (diverifikasi smoke test).

**Verifikasi:** 56 unit test lulus (9 baru di `test/makro_ctx.test.js`: ekstraksi XAU/EUR/USD-JPY/no-tag/no-match/cap + mirror client-server identik + fund block lengkap/XAU/parsial/kosong) + smoke test render frontend via ekstraksi fungsi (badge umur makro, 3 nilai alignment, payload lama, XSS guard reason & entry_basis) + `node --check`. Path AI live tidak bisa diuji lokal (butuh Redis + API key produksi) — konsisten sesi sebelumnya.

---

## Changelog Session 144 (2026-07-06) — Evaluasi & Upgrade Konteks AI: Saran Entry Analisa Berbasis Struktur Harga

**Request user:** evaluasi pengetahuan & konteks AI fitur Ringkasan dan Analisa — apakah perlu diperpanjang; kritik terhadap saran entry AI Analisa: "terlalu tidak mendasar dan terlalu sempit, tidak memakai struktur data harga, pola, dll secara teknikal".

**Hasil evaluasi (root cause dikonfirmasi dari kode, bukan asumsi):** kritik user benar, tapi mekanismenya bukan "AI-nya tidak bisa analisa teknikal" — prompt `ohlcv_analyze` sejak lama (benar) melarang AI mengarang angka di luar DATA TEKNIKAL, sementara data yang dikirim cuma berisi ~10 angka ringkasan: range 30D + top-2 high/low harian (sering 2 candle bertetangga dari spike yang sama = efektif 1 level), range/trend 4H + 2 swing, range 1H, RSI/SMA Daily, MACD, ATR. Tanpa candle mentah (blok Ringkasan dapat 24 candle 1H, Analisa justru tidak), tanpa market structure, tanpa level bersentuhan-banyak, tanpa fib/pivot/pola. Jadi entry-nya pasti sempit — AI "kelaparan" struktur, lalu menjangkar ke segelintir angka yang ada. Solusinya BUKAN melonggarkan larangan mengarang (itu guard halusinasi yang benar), tapi memperbanyak menu struktur ter-grounded yang boleh dipakai + memaksa AI menyebut dasar strukturnya. Konteks fundamental Ringkasan (headline 36 jam, kalender 3 hari, real yield/risk regime/rate path/korelasi/skew, history 7+4 sesi) TIDAK perlu diperpanjang — yang bolong justru memori harga: cuma 30 bar Daily, AI tidak bisa tahu harga sedang "di puncak 6 bulan" vs "di tengah range".

**Perubahan data layer (`api/admin.js`):**
- Fetch daily `range=1mo` → `range=6mo`, snapshot `ohlcv:{symbol}:1d` sekarang 135 bar (TTL tetap 25h; `ohlcv_sync` + `refreshOhlcvFromYahoo`). Konsumen window-30D (`d1` stat UI, blok "Daily 30D") `slice(-30)` sendiri supaya label tetap jujur. Bonus gratis: window MFE/MAE jurnal (`api/journal.js` baca key yang sama) ikut memanjang untuk trade lama.
- Refactor: perakitan metrik dipisah dari I/O jadi `computeOhlcvMetrics({symbol,label,c1h,c4h,c1dFull,ta})` (pure) — `loadOhlcvData` tinggal fetch/parse lalu delegasi; bisa diuji end-to-end tanpa Redis.
- Helper struktur baru (semua pure, di-export untuk test): `_classifyStructure` (HH+HL/LH+LL/Mixed dari 2 swing terakhir + deteksi BOS saat close menembus swing), `_clusterSrLevels` (cluster pivot Daily 6 bulan + swing H4, tolerance 0.35×ATR-Daily, kekuatan = jumlah candle Daily yang menyentuh; max 3 resistance + 3 support, **cluster terdekat ke harga dijamin ikut** — tanpa ini top-3 by sentuhan bisa semuanya zona lama ratusan pip jauhnya, bagus untuk TP tapi entry/SL butuh struktur immediate), `_fibLevels` (retracement 38.2/50/61.8 dari leg dominan 4H, arah dari urutan waktu ekstrem), `_dailyPivots` (pivot klasik dari daily kemarin yang sudah close, index len-2 karena bar terakhir masih berjalan), `_prevWeekHighLow` (minggu kalender Senin-start), `_detectCandlePatterns` (engulfing/pin bar/inside bar/doji dari OHLC — deterministik, AI tinggal pakai label; candle terakhir ditandai "berjalan, belum close"), `_rsi14` (Wilder, untuk RSI H4 + arah vs 3 candle lalu). `_findSwings` dapat param `keep` (H4 sekarang simpan 4 swing, field legacy `swing_high/low` tetap untuk UI).
- `loadOhlcvData` field baru di payload (semua additive, cache klien lama tetap kompatibel): `d1_ext` (range 6M, posisi % dalam range, jarak dari puncak, ATR-Daily), `structure`, `sr_levels`, `fib`, `ref_levels` (pivot + prev day H/L/C + prev week H/L), `patterns`, `rsi_h4`, `h4.candles12` (12 candle H4 mentah).
- `buildOhlcvText`: blok baru `[KONTEKS 6 BULAN]`, `[STRUKTUR H4]`, `[LEVEL S/R]`, `[FIBONACCI]`, `[PIVOT HARIAN]`, `[LEVEL REFERENSI]`, `[POLA CANDLE]`, `[RSI-14 H4]`, + 12 candle H4 dan 12 candle 1H mentah (Analisa akhirnya lihat candle langsung, bukan cuma ringkasan). Semua guarded per-blok — fallback `clientOhlcv` dari sessionStorage pra-deploy tidak crash. Total teks ~800 token (diukur, bukan estimasi).

**Perubahan prompt `ohlcv_analyze` (`api/admin.js`):**
- `bias` wajib mempertimbangkan struktur HH/HL vs LH/LL + BOS, bukan cuma perubahan %.
- `entry_zone` wajib berpijak pada level struktur bernama (cluster S/R, fib, pivot, prev day/week, swing, SMA, expiry) dengan PRIORITAS KONFLUENSI 2+ struktur di area sama; field baru **`entry_basis`** memaksa AI menyebut struktur apa saja + angkanya yang jadi dasar entry (kontrak JSON di system message ikut diupdate). Server menormalisasi: `entry_basis` di-null kalau bukan string/kosong/entry_zone di-drop sanity check.
- **Opsi no-setup eksplisit:** kalau struktur Mixed dan tidak ada level kuat searah bias, AI diinstruksikan set entry/sl/tp/entry_basis null + jelaskan di trigger apa yang ditunggu — jangan memaksakan setup (dulu selalu dipaksa keluar angka).
- `sl` wajib di balik struktur dengan buffer ~0.5×ATR H1 (anti wick-hunt), `tp` = struktur berikutnya searah bias, `trigger` diprioritaskan konfirmasi price action/pola candle di level konkret. Struktur commentary 4 paragraf diarahkan ke: posisi range 6 bulan → struktur H4 + cluster S/R → momentum + pola candle + RSI H4 → integrasi konfluensi.

**Ringkasan (`api/market-digest.js`):** `fetchOhlcvContext` slice daily ke 30 bar untuk blok lama (label "Daily 30D" tetap benar) + baris baru `[6 BULAN] Range | Posisi now % | Jarak dari puncak` (guard ≥40 bar untuk cache lama pra-deploy); prompt XAU JANGKAR HARGA diminta menyebut posisi range 6 bulan dalam frasa singkat di kalimat jangkar. Konteks headline/kalender/history TIDAK diubah (sudah pas untuk briefing pre-session, memperpanjang cuma nambah noise + token).

**Hardening (`api/correlations.js`):** kolisi cache key laten diperbaiki — `action=ohlcv` (chart endpoint lama, tidak dipanggil frontend saat ini) memakai key `ohlcv:{symbol}:{tf}` yang SAMA dengan snapshot admin.js tapi shape beda (object `{candles:[{time,open,...}]}` vs array `[{t,o,...}]`) dan TTL beda (30 menit vs 25h) — satu call saja ke endpoint itu dengan `tf=1d` akan menimpa snapshot dan diam-diam mematikan Analisa/MFE-MAE/PRICE ACTION digest sampai sync berikutnya. Di-rename ke `ohlcv_chart:{symbol}:{tf}` (+ lock key).

**Frontend (`index.html`):** `_renderStructuredAi` render baris **DASAR** (entry_basis, di-escape) di bawah ENTRY/SL/TP; payload lama tanpa field itu tidak menampilkan apa-apa (backward compatible).

**Verifikasi:** 47 unit test Node lulus (21 baru di `test/ta_struct.test.js`: swing keep-N, klasifikasi struktur + BOS, cluster S/R + jaminan level terdekat, fib dua arah, pivot, prev-week, 4 pola candle + guard flat/kosong, RSI monotonic/campuran/kurang data, buildOhlcvText lengkap vs legacy) + smoke test pipeline penuh dengan data Yahoo RIIL (EUR/USD + XAU/USD: `fetch → resampleTo4h → computeOhlcvMetrics → buildOhlcvText`, sanity check S/R relatif harga, fib dalam range, urutan pivot S2<S1<P<R1<R2, RSI 0-100, semua blok ter-render — pola nyata terdeteksi: Pin Bar atas + Bearish Engulfing di XAU H4) + render frontend diuji via ekstraksi fungsi dari index.html (entry_basis tampil/absen/null/XSS-escape). Path AI live (SambaNova/Groq + Redis produksi) tidak bisa diuji lokal — konsisten dengan sesi-sesi sebelumnya, diverifikasi via `node --check` + unit/smoke test di atas.

---

## Changelog Session 143 lanjutan 3 (2026-07-05) — SIMULASI Kalender: Konfluensi "Dasar Bertumpu" + Tombol Hitung Lot

**Request user:** (1) tombol "→ Buka CHECKLIST" di panel SIMULASI event kalender ingin juga bisa mengarah ke sizing calculator, tapi bingung wording-nya supaya user paham; (2) rekomendasi pair hasil simulasi harus punya "dasar bertumpu" — contoh: data USD beat bukan berarti langsung sell EUR/USD; perlu konfirmasi EUR memang lagi lemah (fundamental, hawkish/dovish, teknikal, korelasi) sebelum pair itu layak direkomendasikan.

**Konfluensi multi-faktor per pair (`scenarioConfluence()` di `index.html`):** tiap pair rekomendasi kini diuji terhadap 6 faktor independen, tampil sebagai baris ✓ (mendukung) / ✕ (konflik) / − (netral) / … (data belum dimuat):
1. **Bias CB** — divergensi hawkish/dovish kedua sisi pair (`CB_BIAS_LEVEL`, sudah jadi skor dasar ranking → display-only, tanpa bonus ganda).
2. **Makro** — skor fundamental Bull/Bear kedua mata uang, dihitung dari `fundData` via helper standalone `scenarioFundScore()` (logika sama dengan tab FUNDAMENTAL, tapi tidak butuh tab itu dirender dulu). Support = gap skor ≥15 searah skenario; teks menyesuaikan kalau salah satu sisi belum punya data (tidak mengklaim "counter lemah" saat datanya kosong).
3. **COT** — reuse `cotAlignmentNote()` (flow leveraged funds mingguan, threshold 5K kontrak) — helper yang sama dengan Checklist/Jurnal.
4. **Retail** — sinyal kontrarian dari `retailData` (baris disembunyikan untuk pair di luar cakupan feed retail).
5. **Korelasi antar-leg** — `corrData.matrix_20d` seri kekuatan mata uang (USD=DXY): r ≤ -0.4 = kedua leg bergerak berlawanan → pair responsif terhadap kejutan (✓); r ≥ +0.4 = leg searah → pergerakan pair teredam (✕, relevan untuk cross seperti EUR/GBP).
6. **Teknikal** (async) — SMA50/SMA200 + RSI dari `/api/correlations?action=ta&interval=1d`, render placeholder "memuat…" lalu diisi `scenarioFillTA()`. Cache 15 menit (memory + sessionStorage) supaya toggle BEAT/MISS tidak menghajar rate limit 5 req/menit. RSI ekstrem (≥70 long / ≤30 short) menetralkan verdict searah + catatan overbought/oversold.

**Ranking & verdict:** skor ranking bukan lagi murni divergensi CB — faktor sinkron (makro ±2, COT ±0.75, retail ±0.5, korelasi ±0.5) jadi bonus/penalti di `scenarioRankCurrencies()`, jadi pair dengan dasar bertumpu lebih kuat naik peringkat. Teknikal yang datang async sengaja display-only (tidak re-rank, biar baris tidak lompat-lompat). Badge verdict per pair: **DASAR KUAT** (≥3✓ tanpa ✕) / **DASAR CUKUP** / **CAMPURAN** / **KONFLIK** — badge ikut ter-update saat baris teknikal masuk (`scenarioBumpVerdict()` via data-attribute).

**Auto-load data:** `scenarioEnsureData()` — sumber yang belum dimuat (cb-status, fundamental, COT, retail, korelasi) di-fetch di belakang saat simulasi dibuka, lalu panel re-render kalau skenario yang sama masih aktif (throttle 60 detik supaya sumber yang gagal tidak di-spam). Pesan lama "buka tab RINGKASAN dulu" diganti "Memuat data bias bank sentral…" yang resolve sendiri.

**Tombol aksi per pair (bukan lagi satu tombol global):** tiap pair punya "✓ Validasi CHECKLIST" dan "⚖ Hitung Lot · SIZING" (`scenarioGoToChecklist()`/`scenarioGoToSizing()`). Wording "Hitung Lot" dipilih karena itu bahasa yang dipakai petunjuk app sendiri ("Output: lot size yang tepat"); "· SIZING" menautkan ke nama tab. Tombol SIZING sekaligus pre-select pair + arah (LONG/SHORT) di kalkulator (pola sama dengan `thesisGoToSizing()`) + toast panduan "isi equity, risk %, dan jarak SL… tetap validasi CHECKLIST sebelum entry".

**Verifikasi:** 12 unit test Node (ekstraksi fungsi dari index.html + mock data: ranking beat/miss, verdict per kombinasi data lengkap/parsial/kosong, threshold badge, render HTML) + 23 test E2E Chrome headless via puppeteer-core dengan mock API (BEAT/MISS toggle, badge ter-update setelah TA async, cache TA antar-toggle, navigasi tombol SIZING pre-select pair+arah, CHECKLIST pre-select pair, event non-USD, tanpa JS error) — semuanya lulus. Screenshot desktop 1400px & mobile 390px dicek visual: tidak ada horizontal overflow.

---

## Changelog Session 143 lanjutan 2 (2026-07-05) — Tab CAL: Date-Jump Picker

**Laporan user:** minta kemampuan lompat ke tanggal tertentu di kalender (mis. 2 bulan ke depan), seperti date-range picker di ForexFactory (screenshot referensi: input tanggal + kalender 2 bulan berdampingan).

**Temuan saat investigasi:** `api/calendar.js` ternyata sudah punya `fetchTradingViewEvents(rangeStartWib, rangeEndWib)` sebagai sumber PRIMARY (TradingView calendar endpoint, terima `from`/`to` arbitrer) — ForexFactory XML (`ff_calendar_thisweek.xml`/`nextweek.xml`) cuma FALLBACK kalau TradingView gagal, dan itu memang cuma punya this/next week. Jadi kemampuan date-arbitrer sebenarnya sudah ada di backend, cuma belum pernah diexpose ke `?date=` — endpoint cuma terima `?week=next` atau default this-week.

**Fix backend (`api/calendar.js`):**
- Terima `?date=YYYY-MM-DD` (validasi format + tanggal valid). Menghitung window Senin-Minggu (bukan rolling 5 hari seperti "this week" default) yang berisi tanggal tsb — extract helper `computeWeekMonday()`, `computeWeekRange()` dapat parameter ke-3 `isCustomWeek`.
- Cache key terpisah per pekan: `calendar_custom_{mondayDate}` — supaya beberapa tanggal dalam pekan yang sama share cache, TTL sama (6 jam) dengan cache this/next week.
- **PENTING:** untuk `?date=` custom, TIDAK fallback ke ForexFactory kalau TradingView gagal (beda dari this/next week) — FF cuma punya this/next week, kalau dipakai sebagai fallback untuk tanggal arbitrer akan diam-diam menampilkan event MINGGU YANG SALAH di bawah label tanggal yang diminta. Kalau TradingView gagal untuk custom date, request itu error (bukan silently wrong data).

**Fix frontend (`index.html`):**
- `calWeekView` sekarang punya value ke-3: `'custom'` (selain `'this'`/`'next'`), dengan state terpisah `calDataCustom`/`calCustomWeekLabel`. Helper `calActiveSourceData()` dipakai di `renderCalendar()` DAN `renderCalDayStrip()` supaya day-strip picker dari sesi sebelumnya otomatis ikut bekerja untuk pekan custom juga.
- Row toolbar baru: `<input type="date">` native (zero maintenance, native calendar popup, mobile-friendly — tidak reimplement grid kalender FF dari nol) + tombol "📅 Lompat". `color-scheme:dark` di CSS supaya popup native-nya match tema gelap app.
- Setelah lompat, tanggal yang diminta OTOMATIS ter-select di day-strip (`calSelectedDate = dateStr`) — jadi user langsung lihat event di tanggal itu, bukan cuma pekannya. Chip aktif "📅 Pekan {tanggal} ✕" muncul di toolbar, klik untuk kembali ke Minggu Ini (`calClearCustomWeek()` → `setCalWeekView('this')`).
- Countdown timer (khusus "hari ini") disembunyikan saat viewing custom/next week, bukan cuma saat next week seperti sebelumnya (bug kecil yang ikut ditemukan & diperbaiki).

**Verifikasi:** diuji via Playwright dengan `/api/calendar` di-mock — konfirmasi request memakai `?date=2026-08-17` yang benar, chip toolbar menampilkan "Pekan 17 Agu 2026", day-strip auto-select tanggal 17, list terfilter ke 1 event (CPI m/m) yang match, dan klik chip mengembalikan ke Minggu Ini (`calWeekView` kembali `'this'`, chip hilang). Logic penghitungan pekan Senin-Minggu diverifikasi terpisah cocok persis dengan tanggal di screenshot referensi (17 Agu 2026 = Senin, minggu Senin 17 - Minggu 23).

---

## Changelog Session 143 lanjutan (2026-07-05) — Tab Artikel: Entri Kalender Masa Depan Menutupi Artikel Hari Ini

**Laporan user:** di tab Artikel (CB Watch/Riset), badge BOC dengan tanggal Oktober–Desember 2026 (Boxing Day, Christmas Day, Interest Rate Announcement, dll) tampil di atas artikel yang benar-benar baru (MTM/FJElite/ING tertanggal 3-4 Juli 2026).

**Root cause:** `api/feeds.js` `researchHandler()` sort `items` by `pubDate` descending (`renderResearch()` di `index.html` juga sort ulang dengan cara sama). Sumber BOC pakai feed umum `https://www.bankofcanada.ca/feed/` (dikomentari di kode: "general feed yang valid" karena `/feed/speeches/` sudah return HTML) — feed ini ternyata mencampur publikasi asli dengan entri kalender (hari libur nasional, tanggal pengumuman suku bunga terjadwal), dan `<pubDate>` untuk entri kalender itu adalah tanggal EVENT-nya sendiri (mis. 28 Des 2026 untuk Boxing Day), bukan kapan entry itu dipublikasikan/diindeks. Sort descending otomatis menaruh tanggal masa depan di atas.

**Fix (`api/feeds.js` `researchHandler`):** tambah filter sebelum sort — buang item dengan `pubDate` lebih dari 1 jam ke depan (toleransi kecil untuk timezone quirk antar-feed). Item yang benar-benar sudah dipublikasikan tidak mungkin bertanggal masa depan, jadi ini generik untuk semua 12 sumber CB research, tidak perlu maintain blocklist judul/holiday per-sumber (yang akan gampang basi kalau BoC ganti format kalendernya).

---

## Changelog Session 143 (2026-07-05) — 5 Perbaikan Kecil dari Feedback User

Lima laporan user, semua diverifikasi lewat kode langsung (bukan asumsi) sebelum di-fix, lalu diuji end-to-end dengan Playwright (browser asli, chart TradingView live) terhadap `index.html` yang di-serve statis.

1. **Catatan Analisa "Auto" tidak lagi menghapus catatan manual** (`index.html`, tab TEK) — Root cause: `autoFillTekNote()` selalu `noteEl.value = text` (replace total). Fix: tambah marker `TEK_AUTO_SEP`; `autoFillTekNote()` sekarang extract bagian manual (teks setelah marker, atau seluruh teks lama kalau belum pernah pakai Auto) via `_tekNoteManualPart()`, lalu gabungkan `${autoText}\n${TEK_AUTO_SEP}\n${manualText}`. Klik Auto berulang kali hanya meng-update blok atas, tidak pernah menyentuh/menduplikasi bagian manual di bawah marker. Halaman refresh tidak pernah memicu `autoFillTekNote()` otomatis (hanya via klik tombol), jadi catatan manual otomatis aman juga lintas-refresh.

2. **Thesis AI (invalidation monitor) sekarang otomatis + terjadwal seperti Ringkasan & Analisa XAU/USD** (`api/market-digest.js`, `api/journal.js`, `api/subscribe.js`, `index.html`) — Root cause: Call 4 (cek headline vs thesis open di jurnal) di-gate `&& deviceId`, dan cron GitHub Actions (3x/hari) memanggil endpoint TANPA device_id (by design, karena Call 4 dulunya per-user) — jadi Call 4 selalu skip di cron, dan `thesis_alerts:{device}` cuma terisi kalau user manual tap "Ringkas Ulang", dengan TTL 30 menit yang bikin alert cepat basi. Fix:
   - `journal.js`: `SADD('journal_devices', deviceId)` setiap kali entry jurnal dibuat — registry device yang punya data jurnal.
   - `market-digest.js`: extract logic Call 4 jadi `fetchOpenThesisEntries()` + `checkThesisContradictions()` (dipakai baik oleh path live single-device maupun path baru), dan sweep-nya sendiri jadi `runCronThesisSweep()`. Saat `isCronCall`, loop `SMEMBERS('journal_devices')` (cap 10) **konkuren** (`Promise.allSettled`, bukan sequential — tiap device bisa makan ~16s kalau SambaNova gagal+fallback Groq) — jalankan cek kontradiksi per device, simpan `thesis_alerts:{device}` dengan TTL 8 jam (menutup celah antar 3 run harian), dan push notification device tsb kalau ada alert BARU (dedupe by `entry_id|headline`).
   - **Revisi setelah review kedua:** `runCronThesisSweep()` awalnya di-`await` inline di tengah handler — ini salah, karena GitHub Actions (`market-digest.yml`) meng-curl endpoint ini dengan `--max-time 55` dan `vercel.json` set `maxDuration:60` untuk fungsi ini. Menambah hingga ~16s blocking di atas latency Call 1-3 yang sudah ada berisiko bikin SELURUH response (article+bias+thesis, bukan cuma thesis-alert) timeout di GitHub Actions curl. Fix: `runCronThesisSweep(...)` sekarang dipanggil fire-and-forget (`.catch()`, tidak di-`await`) tepat sebelum `res.status(200).json(payload)`, persis pola yang sudah dipakai `notifyDigestReady()` di baris sebelumnya (sudah terbukti jalan di produksi untuk push "Ringkasan siap"). Jadwal 3x/hari-nya tidak berubah — cron GitHub Actions yang sama tetap men-trigger `isCronCall`, cuma sekarang tidak menahan response.
   - `subscribe.js` + `index.html` (`_doSubscribe`): subscription push sekarang menyertakan `device_id`, disimpan di `push_subs` hash — dipakai `loadPushSubsByDevice()` di market-digest.js untuk push targeted per device (bukan broadcast).

3. **Redesign tab CAL** (`index.html`) — (a) Toolbar dipecah dari satu baris flex-wrap yang berantakan di layar sempit jadi 2 baris jelas (`cal-toolbar-row`): filter impact + count di baris 1, filter minggu + refresh di baris 2. (b) `.cal-date-label` diperbesar & dipertegas (8px muted → 11px bold, warna accent kalau hari ini). (c) **Day-strip picker baru** (`#calDayStrip`, `renderCalDayStrip()`) — baris tanggal horizontal-scroll di atas list event, satu chip per tanggal yang ada di dataset aktif (minggu ini/depan), dengan dot merah/kuning kalau ada event High/Medium hari itu. Klik chip → `calSelectDate()` → filter list ke tanggal itu saja (toggle, klik lagi atau tombol × untuk kembali ke semua tanggal).

4. **Indikator teknikal sekarang tampil di chart TEK, bukan cuma di stat card** (`index.html`, `createTVChart()`) — Root cause: widget `TradingView.widget({...})` di tab TEK tidak pernah diberi parameter `studies`, jadi chart candlestick polos tanpa overlay apapun, padahal panel di bawahnya sudah menghitung & menampilkan RSI 14 / SMA 50 / SMA 200 sebagai teks. Fix: tambah `studies: [{id:'MASimple@tv-basicstudies', inputs:{length:50}}, {id:'MASimple@tv-basicstudies', inputs:{length:200}}, {id:'RSI@tv-basicstudies'}]` — diverifikasi visual via Playwright: MA 50/MA 200 tampil sebagai overlay garis di price pane, RSI sebagai sub-pane, nilai live cocok dengan yang ditampilkan TradingView sendiri di kiri-atas chart.

5. **Section baru "Untuk Pengguna Laptop" di tab PETUNJUK** (`index.html`) — App sudah lama punya sistem keyboard shortcut lengkap (`G` + huruf untuk navigasi tab, dll) dengan overlay referensi (`kbOverlay`, buka via tombol `?`), tapi overlay itu tidak pernah ditemukan dari mana pun di UI (fungsi `openKbHelp()` tidak pernah dipanggil dari elemen manapun) dan tidak disebut sama sekali di guide PETUNJUK — praktis tak diketahui trader yang pertama kali pakai laptop. Fix: tambah section baru sebelum "Sinkronisasi Device" yang mereproduksi seluruh daftar shortcut secara tertulis + tombol "BUKA REFERENSI CEPAT (?)" yang memanggil `openKbHelp()`.

**Verifikasi:** semua 4 perubahan frontend diuji pakai Playwright (Chromium asli, bukan cuma baca kode) terhadap `index.html` yang di-serve via static server lokal — termasuk chart TradingView live (perlu internet asli, bukan mock) yang mengonfirmasi MA 50/200 + RSI benar-benar ter-render. Perubahan backend (#2) tidak bisa diuji live (butuh Redis + AI API key produksi + cron GitHub Actions sungguhan) — diverifikasi via `node --check` (syntax) dan review manual logic, termasuk fix konkurensi untuk mencegah timeout Vercel.

---

## Changelog Session 142 (2026-07-03) — Status Jurnal PENDING vs OPEN untuk Pending Order

**Masalah (ditemukan lewat pertanyaan user):** entri jurnal untuk pending order (buy/sell limit yang di-set dari Sizing Calculator, belum tersentuh harga) selalu tampil badge **"OPEN"** — identik dengan trade yang sudah benar-benar terisi. Investigasi lanjut menemukan dua gap sekaligus:
1. Frontend sudah menghitung `order_kind` (`'limit'`/`'market'`) sejak lama dan mengirimnya ke `POST /api/journal`, tapi backend **tidak pernah menyimpannya** — dibuang begitu saja.
2. Tidak ada mekanisme apapun (di `mt5_bridge.py`, `index.html`, atau `api/`) yang mendeteksi kapan sebuah pending order benar-benar ke-fill di MT5. `mt5_bridge.py` bersifat fire-and-forget: kirim order sekali, tidak pernah cek balik. Endpoint `/positions` di bridge sudah ada sejak lama ("untuk cross-check dengan jurnal" per komentarnya sendiri) tapi tidak pernah dipanggil dari frontend — dead code.

**Keputusan desain (didiskusikan dengan user sebelum implementasi):** rekonsiliasi status HANYA boleh berdasar data MT5 yang terkonfirmasi (lewat bridge), bukan tebakan dari harga live yang delay. Sempat dipertimbangkan fallback "kemungkinan terisi" berbasis perbandingan harga saat bridge tidak bisa dijangkau (mis. akses dari HP), tapi ditolak karena berisiko flip-flop/salah dan mengikis kepercayaan pada badge — konsisten dengan prinsip yang sudah dipakai di baris "Harga sekarang" (`index.html`, komentar dekat `jnFetchLivePrices`): tidak overclaim presisi dari data yang bukan realtime. Kalau bridge tidak reachable, badge PENDING cukup tetap apa adanya (last known state), user bandingkan manual lewat baris Entry vs Harga sekarang yang sudah ada.

**Implementasi:**
- `mt5_bridge.py`: endpoint baru `GET /orders` (`mt5.orders_get()`) — daftar pending order yang masih resting. Dipakai bareng `/positions` yang sudah ada: ticket ada di `/positions` → sudah terisi; ada di `/orders` → masih pending; tidak ada di keduanya → dibatalkan/expired di MT5. Tidak bump `BRIDGE_VERSION` (endpoint baru murni, tidak mengubah logika `/order` yang sudah digate versi).
- `api/journal.js`: entry sekarang menyimpan `order_kind`, `mt5_ticket` (dari `fill.ticket` saat order dikonfirmasi), dan `fill_state` (`pending`/`filled`/`cancelled`, default `filled` untuk market order). PATCH menerima update `fill_state` untuk rekonsiliasi.
- `index.html`:
  - `ckMt5AutoJournal()`: kirim `mt5_ticket` + `fill_state` awal (`pending` untuk limit/stop, `filled` untuk market) ke jurnal.
  - `jnReconcilePendingOrders()` (baru): dipanggil tiap `jnLoadEntries()` (buka tab JURNAL). Cek `/health` bridge dulu (short timeout, silent no-op kalau offline/dari device lain) — kalau online, tarik `/positions` + `/orders`, cocokkan `mt5_ticket` tiap entri `pending`, PATCH status baru ke server. Di-throttle 20 detik biar tidak spam saat re-render cepat.
  - Badge JURNAL: `status==='open'` sekarang tampil **PENDING** (kuning) atau **DIBATALKAN** (merah) sesuai `fill_state`, bukan cuma "OPEN" generik. Entri lama tanpa `fill_state` tetap tampil "OPEN" seperti sebelumnya (backward-compatible).
  - Tombol "Tutup" disembunyikan untuk entri `pending`/`cancelled` — tidak ada posisi nyata untuk ditutup.
  - Portfolio Risk (`jnRenderVaR`) dan export CSV ikut dikoreksi supaya tidak menghitung/melabeli pending & cancelled order sebagai risiko/status "open" yang sudah live.

**Bug ditemukan & diperbaiki lewat testing mandiri:** simulasi manual (skrip Node standalone, sama pola dengan verifikasi Call 4 session 140) awalnya menunjukkan entri `cancelled` masih ikut terhitung di Portfolio Risk — filter `jnRenderVaR` cuma exclude `pending`, lupa `cancelled`. Diperbaiki, re-test lolos semua skenario (market/pending/cancelled/legacy/closed/archived × badge, tombol Tutup, VaR, rekonsiliasi ticket-matching).

**Batasan by-design (bukan bug):**
- Rekonsiliasi cuma jalan kalau browser & bridge di PC yang sama (`localhost:5000` tidak reachable dari device lain) — dari HP, badge PENDING tetap apa adanya sampai user buka lagi dari PC.
- Entri `cancelled` tidak auto-archive — sengaja dibiarkan manual (tombol Arsip yang sudah ada) supaya tidak diam-diam mengubah data user tanpa persetujuan, konsisten dengan pola hard-delete jurnal session 141.
- `mt5_ticket` dari pending order diasumsikan sama dengan ticket posisi hasil eksekusinya (perilaku standar MT5 untuk single-fill tanpa netting) — kalau broker/setup user pakai skema hedging/netting yang mengubah ticket, rekonsiliasi bisa gagal match dan entri tetap PENDING selamanya (aman — gagal diam-diam ke "tidak tahu", bukan salah tampil "OPEN"/"DIBATALKAN").

**Tindakan wajib dari user:** `mt5_bridge.py` gitignored (lokal-only) — restart proses (tutup jendela lama, jalankan ulang `start_bridge.bat`) supaya endpoint `/orders` baru aktif dan rekonsiliasi bisa jalan.

**Verifikasi:** `node --check api/journal.js`, parse inline script `index.html`, `python -c "import ast; ast.parse(...)"` untuk `mt5_bridge.py`, `npm test` (25/25) — semua lolos. Simulasi logika badge/tombol/VaR/rekonsiliasi via skrip Node standalone — semua skenario sesuai ekspektasi setelah perbaikan bug VaR di atas. Eksekusi live (limit order sungguhan sampai fill/cancel di MT5) belum diverifikasi dari sini — perlu ditest langsung oleh user dengan bridge & MT5 terminal aktif.

**Bug lanjutan ditemukan saat user coba live (bukan simulasi):** user konfirmasi entry buy limit XAU/USD 0.02 @4090 dari Checklist — order sukses masuk MT5 (ticket #57392307105, terbukti dari screenshot terminal, status "placed"), tapi **entri jurnalnya sama sekali tidak muncul** di JURNAL, bukan cuma badge yang salah. Root cause: `ckMt5AutoJournal()` ( `index.html`) mem-POST ke `/api/journal` dengan `.catch(() => {})` di ujungnya — pola pre-existing (bukan diperkenalkan session ini) yang membungkam SEMUA kegagalan (network, rate limit, error server) tanpa jejak apapun, sementara toast "Order Masuk ✓" tetap muncul unconditional setelahnya seolah semuanya beres. User tidak pernah tahu jurnalnya gagal tersimpan.

**Fix:** POST jurnal sekarang dibungkus try/catch yang cek `res.ok` — kalau gagal, muncul toast merah eksplisit "⚠ Jurnal Gagal Tersimpan" dengan ticket MT5 dan pesan error, plus saran catat manual via "+ BARU". Order MT5 tetap dianggap sukses (toast "Order Masuk ✓" tidak terpengaruh) — hanya kegagalan pencatatan jurnal yang sekarang terlihat. Root cause spesifik kenapa POST-nya gagal untuk kasus ticket #57392307105 belum diketahui (tidak ada akses log Vercel dari sini) — toast baru ini akan menangkap pesan error asli di percobaan berikutnya.

**Root cause sebenarnya ditemukan (percobaan live kedua):** dugaan "POST jurnal gagal diam-diam" di atas ternyata salah — masalah aslinya lebih awal. Modal MT5 menampilkan "✗ Order ditolak: Request executed (retcode 10009)" untuk buy limit XAU/USD, TAPI order-nya tetap benar-benar masuk ke MT5 (ticket #57392448126, screenshot terminal konfirmasi status "placed"). Retcode 10009 = `TRADE_RETCODE_DONE`, yaitu kode SUKSES di MT5 — bukan penolakan. Bug-nya ada di `mt5_bridge.py` (`/order`): logika `ok_retcode` mengharuskan pending order (`TRADE_ACTION_PENDING`) membalas persis `TRADE_RETCODE_PLACED` (10008), padahal broker demo user (`MetaQuotes-Demo`) ternyata membalas `TRADE_RETCODE_DONE` (10009) untuk pending order yang berhasil ditempatkan. Bridge salah-tolak sukses jadi gagal → HTTP 400 ke frontend → `ckMt5OrderConfirm()` throw sebelum sempat memanggil `ckMt5AutoJournal()` sama sekali — jadi bukan soal POST jurnal yang gagal diam-diam, tapi jurnalnya memang tidak pernah dicoba ditulis. Kedua ticket test user (#57392307105 dan #57392448126) kena bug yang sama, keduanya nyangkut di MT5 tanpa jejak jurnal.

**Fix:** `mt5_bridge.py` — ganti pengecekan retcode tunggal (beda per `trade_action`) jadi satu set kode sukses yang diterima untuk kedua jenis order: `TRADE_RETCODE_DONE` (10009), `TRADE_RETCODE_DONE_PARTIAL` (10010), `TRADE_RETCODE_PLACED` (10008) — broker/server MT5 tidak konsisten soal kode mana yang dibalas untuk pending order, jadi diterima semua kode "berhasil" yang dikenal, bukan cuma satu yang diasumsikan sesuai jenis order. Diverifikasi lewat simulasi Python standalone (retcode 10008/10009/10010 diterima, 10004/10006/10015/10018/10019 tetap ditolak sebagaimana mestinya).

**Sisa PR untuk user:** dua pending order test (#57392307105 dan #57392448126) masih nyangkut di akun demo MT5 tanpa jurnal — boleh dibiarkan (akun demo) atau dibatalkan manual dari terminal MT5. Tidak ada cara retroaktif menciptakan entri jurnal untuk keduanya dari sisi app (tidak ada datanya yang tersimpan) — kalau mau tetap dicatat, pakai "+ BARU" manual di JURNAL.

---

### ANALISA XAU/USD: auto-generate per sesi (menyusul migrasi cron market-digest)

**Masalah:** tab ANALISA (teknikal + AI entry/SL/TP per pair) sepenuhnya manual — user harus klik "🧠 AI" tiap kali, dan hasilnya cuma tersimpan di client (localStorage, 8h). User minta perilaku yang sama seperti Ringkasan (auto per sesi Asia/London/NY), tapi dibatasi khusus XAU/USD saja (bukan 8 pair sekaligus).

**Implementasi:**
- `api/admin.js` (`ohlcvAnalyzeHandler`):
  - Hasil analisa yang berhasil sekarang di-cache ke Redis (`ohlcv_analysis:{symbol}`, TTL 6 jam) — sebelumnya cuma dikembalikan ke caller, tidak pernah disimpan server-side.
  - Tambah `mode=cached` — baca-saja dari cache Redis tanpa panggil AI, dipakai frontend untuk auto-load tanpa boros budget AI.
  - Kalau caller tidak kirim `ringkasanContext` (kasus panggilan cron — tidak ada browser buat ekstrak) DAN symbol-nya XAU (`GC=F`), backend sendiri baca `latest_article` dari Redis dan ekstrak bagian `XAUUSD:`-nya — meniru logika ekstraksi yang sebelumnya cuma ada di client (`analyzeOhlcvAi()`), supaya analisa otomatis tetap dapat konteks makro, bukan teknikal-only.
- `.github/workflows/market-digest.yml`: tambah step kedua ("Trigger XAU/USD ANALISA generation") setelah step digest, `if: always()` supaya tetap jalan walau step digest gagal (fallback ke teknikal-only). Jadwal sama persis (3x/hari, sesi Asia/London/NY) — sengaja dirantai SETELAH digest supaya `latest_article` sudah fresh saat analisa XAU dijalankan.
- `index.html`: `loadAnalisa()` — kalau pair yang dibuka XAU/USD (`GC=F`) dan belum ada cache AI di client, otomatis fetch `mode=cached` dan render langsung (`_autoLoadXauAnalysis`) — tidak perlu klik apapun. Pair lain tetap manual-only seperti sebelumnya. Tombol "Analisa AI" manual tetap berfungsi penuh untuk re-generate fresh kapan saja (termasuk untuk XAU).

**Keputusan desain (dikonfirmasi user):** auto-*tampil* langsung begitu tab ANALISA→XAU/USD dibuka (bukan cuma pre-warm cache diam-diam yang masih perlu diklik manual).

**Verifikasi:** `node --check api/admin.js`, parse inline script `index.html`, `python -c "import yaml; yaml.safe_load(...)"` untuk workflow YAML, `npm test` (25/25) — semua lolos. Eksekusi live belum diverifikasi (nunggu jadwal cron berikutnya atau trigger manual via `workflow_dispatch`).

## Changelog Session 141 (2026-07-03) — Bug MT5 Entry Eksekusi di Harga Market, Bukan Harga Pending yang Di-set

**Laporan user:** set XAU/USD buy limit di 4050 lewat Sizing Calculator (harga saat itu 4110), modal konfirmasi MT5 di Checklist sudah menampilkan entry/SL/TP yang benar (4050 dkk, sesuai Sizing Calc), tapi begitu tombol "Konfirmasi Entry" ditekan, order yang benar-benar masuk ke MT5 tereksekusi di harga pasar SEKARANG (4110), bukan di 4050. Terbukti dari 3 entri jurnal XAU/USD (03/07/2026, ticket #57387959126 dkk) dengan RR planned 0.01–0.05:1 — entry price-nya (4090, 4173.89, 4177.39) semuanya nempel ke harga pasar saat masing-masing test dilakukan, bukan level pending yang dimaksud.

**Root cause:** `mt5_bridge.py` adalah script Python lokal yang jalan terus-menerus di background di PC user (lewat `start_bridge_min.vbs` saat startup) dan **sengaja di-gitignore** ("lokal only", commit `426fcc2`) — jadi setiap kali file ini diedit, perubahan itu tidak otomatis ke-deploy seperti frontend/backend Vercel. Dukungan pending order (`entry_price` → BUY/SELL LIMIT) baru ditambahkan ke file ini di session sebelumnya, tapi **proses Python yang sedang berjalan di PC user sudah aktif dari sebelum edit itu dilakukan** — Flask jalan dengan `debug=False` (tanpa auto-reload), jadi proses lama itu terus pakai logika LAMA: field `entry_price` yang dikirim dari modal diabaikan sepenuhnya, order selalu dieksekusi sebagai market order di `tick.ask`/`tick.bid` saat itu juga. Modal di browser sendiri sudah benar (entry field terkunci dari Sizing Calc, terkirim persis ke bridge) — masalahnya murni proses bridge lokal yang basi, bukan bug logika di kode.

**Fix:**
1. `mt5_bridge.py`: tambah `BRIDGE_VERSION = 2`, dikirim balik di response `/health` sebagai `version`.
2. `index.html` (`ckShowMt5ModalAction`): saat modal MT5 dibuka dan order ini butuh pending order (`hasEntry`), cek `version` dari `/health` — kalau tidak ada atau `< MT5_BRIDGE_MIN_PENDING_VERSION` (bridge lama/basi), tombol "Konfirmasi Entry" **di-disable** dan status menampilkan pesan eksplisit: restart `mt5_bridge.py`. Ini mencegah kasus yang sama terulang secara diam-diam di masa depan (mis. setelah update logika bridge berikutnya tapi lupa restart proses).
3. **Tindakan wajib dari user sekarang:** tutup jendela `mt5_bridge.py`/`python.exe` yang sedang berjalan (termasuk yang jalan minimized dari startup), lalu jalankan ulang `start_bridge.bat` supaya proses baru membaca `BRIDGE_VERSION = 2` dan logika pending order yang benar. Karena file ini gitignored, perubahan sudah langsung ada di disk lokal — tidak perlu git pull, cukup restart proses.

**Tambahan — hard-delete jurnal:** sebelumnya `DELETE /api/journal` cuma soft-delete (`status: archived`, tetap ada selamanya di tab ARSIP). Ditambah dukungan `?hard=1` yang benar-benar menghapus key Redis + entri di index — dipakai untuk membuang 3 entri XAU/USD hasil bug di atas yang tidak pantas disimpan sebagai riwayat trade (bukan cuma diarsipkan). Tombol **"Hapus"** (merah, di sebelah Pulihkan) **sengaja dibatasi hanya muncul di entri berstatus ARCHIVED** — Arsip jadi langkah konfirmasi implisit sebelum penghapusan permanen, jadi trade OPEN/CLOSED tidak bisa kehapus dari satu klik salah. Dibatasi di dua tempat: tombol cuma dirender untuk `status === 'archived'` di frontend, DAN backend menolak `?hard=1` (400) kalau entri yang dituju belum berstatus archived — supaya request langsung ke API pun tidak bisa melewati aturan ini. Tetap ada `confirm()` sebelum eksekusi karena permanen.

**Verifikasi:** `node --check api/journal.js`, parse semua inline script `index.html`, `python -c "import ast; ast.parse(...)"` untuk `mt5_bridge.py`, dan `npm test` (25/25) — semua lolos.

**Tindak lanjut user:** setelah deploy, buka JURNAL → klik "Arsip" dulu pada 3 entri XAU/USD yang salah (ticket #57387959126, #57387888853, #57387788359), lalu buka tab ARSIP dan klik "Hapus" untuk membersihkannya secara permanen.

### Migrasi cron market-digest: Vercel cron → GitHub Actions

User bertanya soal mekanisme "ringkasan otomatis per sesi Asia/London/NY". Investigasi menemukan `vercel.json` sebelumnya punya 3 cron sub-harian ke `/api/market-digest` (00:00, 07:00, 12:30 UTC = 07:00/14:00/19:30 WIB), tapi ini sudah lama ditandai `[VERIFY]` di audit sesi 138 (poin 13) — Vercel Hobby plan historisnya tidak menjamin cron sub-harian jalan konsisten, dan belum pernah dicek langsung apakah ketiganya benar-benar dieksekusi di produksi.

**Keputusan:** ganti sepenuhnya ke GitHub Actions, pola yang sama dengan yang sudah dipakai untuk OHLCV sync/TA warm (`ohlcv-sync.yml`, `ta-warm.yml`) — GitHub Actions cron gratis, jauh lebih dapat diandalkan untuk multi-run/hari, dan sudah didukung tanpa perubahan kode (`api/market-digest.js:390-392` sudah menerima auth `x-cron-secret` selain `x-vercel-cron`).

- `vercel.json`: 3 entri cron `market-digest` dihapus (cron `admin?action=gdpnow` tetap ada, tidak terpengaruh).
- `.github/workflows/market-digest.yml` (baru): 3 jadwal identik (`0 0 * * *`, `0 7 * * *`, `30 12 * * *`), tiap run `curl` ke `/api/market-digest` dengan header `x-cron-secret` (secret `CRON_SECRET` yang sama dipakai workflow lain).
- Tidak ada perubahan kode di `api/market-digest.js` — jalur auth cron eksternal sudah ada sejak awal.
- Dipilih **ganti**, bukan **jalan berbarengan**, supaya tidak berisiko generate dobel (AI call 2x + push notif "Ringkasan siap" dobel per sesi) kalau ternyata Vercel cron-nya masih jalan juga.

**Verifikasi:** `node -e "JSON.parse(...)"` untuk `vercel.json`, `python -c "import yaml; yaml.safe_load(...)"` untuk workflow YAML baru — keduanya valid. Eksekusi live workflow baru belum bisa diverifikasi dari sini (perlu tunggu jadwal berikutnya jalan atau trigger manual via `workflow_dispatch` di tab Actions GitHub).

## Changelog Session 140 (2026-07-03) — Hardening Reliability Thesis Alert (Call 4)

Session 139 mewire `thesis_alerts` ke JURNAL/CHECKLIST/SIZING, tapi user menahan fitur ini ("ditunda") karena eksekusi live-nya belum cukup andal. Audit kode menemukan 4 penyebab konkret dan semuanya sudah diperbaiki di `api/market-digest.js` dan `index.html`:

1. **AI schema drift pada `direction`** — Call 4 (AI thesis monitor) diminta menuliskan ulang `pair`/`direction` sebagai teks bebas. Kalau model menulis "buy" alih-alih "long" (atau format pair beda), filter `getThesisAlertsForPair()` di frontend gagal match secara diam-diam dan alert yang valid jadi tidak pernah muncul. **Fix:** `pair`/`direction` sekarang diambil dari data jurnal server-side (ground truth via `entry_id`), bukan dari teks yang ditulis ulang AI — AI hanya perlu mengembalikan `entry_id` + `headline` + `reason`.
2. **Headline bisa dihalusinasi** — tidak ada validasi bahwa `headline` yang dikutip AI benar-benar ada di feed berita. **Fix:** setiap alert sekarang divalidasi verbatim terhadap daftar 30 headline yang dikirim ke model; alert dengan headline yang tidak cocok persis (kemungkinan parafrase/halusinasi) di-drop dan di-log.
3. **`entry_id` bisa mengacu ke thesis yang tidak ada** — ditambahkan validasi `entry_id` terhadap daftar open entries yang sebenarnya dikirim ke model; alert dengan `entry_id` tak dikenal di-drop.
4. **Coupling salah dengan Call 1** — sebelumnya `thesis_alerts` di-null-kan setiap kali Call 1 (prosa briefing, AI call terpisah) gagal/fallback, walau Call 4 sendiri berhasil dan menemukan kontradiksi asli. Ini bikin alert yang valid hilang total setiap kali provider Call 1 down/quota habis. **Fix:** hasil Call 4 sekarang berdiri sendiri, tidak lagi digate oleh status Call 1.
5. **Frontend menimpa alert lama saat regenerate gagal transient** — `ringkasanCache.thesis_alerts` di-overwrite penuh tiap `generateRingkasan()`/`loadCachedRingkasan()`, termasuk saat backend balas `thesis_alerts: null` (Call 4 gagal sesaat) — alert asli yang tadinya tampil jadi hilang tanpa jejak, kesannya "aman" padahal cuma gagal cek. **Fix:** helper `_applyRingkasanData()` cuma menimpa alert lama kalau backend eksplisit balas array (baik `[]` = "sudah dicek, bersih" maupun alert baru) — `null` ("gagal cek") mempertahankan alert lama.
6. Tambahan: Call 4 di-skip kalau `recentItems.length === 0` (tidak ada berita sama sekali) — sebelumnya tetap manggil AI dengan konteks kosong, buang kuota tanpa hasil berguna.

**Batasan by-design (bukan bug):** alert hanya muncul untuk pair+direction yang sudah punya entri jurnal `status:'open'` dengan `thesis_text` terisi (termasuk pending limit order yang sudah dijurnal via modal MT5) — bukan untuk pair yang benar-benar belum pernah disentuh sama sekali. Ini konsisten dengan skenario yang diminta: alert relevan saat user *revisit* CHECKLIST/SIZING untuk setup yang sudah dijurnal (mis. limit order masih resting), bukan pada pair kosong tanpa histori apapun.

**Verifikasi:**
- `node --check api/market-digest.js` — lolos.
- Seluruh inline script `index.html` lolos parse (`new Function()` per blok `<script>`).
- Logika validasi Call 4 (drift direction, headline halusinasi, entry_id tak dikenal, kasus valid) diuji manual via skrip Node standalone — 4/4 skenario berperilaku sesuai ekspektasi.
- Logika merge frontend (`_applyRingkasanData`) diuji manual — alert asli bertahan saat backend balas `null`, dan ter-clear saat backend balas `[]`.
- `npm test` — 25/25 pass, tidak ada regresi di test suite existing.

**Status:** fitur ini sekarang dianggap cukup andal untuk dipakai sebagai alur utama — catatan "ditunda" di `daun_merah_plan.md` dihapus.

## Changelog Session 139 (2026-07-03) — Alert Headline Kontra Buy/Sell Limit

- `thesis_alerts` dari `market-digest` sekarang juga tampil di JURNAL, CHECKLIST, dan SIZING saat pair yang dipilih punya headline kontra.
- Prefill JURNAL dari CHECKLIST dan auto-journal MT5 ikut menyertakan blok alert buy/sell limit supaya alasan entry lebih eksplisit.
- Entry price dari SIZING ikut dipropagasi ke modal MT5 dan disimpan ke jurnal, jadi eksekusi pending order dan catatan trade memakai harga yang sama.
- Copy alert diubah dari kontradiksi umum menjadi bahasa yang langsung menyebut headline kontra buy/sell limit.
- Verifikasi: seluruh inline script di `index.html` lolos parse setelah perubahan.

## Ringkasan Proyek

Daun Merah adalah forex news PWA (Progressive Web App) untuk trader forex Indonesia bergaya macro discretionary. Sebelumnya bernama FJFeed. Di-deploy di Vercel, single-file frontend (`index.html`) + Vercel Serverless Functions di folder `api/`.

**Deployment target:** Vercel Hobby plan (max 12 serverless functions) + Upstash Redis REST API

---

## Stack Teknis

| Layer | Teknologi |
|-------|-----------|
| Frontend | Vanilla JS + HTML/CSS, single file `index.html` (~4200+ baris) |
| Backend | Vercel Serverless Functions (Node.js, CommonJS `module.exports`) |
| AI | **Multi-provider dual-account strategy:** Call 1 prose: SambaNova `DeepSeek-V3.2` (akun 2, primary), OpenRouter `gpt-oss-120b:free` (fallback 2), Groq `qwen3-32b` (fallback 3); Call 2–3 bias+thesis: SambaNova `DeepSeek-V3.2` (akun 1, upgrade dari V3.1); Call 4–6: Groq `llama-3.3-70b-versatile` |
| Cache/DB | Upstash Redis REST API |
| Git remote (GitHub) | `https://github.com/sam01149/Daun_Merah_Terminal.git` — **repo dipindah dari `sam01149/Financial_Feed_App` (2026-06-23)**. Push masih jalan ke URL lama via GitHub redirect, tapi `origin` lokal sudah di-update ke URL baru biar nggak bergantung redirect terus-menerus. |
| RSS sumber berita (NEWS) | FinancialJuice (`https://www.financialjuice.com/feed.ashx?xy=rss`) — satu-satunya sumber untuk AI digest & tab NEWS |
| Sumber tab ARTIKEL | FED, FOMC, FEDN, ECB, ECBB, BIS, **RBA, BOC, BOE** (CB primary), **Marc to Market (MTM), ING Think (ING)** (macro research). BOJ dihapus sesi 120 (RSS URL sudah tidak ada). |
| Option expiries (tab TEK) | Investinglive `/feed/forexorders/` via rss2json — difilter per-pair, 4h cache |
| ActionForex (tab TEK Berita) | Per-pair technical outlook feed, 6 pair major (tidak ada NZD/XAU), 4h cache |
| Retail Sentiment (tab COT) | ForexBenchmark scrape — contrarian indicator, 2h cache, signal di ≥65% satu arah |
| Kalender ekonomi | TradingView `economic-calendar.tradingview.com` (primer, ada `actual` asli) + ForexFactory XML (`nfs.faireconomy.media`, fallback) |
| COT data | CFTC website scraping (`cftc.gov`) |
| Font | Syne (heading), DM Mono (body) |
| Icon | `icon.svg` — dual-leaf loop design (bear merah + bull teal) |
| PWA | `manifest.json` → `icon.svg`, `sw.js` — Service Worker push |

**Env vars yang dibutuhkan (di Vercel):**
- `GROQ_API_KEY`
- `OPENROUTER_API_KEY`
- `SAMBANOVA_API_KEY` — Call 2 & 3 (CB bias + thesis, akun 1)
- `SAMBANOVA_API_KEY_CALL1` — Call 1 prose (akun 2, opsional; jika tidak ada, langsung pakai OpenRouter)
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `FRED_API_KEY`
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (opsional)
- `CRON_SECRET` (auth header untuk cron + admin endpoints)

---

## Struktur File (Current)

```
Financial_Feed_App/
├── index.html              # Seluruh UI + JS frontend (~3500+ baris)
├── mt5_bridge.py           # Local Python bridge → MT5 via MetaTrader5 library (jalankan di PC)
├── start_bridge.bat        # Klik dua kali untuk jalankan bridge manual
├── start_bridge_min.vbs    # Wrapper jalankan .bat dalam kondisi minimized (dipakai shortcut startup)
├── manifest.json           # PWA manifest — icon: icon.svg
├── sw.js                   # Service Worker — push notif, icon.svg
├── icon.svg                # App icon — dual-leaf loop, viewBox="0 20 680 680"
├── vercel.json             # Security headers config
├── package.json            # name: "daun-merah", deps: web-push
├── scripts/                  # BTC data collection + feature engineering (Node, via GitHub Actions)
│   ├── btc-backfill.js       # One-off: full historical backfill semua sumber BTC
│   ├── btc-sync.js           # Incremental: append data baru saja, idempotent, jalan hourly
│   ├── feature-engineering.js # Gabung 7 dataset jadi feature matrix per timeframe (4h, 1d)
│   └── lib/
│       ├── btc-data.js       # CSV read/write/append/read helpers, fetchJson + fetchJsonPatient (429 backoff)
│       ├── btc-sources.js    # OHLCV (data-api.binance.vision) + Fear&Greed (alternative.me)
│       ├── cot-bitcoin.js    # CME Bitcoin futures COT (cftc.gov) — download via curl (lihat catatan)
│       ├── extra-sources.js  # BTC dominance, stablecoin supply (CoinGecko), hashrate (mempool.space)
│       └── indicators.js     # SMA/EMA/RSI/MACD/ATR/Bollinger %B/z-score — implementasi sendiri, tanpa dep
├── data/btc/                # Dataset historis BTC (CSV), auto-update via GitHub Actions
│   ├── ohlcv_1h.csv          # ~77k baris, sejak 2017-08-17
│   ├── ohlcv_4h.csv          # ~19k baris, sejak 2017-08-17
│   ├── ohlcv_1d.csv          # ~3.2k baris, sejak 2017-08-17
│   ├── cot_bitcoin.csv       # ~430 baris mingguan, sejak 2018-04 (open interest + positioning CME)
│   ├── fear_greed.csv        # ~3k baris harian, sejak 2018-02
│   ├── hashrate.csv          # ~6.4k baris harian, sejak 2009 (mempool.space, tanpa batasan)
│   ├── stablecoin_supply.csv # 365 baris harian (USDT+USDC market cap) — CoinGecko free tier batasi histori max 365 hari
│   ├── btc_dominance.csv     # 1 baris/hari mulai sekarang — tidak ada histori gratis (CoinGecko Pro-only), akumulasi ke depan
│   ├── features_4h.csv       # Feature matrix siap-training (Node), granularitas 4h (~19.3k baris, 31 kolom, + indikator teknikal)
│   ├── features_1d.csv       # Feature matrix siap-training (Node), granularitas 1d (~3.2k baris, 31 kolom, + indikator teknikal)
│   ├── clean_4h.csv          # Versi pandas (ml/preprocess.py) — kolom raw terpilih per sumber, tanpa indikator, 21 kolom
│   └── clean_1d.csv          # idem, granularitas 1d — divalidasi cocok 1:1 dengan features_1d.csv di kolom yang sama
├── ml/                      # Modeling BTC (Python, .venv lokal — pandas/scikit-learn/torch)
│   ├── preprocess.py        # Cleaning + integrasi transparan: pilih kolom per CSV mentah, merge_asof, -> clean_4h/1d.csv
│   ├── train_models.py      # Klasifikasi: 5 algoritma + 2 baseline, chronological split
│   ├── cross_validation.py  # Walk-forward CV (4 fold) — validasi robustness hasil train_models.py
│   ├── train_regression.py  # Regresi: prediksi besaran return (target_ret_6/18)
│   ├── requirements.txt     # pandas, scikit-learn, torch (CPU)
│   └── results/
│       ├── REPORT.md                  # Laporan lengkap 3 eksperimen + kesimpulan jujur final
│       ├── model_comparison.json      # Raw metrics klasifikasi single-split
│       ├── cross_validation.json      # Raw metrics walk-forward CV
│       └── regression_comparison.json # Raw metrics regresi
├── test/                   # Unit test (node:test) — `npm test`, tanpa network/Redis
│   ├── fundamental_parser.test.js # parseFundamentalFromHeadline + parseCBDecision
│   └── guards.test.js             # _ai_guard, _ratelimit, _circuit_breaker (fail-open)
└── api/                    # TEPAT 12 serverless functions (Vercel Hobby limit)
    ├── _ai_guard.js        # Guard kuota harian per provider AI (Redis counter) — sesi 137
    ├── _circuit_breaker.js # Self-healing: Redis-backed circuit breaker (CLOSED→OPEN→HALF_OPEN)
    ├── _push_keywords.js   # Keyword lists untuk detectPushCat() — edit di sini untuk update kategori
    ├── _ratelimit.js       # Shared rate limiter helper — prefix _ = bukan route publik
    ├── _retry.js           # Exponential backoff fetch wrapper — prefix _ = bukan route publik
    ├── admin.js            # Consolidated: health + redis-keys + admin-prompts + push
    ├── calendar.js         # ForexFactory calendar
    ├── cb-status.js        # CB tracker + bias dari Redis
    ├── correlations.js     # Cross-asset correlation (Yahoo Finance), rate limited 5/min
    ├── feeds.js            # Consolidated: RSS proxy + COT scraper
    ├── journal.js          # Trade journal CRUD
    ├── market-digest.js    # AI briefing (3 Groq calls), rate limited 4/min
    ├── rate-path.js        # SOFR heuristic rate path
    ├── real-yields.js      # Real yield differential
    ├── risk-regime.js      # VIX/MOVE/HY regime classifier
    ├── sizing-history.js   # Position sizing history per device
    ├── subscribe.js        # Push subscription management
    └── _webpush.js         # Shared web-push sender (VAPID config + sendNotification) — dipakai admin.js & market-digest.js
```

> **Penting:** `api/feeds.js` menggantikan `api/rss.js` dan `api/cot.js` yang sudah dihapus.
> `api/admin.js` menggantikan `api/health.js`, `api/redis-keys.js`, `api/admin-prompts.js`, dan `api/push.js`.
> Konsolidasi ini dilakukan untuk tetap di bawah limit 12 serverless functions Vercel Hobby.

---

## Konvensi & Referensi Teknis

### Konvensi Animasi & UX

Prinsip psikologi untuk animasi baru — jangan gunakan `ease` polos:

- **Reveal (datang)**: `ease-out` atau `cubic-bezier(0.16, 1, 0.3, 1)` — cepat awal, lambat landing. Durasi ~350–450ms.
- **Dismiss (pergi)**: `ease-in` — mulai pelan, keluar cepat. Durasi ~180–220ms.
- **Drawer/panel buka-tutup**: easing asimetris — buka pakai ease-out (di `.open` class), tutup pakai ease-in (di base class).
- **Modal**: entrance animation `scale(0.95) translateY(14px) → scale(1) translateY(0)` pada inner box; restart otomatis tiap `display:none → display:flex`.

### Status CB Research Feeds

File: `api/feeds.js` → `CB_RESEARCH_SOURCES` (diaudit sesi 120)

| Key | Status | Catatan |
|-----|--------|---------|
| FED, FOMC, FEDN | ✅ | Direct, stabil |
| ECB, ECBB | ✅ | Direct, stabil |
| BIS | ✅ | Direct (RSS 1.0/RDF) — jangan pakai rss2json |
| BOC | ✅ | Direct ke `/feed/` — bukan `/feed/speeches/` (URL mati) |
| BOE, BOEP | ✅ | Direct, ditambahkan sesi 120 |
| MTM, ING | ✅ | Direct, stabil |
| RBA, RBAM, RBAS | ⚠️ | Via rss2json — RBA blokir Vercel IP; rss2json kadang 500 |
| BOJ | ❌ | Dihapus — RSS hilang setelah redesign 2024 |
| RBNZ, SNB | ❌ | 403 semua jalur |

Parser `parseCBRSSItems`: regex `<(?:item|entry)\b[^>]*>` — support RSS 2.0, Atom, dan RDF/RSS 1.0.

---

## Changelog Session 138 (2026-07-03) — Audit Menyeluruh Semua Fitur + Eksekusi Fix & Wiring

Audit read-through 100% kode (20 file `api/`, `index.html` 12.464 baris, `sw.js`, `mt5_bridge.py`, `vercel.json`, 5 GitHub workflows). Setelah konfirmasi user: **semua temuan HIGH+MED (1–8) DIFIX di sesi ini**, plus 3 wiring data belum terpakai + 1 fitur baru (korelasi per-pair TEK, request user). Temuan LOW (9–13) belum dikerjakan kecuali #9 (APP_VERSION di-bump ke `2026.07.03` karena sesi ini memang mengubah fungsionalitas).

### Eksekusi sesi ini (ringkas)

- **Fix #1–#8** (detail di daftar temuan di bawah, semua ✅): pip XAU disamakan 0.01 + cache key `atr_v2:*` (`api/correlations.js`); `escHtml` judul NEWS + nama event strip TEK; `CB_BIAS_LEVEL` kanonik 6-level (Hawkish 6 → Dovish 2, DD/OnHold/Split = 4) dipakai SEMUA call site — `_ckAutoSMC` bull ≥5/bear ≤3, `_ckAutoMacro`, rc5, simulasi kalender, prefill Jurnal/MT5 (dua map `BLVL` lokal dihapus); `sw.js` `detectCat` disinkronkan (early-check calendar-format + keyword sesi 135); simulasi kalender: match pair selector via normalisasi slash + cross dibatasi pair konvensional di `SZ_PAIRS` dengan orientasi benar (EUR/GBP, bukan GBP/EUR — arah ikut dibalik); `journal.js` `pairCurrencies` split `/`; VaR Sizing diganti `1.645 × σ × notional` (formula sama dengan Jurnal, label "posisi X lot"); health cache-clear pindah dari DOWN → RECOVERY.
- **Wire forecast/previous → digest:** `market-digest.js` `parseFFXML` sekarang membawa `forecast`/`previous`; `calBlock` menambah tag `[F: x | P: y]` + catatan cara pakainya di prompt (dipakai Call 1 & Call 3).
- **Wire COT trend + konfluensi retail:** badge `4W ▲/▼` di baris Leveraged Funds tab COT (dari `cot_history` yang selama ini cuma dipakai chart TREN; threshold noise 2K kontrak); badge konfluensi otomatis di baris Retail Sentiment (`cotAlignmentNote` retail-kontrarian × flow lev-funds — dulu user disuruh eyeball); **rc3 checklist dibuat jujur**: arah bias diinfer dari selisih level CB → dinilai `cotAlignmentNote` → selaras = auto-tick, kontra = auto-block (bisa override + alasan), tak bisa dinilai = manual + evidence dots (dulu auto-tick hanya karena data ada — otoritas palsu di gate).
- **Wire option expiry → AI Analisa:** `admin.js` `ohlcv_analyze` membaca `fx_options_cache` (≤24h), helper pure `_pickExpiryLevels()` (max 6 level pair itu, urut terdekat ke harga; diekspor untuk test) → blok "OPTION EXPIRIES NY CUT HARI INI" di prompt dengan framing magnet/S-R harian, bukan sinyal arah.
- **Fitur baru — korelasi per-pair di TEK (request user):** `_buildPairCorrHtml()`/`_tekCorrLegs()` — panel korelasi TEK sekarang kontekstual ke pair aktif: tiap leg jadi kolom (USD→DXY, XAU→Gold, JPY/CAD/CHF pakai seri inverted server), baris = DXY/US10Y/RealYield/SPX/VIX/WTI/Copper/Gold/BTC + baris "leg × leg", nilai r20 + Δ kuning saat menyimpang >0.3 dari norma 60d, caption eksplisit "korelasi KEKUATAN mata uang, bukan arah pair". XAUUSD tetap pakai tabel gold khusus; `selectTekPair()` me-re-render. Berlaku untuk semua 29 pair + US10Y.
- **Test:** `package.json` test di-scope `test/*.test.js` (dulu `node --test` polos ikut menjalankan `scripts/test-deribit.js` yang butuh network → suite selalu merah); +2 test `_pickExpiryLevels` di `guards.test.js` → **25/25 pass**. Harness Node tambahan (extraction): parseFFXML F/P (5 assert), sw.js detectCat (5), journal pairCurrencies (3), korelasi per-pair + regression baris netral (13), simulasi kalender orientasi/normalisasi/skala cautious (4). Full-parse semua `<script>` index.html OK; `node --check` pass semua file api yang disentuh. Bug ditemukan harness saat pengembangan: baris aset ber-korelasi netral valid ikut ke-skip sebagai "no data" (marker `corr-neu` ambigu) — difix pakai marker `EMPTY_CELL` eksplisit + regression test.

File yang disentuh: `index.html`, `sw.js`, `api/admin.js`, `api/correlations.js`, `api/journal.js`, `api/market-digest.js`, `package.json`, `test/guards.test.js`.

### Temuan bug (status setelah eksekusi — prioritas turun ke bawah)

1. ✅ FIXED — **[HIGH] XAU/USD pip-unit mismatch Sizing vs ATR.** `api/correlations.js` `action=atr` pakai `PIP_SIZE_MAP['XAU/USD'] = 0.1`, sedangkan frontend sizing (`calcSizing`/`szAutoComputePips`) pakai `0.01`. Akibat: peringatan "SL < ATR (noise)" dan angka "1d VaR" di hasil sizing salah 10× KHUSUS gold — SL gold yang sebenarnya lebih sempit dari ATR tidak pernah diperingatkan. Fix: samakan pip size (pilih satu konvensi) atau bandingkan dalam harga absolut, bukan pip.
2. ✅ FIXED — **[HIGH] XSS gap satu-satunya yang tersisa: judul berita di tab NEWS.** `renderFeed()` menyisipkan `${item.title}` TANPA `escHtml` ke innerHTML (baris ~3956). Semua render lain (dashboard, TEK, riset, kalender) sudah escape. Title datang dari RSS pihak ketiga (FinancialJuice + fallback Investinglive) — markup di judul akan tereksekusi. Fix 1 baris.
3. ✅ FIXED — **[MED] `CB_BIAS_LEVEL` frontend tidak kenal label bias yang sebenarnya dipakai.** Map cuma punya `very hawkish/hawkish/neutral/dovish/very dovish`, padahal vocabulary AI = `Hawkish/Cautious Hawkish/Neutral/Data Dependent/On Hold/Cautious Dovish/Dovish/Split`. Akibat: `Cautious Hawkish`/`Cautious Dovish` jatuh ke default 2 (netral) di (a) auto-tick checklist `_ckAutoSMC` (f1/f2/f3 tidak pernah nyala untuk bias cautious), (b) `_ckAutoMacro` (mm_cb1/mm_cb2), (c) rc5 alignment, (d) simulasi kalender `scenarioRankCurrencies`. Sementara `ckPrefillJurnal`/`ckShowMt5ModalAction` pakai map `BLVL` 6-level yang benar — tiga skala berbeda untuk konsep yang sama. Fix: satu map kanonik dipakai semua call site.
4. ✅ FIXED — **[MED] `sw.js` `detectCat` = salinan ketiga yang basi.** Masih punya `'flash'`,`'alert'` di market-moving, `'pmi'` di indexes, bare `'gdp'` di macro — fix Session 135 tidak diterapkan ke sini. Label kategori notifikasi background (periodicsync path) salah untuk rilis data.
5. ✅ FIXED — **[MED] Simulasi kalender → tombol "Buka CHECKLIST" tidak pernah memilih pair.** `scenarioRenderResults` mencocokkan `o.value.includes('EURUSD')` padahal value option ber-slash (`EUR/USD`) — selalu false, pair selector diam-diam tidak terisi (kelas bug yang sama dengan insiden "Lihat Gambar"). Juga `scenarioRankCurrencies` bisa menghasilkan pair non-konvensi (mis. `GBP/EUR`, `NZD/EUR`) yang tidak ada di SZ_PAIRS.
6. ✅ FIXED — **[MED] `api/journal.js` analyze: quote currency hilang dari prompt AI.** `e.pair.slice(3, 6)` pada pair ber-slash menghasilkan `"/US"` — CB bias quote currency tidak pernah masuk ringkasan trade untuk AI coach. Fix: split by `/`.
7. ✅ FIXED — **[MED] Formula VaR di hasil Sizing mencurigakan (double-count).** `1.645 × daily_sigma × (dollarRisk/stopPips) × atr_pips` mengalikan sigma DAN ATR (dua ukuran volatilitas). Versi jurnal (`jnRenderVaR`: `1.645 × sigma × notional`) sudah benar — samakan.
8. ✅ FIXED — **[MED] Health auto-clear cache justru menghapus jaring pengaman stale-serve.** Saat source DOWN, `admin?action=health` DELETE cache key source itu (mis. `cot_cache_v2`) — padahal handler-nya memakai cache stale sebagai fallback saat upstream mati. Selama outage panjang user malah dapat 502, bukan data lama. Rekomendasi: clear hanya saat RECOVERY, bukan saat DOWN.
9. ✅ FIXED — **[LOW] `APP_VERSION`** di-bump ke 2026.07.03 sesi ini; catatan asli: — masih `2026.06.29` padahal sesi 135–137 mengubah fungsionalitas; stempel anti-versi-lama-PWA kehilangan fungsinya.
10. **[LOW] `mt5_bridge.py` CORS terbuka untuk semua origin tanpa auth** — halaman web mana pun yang terbuka di browser PC yang sama bisa POST order ke `localhost:5000/order`. Rekomendasi: batasi origin ke domain app + shared token.
11. **[LOW] Dashboard `BIAS_COLORS` keys tidak cocok dengan vocabulary bias** (punya `very hawkish/very dovish` yang tidak ada; `Cautious */On Hold/Data Dependent/Split` tidak ada) → mayoritas pill bias tampil abu-abu, glanceability hilang.
12. **[LOW] Kosmetik/konsistensi:** `toggleVoice` menimpa ikon SVG via `textContent`; label tombol Polymarket & Korelasi berubah setelah fetch pertama ("Refresh…" → "Muat…"); `KEY_REGISTRY` redis-keys ketinggalan banyak key baru (news_history, cot_history, ohlcv:*, ta:*, ai_budget:*, fx_options_cache, dll); health probe belum meng-cover Yahoo Finance (dependensi terbesar: OHLCV/TA/VIX/MOVE/spot/rates); `market-digest?mode=cached` tanpa rate limit; retry `fetchFeed` tiap 8s tanpa batas saat source down; keyword `'snb jordan'` usang.
13. ✅ FIXED (session 141) — **`vercel.json` punya 4 cron (3× market-digest sub-harian)** — limit Vercel Hobby historisnya 2 cron/harian, keandalan sub-harian tidak terjamin. Dipindah ke GitHub Actions (`.github/workflows/market-digest.yml`), pola sama dengan OHLCV sync — lihat Changelog Session 141.

### Audit desain / psikologi trader — kesimpulan

- **Kuat (dipertahankan):** friction anti-FOMO berlapis (override wajib alasan kalimat nyata + blocklist kata pengisi, speed-flag typed ack yang tercatat permanen di jurnal, reset cooldown 60s, lot/SL/TP MT5 dikunci ke Sizing Calc, blokir risk >5%), anti-noise (tanpa floating P&L di posisi open — by design, quiet hours push 23:00–06:00 WIB, default push minimal, XAU history gate ≥3 headline), kejujuran data (badge umur candle/stale, provider log saat fallback, persentil 10 tahun di regime, disclaimer di semua output AI), alur SOP CAL→RINGKASAN→NEWS untuk pemula + onboarding sekali.
- **Celah psikologi:** auto-tick `rc3` ("COT aligned dengan bias") menyala hanya karena DATA ADA, bukan karena benar-benar selaras — memberi otoritas palsu di gate; verdict `ENTRY` (≥90%) terbaca sebagai perintah (pertimbangkan "SETUP KUAT"); tooltip-only warnings (divergence, evidence dots) tidak terakses di mobile.

### Kandidat data belum terpakai (keputusan user 2026-07-03: #1, #3, #4 ✅ diwire sesi ini + fitur korelasi per-pair; #2 Polymarket & #5 yield differential TIDAK dipilih — belum dikerjakan)

1. **Forecast/Previous kalender → prompt digest Call 1/3** — parseFFXML di market-digest.js membuang field forecast/previous padahal instruksi prompt menuntut skenario beat/miss; nol fetch baru.
2. **Polymarket probabilities → prompt digest** — sudah difetch & tampil di UI, belum pernah masuk konteks AI; odds real-money Fed/CPI adalah anchor objektif pelengkap rate path.
3. **COT trend mingguan (`cot_history`) + konfluensi retail sentiment** — UI menyuruh user meng-eyeball konfluensi COT×retail, tapi tidak pernah dihitung; bisa memperbaiki auto-tick rc3 sekalian (fix temuan #bug di atas).
4. **Option expiry gravity levels → `ohlcv_analyze`** — level magnet NY cut sudah diparse untuk TEK, relevan untuk entry/TP AI tapi tidak dikirim.
5. **Yield differential 10Y antar negara (US/DE/JP/GB sudah difetch di daily-snapshot)** — differential per pair (driver klasik FX) tidak pernah dihitung/ditampilkan.

---

## Changelog Session 137 (2026-07-02) — Audit & Hardening 22 Layer



Audit menyeluruh terhadap 22 layer aplikasi (frontend → onboarding) berdasarkan daftar layer terdokumentasi, lalu perbaikan langsung untuk semua gap yang actionable. Hasil audit: beberapa klaim daftar layer sudah usang (rate limiter, circuit breaker, RSS fallback chain ternyata SUDAH ada), tapi ditemukan gap nyata di auth, validasi input, kuota AI, testing, legal, dan a11y — semua diperbaiki di sesi ini.

### L10 Security — auth fail-open ditutup, rate limit menyeluruh, validasi input

- **`api/admin.js` — 6 gate auth fail-open diperbaiki.** Pola lama `if (CRON_SECRET && header !== CRON_SECRET)` berarti: kalau env `CRON_SECRET` tidak diset, SEMUA orang bisa akses health/redis-keys/admin-prompts/push/fundamental_seed/journal_import. Sekarang fail-closed: `if (!CRON_SECRET || header !== CRON_SECRET)` → tanpa env, endpoint menolak semua request.
- **Rate limit per-IP sekarang di 12/12 endpoint** (sebelumnya hanya `correlations` + `market-digest`): `feeds` (30/m per type), `calendar` (20/m), `cb-status` (20/m), `journal` (30/m), `sizing-history` (30/m), `subscribe` (10/m), `real-yields`/`risk-regime`/`rate-path` (15/m), aksi publik `admin` via `PUBLIC_ACTION_LIMITS` (aksi AI `fundamental_analysis`/`ohlcv_analyze` 5/m; cache read 30/m; `gdpnow`/`fundamental_refresh` 10/m). Cron traffic (header `x-vercel-cron` atau secret valid) selalu exempt.
- **Validasi input endpoint tulis:**
  - `subscribe.js`: `validSubscription()` — endpoint wajib https + max 1024 char, keys `p256dh`/`auth` wajib ada dengan cap panjang; field di-rebuild eksplisit (bukan spread `...subscription` — mencegah payload sampah membengkakkan hash `push_subs`); categories difilter whitelist `VALID_CATEGORIES` (sinkron dengan `detectPushCat()` admin.js).
  - `sizing-history.js` + `journal.js`: `device_id` wajib match `^[A-Za-z0-9_-]{1,64}$` (dipakai langsung sebagai Redis key), body cap (2KB sizing / 32KB journal), `direction` enum long/short, `status` enum open/closed/archived, string panjang di-clamp (`thesis_text` 8000, `pair` 16, dst).

### L11 Error Handling — circuit breaker untuk sumber scraping di feeds.js

- `feeds.js` sebelumnya satu-satunya konsumen scraping TANPA circuit breaker — sumber down = tiap cache-miss bayar timeout 12–20s. Sekarang 4 sumber utama pakai `_circuit_breaker.js` yang sama dengan AI/health: `fj` (FinancialJuice RSS — saat OPEN langsung ke fallback Investinglive), `cftc` (COT), `forexbenchmark` (retail), `actionforex` (aftek). Failure `CIRCUIT_OPEN` tidak dihitung sebagai failure baru (tidak double-penalize).
- `KNOWN_CIRCUITS` di admin.js ditambah `forexbenchmark` + `actionforex` → muncul di `circuit-status`.

### L12 Data Quality — validasi skema kalender TradingView

- `calendar.js` `fetchTradingViewEvents()`: filter event tanpa `title` atau `date` invalid sebelum masuk cache/UI (sebelumnya bisa render baris "undefined"). Validasi lain sudah ada dari sesi lalu: COT 8-currency parse check, retail 0-100% bounds + 0-pair warning, RSS `<rss` check, `QUANTITY_INDICATORS` reject `%`.

### L13 Cost Management — guard kuota harian AI (`api/_ai_guard.js` BARU)

- Helper baru `allowAiCall(provider)`: counter Redis `ai_budget:{provider}:{YYYY-MM-DD}` (INCR + TTL 48h), limit harian default groq 500 / sambanova 200 / openrouter 150 / cerebras 200, override via env `AI_DAILY_LIMIT_{PROVIDER}`. Fail-open kalau Redis down.
- Wired ke SEMUA call site AI: `market-digest.js` `aiCall()` (choke point Call 1–6; budget habis → throw 429 → jatuh ke provider berikutnya via jalur fallback existing), `journal.js` `aiCall()`, `admin.js` `fundamental_analysis` (Groq + SambaNova) dan `ohlcv_analyze` (SambaNova + Groq).
- Observability: response `admin?action=health` sekarang menyertakan `ai_budget: { groq: {used, limit}, ... }`.
- Mencegah: loop bug / abuse endpoint publik menghabiskan kuota free-tier SEMUA provider serentak (sebelumnya tidak ada guard runtime sama sekali — riset rate limit hanya manual).

### L14 Testing — test suite pertama (`test/`, `npm test`)

- `test/fundamental_parser.test.js` (17 test): format FJ standar, NFP % rejection, Core PCE YoY/MoM disambiguation, calendar-format fallback (kata sisipan Core/Flash), CB decision cut/hike/hold + bps sign.
- `test/guards.test.js` (7 test): `providerFromUrl`, fail-open `_ai_guard`/`_ratelimit`/`_circuit_breaker` tanpa Redis env, whitelist IP internal.
- `package.json`: script `"test": "node --test"`. Semua 24 test pass, tanpa network/Redis.
- **Bug asli ditemukan test:** `parseCBDecision` regex `\bcut\b`/`\bhold\b`/`\bhike\b` tidak match bentuk present-tense **"Fed cuts" / "BoJ holds" / "SNB hikes"** — bentuk headline paling umum — jadi mayoritas keputusan CB real tidak pernah terdeteksi. Juga `\bincreas\b` dead pattern (tidak pernah match karena `\b` sebelum huruf). Fix: `\bcuts?\b`, `\bholds?\b`, `\bhikes?\b`, `\bincreas` (prefix). Regression test ditambah.

### L15 Editorial + L17 Legal — disclaimer

- Seksi **"Disclaimer & Risiko"** lengkap di tab PETUNJUK (`#ptDisclaimer`): bukan nasihat keuangan, output AI bisa hallucinate, data pihak ketiga bisa delay/salah, risiko leverage, bukan produk terdaftar OJK/Bappebti.
- Disclaimer singkat `.ai-disclaimer` persis di bawah output AI: panel RINGKASAN + panel ANALISA (level SL/TP AI).
- Disclaimer juga tampil di modal onboarding first-run (lihat L22).

### L16 Accessibility

- Viewport: `maximum-scale=1.0, user-scalable=no` DIHAPUS (WCAG 1.4.4 — pinch zoom sekarang aktif). Kompensasi: `touch-action: manipulation` di elemen interaktif → double-tap zoom tetap mati, jadi UX tap cepat tidak berubah.
- Nav utama: `role=tablist`/`role=tab` + `aria-selected` (di-sync di click handler), `aria-label` untuk tombol icon-only (`navMoreBtn`, `voiceSettingsBtn`).
- Toast: `role=status aria-live=polite` — headline baru dibacakan screen reader.
- `:focus-visible` outline global (2px accent) untuk keyboard nav — sebelumnya nol indikator fokus.

### L22 Onboarding — first-run overlay

- `#onboardOverlay` (role=dialog, aria-modal): muncul SEKALI untuk user baru (flag `dm_onboard_v1` di localStorage). Isi: 3 langkah mulai (CAL → RINGKASAN → NEWS, konsisten dengan seksi "Mulai dari Sini" PETUNJUK) + disclaimer singkat + tombol "Buka Panduan" (switchView ke PETUNJUK) / "Mulai".
- User lama tidak diganggu: kalau localStorage sudah punya jejak pemakaian (`daun_merah_device_id`/`daun_merah_thesis`/`daun_merah_sz_form`/`ringkasan_cooldown_end`), flag langsung diset tanpa menampilkan modal. Escape = dismiss; fokus otomatis ke tombol utama.

### L18–L21 — keputusan terdokumentasi (tidak butuh kode)

- **L18 Versioning/Rollback:** deploy = push ke `main` (Vercel auto). Rollback tercepat: Vercel Dashboard → Deployments → promote deployment sebelumnya (instan, tanpa git). Alternatif: `git revert <sha> && git push`. Staging tersedia gratis via Vercel Preview: push branch non-main → preview URL unik (belum dipakai sebagai kebiasaan; env vars sama dengan production, hati-hati cron/Redis shared).
- **L19 Dependency:** `npm audit` = 0 vulnerabilities (satu-satunya dep runtime: `web-push`; lockfile committed). Kebijakan: jalankan `npm audit` tiap nambah dependency; jangan menambah dep untuk hal yang bisa ditulis <100 baris.
- **L20 i18n:** single-language Bahasa Indonesia BY DESIGN — target user trader Indonesia; teks tersebar inline di HTML/prompt AI. Menambah bahasa = rewrite besar, tidak ada rencana. Keputusan final, bukan gap.
- **L21 State Management frontend:** pola resmi = module-scope `let` per fitur (mis. `ringkasanCache`, `calData`, `seenGuids`) + localStorage untuk persist antar sesi dengan prefix `daun_merah_*` (device_id, thesis, sz_form, rates) + key legacy tanpa prefix (`ringkasan_cooldown_end`, `dm_onboard_v1`). Tidak ada framework/store terpusat — by design untuk single-file vanilla JS; konvensi: state baru wajib module-scope + render function sendiri, jangan global window kecuali dipanggil dari onclick inline.

### Audit L1–L9 — koreksi dokumentasi vs realita

- Daftar "22 layer" yang jadi acuan audit ternyata usang di beberapa poin: `_ratelimit.js`, `_circuit_breaker.js`, `_retry.js`, `_fetch_lock.js` sudah lama ada (L10/L11 tidak sepenuhnya kosong); RSS backup chain (Investinglive fallback) sudah diimplementasi; frontend sudah 12.332 baris (bukan ~4200); 12/12 slot function Vercel Hobby SUDAH PENUH — endpoint baru = harus konsolidasi ke endpoint existing (pola `?action=`/`?type=`).
- **Yang masih jadi gap sadar (belum dikerjakan, by choice):** logging terpusat/alerting eksternal masih terbatas (Telegram health alert saja); tidak ada E2E test UI; secret rotation manual; CORS `*` di semua endpoint (data publik + journal keyed device_id random — risiko rendah, diterima).

---

## Changelog Session 136 (2026-07-01)

### Feat: Wire up econ-data indikator yang belum masuk ke tab FUNDAMENTAL (semua pair) + card sectioning & "Selengkapnya"

**Konteks:** User minta cek — di News/`econ-data` (`api/_push_keywords.js` `ECON_DATA`) ada keyword rilis data ekonomi yang ternyata TIDAK pernah ke-parse ke tab FUNDAMENTAL (`api/_fundamental_parser.js`), padahal secara konsep harusnya ikut dilacak per currency.

**Gap yang ditemukan (audit `ECON_DATA` vs `FUND_PREFIX_MAP`/`FUND_INDICATOR_MAP`):**
- **USD** — indikator yang muncul di News sebagai `econ-data` tapi tidak pernah nyampe ke card USD: JOLTS Job Openings, ADP Employment, Continuing Claims (beda dari Initial/Jobless Claims), Chicago PMI, Michigan Consumer Sentiment, Existing/New Home Sales, Personal Income/Personal Spending, Capacity Utilization, Factory Orders. Semua ini adalah indikator EKSKLUSIF Amerika yang di headline FinancialJuice biasanya TIDAK pernah disebut "US"/"United States" (persis pola NFP/ISM/Core PCE yang sudah lebih dulu ada) — jadi butuh bare keyword di `FUND_PREFIX_MAP`, bukan cuma di `FUND_INDICATOR_MAP`.
- **EUR** — GfK Consumer Climate (Jerman) ada di `ECON_DATA` (`'gfk'`) tapi tidak pernah dipetakan sama sekali.
- **Semua pair** — headline generik "Inflation Rate"/"Inflation Data" (dipakai UK/Eurozone selain istilah "CPI") dan "Core Inflation" (sinonim Core CPI) tidak match keyword manapun di `FUND_INDICATOR_MAP`, jatuh ke fallback title-case bebas → berpotensi bikin row terpisah yang isinya sama tapi nama key beda (kelas bug yang sama seperti "CPI Core/Flash" di Session 135).

**Fix (`api/_fundamental_parser.js`):**
- `FUND_PREFIX_MAP` USD: tambah bare keyword `jolts`, `job openings`, `adp employment`/`adp nonfarm`/`adp jobs`/`adp report`, `chicago pmi`, `existing home sales`, `new home sales`, `capacity utilization`, `personal income`, `personal spending`, `consumer spending`, `michigan sentiment`, `michigan consumer`, `continuing claim`.
- `FUND_PREFIX_MAP` EUR: tambah `gfk`.
- `FUND_INDICATOR_MAP`: tambah key baru `Continuing Claims`, `JOLTS Job Openings`, `ADP Employment`, `Chicago PMI`, `Existing Home Sales`, `New Home Sales`, `Personal Income`, `Personal Spending`, `Capacity Utilization`, `Factory Orders`, `GfK Consumer Climate`, `Building Permits` (dipisah dari `Building Approvals` — lihat bug di bawah); alias `core inflation` → `Core CPI MoM`, `inflation rate`/`inflation data` → `CPI YoY`, `michigan sentiment` → `Consumer Confidence`. Semua entry ini **currency-agnostic** (key generik dicocokkan terpisah dari deteksi currency), jadi otomatis berlaku untuk SEMUA 8 pair lewat mekanisme `FUND_COUNTRY_ONLY` fallback yang sudah ada sejak Session 135 — bukan cuma USD (contoh: "German Factory Orders Actual..." → EUR + `Factory Orders`, "Australia Building Approvals..." tetap → AUD + `Building Approvals`).
- **Bug pre-existing ditemukan saat testing:** `Building Approvals` (AU) ada di `QUANTITY_INDICATORS` (reject value `%`), padahal AU Building Approvals SELALU dilaporkan sebagai `%` MoM (konsisten dengan `FUND_SCORE_RULES` yang sudah lama nge-set `dir:1, threshold:0` — asumsi angka bertanda, bukan count). Akibatnya headline real Australia Building Approvals tidak pernah bisa update Redis sejak awal fitur ini ada. Dihapus dari `QUANTITY_INDICATORS` (kelas bug yang sama seperti fix `Employment Change` NZD di Session sebelumnya — lihat baris 551-554 di atas).

**UI (`index.html`) — card jadi kepanjangan setelah indikator nambah banyak, jadi ditambah sectioning + show-more:**
- `FUND_SECTIONS_MAP`: tambah semua key baru ke section yang sesuai (Ketenagakerjaan/Aktivitas/Sentimen/Permintaan) — dipakai bareng oleh overlay detail (`openFundDetail`) yang sudah ada dari fitur drill-down sebelumnya.
- `IND_DIR` + `FUND_SCORE_RULES`: tambah arah bull/bear dan threshold fallback untuk semua key baru.
- `renderFundamental()`: card compact sekarang di-cap `CARD_ROW_LIMIT = 8` baris, diurutkan pakai prioritas section yang SAMA dengan overlay (Inflasi → Pertumbuhan → Ketenagakerjaan → Aktivitas → Sentimen → Permintaan → Eksternal) supaya indikator paling relevan tampil duluan sebelum terpotong. Kalau ada sisa, muncul link `.fund-more-link` "Selengkapnya (+N) →" di bawah tabel — tidak perlu handler baru, tap di mana pun di card (termasuk link ini, lewat event bubbling) sudah otomatis buka `openFundDetail(cur)` yang menampilkan SEMUA indikator ter-section rapi (fitur ini sudah ada dari drill-down overlay, cuma belum pernah dipakai sebagai "lihat semua" dari card compact).

**Scope yang SENGAJA tidak disentuh:**
- Tidak menambah angka `FUND_SEED` untuk indikator baru — nilainya akan populate otomatis dari headline real lewat `fundamental_refresh`/digest pipeline yang sudah jalan, tanpa perlu seed manual. Menghindari menampilkan angka ekonomi yang tidak bisa diverifikasi sebagai data "aktual" di tool trading real.
- Caixin PMI (China) tetap tidak dipetakan — tidak ada pair CNY yang ditradingkan di app ini, di luar 8 currency yang didukung tab FUNDAMENTAL.

**Verifikasi:**
- 22 test case lewat `parseFundamentalFromHeadline()` langsung (Node) — semua pass, termasuk regression check headline lama (Core/Flash CPI Session 135, NFP, NZD Employment Change) supaya tidak ada perilaku existing yang berubah.
- Harness `jsdom`: ekstrak kode asli `renderFundamental`/`openFundDetail`/`_renderFundDetail` dari `index.html`, render dengan mock data USD 21 indikator — card ke-cap 8 baris + `"Selengkapnya (+13) →"` muncul benar; card CHF (2 indikator) tidak ke-truncate; overlay detail nunjuk SEMUA 21 baris ter-bagi ke section Inflasi/Pertumbuhan/Ketenagakerjaan/Aktivitas/Permintaan, nol yang jatuh ke bucket "Lainnya" (unmapped).
- `node --check` pass untuk `api/_fundamental_parser.js` dan `api/admin.js`; seluruh `<script>` di `index.html` di-parse ulang via `new Function()` — tidak ada syntax error.

`git diff` menyentuh `api/_fundamental_parser.js` dan `index.html` saja.

### Fix CRITICAL: Swipe antar tab utama (FEED/RINGKASAN/ANALISA/TEKNIKAL) di HP tidak berfungsi sama sekali

**Dilaporkan user:** "swipe ke samping, aku tadi coba gabisa" — panel keliatan geser + haptic bunyi, tapi tab tidak pernah pindah.

**Root cause:** Interaksi tak terduga antara dua fitur independen yang sama-sama sudah ada sebelum session ini:
1. `doCommit()` (swipe nav, `index.html` ~baris 11509) menyelesaikan swipe sukses dengan `btn.click()` terprogram ke tombol `#navViews .nvtab` yang sesuai (dipanggil di dalam `setTimeout` 95ms, supaya sinkron dengan animasi fade-out panel lama).
2. Guard lama yang dibuat untuk kasus lain sama sekali ("Cegah klik tidak sengaja saat scroll list berita di HP", `index.html` ~baris 3985) — `document.addEventListener('click', e => { if (_touchMoved) { e.preventDefault(); e.stopImmediatePropagation(); ... } }, true)` — cancel SEMUA klik (capture phase, `stopImmediatePropagation`) selama flag global `_touchMoved` masih `true` sejak gestur touch terakhir bergerak >10px.

Karena swipe SELALU menggerakkan jari jauh lebih dari 10px (butuh 8px buat direction-lock, dan commit butuh 28% lebar layar), `_touchMoved` sudah pasti `true` selama gestur swipe berlangsung. Browser mobile (iOS Safari & Android Chrome) tidak pernah memicu native `click` sesudah gestur drag sejauh itu, jadi `_touchMoved` TIDAK PERNAH direset balik ke `false` sebelum `doCommit()`'s `btn.click()` terprogram jalan 95ms kemudian. Akibatnya: `btn.click()` dispatch event click asli, ke-intercept duluan oleh guard di atas (capture phase, jalan sebelum listener asli tombol yang bubble-phase), `stopImmediatePropagation()` membunuh event itu total — `activeView` tidak pernah berubah, `hideAllPanels()`/render panel baru tidak pernah terpanggil. Panel lama cuma balik ke posisi normal (transform di-reset di baris berikutnya di `doCommit`), keliatan seperti swipe di-abort padahal sebenarnya berhasil "commit" tapi hasilnya dibatalkan diam-diam oleh kode yang sama sekali tidak berhubungan.

**Kenapa lolos dari review kode statis sebelumnya:** dua listener ini ada di bagian file yang jauh terpisah (baris ~3985 vs ~11509-11535), tidak saling mereferensi langsung — bug-nya baru kelihatan kalau menelusuri urutan eksekusi event lintas fitur, bukan dari membaca satu fungsi saja.

**Fix (`index.html` ~baris 3985):** tambah syarat `e.isTrusted` ke guard lama — `if (_touchMoved && e.isTrusted) { ... }`. Klik asli dari browser (misal synthetic click setelah scroll list berita, `isTrusted: true`) tetap ke-cancel seperti semula (tidak ada perubahan perilaku untuk kasus asli yang dilindungi guard ini). Klik yang di-trigger lewat JS (`element.click()` — SELALU `isTrusted: false`, termasuk punya swipe nav) sekarang lolos tanpa terjegal, apa pun status `_touchMoved`.

**Verifikasi:** Simulasi `jsdom` — guard lama (tanpa fix) vs guard baru (dengan fix), keduanya diuji dengan skenario identik (`_touchMoved = true`, lalu panggil `btn.click()` persis seperti `doCommit()`): guard lama → handler klik tombol nav TIDAK terpanggil (bug ter-reproduksi persis laporan user); guard baru → handler klik tombol nav terpanggil normal (fix terverifikasi). `node -e` full-script parse index.html tetap tidak ada syntax error.

`git diff` untuk fix ini hanya menyentuh satu blok kecil di `index.html` (guard `_touchMoved`/`isTrusted`, ~baris 3985-3996).

### Fix: Tombol "Lihat Gambar ▾" di News tidak menampilkan apa-apa (kelihatan gak berfungsi)

**Dilaporkan user:** paste contoh nyata headline `"Fed's Chair Warsh: volatility is down, yields are down"` bertag `market-moving`, muncul tombol "Lihat Gambar ▾" tapi diklik tidak menampilkan gambar apa pun.

**Root cause:** `fjImageType(title)` (`index.html` ~baris 3812) menebak apakah sebuah post FinancialJuice punya gambar chart/tabel murni dari kata kunci di judul — regex lama `\b(probabilities?|matrix|heatmap|volatility)\b`. Kata **"volatility"** terlalu umum: sering muncul di judul quote/komentar biasa ("volatility is down", "market volatility rises") yang BUKAN post gambar. Diverifikasi langsung ke RSS feed live: headline yang dilaporkan user (`guid 9660453`) memang cocok regex → tombol "Lihat Gambar" muncul → tapi `financialjuice.com/images/9660453.png` return **HTTP 404** (memang tidak ada gambarnya) → `onerror` lama diam-diam nyembunyiin seluruh wrap (`style.display='none'`) tanpa pesan apa pun, jadi kelihatan seperti tombol tidak berfungsi.

Ditemukan juga false-positive serupa dari kata **"chart"** (idiom "We'll chart a new course...", `guid 9660356` → juga 404) — tidak diperbaiki (masih dipertahankan sebagai keyword) karena tidak ada bukti false-positive rate-nya cukup tinggi untuk sepadan dengan resiko kehilangan true-positive (real chart post biasanya memang judulnya literally "X Chart"), tapi sekarang aman berkat fix kedua di bawah.

**Fix (`index.html`):**
1. Hapus `volatility` dari regex `fjImageType()` — kasus false-positive yang dilaporkan user, terbukti generik.
2. `onerror` pada `<img class="feed-chart-img">` (2 lokasi: `renderFeed()` tab NEWS ~baris 3849, render berita TEK ~baris 10655) diganti dari "diam-diam hilang" jadi tampilkan pesan **"Gambar tidak tersedia"** (`.feed-chart-error`, class baru) — supaya kalau heuristik salah tebak lagi di masa depan (mis. kasus "chart a new course" di atas), user dapat feedback jelas, bukan kelihatan seperti tombol rusak.

**Verifikasi:**
- `curl` langsung ke `financialjuice.com/images/9660453.png` dan `.../9660356.png` → HTTP 404 keduanya (konfirmasi tidak ada gambar); `.../9660330.png` (headline "UniCredit's matrix of possible EUR-USD reaction...") → HTTP 200 (konfirmasi keyword `matrix` masih valid, tidak dihapus).
- Test `fjImageType()` langsung (Node, 5 skenario) — headline volatility di atas sekarang `null` (tombol tidak muncul sama sekali, bukan cuma "gambar gagal"); "matrix"/"probabilities"/"chart" tetap terdeteksi benar.
- Simulasi `jsdom` untuk `onerror` handler baru — `<img>` yang gagal load benar digantikan teks "Gambar tidak tersedia" dengan class `feed-chart-error`, tanpa error (verifikasi `closest()` di-capture sebelum DOM diubah, tidak ada masalah node ke-detach).
- Full-script parse `index.html` tetap tanpa syntax error.

---

## Changelog Session 135 (2026-07-01)

### Fix: Rilis data ekonomi salah kategori — `market-moving`/`indexes`/`macro`/`bonds` "merebut" headline yang seharusnya `econ-data`

**Masalah (dilaporkan user):** Di News, headline rilis data ekonomi (CPI/NFP/GDP/PMI dari feed FinancialJuice, format kalender `"... Actual X Forecast Y Previous Z"`) sering ke-tag kategori `market-moving`, bukan `econ-data`.

**Root cause:** `detectCat(title)` — ada dua salinan independen, `api/market-digest.js` (narasi AI briefing per kategori) dan `index.html` (tab filter News, dashboard grouping, voice readout) — mengecek kategori berurutan via `Object.entries(CATS)` dan berhenti di match pertama. `econ-data` diletakkan di urutan ke-10 dari 11, sehingga kategori yang dicek lebih dulu dan punya keyword generik "merebut" headline rilis data:
- `market-moving` (urutan 1) punya `'flash'`/`'alert'` — tapi "Flash CPI"/"Flash PMI"/"Flash GDP" adalah terminologi standar rilis data preliminer, bukan breaking news darurat.
- `indexes` (urutan 8) punya `'pmi'`/`'purchasing manager'`/`'manufacturing index'` (+ `'services index'`/`'business activity'` di `index.html`) — semua rilis PMI ke-tag `indexes`.
- `macro` (urutan 9) punya bare `'gdp'` — rilis GDP resmi ke-tag `macro`.
- `bonds` (urutan 6, ditemukan saat audit menyeluruh) punya `'bps'`/`'basis point'` — headline keputusan rate bank sentral (mis. "Fed cuts rates by 25bps") ke-tag `bonds`, bukan `macro`.

Bug kelas ini identik dengan yang sudah pernah difix 2026-05-06 di sistem push notification (`api/_push_keywords.js` — lihat entry Session sebelumnya soal `'record high/low'`/`'jordan'`/`'trade deficit/surplus'`), tapi belum pernah diterapkan ke `detectCat()` di News feed karena kedua sistem kategorisasi berkembang independen.

**Klarifikasi arsitektur penting:** Pipeline yang menulis fundamental per pair ke Redis (`autoUpdateFundamentals`/`parseFundamentalFromHeadline` di `api/_fundamental_parser.js`, dipanggil dari `market-digest.js` & `admin.js` `fundamental_refresh`) **sudah independen dari `detectCat`/kategori sejak refactor 2026-05-21** — kedua caller mengirim semua headline mentah tanpa filter kategori, parser punya keyword matching sendiri (`FUND_PREFIX_MAP`/`FUND_INDICATOR_MAP`). Jadi fix kategori ini murni memperbaiki tampilan/narasi kategori di News — bukan pipeline fundamental (yang sudah benar). Kalau ke depan ditemukan pair fundamental yang tidak update, root cause-nya ada di keyword coverage `_fundamental_parser.js`, kasus terpisah.

**Fix (`api/market-digest.js` fungsi `detectCat` baris ~1566; `index.html` objek `CATS` + fungsi `detectCat` baris ~3204):**
- Tambah early-check regex di awal `detectCat`: headline yang match `/\bactual\b/` DAN (`/\bforecast\b/` ATAU `/\bprevious\b/`) langsung `return 'econ-data'`, sebelum loop `CATS` — jaring pengaman utama, menjamin SEMUA rilis format kalender FinancialJuice selalu econ-data terlepas dari keyword lain apa pun yang ikut muncul di judul.
- Hapus `'flash'`, `'alert'` dari `market-moving`; hapus `'bps'`/`'basis point'` dari `bonds`; hapus `'pmi'`/`'purchasing manager'`/`'manufacturing index'`/`'services index'`/`'business activity'` dari `indexes` (sisa `'composite index'` saja); hapus bare `'gdp'` dari `macro`.
- Perluas & SAMAKAN keyword `econ-data` di kedua file — tambah `'gdp'`, `'pmi'`, `'ism '`, `'ism manufacturing'`, `'ism services'`, `'manufacturing pmi'`, `'services pmi'`, `'composite pmi'`, `'flash pmi'`, `'flash cpi'`, `'flash gdp'`, `'ppi'`, `'durable goods'`, `'housing starts'`, `'building permits'`, `'caixin'`, `'ifo'`, `'zew'` — align dengan `FUND_INDICATOR_MAP` (`_fundamental_parser.js`) dan `ECON_DATA` (`_push_keywords.js`).
- `api/admin.js`/`api/_push_keywords.js` (`detectPushCat`) **tidak disentuh** — sistem itu sudah benar (fix 2026-05-06), di luar scope.

**Verifikasi:** Diekstrak & dijalankan langsung fungsi `detectCat` dari kedua file (Node) terhadap 8 headline representatif — semua match ekspektasi identik di kedua salinan:
- `"US Non-Farm Payrolls Actual 254K Forecast 140K Previous 130K"` → `econ-data` ✓
- `"Eurozone Flash CPI y/y Actual 3.0% Forecast 2.9% Previous 2.8%"` → `econ-data` ✓ (kasus utama yang dilaporkan — sebelumnya `market-moving`)
- `"BREAKING: US NFP Actual 254K vs 140K Forecast"` → `econ-data` ✓ (early-check menang meski ada kata "breaking")
- `"US ISM Manufacturing PMI Actual 54.5 Forecast 53.0 Previous 52.8"` → `econ-data` ✓ (sebelumnya `indexes`)
- `"US GDP q/q Actual 2.1% Forecast 1.8% Previous 1.5%"` → `econ-data` ✓ (sebelumnya `macro`)
- `"Fed cuts rates by 25bps to 3.75%, as expected"` → `macro` ✓ (sebelumnya `bonds`)
- `"Israel strikes Iranian nuclear facility, oil surges"` → tidak berubah jadi `econ-data` (tetap `energy`, tidak ada regresi kategori darurat)
- `"Market moving: Fed announces emergency rate decision"` → tetap `market-moving` ✓ (keyword yang disisakan masih berfungsi)

`git diff` hanya menyentuh `api/market-digest.js` (fungsi `detectCat`) dan `index.html` (objek `CATS` + fungsi `detectCat`) — tidak ada file lain yang berubah. `node -c` pass, tidak ada syntax error.

### Fix lanjutan: `parseFundamentalFromHeadline` gagal parse headline dengan kata sisipan ("Core", "Flash")

**Ditemukan user langsung setelah deploy fix di atas** — user paste contoh nyata dari News: `"Eurozone Core CPI YoY Flash Actual 2.4% (Forecast 2.5%, Previous 2.6%)"` sudah benar ke-tag `econ data` di News, tapi kartu EUR di tab FUNDAMENTAL tetap nunjuk `CPI Flash YoY 3.0% (Apr 2026)` — stale.

**Root cause 1 (currency gagal terdeteksi):** `FUND_PREFIX_MAP` (`api/_fundamental_parser.js`) butuh frasa nama-negara+indikator NEMPEL LANGSUNG (`'eurozone cpi'`), sehingga gagal kalau ada kata sisipan seperti **"Core"** di antaranya (`"Eurozone Core CPI"` tidak match `'eurozone cpi'`) — `parseFundamentalFromHeadline` langsung `return null` di baris cek currency, headline dibuang total, tidak pernah nyampe ke Redis.

**Root cause 2 (indicator key salah, headline yang user paste kemudian):** `"Eurozone CPI YoY Flash Actual 2.8% (Forecast 3%, Previous 3.2%)"` — pola FinancialJuice nyata ("indikator dulu, 'Flash' di akhir") tidak match keyword `'flash cpi'`/`'cpi flash'` (assumsi adjacency 2 kata) di `FUND_INDICATOR_MAP`, jatuh ke keyword generik `'cpi yoy'` duluan → key jadi `'CPI YoY'` (baru, kosong) bukan `'CPI Flash YoY'` (key yang sudah ada datanya) — hasilnya row DUPLIKAT bukan update ke row yang sama.

**Fix (`api/_fundamental_parser.js`):**
- Tambah `FUND_COUNTRY_ONLY` (baris ~72) — deteksi nama negara SENDIRI (regex word-boundary, bukan `.includes`) sebagai fallback, HANYA aktif kalau `FUND_PREFIX_MAP` gagal match DAN judul memenuhi `isCalendarFormat` (`actual` + `forecast`/`previous`) — gate ini menjaga supaya fallback yang lebih longgar tidak menimbulkan false positive di headline non-rilis yang cuma menyebut nama negara.
- Tambah redirect "Flash" setelah resolusi `indicatorKey` (mirror pola disambiguasi Core PCE/Core CPI yang sudah ada): kalau judul mengandung kata `flash` di mana pun DAN `indicatorKey` sudah `'CPI YoY'`/`'GDP QoQ'`, redirect ke `'CPI Flash YoY'`/`'GDP QoQ Flash'` — supaya headline flash apa pun urutan katanya tetap nempel ke key seed yang sama.

**Verifikasi:** 12 headline (termasuk 3 contoh nyata dari user) dites langsung lewat `parseFundamentalFromHeadline()` — semua currency & key sesuai ekspektasi, termasuk 2 negative test (`"Germany warns of recession risk..."`, `"Belarus president meets Putin..."`) tetap `null` (tidak ada false positive dari fallback nama-negara yang lebih longgar). Satu kasus di luar scope (`"US GDP Advance q/q"` → tetap `'GDP QoQ'` bukan `'GDP QoQ Flash'`) adalah inkonsistensi minor pre-existing di `FUND_INDICATOR_MAP` (keyword bare `'gdp'` posisinya sebelum `'gdp advance'` di list) — TIDAK disentuh, di luar laporan user, catat sebagai temuan terpisah kalau nanti relevan.

---

## Changelog Session 132 (2026-07-01)

### UX: Swipe horizontal mobile — empati psikologis + real-time panel tracking

**Masalah:** Swipe lama hanya deteksi di `touchend` dengan threshold fixed 60px. Tidak ada feedback real-time — panel tidak bergerak saat jari geser, tidak ada indikator arah, tidak ada spring-back.

**Solusi: Swipe psikologis berbasis physics + empati gesture:**

**CSS (`index.html`):**
- Swipe-in animations diperhalus: travel 40px → 70px, curve `ease-out-expo` (`cubic-bezier(.22,1,.36,1)`) — masuk lebih natural, landing lebih smooth, 220ms → 280ms.
- Tambah `#swipeHint`: indikator nama tab tujuan (`FEED`, `ANALISA`, dst) + panah `›`/`‹` yang muncul di tepi layar saat drag. Opacity naik proporsional terhadap jarak drag.

**JS (`index.html`) — ganti total blok swipe lama:**
1. **Direction lock 8px**: touchmove pertama >8px horizontal/vertical → lock ke satu arah. Kalau vertical terpilih, swipe diabaikan dan scroll vertikal berjalan normal.
2. **Real-time panel tracking**: selama drag horizontal, panel aktif `transform: translateX(dx)` tanpa transisi — panel ikut jari langsung.
3. **Rubber band di tepi**: kalau tidak ada tab di arah drag (posisi pertama/terakhir), travel dikurangi ke 12% (`dx * 0.12`) — terasa ada hambatan tapi tidak mentok keras.
4. **isHScroll guard**: swipe diabaikan kalau dimulai di elemen yang punya `overflow-x:auto/scroll` aktif (nav tabs, event strip, fundamental tabs, dll).
5. **Commit logic**: `touchend` → cek `|dx| > 28% layar` ATAU `velocity > 0.42 px/ms` → commit. Keduanya bisa trigger: drag panjang lambat ✓, flick pendek cepat ✓.
6. **Commit animation**: panel lama slide out + fade (180ms), 95ms kemudian `btn.click()` → panel baru slide in dari sisi berlawanan (280ms swipe-in animation).
7. **Spring-back abort**: kalau threshold tidak terpenuhi, panel kembali dengan `cubic-bezier(.34,1.56,.64,1)` — ada overshoot kecil yang terasa "terpental" alami.
8. **Haptic feedback**: `navigator.vibrate(8)` saat switch berhasil (Android).
9. **touchcancel**: kalau gesture diinterrupt sistem (call masuk, notif), spring-back bersih.
10. **Drawer case**: swipe kiri dari tab terakhir (Teknikal) → buka drawer "Lainnya" dengan animasi yang sama.

### Fix: Swipe freeze di view sekunder + filter berita non-Fed di XAU/USD (session 132)

---

## Changelog Session 133 (2026-07-01)

### Filter Berita Terkait — Extended ke Semua Kombinasi Pair

**Masalah yang diperbaiki:**

**1. Filter negatif hanya ada untuk XAUUSD, semua pair lain tidak punya:**
- Sebelumnya `TEK_PAIR_NEGATIVE` hanya punya entry XAUUSD. 27 pair FX lain (termasuk EURUSD, GBPUSD, USDJPY, semua crosses) tidak difilter sama sekali.
- Akibat: "BOJ Rate Decision" muncul di berita terkait EURUSD, "RBA Rate Hike" di GBPUSD, "SNB Rate Cut" di USDJPY — semuanya false positive dari keyword `'rate decision'`/`'rate hike'` di `TEK_CUR_KEYWORDS['USD']` yang terlalu lebar.

**2. Bug XAUUSD: `'interest rate probabilities'` catch-all memblokir "USD Interest Rate Probabilities":**
- Daftar negatif XAUUSD menggunakan `'interest rate probabilities'` sebagai catch-all.
- Ini memblokir "USD Interest Rate Probabilities" / "Fed Interest Rate Probabilities" yang sangat relevan untuk gold (gold bergerak terbalik dengan Fed rate expectations).
- False negative: berita penting tentang Fed rate expectations tidak muncul di XAU/USD berita terkait.

**Fix: Generate `TEK_PAIR_NEGATIVE` secara programatik untuk SEMUA pair:**
- Tambah `_CB_RATE_BLOCK` — mapping per-CB berisi blocking terms dalam 2 format: CB-prefix (`'ecb rate'`, `'boe policy'`) + currency-prefix (`'eur interest rate'`, `'gbp interest rate'`).
  - CB-prefix menangkap: "ECB Rate Decision", "BOE Policy Statement"
  - Currency-prefix menangkap: "EUR Interest Rate Probabilities", "GBP Rate Decision" (format FinancialJuice charts)
- Tambah `_CUR_CB` — mapping currency leg → CB key. USD dan XAU tidak ada mapping (kita tidak pernah blokir berita Fed).
- Loop `TEK_ALL_PAIRS` untuk generate negative filter per-pair: setiap pair memblokir semua CB yang bukan salah satu dari kedua legnya.
  - EURUSD: blocks BOE/BOJ/RBA/RBNZ/BOC/SNB rate news (allow ECB + Fed)
  - GBPUSD: blocks ECB/BOJ/RBA/RBNZ/BOC/SNB (allow BOE + Fed)
  - USDJPY: blocks ECB/BOE/RBA/RBNZ/BOC/SNB (allow BOJ + Fed)
  - AUDUSD: blocks ECB/BOE/BOJ/RBNZ/BOC/SNB (allow RBA + Fed)
  - NZDUSD: blocks ECB/BOE/BOJ/RBA/BOC/SNB (allow RBNZ + Fed)
  - USDCAD: blocks ECB/BOE/BOJ/RBA/RBNZ/SNB (allow BOC + Fed)
  - USDCHF: blocks ECB/BOE/BOJ/RBA/RBNZ/BOC (allow SNB + Fed)
  - XAUUSD: blocks semua 7 CB (XAU + USD tidak ada CB entry) — lebih presisi dari sebelumnya
  - Cross pairs (EURJPY, EURGBP, GBPJPY, dll.): blocks semua CB kecuali dua leg pair
  - Yield instruments (US10Y, US02Y): tidak diberi filter negatif — berita rate global tetap relevan
- Menggantikan `'interest rate probabilities'` catch-all yang lama dengan currency-prefix terms per-CB → "USD/Fed Interest Rate Probabilities" sekarang bisa lolos filter untuk XAU/USD ✓

### Fix: Swipe freeze di view sekunder + filter berita non-Fed di XAU/USD

**Bug 1 — Swipe di view sekunder (Kalender, COT, Riset, dll.) panel bergerak tapi tidak bisa pindah:**
- Penyebab: view sekunder (`cal`, `cot`, `riset`, dll.) tidak ada di array `VIEWS` primer `['dashboard','feed','ringkasan','analisa','teknikal']`. `adjView()` return `null` untuk `nv` dan `pv`. Panel tetap bergerak karena rubber-band (12%) tapi `doAbort` selalu terpanggil → view tidak pernah ganti.
- Fix: saat direction lock 'h' tapi `nv` dan `pv` keduanya `null` → set `locked = 'v'`. Panel tidak bergerak sama sekali, scroll vertikal berjalan normal. Rubber band di sisi tepi view PRIMER tetap berjalan (nv atau pv bisa null secara individual — cuma keduanya sekaligus yang di-abort).

**Bug 2 — Berita Terkait XAU/USD: "SNB/RBNZ/RBA/BOC/BOE/ECB Interest Rate Probabilities" muncul (tidak relevan):**
- Penyebab: keyword `'interest rate'` di `TEK_CUR_KEYWORDS['USD']` terlalu lebar — menangkap semua headline yang mengandung "interest rate", termasuk milik CB pair lain. Hanya Fed yang relevan ke XAU/USD.
- Fix: tambah `TEK_PAIR_NEGATIVE['XAUUSD']` berisi compound terms: `'snb interest'`, `'rbnz rate'`, `'ecb policy'`, `'interest rate probabilities'` (format generik chart), dll. Diterapkan di `renderTekNews()` — headline yang cocok di-skip meskipun ada keyword match. Berita Fed (`'fed interest'`, `'fomc'`, dll.) tidak cocok dengan negative list → tetap tampil.

---

## Changelog Session 134 (2026-07-01)

### UI: Session Strip di REGIME bar (handoff Section G, `daun_merah_plan.md`)

**Masalah:** Sisi kanan REGIME bar kosong ~60% — cuma `REGIME: NEUTRAL · VIX · MOVE · HY` nempel di kiri. User memilih indikator sesi FX (dari 4 opsi kandidat) untuk mengisi ruang itu — glanceable, low-noise, non-duplikat dengan boundary sesi yang sudah ada di tab CHECKLIST.

**Implementasi:**
- **`getFxSession(now)`** (`index.html`, sebelum `ckUpdateClock`) — single source of truth untuk boundary sesi UTC: TOKYO 00–08, LONDON 08–13, OVERLAP 13–16, NY 16–21, CLOSED 21–24. Return `{ list, cur, next, msToNext }`.
- **`renderRegimeSessions()`** — render chip progression (`TOKYO › LONDON › OVERLAP › NY › CLOSED`) dengan sesi aktif di-highlight bold + warna, plus countdown `→ <next> in Xj Ym`. Dipasang sebagai ticker independen (`setInterval` 30 detik) di `window.addEventListener('load', …)` supaya jalan terlepas dari tab yang sedang aktif (beda dari `ckClockInterval` yang cuma jalan saat tab CHECKLIST kebuka).
- **HTML:** tambah `<span class="regime-sessions" id="regimeSessions">` setelah `#regimeMeta` di `.regime-row`.
- **CSS:** `.regime-sess-chip` warna reuse existing (`--yellow` London/Overlap, `#60a5fa` NY, `--muted`→`--text-mid` saat aktif untuk Tokyo/Closed). `margin-left:auto` + `flex-shrink:0` supaya rata kanan tanpa nge-clip `regime-main`/`regime-meta`. Mobile (`≤820px`): sembunyikan chip non-aktif + separator, sisakan sesi aktif + countdown saja.
- **Refactor `ckUpdateClock()`** — hardcode if/else boundary diganti baca dari `getFxSession()` supaya header & checklist tidak pernah beda (`ckLabel`/`ckCls` per sesi).

**Verifikasi (Playwright headless, fake `Date` per jam batas):**
- 10 titik boundary (07/08, 12/13, 15/16, 20/21, 23/00 UTC) → chip aktif & label checklist match ekspektasi persis, termasuk wrap CLOSED→TOKYO tengah malam.
- `msToNext` tidak pernah negatif / nyangkut di "0m" — dicek matematis di Node terpisah untuk semua 10 boundary + 2 titik rollover presisi (`20:59:59.9`, `23:59:59.9`).
- Output `ckUpdateClock()` hasil refactor **identik** dengan versi hardcode lama (dicek 5 sesi lewat tab CHECKLIST) — pembuktian single-source-of-truth tidak mengubah perilaku existing.
- Kontras chip aktif dicek di background `risk-on` (hijau tua) & `risk-off` (merah tua) via screenshot — semua warna (yellow/blue/text-mid) tetap legible, tidak perlu adjustment.
- Mobile viewport (390px) → chip non-aktif tersembunyi, `REGIME: —` dan `regimeMeta` tidak ter-clip.

### UI: Retail Sentiment mini-strip di kolom kanan DASHBOARD

**Masalah:** Kolom kanan dashboard (`#dashSideCol`: CB BIAS, FUNDAMENTAL RANKING, DAILY PULSE) `overflow-y:auto` dengan tinggi mengikuti grid row penuh — kalau konten lebih pendek dari kolom kiri/tengah, sisanya kosong (dead space di sudut kanan bawah). User pilih **Retail Sentiment** (dari 4 opsi kandidat) untuk mengisinya — reuse data yang sudah di-fetch untuk tab COT, tanpa API baru.

**Implementasi:**
- **`renderDashRetail()`** (`index.html`) — versi ringkas dari `renderRetailSentiment()` (tab COT). Reuse `retailData`, `RETAIL_PAIR_ORDER`, `RETAIL_PAIR_COLORS` yang sudah ada. Render ke `#dashRetailStrip` (div baru di `#dashSideCol`, setelah DAILY PULSE).
- **Sort by extremity** — beda dari tab COT (urutan pair tetap), mini-strip di-sort descending berdasarkan `|long_pct − 50|` supaya sinyal paling ekstrem/kontrarian muncul duluan — lebih glanceable untuk dashboard.
- Tiap baris: pair + mini progress bar (`long_pct` width) + panah arah sinyal kontrarian (↑ LEAN LONG / ↓ LEAN SHORT / — NEUTRAL, warna hijau/merah/abu), dengan `title` tooltip berisi detail persentase lengkap.
- **`fetchRetailSentiment()`** dipanggil juga di `window.addEventListener('load', …)` (sebelumnya cuma dipanggil saat switch ke tab COT) supaya dashboard dapat data tanpa perlu buka tab COT dulu. `renderRetailSentiment()` (tab COT) sekarang juga memanggil `renderDashRetail()` di akhir — satu fetch, dua tempat render, tidak ada request duplikat.
- **Error handling:** kalau fetch retail gagal, cabang `catch` sekarang juga fallback `#dashRetailStrip` ke `—` (sebelumnya cuma `#retailGrid`/`#retailMeta` di tab COT yang di-update — ditemukan & diperbaiki saat evaluasi mandiri, karena tanpa ini strip dashboard bisa nyangkut di "Memuat..." selamanya kalau ForexBenchmark down).

**Verifikasi (Playwright headless, mock `/api/feeds?type=retail`):**
- Data sukses (8 pair, macam-macam signal) → urutan render sesuai extremity (`|long_pct-50|` descending), warna & arah panah cocok dengan signal (`CONTRARIAN_LONG`→↑ hijau, `CONTRARIAN_SHORT`→↓ merah, `NEUTRAL`→— abu), lebar bar proporsional ke `long_pct`, tidak ada console error.
- Simulasi upstream gagal (HTTP 500) → `#dashRetailStrip` fallback ke `—`, tidak nyangkut di "Memuat...".
- Konfirmasi `renderDashBias()`/`refreshDashboard()` (siklus 60 dtk) tidak menimpa `#dashRetailStrip` — sama seperti DAILY PULSE, strip retail punya siklus fetch sendiri (TTL 2 jam) independen dari auto-refresh dashboard.

---

## Changelog Session 131 (2026-06-30)

### Analisa near real-time — candle fetch on-demand dari Yahoo (tidak lagi nunggu cron)

**Masalah:** Header tab Analisa menampilkan `candle: 2.2 jam lalu`. Penyebabnya: tab Analisa (`/api/admin?action=ohlcv_read`) baca candle dari snapshot Redis (`ohlcv:<symbol>:1h/4h/1d`) yang **hanya** diisi cron `ohlcv_sync`. Setelah cron Vercel dihapus (session 130, Hobby plan max 1x/hari), snapshot bisa basi berjam-jam. User minta data mendekati/real-time.

**Solusi: fetch fresh saat dibaca (on-demand), bukan nunggu cron.**

**`api/admin.js`:**
- Fungsi baru `refreshOhlcvFromYahoo(symbol)`: tarik 1H (`range=10d`) + 1D (`range=1mo`) langsung dari Yahoo saat user buka/refresh pair, resample 4H, tulis ke key `ohlcv:<symbol>:*` yang sama (TTL 25h) — snapshot tetap hangat untuk `ohlcv_analyze`/`ohlcv_dashboard`.
  - **Throttle per-symbol** via Redis `ohlcv_fresh:<symbol>` (TTL 90s): refresh beruntun / banyak klien tidak menghajar Yahoo; baca dalam window 90s pakai snapshot yang baru ditulis.
  - **Per-timeframe `allSettled`**: kalau fetch 1D gagal sesaat, fetch 1H yang sukses tetap ditulis (tidak dibuang).
  - **Failure throttle 30s**: kalau Yahoo down total, set throttle pendek supaya tiap read tidak bayar timeout penuh ~12s; langsung fallback ke snapshot.
- `loadOhlcvData()`: panggil `refreshOhlcvFromYahoo(symbol)` di awal (try/catch — kalau Yahoo down, lanjut pakai snapshot; badge umur candle tetap menandai kalau basi).

**`index.html`:**
- `ANALISA_REFRESH_INTERVAL` 15m → **5m** (auto-refresh lebih sering).
- Label header `auto 15m` → `auto 5m`.

**Hasil (diuji live ke Yahoo):** EUR/USD & USD/JPY candle umur **0 menit** (real-time), XAU/USD ~10 menit. Sebelumnya 2.2 jam. Badge `candle: X menit lalu` sekarang mencerminkan candle 1H berjalan, bukan jejak cron terakhir. `maxDuration: 60` di `vercel.json` cukup untuk dua fetch Yahoo paralel (timeout 12s each).

**Catatan:** independen dari cron — kalaupun `ohlcv_sync` (GitHub Actions / cron-job.org INFRA-1) telat, tab Analisa tetap fresh karena di-refresh saat dibuka.

---

## Changelog Session 130 (2026-06-30)

### Fix: Hapus cron ohlcv_sync dari vercel.json — deployment macet sejak session 128

**Root cause:** Session 128 menambahkan cron `"30 * * * *"` (setiap jam) ke `vercel.json`. Vercel Hobby plan hanya mengizinkan cron yang berjalan maksimal 1x per hari — cron hourly menyebabkan deployment **ditolak** untuk semua commit setelah `d4cca9f`. Production stuck selama 2+ jam.

**Fix:** Hapus entry `ohlcv_sync` dari array `crons` di `vercel.json`. OHLCV sync kembali hanya dijalankan via GitHub Actions (tiap jam di :00).

---

## Changelog Session 129 (2026-06-30)

### Hapus klik ke link eksternal dari headline berita (NEWS + TEK FJ), biarkan ActionForex tetap bisa diklik

**Masalah:** Klik pada headline berita di tab NEWS dan bagian "Berita Relevan" di tab TEK membuka link FinancialJuice yang tidak punya konten bermakna — hanya menampilkan headline ulang tanpa artikel/detail. ActionForex (AF) punya artikel lengkap, jadi linknya berguna.

**Perubahan (`index.html`):**
- `renderFeed()`: hapus `onclick` dari setiap `<div class="feed-item">` — NEWS feed tidak bisa diklik ke eksternal
- TEK FJ news (FinancialJuice per-pair): hapus `onclick` — tidak bisa diklik
- TEK AF news (ActionForex): **tetap bisa diklik** — pakai CSS class `.tek-news-item-link` (bukan inline style), hover judul berubah biru sebagai feedback visual
- CSS `.feed-item`: `cursor:pointer` → `cursor:default`, hapus `transform:scale(.98)` saat active
- CSS `.tek-news-item`: `cursor:default` sebagai default
- CSS tambah `.tek-news-item-link { cursor:pointer }` + hover warna judul — hanya berlaku untuk AF items
- Cleanup: hapus variabel `safeLink` yang tidak terpakai di feed dan FJ tek

**State akhir:**
| Area | Bisa diklik? |
|------|-------------|
| Tab NEWS — semua headline | ❌ tidak |
| TEK — FinancialJuice per-pair | ❌ tidak |
| TEK — ActionForex (AF · tek) | ✅ ya, buka artikel di tab baru |

---

## Changelog Session 128 (2026-06-30)

### OHLCV sync resilience: Vercel cron backup + Binance PAXG fallback

**Root cause temuan:** Yahoo Finance GC=F data sebenarnya fresh (delay ~10 menit). Penyebab "2.8 jam lalu ⚠" adalah GitHub Actions ohlcv-sync **gagal untuk 2–3 run berturut-turut** (09:00, 10:00 UTC), bukan Yahoo yang lambat.

**Fix 1 — Vercel cron backup (dibatalkan)**
- ~~Tambah entry `ohlcv_sync` di cron Vercel: `"30 * * * *"`~~ — dihapus di session 130 karena Hobby plan hanya boleh cron 1x/hari; cron hourly menyebabkan deployment gagal total
- OHLCV sync kembali hanya via GitHub Actions at :00

**Fix 2 — Binance PAXG fallback (`api/admin.js`)**
- `fetchYahooOhlcv1h('GC=F')` sekarang di-wrap dalam try-catch
- Jika Yahoo error (HTTP non-200, no chart result, 0 valid candle) → fallback otomatis ke Binance PAXGUSDT 1H klines
- Binance public endpoint, no auth, real-time (update tiap trade)
- PAXG = 1 troy oz gold stored di Brink's vault, harga tracks XAU spot dalam ~0.1%
- Fallback fetch 250 candles (≈10 hari) agar 4H resampling tetap punya coverage penuh
- FX pairs lain tidak terpengaruh — fallback hanya aktif untuk `symbol === 'GC=F'`

---

## Changelog Session 127 (2026-06-30)

### [QUAL-3] Label frame di thesis card dan prose section (`index.html`)

Pendekatan: bukan menyamakan output Call 1 dan Call 3, tapi memberi label konteks di UI agar user tahu keduanya menjawab frame berbeda.

- `renderThesisCard`: label header `AI THESIS` → `AI THESIS · CB BIAS + TA`
- `renderArticleSections`: tambah `<div class="ringkasan-fx-label">ANALISIS BERITA · HEADLINE MOMENTUM</div>` di atas prose FX (kedua path: dengan dan tanpa XAU section)
- Dashboard thesis card (baris ~11568): `AI THESIS · FX` → `AI THESIS · FX · CB BIAS + TA`
- CSS: tambah `.ringkasan-fx-label` (warna `var(--accent)` merah, style konsisten dengan `.ringkasan-xau-label`)

**Rationale:** Call 1 menilai dari momentum headline, Call 3 dari CB bias + TA — keduanya bisa valid sekaligus. Inkonsistensi bukan bug, tapi perbedaan frame. Label ini membuat perbedaan frame visible tanpa memaksakan salah satu mengalah.

---

## Changelog Session 126 (2026-06-30)

### Sisa Backlog Opsional (D) — 5 tugas selesai

**[A2.3 Fase 2] Push notification kategori per-user (`api/subscribe.js`, `api/admin.js`, `index.html`)**
- `subscribe.js`: terima body field `categories[]`; simpan bersama subscription JSON di Redis. Default: `['market-moving', 'econ-data']` jika tidak dikirim (kompatibel mundur dengan subscriber lama).
- `admin.js` (pushHandler): ubah dari single `sendWebPush(allSubs, payload)` ke per-item loop dengan filter per-subscriber. `market-moving` selalu kirim ke semua; kategori lain diperiksa vs `sub.categories`. Stale key deduplikasi sebelum `HDEL`.
- `index.html`: tambah modal "Pilih Kategori Push" (6 kategori, `market-moving` locked-checked). Muncul saat aktivasi pertama dan bisa dibuka ulang via tombol "Kategori Push" di header dropdown (tersembunyi saat notif mati). Preferensi disimpan ke `localStorage`.

**[B2 4.0c] Top-2 swing points 4H (`api/admin.js`)**
- `_findSwings()`: return `swing_highs[]` dan `swing_lows[]` (2 terbaru masing-masing) + `last_swing_high/low` backwards compat.
- `loadOhlcvData` h4 block: tambah `swing_highs` dan `swing_lows` array.
- `buildOhlcvText`: tampilkan kedua swing per sisi sebagai "lama→baru" — AI punya lebih banyak anchor level untuk SL/TP.

**[B3 COR-G] BTC + gold ratio synthetics di korelasi (`api/correlations.js`)**
- `INSTRUMENTS`: tambah `BTC: 'BTC-USD'` (Yahoo Finance).
- `GOLD_CORR_ASSETS`: tambah `'BTC'`, `'GoldSilverRatio'`, `'GoldCopperRatio'`.
- Setelah fetch raw data: hitung `GoldSilverRatio` (Gold.close / Silver.close) dan `GoldCopperRatio` (Gold.close / Copper.close) sebagai derived series — dimasukkan ke matriks korelasi dan `goldCorr`.
- `CACHE_KEY`: `correlations_v2 → correlations_v3` (shape berubah). Reference di market-digest.js juga diupdate.

**[QUAL-11] Sederhanakan penutup Call 1 + validasi pembuka di kode (`api/market-digest.js`)**
- Gabungkan `REMINDER FINAL` + `CEK SEKALI LAGI` (3× pengecekan) jadi 1 `CEK AKHIR SEBELUM KIRIM` yang ringkas — hemat ~200 token prompt.
- Tambah code-level opening validation: setelah Call 1 sukses, cek apakah kalimat pertama dimulai dengan opener terlarang (`FORBIDDEN_OPENERS`). Jika ya: `console.warn` + masuk `providerLog` sebagai `bad_opener:...`.

**[QUAL-17] Refactor `userMsg` ohlcv_analyze ke array (`api/admin.js`)**
- Pecah 1 template literal raksasa (~800 karakter per baris) jadi `[...].join('\n')` seperti pola `biasPrompt`/`thesisPrompt`.
- Logika tidak berubah, isi prompt identik — murni maintainability.

---

## Changelog Session 125 (2026-06-30)

### Audit Ketahanan & Kualitas AI (Blok C dari daun_merah_plan.md) — 8 tugas selesai

**C1 — Pisahkan circuit breaker per-akun SambaNova (`api/market-digest.js`)**
- Tambah konstanta `CB_SAMBA_C1 = 'ai:sambanova:c1'` (Call 1 prosa, akun 2) dan `CB_SAMBA_MAIN = 'ai:sambanova:main'` (Call 2/3/4, akun 1).
- Ganti semua `'ai:sambanova'` literal → konstanta yang tepat. Grep hasilnya 0 literal tersisa.
- Efek: kegagalan Call 2/3/4 tidak lagi menjatuhkan Call 1 akun 2 yang sehat.
- `admin.js`: `KNOWN_CIRCUITS` diupdate ke `'ai:sambanova:c1'` dan `'ai:sambanova:main'`.

**C2 — Budget waktu dinamis + pangkas timeout (`api/market-digest.js`)**
- `handlerStart = Date.now()` ditambah di awal handler.
- Timeout Call 1 SambaNova `28s → 22s`, Groq prose `20s → 15s`. Worst-case Call 1 = 22+15+15 = 52s (di bawah 60s).
- Guard `CALL3_BUDGET_MS = 50000` ditambah sebelum Call 3: kalau elapsed > 50s, Call 3 di-skip (UI tetap sajikan `latest_thesis` lama dari Redis).

**C3 — Naikkan headroom max_tokens JSON + deteksi truncation (`api/market-digest.js`)**
- Call 2 & 4: `400 → 700` token. Call 3: `500 → 800` token (ruang untuk token reasoning DeepSeek).
- `aiCall`: tambah log `finish_reason === 'length'` sebelum return — tidak ubah return shape.

**C4 — Fallback `fundamental_analysis` + breaker `ohlcv_analyze` (`api/admin.js`)**
- `require('./_circuit_breaker')` ditambah ke admin.js.
- `fundamentalAnalysisHandler`: Groq-first → SambaNova akun 1 fallback; return 500 hanya kalau keduanya gagal.
- `ohlcvAnalyzeHandler`: wrap call SambaNova dengan `cb.canCall('ai:sambanova:main')` + onSuccess/onFailure.

**C5 — Headline mentah sebagai jangkar fakta Call 3 (`api/market-digest.js`) — DRAFT**
- `rawHeadlinesForThesis` (15 headline pertama dari `headlinesForBriefing`) ditambah ke `thesisPrompt`.
- Instruksi: "If the prose briefing contradicts these raw headlines, prioritise the raw headlines."
- **Tandai DRAFT — menunggu review user** (aturan C: prompt menyimpan preferensi gaya tulisan).

**C7 — Validasi override `prompt_digest` (`api/market-digest.js`)**
- Tambah `isValidDigestPrompt(p)`: min 1000 char + ada marker `'XAUUSD'` dan `'ATURAN FX'`.
- Override invalid → diabaikan, pakai `DIGEST_SYSTEM_DEFAULT`, ada log warning.

**C8 — Penegakan frasa terlarang via kode (`api/market-digest.js`)**
- Tambah `FORBIDDEN_PHRASES` array di level modul (sinkron dengan daftar di prompt).
- Setelah Call 1 sukses, cek `article.toLowerCase()` terhadap array.
- Hits di-log + masuk `providerLog` sebagai `forbidden:N`. Tak ada auto-edit teks (Tahap 1 = observability saja).
- `quality_flags: { forbidden_phrases: [...] }` ditambah ke payload response (UI abaikan — hanya untuk diagnostik).

**C6 — Hint halus model cadangan di UI (`index.html`)**
- Badge `.ringkasan-method` mendapat `title` attribute "model cadangan — gaya naratif mungkin kurang tajam" saat `method` adalah `gpt-oss-120b`, `groq`, atau `qwen3-32b`.
- Tambah span kecil "(model cadangan)" dalam warna `--muted` di sebelah badge.

---

## Changelog Session 124 (2026-06-30)

### 4 UX + Feature Improvements

**1. Fix header scroll — always visible di scrollTop===0**

**Root cause:** Scroll listener memiliki `ignoreUntil` window (520ms setelah collapse, 640ms setelah reveal) yang memblokir semua event scroll termasuk `scrollTop===0`. Jika user scroll ke atas dengan cepat dalam window transisi, header tetap collapsed — flickering dan inconsistent.

**Fix (`index.html`, scroll listener):**
- Tambah `pendingTopReveal` (setTimeout) + helper `schedulePendingReveal(el)` / `cancelPendingReveal()`.
- Jika `scrollTop===0` dalam `ignoreUntil` window: jadwalkan deferred reveal yang muncul tepat setelah window berakhir + 60ms buffer.
- Jika `scrollTop===0` di luar window: reveal langsung (behavior sebelumnya).
- Jika user scroll ke bawah (`delta > 0`): `cancelPendingReveal()` — tidak perlu reveal kalau user lagi turun.
- Browser-clamping loop tidak terjadi karena: (a) saat timer fire kita cek ulang `scrollTop===0` + `chrome-collapsed`, (b) setelah reveal, `ignoreUntil=640ms` menghalau re-trigger dari browser clamp.

**2. Stats bar (Total/Mkt Moving/Forex/Macro/Energy/Geopolit) hanya tampil di NEWS**

- `setFeedUI(show)` diperluas: selain toolbar dan navFilters, sekarang juga toggle `#statsBar` (`display: flex/none`).
- Di semua view selain NEWS, stats bar disembunyikan → header lebih ringkas, hanya regime banner + nav tabs yang terlihat.

**3. Berita Terkait (tab TEK) — tambah image toggle seperti di NEWS**

- `renderTekNews()` sekarang menambahkan logic yang sama dengan `renderFeed()` untuk item FinancialJuice (GUID numerik):
  - Panggil `fjImageType(item.title)` untuk deteksi chart/tabel.
  - Render `<button class="feed-chart-toggle">` + `<div class="feed-chart-wrap"><img>` jika terdeteksi.
  - Gunakan ID unik `fjImg-tek-{guid}` untuk menghindari konflik dengan NEWS panel.
  - Reuse `toggleFJImg()` yang sama.

**4. TEK_CUR_KEYWORDS & TEK_SHARED_KEYWORDS — expanded + sorted by relevance**

- Semua 9 currency lists (`XAU`, `USD`, `EUR`, `GBP`, `JPY`, `AUD`, `NZD`, `CAD`, `CHF`) diperluas secara signifikan.
- Keyword disusun dari paling relevan/high-signal (primary driver) ke konteks sekunder.
- `XAU`: tambah real yield, etf flow, have demand keywords.
- `USD`: tambah fed-related terms (fomc minutes, dot plot, federal funds), pce/labor data.
- `EUR`: tambah ecb meeting terms, bund yield, individual country data (france, italy).
- `GBP`: tambah boe minutes, gilt yield, political keywords (keir starmer, labour).
- `JPY`: tambah boj intervention, jgb, carry trade detail.
- `AUD`: tambah china linkage (massive driver), specific commodity/mining data.
- `NZD`: tambah rbnz rate path, nz housing, fonterra detail.
- `CAD`: tambah oil inventory/eia, nat gas, us-canada trade relationship.
- `CHF`: tambah snb intervention, safe haven framing, eu/swiss linkage.
- `TEK_SHARED_KEYWORDS`: diurut risk sentiment → geopolitik → geografi → macro global.
- Result cap ditingkatkan dari 10 → 15 item di `renderTekNews()`.

---

## Changelog Session 123 (2026-06-30)

### Fix: Scroll balik ke atas sendiri di panel Fundamental (laptop)

**Root cause:** Chrome collapse listener memiliki bypass `scrollTop === 0` yang diprioritaskan di atas `ignoreUntil` window. Ketika header collapse menyebabkan panel fundamental tumbuh lebih besar dari kontennya, browser men-clamp `scrollTop` ke 0, yang langsung men-trigger reveal header. Reveal memperkecil panel → konten overflow lagi → user bisa scroll → header collapse lagi → loop.

**Fix dua lapis (`index.html`, scroll listener):**
1. `ignoreUntil` dicek **sebelum** `scrollTop === 0` — browser clamping dalam window transisi tidak memicu reveal.
2. Collapse hanya terjadi jika `scrollHeight > clientHeight + chromeH` (konten masih bisa di-scroll setelah chrome hilang). Jika tidak, header tidak disembunyikan sama sekali.

---

## Changelog Session 122 (2026-06-30)

### Audit fitur Fundamental — 3 bug fix

**Temuan audit mendalam:**

1. **Bug CRITICAL — NZD Employment Change tidak pernah diupdate dari headline** (`api/_fundamental_parser.js`):
   - `QUANTITY_INDICATORS` men-reject nilai `%` untuk key `'Employment Change'`
   - NZD melaporkan Employment Change sebagai QoQ % (e.g. "NZ Employment Change QoQ 0.2%") — berbeda dengan USD/GBP/AUD/CAD yang menggunakan count (K)
   - Akibatnya semua headline "New Zealand Employment Change" dibuang silent oleh parser setelah nilai diekstrak sebagai "%"
   - **Fix:** Hapus `'Employment Change'` dari `QUANTITY_INDICATORS`. Key NFP tetap di-reject jika %, karena NFP secara definitif selalu dalam ribuan. NZD sekarang bisa diupdate dari headline.

2. **Bug display — GDP Nowcast, Core PCE YoY, Core CPI YoY jatuh ke seksi "Lainnya"** (`index.html`):
   - Ketiga indikator bisa diparse/ditulis ke Redis (GDP Nowcast dari Atlanta Fed, Core PCE YoY dan Core CPI YoY dari headline disambiguation), tapi tidak ada di `FUND_SECTIONS_MAP`
   - **Fix:** Tambah `'GDP Nowcast':'Pertumbuhan'`, `'Core PCE YoY':'Inflasi'`, `'Core CPI YoY':'Inflasi'` ke `FUND_SECTIONS_MAP`

3. **Bug scoring — GDP Nowcast, Core PCE YoY, Core CPI YoY tidak berkontribusi ke skor currency** (`index.html`):
   - Tidak ada di `FUND_SCORE_RULES` dan `IND_DIR`
   - **Fix:** Tambah ke `FUND_SCORE_RULES` (GDP Nowcast threshold 2.0, Core PCE/CPI YoY threshold 2.0, dir 1 semua) dan `IND_DIR` (value 1 semua)

4. **Bug parser — 4 keyword FUND_PREFIX_MAP hilang → rilis penting tidak ter-assign ke currency** (`api/_fundamental_parser.js`):
   - Headline "US Durable Goods Orders" — tidak ada `'us durable'` → ditolak, tidak masuk USD
   - Headline "UK Average Earnings Index" — `'uk earnings'` BUKAN substring dari "uk average earnings" → tidak match GBP (note: "uk" + " average" + " earnings" ≠ "uk earnings"). `'uk wage'` juga tidak match.
   - Headline "Japan Current Account" — tidak ada `'japan current account'` → tidak masuk JPY
   - Headline "Eurozone Current Account" — tidak ada `'eurozone current account'` → tidak masuk EUR
   - **Fix:** Tambah keyword yang hilang ke masing-masing currency di `FUND_PREFIX_MAP`

---

## Changelog Session 121 (2026-06-30)

### Extend deteksi gambar inline NEWS — chart + tabel/probabilitas/matrix

**Konteks:** Session 116 menambahkan toggle gambar inline untuk headline chart FinancialJuice (mekanisme: FJ render konten visual sebagai PNG statis di `/images/{guid}.png`, CORS terbuka). Waktu itu, kasus serupa untuk headline "policy probabilities" (tabel) ditunda karena belum ada contoh live. User sekarang kirim dua sample URL konfirmasi: `financialjuice.com/News/9657761/SNB-Interest-Rate-Probabilities.aspx` dan `financialjuice.com/News/9657748/90-Day-Correlation-Matrix.aspx` — keduanya dikonfirmasi via fetch: gambar tersedia di `/images/{id}.png` dengan CORS terbuka, pola identik dengan chart. Tabel dalam bentuk gambar statis, bukan HTML tabel.

**Perubahan (`index.html`):**
- `isChartHeadline(title)` → `fjImageType(title)` — return `'chart'` | `'table'` | `null` alih-alih boolean. Regex chart tetap `/\bchart\b/i`; regex tabel baru `/\b(probabilit|matrix|heatmap)\b/i` (menangkap "probabilities", "probability", "matrix", "heatmap" sekaligus).
- `toggleChartImg(btn, id)` → `toggleFJImg(btn, id)` — pakai `btn.dataset.labelShow`/`btn.dataset.labelHide` (data-attribute di button) alih-alih hardcode string "Lihat Chart" — satu fungsi cukup untuk semua tipe tanpa if-else.
- `renderFeed`: label dan emoji dibedakan per tipe — chart: `📊 Lihat Chart ▾`/`Sembunyikan Chart ▴`, tabel: `📋 Lihat Gambar ▾`/`Sembunyikan Gambar ▴`. Variabel `chartId`/`chartHtml` di-rename `fjImgId`/`chartHtml` (chartHtml dipertahankan karena terkait template string yang sama).

**Testability:** Lolos `node -c`. Regex diverifikasi terhadap dua URL sample live (kedua gambar berhasil diakses di `/images/{id}.png`). Belum dites visual di browser — perlu deploy untuk konfirmasi toggle expand/collapse dan label yang benar muncul di headline probability/matrix vs chart.

---

## Changelog Session 120 (2026-06-30)

### Audit UX psikologi — 6 fix animasi + RBA Minutes feed ditambahkan

**UX Psikologi — 6 perbaikan animasi (`index.html`):**

- **Toast entrance** `ease` → `ease-out`: animasi masuk terasa lebih responsif (langsung cepat, bukan lambat di awal).
- **Toast exit**: sebelumnya `display:'none'` instan (hilang tiba-tiba), sekarang punya animasi `slideUp .2s ease-in` sebelum disembunyikan. Fungsi `_toastHide()` ditambahkan; `showToast()` force display-cycle `none → block` + `void offsetWidth` agar `slideDown` selalu restart saat toast baru masuk di atas toast yang sedang jalan.
- **3 Modal (MT5, Override, Speed)** sebelumnya muncul instan tanpa animasi. Sekarang inner box tiap modal punya `animation: modalIn .28s cubic-bezier(0.16,1,0.3,1)` — scale 95%→100% + translateY 14px→0. Karena parent modal pakai `display:none → display:flex`, animasi restart otomatis setiap modal dibuka.
- **Drawer panel** — easing sebelumnya identik untuk buka dan tutup (`.22s ease`). Sekarang asimetris: buka `.28s cubic-bezier(0.16,1,0.3,1)` (ease-out-expo, datang responsif lalu landing halus), tutup `.18s ease-in` (cepat pergi). Overlay backdrop juga: buka `ease-out .25s`, tutup `ease-in .18s`.
- **Feed items** `ease` → `ease-out`: sebelumnya item baru muncul dengan rasa "lambat bangun" (slow-start). Sekarang langsung terasa hadir.
- **Status dot live vs warn**: sebelumnya keduanya `blink 2s infinite` — tidak ada beda urgensi visual. Sekarang `live` (hijau) = `1.4s ease-in-out` (steady heartbeat), `warn` (kuning) = `0.9s ease-in-out` (lebih cepat, mencerminkan urgency).

**RBA feeds diperluas + audit semua link (`api/feeds.js`):**

- Sebelumnya hanya `rss-cb-speeches.xml`. Ditambahkan `RBAM` (minutes) dan `RBAS` (statements) via rss2json.
- Hasil audit menyeluruh semua CB_RESEARCH_SOURCES (tested via PowerShell):
  - FED, FOMC, FEDN, ECB, ECBB, MTM, ING → ✅ semua OK
  - **BIS**: rss2json tidak perlu, direct fetch works → diubah ke direct. Parser `parseCBRSSItems` regex diupdate dari `<item>` ke `<item\b[^>]*>` untuk support RDF/RSS 1.0 format yang BIS gunakan.
  - **BOC**: `feed/speeches/` URL sekarang return HTML (URL berubah) → difix ke `feed/` (general feed, valid RSS).
  - **BOJ**: RSS feeds dihapus total setelah redesign 2024, semua URL 404/timeout → di-remove dari sources.
  - **BOE (Bank of England)**: belum ter-cover padahal bisa diakses langsung dari Vercel → ditambahkan `BOE` (speeches) dan `BOEP` (publications). Penting untuk GBP pairs.
  - **RBA**: Blocked di semua proxy yang ditest (direct 403, rss2json 500, allorigins 500) → entri dipertahankan, kalau rss2json pulih akan otomatis jalan.
  - **RBNZ, SNB**: 403 dari semua jalur → tidak bisa di-cover saat ini.

### Fix layout shift saat header collapse/reveal — swap easing max-height

**Konteks:** User melaporkan komponen di bawah header "tiba-tiba naik/turun sangat cepat" saat header hilang/muncul. Analisa sebelumnya salah fokus ke easing header itu sendiri, padahal masalah utama adalah **layout shift dari flex children** akibat height header berubah.

**Root cause:** `#topChrome` ada di dalam `body { display: flex; flex-direction: column }`. Saat max-height collapse/reveal, seluruh flex children di bawahnya (navFilters, toolbar, content area) ikut bergeser. Dengan max-height 420px tapi tinggi konten aktual ~160px:
- **260px pertama** (420→160) tidak terlihat — animasi "buang waktu" di zona invisible
- **160px terakhir** (160→0) baru terlihat — tapi bagian paling cepat dari kurva ease-in → visible duration hanya ~44ms (bukan 220ms)
- Efeknya: konten di bawah bergeser hampir seketika (44ms), bukan smooth

Hal yang sama terjadi untuk reveal (0→420 dengan ease-out-expo sangat cepat di awal) → visible zone 0→160px selesai dalam ~30ms → content "lompat turun".

**Fix: swap easing untuk max-height** (berlawanan dengan intuisi umum, karena ada invisible zone):

| Arah | Easing max-height | Kenapa |
|------|------------------|--------|
| Collapse (420→0) | `ease-out` | Fast di invisible zone (420→160), SLOW di visible zone (160→0) → content glides up |
| Reveal (0→420) | `ease-in` | SLOW di visible zone (0→160), fast di invisible zone (160→420) → content glides down |

Durasi visible naik dari ~44ms → **~183ms** (collapse) dan ~30ms → **~236ms** (reveal). Content shift terasa seperti smooth slide, bukan lompatan.

**Perubahan CSS (`index.html`):**
- Reveal: `max-height .38s ease-in, opacity .30s ease-out` (ganti dari `.42s cubic-bezier(0.16,1,0.3,1)`)
- Collapse: `max-height .30s ease-out, opacity .22s ease-out` (ganti dari `.22s ease-in, opacity .18s ease-in`)
- Opacity juga diubah ke `ease-out` untuk keduanya — mulai fade langsung tanpa "sudden snap" di akhir

---

### Fix horizontal overflow di panel scroll

**Root cause:** `.feed-scroll` hanya punya `overflow-y:auto` tanpa `overflow-x:hidden`. Konten anak yang melebar (terutama elemen dengan `white-space:pre-wrap` tanpa `word-break`) menyebabkan panel ikut melebar horizontal saat di-scroll ke bawah — terlihat jelas di Split View desktop.

**Fix:**
- `overflow-x:hidden` ditambahkan ke `.feed-scroll` (fix di level container)
- `word-break:break-word; overflow-wrap:break-word` ditambahkan ke `.jn-ai-body` dan `.fund-analysis-text` (keduanya pakai `white-space:pre-wrap` — sumber utama overflow)
- `overflow-wrap:break-word` ditambahkan ke `.ringkasan-text` dan `.thesis-val`

---

### Header reveal lebih smooth — ease-out-expo + scroll accumulator

**Konteks:** User feedback bahwa header yang naik kembali setelah scroll terasa "tiba-tiba" dan "forceful" dari sisi UX pengguna.

**Root cause:** Dua masalah terpisah:
1. `max-height` transition dari `0 → 420px` tidak proporsional — browser interpolasi rentang penuh (0–420px) tapi konten asli jauh lebih pendek (~130px), sehingga kurva easing tidak selaras dengan visual nyata. Hasilnya: header "melesat" masuk di awal animasi lalu tiba-tiba berhenti.
2. Threshold reveal terlalu sensitif — scroll naik 7px (barely above 6px minimum threshold) sudah trigger header muncul, terasa tidak disengaja.

**Perbaikan (`index.html`):**

- **CSS — pisah easing collapse vs reveal:**
  - *Reveal* (class dilepas): `max-height .42s cubic-bezier(0.16, 1, 0.3, 1), opacity .35s ease-out` — ease-out-expo: muncul cepat di awal lalu melambat halus mendekati posisi akhir. Lebih panjang (420ms) supaya ada waktu untuk "landing" yang lembut.
  - *Collapse* (class ditambah): `max-height .22s ease-in, opacity .18s ease-in` — cepat pergi, tidak menarik perhatian. Sebelumnya sama-sama `.28s ease` untuk keduanya.

- **JS — scroll accumulator 60px sebelum reveal:** WeakMap `upAccum` per scroll-container mencatat akumulasi pixel scroll-naik. Reset saat arah berbalik ke bawah. Header hanya muncul setelah akumulasi ≥ 60px — mencegah trigger dari jiggle/inersia ringan. Sebelumnya: setiap delta negatif langsung trigger reveal.

---

## Changelog Session 119 (2026-06-29)

### Filter usulan "design psychologist": Split View 3-window otomatis + dots bobot bukti CB divergence

**Konteks:** User minta saya berperan sebagai "design psychologist" untuk audit UX. Dari 4 usulan besar (Synth View pinning, adaptive theme, checklist empatik, AI interaktif), saya filter berdasar kriteria "tetap profesional/high-value, bukan consumer-app gimmick" — Synth View pinning ditolak user sendiri (tidak cocok untuk bagian informatif), diganti konsep lebih simpel: tombol auto-arrange 3 window. Adaptive "Calm" theme & forced-pause checklist saya rekomendasikan skip (dark-pattern/melemahkan identitas terminal serius), user setuju. AI drill-down diskip user karena belum perlu sekarang. Disepakati: Split View + dots bobot bukti checklist.

**Split View — 3 window otomatis (`index.html`):**
- Item baru di header kebab menu: "Split View (3 Window)" — sekali klik buka `TEK`, `NEWS`, `RINGKASAN` (urutan default kiri→kanan, array `SPLIT_VIEW_LAYOUT`) sebagai 3 window terpisah, posisi & lebar dihitung otomatis dari `screen.availWidth`/`availHeight` dibagi rata — menggantikan popout manual satu-satu + drag-resize sendiri.
- Reuse mekanisme `popoutView()`/`restoreViewFromHash()` yang sudah ada (window baru dibuka dengan hash `#view`, auto-landing ke tab yang benar) — tidak ada infrastruktur baru, cuma orkestrasi 3x `window.open` dengan koordinat berbeda.
- Guard `innerWidth < 1024` → toast "Khusus Desktop" alih-alih maksa buka 3 window kecil di HP yang tidak ada gunanya.

**Checklist — dots bobot bukti CB divergence (`index.html`):**
- Playbook **Macro Momentum**, section CB DIVERGENCE, item `mm_cb2` ("Perbedaan bias minimal 2 level") sekarang dapat indikator visual ●●○ di samping label — terisi 1-3 sesuai jarak bias aktual kedua currency pair di `HAWK_DOVE_AXIS` (5 level murni: Dovish→Hawkish, label ortogonal Data Dependent/On Hold/Split sengaja dikecualikan karena tidak comparable).
- Dihitung dari `cbData` yang sama dipakai auto-tick `rc2` yang sudah ada (reuse, tidak ada fetch baru) — dipanggil dari `ckAutoTickRegimeCheck()` setiap kali pair di Checklist berubah.
- **Sengaja tidak auto-centang** — beda dari `ckAutoTick`/`ckAutoBlock` yang mengubah `ckState`, fungsi baru `ckShowEvidenceDots()` cuma nempelin elemen visual terpisah (`.ck-evidence-dots`), item tetap manual dicentang user. Alasan: 3 kondisi lain di section yang sama (narrative belum berubah, real yield mendukung, dst) tetap butuh judgment, jadi dots ini cuma "bukti pendukung" bukan keputusan pass/fail.
- Tooltip di dots menunjukkan nilai mentah (`"USD: Hawkish · JPY: Cautious Dovish — jarak 3 level"`) — user bisa audit sendiri kenapa dots-nya segitu, bukan percaya buta ke indikator visual.

**Testability:** Lolos `node -c`/inline-script syntax check. Logika mapping jarak axis→level dots diverifikasi simulasi Node terhadap 4 skenario (Hawkish/Dovish, Hawkish/Neutral, Cautious×2, Neutral/Neutral) — semua sesuai ekspektasi. `openSplitView()` (positioning window, guard mobile) dan render dots di DOM nyata belum dites manual di browser — perlu verifikasi visual setelah deploy, khususnya apakah popup blocker browser mengizinkan 3x `window.open` berurutan dari satu klik.

---

## Changelog Session 118 (2026-06-29)

### Gabung tombol SUARA+settings jadi segmented pill, top chrome collapse otomatis saat scroll

**Konteks:** Lanjutan session 117. User screenshot toolbar NEWS (SUARA + ⚙ tampil sebagai 2 kotak terpisah, berdesakan dengan AUTO/FETCH) minta dirapikan. Lalu diskusi soal navbar yang "ikut bergeser" saat scroll — diperkuat dengan screenshot 3 window desktop yang menunjukkan header+regime-banner+stats-bar+nav-views menumpuk 4 lapis sebelum konten, bikin app kerasa sempit terutama di window kecil/HP.

**Konsolidasi tombol SUARA+⚙ (`index.html`):**
- Dibungkus jadi satu `.voice-control-group` (border tunggal, garis pemisah tipis di dalam) menggantikan 2 tombol dengan border masing-masing — bobot visual setara 1 tombol FETCH, bukan 2 kotak lepas.

**Top Chrome collapse-on-scroll (`index.html`):**
- Header + Regime Banner + Stats Bar + Nav-Views (tab switcher desktop: NEWS/RINGKASAN/ANALISA/dst) dibungkus `#topChrome` — collapse otomatis (`max-height` + opacity transition) saat scroll ke bawah di panel manapun yang aktif, muncul lagi saat scroll ke atas.
- App ini bukan satu halaman yang di-scroll (`body{overflow:hidden}`, tiap tab punya scroll container `.feed-scroll` sendiri-sendiri: `#feedScroll`, `#calPanelInner`, `#teknikalPanel`, dst) — listener dipasang SEKALI secara global di `document` dengan `{capture:true, passive:true}`, menangkap scroll event dari descendant manapun tanpa perlu didaftarkan per-panel (scroll event tidak bubble tapi tetap lolos capture phase).
- Threshold 6px (anti-jiggle dari inersia scroll) + baru collapse setelah `scrollTop > 40` (tidak langsung collapse di awal scroll sedikit).
- Nav-Filters (kategori) dan Toolbar per-view (AUTO/SUARA/FETCH, atau symbol/timeframe bar di TEK) **sengaja tidak** diikutkan ke grup collapse — isinya kontrol aktif yang sering dipencet sambil baca/lihat chart, beda dari header/regime/stats yang sifatnya info pasif.
- Berlaku universal termasuk tab TEK (chart) — dikonfirmasi `#teknikalPanel` juga pakai class `.feed-scroll` (`overflow-y:auto`), jadi ke-detect listener yang sama.

**Testability:** Lolos `node -c`/inline-script syntax check. Animasi collapse, threshold scroll, dan perilaku di tab TEK belum dites manual di browser nyata (hanya verifikasi struktural: CSS `max-height` transition + scroll listener attach point + konfirmasi `.feed-scroll` di semua panel target) — perlu cek visual setelah deploy.

---

## Changelog Session 117 (2026-06-29)

### Fix bug HTML mentah di artikel FJElite, fitur voice readout headline, konsolidasi menu header, hapus fitur share

**Konteks:** Lanjutan session 116. User screenshot artikel FJElite di tab ARTIKEL menampilkan tag HTML mentah (`<div>`, `<br />`, `<ul><li>`) sebagai teks — ditemukan bug nyata di `sanitizeDesc()`. Diskusi lanjut soal fitur Voice widget FinancialJuice (cuma TTS, bukan data eksklusif) berujung ke permintaan bikin fitur serupa sendiri dengan kontrol lebih baik (kategori custom, batching anti-noise). Sekaligus user minta hapus fitur share (dianggap tidak penting) dan rapikan header (kebanyakan ikon lepas).

**Fix bug HTML mentah (`index.html`):**
- Root cause: `sanitizeDesc()` strip HTML tag SEBELUM decode entity. Description FinancialJuice datang dalam bentuk entity-escaped (`&lt;div&gt;` bukan `<div>`), jadi step strip-tag tidak nemu apa-apa untuk dihapus; entity baru di-decode SETELAHNYA, menciptakan tag asli sebagai teks. Diperbaiki: urutan dibalik (decode dulu, baru strip tag+script/style).
- Ini juga menutup risiko keamanan nyata: description ber-entity-escape yang berisi `<script>` sebelumnya bisa lolos jadi teks literal lalu disisipkan via `innerHTML` di NEWS feed tanpa di-escape ulang — dengan urutan baru, script/style block ikut terstrip setelah decode, sebelum sempat masuk DOM.
- `sanitizeDescMultiline()` baru — khusus body artikel FJElite panjang, menjaga jeda paragraf (`<div>`/`<p>`/`<br>` → newline) dan bullet list (`<li>` → `• `) instead of diratakan jadi satu baris seperti `sanitizeDesc()` biasa (yang tetap dipakai apa adanya untuk preview singkat di NEWS).
- Diverifikasi via simulasi Node: paragraf terpisah benar, bullet list terformat `•`, dan entity-escaped `<script>` terbukti terstrip bersih (tidak nongol sebagai teks maupun tereksekusi).

**Fitur Voice Readout — TTS headline penting (`index.html`):**
- Tombol 🔊/🔇 di toolbar NEWS (ikon SVG, bukan emoji — ikut warna tema via `stroke="currentColor"`) — toggle manual, default mati, reset ke mati tiap reload (keputusan user: bukan fitur diam-diam selalu jalan).
- Tombol ⚙ di sebelahnya buka panel kategori (11 kategori, chip toggle) — preferensi kategori dipersist ke `localStorage` (beda dari toggle utama yang session-only).
- Default kategori: **market-moving + econ-data saja** (disamakan persis dengan `PUSH_CATS` di `api/admin.js` — keputusan eksplisit user untuk konsistensi minim-noise dengan push device yang sudah ada).
- Anti-noise batching: kalau 1 headline baru lolos filter → dibacakan penuh (`lang=en-US`, sesuai bahasa asli headline). Kalau >1 muncul bersamaan dalam satu siklus polling → cuma diucapkan ringkasan jumlah ("N berita penting baru", `lang=id-ID`), tidak dibaca satu-satu — mencegah rilis data beruntun numpuk jadi antrian suara berisik (sesuai keputusan user di pertanyaan klarifikasi).
- `speechSynthesis.speak()` dengan utterance kosong dipanggil saat toggle diaktifkan (di dalam user-gesture click) untuk "unlock" TTS di browser yang membatasi speak() pertama harus dari interaksi user — supaya panggilan otomatis berikutnya dari `fetchFeed()` (bukan user gesture) tidak diam-diam gagal.

**Konsolidasi menu header (`index.html`):**
- 3 tombol icon lepas di header (🔔 notif, ⤴ share, ⧉ popout) → digabung jadi 1 tombol kebab menu (⋮) yang buka dropdown kecil berisi 2 item: Notifikasi, Buka di Window Baru.
- Logic toggle notif yang sudah ada (`toggleNotif()`, status `.enabled`, dst) tidak diubah sama sekali — elemen `#notifBtn`/`#popoutBtn` cuma dipindah ke dalam dropdown dengan class baru, semua `classList`/id reference lama tetap valid.
- Click-outside-to-close + auto-close saat klik salah satu item.

**Hapus fitur share (`index.html`):**
- Tombol `⤴` (`shareBtn`), fungsi `shareCurrentView()`, dan const `SHARE_VIEW_LABELS` dihapus total atas permintaan user ("ga penting"). Tidak ada sisa referensi (diverifikasi via grep).

**Testability:** Semua perubahan lolos `node -c`/inline-script syntax check via `new Function()`. Fix `sanitizeDesc`/`sanitizeDescMultiline` diuji simulasi Node terhadap 3 skenario (paragraf, list, XSS entity-escaped script) — semua sesuai ekspektasi. Voice readout & header menu dropdown belum dites manual di browser nyata (interaksi klik, TTS audio actual, click-outside behavior) — perlu verifikasi visual setelah deploy.

---

## Changelog Session 116 (2026-06-29)

### Kalender ekonomi pindah ke TradingView (actual asli) + minggu depan, fix FJElite, chart inline FinancialJuice

**Konteks:** Diskusi dimulai dari pertanyaan "bisa scrape kalender tradinghub.id/fxstreet/myfxbook?" — semua dicek dan ternyata cuma proxy ForexFactory (tradinghub.id) atau diblokir Cloudflare (fxstreet, myfxbook). Investigasi berlanjut menemukan endpoint publik TradingView yang ternyata punya `actual` asli, lalu meluas ke dua bug/permintaan terpisah yang ditemukan saat eksplorasi: artikel FJElite hilang dari tab ARTIKEL, dan permintaan tampilkan chart FinancialJuice inline.

**Kalender (`api/calendar.js`, `index.html`):**
- Sumber utama diganti ke `economic-calendar.tradingview.com/events` (endpoint publik tak berdokumen, butuh header `Origin`/`Referer` saja, tanpa Cloudflare) — beda dari ForexFactory XML, field `actual` di TradingView benar-benar terisi begitu event rilis.
- ForexFactory XML jadi fallback otomatis kalau TradingView gagal (`fetchTradingViewEvents` throw → `fetchForexFactoryEvents`).
- Filter impact (High/Medium) + major currencies dipertahankan persis seperti sebelumnya.
- Format nilai TradingView (`forecast`/`previous`/`actual`) pakai `scale` (M/B/K) + `unit`: simbol mata uang (£/$/€/¥) diprefix, persen/skala lain disuffix.
- Field `source` (`tradingview`/`forexfactory`) ditambahkan ke response untuk observability.
- Param `?week=next` baru — kalender minggu depan (ISO Mon-Sun), cache key Redis terpisah (`calendar_next_v1`) dari minggu ini, supaya tidak saling timpa.
- UI: tombol toggle "Minggu Ini / Minggu Depan ›" di toolbar kalender, lazy-fetch saat pertama diklik. Countdown timer disembunyikan saat melihat minggu depan (tetap berbasis minggu ini, tidak relevan untuk view lain).
- Disclaimer kolom Actual diperbarui — sebelumnya bilang "selalu dari headline berita" (sudah usang), sekarang akurat: dari TradingView, fallback headline-guess (`enrichCalActuals`, tidak diubah, sudah aman karena hanya mengisi kalau `actual` masih kosong) cuma aktif kalau ForexFactory yang jalan.

**Fix artikel FJElite hilang dari tab ARTIKEL (`index.html`):**
- Root cause: heuristik deteksi lama `title.length > 280` (asumsi FinancialJuice menjejalkan isi artikel penuh ke `<title>`) sudah tidak berlaku — FinancialJuice ganti format jadi title singkat bersuffix `" - FJElite"`, isi lengkap dipindah ke `<description>`. Heuristik lama tidak pernah cocok lagi → `fjResearchItems` selalu kosong.
- `isLongFormFJ()` → `isFJElite()`, deteksi via suffix `"- FJElite"` bukan panjang karakter. `cleanFJEliteTitle()` baru untuk strip suffix jadi heading bersih. `renderResearch()` sekarang ambil isi dari `desc` (description, di-`sanitizeDesc`) bukan dari title.
- Diverifikasi terhadap sample RSS live: 3 artikel (MUFG: The GBP/USD, Crédit Agricole Weekly FX Positions) langsung terdeteksi & terekstrak benar dengan fix ini.

**Chart FinancialJuice inline di NEWS (`index.html`):**
- Investigasi headline "Currency Strength Chart" (link dikirim user) menemukan: FinancialJuice render chart sebagai PNG statis di `https://www.financialjuice.com/images/{guid}.png` (guid = ID numerik dari RSS), CORS terbuka (`access-control-allow-origin: *`) — bisa di-`<img>` langsung dari browser tanpa proxy server.
- `isChartHeadline()` (regex `/\bchart\b/i` di title) + render tombol toggle `📊 Lihat Chart ▾` di tiap item feed yang cocok — gambar collapsed by default (tidak otomatis tampil, biar feed tetap ringkas), expand/collapse di klik, teks tombol berubah jadi "Sembunyikan Chart ▴" saat terbuka. `onerror` pada `<img>` auto-hide kalau pola ID ternyata tidak berlaku untuk suatu headline (graceful, tidak ada broken-image noise).
- Kasus serupa untuk headline "policy probabilities" (tabel) — **belum ditemukan contoh live**, ditunda sampai user kirim link contoh nyata untuk dicek strukturnya (kemungkinan beda mekanisme, bukan image).

**Testability:** Semua perubahan kode lolos `node -c`/inline-script syntax check. `calendar.js` diuji lokal end-to-end (jalankan handler langsung di Node) — dikonfirmasi `source: tradingview` dan `actual` terisi nyata untuk event yang sudah rilis, serta range tanggal "this week"/"next week" benar. Fix FJElite diuji simulasi parser lengkap terhadap sample RSS live FinancialJuice, berhasil ekstrak 3 artikel dengan body benar. Chart image URL diverifikasi langsung via `curl` (PNG 1136×589, CORS terbuka). Belum dites di browser nyata (Vercel preview/production) — perlu deploy untuk verifikasi visual akhir.

---

## Changelog Session 115 (2026-06-29)

### Eksekusi `daun_merah_plan.md` — Call 2 CB bias, sistem notifikasi, refinement Ringkasan, sisa audit

**Konteks:** Mengerjakan seluruh `daun_merah_plan.md` (tugas baru Session 49 review + sisa item audit lama). Tiga blok besar: A1 (Call 2 CB bias hawkish/dovish), A2 (overhaul notifikasi), A3 (refinement narasi Ringkasan), plus B1/B2 (sisa audit Ringkasan & Analisa).

**A1 — Call 2 CB bias (`api/market-digest.js`):**
- **A1.1 (prompt, draft):** `biasPrompt` sekarang disuntik blok `PRIOR STANCE & POLICY RATE` per currency (stance lama dari Redis `cb_bias` + rate live dari `_cb_rates.js`) SEBELUM daftar headline — model dipaksa menilai PERGESERAN stance, bukan sentimen mentah headline dari nol.
- **A1.2 (prompt, draft):** instruksi recency — headline diberi tahu eksplisit "terurut TERBARU di atas", bobotkan sinyal baru lebih tinggi.
- **A1.3 (prompt, draft):** instruksi abaikan headline price-action murni ("Yen jatuh ke 161") — nilai stance hanya dari komunikasi resmi/data/rilis.
- **A1.4 (prompt, draft):** definisi singkat untuk label non-axis (Data Dependent/On Hold/Split) ditambahkan ke prompt.
- **A1.5 (kode):** `BIAS_ORDER` 7-label diganti `HAWK_DOVE_AXIS` (5 label murni hawk-dove) + `ORTHOGONAL_LABELS` (Data Dependent/On Hold/Split) — transisi ke/dari label ortogonal tidak lagi salah-trigger guard divergence sebagai swing besar.
- **A1.6 (kode):** normalisasi casing bias/confidence sebelum validasi (`BIAS_CANON`/`CONFIDENCE_CANON`) — balasan model dengan casing berbeda ("cautious hawkish") tidak lagi di-drop diam-diam.
- **A1.7 (prompt, draft):** instruksi fundamental diperjelas — fundamental boleh mengubah ARAH bias, bukan cuma confidence.

**A2 — Sistem Notifikasi (`sw.js`, `api/admin.js`, `api/market-digest.js`, `index.html`, `api/_webpush.js` baru):**
- **A2.1:** `push` handler di `sw.js` sekarang cek visibilitas tab sebelum `showNotification` — app terbuka & visible → kirim update senyap via `postMessage`, bukan OS-notif (konsisten dengan guard yang sudah ada di jalur periodicSync).
- **A2.2:** notif "Ringkasan siap" baru — sekali per digest sukses, `market-digest.js` kirim push `📰 Ringkasan {sesi} siap` ke semua `push_subs` (fire-and-forget, tidak pernah block response digest). Diekstrak helper `sendWebPush()`/`configureVapid()` ke `api/_webpush.js`, dipakai bersama oleh `admin.js` (refactor, hilangkan duplikasi) dan `market-digest.js` (baru).
- **A2.3 Fase 1:** `pushHandler` (`admin.js`) sekarang filter kategori sebelum push device — hanya `market-moving`/`macro`/`forex`/`energy` yang lolos (econ-data rutin & geopolitical umum tetap di feed in-app + Telegram, cuma tidak push device).
- **A2.4:** quiet hours WIB 23:00–06:00 — non-market-moving push ditahan di jam tidur (Telegram tetap jalan).
- **A2.5:** tombol 🔔 jadi toggle on/off sungguhan — klik saat aktif sekarang `unsubscribe()` + `DELETE /api/subscribe` + hapus class `enabled` (sebelumnya cuma bisa nyala, tidak ada cara mati dari dalam app).
- **A2.6:** path icon SW disamakan ke `/icon.svg` (sebelumnya campur `./icon.svg`); handler dead `SHOW_DIGEST_NOTIF` di `sw.js` dihapus (jalur server A2.2 menggantikannya).

**A3 — Refinement narasi Ringkasan (`api/market-digest.js`, prompt — DRAFT, menunggu review user):**
- Positioning ditegaskan sebagai konfirmasi/kontradiksi, bukan jangkar arah analisa pair.
- Anomali emas-naik-saat-real-yield-tinggi sekarang wajib dipanggil eksplisit sebagai sinyal regime (driver bukan real yield).
- Mekanisme "positioning crowded → bahan bakar downside" wajib disertakan dalam kalimat yang sama, bukan lompatan logika.
- Tema dengan kaitan kausal lemah (proksi tidak langsung) di-skip kecuali magnitude jelas kuat.

**B1 — QUAL-12 (`api/market-digest.js`, kode):** 80 headline briefing sekarang di-pra-rank pakai sinyal mention-count per currency yang sudah dihitung (dipakai juga untuk pilih pair OHLCV dominan) — headline terkait tema currency dominan naik ke atas, urutan recency dipertahankan untuk skor yang sama (stable sort).

**B2 — Analisa (`api/admin.js`, `index.html`):**
- **QUAL-14 (kode):** `ohlcv_analyze` sekarang minta model balas DUA bagian terpisah dengan delimiter `===COMMENTARY===` — JSON terstruktur (bias/entry/sl/tp/trigger) di bagian 1, commentary prosa 4-5 paragraf sebagai teks BIASA di bagian 2 (bukan lagi string di dalam JSON). Menghilangkan akar masalah: prosa panjang dalam JSON gampang gagal `JSON.parse` (kutip/newline tak ter-escape) yang sebelumnya bikin `structured` null dan bias/entry/sl/tp hilang total.
- **4.0b (kode + UI):** `loadOhlcvData` sekarang return `last_candle_t` (timestamp candle 1H terakhir, bukan waktu baca server). Header tab Analisa menampilkan umur candle asli ("candle: X jam lalu ⚠" kalau >150 menit) — staleness cron yang macet sekarang terlihat, sebelumnya `loaded_at` selalu tampak segar.

**Testability (sesuai aturan plan):** Semua perubahan kode (A1.5, A1.6, A2.1, A2.2, A2.3, A2.4, A2.5, A2.6, B1, B2) lolos `node -c` syntax check + smoke-check JS inline `index.html`. Logika notif toggle & suppress-saat-visible perlu verifikasi manual di device nyata (DevTools Application → Push, tab visible vs hidden) — belum bisa diuji penuh di sandbox. Semua perubahan teks prompt (A1.1-A1.4, A1.7, A3.1-A3.4) ditandai **draft — menunggu review user** sesuai aturan plan (prompt menyimpan preferensi gaya tulisan user), output AI sebenarnya butuh trigger `GET /api/market-digest` (non-cached) + deploy untuk verifikasi.

**Tidak dikerjakan (ditandai opsional di plan, sengaja dilewati):** A2.3 Fase 2 (preferensi kategori per-user), B2 4.0c (lebih banyak titik swing), QUAL-8 (circuit breaker `ohlcv_analyze`), QUAL-17 (refactor prompt jadi array baris), B3 COR-G (BTC/gold-silver/gold-copper ratio), QUAL-2/QUAL-3 (ditandai "jangan ubah tanpa keluhan nyata"/low-prio).

---

## Changelog Session 114 (2026-06-26)

### Ganti model Groq Call 1 fallback-3 — qwen3-32b (preview) → llama-3.3-70b-versatile (production)

**Konteks:** User minta cek apakah ada model lebih bagus di OpenRouter/Groq untuk gantikan yang sering gagal (Groq HTTP 413, OpenRouter timeout 15s). Diverifikasi langsung ke sumber resmi (bukan training data) — `console.groq.com/docs/models` dan `https://openrouter.ai/api/v1/models` (endpoint live, 339 model total, 22 gratis).

**Temuan:** `qwen/qwen3-32b` (model Groq fallback-3 sebelumnya) statusnya **"Preview Models (Evaluation Only)"** di dokumentasi resmi Groq — bukan production tier, kemungkinan besar sumber HTTP 413 yang berulang. `llama-3.3-70b-versatile` (sudah dipakai di codebase ini untuk Call 2/4, terbukti reliable) statusnya **Production**, context window sama (131,072 token), dan didokumentasikan resmi cocok untuk "Complex tasks, long-form content" — upgrade yang well-justified, bukan tebakan.

**Fix (`api/market-digest.js`):** `GROQ_MODEL_PROSE` diganti dari `qwen/qwen3-32b` ke `llama-3.3-70b-versatile`.

**Soal OpenRouter (`openai/gpt-oss-120b:free`) — TIDAK diganti, dengan alasan:** Verifikasi list lengkap free model OpenRouter (qwen3-next-80b, llama-3.3-70b-instruct, hermes-3-405b, gemma-4, dst) tidak memberi bukti kuat salah satu di antaranya bakal lebih cepat — model gratis besar (405B) cenderung LEBIH lambat di free-tier queue, bukan lebih cepat, jadi ganti tanpa data latency nyata berisiko memperburuk bukan memperbaiki. Timeout 15 detik yang sering ke-hit kemungkinan besar gejala queue/load infrastruktur OpenRouter free-tier, bukan model yang salah. Juga ditemukan: total timeout worst-case kalau SambaNova(28s)+OpenRouter(15s)+Groq(20s) semua gagal berurutan = 63 detik, sementara `vercel.json` cuma kasih `maxDuration: 60` untuk `api/market-digest.js` — risiko laten yang sudah ada SEBELUM sesi ini (bukan disebabkan perubahan hari ini), dicatat di sini sebagai temuan terpisah, belum diperbaiki karena di luar scope permintaan user (perlu keputusan: kecilkan timeout SambaNova, atau naikkan maxDuration kalau plan Vercel mengizinkan).

**Testing:** Validasi `node -e "require(...)"` — lolos. Test live generate diperlukan untuk konfirmasi Groq fallback-3 sekarang sukses kalau ter-trigger (perlu skenario SambaNova+OpenRouter gagal berbarengan untuk reach Groq, sulit dipaksa terjadi secara terkendali).

---

## Changelog Session 113 (2026-06-25)

### Izinkan kalimat penutup FX bilang "sinyal campuran" secara eksplisit

**Konteks:** Test live Session 112 (instruksi "tepat satu currency" diperkuat 2x) hasilnya malah jadi kalimat ambigu: "Dolar AS melemah terhadap EUR dan komoditas tetapi bertahan terhadap JPY... JPY tetap menjadi mata uang terlemah" — nggak pernah eksplisit bilang USD itu kuat atau lemah overall. Disadari root cause-nya bukan AI gagal paham, tapi instruksi "WAJIB pilih satu pemenang" yang berlawanan sama kondisi pasar yang genuinely campuran hari itu (USD kuat vs satu currency, lemah vs currency lain) — maksa pilih satu pemenang palsu di hari campuran berisiko kurang akurat, bukan lebih jelas.

**Fix (`api/market-digest.js`):** "Penutup FX" sekarang punya dua jalur valid: (1) kalau ada satu pemenang/pecundang yang jelas tanpa kontradiksi — tetap sebut TEPAT SATU di tiap sisi seperti sebelumnya; (2) kalau buktinya genuinely campuran — boleh eksplisit bilang "sinyal campuran" dengan alasan singkat (kuat vs siapa, lemah vs siapa), bukan dipaksa pilih satu pemenang yang nggak akurat. REMINDER FINAL diupdate konsisten — sekarang minta kalimat ambigu ("EUR dan JPY" ditumpuk tanpa penjelasan) diperbaiki jadi salah satu dari dua jalur itu, bukan otomatis dipotong jadi satu currency saja.

**Testing:** Validasi `node -e "require(...)"` — lolos. Test live ditunda (provider AI sempat di-throttle dari testing sebelumnya) — user akan generate manual lewat tombol "Ringkas Ulang" dan kasih feedback langsung.

---

## Changelog Session 112 (2026-06-25)

### Perkuat instruksi "tepat satu currency lemah/kuat" di kalimat penutup FX

**Konteks:** Test live Session 111 sukses untuk tag, tapi user perhatikan kalimat penutup menyebut DUA currency lemah ("EUR dan JPY") padahal instruksi "Penutup FX" sudah eksplisit minta TEPAT SATU. Beda dari kasus tag Konfirmasi (Session 111) yang bisa dijamin 100% lewat kode (murni soal posisi/struktural), kasus ini butuh penilaian (currency mana yang buktinya paling kuat) — nggak aman diperbaiki via regex tanpa risiko merusak grammar kalimat.

**Fix (`api/market-digest.js`):** Duplikasi instruksi "tepat satu currency" di REMINDER FINAL (titik perhatian tertinggi prompt, dibaca AI persis sebelum generate) — teknik yang sama yang berhasil untuk Konfirmasi tag di Session 111. Sifatnya best-effort (penguatan instruksi), BUKAN jaminan 100% seperti safety net kode untuk tag.

**Testing:** Validasi `node -e "require(...)"` — lolos. Test live perlu diulang untuk lihat apakah penguatan ini efektif; kalau masih sering gagal, perlu dipikirkan pendekatan lain (misal validasi+regenerate kalimat penutup lewat AI call kedua yang lebih kecil, kalau severity-nya dianggap cukup penting untuk biaya tambahan itu).

---

## Changelog Session 111 (2026-06-25)

### Safety net kode untuk tag {{TAG: Konfirmasi}} — bukan cuma andalkan prompt compliance

**Konteks:** Test live Session 110 (instruksi "WAJIB tag kalimat penutup") langsung gagal di percobaan pertama — AI tetap nempelkan kalimat penutup ("Penutup sesi ini mengonfirmasi USD sebagai yang terkuat...") tanpa tag ke paragraf {{TAG: AUD/CAD}} sebelumnya. Instruksi prompt yang sudah cukup panjang (>1000 kata) rupanya nggak cukup buat jamin compliance 100% pada satu item spesifik.

**Fix (`api/market-digest.js`):** Tambah `_ensureConfirmasiTag()`, dijalankan di kode setelah Call 1 selesai (sebelum disimpan ke cache) — bukan gantung ke AI patuh instruksi. Logikanya manfaatkan fakta struktural yang SUDAH dijamin oleh prompt yang sudah ada ("Penutup FX" wajib menghasilkan satu kalimat kuat/lemah currency sebagai kalimat TERAKHIR sebelum marker "XAUUSD:") — cari batas kalimat terakhir di bagian FX (regex titik+spasi+huruf besar, sengaja menghindari angka desimal seperti "2.32%"), sisipkan tag persis di situ kalau belum ada. Kalau AI ternyata sudah comply duluan, fungsi ini no-op (deteksi `{{TAG: Konfirmasi}}` sudah ada → return apa adanya).

**Testing:** Unit test lokal dengan teks sample yang reproduksi persis kasus gagal dari test live sebelumnya — tag berhasil disisipkan tepat sebelum "Penutup sesi ini...". Test generate live perlu diulang setelah deploy untuk konfirmasi end-to-end.

---

## Changelog Session 110 (2026-06-25)

### Perketat instruksi tag topik — currency yang dibahas substantif tidak boleh numpang di tag lain

**Konteks:** User cek output Session 108/109 lebih detail: tag `{{TAG: AUD/CAD}}` ternyata isinya bukan cuma AUD/CAD — di dalamnya ikut nyangkut pembahasan JPY/CHF (safe-haven flow) dan kalimat penutup kesimpulan kekuatan mata uang, semua numpang tanpa tag sendiri di bawah tag AUD/CAD. Diskusi sempat ke arah bikin section "Lainnya" buat nampung sisa-sisa begini, tapi disepakati itu berisiko jadi bucket sampah generik (masalah yang sama cuma ganti nama) — lebih baik instruksinya diperketat supaya AI nggak ngumpulin currency yang tidak berhubungan ke satu tag begitu saja.

**Fix (`api/market-digest.js`):**
- FX poin 6: tegaskan bahwa contoh tag (EUR, AUD/CAD, USD/JPY) di prompt itu CONTOH FORMAT, bukan daftar lengkap — currency apa pun (JPY, CHF, GBP, NZD, dst) yang dibahas dengan klaim/mekanisme sendiri WAJIB dapat tag sendiri, dilarang numpang di tag currency lain.
- Kalimat penutup (kesimpulan kekuatan mata uang) yang sebelumnya justru DIKECUALIKAN dari tagging — sekarang dibalik jadi WAJIB diberi tag `{{TAG: Konfirmasi}}`, supaya selalu jadi blok visual tersendiri, bukan menyatu ke paragraf tema sebelumnya.
- XAU poin 9: penguatan serupa — Korelasi/Geopolitik/Positioning di prompt cuma contoh, sub-angle lain (Risk Regime, Rate Differential, ETF Flow, CB Buying, dst) yang punya klaim sendiri wajib tag sendiri juga.

**Testing:** Validasi `node -e "require('./api/market-digest.js')"` — lolos. Test generate live perlu diulang setelah deploy untuk verifikasi AI benar-benar memisah JPY/CHF dan kalimat penutup jadi tag tersendiri (bukan numpang lagi di AUD/CAD).

---

## Changelog Session 109 (2026-06-25)

### Bug fix — briefing AI salah tense, event yang sudah rilis disebut "besok"

**Konteks:** User lapor output briefing bagian AUD/CAD nyebut "Data tenaga kerja Australia besok pagi" sebagai katalis potensial — padahal event itu (AUD Employment Change) sudah rilis PAGI HARI YANG SAMA (08:30 WIB), beberapa jam sebelum briefing di-generate malam itu. Konfirmasi via `/api/calendar` live: event tanggal `2026-06-25 08:30 WIB`, sementara briefing di-generate setelah `19:30 WIB` — jelas sudah lewat, bukan "besok".

**Root cause (`api/market-digest.js`):** Blok KALENDER EKONOMI yang dikirim ke AI cuma berisi `date | time | currency | event` mentah, tanpa informasi relatif terhadap waktu generate. AI harus menghitung sendiri "ini sudah lewat atau belum" dari dua string tanggal/jam — LLM nggak reliable untuk aritmatika tanggal seperti ini, dan kasus di atas membuktikan itu salah hitung.

**Fix:** Tambah `_calEventStatusTag()` yang menghitung selisih jam ke event (pakai logika WIB→UTC yang sama dengan yang sudah dipakai di `enrichCalActuals()` pada `index.html`), menghasilkan tag `[SUDAH RILIS X jam/menit lalu]` atau `[AKAN RILIS dalam X jam/menit]` yang ditempel ke tiap baris event di `calBlock`. Instruksi "Kalender:" di prompt diupdate: AI WAJIB pakai tag ini apa adanya untuk menentukan tense, dilarang menghitung sendiri dari tanggal mentah.

**Testing:** Unit test lokal `_calEventStatusTag()` (simulasi "now" = 19:30 WIB 25 Jun) — event 08:30 WIB hari yang sama → `[SUDAH RILIS 11 jam lalu]` (benar), event besok 08:30 WIB → `[AKAN RILIS dalam 13 jam]` (benar), event nanti malam 21:00 WIB → `[AKAN RILIS dalam 2 jam]` (benar). Test generate live 3x via curl ke `/api/market-digest` setelah deploy: percobaan 1-2 sempat fallback ke template generik karena SambaNova+OpenRouter timeout berbarengan (transient, lalu Groq fallback-3 kena HTTP 413 — dicatat sebagai temuan operasional terpisah, bukan regresi dari fix ini, karena percobaan ke-3 langsung sukses via SambaNova tanpa ubah apa pun); percobaan ke-3 sukses, AI comply dengan tag topik dari Session 108 sekaligus konten tetap padat.

---

## Changelog Session 108 (2026-06-25) — EKSPERIMEN, belum dikonfirmasi user

### Tag topik inline di prompt Call 1 — biar paragraf padat lebih mudah dipindai

**Konteks:** User merasa narasi briefing (terutama bagian FX) noise — bukan soal kualitas/kedalaman isi (tetap diakui sangat informatif), tapi karena ~6-7 tema (PCE/Fed, GDP+claims, ECB/EUR, risk sentiment, komoditas, USD/JPY, kesimpulan) dijejer satu paragraf prosa panjang tanpa jeda visual. User kepikiran bikin sub-bab, tapi khawatir ubah prompt bikin output AI "kurang" (lebih ringkas/dangkal) — minta dicek dulu sebelum dipakai.

**Kenapa BUKAN restrukturisasi penuh jadi section:** Prompt Call 1 yang sudah ada punya instruksi "PENDEKATAN BENANG MERAH FX" yang sengaja MELARANG tema ditulis sebagai paragraf lepas yang ditumpuk — tema lain WAJIB dikaitkan ke tema utama lewat konektor sebab-akibat eksplisit. Minta AI menulis section berdiri sendiri akan langsung bentrok sama instruksi ini dan berisiko menurunkan kualitas benang-merah narasi yang sudah di-tuning panjang (87 baris prompt).

**Pendekatan yang dipakai — tag tambahan, bukan pengganti:** Tambah instruksi "LABEL TOPIK" di prompt (`api/market-digest.js`, FX poin 6 dan XAU poin 9) — AI tetap menulis narasi yang sama (konektor causal tetap wajib), tapi setiap kali fokus bergeser ke currency/sub-topik baru, sisipkan tag `{{TAG: NAMA}}` persis sebelum kalimatnya. Frontend (`articleToHtml()` di `index.html`) mendeteksi tag ini dan mengubahnya jadi heading kecil + jeda paragraf baru — kalau AI nggak comply (model lama/nggak ikut instruksi), fallback otomatis ke render paragraf biasa seperti sebelumnya (backward-compatible, nggak ada cara ini merusak output existing).

**PERINGATAN PENTING — belum tervalidasi sepenuhnya:** `digestSystemMsg = promptDigestInstr || DIGEST_SYSTEM_DEFAULT` (`market-digest.js` baris ~922) — kalau ada custom prompt tersimpan di Redis key `prompt_digest` (lewat endpoint `admin-prompts`), prompt itu yang DIPAKAI, bukan `DIGEST_SYSTEM_DEFAULT` yang baru diedit di sesi ini. Saya tidak punya `CRON_SECRET`/`x-admin-secret` untuk cek apakah Redis key itu terisi di production — kalau iya, perubahan prompt sesi ini TIDAK akan ada efeknya sampai key Redis itu juga diupdate (lewat `POST /api/admin?action=admin-prompts&key=prompt_digest`) atau dihapus supaya fallback ke default yang baru.

**Testing:** Validasi sintaks `index.html` + `market-digest.js` — lolos. Test logika parsing `articleToHtml()` secara lokal (Node, 2 skenario: AI pakai tag vs tidak) — keduanya render benar. **Belum ada test generate live** (butuh tes manual lewat tombol "Ringkas Ulang" di app oleh user, sekaligus untuk cek: (1) apakah Redis prompt override di atas memblokir perubahan ini, (2) apakah AI benar-benar comply nyisipin tag, (3) apakah kedalaman/density konten tetap sama seperti sebelumnya — sesuai concern awal user).

---

## Changelog Session 107 (2026-06-25)

### Revert total redesign RINGKASAN (Session 104 + 106) — balik ke tampilan awal

**Konteks:** Setelah dicoba flat redesign (Session 104) lalu hybrid warna-di-direction-badge (Session 106), user masih ragu dan akhirnya minta balik total ke tampilan sebelum redesign — card warna-warni, emoji provider badge, bintang confidence, semuanya. Tombol "Ringkas Berita"/"Ringkas Ulang"/"Meringkas..." (Session 104, request terpisah) **tidak** direvert karena itu bukan bagian dari keraguan soal visual.

**Implementasi:** `git revert` dua commit (`b06f3aa` hybrid color fix, lalu `208fc70` redesign asli) — bukan `git reset`, supaya history tetap utuh dan perubahan lain di antara dua commit itu (bug fix ANALISA, Session 105) tidak ikut hilang. Detail teknis redesign yang di-revert ada di entry Session 104 di bawah (dipertahankan sebagai catatan historis, meski sudah tidak aktif).

---

## Changelog Session 105 (2026-06-25)

### Bug fix — analisa AI hilang setelah reload, baru muncul lagi setelah pindah pair lalu balik

**Konteks:** User lapor: reload app, masuk tab ANALISA ke pair yang AI analysis-nya sudah pernah di-generate sebelumnya (XAU/USD) — analisanya kosong. Pindah ke pair lain lalu balik lagi ke XAU/USD, analisanya tiba-tiba muncul. Perilaku flaky yang nggak disukai user.

**Root cause #1 (`loadAnalisa()`, `index.html`):** Cache data OHLCV mentah (`analisaDataCache`, TTL 2 jam) dan cache hasil AI (`analisaAiCache`, TTL 8 jam) punya umur beda. Restore AI cache (`_restoreAiResult`) cuma dicek di cabang "render instan dari cache" (kalau `analisaDataCache[symbol]` masih ada) — di cabang "data cache kosong/basi → fetch fresh dulu", setelah fetch selesai cuma `renderAnalisa()` dipanggil, **tidak ada** cek ulang `analisaAiCache[symbol]`. Jadi begitu data cache 2 jam itu basi (padahal AI cache 8 jam masih valid), hasil AI yang sebenarnya masih sah jadi nggak pernah ditampilkan — sampai pair itu di-load ulang DAN data cache-nya sudah terisi (baru lewat cabang instant-render yang benar).

**Root cause #2 (`switchView('analisa')`):** Logika "restore pair terakhir saat tab dibuka" cuma jalan kalau `analisaDataCache[lastSym]` masih ada (gate kondisi) — beda dari logika di `loadAnalisa()` yang selalu fetch ulang kalau cache kosong/basi. Kalau cache OHLCV mentah sudah basi pas reload, seluruh blok restore ini di-skip total: tidak ada pair yang ke-select, tidak ada loading state, tidak ada apa-apa — tab kelihatan kosong sampai user klik manual.

**Fix:** (1) Tambah pengecekan `analisaAiCache[symbol]` setelah fetch fresh selesai di `loadAnalisa()`, sama seperti yang sudah ada di cabang instant-render. (2) Ganti logika restore di `switchView('analisa')` supaya selalu panggil `loadAnalisa(lastSym, lastLabel, chip)` (path yang sama dengan klik manual) — bukan duplikat logika render-from-cache-only yang gampang silently no-op. Label pair diambil dari `chip.textContent` (selalu ada di DOM), bukan dari `analisaDataCache[lastSym].label` (bisa undefined kalau cache kosong).

**Testing:** Validasi sintaks tiap blok `<script>` (`node -e "new Function(...)"`) — lolos. Verifikasi manual logic trace 2 skenario: (1) data cache basi + AI cache masih valid → sekarang AI result ikut tampil setelah fetch fresh, bukan cuma chart; (2) restore last-pair saat data cache kosong total → sekarang tetap masuk ke `loadAnalisa()` (tampil loading state lalu data fresh), bukan diam tanpa indikasi apa pun.

---

## Changelog Session 104 (2026-06-25)

### Redesign tab RINGKASAN — gaya "laporan profesional" flat & minimal

**Konteks:** User minta tampilan tab RINGKASAN diubah agar berasa seperti laporan profesional, bukan dashboard kasual. Dikasih 3 opsi mock-up (flat-minimal / serif-body / batal) — user pilih flat & minimal.

**Implementasi (`index.html`):**
- `.ringkasan-card` & `.thesis-card`: hilangkan rounded-box background + colored left accent bar (`::before`), ganti jadi flat `border-top` divider antar section (selaras antar section, bukan kotak-kotak terpisah).
- `.ringkasan-method`: hilangkan pill berwarna + emoji per-provider (⚡🧠✨🤖), jadi teks abu kecil biasa — cuma status `fallback`/`fallback_quota` yang tetap dapat warna (kuning) karena itu informasi kualitas data, bukan dekorasi.
- `.thesis-dir`: hilangkan background pill berwarna, jadi teks polos berwarna (hijau/merah) saja.
- `.thesis-conf`: bintang ★★★★☆ diganti teks "Confidence: Tinggi/Sedang/Rendah" (`confidenceLabel()`) — lebih sesuai nada laporan dibanding rating ala app konsumen.
- Tambah heading section flat: "LAPORAN PASAR" (judul laporan), "Thesis · FX" / "Thesis · XAU/USD" (label section thesis, class `thesis-section-label`), "Market Briefing" (sebelumnya tanpa label di bagian FX artikel, sekarang ada biar konsisten dengan label "XAUUSD" di sampingnya).
- Hapus `.ringkasan-stats` (kotak chip jumlah berita/event) — datanya sudah ada di `.ringkasan-meta-left` (`tsStr · N berita · M kalender`), jadi sebelumnya nampilin angka yang sama dua kali.
- Dashboard: blok thesis FX/XAU yang sebelumnya duplikat inline HTML (beda dari tab RINGKASAN) sekarang reuse `renderThesisCard()`/`renderXauThesisCard()` langsung — otomatis ikut style baru, dan dapat bonus tombol "Mulai ke Sizing Calc →" yang sebelumnya cuma ada di tab RINGKASAN.

### Rename tombol "Generate Ringkasan" → "Ringkas Berita"

Permintaan user: hilangkan istilah "Generate", ganti "Ringkas Berita" (state awal), "Ringkas Ulang" (sudah ada ringkasan), "Meringkas..." (loading state). Diterapkan konsisten di semua tempat tombol ini muncul: tab RINGKASAN, Dashboard, dan teks panduan/onboarding (Petunjuk) yang merujuk ke tombol ini.

**Testing:** Validasi sintaks tiap blok `<script>` (`node -e "new Function(...)"`) — lolos. Verifikasi manual tidak ada CSS/class yang jadi orphan setelah penghapusan (`rstat`, `::before` pada card/thesis-card, `ringkasan-card-xau::before`) — semua referensi sudah dibersihkan dari render function maupun stylesheet.

---

## Changelog Session 103 (2026-06-25)

### Dashboard — readability fix teks ringkasan (font 10px → 13px, paragraf, warna)

**Konteks:** Setelah Session 102 bikin preview ringkasan jadi full-text (bukan dipotong), user lapor font-nya kekecilan (10px) dan capek dibaca — minta disamakan dengan kenyamanan baca di tab RINGKASAN.

**Root cause tambahan yang ketemu saat investigasi:** bukan cuma soal ukuran font — `dash-digest-text` sebelumnya di-render dengan `escHtml(preview)` langsung (satu blok teks tanpa pemecahan paragraf), beda dari tab RINGKASAN yang pakai `articleToHtml()` (pecah jadi `<p class="r-para">` per paragraf dengan margin 1.2em). Hasilnya dinding teks panjang tanpa nafas, jauh lebih melelahkan dibaca dibanding ukuran font kecilnya sendiri.

**Fix (`index.html`):**
- `.dash-digest-text`: font-size 10px → 13px, line-height 1.6 → 1.75, color `var(--text-mid)` (abu redup) → `var(--text)` (#e8e4d9, krem hangat) — identik dengan `.ringkasan-text` di tab RINGKASAN.
- `renderDashDigest()` sekarang pakai `articleToHtml(preview)` (bukan `escHtml`) supaya paragraf ter-pecah dengan benar, termasuk highlight paragraf kalender (`r-cal`) kalau ada.

**Testing:** Validasi sintaks tiap blok `<script>` (`node -e "new Function(...)"`) — lolos.

---

## Changelog Session 102 (2026-06-25)

### Dashboard — preview ringkasan satu sisi (XAU default) dengan toggle panah

**Konteks:** User minta card RINGKASAN PASAR di Dashboard cuma nampilin satu bagian (FX atau XAU) bukan dua-duanya, biar cepat dibaca. Diskusi: user trading gold jadi mau XAU sebagai default, tapi sempat ragu apakah itu objektif mengingat aplikasi ini macro-context-heavy. Konklusi: paragraf XAU di output ringkasan sudah merangkum driver makro yang relevan (real yield, Core PCE, Fed bias, risk regime) di dalam paragrafnya sendiri, jadi tidak kehilangan konteks signifikan dengan menyembunyikan bagian FX — defaultkan XAU, kasih toggle panah buat lihat FX kalau perlu.

**Implementasi (`index.html`):**
- Extract helper `splitArticleParts(article)` dari logika split `"XAUUSD:"` yang sebelumnya cuma ada di `renderArticleSections` (tab RINGKASAN) — sekarang dipakai juga di `renderDashDigest()` biar tidak duplikat logika.
- `renderDashDigest()` sekarang preview cuma satu sisi (`dashDigestSide`, persisted ke localStorage `dash_digest_side`, default `'xau'`), dengan tombol panah ‹ › (`toggleDashDigestSide()`) buat switch antar XAU/FX. Toggle cuma muncul kalau artikel benar-benar punya dua bagian (`hasBoth`); kalau cuma satu bagian, tampil langsung tanpa toggle.
- Susulan: ditampilkan **full** (tidak dipotong 500 char) karena cuma satu sisi yang tampil sekaligus — ruang yang dipakai sama dengan preview lama yang motong dua sisi. "Lihat semua" sekarang maksudnya "lihat sisi yang satunya juga" (label diubah jadi "→ Lihat semua (FX + XAU)"), muncul cuma kalau artikel punya dua bagian — bukan lagi soal truncation.

**Testing:** Validasi sintaks tiap blok `<script>` di `index.html` (`node -e "new Function(...)"`) — lolos. Verifikasi manual alur 3 skenario: artikel ada XAU+FX (toggle muncul, default XAU), artikel cuma FX/legacy tanpa marker XAUUSD (toggle disembunyikan, fallback ke FX), dan belum ada ringkasan sama sekali (tetap tampil tombol Generate seperti sebelumnya, tidak kena logic split).

---

## Changelog Session 101 (2026-06-25)

### Fix kalender: "Initial Jobless Claims" tidak pernah match "Unemployment Claims"

**Konteks:** User paste contoh headline FinancialJuice hari itu (PCE, Durable Goods, Jobless Claims, dll) dan minta kalender "disesuaikan lagi". Dicek silang dengan data live `/api/calendar` — ketemu satu mismatch nyata: headline FinancialJuice "Initial Jobless Claims Actual X (Forecast Y, Previous Z)" tidak pernah cocok dengan event ForexFactory yang namanya "Unemployment Claims", walau itu rilis mingguan yang sama. `_calWordSetsMatch` di `index.html` butuh kecocokan word-set persis, dan "initial jobless claims" vs "unemployment claims" tidak ada kata yang sama sama sekali — jadi `actual` selalu kosong tiap Kamis untuk event ini.

**Fix (`index.html`):** Tambah `initial` ke `_CAL_STOPWORDS` (filler, tidak membedakan indikator) dan mapping `jobless → unemployment` di `_CAL_SYNONYMS`, supaya kedua sisi collapse ke token yang sama. "Continued Jobless Claims" (rilis berbeda) tetap aman tidak ke-match karena kata "continued" bikin ukuran word-set beda.

### Dashboard — generate ringkasan manual + jadwal otomatis per sesi pasar

**Konteks:** Evaluasi mandiri atas keluhan user "dashboard kurang menarik" — ternyata card AI DIGEST/AI THESIS di Dashboard sering kosong karena ringkasan cuma bisa di-generate manual dari tab RINGKASAN (tidak ada cron). Sempat dicoba auto-generate tiap kali Dashboard dibuka, tapi user khawatir soal biaya token kalau dibuka tiap jam/sesi — direvisi ke pendekatan jadwal fix.

**Implementasi:**
- `index.html`: card ringkasan di Dashboard (di-rename label-nya jadi "RINGKASAN PASAR") sekarang punya tombol generate sendiri (`dashGenerateRingkasan()`) + tombol "↻ Refresh" kalau data sudah stale — murni manual tap, tidak ada auto-trigger dari aktivitas buka app.
- Ditambah caption "Terakhir diringkas HH:MM WIB (sesi Asia/London/New York)" di bawah preview (`fmtWibSession()`), label sesi cuma informatif berdasarkan jam WIB, bukan deteksi presisi.
- `api/market-digest.js`: handler sekarang terima request cron terautentikasi (header `x-vercel-cron: 1` dari Vercel, atau `x-cron-secret` cocok `CRON_SECRET` — pola yang sama dipakai `ohlcvSyncHandler` di `api/admin.js`), yang melewati rate-limit per-IP (4 req/menit) karena ini cuma 3 panggilan terautentikasi/hari, bukan trafik user. Tidak ada `device_id` di panggilan cron — sudah diverifikasi aman karena Call 4 (thesis monitor per-journal user) sudah punya gate `&& deviceId` dari awal, jadi otomatis skip; Call 1-3 (briefing, CB bias, thesis) tetap jalan dan update cache (`latest_article`) yang dibaca semua user lewat `mode=cached`.
- `vercel.json`: tambah 3 cron entry ke `/api/market-digest` — `0 0 * * *` (07:00 WIB, sesi Asia), `0 7 * * *` (14:00 WIB, sesi London), `30 12 * * *` (19:30 WIB, sesi New York).

**Testing:** Validasi sintaks (`node -e "new Function(...)"` untuk tiap blok `<script>` di `index.html`, `require()` untuk `market-digest.js`, `JSON.parse` untuk `vercel.json`) — semua lolos. Verifikasi manual logika gating Call 4 di kode (baris `(SAMBANOVA_KEY || GROQ_KEY) && deviceId`) untuk memastikan panggilan cron tanpa `device_id` tidak crash dan tidak menulis ke key Redis `thesis_alerts:undefined`. Belum bisa di-test end-to-end jam cron yang sesungguhnya karena itu baru jalan setelah deploy ke Vercel.

---

## Changelog Session 99 (2026-06-24)

### Fix: Option Expiries FinancialJuice — sumber kedua sering kosong karena live ticker window terlalu sempit

**Konteks:** Setelah Session 99 nambahin FinancialJuice sebagai sumber kedua, user lapor pasangan mata uang dari FinancialJuice belum muncul. Root cause: `RSS_URL` FinancialJuice itu live ticker semua-asset-class (~100 headline terakhir lintas forex/equity/commodity/geopolitik), bukan feed khusus forex. Post "Options Expiries" cuma sekali sehari, dan dengan volume berita FinancialJuice yang tinggi, item-nya rotasi keluar dari window itu dalam hitungan jam — jadi `fetchFinancialJuiceOptions` hampir selalu gagal nemu post-nya kecuali serverless function kebetulan fetch persis di jam postingan baru naik.

**Fix (`api/feeds.js`):**
- `fetchFinancialJuiceOptions` sekarang 2 tahap: (1) coba live ticker dulu (cepat, kena kalau baru saja diposting), (2) kalau gagal/item tidak ketemu, fallback ke Redis sorted set `news_history` (window 36 jam, sudah otomatis terisi tiap kali ada yang akses `type=rss` lewat `storeNewsHistory`) — cari item dengan title cocok pattern expiry, ambil yang `pubDate` paling baru.
- `parseRSSItems` (yang ngisi `news_history`) sekarang simpan field `description` juga, tapi *cuma* untuk item yang title-nya cocok pattern option-expiry — item berita biasa tetap tanpa description supaya ukuran history di Redis nggak boros buat data yang nggak kepake.

**Testing:** Disimulasikan skenario "live ticker sudah rotasi keluar" (live fetch return XML tanpa item expiry sama sekali) + history Redis berisi item expiry lama — hasil tetap berhasil ke-extract dari history, dengan `sources: ["FinancialJuice"]` dan level/size yang benar. Regression check: live-fetch path (skenario normal, item masih ada di ticker) tetap jalan seperti semula.

---

## Changelog Session 99 (2026-06-24)

### Feat: Option Expiries — Tambah sumber kedua (FinancialJuice), merge dengan Investinglive

**Konteks:** User kasih tahu FX option expiry ternyata juga diposting FinancialJuice (bukan cuma Investinglive yang sudah dipakai sejak Session 66/67), berupa headline harian "[Day] FX Options Expiries" di feed berita FinancialJuice yang sama dengan yang dipakai untuk RSS ticker (`RSS_URL`), formatnya `<li><strong>PAIR:</strong> level (size), level (size)</li>` per pair.

**Implementasi (`api/feeds.js`):**
- `optionsHandler` sekarang fetch Investinglive (`fetchInvestingLiveOptions`) dan FinancialJuice (`fetchFinancialJuiceOptions`) paralel via `Promise.allSettled` — kalau satu sumber down/diblokir, yang lain tetap jalan (tidak hard-fail, konsisten dengan pola degradasi sumber lain di file ini).
- `fetchFinancialJuiceOptions` cari item RSS dengan title match `/options?\s*expir/i` (longgar untuk nangkep "Option Expiries" singular dan "Options Expiries" plural FinancialJuice), ambil `<description>`, decode HTML entities, lalu reuse `parseOptionExpiries` yang sudah ada.
- Regex size di `parseExpiryEntries` diperluas: sebelumnya cuma terima prefix simbol mata uang (`€$¥£`), sekarang juga terima kode 2-4 huruf (`EU`, `AUD`, `GBP`, `NZD`, `MXN`...) — format yang dipakai FinancialJuice (`EU2.51b`, `AUD688.9m`) beda dari Investinglive yang pakai simbol.
- Hasil dari kedua sumber digabung lalu di-dedupe (`dedupeExpiries`) per `pair+level` — kalau dua sumber sama-sama lapor level yang sama, jadi satu entry dengan `sources: [...]` (menandakan dikonfirmasi 2 sumber) dan size diisi dari sumber mana pun yang punya data.
- Response sekarang punya field `sources` di top-level: `[{name, link, date}, ...]` — satu per sumber yang berhasil fetch.

**Frontend (`index.html`):** Tabel Option Expiries di TEK tab dapat kolom "Sumber" (muncul cuma kalau ada entry yang dikonfirmasi >1 sumber — abbreviation IL/FJ dengan tooltip nama lengkap), dan footer link sumber sekarang nampilin link ke kedua sumber yang berhasil fetch (bukan cuma Investinglive seperti sebelumnya).

**Testing:** Diverifikasi end-to-end pakai data live FinancialJuice RSS (capture asli "Wednesday FX Options Expiries" dengan 9 pasangan: EUR/USD, USD/JPY, AUD/USD, USD/CNY, GBP/USD, USD/BRL, NZD/USD, EUR/GBP, USD/MXN — total 23 level) — semua level+size terparse benar termasuk format `EU2.51b`/`AUD688.9m` yang sebelumnya tidak match. Dites juga skenario merge (2 sumber lapor level sama → 1 entry dengan 2 sources), filter per-pair, dan graceful degradation (1 sumber down → tetap return 200 dengan sumber yang hidup).

---

## Changelog Session 100 (2026-06-25)

### UX tweak — yield instruments di tab TEKNIKAL otomatis pindah ke timeframe 1D

**Konteks:** US10Y dan US02Y sekarang bisa dibuka sebagai chart teknikal sendiri di tab TEKNIKAL, tapi kalau user pindah ke pair yield dari pair lain, timeframe sebelumnya bisa ikut kebawa dan bikin chart yang kurang relevan.

**Fix:** Saat `selectTekPair()` atau `initTeknikal()` mendeteksi pair yield (`US10Y` / `US02Y`), state timeframe sekarang dipaksa ke `D` dan dropdown ikut disinkronkan. Saat balik ke forex atau XAU/USD, state otomatis balik ke `240` supaya tampilan teknikal kembali ke H4, yang jadi default paling masuk akal untuk pair tersebut.

**Testing:** Verifikasi wiring langsung di `index.html` memastikan helper sync dipanggil dari dua jalur utama: saat pair diganti dan saat tab TEKNIKAL diinisialisasi.

---

## Changelog Session 98 (2026-06-23)

### Bug fix — hasil Sizing Calculator (lots/SL/TP) hilang setelah refresh, padahal sudah dipakai di Checklist/MT5

**Konteks:** User lapor: hitung Sizing Calculator, lanjut ke Checklist, refresh halaman dengan pair yang sama — Lot/SL/TP yang sudah dikunci di modal Entry MT5 (Session 95) hilang total, harus ulang dari Sizing Calculator.

**Root cause:** `window._lastSizing` — objek yang jadi jembatan satu-satunya antara Sizing Calculator dan Checklist/MT5 (`ckShowMt5Modal()` baca dari sini) — cuma variabel in-memory, tidak pernah ditulis ke localStorage. Form INPUT-nya (equity, risk, entry, SL via `szPersistForm()`/`szRestoreForm()`) sudah lama persisten, tapi hasil KALKULASI-nya tidak — asimetri yang bikin form kelihatan "selamat" setelah refresh sementara nilai yang sebenarnya dipakai sistem (lots/SL/TP) hilang diam-diam.

**Fix:** `window._lastSizing` sekarang dipersist ke localStorage (`daun_merah_sz_lastsizing`) tiap kali `calcSizing()` menghasilkan nilai baru (`szPersistLastSizing()`), dan direstore lewat IIFE di top-level script saat halaman dimuat — jadi tersedia segera, tidak menunggu user buka tab Sizing dulu (penting karena skenario user: refresh lalu LANGSUNG balik ke Checklist, tanpa mampir ke Sizing tab). Sekalian diperbaiki gap kedua yang ditemukan saat investigasi: kalau user toh balik ke tab Sizing setelah refresh, panel hasil yang terlihat tetap kosong walau `_lastSizing` sudah benar di balik layar (inkonsistensi tampilan vs data). `initSizing()` sekarang panggil ulang `calcSizing()` otomatis kalau ada `_lastSizing` yang pair-nya cocok dengan form yang baru direstore — sumber tunggal data dijaga konsisten, tidak ada dua objek (form vs hasil) yang bisa drift.

**Testing:** Playwright dengan `browser.newContext()` (localStorage persist antar `page.reload()`, beda dari context baru tiap test sebelumnya). 3 skenario: (1) `_lastSizing` di-set manual lalu reload — terbukti pulih dari localStorage; (2) langsung ke Checklist setelah reload TANPA mampir Sizing tab — modal Entry MT5 langsung terisi lots/SL/TP terkunci, sama seperti sebelum refresh; (3) kalkulasi sungguhan lewat form UI (pilih pair, isi equity/risk/RR/entry/SL, klik Calculate) lalu reload lalu buka tab Sizing — panel hasil muncul kembali otomatis, bukan kosong.

---

## Changelog Session 97 (2026-06-23)

### Speed-flag untuk blind mass-check checklist — bukan mencegah, tapi memaksa berhenti + tercatat permanen

**Konteks:** Pertanyaan user setelah Session 96: "gimana kalau aku tiba-tiba centang semua biar bisa entry?" Beda kategori dari 4 celah sebelumnya — itu bug (sistem punya jalan pintas tak disengaja), ini bukan bug: tidak ada cara teknis memverifikasi user benar-benar membaca tiap kondisi vs asal klik. Sama dengan argumen demo-vs-riil di awal sesi diskusi disiplin trading — software tidak bisa membuktikan kejujuran, tapi bisa menaikkan biaya dan membuat ketahuan.

**Implementasi:** `ckToggleItem()` sekarang catat timestamp checklist pertama kali ada item dicentang dari kondisi kosong (`daunmerah_v2_firstcheck_{PAIR}` di localStorage, per-pair, dibersihkan saat reset/ganti playbook). Fungsi baru `ckChecklistSpeedInfo()` hitung rasio item-tercentang vs waktu-berlalu; ditandai "suspicious" kalau ≥50% item checklist sudah tercentang TAPI rata-rata kurang dari ~0,6 detik/item — ambang batas lega untuk skim-reading genuine, jauh di bawah yang bisa dicapai mass-click instan.

Kalau `ckPrefillJurnal()` atau `ckShowMt5Modal()` dipanggil saat flag ini aktif, keduanya dialihkan lewat `ckProceedIfNotSuspicious()` ke modal baru (`ckSpeedAckModal`) yang memaksa user mengetik kalimat nyata (pakai validator yang sama dengan override reason — `ckOverrideReasonIssue()`, minimal 15 karakter/3 kata/bukan kata pengisi) menjelaskan kondisi apa yang barusan dicek, sebelum bisa lanjut. Bukan hard block — user tetap bisa lanjut kalau memang mau — tapi alasan itu (`ckLastSpeedAck`) otomatis ditempel permanen ke teks thesis jurnal (`⚠ FLAG KECEPATAN: N/M item dicentang dalam X detik...`) lewat `ckConsumeSpeedAckNote()`, baik untuk jalur Jurnal manual maupun auto-journal dari MT5 Bridge. Catatan one-shot — dikonsumsi begitu terpakai, supaya tidak nempel ke entry lain yang temponya genuine.

**Bonus kecil:** ketemu saat refactor — `ckPrefillJurnal()` sebelumnya cuma cek `pct < 50`, tidak ikut cek `gatesOk` dari fix Session 96 (MT5 modal sudah benar, Jurnal kelewat). Disamakan sekarang.

**Testing:** Playwright — 6 skenario: (1) mass-check instan terdeteksi suspicious (44/44 item dalam 0.003s), (2) `ckPrefillJurnal()` dialihkan ke modal speed-ack bukan langsung navigasi, (3) alasan "ok" tetap menjaga tombol disabled, (4) alasan kalimat nyata mengaktifkan tombol → konfirmasi → navigasi ke Jurnal jalan + teks thesis berisi flag note + `ckLastSpeedAck` ke-clear, (5) checklist yang sama dicentang selama 5 menit (pacing genuine) TIDAK ditandai suspicious, (6) checklist genuine lolos langsung ke Jurnal tanpa modal sama sekali. Jalur MT5 diuji terpisah: modal speed-ack tampil duluan, baru setelah konfirmasi modal Entry MT5 terbuka.

**Catatan:** ini eksplisit bukan solusi penuh — kalau user benar-benar niat berbohong, dia bisa mengetik kalimat yang valid secara format tapi isinya tetap bohong ("saya sudah cek semua dengan teliti" tanpa benar-benar cek). Tidak ada perbaikan lanjutan yang realistis untuk ini di level software; batasannya didokumentasikan terbuka ke user saat fitur ini diusulkan, bukan diklaim sebagai pencegahan mutlak.

---

## Changelog Session 96 (2026-06-23)

### Tutup 4 celah checklist sisa dari audit disiplin (Session 95) — gate wajib 100%, cooldown reset, konfirmasi ganti playbook, validasi alasan override

**Konteks:** Lanjutan audit checklist Session 95. User minta semua celah yang teridentifikasi dikerjakan, bukan cuma satu (lot/SL/TP yang sudah dibereskan di Session 95).

**1. Gate section (VALIDITAS DRIVER, RISK MANAGEMENT, dst — beda per playbook) sekarang wajib 100% checked, bukan cuma 2x-weighted di skor agregat.** Sebelumnya user bisa skip seluruh gate dan tetap lolos 50% threshold dengan mencentang section lain yang lebih remeh — celah paling berbahaya karena gate justru yang paling sering dikorbankan saat emosi (FOMO/revenge). `ckGetVerdict()` sekarang hitung `gatesOk` (semua section di `CK_GATES` harus 100% item parent-nya checked, lewat fungsi baru `ckGateComplete()` — bukan reuse `ckIsComplete()` yang juga mensyaratkan sub-item, supaya konsisten dengan skor agregat yang dari awal cuma menghitung parent item, sub cuma guidance). Verdict dipaksa "NO TRADE" kalau gate belum lengkap walau pct sudah tinggi, dengan pesan eksplisit gate mana yang kurang. Tombol Jurnal/MT5 dan `ckShowMt5Modal()` ikut pakai `gatesOk`, dengan toast jelas (bukan diam) kalau diblokir karena gate.

**2. Cooldown 60 detik setelah Reset Checklist — menutup pola "reset lalu instan centang ulang yang sama" buat melepas verdict NO TRADE tanpa konsekuensi.** Lock disimpan di localStorage per-pair (`daunmerah_v2_resetlock_{PAIR}`, bukan cuma in-memory) supaya refresh halaman tidak jadi jalan pintas. `ckToggleItem()` sekarang cek lock duluan — kalau masih dalam cooldown, klik checkbox diblokir + toast "Tunggu Xs ... bukan reset-lalu-paksa-lolos". Countdown live ditumpangkan ke interval jam 1 detik yang sudah ada (`ckUpdateClock()` → `ckUpdateResetCooldownUI()`), tampil sebagai teks merah di bawah tombol Reset.

**3. Ganti playbook di tengah sesi (ada progress checklist tercentang) sekarang minta konfirmasi eksplisit sebelum reset state, bukan langsung wipe diam-diam.** Sebelumnya ganti playbook = celah belakang: skor rendah di SMC/ICT → pindah ke Macro Momentum → checklist kosong baru → lolos lebih mudah. `ckSwitchPlaybook()` sekarang cek `Object.values(ckState).some(v => v === true)` — kalau ada item tercentang, `confirm()` dulu ("Checklist pair ini yang sudah dicentang akan di-reset ke kosong"); kalau user batal, dropdown selector dikembalikan ke playbook aktif (tidak ada state ganda/visual mismatch).

**4. Alasan override sinyal auto-block (`rc4` dst) sekarang harus kalimat nyata, bukan cuma ≥5 karakter.** Validasi lama meloloskan "test", "ok ok", "udah" — kosmetik doang. Fungsi baru `ckOverrideReasonIssue()`: minimal 15 karakter, minimal 3 kata, blocklist kata pengisi umum (test/ok/aman/skip/gas/terserah/dst — case+symbol-insensitive), tolak alasan dengan diversity karakter rendah (<6 unique char — nangkep filler kayak "aaaaaaaaaaaaaaa" / "asdasdasdasdasd" yang lolos count tapi bukan kalimat). Ditambah hint teks live di bawah textarea (`#ckOverrideHint`) yang menjelaskan kenapa tombol masih disabled — sebelumnya tombol cuma mati tanpa penjelasan apa pun.

**Testing:** Playwright headless, 4 skenario terpisah per celah (lihat detail di Session 95 untuk setup server statis). Ketemu 1 bug nyata saat testing: percobaan pertama pakai `ckIsComplete()` (yang ikut mensyaratkan sub-item) untuk cek gate — hasilnya gate SELALU "incomplete" walau semua parent item dicentang, karena sub-item (mis. `g5a`-`g5d` di bawah `g5`) tidak ikut tercentang dalam skenario normal (sub murni guidance, tidak pernah dimaksudkan wajib). Diperbaiki dengan fungsi terpisah `ckGateComplete()` yang cuma cek parent item, konsisten dengan semantik skor. Setelah fix: re-test konfirmasi `gatesOk` jadi `true` begitu semua parent item gate checked (skor 100%, verdict ENTRY). 3 celah lain (cooldown, playbook-switch confirm, override validation) lolos dari percobaan pertama — verified lewat manipulasi `localStorage`/`ckState` langsung + dialog handler Playwright (`page.on('dialog')`) untuk simulasi accept/dismiss `confirm()`, plus screenshot visual untuk banner cooldown dan hint override.

**Catatan:** keempat fix ini menutup celah yang ditemukan, tapi tidak menyentuh hal di luar lingkup (mis. localStorage/console tampering — itu butuh user aktif buka DevTools saat trading, bukan pola emosi spontan yang jadi concern utama diskusi ini).

---

## Changelog Session 95 (2026-06-23)

### Lock Lot/SL/TP di modal Entry MT5 ke hasil Sizing Calculator — tutup celah entry emosional

**Konteks:** Diskusi disiplin trading dengan user — checklist di-audit untuk cari celah dimana entry bisa lolos berdasarkan emosi walau user berniat jujur ke diri sendiri (sistem harus tegas, bukan cuma andalkan niat baik). User sendiri menyadari titik paling rawan: field Lot/Stop Loss/Take Profit di modal "Entry MT5" sebelumnya bisa diedit manual di menit terakhir — sama bahayanya dengan langsung input manual di MT5, karena angka eksekusi bisa berubah dari rencana objektif (hasil Sizing Calculator) jadi tebakan saat itu.

**Implementasi (`index.html`):**
- Modal `mt5Modal`: field Lot Size/Stop Loss/Take Profit sekarang `readonly` + label 🔒 "dari Sizing Calculator". Ditambah div `mt5ModalNoSizing` (tersembunyi default) yang muncul kalau `window._lastSizing` belum ada / tidak cocok pair, dengan CTA "Buka Sizing Calculator →".
- `ckShowMt5Modal()`: `matchSz` sekarang mensyaratkan `lots`, `slPrice`, DAN `tpPrice` ada (bukan fallback ke `0.01`/kosong seperti sebelumnya). Kalau tidak match → field/section dan tombol "Konfirmasi Entry" disembunyikan, hanya warning + CTA yang tampil. Kalau match → field terisi read-only persis dari hasil Sizing Calculator.
- `ckGoToSizingFromModal()` (baru): tutup modal MT5, pindah ke tab Sizing, auto-set `szPair` ke pair yang sama, toast pengingat "isi entry/stop lalu balik ke checklist".
- `ckMt5OrderConfirm()`: guard tambahan — kalau `lots` tetap 0 (longgar terlewat lewat console/edge case), tolak submit dengan toast, bukan diam-diam kirim order.
- Fix kecil terkait (ditemukan saat audit, bukan permintaan langsung tapi searah): `ckShowMt5Modal()` sebelumnya `return` diam-diam kalau skor checklist <50% (user klik tombol, tidak ada respons apa pun). Ditambah toast `"Checklist belum cukup — Skor masih X%"` supaya gate-nya terasa tegas, bukan tombol yang kelihatan mati.

**Testing:** Playwright headless terhadap `index.html` yang disajikan statis (server backend tidak dijalankan, expected 404 di API calls — tidak relevan ke logic yang diuji). 3 skenario diverifikasi lewat manipulasi state langsung (`window._lastSizing`, `ckState`) lalu screenshot:
1. Checklist 100%, tanpa data sizing → modal terbuka tapi cuma tampilkan warning + tombol redirect, field & tombol konfirmasi tersembunyi.
2. Checklist 100%, sizing diisi (`lots:0.25, sl:1.23000, tp:1.24500`) → field lot/SL/TP terkunci read-only, nilainya persis sama dengan sizing, tombol konfirmasi muncul.
3. Checklist skor 0% → modal tidak terbuka sama sekali (toast tampil, sudah dicek lewat behavior, tidak discreenshot ulang).
Tombol redirect diverifikasi membuka tab Sizing dengan pair ter-prefill otomatis.

**Catatan:** celah lain dari audit checklist (gate section tidak wajib 100%, reset tanpa cooldown, ganti playbook = reset state, override reason tanpa validasi isi) belum disentuh — user pilih fokus ke satu celah ini dulu (lot/SL/TP) karena itu yang paling kena ke pola emosinya secara langsung. Sisanya didokumentasikan ke user sebagai opsi lanjutan, menunggu keputusan mana yang mau dikerjakan berikutnya.

---

## Changelog Session 94 (2026-06-23)

### Tombol "Mulai ke Sizing Calc" di card Thesis XAU/USD + warna disamakan ke tab Sizing

**Konteks:** Card Thesis XAU/USD (tab RINGKASAN) sebelumnya tidak punya tombol aksi sama sekali (beda dari card Thesis FX yang sudah punya `thesisGoToSizing()` dari session 93). User minta disamakan + warna tombol jangan pink (warna lama yang dipakai sebelum disadari salah) — diganti ke warna yang benar-benar dipakai tab SIZING di nav (`var(--accent)`, merah-maroon brand "Daun Merah" — dikonfirmasi dari CSS `.nvtab[data-view="sizing"] { color: var(--accent); }`, bukan biru yang dipakai drawer icon).

**Implementasi:** `thesisGoToSizing()` di-refactor jadi generik — terima parameter `(pair, direction)` langsung dari pemanggil, bukan baca `_lastThesis` di dalam fungsi (supaya bisa dipakai baik dari card FX maupun XAU yang field-nya beda bentuk: `t.direction` long/short vs `t.xau_bias` bullish/bearish/neutral/conflicting). Tombol baru di `renderXauThesisCard()` cuma muncul kalau `xau_bias` itu `bullish` atau `bearish` (mapped ke long/short) — disembunyikan total kalau `neutral`/`conflicting`, konsisten dengan card FX yang juga sembunyi tombol saat `direction === 'no_trade'`. CSS `.thesis-use-btn` diubah dari `var(--pink)` → `var(--accent)`, berlaku otomatis untuk kedua tombol (FX dan XAU) karena reuse class yang sama.

---

## Changelog Session 93 (2026-06-23)

### Auto-load Polymarket + Korelasi, thesis AI bahasa Indonesia, satukan jalur Thesis → Checklist

**1. Bug bahasa: AI Thesis field bebas (`invalidation_condition`, `catalyst_dependency`, `xau_driver_evidence`, `xau_key_trigger`) keluar Bahasa Inggris.** Root cause: Call 1 (briefing prosa) di `api/market-digest.js` punya instruksi eksplisit "Tulis Bahasa Indonesia" (`DIGEST_SYSTEM_DEFAULT`), tapi Call 2-3 (thesis JSON) sama sekali tidak punya instruksi bahasa — AI default ke Inggris walau UI label-nya sudah Indonesia ("INVALIDASI", "BUKTI", dst). Fix: tambah anotasi bahasa di skema JSON tiap field + 1 baris rule eksplisit "All free-text string fields ... must be written in Bahasa Indonesia". Catatan: hasil lama yang sudah di-cache di Redis (`latest_article`) tetap Inggris sampai user generate ulang.

**2. Auto-load Polymarket (tab RINGKASAN) + Korelasi Cross-Asset (tab TEKNIKAL) — sebelumnya wajib klik manual.** Kedua panel ini adalah satu-satunya yang masih manual-trigger di seluruh app (semua data tab lain — CAL, COT, FUNDAMENTAL, dll — sudah pakai pola staleness-check auto-fetch saat tab dibuka). Disamakan ke pola yang sama: `if (!data || (now - fetchedAt) > TTL) fetchX()` dipanggil di view-switch handler ('ringkasan') dan `initTeknikal()`. TTL klien disamakan dengan cache server: Polymarket 30 menit (`polymarket_signal_v3`), Korelasi 24 jam (`correlations_v2`) — jadi auto-fetch cuma benar-benar hit upstream kalau cache server juga sudah expired, bukan tiap kali pindah tab. Tombol manual tetap ada (diganti label "↻ Refresh ..." dari "↻ Muat ...") untuk override kapan saja. Teks placeholder statis dan instruksi di tab PETUNJUK yang menyebut "klik tombol Korelasi" / "tab RINGKASAN" (salah — Korelasi sebenarnya di tab TEKNIKAL, bug dokumentasi lama) diperbaiki sekaligus. Note "buka tab KORELASI" di widget Portfolio Risk (Jurnal) juga dikoreksi — tab itu tidak pernah ada, Korelasi adalah sub-section TEKNIKAL.

**Trade-off auto-load (didiskusikan ke user):** menambah 1 request per pembukaan tab RINGKASAN/TEKNIKAL kalau cache server expired (bukan tiap kali — Redis cache 24h/30m yang sudah ada menyerap mayoritas trafik). Risiko utamanya bukan biaya, tapi waktu render tab sedikit lebih lama saat cache benar-benar miss (network round-trip ekstra di background, non-blocking — UI lain tetap responsif). Dianggap worth it karena selama ini data ini sering kelewat dipakai (user harus ingat klik manual), padahal sama pentingnya dengan data tab lain yang sudah auto.

**3. Satukan jalur Thesis AI → Sizing Calculator → Checklist → Jurnal/MT5 (pola yang sama dengan Session 87, sekarang satu jalur resmi dari hulu ke hilir).** Tombol "Gunakan untuk mulai jurnal →" di card Thesis FX (tab RINGKASAN) sebelumnya loncat LANGSUNG ke form Jurnal, melewati gate skor Checklist DAN tahap sizing — inkonsistensi yang sama dengan yang diperbaiki di Sizing Calculator session 87. **Iterasi pertama** (revisi awal sesi ini) diganti ke `thesisGoToChecklist()` (loncat ke Checklist, skip Sizing) — tapi user koreksi: thesis adalah titik paling hulu di funnel (sebelum keputusan sizing pun dibuat), jadi seharusnya rute-nya ke Sizing dulu, bukan ke Checklist. **Diperbaiki jadi `thesisGoToSizing()`**: tombol "Mulai ke Sizing Calc →", pindah ke tab Sizing + auto-set `szPair` ke `pair_recommendation` + `szSetDir(t.direction)`. User isi stop/entry manual (tidak ada di data thesis), lalu lanjut natural via tombol `szGoToChecklist()` yang sudah ada (session 87) ke Checklist → Jurnal/MT5. Auto-tick item Checklist relevan tetap otomatis lewat `ckAutoTickRegimeCheck` yang sudah ada, begitu pair di-set di tahap Checklist. `ckPrefillJurnal()` dan `ckShowMt5Modal()` tetap override direction inferred dari CB bias dengan direction AI thesis (`_lastThesis.direction`) kalau pair cocok, dan katalis/invalidasi thesis ikut nempel ke teks jurnal final.

**Testing:** extract + `new Function()` semua inline `<script>` setelah tiap perubahan — lolos tanpa syntax error. Verifikasi manual TTL cache server vs client (`correlations.js` CACHE_TTL=86400, `admin.js` polymarket CACHE_TTL=1800) untuk pastikan guard client selaras, tidak over-fetch.

---

## Changelog Session 92 (2026-06-23)

### Bug fix — Portfolio Risk widget (Jurnal) hitung dollar-risk XAU/USD 10x lebih kecil dari Sizing Calculator

**Konteks:** User menyadari ketidakcocokan: Sizing Calculator bilang "At risk $66.80" (XAU/USD, 0.02 lots, stop 3000p), tapi widget "Portfolio Risk" di tab Jurnal cuma menampilkan "$7" untuk posisi yang sama.

**Root cause:** pip size XAU/USD didefinisikan di 3 tempat secara konsisten sebagai `0.01` (lihat `calcPipValueUSD()` baris ~7638, `szAutoComputePips()` baris ~7768, `szUpdatePipInfo()` baris ~7867 — 1 pip = $0.01 pergerakan harga, pip value = $1/lot/100oz). Tapi fungsi `PIP_SIZE()` di renderer Portfolio Risk (dalam `jnRenderVaR`, dipakai untuk hitung `stopPips` dari selisih entry/stop price) keliru pakai `0.1` untuk XAU/USD — 10x lebih besar. Karena `stopPips = priceDiff / pipSize`, pembagi yang 10x kebesaran membuat `stopPips` (dan akibatnya `dollarRisk = stopPips × pipValue × lots`) terhitung 10x lebih kecil dari realita.

**Fix:** ubah `PIP_SIZE` XAU/USD dari `0.1` → `0.01` agar konsisten dengan 3 tempat lain.

### Bug fix tambahan — note "buka tab KORELASI" muncul walau cuma 1 posisi open

**Konteks:** User nanya kenapa widget Portfolio Risk minta buka tab KORELASI padahal cuma ada 1 posisi (XAU/USD) — korelasi antar pair logikanya cuma relevan kalau ada 2+ posisi.

**Root cause:** `noCorrNote` di `jnRenderVaR` (baris ~8442) ditampilkan berdasarkan `!corrData` doang, tanpa cek jumlah posisi. Padahal `portfolioVar1d` cuma memanggil `getCorr()`/`corrData` kalau `vi.length > 1` (baris ~8401-8414) — dengan 1 posisi, `portfolioVar1d = vi[0].var1d` langsung, korelasi sama sekali tidak dipakai.

**Fix:** tambah kondisi `varItems.length > 1` ke `noCorrNote` supaya note itu cuma muncul kalau korelasi benar-benar relevan untuk kalkulasi yang sedang ditampilkan.

**Verifikasi:** `node -e` simulasi manual dengan angka kasus user (stop 3000p, 0.02 lots, pip value $1/lot) → hasil `$60.00` setelah fix, sangat dekat dengan target `$66.80` Sizing Calculator (selisih kecil murni dari pembulatan `lots` ke 2 desimal, bukan bug); sebelum fix hasilnya `$6` (cocok dengan `$7` yang dilaporkan user, beda dikit karena rounding stop price). Extract+`new Function()` semua inline `<script>` di `index.html` → tidak ada syntax error. Grep ulang memastikan tidak ada sisa pip-size `0.1` lain untuk XAU/USD di file.

---

## Changelog Session 91 (2026-06-23)

### Bug fix — status "LIVE (fallback)" tidak pernah muncul karena Redis cache-hit path lupa propagate `X-News-Source`

**Konteks:** User curiga sebuah artikel di tab NEWS ("...Asia-Pacific FX news wrap...") sebenarnya berasal dari fallback Investinglive (link mengarah ke investinglive.com, dan headline itu tidak ada di website financialjuice.com), padahal status pill di UI menunjukkan "LIVE" biasa, bukan "LIVE (fallback)". Awalnya diasumsikan itu cuma konten sister-site yang disindikasi FinancialJuice — tapi ditelusuri lebih dalam ke kode karena user tetap yakin.

**Root cause ditemukan di `api/feeds.js` `rssHandler`:** payload yang disimpan ke Redis (`rss_cache`) menyimpan field `source` (`'financialjuice'` atau `'investinglive_fallback'`), tapi dua jalur baca cache — cache-hit normal (baris ~63-69) dan stale-cache saat fetch gagal total (baris ~107-112) — keduanya **tidak pernah** men-set header `X-News-Source` dari `obj.source`, hanya men-set `X-Cache-Source`. Frontend (`index.html` `fetchRSS()`) default ke `lastNewsSource = 'financialjuice'` kalau header itu kosong, jadi setiap kali respons disajikan dari Redis cache (yang sebagian besar waktu, karena TTL 60s) — info fallback hilang dan status pill salah tampil "LIVE" walau isi feed sebenarnya dari investinglive.

**Fix:** tambah `res.setHeader('X-News-Source', obj.source || 'financialjuice')` di kedua jalur baca cache (REDIS hit dan STALE).

**Verifikasi:** `node --check api/feeds.js` lolos. Tidak ada jalur baca `RSS_CACHE_KEY` lain yang terlewat (grep konfirmasi cuma 2 baca + 1 tulis). Belum diverifikasi live end-to-end karena butuh momen FinancialJuice benar-benar down untuk memicu fallback secara natural — perbaikan ini struktural (memastikan header source selalu konsisten antara fresh-fetch dan cache-hit), bukan logic baru yang berisiko regresi.

---

## Changelog Session 90 (2026-06-22)

### Audit tab CHECKLIST untuk skenario multi-window

**Konteks:** Lanjutan session 89 (multi-window). User nanya "ada yang kepanjangan placeholdernya ga". Ketemu 2 hal nyata via Playwright + baca kode langsung (bukan cuma screenshot sekilas):

1. **Bug fungsional** — fitur hash-restore dari session 89 (`restoreViewFromHash()`) dipanggil sebagai IIFE saat script masih di-parse, SEBELUM `const SZ_PAIRS`/`PLAYBOOKS`/`CK_SECTIONS` (dideklarasikan ratusan baris di bawah dalam script yang sama) selesai diinisialisasi. Akibatnya: buka window baru langsung ke `#checklist` (atau tab lain yang depend ke const-const itu) → `ReferenceError` (temporal dead zone) di tengah `initChecklist()`, pair selector gagal terisi. Lolos dari verifikasi session 89 karena waktu itu cuma dites pakai `#jurnal` (kebetulan gak kena TDZ). **Fix:** panggilan restore dipindah ke dalam `window.addEventListener('load', ...)` yang sudah ada (jalan setelah seluruh script selesai dieksekusi, jadi semua const sudah pasti siap) — bukan lagi IIFE di tempat lama.
2. **Bug visual pre-existing** (bukan sebab multi-window, tapi kebuka jelas pas ngecek lebar sempit) — widget "Progress" di sidebar Checklist (`.ck-sp-name`) punya `width: 52px` hardcoded buat nama tiap section, jadi 8 dari 10 judul section ("VALIDITAS DRIVER", "FUNDAMENTAL BIAS", "PRE-MARKET DECISION", dst) kepotong jadi cuma ~7 karakter + "…" — **ini terjadi di SEMUA lebar window termasuk desktop 1920px penuh**, gak ada hubungan sama multi-window, cuma baru ketahuan pas ditest. Fix: lebar dinaikkan ke 78px (2 judul paling panjang — "PRE-MARKET DECISION"/"STRUKTUR TEKNIKAL" — masih kepotong dikit, sisanya sekarang utuh) + tambah native `title` attribute biar ada tooltip hover nampilin judul lengkap kalau masih kepotong.

**Hal lain yang DICEK tapi TIDAK bermasalah:** section header utama ("VALIDITAS DRIVER" dkk di body checklist, bukan sidebar) wrap 2 baris secara wajar di lebar ~800px tanpa kepotong/rusak; verdict besar "SIAP TRADE" wrap jadi 2 baris di sidebar 232px tapi tetap utuh terbaca; MT5 modal & override modal terverifikasi rapi di 480px (quarter-window). Sidebar Checklist (Quick Check + Waktu/clock + tombol Reset) memang sengaja disembunyikan total di lebar <768px (breakpoint mobile lama) — diganti versi ringkas (verdict + progress bar + tombol Jurnal/MT5 doang) di mobile bar; ini desain lama yang masih konsisten dipakai, bukan regresi dari multi-window, cuma dicatat di sini sebagai konteks kalau user pop-out Checklist ke window sempit (<768px) dan nyari tombol Reset/Quick Check nggak ketemu — naikkan lebar window dulu kalau perlu fitur itu.

**Testing:** Playwright headless, lebar 480/700/800/900/1100/1920px, pair EUR/USD, ~80% item dicentang biar semua widget (verdict ENTRY-state, tombol Jurnal/MT5, Progress list penuh) ke-render — sebelum fix: error TDZ + sidebar truncation 8/10; sesudah fix: hash-restore checklist sukses (pair selector terisi, tidak ada console error), sidebar truncation tinggal 2/10 (yang memang nggak mungkin fit di 232px tanpa redesain total), no horizontal overflow di semua lebar yang dites.

---

## Changelog Session 89 (2026-06-22)

### Multi-window support — hash routing + tombol pop-out

**Konteks:** User minta app bisa dipakai fleksibel kalau dibuka jadi 4 window terpisah di layar laptop (window manager OS, bukan split-view internal). Ditemukan 2 hal lewat audit kode: (1) `activeView` sudah variabel in-memory per-window (bukan localStorage), jadi tiap window browser yang dibuka ke app ini SUDAH otomatis independen navigasinya satu sama lain — tidak perlu di-refactor; (2) yang BENERAN belum ada: cara mendaratkan sebuah window langsung ke view tertentu (tiap window baru selalu mulai dari DASHBOARD/NEWS, user harus klik tab manual tiap kali), dan cara cepat "lempar" view yang sedang aktif ke window baru.

**Implementasi:** hash routing (`switchView`/klik tab nav sekarang `history.replaceState(null,'', '#'+view)`), restore-on-load (`restoreViewFromHash()` IIFE + `hashchange` listener baca `location.hash` lalu `.click()` tab yang sesuai), dan tombol pop-out baru (⧉, id `popoutBtn`, di header sebelah ikon lonceng) yang `window.open()` ke `location.href` + `#activeView` dengan window name `dm_<view>` (re-klik popout utk view yg sama fokus ke window yang sudah ada, bukan numpuk duplikat).

**Bug ditemukan & diperbaiki saat verifikasi:** handler `window.addEventListener('load', ...)` yang lama selalu force-klik tab DASHBOARD di desktop width, override hash routing yang baru — di-guard supaya skip default-landing itu kalau `location.hash` sudah berisi view spesifik.

**Testing:** Playwright headless (chromium, viewport desktop & 480px/quarter-screen-laptop): klik tab → hash berubah (`#sizing`/`#jurnal`/`#checklist`), reload langsung ke `#jurnal` → landing tepat di Jurnal (sebelum fix: salah landing ke Dashboard), klik pop-out → window baru ke URL yang benar, dan screenshot di 480px untuk Sizing/Checklist/Jurnal — tidak ada overflow horizontal, bottom-nav muncul, top-nav tersembunyi (breakpoint mobile lama sudah pas dipakai ulang untuk kasus quarter-window).

---

## Changelog Session 88 (2026-06-22)

### Tombol hapus di Riwayat Sizing Calculator

**Konteks:** Dipicu user nanya "history sizing calc ga perlu di hapus kah" pas lagi coba-coba hitung sizing (dikonfirmasi dulu ke user: coba-coba di Sizing 100% aman, nggak nyentuh skor Checklist/Jurnal/AI Coach — cuma numpuk di riwayat read-only yang sebelumnya nggak bisa dihapus manual, walau backend sudah auto-cap 10 entry terakhir).

**Implementasi:** `api/sizing-history.js`: tambah `DELETE` — `?timestamp=X` hapus satu entry (`ZREMRANGEBYSCORE` pakai timestamp sebagai score, sesuai cara `ZADD` nyimpennya), `?all=1` hapus semua (`DEL` key). `index.html`: tombol "×" kecil per-item (`szDeleteHistoryItem`) + "Hapus semua" di header riwayat (`szClearAllHistory`) — optimistic update (hapus dari local cache + re-render duluan, network call fire-and-forget, konsisten sama pola `szSaveHistory` yang sudah ada).

**Testing:** diuji live ke Redis production pakai device_id sintetis: POST 2 entry → DELETE 1 by timestamp (sisa 1 entry yang benar) → DELETE all (kosong) — semua sesuai ekspektasi.

---

## Changelog Session 87 (2026-06-22)

### Satukan jalur entry: Sizing Calculator → Checklist → Jurnal/MT5

**Konteks:** Dulu ada 2 jalur paralel beda ketat. User bingung liat tombol Sizing langsung "→ BUAT TRADE DI JURNAL" sementara Checklist juga punya jalur sendiri ke MT5/Jurnal — ternyata itu memang inkonsistensi nyata: `szPrefillJurnal()` lama loncat LANGSUNG ke form Jurnal, melewati gate skor Checklist, snapshot CB bias/COT, DAN friksi override yang baru dibangun session 85 — sama sekali nggak lewat pagar yang sudah dibangun di jalur lain.

**Fix:** diganti jadi `szGoToChecklist()`: pindah ke tab Checklist + auto-set `ckPairSelector` ke pair yang sama dengan hasil sizing (penting — `ckShowMt5Modal()` cuma auto-fill lot/SL/TP dari `window._lastSizing` KALAU pair-nya match persis; tanpa auto-sync ini, user tetap harus pilih pair manual ulang di Checklist, balik bingung lagi). Sekarang cuma ada SATU jalur resmi: Sizing → Checklist (gate + snapshot + override-friction) → Jurnal/MT5, lot/SL/TP nempel otomatis sepanjang jalur tanpa input ulang.

---

## Changelog Session 86 (2026-06-22)

### MFE/MAE di Jurnal + Event Risk di Sizing Calculator

**Konteks:** Dipicu kritik gaya-Gemini soal `api/journal.js` (AI Coach "buta eksekusi" — nggak tahu harga sempat bergerak favorable sebelum exit, cuma evaluasi thesis vs hasil akhir) dan `calcSizing()` (ATR cuma lihat volatilitas 14 hari ke belakang, buta terhadap event kalender besok seperti NFP/FOMC yang bisa bikin lot besar over-leveraged). User pilih 2 dari 4 saran (skip pagination AI Coach & hard-multiplier sizing yang dinilai kebablasan).

**MFE/MAE (`api/journal.js`):** Dihitung SEKALI, persis saat trade ditutup (PATCH ke status closed/archived) — bukan retroaktif saat analyze, karena cache OHLCV cuma rolling window (~5 hari di 1H, ~10 hari di 4H, ~30 hari di 1D, di-refresh terus oleh cron `ohlcv_sync`), jadi cuma saat-trade-ditutup itu satu-satunya momen data dijamin masih nutup `entry_time`. Fungsi `computeMfeMae()` coba 3 tier granularitas (1h→4h→1d), pakai yang pertama nutup penuh durasi trade; kalau ketiganya gagal (trade kelamaan held atau pair nggak ke-sync) → field `quality: 'unavailable'` eksplisit, BUKAN angka ngarang. Hasil masuk ke prompt AI (instruksi baru "Realitas Eksekusi" — AI diminta bedain LOSS karena thesis salah (MFE kecil) vs LOSS karena panic-exit (MFE besar tapi tetap exit rugi)) dan ditampilkan di card list Jurnal (cuma kalau data tersedia — disembunyikan kalau unavailable, biar nggak nge-spam "data tidak cukup" di tiap card trade lama). Diverifikasi live ke Redis production: entry 2 jam lalu kena window-gap karena cron OHLCV sedang lag ~3-4 jam (temuan sampingan, dicatat tapi nggak difix di sesi ini), entry 8 hari lalu berhasil fallback ke tier 1h (gap weekend bikin 120 candle 1H nutup >10 hari kalender), entry 40 hari lalu & pair non-sync benar2 ke-flag unavailable.

**Event Risk (`calcSizing()` di `index.html`):** Reuse `calData` (variabel global yang sudah ada) + `_ckEvTimestamp()` (helper yang sebelumnya cuma dipakai Checklist) — bukan endpoint/fetch baru. Window 24 jam (lebih lebar dari Checklist yang 6 jam, karena sizing adalah keputusan pre-trade yang diambil lebih awal dari trigger entry). Kalau ada event High-impact untuk currency base/quote pair dalam 24 jam: banner merah `#szEventRiskWarning` + saran "Lot diskon 50%" ditampilkan **di samping** hasil normal — TIDAK auto-apply/force, user tetap pilih sendiri (konsisten sama filosofi "warn don't dictate" yang sudah dipakai di seluruh app ini, ditolak ide Gemini soal hard-multiplier otomatis). Diverifikasi live ke kalender production: 10 event High-impact real hari itu (CAD CPI, AUD jobs, USD PCE) semua di luar 24 jam dari "now" jadi nggak trigger — dikonfirmasi BENAR (bukan bug) dengan event sintetis yang disisipkan manual ke response asli.

---

## Changelog Session 85 (2026-06-22)

### Smart Checklist — friksi wajib-alasan saat override item auto-blocked

**Konteks:** Dipicu kritik gaya-Gemini tentang fitur Checklist (`ckPrefillJurnal` dinilai brilian sebagai jembatan pre-trade→jurnal, tapi rawan *self-deception* kalau checklist 100% manual). Sebelum implementasi, riset kode dulu via subagent (2x) — temuan penting: auto-tick **sudah ada** (`ckAutoTickRegimeCheck`, item `rc1`-`rc5` + beberapa item per-playbook) tapi cuma kosmetik, badge hijau/merah doang — user bisa klik & flip item auto-blocked kapan saja tanpa friksi sama sekali, jadi auto-tick yang ada sekarang nggak ngefek apa-apa ke kebiasaan FOMO. Opini saya ke user: ide Gemini "user tidak bisa mengubahnya" (hard-lock total) kebablasan untuk app discretionary trading (data auto bisa lag/ambigu — sudah kebukti berulang kali sepanjang proyek ini), tapi versi "wajib ketik 1 kalimat alasan kalau override" itu level yang pas. User: "boleh buat saja".

**Implementasi:** state baru `ckAutoBlocked{}`/`ckAutoBlockHints{}` (in-memory, direkomputasi setiap `ckAutoTickRegimeCheck` jalan) + `ckOverrideReasons{}` (persisted per-pair, key `daunmerah_v2_overrides_<PAIR>`, sejalan dengan `ckState` yang sudah per-pair). `ckToggleItem(id)`: kalau user mau centang item yang sedang `ckAutoBlocked`, nggak langsung toggle — buka modal `#ckOverrideModal` (`ckRequestOverride`) yang nampilin alasan kenapa item itu di-block sistem (`ckAutoBlockHints[id]`) + textarea wajib diisi ≥5 karakter sebelum tombol konfirmasi aktif (`ckOverrideInputCheck`). Konfirmasi (`ckConfirmOverride`) baru men-set `ckState[id]=true` + simpan alasan, badge berubah jadi kuning "⚠ overridden" (beda dari hijau "✓ auto" dan merah "⚠ blocked"). Item non-blocked tetap toggle bebas tanpa friksi apapun — friksi cuma kena ke override sinyal merah, bukan ke checklist manual biasa.

**Self-cleanup logic:** uncheck item yang sudah di-override → hapus alasan tersimpan (state nggak nyangkut). Kalau sistem sendiri kemudian bilang item itu OK (`ckAutoTick` jalan lagi, kondisi sudah resolve) → alasan override lama otomatis dihapus juga, supaya teks jurnal nggak bawa catatan "override" yang sudah nggak relevan.

**`ckPrefillJurnal`/MT5-entry thesis text** (2 tempat, sama-sama dipatch): item yang dicentang via override sekarang muncul dengan anotasi `✅ [label] (⚠ override: "[alasan user]")` — supaya rekam jejak journal beneran mencatat KALAU dan KENAPA user melawan sinyal otomatis, bukan cuma checkbox polos.

**Bug lama ikut diperbaiki sambil di sini:** `ckAutoTick` sebelumnya hanya reset warna/teks badge kalau badge BARU dibuat (`if (!badge)`) — item yang pernah merah lalu sistem bilang OK lagi akan TETAP nampak merah secara visual walau `ckState` sudah `true`. Sekarang badge selalu di-reset warna/teks tiap kali `ckAutoTick`/`ckAutoBlock` jalan, nggak peduli badge baru atau lama.

**Testing:** `node --check` semua inline `<script>`, 6 skenario logic test terisolasi (toggle item blocked → minta override; konfirmasi dengan alasan valid → overridden; alasan terlalu pendek → ditolak; item manual normal → toggle bebas; uncheck item overridden → alasan terhapus; sistem auto-resolve → alasan stale ikut terhapus) — semua PASS. Live sanity check via `vercel dev` (index.html load 200, tidak ada syntax error). **Catatan jujur:** tidak ada verifikasi visual klik-modal di browser sungguhan (Playwright belum terinstall) — sebatas logic test + structural HTML review terhadap pattern modal yang sudah teruji (`mt5Modal`).

---

## Changelog Session 84 (2026-06-22)

### Auto-fill Catatan Analisa (manual trigger via tombol)

**Konteks:** User minta balik tombol auto-fill di Catatan Analisa juga ("kamu boleh tambahin juga auto di catatan analisa") — tapi kali ini cuma manual-trigger via tombol "↻ Auto" yang diklik eksplisit, TIDAK auto-jalan sendiri di pair switch/tab init (beda dari percobaan session 83 yang langsung di-reject).

**Implementasi:** `composeTekAutoNote()` + `autoFillTekNote()` ditambah balik, isinya identik dengan versi yang sempat direvert — bedanya cuma di wiring: tidak dipanggil dari `selectTekPair()`/`initTeknikal()`, hanya dari `onclick` tombol. Klik tombol akan mengganti isi catatan yang ada (bukan cuma kalau kosong) karena klik eksplisit = consent untuk replace.

---

## Changelog Session 83 (2026-06-22)

### Auto-fill dropdown MTF (D1/H4/H1) di tab TEK dari trend Makro/Swing/Entry

**Konteks:** Percobaan pertama (salah paham) auto-fill ke textarea "Catatan analisa" — user koreksi langsung: "kalau catatan analisa itu aku aja yang buat catatannya", yang dimaksud justru dropdown alignment "D1 −, H4 −, H1 −, M15 −" yang sebelumnya manual full (pilih Bull/Bear/Neut sendiri per timeframe). Revert: hapus tombol/wiring auto-fill dari Catatan Analisa, textarea itu kembali 100% manual seperti semula.

**Implementasi:** `mapTrendToMtf()` + `autoFillMtfSelectors()` — D1/H4/H1 diisi otomatis dari `d.d1.trend`/`d.h4.trend`/`d.h1.trend` (sumber data sama dengan tab ANALISA, `/api/admin?action=ohlcv_read`, reuse `analisaDataCache`), map Uptrend→bull/Downtrend→bear/Sideways→neut. M15 sengaja dibiarkan manual — tidak ada trend H15 terkomputasi di mana pun di app ini, daripada fabrikasi sinyal kualitas rendah. Non-destructive: cuma isi selector yang masih kosong (`—`), tombol "↻ Auto" di baris dropdown buat force-regenerate D1/H4/H1 kapan saja. Keterbatasan sama dengan sebelumnya: cross pair non-major kadang belum punya data MTF tersedia (limitasi `ohlcv_sync` lama) — ditangani toast pesan jelas.

---

## Changelog Session 82 (2026-06-22)

### Option Gravity Heatmap — Tab TEK

**Konteks:** Lanjutan diskusi proposal UI/UX (heatmap option expiry + macro quadrant risk/inflasi). Sebelum eksekusi, dievaluasi kritis dulu: macro quadrant ditahan (lihat alasan di catatan header atas), heatmap option dieksekusi karena murah secara teknis dan datanya nyata.

**Constraint teknis yang ditemukan:** data `size` dari option expiry (`api/feeds.js` `optionsHandler`) sering kosong sejak Investinglive pindah ke format prosa (lihat session sebelumnya soal `parseProseExpiries`) — jadi "gravitasi" nggak bisa selalu dihitung dari notional asli. Solusi: fallback ke count-based weight (tiap level yang disebut = weight 1) kalau size kosong/tidak terparse, size asli dipakai kalau ada (dinormalisasi ke skala "juta": "1.2bln" → 1200, "500mln" → 500).

**Implementasi (`index.html`):**
- `parseOptionSizeWeight(sizeStr)` — parse string size ("1.2bln", "€500m", dll) jadi angka weight; fallback 1 kalau kosong/gagal parse.
- `renderOptionGravityHeatmap(filtered)` — bukan clustering eksplisit, tapi histogram-binning: range harga (termasuk level min/max + current price kalau tersedia dari `tekTaCache`) dibagi 36 bin, tiap level expiry menambah weight ke bin terdekat + sedikit smoothing ke bin tetangga (25% spillover) supaya level berdekatan terlihat menyatu jadi satu hot-zone, bukan paku terpisah-pisah. Render sebagai strip flexbox CSS murni (tinggi bar + opacity warna oranye proporsional terhadap intensitas) — tidak ada library chart yang ditambahkan. Current price ditandai garis vertikal "NOW". Bawahnya ditampilkan teks 3 level "gravitasi terkuat" sebagai ringkasan cepat.
- Graceful degradation: kalau cuma 0-1 level numerik valid (kasus nyata — hari testing cuma ada 1 expiry GBP/USD), fungsi return string kosong dan tabel level yang sudah ada tetap tampil normal tanpa heatmap, tidak ada elemen kosong/error yang nongol.
- CSS baru: `.tek-grav-*` (wrap/strip/bin/axis/now-marker/peaks), reuse warna `--yellow`/`--muted`/font `DM Mono` yang sudah ada di tema.

**Testing:** 6 skenario logic test terisolasi (cluster realistis, size berformat, single-point skip, array kosong, format range "1.1540-1.1600", tanpa current price) — semua sesuai ekspektasi. Live wiring test ke `api/feeds?type=options` production (data real hari ini: cuma 1 expiry GBP/USD 1.3200) — konfirmasi graceful skip jalan benar, tidak ada heatmap kosong yang dipaksa render. Render HTML preview manual dengan data multi-level mock — visual hot-zone muncul tepat di level dengan size terbesar, marker NOW di posisi proporsional yang benar. **Catatan jujur:** tidak ada verifikasi screenshot browser asli (Playwright tidak terinstall di environment ini) — verifikasi sebatas logic test + HTML/CSS preview manual, bukan visual end-to-end di browser sungguhan.

---

## Changelog Session 81 (2026-06-22)

### Risk Regime "Selalu Neutral" — Investigasi yang Membalik Hipotesis Sendiri

**Konteks:** User penasaran kenapa badge Risk Regime di tab TEK sepertinya selalu nampilkan "NEUTRAL" — bertanya apakah itu kondisi pasar yang genuinely netral atau fitur yang nggak berfungsi.

**Langkah 1 (live check):** Tarik VIX & MOVE langsung dari Yahoo Finance — VIX=17.51, MOVE=65.4, keduanya valid (bukan fetch gagal). `classifyRegime()` di `api/risk-regime.js` butuh VIX<15 untuk `risk_on`, dan VIX 17.51 jatuh di celah 15-20 (bukan risk_on, bukan elevated >20) → otomatis `neutral`.

**Langkah 2 (hipotesis awal, keliru):** Cek distribusi VIX 2 tahun terakhir — VIX<15 cuma 14% hari, 15-20 (zona neutral) 61.3% hari. Simpulkan sementara: threshold `risk_on` (VIX<15) kelewat strict dibanding realisasi pasar, sehingga `neutral` jadi default state. **Disampaikan ke user sebagai temuan awal.**

**Langkah 3 (backtest 10 tahun, membalik kesimpulan):** User minta dikerjakan recalibration. Sebelum mengubah angka, backtest `classifyRegime()` versi SEKARANG terhadap histori VIX+MOVE 10 tahun penuh (bukan 2 tahun) — hasilnya: **risk_on 26.3% / neutral 28% / elevated 28.2% / risk_off 17.5%**, distribusi yang sudah sehat, tidak didominasi satu bucket. Coba 4 kandidat threshold baru berbasis persentil (p25/p50/p75/p90 dari histori 10 tahun) — semua kandidat baru TIDAK memperbaiki apapun: salah satu varian (`p25/p75/p90`) malah memperburuk jadi neutral 47.2%, dan **tidak satupun** kandidat mengubah hasil klasifikasi hari itu (VIX=17.47, MOVE=65.4) — tetap `neutral` di semua varian, karena nilai itu memang persis di persentil-53 (median) histori 10 tahun.

**Kesimpulan revisi:** threshold yang ada SEKARANG sudah cukup baik dikalibrasi terhadap siklus pasar 10 tahun. Yang membuat user merasa "selalu neutral" adalah dua hal yang bukan bug: (1) 2024-2026 secara realized memang periode vol yang lebih tinggi dari rata-rata dekade (VIX<15 cuma 14% di window ini vs 35% di 10 tahun penuh), dan (2) logika "worst-indicator-wins" multi-sinyal (VIX/MOVE/HY) secara matematis selalu membuat `risk_on` butuh SEMUA indikator calm bersamaan (AND) sementara `elevated`/`risk_off` cuma butuh SATU indikator memburuk (OR) — asimetri ini inheren di desain risk dashboard konservatif, bukan sesuatu yang "bisa diperbaiki" tanpa mengorbankan keandalan sinyal risk_off.

**Yang dieksekusi (bukan ubah threshold, tapi tambah konteks):** `api/risk-regime.js` — tambah breakpoint persentil `VIX_PCTL_10Y` / `MOVE_PCTL_10Y` (dari Yahoo 10y daily, dihitung 2026-06-22) + `percentileRank()` (interpolasi linear), field baru `vix_percentile_10y` / `move_percentile_10y` di response. `index.html` — baris VIX/MOVE di detail breakdown regime banner sekarang menampilkan persentil (mis. "· P53/10th"), plus catatan kecil menjelaskan artinya, supaya user paham bahwa "neutral" sering = median yang valid, bukan symptom kerusakan.

**Pelajaran:** jangan commit ke "fix" berdasarkan sampel waktu pendek (2 tahun) yang kebetulan biased terhadap periode anomali — backtest pakai window yang merepresentasikan siklus penuh dulu sebelum mengubah threshold produksi.

---

## Changelog Session 80 (2026-06-22)

### NEWS Fallback Source — Investinglive Kalau FinancialJuice Down

**Konteks:** Lanjutan session 79 — item "tidak dieksekusi" (fallback RSS) sempat ditunda karena belum ada sinyal urgensi. User minta dicek ulang: "cek bagian news, apakah bisa di scrap." Bukan asumsi — langsung uji fetch ke beberapa kandidat dari jaringan nyata sebelum menjawab.

**Hasil riset kandidat:**
| Sumber | Hasil |
|---|---|
| Investinglive `/feed/news/` | ✅ HTTP 200, RSS standar WordPress, 25 item, genre macro/forex sama persis dengan FJ (politik UK, Iran/Hormuz, China rare earth) |
| Investing.com `/rss/news_1.rss` | ✅ HTTP 200, kategori "Forex News" khusus |
| DailyFX | ❌ fetch gagal total |
| FXStreet | ❌ fetch gagal total |
| Reuters (feed publik) | ❌ 404, sudah tidak aktif |

Investinglive dipilih: domain sudah dipercaya (dipakai untuk option expiries di `optionsHandler`), dan struktur XML-nya (`<rss><item><title><guid><pubDate><link><description>`, CDATA-wrapped) **kompatibel langsung** tanpa transformasi dengan parser yang sudah ada (`parseRSSItems` di server, `parseRSS` di frontend) — tidak perlu endpoint normalisasi baru.

**Implementasi (`api/feeds.js` `rssHandler`):** Tambah `RSS_FALLBACK_URL`. Kalau fetch FinancialJuice gagal (network error / HTTP non-200 / response bukan RSS), coba fetch Investinglive sebelum jatuh ke stale Redis cache. Cache payload (`rss_cache`) sekarang menyimpan field `source` (`'financialjuice'` atau `'investinglive_fallback'`) untuk observability. Response header baru `X-News-Source` (selain `X-Cache-Source` yang sudah ada, sekarang juga punya value `FALLBACK`).

**Bug ikut ditemukan & diperbaiki (pola sama dengan session 79):** `redisCmd('SET', RSS_CACHE_KEY, ...).catch(()=>{})` di `rssHandler` adalah fire-and-forget tanpa `await` sebelum response dikirim — berisiko function Vercel mati sebelum SET selesai (TTL cache cuma 50-60s jadi dampaknya kemungkinan setiap fetch nyaris selalu miss cache dan hit upstream langsung, memperberat beban ke FinancialJuice). Diubah jadi `await` dengan try/catch.

**Frontend (`index.html`):** `fetchRSS()` sekarang membaca header `X-News-Source` dan simpan ke `lastNewsSource`. `fetchFeed()`: kalau `lastNewsSource === 'investinglive_fallback'`, status pill NEWS tab tampil "LIVE (fallback)" dengan dot kuning berkedip (`.dot.warn`, CSS baru — reuse pola blink dari `.dot.live` tapi warna `var(--yellow)`) supaya user sadar sedang baca sumber non-primer, bukan diam-diam ganti sumber tanpa indikasi.

**Testing:** `node --check` semua file + extract inline `<script>`. Live test via `vercel dev` + Redis production: (1) path normal — `financialjuice`, 100 item, header `X-News-Source: financialjuice`; (2) path fallback — `global.fetch` di-monkey-patch supaya request ke `financialjuice.com` reject, request ke Investinglive tetap asli → hasil 25 item, `X-Cache-Source: FALLBACK`, cache Redis tersimpan dengan `source: investinglive_fallback` (diverifikasi langsung via Upstash REST GET, bukan cuma percaya response). Direplay juga logic `parseRSS()` frontend persis terhadap XML Investinglive asli — 25/25 item lolos punya guid+title+pubDate+link lengkap.

---

## Changelog Session 79 (2026-06-22)

### Audit Ketahanan Informasi — 4 Perbaikan Silent-Failure di `api/`

**Konteks:** User membawa kritik dari Gemini soal kerentanan arsitektur `api/` (stuck CB bias, OHLCV blind spot saat rotasi pair, TA cache nunggu user, calendar tanpa fallback, single-source RSS). Sebelum eksekusi, kritik tersebut **diverifikasi langsung ke kode** (bukan ditelan mentah) — beberapa klaim Gemini ternyata salah/basi karena dia tidak baca `index.html`: staleness indicator UI sebenarnya **sudah ada luas** (9+ tempat: `cotStaleBadge`, CB rate liveDot, correlations/polymarket/research/retail-positioning stale tag, dll), dan OHLCV cache **sudah** punya cron warmer (GitHub Actions `ohlcv-sync.yml`, hourly) — Gemini melewatkan keduanya. Sebaliknya, `api/calendar.js` ternyata **lebih rapuh** dari yang Gemini bilang: satu-satunya endpoint tanpa serve-stale-cache sama sekali (langsung 500 kalau ForexFactory/Cloudflare block IP Vercel), padahal pola serve-stale sudah konsisten dipakai di `correlations.js`.

**Perbaikan yang dieksekusi (prioritas direvisi berdasarkan temuan di atas):**

1. **`api/calendar.js` — stale-cache fallback (prioritas tertinggi, gap nyata).** Tambah `CACHE_KEY='calendar_v1'`, TTL 6 jam. Sukses fetch → `await redisCmd('SET', ...)` (awalnya ditulis fire-and-forget `.catch(()=>{})` tanpa `await` — **bug nyata ketemu saat testing**: function Vercel mati sebelum SET selesai, jadi cache_v1 selalu kosong. Diperbaiki jadi `await` sebelum response dikirim, diverifikasi ulang via Upstash REST langsung). Saat fetch gagal total → serve cache lama dengan `stale: true` + `stale_reason`. Frontend (`index.html`): tambah `#calStaleBadge` (reuse class `.cot-stale-badge`) di header kalender, di-toggle di `fetchCalendar()` dan `fetchCalendarSilent()`.

2. **TA cache warmer — `.github/workflows/ta-warm.yml` (baru).** Hourly cron, loop 8 pair tetap (XAU + 7 FX major) ke `/api/correlations?action=ta&symbol=X&interval=1d` dengan header `x-cron-secret`. `api/correlations.js` Call `action=ta` ditambah bypass rate-limit kalau header cron-secret valid (pola sama dengan `ohlcv_sync` di `admin.js`). Cache key (`ta:{symbol}:1d`) persis sama dengan yang dibaca `fetchTaCache()` di `market-digest.js` — tidak perlu endpoint baru.

3. **`api/market-digest.js` — stuck-bias jadi divergence-flag.** Sebelumnya: swing bias >2 step dengan confidence non-High → `continue` (di-skip total, tanpa jejak). Sekarang: bias lama dipertahankan TAPI `confidence` di-downgrade ke `'Low'` + simpan `divergence_warning: {suggested_bias, suggested_confidence, detected_at, source_headlines}`. Auto-clear di cycle berikutnya kalau swing sudah mengecil atau confidence jadi High (object di-replace penuh, tidak ada field lama yang nempel). Confidence High dengan swing besar tetap langsung flip (behavior lama tidak berubah — ini fix untuk kasus ambigu saja). Diteruskan ke `cb-status.js` (`divergence_warning` di response) dan dirender di CB tracker UI (badge kuning "⚠ Divergence: bias mungkin bergeser ke X", reuse class `.cb-manual-warn`).

4. **OHLCV pair selection ikut headline dominan.** `CB_KW`/`kwTest` (sebelumnya didefinisikan lokal di dalam `_biasPromise`, dipakai cuma untuk Call 2) dipindah ke module-level supaya bisa dipakai ulang. Tambah `CUR_TO_OHLCV_PAIR` map (7 currency non-USD → pair label standar). Sebelum fetch OHLCV: hitung jumlah headline per currency dari `recentItems`, pilih currency dengan match terbanyak → map ke pair (mis. GBP dominan → `GBP/USD`). Kalau tidak ada currency mayor di headline hari ini, fallback ke `pair_recommendation` thesis kemarin (behavior lama), lalu default `EUR/USD` kalau itu pun kosong. USD sendiri tidak dihitung (sudah inherent di XAU/USD context yang selalu di-load).

**Testing:** `node --check` semua file diubah (lolos). Extract inline `<script>` dari `index.html` → `node --check` (lolos, tidak ada syntax error dari edit HTML). Replika logic test offline (tanpa cost API): pair-selection 5 skenario (GBP-dominant, EUR-dominant, no-major-news, USD-only-tidak-pilih-USD-pair, JPY-dominant) — **semua PASS**; divergence-flag 4 skenario (big-swing+Medium→flag, big-swing+High→flip langsung, small-swing→update normal, divergence-clear-di-cycle-berikutnya) — **semua PASS**. Live test: `vercel dev` lokal + `vercel env pull` (kredensial production asli) — `/api/calendar` normal & stale-fallback (disimulasikan dengan mock `fetch` reject langsung di handler) keduanya 200 dengan flag `stale` benar; `/api/correlations?action=ta` berfungsi; `/api/cb-status` mengembalikan field `divergence_warning` (null untuk currency normal). Tidak menjalankan `market-digest.js` end-to-end secara live karena costly (multi-LLM call berbayar) — divalidasi via logic replica test saja.

**Tidak dieksekusi dari saran Gemini (dengan alasan):** fallback RSS source untuk FinancialJuice — belum ada insiden downtime tercatat di histori project, risiko terendah dari 5 item yang diaudit, ditunda sampai ada sinyal nyata diperlukan.

---

## Changelog Session 75 (2026-06-22)

### BTC: Triple-Barrier Labeling — Diuji, Hasil: Signifikan Tapi Lebih Lemah Dari Champion

**Konteks:** Konsultasi eksternal (Gemini, diberi konteks lengkap `daun_merah.md` sesi 71-72 + `volatility_regime.py`) mengkritik bahwa target arah/vol-regime di proyek ini pakai label fixed-horizon (`.shift(-HORIZON)`) yang buta terhadap *path* harga — harga bisa menyentuh level lalu berbalik dalam horizon yang sama, dan tetap dianggap satu label. Diusulkan reformulasi via **Triple-Barrier Method** (Lopez de Prado): TP/SL berbasis ATR + time barrier, bukan delay tetap.

**Implementasi (`ml/triple_barrier.py`, baru):** Label long-only — untuk tiap bar, TP = close + 2×ATR, SL = close − 1×ATR, horizon 6 bar (sama dengan `target_dir_6`/`target_vol_regime_6` untuk komparasi adil). Label 1 jika TP tersentuh duluan, 0 jika SL duluan; tie dalam bar yang sama dianggap 0 (tidak bisa dipastikan urutannya dari OHLC). Dua varian time-barrier: "strict" (timeout dibuang) dan "loose" (timeout = 0). Walk-forward CV (LR/RF/GB) + permutation test, sama persis rigor eksperimen lain di proyek ini.

**Hasil:**
| Timeframe | Varian | AUC terbaik (Logistic Regression) | p-value |
|---|---|---|---|
| 4h | loose | 0.582 ± 0.024 | 0.000 |
| 4h | strict | 0.566 ± 0.023 | 0.000 |
| 1d | loose | 0.607 ± 0.075 | 0.000 |
| 1d | strict | 0.597 ± 0.067 | 0.000 |

Sinyalnya nyata (lolos permutation test di semua varian), tapi **lebih lemah dan jauh kurang stabil** dibanding champion proyek (`target_vol_regime_6`: AUC 0.633 ± 0.0035). Std di triple-barrier 0.02-0.075 vs 0.0035 — terutama buruk di 1d (cuma 2635 baris setelah dropna, ~527/fold). Catatan menarik: Logistic Regression menang di sini, bukan tree model — pola terbalik dari semua eksperimen lain di proyek ini (sinyal lebih linear-separable tapi tipis). Distribusi label: TP duluan ~18-20%, SL duluan ~46%, timeout ~34-36%.

**Kesimpulan:** kritik metodologis Gemini soal path-blindness itu valid, tapi memperbaikinya via triple-barrier tidak menghasilkan model lebih baik — cuma target reformulation dengan edge lebih kecil dan lebih tidak stabil. Konsisten dengan kesimpulan sesi 72: ceiling-nya ada di data (informasi yang bisa diekstrak dari OHLCV+konteks BTC sendiri), bukan di cara pelabelan atau pilihan algoritma. **Jangan disarankan ulang tanpa data/horizon yang genuinely baru.**

**File baru:** `ml/triple_barrier.py` (belum di-push — masih tahap eksperimen lokal per instruksi user).

---

## Changelog Session 72 (2026-06-19)

### BTC: EDA Target Volatility-Regime, GARCH/Sentiment, Mitigasi Multikolinearitas

**Konteks:** User minta dorong AUC volatility-regime ke 70% (dari baseline 0.633), dan minta cek ulang EDA/data-prep dulu sebelum nambah sumber data eksternal lagi — siapa tahu ada insight lebih murah daripada VIX/data baru.

**1. EDA baru, khusus target volatility-regime (`ml/eda_volregime.py`)** — EDA lama (`eda.py`) ternyata ditulis untuk target arah harga (era sebelum vol-regime jadi andalan), belum pernah diprofilkan untuk target ini. Temuan:
- Fitur non-vol (momentum/sentimen/COT) kontribusinya nyata: vol-only (3 fitur) AUC 0.58 (4h)/0.65 (1d) vs full set (25 fitur) 0.63/0.67.
- `fear_greed` masuk top-5 feature importance RF di kedua timeframe.
- ACF `realized_vol_6` sendiri decay pelan (lag1=0.91, lag6=0.43, lag20=0.35, lag60=0.21 di 4h) — ada memori volatilitas lebih panjang dari window 6/20 yang dipakai sekarang.
- Garman-Klass/Rogers-Satchell estimator cuma beda tipis dari Parkinson yang sudah dipakai — tidak worth diganti.
- Distribusi target per tahun fluktuasi besar (0.16-0.38) — sumber utama std antar-fold yang tinggi di CV 1d.

**2. GARCH(1,1) + fear_greed extremity — diuji ketat, hasil: TIDAK membantu (`ml/vol_regime_garch.py`)** — Dua ide termotivasi temuan EDA di atas: GARCH(1,1) conditional volatility (model eksplisit untuk persistence, dimotivasi temuan ACF) dan `|fear_greed-50|` (capture sentimen ekstrem di kedua arah, dimotivasi feature importance). Diuji walk-forward CV dengan disiplin no-lookahead (parameter GARCH di-fit dari training fold saja, lalu di-filter dengan parameter beku ke seluruh series). Hasil RF 4h: baseline 0.6329±0.0034, +fear_greed_extreme 0.6322±0.0105, +GARCH 0.6333±0.0031, +both 0.6337±0.0079 — semua delta dalam rentang noise. **Akar masalah ditemukan:** GARCH conditional vol berkorelasi **0.956** dengan `realized_vol_20` yang sudah jadi fitur — bukan informasi baru, cuma menurunkan ulang info yang sudah ada di rolling window.

**3. Mitigasi multikolinearitas pada fitur** — Dicek khusus untuk feature set vol-regime (16-21 pasang |corr|>0.7). Ditemukan 3 fitur vol-level yang dipakai saling redundan (realized_vol_6 ↔ parkinson_vol_mean_6 = 0.88, ↔ realized_vol_20 = 0.75-0.88) — efektif cuma ~1.5 sinyal independen, bukan 3 — ini penjelasan tambahan kenapa GARCH (mirip salah satunya) tidak nambah. Diimplementasikan: pangkas `ret_1`, `macd_signal`, `ema12_gt_ema26`, `cot_noncomm_long_pct`, `bb_pctb` dari `FEATURE_COLS` (`ml/train_models.py`) dan `realized_vol_6` dari `extra_cols` (`ml/volatility_regime.py`) — 25→19 fitur. Diverifikasi via walk-forward CV sebelum commit: tidak ada AUC cost (baseline baru 0.6302±0.0062 vs lama 0.633±0.0036, sama secara statistik), malah sedikit lebih stabil untuk Logistic Regression. Semua file hasil yang ter-commit (`model_comparison.json`, `cross_validation.json`, `regression_comparison.json`) diregenerate ulang dengan fitur yang sudah dipangkas supaya konsisten dengan kode — kesimpulan direction/regresi tidak berubah (tetap ~0.50-0.53 AUC, tetap R² negatif).

**4. VIX (cross-asset macro risk) — kandidat terakhir, dites, hasil: TIDAK signifikan.** Satu-satunya kandidat "informasi genuinely baru" yang masih belum dites setelah GARCH/sentiment ternyata cuma menurunkan ulang info yang sudah ada. VIX (CBOE volatility index, harian, gratis dari Yahoo sejak 1990 — tidak ada masalah histori pendek seperti DVOL). Korelasi mentahnya dengan target paling kuat dari semua fitur cross-asset yang dicoba (+0.07 di 4h, +0.10 di 1d). RF 4h walk-forward CV: 0.6270±0.0076 (tanpa VIX) → 0.6286±0.0028 (+VIX), delta +0.0015. Untuk memastikan bukan kebetulan, dilakukan permutation test LANGSUNG pada delta-nya (bukan cuma pada AUC) — shuffle target 30x, hitung ulang delta tiap kali, lihat di mana delta asli jatuh di distribusi itu. **Hasil: p=0.300 — tidak signifikan**, delta asli sepenuhnya konsisten dengan rentang kebetulan.

**Kesimpulan untuk pertanyaan "bisa ke 70%?":** Sudah dijawab TUNTAS secara empiris (gabungan session 71 DVOL + session 72 ini). Empat kandidat untuk push AUC di atas 0.63 — DVOL (data baru), GARCH (model lebih canggih), sentiment extremity (transformasi fitur), VIX (cross-asset macro) — semuanya dites dengan rigor walk-forward CV + permutation test, dan semuanya gagal. Ada penjelasan struktural kenapa: fitur rolling-window yang sudah ada sudah menyerap hampir semua informasi yang bisa direcover secara linear dari histori harga BTC sendiri. Untuk melewati 0.63 perlu sumber data yang genuinely baru (bukan derivasi dari OHLCV atau proxy cross-asset berkorelasi lemah) atau target/horizon yang fundamental berbeda — belum ada kandidat konkret saat ini. **Riset BTC ML sekarang benar-benar mentok tanpa input baru dari user.**

**5. Regresi besaran volatilitas (vs klasifikasi biner) — dites, hasil: GAGAL (`ml/vol_regression.py`)** — User tanya: yang sudah dites itu klasifikasi (top 30%/bukan), bagaimana dengan regresi nilai volatilitas-nya langsung? Beda dari regresi return (`train_regression.py`) yang sudah dicoba sebelumnya — ini regresi `forward_vol` (nilai kontinu di belakang threshold biner), belum pernah dicoba. Diuji walk-forward CV dengan baseline persistence (vol besok = `realized_vol_20` hari ini). **Hasil: Random Forest cuma R²=+0.030±0.049 (4h, nyaris nol) dan -0.195±0.202 (1d, negatif)** — Linear Regression dan Gradient Boosting negatif & tidak stabil antar-fold, **MLP divergen total** (R² minus ribuan, tanda training meledak). Single-split sempat kelihatan OK (R²=0.11-0.13) tapi itu fluke lagi — CV mean-nya jauh negatif, kejadian ketiga di proyek ini di mana single-split menyesatkan. **Kenapa regresi gagal padahal klasifikasi (agak) berhasil:** `forward_vol` itu standar deviasi dari cuma 6 return — sample sangat kecil, margin error sample std n=6 sekitar 30%, jadi target itu sendiri noisy. Klasifikasi cuma butuh rank/posisi relatif terhadap threshold yang benar, regresi butuh nilai eksak — itu kenapa noise target lebih mematikan untuk regresi.

**Kesimpulan akhir riset BTC ML:** output yang bisa dipakai dari seluruh riset ini adalah **classifier biner `target_vol_regime_6`** (sudah di pipeline produksi) — BUKAN forecast magnitude volatilitas. Semua jalur yang teridentifikasi sudah dites tuntas (arah harga, regresi return, klasifikasi vol-regime, regresi vol magnitude, DVOL, GARCH, sentiment extremity, VIX, multikolinearitas).

**File diupdate:** `ml/train_models.py`, `ml/volatility_regime.py`, `ml/STATUS.md`, `ml/results/REPORT.md`, `ml/results/model_comparison.json`, `ml/results/cross_validation.json`, `ml/results/regression_comparison.json`, `daun_merah_plan.md`. **File baru:** `ml/eda_volregime.py`, `ml/vol_regime_garch.py`, `ml/vol_regression.py`. (Eksperimen VIX dilakukan ad-hoc/interaktif, tidak dipersist jadi script baru karena hasilnya negatif — data `vix_test.csv` dihapus setelah pengujian selesai.)

---

## Changelog Session 71 (2026-06-19)

### BTC: Selesaikan Integrasi DVOL + Uji Ketat — Hasil: Tidak Membantu

**Konteks:** Lanjutan riset BTC dari session 70. Sebelumnya, integrasi fitur DVOL (Deribit implied volatility) berhenti di tengah jalan — data sudah di-backfill dan di-push, tapi `scripts/feature-engineering.js` belum menggunakannya di output kolom. Tujuannya menjawab pertanyaan terbuka: apakah AUC volatility-regime (baseline 0.633±0.0035) bisa didorong lebih tinggi (target 70-80%) dengan menambah DVOL sebagai fitur baru.

**Yang dikerjakan:**
1. **`scripts/feature-engineering.js`** — selesaikan kode yang sudah disiapkan (`dvolFf`, `dvolIndexByTs` sudah dihitung tapi belum dipakai): tambah `dvolIdx` lookup dan dua kolom baru ke output row: `dvol_close`, `dvol_change_1`. Regenerate `data/btc/features_4h.csv` (19.353 baris, 37 kolom) dan `features_1d.csv` (3.229 baris, 37 kolom). Coverage DVOL ~59% (terbatas sejak 2021-03-24, lebih pendek dari sumber lain 2017-18).
2. **`ml/volatility_regime.py`** — tambah opsi `use_dvol` ke `build_dataset()`, lalu jalankan perbandingan **apple-to-apple**: baseline vs +DVOL di baris yang identik (subset era-DVOL), bukan baseline-full-history vs +DVOL-history-lebih-pendek (yang akan merancukan efek DVOL dengan efek window waktu yang berbeda). Dievaluasi dengan rigor yang sama seperti eksperimen volatility-regime sebelumnya: single-split, walk-forward CV (4 fold), permutation test, 5 algoritma (Logistic Regression, Random Forest, Gradient Boosting, MLP, LSTM).

**Hasil (lengkap di `ml/results/REPORT.md` poin 10):**
- 4h: baseline di era-DVOL (n=11.473) AUC 0.6125±0.0502 vs +DVOL AUC 0.6185±0.0463 — selisih +0.006, jauh lebih kecil dari std antar-fold (0.046-0.05) → **tidak signifikan, noise bukan sinyal**.
- 1d: selisih +0.0003 — juga tidak signifikan, dan jauh lebih noisy (std 0.12-0.13) karena dataset jauh lebih kecil.
- **Temuan penting lain:** membatasi data ke era-DVOL saja (2021+, tanpa fitur DVOL sekalipun) sudah menurunkan AUC dari 0.633 (full history 2017-2024) ke 0.6125 — window 2021+ mencakup bear market BTC paling parah, lebih sulit diprediksi terlepas dari DVOL.
- **Kesimpulan:** DVOL, walau secara konsep adalah kandidat data baru paling kuat (implied volatility dari pasar opsi, beda jenis informasi dari realized vol historis yang sudah dipakai), **tidak terbukti menambah edge** setelah dievaluasi jujur. Kolom `dvol_close`/`dvol_change_1` tetap dipertahankan di pipeline (tidak merugikan), tapi tidak dipakai untuk klaim peningkatan model.

**Implikasi untuk arah riset:** AUC 0.633±0.0036 (Random Forest, 4h, volatility-regime, full history) kemungkinan adalah plafon untuk pendekatan dan fitur yang sudah dicoba. Semua jalur yang teridentifikasi (arah harga, regresi, volatility-regime, DVOL) sudah dites tuntas. Untuk melangkah lebih jauh (target 70-80%) perlu target/horizon yang fundamental berbeda atau sumber data baru — belum ada kandidat konkret saat ini.

**File diupdate:** `scripts/feature-engineering.js`, `ml/volatility_regime.py`, `ml/results/REPORT.md`, `ml/STATUS.md`, `daun_merah_plan.md`.

### Bersihkan Backlog Stale — `daun_merah_plan.md`

Audit mandiri: section 4.2 (FX Risk Reversals) dan 4.4 (Portfolio VaR) di `daun_merah_plan.md` masih berstatus "TUNGGU keputusan" / "SIAP DIKERJAKAN" — padahal keduanya **sudah live di production sejak session 46-47** (dikonfirmasi via curl ke endpoint production + cek kode `index.html`/`api/correlations.js`). Dokumen backlog belum pernah diupdate sejak 2026-06-03. Diringkas jadi catatan "selesai, live di production" supaya tidak rancu di sesi berikutnya. Backlog aktif sekarang cuma menyisakan BTC ML research (section 5), yang juga sudah mentok — semua jalur teridentifikasi sudah dites (lihat di atas).

---

## Changelog Session 70 (2026-06-18)

### Data Collection: BTC Dataset untuk Model Prediksi (Fase 1 — selesai)

**Konteks:** Eksplorasi membangun model prediksi bias arah BTC sebagai pendukung narasi thesis (bukan sinyal trading mandiri — ekspektasi akurasi directional realistis 52-58%, bukan 70-80%). Fase ini fokus murni ke data collection; modeling belum dimulai.

**Sumber data final (7 dataset, semua gratis):**
- **OHLCV spot BTC/USDT** (1h/4h/1d) — `data-api.binance.vision`, sejak 2017-08-17
- **COT Bitcoin (CME futures)** — `cftc.gov`, open interest + positioning non-commercial/commercial, mingguan sejak 2018-04
- **Fear & Greed Index** — `alternative.me`, harian sejak 2018-02
- **Hash rate** — `mempool.space`, harian sejak 2009, tanpa batasan histori
- **Stablecoin supply** (USDT+USDC market cap) — CoinGecko, harian, **dibatasi 365 hari ke belakang** (kebijakan free tier CoinGecko, bukan pilihan kita)
- **BTC dominance** — CoinGecko `/global`, snapshot harian — **tidak ada histori gratis** (Pro-only), akumulasi mulai sekarang ke depan saja
- **Funding rate (perpetual)** — di-drop, tidak ada sumber gratis yang tidak ter-geoblock
- **Orderbook live** — di-skip, tidak relevan untuk horizon intraday-swing & tidak cocok arsitektur serverless

**Masalah signifikan yang ditemukan & diperbaiki:**
1. `api.binance.com` (spot) dan `fapi.binance.com` (futures) **return HTTP 451 dari GitHub Actions runner** — Binance membatasi akses derivatif dari IP US karena alasan regulasi (CFTC restricted location), bukan bug. Spot dipindah ke `data-api.binance.vision` (mirror resmi Binance, tidak ter-geoblock). Futures (funding rate + open interest) tidak ada workaround resmi → open interest diganti sumber **CFTC COT CME Bitcoin** (kode kontrak `133741`), funding rate didrop permanen.
2. `cftc.gov` (untuk download zip historis COT) **403 di `fetch()` Node** (Cloudflare bot management, fingerprint TLS) tapi lolos via `curl` — download di `scripts/lib/cot-bitcoin.js` pakai `execFileSync('curl', ...)` bukan `fetch()`.
3. Jam sistem lokal awalnya disangka salah (cert Binance "expired") — ternyata jam benar, masalahnya DNS ISP lokal redirect `api.binance.com` ke `aduankonten.id` (blokir Kominfo), beda dari masalah geoblock GitHub Actions di atas.
4. CoinGecko free tier menolak query historis lebih dari 365 hari ke belakang (HTTP 401, `error_code: 10012`) — `stablecoin_supply` jadi terbatas 1 tahun, bukan full history sejak USDT/USDC listing.
5. CoinGecko free tier rate-limit ketat (429 setelah beberapa request berturutan) — ditambahkan `fetchJsonPatient()` di `btc-data.js` dengan backoff lebih sabar (10s × attempt, max 5x) khusus untuk panggilan CoinGecko.

**File baru:**
- `scripts/btc-backfill.js`, `scripts/btc-sync.js`, `scripts/lib/{btc-data,btc-sources,cot-bitcoin,extra-sources}.js`
- `.github/workflows/btc-backfill.yml` (workflow_dispatch, one-off) + `.github/workflows/btc-sync.yml` (cron hourly, auto-commit)
- `data/btc/*.csv` — terisi penuh: OHLCV 1h (77.332 baris), 4h (19.349), 1d (3.228), COT (427), Fear&Greed (3.056), hashrate (6.376), stablecoin_supply (365), btc_dominance (1, bertambah harian)

**Verifikasi data:** 0 duplikat di semua dataset; gap minor di OHLCV 1h/4h (28 dan 8 gap, max 34 jam, tersebar 2017-2023, konsisten dengan downtime exchange di awal era Binance) — OHLCV 1d, hashrate, dan stablecoin_supply tanpa gap berarti.

### Feature Engineering (Fase 2 — selesai)

**`scripts/feature-engineering.js`** menggabungkan ke-7 dataset jadi satu feature matrix per timeframe (`data/btc/features_4h.csv`, `features_1d.csv`), masing-masing 31 kolom:

- **Indikator teknikal** (dari OHLCV, dihitung sendiri di `scripts/lib/indicators.js`, tanpa dependency npm): `ret_1/6/18`, `log_ret_1`, `volatility_z20`, `rsi_14`, `macd`/`macd_signal`/`macd_hist`, `atr_14`, `bb_pctb` (Bollinger %B), `price_to_sma20`, `sma20_gt_sma50`, `ema12_gt_ema26`, `volume_z20`, `volume_change_pct`
- **Konteks eksternal** (forward-filled ke timestamp candle, **timestamp-gated — tidak ada lookahead bias**, nilai cuma muncul setelah benar-benar tersedia): `cot_open_interest`, `cot_net_noncomm`, `cot_noncomm_long_pct`, `cot_net_change_1w`, `fear_greed`, `hashrate`, `stablecoin_total_cap`, `btc_dominance_pct`
- **Target** (forward-looking, untuk fase modeling): `target_ret_6/18` (return n-periode ke depan), `target_dir_6/18` (1=naik, 0=turun)

**Sanity-check terhadap event historis yang dikenal** (bukan cuma cek row count):
- RSI turun ke 15-25 saat Black Thursday (12-13 Maret 2020, crash BTC $8000→$4800) — oversold ekstrem, sesuai ekspektasi
- RSI ~67-68 + `bb_pctb` > 1 (breakout upper band) tepat di ATH 8 November 2021 ($67.525) — overbought, sesuai ekspektasi
- 1 nilai `Infinity` ditemukan di `volume_change_pct` (candle volume=0 era awal Binance 2017) — diperbaiki, semua non-finite ditulis kosong bukan `Infinity`/`NaN`

**Coverage per kolom** (file 1d, 3.228 baris): indikator teknikal ~99% (NaN cuma di periode awal sebelum cukup histori), COT 92.7% (sebelum April 2018 belum ada), fear&greed 94.8% (sebelum Feb 2018), hashrate 100%, stablecoin 11.3% (limitasi 365 hari), btc_dominance 0% di file 1d saat ini (snapshot pertama diambil 15:53 UTC, setelah candle harian tutup jam 00:00 — akan mulai terisi mulai besok).

Workflow GitHub Actions (`btc-backfill.yml` dan `btc-sync.yml`) sudah di-update untuk regenerate feature matrix otomatis setiap kali data baru masuk.

### Model Comparison (Fase 3 — selesai, hasil: tidak ada edge yang robust)

**`ml/train_models.py`** (Python, `.venv` lokal — pandas, scikit-learn, torch/CPU) melatih 5 algoritma + 2 baseline naif (Logistic Regression, Random Forest, Gradient Boosting, MLP, **LSTM**), di 4 kombinasi timeframe×horizon, evaluasi awal pakai chronological split 80/20. **Fitur dipakai:** 22 kolom (teknikal + COT + fear&greed + hashrate) — `stablecoin_total_cap`/`btc_dominance_pct` di-exclude karena coverage historis rendah.

**Bug ditemukan & diperbaiki sebelum hasil final:** CFTC COT punya **publish-lag ~3 hari** (data "as of" Selasa, dirilis Jumat berikutnya) yang belum diperhitungkan di forward-fill `scripts/feature-engineering.js` — sempat ada lookahead bias kecil (candle bisa "lihat" data COT 3 hari sebelum benar-benar publik). Fixed dengan `COT_PUBLISH_LAG_MS`; semua model dilatih ulang dengan data yang sudah benar.

**`ml/cross_validation.py`** — walk-forward CV (4 fold ekspanding kronologis) untuk cek apakah hasil single-split di atas itu robust atau kebetulan. **Hasilnya penting:** config yang sebelumnya tampak terbaik (Random Forest, 1d/18-hari, single-split AUC 0.548) ternyata rata-rata AUC across-fold cuma **0.481 — di bawah 0.50, lebih buruk dari lempar koin.** Itu cuma kebetulan bagus di satu jendela test tertentu, bukan edge yang nyata. Satu-satunya hasil yang terlihat agak konsisten: **Random Forest di 4h/1-hari, AUC 0.532 ± 0.010** (mean tipis di atas random, tapi variansnya kecil antar-fold) — itu hasil paling kredibel di seluruh proyek ini, dan tetap sangat lemah.

**`ml/train_regression.py`** — eksperimen prediksi besaran return (`target_ret_6/18`, bukan cuma arah). **Hasil lebih buruk lagi:** hampir semua model (Linear Regression, Gradient Boosting, MLP, LSTM) punya **R² negatif** — lebih buruk daripada cuma menebak return 0%. Random Forest R²=0.0015, secara statistik sama dengan nol. Prediksi besaran return jauh lebih sulit daripada arah.

**Kesimpulan final (lengkap di `ml/results/REPORT.md`):**
1. Tidak ada edge direksional yang robust — satu-satunya hasil yang lolos CV (Random Forest 4h/1-hari, AUC 0.532) terlalu lemah untuk dijadikan sinyal apapun.
2. Hasil "terbaik" yang dilaporkan sebelum CV (55.6%/AUC 0.569 → 0.548 setelah fix bug) **tidak robust** — ini koreksi penting dari kesimpulan sesi sebelumnya.
3. Regresi besaran return tidak bekerja sama sekali.
4. **LSTM (deep learning) tidak pernah menang** di tiga eksperimen manapun — kadang malah jauh lebih buruk (R² regresi sangat negatif).
5. Lima algoritma yang sangat berbeda semua konvergen ke ~0.50 AUC — ini bukti bottleneck-nya **data/fitur, bukan pilihan algoritma**.

**Rekomendasi:** jangan dipakai sebagai sinyal trading atau bahkan input thesis-narrative yang percaya diri. Kalau tetap mau ada "lean" BTC di digest, posisikan sebagai narasi indikator teknikal/COT biasa (seperti sistem thesis XAU/forex yang sudah ada) — bukan probabilitas hasil model, karena model ini tidak terbukti menambah nilai di atas baca indikator langsung.

**Opsi lanjutan (belum dikerjakan):** feature pruning/importance analysis; reframe target dari "arah harga" (mendekati random walk) ke "deteksi rezim volatilitas tinggi" (lebih learnable secara teori); atau perbanyak fold CV (10+) untuk interval kepercayaan lebih ketat di hasil Random Forest 4h/1-hari yang borderline kredibel itu.

### Preprocessing Transparan di Pandas (tambahan)

**`ml/preprocess.py`** — versi pandas dari tahap cleaning+integrasi data, dipisah dari komputasi indikator teknikal (yang tetap di `scripts/feature-engineering.js`, Node). Tujuannya supaya proses seleksi kolom & pembersihan terlihat eksplisit langkah demi langkah, bukan tersembunyi.

- **Seleksi kolom per sumber** (didokumentasikan inline di kode): COT cuma ambil `open_interest` + 2 kubu utama (`noncomm_long/short`, `comm_long/short`) — buang `noncomm_spread` dan `nonreportable_*` (kurang informatif/lebih noisy); Fear&Greed cuma ambil `value` numerik, buang `classification` (cuma label kategori dari value yang sama); stablecoin cuma ambil total gabungan, buang breakdown USDT/USDC.
- **Cleaning**: dedupe timestamp, buang baris dengan harga ≤0/volume negatif (OHLCV), posisi negatif (COT), nilai di luar 0-100 (Fear&Greed, dominance), hashrate ≤0 — ditemukan 6 baris hashrate `0.0` di 4-9 Januari 2009 (beberapa hari setelah genesis block), dibuang (tidak berdampak karena OHLCV baru mulai 2017).
- **Merge**: `pandas.merge_asof(..., direction="backward")` — join point-in-time yang sama persis semantiknya dengan forward-fill di Node, tapi deklaratif/lebih mudah diaudit. Termasuk fix COT publish-lag yang sama.
- **Output**: `data/btc/clean_4h.csv`, `clean_1d.csv` (21 kolom, tanpa indikator teknikal).
- **Validasi cross-check**: dibandingkan manual dengan `features_1d.csv` (hasil Node) di tanggal 2021-11-10 — `close`, `open_interest`, `fear_greed`, `hashrate` semua identik, dan tanggal mulai COT (2018-04-13, sudah dengan koreksi lag) juga sama. Dua pipeline independen menghasilkan angka yang konsisten.

---

## Changelog Session 69 (2026-06-17)

### Polish: PWA Robustness — Notif Focus, Offline Awareness, Guards

**Konteks:** Pass penyempurnaan mandiri (tanpa instruksi spesifik) — fokus ke robustness PWA & UX yang aman, bukan refactor besar. Refactor konsolidasi 12→5 serverless function (`daun_merah.plan`) sengaja **tidak** dijalankan di sesi ini karena mengubah routing production dan butuh sesi terfokus + konfirmasi tersendiri.

**Perubahan `sw.js`:**
- `notificationclick` — **fix bug spawn instance baru.** Sebelumnya selalu `clients.openWindow(url)`, sehingga tiap kali notif diklik membuka instance/tab app baru. Sekarang:
  - Link eksternal (artikel http(s) ke host lain) → tetap buka tab baru
  - Link internal / `'/'` (buka app) → **fokus window app yang sudah terbuka**; hanya `openWindow` jika belum ada window
  - Deteksi via `isExternal = /^https?:\/\//i.test(url) && !url.includes(self.location.host)`
- `message` handler — tambah guard `if (!e.data) return;` (cegah throw saat menerima pesan tanpa `data`)

**Perubahan `index.html`:**
- **Connectivity awareness (baru):** listener `offline` → status pill jadi `OFFLINE`; `online` → `RECONNECTING` + `fetchFeed()` (refresh feed & status begitu jaringan kembali) + toast "Kembali online". Plus cek awal `if (!navigator.onLine) setStatus('error','OFFLINE')` saat load. Sebelumnya app hanya sadar `visibilitychange`/bfcache, buta terhadap putus/sambung jaringan.
- SW message listener (page side) — guard `e.data && e.data.type === 'NEW_ITEMS'`
- `<html lang="en">` → `lang="id"` (konten app full bahasa Indonesia — benar untuk screen reader/a11y)
- Tambah `<meta name="description">` (sebelumnya tidak ada) untuk metadata PWA/share

**Verifikasi:**
- `node --check sw.js` ✅ dan ekstraksi main inline script `index.html` (6785 baris) → `node --check` ✅
- Elemen `#dot`/`#statusText` (baris 1998–1999) berada sebelum `<script>` (2854) → aman dipanggil saat init
- `setStatus` adalah function declaration (hoisted) → tersedia di blok connectivity

---

## Changelog Session 67 (2026-06-16)

### Fix: Option Expiries — Prose Parser Fallback (Investinglive Format Change)

**Root cause:** Investinglive (`/feed/forexorders/`) sebelumnya mempublikasikan expiry data dalam format tabel terstruktur:
```
EUR/USD
1.0800 (€2.0bln)
1.0850 ($1.5bln)
```
Format ini sudah **berubah ke prosa naratif** — levels disebutkan dalam kalimat tanpa notional size:
```
"EUR/USD at the 1.1540 and 1.1600 levels"
```

**Perubahan `api/feeds.js`:**
- `parseOptionExpiries()` diubah menjadi dual-mode:
  - Primary: `parseStructuredExpiries()` — parser lama (pair header + level/size rows)
  - Fallback: `parseProseExpiries()` — parser baru: split per baris → deteksi pair via regex alias → extract semua angka decimal dalam baris yang sama → validasi range 0.3–5000
  - Field `size` dikembalikan sebagai string kosong `''` pada prose entries (tidak ada data notional)
- Tambah `?force=1` pada `optionsHandler` untuk bypass Redis cache (berguna setelah format change)

**Perubahan `index.html`:**
- `renderTekOptions()`: kolom Size disembunyikan jika semua filtered entries tidak punya size (`hasSizes` flag)
- Fix label sumber: `"sumber: Forexlive ↗"` → `"sumber: Investinglive ↗"`

**Verifikasi production:**
- Setelah deploy: `/api/feeds?type=options&force=1` mengembalikan EUR/USD 1.1540 + 1.1600 ✅

---

## Changelog Session 66 (2026-06-16)

### Feat: Ekspansi Sumber Riset + Option Expiries di TEK Tab

**Konteks:** Penambahan sumber-sumber supplemental berdasarkan analisis Gemini. FinancialJuice tetap sebagai satu-satunya sumber untuk AI digest dan tab NEWS — tidak berubah.

**Perubahan `api/feeds.js`:**
- `CB_RESEARCH_SOURCES` diperluas: tambah **RBA** (via rss2json), **BoC** (direct feed), **BoJ** (via rss2json)
- Tambah dua sumber macro research: **MTM** (Marc to Market) dan **ING** (ING Think) via rss2json
- Endpoint baru: `GET /api/feeds?type=options` — scrape Forexlive Technical Analysis RSS, cari post "FX option expiries … NY cut", parse data level + size per pair, cache 4h di Redis
- Parser `parseOptionExpiries()`: strip HTML → split per baris → detect pair header + inline pair → extract entries dengan regex level/size pattern
- `filterByPair()`: filter per tekPair dengan alias map (termasuk `XAUUSD: ['xau/usd','gold']`)

**Perubahan `index.html`:**
- CSS: tambah badge styles `.riset-badge.RBA`, `.BOC`, `.BOJ`, `.MTM`, `.ING` + CSS section `.tek-opts-*` untuk option expiries
- HTML (TEK panel): tambah div `#tekOptsSection` dengan header + `#tekOptsBody` — disisipkan antara `#tekNewsSection` dan `#corrPanelWrap`
- JS: `fetchTekOptions()` + `renderTekOptions()` — fetch cache 4h, filter berdasarkan `tekPair` aktif, render tabel level/size
- `onTekPairChange()` dan `initTeknikal()`: keduanya memanggil `renderTekOptions()` / `fetchTekOptions()` agar data selalu tersync dengan pair yang dipilih

**Desain keputusan:**
- XAU/USD akan sering kosong (Forexlive jarang publish XAU expiries) → tampilkan "Tidak ada expiry" bukan error
- AI digest tetap eksklusif dari `news_history` yang diisi hanya dari FinancialJuice

---

## Changelog Session 65 (2026-06-16)

### Fix: CAL Tab — Actual Values Auto-Update

**Problem:** Kolom ACTUAL di tab CAL menampilkan "—" meskipun ForexFactory sudah merilis nilai actual. Data hanya di-refresh saat user buka tab CAL (dengan threshold 1 jam), sehingga user harus manual refresh setiap kali ingin melihat actual terbaru.

**Root cause:**
- `startCountdownTimer()` menjalankan `renderCountdown()` setiap 30 detik — hanya update tampilan countdown, tidak re-fetch data
- `calFetchedAt` threshold 1 jam: data tidak di-fetch ulang sampai user tutup + buka tab CAL setelah 1 jam
- Background init refresh (S30M = 30 menit) update `calData` di memori tapi tidak re-render tab CAL

**Fix (`index.html`):**
1. Tambah variabel `let _calAutoRefreshTimer = null;` di calendar state section
2. `startCountdownTimer()`: tambah `setInterval(fetchCalendarSilent, 90000)` → `_calAutoRefreshTimer`
3. `stopCountdownTimer()`: clear `_calAutoRefreshTimer` saat user pindah tab
4. Tambah fungsi `fetchCalendarSilent()`:
   - Guard: `if (activeView !== 'cal') return` — tidak jalan jika user sudah pindah tab
   - Fetch `/api/calendar?_t=${buster}` dengan cache buster per 90s
   - Silent fail (no loading spinner, no error UI)
   - Update `calData`, `calFetchedAt`, panggil `renderCalendar()` + `renderCountdown()` + `updateCalLastUpdated()`

**Efek:** Actual values muncul otomatis dalam ≤90 detik setelah ForexFactory merilis data — tanpa manual refresh, tanpa loading spinner. Label "baru saja" di header kalender ikut update.

---

## Changelog Session 62 (2026-06-15)

### Analisa Feature Upgrade — MACD, ATR, Structured AI Output, Auto-refresh

**Tiga peningkatan sekaligus di tab ANALISA:**

**1. Indikator baru: MACD H4 + ATR 14H**
- `api/admin.js` — `_macdFull(closes)`: hitung MACD (EMA 12/26/9) dari H4 candles (butuh 35+ bar). Output: `macd`, `signal`, `histogram`, `status` (Bullish/Bearish/Recovering/Weakening)
- `_atr14h1(candles)`: hitung ATR-14 dari H1 candles. Output: `atr_h1` (price), `atr_pips` (null untuk XAU)
- `loadOhlcvData()` kini return `out.macd` dan `out.atr`
- `buildOhlcvText()` sertakan MACD dan ATR di blok teks yang dikirim ke AI
- Frontend: indicator card sekarang label "INDIKATOR — RSI / SMA / MACD / ATR" dengan tiga seksi terpisah (RSI/SMA dari ATR cache, MACD H4 dari candles, ATR 14H dari candles)

**2. Structured AI Output**
- Prompt AI diubah dari "4-5 kalimat bebas" → JSON dengan field: `bias`, `entry_zone`, `sl`, `tp`, `trigger`, `commentary`
- Backend parse JSON dari response, normalize bias ke bullish/bearish/neutral; fallback ke plain text jika parse gagal
- `ohlcvAnalyzeHandler` return `{ commentary, structured, model, loaded_at }`
- Frontend: `_renderStructuredAi()` — render bias chip berwarna (green/red/orange), trigger inline, baris ENTRY/SL/TP dalam monospace, commentary di bawah
- Cache format diperluas: `{ commentary, structured, model, hasMakro, saved_at }` — backward compat: old cache tanpa `structured` render sebagai plain text

**3. Auto-refresh 15 menit**
- `startAnalisaAutoRefresh()` / `stopAnalisaAutoRefresh()` menggunakan `setInterval` 15 menit
- `loadAnalisa()` selalu restart timer (reset countdown saat user manual refresh)
- Tab switch listener: stop timer saat meninggalkan tab ANALISA
- Header timestamp menampilkan label "auto 15m" di samping tombol ↻ refresh

---

## Changelog Session 56 (2026-06-12)

### OHLCV Upgrade — Multi-Timeframe: Daily 30D + 4H 10D + Volume GC=F

**Konteks:** Sebelumnya OHLCV hanya 1H 5D. Untuk analisa AI yang lebih dalam, perlu: Daily untuk struktur makro (trend 1 bulan), 4H untuk swing context, dan volume real dari GC=F (CME futures) sebagai konfirmasi conviction.

**Perubahan `api/admin.js`:**
- `fetchYahooOhlcv1h`: range `5d` → `10d` (diperlukan untuk resample 4H), tambah parsing volume (`v: Math.round(vol || 0)`)
- Fungsi baru `fetchYahooOhlcvDaily(symbol)`: fetch `interval=1d&range=1mo` dari Yahoo — semua pair, include volume
- Fungsi baru `resampleTo4h(candles1h)`: resample candles 1H → 4H dengan bucketing per 4×3600s; aggregate OHLC + sum volume
- `ohlcvSyncHandler` update: per pair, sekarang fetch 1H + daily lalu store 3 Redis keys:
  - `ohlcv:{symbol}:1h` — last 72 candles (3 trading days), TTL 8h
  - `ohlcv:{symbol}:4h` — last 60 candles (10 days), TTL 8h
  - `ohlcv:{symbol}:1d` — last 30 candles (1 month), TTL 25h
- Volume ada di semua TF candle object (field `v`), tapi hanya ditampilkan ke AI untuk GC=F

**Perubahan `api/market-digest.js`:**
- `fetchOhlcvContext(symbol, label)` full rewrite — sekarang baca 3 TF dari Redis paralel:
  - **[MAKRO — Daily 30D]**: range, trend, % 30D, top-2 resistance + bottom-2 support, volume avg/today + label HIGH/Normal/low (XAU only)
  - **[SWING — 4H 10D]**: range, trend, % 10D, swing high + swing low dengan tanggal WIB
  - **[ENTRY — 1H 3D]**: range, now, % 3D, trend; 24H candles per-jam dengan volume + label untuk XAU
  - Output format: `=== {label} MULTI-TIMEFRAME ===` diikuti 3 blok terstruktur
- Prompt header Call 1: diupdate ke `PRICE ACTION XAU/USD (Daily/4H/1H — ...)`
- Call 3 thesis injection: diubah dari `.split('\n')[0]` → `.split('\n').slice(1, 8).join('\n')` — memberikan summary Daily+4H+1H (bukan hanya header baris pertama)

**Volume philosophy:**
- FX OTC (EURUSD=X, dll): volume Yahoo adalah proxy dealer, tidak punya makna. Tetap disimpan di Redis tapi tidak ditampilkan ke AI
- GC=F (CME futures): volume real. Dipakai untuk label candle `V:8.2K [HIGH]` / `V:5.1K [low]`, plus daily vol context

**Redis keys baru per pair:**
- `ohlcv:{symbol}:4h` — 4H candles TTL 8h
- `ohlcv:{symbol}:1d` — Daily candles TTL 25h
- Total keys: 9 pairs × 3 TF = 27 Redis keys (sebelumnya 9 keys 1H saja)

---

## Changelog Session 55 (2026-06-12)

### Self-Healing OHLCV System — AI Price Context untuk Entry

**Masalah:** AI briefing hanya mengetahui harga spot saat ini + RSI/SMA, tidak bisa menyebut level konkret ("resistance 3380 yang diuji 2x", "ranging sejak Jun-10"). Tidak ada koneksi teknikal-fundamental untuk entry analysis.

**Solusi:** Sistem OHLCV 1H yang berjalan otomatis setiap jam, menyimpan data ke Redis, dan AI membacanya saat generate briefing.

**Perubahan `api/admin.js`:**
- Tambah `ohlcvSyncHandler` — action baru `?action=ohlcv_sync`
- `OHLCV_FIXED_PAIRS`: 8 pair fixed (XAU, 7 FX majors) selalu di-track
- `OHLCV_PAIR_SYMBOL_MAP`: mapping pair label → Yahoo symbol (14 pair + cross)
- `fetchYahooOhlcv1h(symbol)`: fetch `interval=1h&range=5d` dari Yahoo Finance
- Storage: Redis key `ohlcv:{symbol}:1h`, JSON array max 120 candles, TTL 8 jam
- Dynamic pair: baca `latest_thesis.pair_recommendation` → tambah ke sync list jika cross pair (misal EUR/JPY)
- Self-healing: TTL 8h = kalau cron stop, data expire otomatis. Kalau Yahoo gagal 1 pair, pair lain tetap sync.
- Tidak butuh file baru (sudah 12 functions di Vercel Hobby limit)

**Perubahan `vercel.json`:**
- Tambah cron `0 * * * *` untuk `/api/admin?action=ohlcv_sync` — jalan tiap jam

**Perubahan `api/market-digest.js`:**
- Tambah konstanta `OHLCV_SYMBOL_MAP` — 14 pair label → Yahoo symbol
- Tambah fungsi `fetchOhlcvContext(symbol, label)`:
  - Baca Redis `ohlcv:{symbol}:1h`
  - Compute: range 3D, trend direction (uptrend/downtrend/sideways), current price, 3D % change
  - Output compact: 1 baris summary + 24H candles mentah (H/L/C per jam, WIB)
  - Decimal precision otomatis per instrument (XAU=2, JPY=3, FX=5)
- Tambah `rawPrevThesis` ke parallel fetch block → determine FX pair berdasarkan previous thesis
- Load OHLCV untuk XAU + FX pair setelah parallel fetch (2 Redis reads paralel)
- Inject ke **Call 1** user message: blok `PRICE ACTION XAU/USD 1H` + `PRICE ACTION {pair} 1H`
- Inject ke **Call 3** thesis prompt: 1-line summary range + trend untuk precision entry/invalidation
- **Fix bug:** `GROQ_MODEL_PROSE = 'qwen/qwen3-32b'` (sebelumnya `'qwen3-32b'` tanpa prefix → model not found)
- **Call 4 SambaNova-first:** `_call4Promise` sekarang coba SambaNova DeepSeek-V3.2 (akun 1) dulu, fallback ke Groq. Condition diubah dari `(GROQ_KEY && deviceId)` → `((SAMBANOVA_KEY || GROQ_KEY) && deviceId)`

**Redis keys baru:**
- `ohlcv:GC=F:1h` — XAU/USD 1H candles, max 120 entries, TTL 8h
- `ohlcv:EURUSD=X:1h`, `ohlcv:GBPUSD=X:1h`, etc. — semua 8 fixed pair + dynamic cross pair

**AI provider strategy (updated):**
- Call 1 (prose briefing): SambaNova primary → OpenRouter → Groq qwen/qwen3-32b → Groq llama
- Call 2 (CB bias): SambaNova primary → Groq
- Call 3 (structured thesis): SambaNova primary → Groq
- Call 4 (thesis monitor): **SambaNova primary** (baru) → Groq ← semua call sekarang preferensi SambaNova DeepSeek-V3.2

---

## Changelog Session 54 (2026-06-11)

### Feat: Fundamental Drill-Down Overlay (tap currency → detail view)

**Masalah:** Panel fundamental menampilkan 8 mata uang sekaligus dengan font 8-9px, sulit dibaca. Tidak ada cara untuk fokus ke satu mata uang.

**Solusi:** Full-screen overlay yang muncul saat user tap currency card atau ranking cell.

**Perubahan `index.html`:**
- CSS baru: `.fd-overlay`, `.fd-hdr`, `.fd-hdr-close`, `.fd-hdr-nav`, `.fd-hdr-center`, `.fd-cur-tabs`, `.fd-cur-tab`, `.fd-score-strip`, `.fd-body`, `.fd-section-hdr`, `.fd-row`, `.fd-row-name`, `.fd-row-right`, `.fd-row-val`, `.fd-row-prev`, `.fd-row-period`, `.fd-extra-block`, `.fd-extra-title`, `.fd-extra-row`
- HTML: `#fdOverlay` — full-screen overlay dengan header (← back, nama mata uang besar, ‹ › nav), score strip, currency tabs, scrollable body
- JS: `openFundDetail(cur)`, `closeFundDetail()`, `navFundDetail(dir)`, `_renderFundDetail()` — render detail untuk satu currency
- `FUND_SECTIONS_MAP` + `FUND_SECTION_ORDER` — grouping indikator ke seksi: Inflasi, Pertumbuhan, Ketenagakerjaan, Aktivitas, Sentimen, Permintaan, Eksternal, Lainnya
- `fdScores` global — scores array dari `renderFundamental()` disimpan untuk overlay
- Tap fund-card → `openFundDetail(cur)` (cursor:pointer, ↗ hint di pojok kanan header)
- Tap frnk-cell (ranking strip) → `openFundDetail(cur)`
- Escape key menutup overlay (prioritas pertama sebelum kbOverlay)
- Detail view: CB rate di top (font 26px), tiap indikator font 18px (vs 9px sebelumnya), prev value ditampilkan, color-coded bull/bear, yield curve + likuiditas dalam card terpisah

---

### Fix: Regime selalu NEUTRAL — tambah tier ELEVATED + Yahoo MOVE live

**Root cause dua masalah:**
1. **MOVE data null** — Stooq (satu-satunya source) diblokir anti-scraping, circuit breaker terbuka → `move = null` → "0/2 trigger" (hanya VIX + HY dihitung). Banner tidak pernah bisa Risk-Off dari MOVE.
2. **VIX 20.6 di zona neutral** — threshold lama: risk_off > 25, risk_on < 15. VIX 15-25 selalu NEUTRAL meski sudah elevated secara historis.

**Perubahan `api/risk-regime.js`:**
- Tambah `fetchYahooMove()` — Yahoo Finance `^MOVE` (live, 15m delay), lebih reliable dari Stooq scraping
- Rename Stooq fetcher ke `fetchStooqMove()`, tetap sebagai fallback
- `fetchMove(stooqAllowed)` — selalu coba Yahoo dulu; Stooq hanya jika Yahoo gagal DAN circuit tidak OPEN
- Stooq circuit breaker hanya dicredit/didebited berdasarkan actual Stooq calls (bukan Yahoo sukses)
- Tambah regime tier **ELEVATED**: VIX > 20, MOVE > 100, atau VIX spike +3 dalam 2 hari
- Hierarchy regime: `risk_off` > `elevated` > `risk_on` (all benign) > `neutral`
- Tambah `move_source` ke payload response (`'yahoo'` atau `'stooq'`)
- Tambah `vix_elevated`, `move_elevated`, `vix_spike` ke `components`

**Perubahan `index.html`:**
- CSS: `.regime-banner.elevated { background: #251e08; color: #f59e0b; }` (amber/kuning)
- LABELS: tambah `elevated: 'ELEVATED'`; CLASSES: `elevated: 'elevated'`
- IMPLICATIONS: `elevated: 'Volatilitas naik · Selektif & kurangi size · Pantau VIX & MOVE ketat'`
- Detail panel VIX row: tampilkan threshold per level (> 20 ELEVATED, > 25 RISK-OFF, < 15 Risk-On, 15-20 netral)
- Detail panel MOVE row: tampilkan threshold per level (> 100, > 130, < 90)
- MOVE null case: tampilkan `"data tidak tersedia"` (sebelumnya baris hilang tanpa keterangan)
- VIX spike row: tampilkan jika `vix_spike = true`
- Data label: `"VIX & MOVE live · HY Data X"` jika MOVE dari Yahoo; `"VIX live · MOVE/HY Data X"` jika Stooq
- Journal regime filter dropdown: tambah option `elevated`
- Fix bug `_ckAutoMeanRev()`: perbandingan `=== 'Neutral'` (kapital) → `=== 'neutral'` — auto-tick tidak pernah jalan sebelumnya
- `_ckAutoMeanRev()` sekarang juga trigger untuk `'elevated'` (regime ranging/choppy)
- `ckAutoTick('rc1')`: pakai label readable (RISK-ON/ELEVATED/NEUTRAL/RISK-OFF) bukan raw value

---

## Changelog Session 53 (2026-06-10)

### Fix: AI Summarization — Vercel Timeout, Provider Diagnostics, CSS Badges

**Masalah root cause:** Vercel Hobby plan default function timeout adalah 10-15s, sedangkan SambaNova Call 1 sendiri membutuhkan timeout 28s (normal response time 13-20s). Ketika SambaNova timeout + OpenRouter timeout (15s), total waktu bisa melampaui limit Vercel → 504 sebelum Groq sempat menjadi fallback.

**Perubahan `vercel.json`:**
- Tambah blok `"functions"` dengan `maxDuration` explicit per endpoint:
  - `market-digest.js`: 60s
  - `journal.js`: 45s
  - `admin.js`: 60s
  - `correlations.js`: 30s
  - `real-yields.js`: 30s
  - `risk-regime.js`: 20s
  - `feeds.js`: 20s

**Perubahan `api/market-digest.js`:**
- Tambah `providerLog` array yang melacak setiap provider attempt: nama, status (ok/error/empty), elapsed time, char count
- Sertakan `provider_log` di response payload — tampil di frontend saat method=fallback
- Setiap fallback provider sekarang log: `sambanova:ok(1200ms,3400c)` atau `sambanova:HTTP429(100ms)` atau `sambanova:no_key`

**Perubahan `index.html`:**
- Frontend timeout: 45s → 55s (sesuai maxDuration 60s Vercel)
- CSS tambahan untuk method badges yang sebelumnya tidak styled: `deepseek-v3.2` (biru), `deepseek-v3.1` (biru), `gpt-oss-120b` (hijau), `qwen3-32b` (kuning, sama dengan groq)
- Tambah `fallback_quota` ke CSS fallback
- Tampilkan provider log (monospace, muted) di bawah meta bar ketika method=fallback, sehingga user bisa melihat provider mana yang gagal

**Env var:**
- Dokumentasikan `SAMBANOVA_API_KEY_CALL1` (akun 2, opsional) di daun_merah.md

---

## Changelog Session 51 (2026-06-05)

### Dashboard News Panel — Thematic Clustering

**Masalah:** Panel berita kiri di Dashboard menampilkan list kronologis mentah (20 headline berurutan) yang memaksa otak membaca setiap item satu per satu, termasuk berita tidak relevan dengan thesis aktif trader.

**Solusi:** Ubah paradigma dari *timeline* ke *status board* berbasis kategori.

**Perubahan `index.html`:**
- `renderDashNews()` diubah total: item dikelompokkan per kategori menggunakan `detectCat()` yang sudah ada
- 11 kategori ditampilkan dalam urutan prioritas: MKT MOVING → FOREX → MACRO → ECON DATA → BONDS → ENERGY → COMMODITIES → EQUITIES → GEOPOLIT. → INDEXES → CRYPTO
- Setiap kluster menampilkan: colored dot + label + count badge + timestamp item terbaru + chevron
- Klik header kluster untuk expand/collapse (state persists antar auto-refresh via `dashClusterState`)
- MKT MOVING auto-expand jika ada isi; semua kategori lain collapsed by default
- Kategori kosong tidak ditampilkan sama sekali
- Individual item tetap pakai format `.dash-news-item` yang sama, dot warna disesuaikan per kategori
- CSS baru: `.dash-cluster`, `.dash-cluster-header`, `.dash-cluster-dot`, `.dash-cluster-label`, `.dash-cluster-count`, `.dash-cluster-age`, `.dash-cluster-chevron`
- `toggleDashCluster(cat)` fungsi baru untuk handle expand/collapse
- `dashClusterState` state variable baru

---

## Changelog Session 50 (2026-06-25)

### Nav Polish — Analisa Border-Bottom + Mobile Bottom Nav Swap

**1. Tab ANALISA tidak ada border-bottom saat active — `index.html`**
- Root cause: semua `.nvtab[data-view="X"].active` punya rule `border-bottom-color`, kecuali `analisa` — jadi border tetap transparent walau tab aktif
- Fix: tambah `.nvtab[data-view="analisa"]` (warna `#fb923c`) + `.nvtab[data-view="analisa"].active { border-bottom-color: #fb923c; }`

**2. Mobile bottom nav: Checklist diganti Analisa**
- `#botNav`: button `data-view="checklist"` (icon checklist) diganti `data-view="analisa"` (icon chart) — label "Analisa"
- Checklist dipindah ke drawer "Lainnya": ditambahkan ke `DRAWER_ITEMS` + CSS hide `#botNav .bot-nav-btn[data-view="checklist"]`
- `analisa` dihapus dari `DRAWER_ITEMS` karena sekarang akses langsung dari bottom nav (gak perlu duplikat)
- Desktop top nav (`#navViews`) tidak berubah — checklist tetap tampil langsung di sana, hanya mobile bottom nav yang disesuaikan

**3. Tab MTF bias (D1/H4/H1/M15 dropdown) di tab TEKNIKAL bikin window melebar ke kanan di mobile**
- Root cause: `.tek-mtf-bar` (4 dropdown bias + tombol Auto + badge kesimpulan BULLISH/BEARISH/MIXED) pakai `display:flex` tanpa wrap — total lebar konten lebih besar dari viewport mobile, jadi overflow horizontal alih-alih wrap ke baris baru
- Fix: tambah `flex-wrap: wrap` pada `.tek-mtf-bar` (+ gap jadi `8px 10px` untuk jarak antar baris)

**4. Swipe gesture horizontal nyasar ke tab "Lainnya" — `index.html` (SWIPE NAVIGATION)**
- Root cause: array `VIEWS` di swipe handler masih include semua tab drawer-only (riset/cal/cot/fundamental/checklist/sizing/jurnal/petunjuk) di antara tab primer — jadi swipe dari ANALISA ke kanan nyasar ke `cal` (Kalender) bukan ke TEKNIKAL
- Fix: `VIEWS` dipersempit jadi cuma tab primer: `['dashboard','feed','ringkasan','analisa','teknikal']` — urutan sama dengan bottom nav mobile
- Tambahan: swipe ke kiri setelah tab terakhir (TEKNIKAL) sekarang langsung `openDrawer()` — konsisten dengan posisi "Lainnya" di paling kanan bottom nav

**5. FUNDAMENTAL detail overlay — swipe untuk ganti mata uang**
- Sebelumnya pindah currency di overlay detail (`fdOverlay`) cuma bisa lewat tombol ‹ › atau tap chip currency di `fdCurTabs`
- Tambah swipe horizontal di `#fdBody`: swipe kiri/kanan panggil `navFundDetail(1/-1)`, dengan deteksi dominan horizontal (sama pola dengan global swipe nav) supaya gak ganggu scroll vertikal daftar indikator
- `navFundDetail()` sekalian ditambah animasi slide-in (`swipe-in-right`/`swipe-in-left`, reuse keyframes yang sudah ada) biar transisi kerasa
- Tidak konflik dengan global swipe nav antar-tab karena `activeView` tetap `'fundamental'` saat overlay terbuka — dan `'fundamental'` sudah gak ada di array `VIEWS` swipe nav (poin 4), jadi handler global auto-skip

**6. Swipe saat drawer "Lainnya" terbuka tembus ganti tab di belakangnya**
- Root cause: global swipe nav handler gak cek status drawer — swipe di atas drawer yang sedang terbuka tetap dianggap swipe ganti tab, jadi konten di belakang drawer berubah sementara drawer-nya sendiri masih nampil di atas (state nyasar)
- Fix: tambah guard di awal `touchend` handler — kalau `#drawerPanel.open`, swipe arah manapun cuma `closeDrawer()`, gak lanjut ke logic ganti tab

**7. Fitur baru: US10Y yield strip di tab TEKNIKAL**
- Data udah ada di `api/real-yields.js` (`realYieldsData.USD.{nominal,real}`), tinggal ditarik ke UI — gak ada API call baru
- Pakai USD aja (bukan differential per-pair) karena itu satu-satunya yield yang konsisten ada di semua 8 pair TEK (XAUUSD + 7 FX major)
- Strip baru `#tekYieldStrip` di bawah `.tek-mtf-bar`: nampilin US10Y nominal + real yield (TIPS-implied)
- Khusus XAUUSD: real yield dikasih warna (merah kalau positif = tekanan ke Gold, hijau kalau negatif = suportif) + hint teks — karena ini driver fundamental klasik gold (inverse correlation ke real yield)
- Pair FX lain cuma nampilin angka netral (US10Y jadi konteks makro umum, gak ada hint directional spesifik karena bukan currency differential)
- Render dipanggil di 3 titik: `initTeknikal()` (pakai cache kalau masih fresh ≤6 jam, else `fetchRealYields()`), `selectTekPair()` (ganti pair), dan di akhir `fetchRealYields()` (data baru datang)

**8. Bug: kalender — event yang ketinggalan dicek dalam 3 jam jadi blank actual permanen**
- Root cause: `enrichCalActuals()` punya gate `(nowMs - evMs) > AFTER_MS) return` yang ngecek "udah berapa lama dari SEKARANG", bukan dari waktu rilis event — begitu lewat 3 jam wall-clock, event itu di-skip dari backfill SELAMANYA, walau actual-nya udah ada di feed FinancialJuice (dikonfirmasi langsung: AUD Employment Change & Unemployment Rate hari ini, headline actual muncul <1 menit setelah rilis, tapi event masih blank 4 jam kemudian karena user belum buka tab CAL dalam window itu)
- Window kecocokan per-headline (`BEFORE_MS`/`AFTER_MS` relatif ke `evMs`) udah benar dan tetap dipertahankan — yang dihapus cuma gate redundan yang gak ada hubungannya sama validitas match
- Fix: gate dipersempit jadi cuma skip event yang **belum rilis** (`evMs > nowMs`) — `allItems` cap 100 item biasanya nutup >5 jam riwayat headline, jadi backfill telat tetap kena tangkep di kunjungan berikutnya

**9. Fitur baru: COT week-over-week alignment flag (vs arah trade)**
- Helper baru `cotAlignmentNote(base, quote, dir)` — bandingin `lev_change_net` (perubahan posisi leveraged funds minggu-ke-minggu, data udah ada di `api/feeds.js`) base vs quote, threshold 5000 kontrak biar shift kecil/noise gak di-flag
- Live preview: `jnSnapshotInfo()` (form entry manual JURNAL) sekarang nampilin baris "✅ Selaras smart money" / "⚠ Kontra smart money" sebelum trade disimpan — `onchange="jnSnapshotInfo()"` ditambah ke `#jnPair` dan `#jnDir` biar update live
- Disimpan permanen: field `cot_alignment` (boolean) ditambah ke `cot_snapshot` (sekarang nyimpen `lev_change_net` juga, sebelumnya cuma `lev_net` statis) — dipanggil dari `jnSave()` (manual) dan `ckMt5AutoJournal()` (MT5 bridge auto-journal)
- `api/journal.js`: field `cot_alignment` ditambah ke whitelist POST entry; per-trade summary di endpoint `?action=analyze` sekarang nyebutin "selaras smart money" / "KONTRA smart money" + delta COT, dan instruksi prompt AI poin 2 (Keselarasan Framework) diperluas buat ikut nilai positioning institusional, bukan cuma CB bias + regime
- Badge "✅ selaras COT" / "⚠ kontra COT" ditambah di kartu list JURNAL biar kelihatan retroaktif juga
- Catatan desain: TIDAK ditambah breakdown win-rate numerik per kategori (bias/regime/COT) — sample trade trader pribadi biasanya kekecilan buat statistik valid, AI analysis yang udah ada (poin 2 prompt) lebih aman buat sample kecil drpd widget angka yang bisa overfit/noise

**10. Fitur baru: US10Y & US2Y sebagai chart candle sendiri di tab TEKNIKAL**
- Awalnya US10Y cuma badge angka (poin 7), tapi user mau technical reading langsung di yield-nya (trendline/SR) — bukan cuma satu angka
- `TEK_YIELD_INSTRUMENTS = ['US10Y','US02Y']` ditambah ke `TEK_ALL_PAIRS` (jadi muncul di dropdown pair, searchable by "10Y"/"2Y"/"yield"), dengan override manual di `TEK_TV_SYM` (`TVC:US10Y`/`TVC:US02Y` — data asli TradingView) karena auto-derive symbol dari nama pair gak cocok buat instrumen non-currency-pair ini
- `tekPairLabel()` dan 2 tempat lain yang masih hardcode `slice(0,3)+'/'+slice(3)` (renderTekNews, renderTekOptions) dirapihin pakai `tekPairLabel()` biar gak pecah format buat pair 5-karakter ini
- `TEK_YAHOO_SYM.US10Y = '^TNX'` (buat panel TA RSI/SMA) — US02Y gak ada index Yahoo yang bersih, jadi `fetchTaData()` skip otomatis (graceful, gak crash)
- `TEK_PAIR_KEYWORDS.US10Y/US02Y` di-set manual ke keyword USD (Fed/FOMC/yield) biar filter Berita Terkait tetap relevan
- Strip badge US10Y dari poin 7 di-skip otomatis (`renderTekYield()`) kalau lagi di-chart sendiri — gak ada badge duplikat
- **Update:** `TVC:US10Y`/`TVC:US02Y` ternyata kena paywall di widget gratis ("Simbol tersebut hanya tersedia di TradingView"). Diganti ke `FRED:DGS10`/`FRED:DGS2` (data US Treasury via FRED, sumber sama dengan `api/real-yields.js`, gak dikunci). Trade-off: FRED update harian doang, jadi timeframe intraday (H4/H1/M15) gak akan se-granular pair FX biasa — tapi chart-nya jalan tanpa paywall.
- **Update lagi:** Berita Terkait buat US10Y/US02Y awalnya pakai `TEK_CUR_KEYWORDS.USD` penuh (ikut 'dollar','dxy','trump','nfp' — kebanyakan gak relevan buat baca chart yield). Dipersempit jadi `TEK_YIELD_KEYWORDS` khusus: Fed/FOMC/rate decision, treasury auction/yield curve/TIPS/real yield, dan rilis makro yang langsung pengaruh ekspektasi rate (CPI/GDP/NFP/PCE/jobless claims) — driver yang beneran gerakin yield itu sendiri, bukan USD secara umum.

---

## Changelog Session 49 (2026-06-05)

### Unverified Audit + Maintenance Debt + OECD/TGA Fixes

**1. OECD Inflation Dead Code Removed — `api/real-yields.js`**
- Verified: `stats.oecd.org/SDMX-JSON` → 404 (deprecated), `sdmx.oecd.org` → 403 (Cloudflare block dari Vercel IPs)
- `fetchOECDInflation()` selalu silent fail, selalu fallback ke hardcoded
- Dihapus: `fetchOECDInflation()`, `OECD_TO_CURRENCY` constant, `oecdCached` Redis read, Step 1 OECD block
- Simplified: `inflationExp` langsung spread dari `INFLATION_EXPECTATIONS` tanpa OECD merge
- Orphaned Redis key `oecd_inflation` expire natural dalam 24h

**2. TGA via FRED WDTGAL — `api/real-yields.js`**
- Root cause: `fiscaldata.treasury.gov` blocked dari Vercel datacenter IPs (confirmed) → `tga_balance_bn` selalu null
- Fix: Ganti ke FRED series `WDTGAL` (US Treasury General Account, Fed H.4.1 weekly Wednesday levels)
- Tambah helper `fetchFredMulti(seriesId, limit)` untuk fetch N observasi (needed untuk `tga_change_bn`)
- `fetchLiquidityIndicators()`: sekarang `fetchFred('WALCL')` + `fetchFredMulti('WDTGAL', 2)` (keduanya via FRED API, tidak diblokir Vercel)
- Trade-off: WDTGAL weekly (Rabu), less granular dari daily Treasury API, tapi reliable. `tga_change_bn` = perbandingan 2 Rabu berturut-turut.

**3. FUND_SEED Update — `api/admin.js`**
- AUD GDP QoQ: 0.8% Q4 2025 → **0.3% Q1 2026** (ABS published June 3, 2026; QoQ below expected 0.5%)
- JPY GDP QoQ: 0.3% Q4 2025 → **0.5% Q1 2026** (Cabinet Office 1st preliminary May 19, 2026; annualized +2.1%)
- NZD GDP: tetap Q4 2025 (Q1 2026 publish June 18)

**4. GBP Inflation Expectation — Confirmed No Update Needed**
- BoE IAS Q2 2026 belum publish (konfirmasi via research). GBP 3.2% (Feb 2026) masih current.
- Next refresh: BoE IAS Q2 hasil biasanya ~Aug 2026.

**5. AI Liquidity + Yield Curve Prompt — Verified Working**
- Yield curve USD+EUR confirmed masuk ke `realYieldBlock` di prompt market-digest
- TGA sebelumnya null karena Vercel IP blocked → sudah fixed via WDTGAL
- Cold-start caveat: `liquidity_usd` dan `yield_curve` TTL 1h. Jika user buka tab FUNDAMENTAL sebelum generate digest, data selalu tersedia.

**6. crawl4ai Assessment**
- Python-based library, Docker mode punya REST API (callable dari Node.js)
- Berguna untuk bypass Cloudflare/anti-bot (ING Think, option expiry pages)
- **Tidak applicable untuk Vercel serverless** — butuh server terpisah
- Cloud API "coming soon" tapi belum tersedia
- Relevant di masa depan jika ada VPS scraping proxy

---

## Changelog Session 48 (2026-06-05)

### VIX Fix + TGA API Fix + Rename + RSS Research

**1. VIX Term Structure — `api/risk-regime.js`**
- Root cause: `^VIX1M` tidak tersedia di Yahoo Finance → selalu null → `structure` field tidak pernah dihitung.
- Fix: tambah fallback `else if (vix3m != null)` — hitung `structure` dari `vix_spot` vs `vix_3m` jika `vix_1m` null.
- Dikonfirmasi live: `{ vix_spot: 15.4, vix_1m: null, vix_3m: 19.23, structure: "contango" }`.

**2. TGA Balance — `api/real-yields.js`**
- Root cause: Treasury FiscalData API pindah endpoint. URL lama `/v1/accounting/dts/dts_table_1` return 404 dari semua sumber.
- URL baru ditemukan via JS bundle `fiscaldata.treasury.gov`: `/services/api/fiscal_service/v1/accounting/dts/operating_cash_balance`
- Filter baru: `account_type:eq:Treasury General Account (TGA) Closing Balance`
- Field: `open_today_bal` — bukan `close_today_bal` yang selalu string `"null"` (Treasury naming quirk).
- Data confirmed lokal: Jun 3 = $845B, Jun 2 = $866B, change -$21B (drain).

**3. Rename CB WATCH → ARTIKEL — `index.html`**
- Top nav button, DRAWER_ITEMS label + desc, keyboard shortcut help (`G B`) — 3 titik diganti.
- Alasan: tab ini akan menampung artikel macro lebih luas (bukan hanya CB speeches), termasuk rencana tambah Marc to Market + ING Think.
- `data-view="riset"` dan semua JS logic tidak berubah — hanya label UI.

**4. Option Magnets — dipertahankan**
- Sebelumnya dikira dead code karena FinancialJuice tidak publish format expiry.
- Keputusan: **kode tetap ada** — regex parser + panel + CSS + filter button semua dipertahankan.
- Alasan: investing.com (kandidat backup source) publish headline option expiry yang bisa match regex secara otomatis.

**5. Audit `daun_merah_progress.md`**
- Item 12 (FX Risk Reversals) + Item 13 (Portfolio VaR): dikira ⚫ belum ada → ✅ sudah ada sejak session 46–47.
- Item 5 (TGA), Item 6 (VIX): diupdate → FIXED.
- Item 8 (Option Magnets): diupdate → dipertahankan (source lain mungkin punya data ini).
- Test live semua item 4–8 via WebFetch + curl ke production.

**6. Research RSS Backup Sources (Item 14)**
- **Investing.com**: `investing.com/rss/news_1.rss` — gratis, real-time, tapi noise tinggi (1 event = 3–5 artikel).
- **Reuters**: berbayar, skip.
- **Marc to Market** (`feeds.feedburner.com/MarcToMarket`): gratis, bersih, 6x/minggu — cocok masuk tab ARTIKEL bukan breaking news.
- **ING Think**: tidak ada RSS resmi, perlu scrape.
- **Econostream**: berbayar wire service, skip.
- Kesimpulan: tidak ada sumber gratis yang ideal sebagai real-time fallback. Marc to Market + ING Think lebih cocok sebagai sumber riset di tab ARTIKEL.

---

## Changelog Session 48b (2026-06-29)

### Eksekusi item deferred — Bagian 9 (anti-versi-basi PWA + Share deep-link) & COR-D (real yield proxy)

Lanjutan Session 48 — dua item yang sebelumnya deferred/butuh keputusan user sekarang dikerjakan atas permintaan eksplisit.

**1. Anti-versi-basi PWA — `index.html` + `sw.js` + `vercel.json`**
- **Root cause ditemukan saat implementasi:** `sw.js` memanggil `self.skipWaiting()` (saat install) + `clients.claim()` (saat activate) tanpa menunggu — artinya SW baru langsung mengambil kendali tab yang sudah terbuka, TAPI halaman tetap menjalankan JS versi lama yang sudah di-load di memory sampai user reload manual. Ini kemungkinan besar mekanisme persis di balik insiden "teman user nyangkut di versi lama, hapus cache pun tidak menolong" (Bagian 9 lama).
- Fix: tambah listener `controllerchange` di `index.html` yang auto-reload halaman sekali begitu SW baru mengambil kendali (pola standar PWA, dengan guard `swRefreshing` agar tidak reload-loop).
- Stempel versi: `const APP_VERSION = '2026.06.29'` ditambah, ditampilkan di footer panel PETUNJUK (`#ptAppVersion`) sebagai referensi diagnostik kalau user lapor "kok beda dari biasanya".
- `vercel.json`: tambah header `Cache-Control: no-cache, must-revalidate` untuk `/`, `/index.html`, `/sw.js` — defense-in-depth supaya browser/CDN tidak menahan versi lama di edge cache.
- `sw.js` `activate`: tambah `caches.keys()` cleanup — hapus semua cache storage selain `CACHE_NAME`/`STATE_CACHE` aktif (note: `CACHE_NAME` sendiri saat ini dead, tidak dipakai cache apa pun, tapi cleanup tetap berguna untuk proteksi ke depan kalau nama berubah).

**2. Tombol Share dengan deep-link — `index.html`**
- Tombol baru `⤴` di header (sebelah tombol popout), `shareCurrentView()`: pakai `navigator.share()` di mobile (Web Share API, sertakan judul tab + URL `#<view>`), fallback copy-to-clipboard + toast di desktop/browser tanpa Web Share API.
- AC plan terpenuhi: share dari tab Kalender sekarang membawa penerima ke Kalender (bukan default News/Dashboard), karena hash `#cal` sudah didukung `restoreViewFromHash`.

**3. COR-D — Real yield (TIP ETF proxy) ke matriks korelasi — `api/correlations.js`**
- `INSTRUMENTS.RealYield = 'TIP'` (iShares TIPS Bond ETF). Rasionalnya: harga TIP bergerak searah dengan suku bunga riil yang di-price ke TIPS (harga bond naik = yield riil turun) — sehingga TIP berkorelasi positif dengan driver sebenarnya emas, beda dari `US10Y` (`^TNX`, nominal) yang bisa divergen dari real yield saat ekspektasi inflasi berubah cepat.
- Ditambahkan ke `GOLD_CORR_ASSETS` supaya selalu tampil di blok `gold_correlations` (bukan cuma kalau masuk top-10 anomali) — sejajar dengan `US10Y`, bukan menggantikannya, supaya kedua sinyal (nominal vs riil) bisa dibandingkan.

**Catatan testability:** semua perubahan lolos `node -c`/parse-check. Fix `controllerchange` butuh deploy + 2 kali kunjungan (versi lama lalu versi baru) untuk verifikasi nyata — tidak bisa diuji penuh di sandbox. Tombol Share bisa diuji langsung di browser begitu deploy (mobile: share sheet; desktop: clipboard + toast).

---

## Changelog Session 48 (2026-06-29)

### Eksekusi `daun_merah_plan.md` — Audit Prompt & Korelasi

Hasil audit (sebelumnya sudah disimpan di `daun_merah_plan.md`, status "analisis selesai belum dieksekusi") dikerjakan tuntas sesi ini, kecuali item yang plan-nya sendiri menandai sebagai keputusan/review user atau deferred.

**1. Bug News fetch ganda — `index.html`**
- Root cause: `startAutoRefresh()` mengirim `CHECK_NOW` ke service worker dengan `seenGuids` kosong saat load → SW selalu false-positive "semua item baru" → trigger `fetchFeed()` kedua lewat `NEW_ITEMS`, bertumpuk dengan fetch jalur load/visibilitychange.
- Fix: hapus `sendToSW({type:'CHECK_NOW'})` dari `startAutoRefresh()` (SW kini background-only, baseline disinkronkan via `INIT_GUIDS` setelah tiap `fetchFeed()` sukses — mekanisme ini sudah ada). Tambah debounce `lastFetchAt` (skip kalau `fetchFeed()` dipanggil <3s setelah fetch sebelumnya) sebagai jaring tambahan untuk pemicu berurutan dari sumber berbeda.
- AC plan terpenuhi: 1 load = 1 fetch RSS dari halaman.

**2. BUG-1 — Korelasi Gold cuma kirim r20 ke prompt — `api/market-digest.js`**
- Render `correlationBlock` sekarang kirim `r20 + r60 + delta` per aset di `gold_correlations`, bukan cuma `r20`. Instruksi XAU #6 ("biasanya kuat → sekarang melemah") sekarang punya data untuk dieksekusi tanpa harus masuk top-5 anomali.

**3. BUG-2 — RSI/SMA Daily di fitur Analisa mati total — `api/admin.js`**
- Root cause: `loadOhlcvData` baca indikator dari key salah (`atr:${symbol}` — cuma berisi ATR/sigma, tidak ada RSI/SMA). RSI/SMA sebenarnya di `ta:${symbol}:1d`.
- Fix: ganti key baca jadi `ta:${symbol}:1d` (field name sudah cocok, drop-in). Plus: cron `ohlcv_sync` (`ohlcvSyncHandler`) sekarang juga warm `ta:` cache untuk semua pair yang disync (fire-and-forget call ke `/api/correlations?action=ta`) supaya RSI/SMA selalu tersedia, tidak menunggu tab TEK dibuka manual per-symbol.

**4. COR-B/C/E/F — Grounding korelasi (FX matrix, 8 majors, anomali relevance-aware) — `api/correlations.js` + `api/market-digest.js`**
- `INSTRUMENTS` di `correlations.js` ditambah `CAD` (USDCAD=X, inverted), `NZD` (NZDUSD=X), `CHF` (USDCHF=X, inverted) — lengkap 8 majors di matriks korelasi.
- Blok KORELASI di prompt Ringkasan sekarang juga surface pasangan FX spesifik (DXY-EUR, DXY-GBP, DXY-AUD, DXY-JPY, AUD-SPX, JPY-US10Y) dari `matrix_20d`/`matrix_60d` yang sebelumnya dihitung tapi dibuang.
- Anomali korelasi diprioritaskan kalau menyangkut Gold/DXY (relevance-aware, kurangi noise pasangan tak relevan macam Copper-Silver), plus hint arah ("melemah/menguat" vs "berbalik arah/sign-flip").

**5. RISK-2 — Dead config `prompt_bias`/`prompt_thesis` — `api/admin.js`**
- Konfirmasi: kedua key tidak pernah dibaca Call 2/3 (hardcoded) dan tidak ada di Redis. Dibuang dari `ALLOWED_PROMPT_KEYS` dan dari tabel referensi Redis keys — tidak ada lagi config yang bisa diedit admin tapi tidak berefek.

**6. Kualitas fitur Analisa (QUAL-4/5/6/7/15/16) — `api/admin.js` + `index.html`**
- Prompt `ohlcv_analyze`: tambah field `invalidation_condition` + `time_horizon_days`, syarat risk/reward ≥1 (divalidasi di kode, level di-drop kalau RR<1), opsi bias `mixed` (selain bullish/bearish/neutral) untuk timeframe/makro yang genuinely konflik, larangan eksplisit "jangan mengarang level di luar DATA TEKNIKAL", guard konfluensi makro-vs-teknikal, dan bar anti-generik dinaikkan setara Ringkasan.
- UI kartu Analisa: render RR, invalidation, time horizon, dan badge bias "MIXED".
- `ringkasanContext` yang dikirim ke Analisa kini di-strip dari marker `{{TAG:...}}` sebelum jadi konteks makro.

**7. Prompt-quality Ringkasan (QUAL-1/9/10/13, draft — lihat catatan review di bawah) — `api/market-digest.js`**
- `max_tokens` Call 1 disamakan ke 1300 di tiga provider (sebelumnya timpang 800/800/1800) + target panjang lunak (FX 4-7 kalimat, XAU 4-6 kalimat) ditambahkan ke system prompt.
- Token `/no_think` (sisa era Qwen3, tidak dikenali provider saat ini) dihapus dari `digestUserMsg`.
- Guard anti-halusinasi (jangan gabung 2 headline jadi klaim baru) yang sebelumnya cuma ada di ATURAN XAUUSD, diduplikasi ke ATURAN FX.
- Aturan baru: kalau headline jelas lebih segar dari timestamp blok data cache (real yield/risk regime/rate path) dan bertentangan, sebut konflik eksplisit dan beri bobot ke yang lebih segar.
- **⚠ Belum dieksekusi (di luar scope wajib-review, lihat di bawah):** QUAL-2 (FRASA TERLARANG, sengaja tidak diubah — trade-off, bukan bug), QUAL-3 (selaraskan penutup Call 1 vs Call 3, opsional), QUAL-11 (rampingkan duplikasi aturan penutup FX), QUAL-12 (pra-rank headline by relevansi), QUAL-14/17 (refactor commentary-keluar-dari-JSON, pecah template literal — maintainability, bukan korektivitas).

**Item yang sengaja TIDAK dikerjakan (sesuai instruksi eksplisit di `daun_merah_plan.md`):**
- **Bagian 9** (insiden versi-lama PWA, P0-INFRA anti-versi-basi, share deep-link) — ditandai DEFERRED atas permintaan user di plan.
- **COR-D** (real yield proxy TIP ETF) — plan menandai ini keputusan user, bukan tugas coding.
- **Item P3 opsional** (COR-G BTC/gold-silver/gold-copper ratio) — tidak diminta, di luar prioritas.

**Catatan testability (sesuai plan bagian B):** semua perubahan korelasi & prompt **code-complete, lint/syntax-check lolos (`node -c`), tapi belum diverifikasi output live** — butuh trigger `GET /api/market-digest` (non-cached) + Redis + API key di environment deploy untuk konfirmasi output asli. Fix double-fetch News bisa diverifikasi browser (DevTools Network + `console.count`).

**Catatan review (sesuai plan bagian C):** perubahan teks prompt di poin 6 dan 7 di atas adalah **draft** — wajib direview user sebelum dianggap final, karena prompt menyimpan preferensi gaya tulisan user.

---

## Changelog Session 47 (2026-06-05)

### ScraperAPI Proxy + CME CVOL Fix + Bug Fixes

**1. ScraperAPI Proxy — `api/rate-path.js` + `api/correlations.js`**
- Root cause: CME Group memblokir IP data center Vercel (AWS/GCP) via Akamai WAF.
- Solusi: ScraperAPI residential IP proxy — tidak diblokir CME.
- `api/rate-path.js`: tambah `cmeFetch(targetUrl, directHeaders, timeoutMs)` — jika `SCRAPER_API_KEY` ada, semua CME fetch (FedWatch V1/V2, ZQ settlement, ZQ quote) di-route via `api.scraperapi.com`. Timeout naik 8-10s → 15s.
- **Env var baru:** `SCRAPER_API_KEY` di Vercel. Free tier: 5,000 credits/bulan, kebutuhan aktual ~120-180 req/bulan.

**2. CME CVOL Risk Reversals — Endpoint Baru + 6 Pair**
- Endpoint lama `CmeWS/mvc/Volatility/historical` return 404 (dihapus CME).
- Endpoint baru: `https://www.cmegroup.com/services/cvol?symbol={CODE}&isProtected&_t={timestamp}`
- Response format: array `[{ skew: "-0.402", atmInd, cvolPrice, ... }]` — field `skew` langsung di root.
- **Symbol mapping baru (semua dikonfirmasi via browser test):**
  - EUR/USD → `EUVL`, GBP/USD → `GBVL`, USD/JPY → `JPVL`
  - AUD/USD → `ADVL`, USD/CAD → `CAVL` (bukan CDVL), XAU/USD → `GCVL`
  - NZD/USD + USD/CHF: tidak tersedia di CME CVOL (options terlalu illiquid)
- **6 pair live:** EUR/USD (-0.402), GBP/USD (-0.728), USD/JPY (+1.598), AUD/USD (-0.819), USD/CAD (-0.166), XAU/USD (-0.021)
- Cache key: `rr_cache_v2`, TTL 3600s.
- Barchart OnDemand: dikonfirmasi **enterprise berbayar** (bukan free) — path tetap ada di kode tapi tidak digunakan.

**3. Bug Fixes**
- `index.html` line 2673: `handleNewItems is not defined` — SW masih kirim `NEW_ITEMS` tapi fungsi sudah dihapus. Fix: ganti `handleNewItems(e.data.items)` → `fetchFeed()`.
- `api/calendar.js`: return HTTP 500 saat FF XML tidak ada event di range tanggal (weekend). Fix: hanya throw 500 jika kedua fetch benar-benar gagal (`anyFetchSucceeded` flag). Event kosong (weekend/no high-impact) return 200 empty array.

**4. Penjelasan Manfaat Risk Reversal untuk Trader**
- RR = fear indicator dari options market (bukan performance indicator).
- Negatif = institusi beli put lebih mahal (fear downside). Positif = call bias (expect kenaikan).
- Kegunaan: konfirmasi CB bias, deteksi contrarian setup (RR ekstrem = semua positioned satu arah), sizing confidence (trade with/against institutional hedging).
- Contoh: AUD/USD -0.819 → institusi agresif hedge downside AUD; USD/JPY +1.598 → carry trade masih diminati.

---

## Changelog Session 46 (2026-06-04)

### Fitur Baru dari Backlog

**1. Portfolio VaR — Tab JURNAL (`index.html`)**
- Card `#jnVarCard` muncul di atas filter buttons di `jnListView` saat ada posisi open.
- `jnRenderVaR()`: async function yang fetch ATR per pair secara paralel, hitung VaR 1D 95% per posisi, lalu hitung Portfolio VaR via variance-covariance method (korelasi dari `corrData`).
- **Notional USD benar per pair type**: XAU/USD (`lots × 100 oz × price`), quote=USD (`lots × 100K × rate`), base=USD (`lots × 100K`), cross (`lots × 100K × base/USD rate dari szLiveRates`).
- **ATR cached** di `sessionStorage` 4 jam agar tidak re-fetch tiap kali filter berubah.
- Warning kuning jika 2 pair berkorelasi ≥0.70 dan arah sama (risiko amplified). Warning hijau jika hedge (arah berlawanan, risiko tereduksi).
- Diversification % = `(1 - portfolioVar1d / undiversifiedVar) × 100` — membandingkan VaR dengan korelasi vs tanpa korelasi.
- Note "buka tab KORELASI" muncul jika `corrData` belum dimuat.

**2. Cleveland Fed Inflation Nowcast — `api/real-yields.js`**
- Tambah fetch `EXPINF10YR` (FRED series — Cleveland Fed 10-year inflation expectation model, monthly) paralel dengan DGS10 dan T10YIE.
- USD inflation_exp sekarang: primary = TIPS T10YIE (market-implied, daily); fallback = Cleveland Fed EXPINF10YR jika TIPS gagal.
- `source_inflation` field mencantumkan keduanya: `"FRED T10YIE (TIPS breakeven) · Cleveland Fed 10yr: X%"`.
- Response USD menambah field `cleveland_fed_exp` (nullable).

**3. CME FedWatch Fix — `api/rate-path.js`**
- Split `CME_FEDWATCH_URL` jadi V1 (dengan `?startDate=`) dan V2 (tanpa param) — keduanya dicoba dalam loop.
- Shared `CME_HEADERS` object dengan full browser fingerprint (User-Agent, Sec-Fetch-*, Accept-Language).
- Tambah `fetchCMEQuoteZQ()`: coba endpoint quote publik CME untuk produk 305 (ZQ front-month). Muncul sebagai step 2b antara ZQ settlement dan T-bill.
- Source label baru `cme_zq_quote` di response jika berhasil.
- Fallback chain: CME FedWatch V1 → V2 → ZQ Settlement → ZQ Quote → FRED T-bill → Heuristic.

**4. FX Risk Reversals — `api/correlations.js` + `index.html`**
- `action=risk-reversal`: endpoint baru di correlations.js (tidak butuh rate limiter terpisah).
- **Attempt 1 — CME CVOL Skew**: fetch `https://www.cmegroup.com/CmeWS/mvc/Volatility/historical?productCode=EUSK` (dan GBSK, JPSK, ADSK, CDSK) tanpa auth. Jika ≥3 pair berhasil → pakai CME CVOL.
- **Attempt 2 — Barchart OnDemand**: jika `BARCHART_API_KEY` env var tersedia, fetch getFuturesOptionsEOD untuk 6E/6B/6J/6A/6C/6N/6S, cari 25-delta calls dan puts (tolerance ±0.06), hitung `RR = call_IV - put_IV`.
- **Jika keduanya gagal**: return `{ available: false, reason: '...' }` dengan instruksi menambah `BARCHART_API_KEY`.
- Redis cache `rr_cache` TTL 3600s.
- **Frontend**: section `#fundRRSection` di tab FUNDAMENTAL, muncul secara dinamis saat data tersedia. Per pair: angka RR + label (Call Bias ↑ / Put Bias ↓ / Neutral). Sumber ditampilkan di header. Dipanggil fire-and-forget dari `fetchFundamental()`.

---

## Changelog Session 45 (2026-06-04)

### Bug Fixes

**1. Rate Path — Fix keyless FRED + T-bill logic + heuristic (`api/rate-path.js`)**
- Ganti `fetchFredSeries` (butuh `FRED_API_KEY`) → `fetchFredCsv` (keyless, pattern sama dengan `cb-status.js` scrapeUSD). Root cause "selalu fallback ke heuristic": FRED API key missing/rate-limit → semua T-bill null → heuristic.
- T-bill term premium fix: T-bill yield biasanya ~20bps DI ATAS EFFR di regime hold (term premium). Logic lama: `prob_cut = (FF - tbill) / 0.25` → T-bill di atas FF → prob_hike=100% (salah). Logic baru: `spread = FF - tbill + 0.20` → jika T-bill 4.30% dan FF 3.75%: spread = -0.35 → prob_cut = 1% ✓.
- Heuristic threshold lebih akurat: d≥0.5 (FF 3.5-4.0%) → 7% (sebelumnya 12%). Untuk FF=3.75%: 7% vs CME FedWatch aktual ~1.6% (lebih mendekati realita, bukan 7.5× lebih tinggi seperti sebelumnya).
- `computeRatePath()` tidak lagi butuh `apiKey` parameter.

**2. GDP Nowcast — Keyless fetch + auto-trigger via fundamental_refresh (`api/admin.js`)**
- `gdpnowHandler`: ganti dari FRED API (butuh key) ke `fetchGdpNowData()` helper yang primary-nya FRED CSV keyless, fallback ke API. Data kini pasti tersimpan ke Redis saat cron jalan.
- `fundamentalRefreshHandler`: di akhir handler, auto-refresh GDP Nowcast jika data >6 jam stale. Artinya klik tombol "REFRESH" di tab FUNDAMENTAL sekarang juga update GDP Nowcast di card USD.
- Data disimpan di `fundamental:USD` → `GDP Nowcast` → auto-render di tabel karena `renderFundamental()` sudah render semua key.

**3. Fundamental Parser — Reject % untuk quantity indicators + Core PCE YoY disambiguation (`api/_fundamental_parser.js`)**
- Tambah `QUANTITY_INDICATORS` set: NFP, Jobless Claims, Employment Change, Claimant Count, Building Approvals, Housing Starts, Durable Goods Orders. Jika value-nya berakhir `%`, parse di-reject. Fix: `NFP: 0.0%` tidak lagi bisa overwrite seed `NFP: 178K`.
- Disambiguasi Core PCE: jika headline mengandung `y/y|yoy|annual|year-on-year` → key disimpan sebagai `Core PCE YoY` (bukan `Core PCE`). Mencegah nilai `4.4%` YoY overwrite seed MoM `0.3%`. Idem untuk `Core CPI MoM` → `Core CPI YoY`.

**4. Inflation Expectations Update (`api/real-yields.js`)**
- EUR: 2.1% → 2.0% (ECB SPF Q2 2026, as_of 2026-04-10)
- CAD: 2.3% → 2.2% (BoC MPR Apr 2026, as_of 2026-04-16)
- AUD: as_of updated → RBA SoMP May 2026 (2026-05-06), value 3.2% (unchanged, RBA hiking)
- NZD: 2.2% → 2.1% (RBNZ MPS May 2026, as_of 2026-05-27)
- CHF: as_of updated → SNB Mar 2026 (2026-03-19), value 0.4% (unchanged)
- JPY: as_of updated → BoJ Tankan Q1 2026 (2026-03-28, Tankan published late March)
- GBP: unchanged (BoE IAS Q2 2026 results not published yet as of June 4)

---

## Changelog Session 44 (2026-06-03)

### Implementasi daun_merah_plan.md — 14 Items

**Data Accuracy:**
- `api/cb-status.js` — CB_FALLBACK diperbarui: AUD last_meeting `2026-05-05` (hike +25bps ke 4.35%), NZD last_meeting `2026-05-27` (hold)
- `api/real-yields.js` — Tambah 3 data source baru:
  - **OECD CPI Forecast** (`fetchOECDInflation`): auto-fetch dari OECD Economic Outlook, override hardcoded INFLATION_EXPECTATIONS. Redis key `oecd_inflation` TTL 24h.
  - **TGA + Fed Balance Sheet** (`fetchLiquidityIndicators`): US Treasury FiscalData API + FRED WALCL. Redis key `liquidity_usd` TTL 1h.
  - **Yield Curve USD+EUR** (`fetchYieldCurve`): FRED DGS2/5/10/30 untuk USD, ECB SDW untuk EUR. Spread 2Y10Y + NORMAL/FLAT/INVERTED label. Redis key `yield_curve` TTL 1h.
- `api/admin.js` — Tambah `?action=gdpnow`: fetch FRED GDPNOW series, simpan ke `fundamental:USD` hash sebagai "GDP Nowcast"
- `api/rate-path.js` — Tambah `fetchCMEZQData()`: fetch ZQ (30-day Fed Funds futures) settlement dari CME public endpoint, hitung probabilities per FOMC meeting. Fallback ke heuristic SOFR jika CME unavailable.

**Performance:**
- `api/market-digest.js` — Call 2 (CB bias) dan Call 4 (thesis monitor) sekarang fire sebagai async IIFEs **sebelum** Call 1 dimulai, berjalan concurrent. Sebelumnya sequential; sekarang parallel → hemat ~5-10 detik wall time per request.
- `api/journal.js` — GET entries: dari N+1 sequential Redis GET menjadi single `MGET` batch. Sama untuk `?action=analyze`. Dari 51 roundtrips (50 entries) → 2 roundtrips.

**New Features:**
- `api/correlations.js` — Tambah `?action=atr`: hitung ATR-14 + 1-day daily σ dari Yahoo Finance OHLCV. Cache `atr:{symbol}` TTL 4h. Support 29 pairs + XAU/USD.
- `api/risk-regime.js` — Tambah VIX term structure: fetch ^VIX1M + ^VIX3M dari Yahoo. Response includes `vix_term_structure: { vix_spot, vix_1m, vix_3m, structure }`. Label: "Backwardation (Panik Akut)" vs "Contango (Fear Terdistribusi)".

**Frontend (index.html):**
- **ATR/VaR di Sizing Calculator**: warning kuning jika SL < ATR 14d, baris info ATR + 1d VaR 95% selalu tampil setelah data tersedia (~1 detik async).
- **Yield Curve display**: section YIELD CURVE di card USD dan EUR di tab FUNDAMENTAL. Tampil 2Y/5Y/10Y/30Y rates + spread 2Y10Y dengan color coding.
- **Liquidity USD display**: section LIQUIDITY USD di card USD — Fed Assets + TGA balance dengan arah drain/inject.
- **VIX Term Structure**: row tambahan di regime breakdown — warna merah untuk backwardation, hijau untuk contango.
- **Checklist state per-pair**: `ckLoad/ckSave` sekarang pakai key `daunmerah_v2_state_{PAIR}` (e.g. `_EURUSD`). Saat ganti pair, state pair lama disimpan dan state pair baru dimuat.

---

## Changelog Session 41 (2026-06-02)

### Bug Fix — Dashboard Panel Tampil di Mobile

**Root cause:** `#dashboardPanel { display: none }` ditulis di dalam `@media (min-width: 1024px)`. Artinya di mobile (< 1024px) panel tidak punya aturan display apapun — browser render sebagai block element di bawah feed. `hideAllPanels()` hanya remove class `.visible` yang tidak berpengaruh di mobile.

**Fix:** Pindahkan `#dashboardPanel { display: none }` ke luar media query (scope global). Hanya rule `#dashboardPanel.visible { display: grid }` yang tetap di dalam media query. Panel sekarang selalu tersembunyi di mobile.

---

## Changelog Session 40 (2026-06-02)

### Sizing Calculator — Form Persist + History Optimistic Update
- `szPersistForm()` / `szRestoreForm()`: simpan semua field form ke `localStorage` (`daun_merah_sz_form`) saat HITUNG atau saat direction/mode berubah. Auto-restore saat tab SIZING pertama dibuka (termasuk setelah refresh/reopen PWA). Guard `_szRestoring` flag agar restore tidak trigger save ganda.
- Fields yang disimpan: equity, risk%, pair, RR, stop (pips), entry (pips mode), entryPrice & slPrice (price mode), direction, mode
- `szSaveHistory()` refactor ke fire-and-forget: tidak lagi `await`, tidak lagi trigger `szLoadHistory()`. History update via optimistic local cache (`szHistoryCache`) — muncul instan tanpa network roundtrip.
- `szRenderHistory()` dipisah dari `szLoadHistory()` agar bisa di-call dari cache maupun dari network.
- `initSizing()`: render history dari cache (instant) + load fresh di background setiap tab dibuka.

### CSS Polish
- **`100dvh`**: `body { height: 100dvh }` (fallback `100%`). Mencegah layout terpotong address bar mobile browser (Safari iOS, Chrome Android).
- **Scrollbar desktop**: `@media (min-width:1024px)` tampilkan scrollbar tipis 5px untuk `.feed-scroll`. Warna `--border` / `--muted` on hover. User mouse tahu konten bisa di-scroll. Mobile tetap hidden.
- **Pulse animation loading**: `.loading-pulse` pakai existing `@keyframes textPulse`. Diterapkan di: CB research, kalender ekonomi, jurnal list, COT, fundamental, COT tren chart.

## Changelog Session 40 (2026-06-23)

### Fix: Fundamental tab — CB Rate row tidak pernah auto-update (stale seed)

**Bug ditemukan:** Audit data tab FUNDAMENTAL menemukan `ECB Rate` masih tertulis 2.15% padahal ECB sudah hike ke 2.40% (meeting 2026-06-17, terdeteksi oleh `cb-status.js`). Root cause: field `"{Bank} Rate"` di hash `fundamental:{currency}` ditulis sekali saat `fundamental_seed` (`source:"seed"`, tanpa tanggal) dan tidak pernah ikut pipeline auto-refresh (`autoUpdateFundamentals`/`fundamental_refresh`) — beda mekanisme dari indikator headline lain. Semua 8 CB rate kebetulan masih cocok kecuali ECB, yang baru kena karena rate decision terbaru.

**Fix:**
- Extract logic scrape+cache CB rate dari `api/cb-status.js` ke modul baru `api/_cb_rates.js` (prefix `_` → tidak dihitung ke limit 12 serverless function). Export `getLiveCbRates()` — scrape 8 official source (FRED, ECB Data Portal, BoE/BoJ/RBA/RBNZ/SNB webpage, BoC Valet) dengan 6h Redis cache (`cb_rates_live_v2`), sama persis dengan yang sudah dipakai `cb-status.js`.
- `api/cb-status.js` jadi thin wrapper: panggil `getLiveCbRates()` + merge `cb_bias`.
- `api/admin.js` `fundamentalGetHandler`: setelah baca hash `fundamental:{cur}`, overlay key `"{Bank} Rate"` dengan hasil `getLiveCbRates()` (`actual`, `period`/`date` = `last_meeting`, `source` = `rate_source`: `live_fresh`/`live_cached`/`fallback`). Jadi setiap kali tab FUNDAMENTAL fetch data, rate bank sentral selalu live (maks ~6 jam basi dari cache), bukan beku dari seed.
- Tidak perlu cron baru atau write-through ke Redis — overlay terjadi di read-time, reuse cache 6h yang sudah ada.

**Verifikasi:** Test lokal `getLiveCbRates()` → EUR balik `2.4%` (`live_fresh`), konsisten dengan endpoint `/api/cb-status` production. Simulasi overlay ke struktur `fundamental_get` menghasilkan `"ECB Rate":{"actual":"2.4%","source":"live_fresh",...}` — sesuai ekspektasi.

## Changelog Session 39 (2026-06-02)

### Export CSV — Tab JURNAL
- Tambah tombol **EXPORT CSV** di baris filter (kanan, warna hijau) pada `jnListView`
- `jnExportCSV()`: export semua `jnAllEntries` (semua status) ke file `.csv`, diurutkan ascending by `created_at`
- Kolom: No, Tanggal Buka, Pair, Arah, Status, Entry, SL, TP, Lots, RR Plan, R Aktual, Exit Price, Tanggal Tutup, Alasan Keluar, Horizon, Regime, Thesis, Catatan Post-Trade
- UTF-8 BOM di awal file agar Excel Windows buka langsung tanpa encoding issue
- Nama file otomatis: `jurnal_daun_merah_YYYY-MM-DD.csv`
- Proper CSV escaping: wrap in quotes jika ada koma/newline/quote, double-quote untuk escape

## Changelog Session 38 (2026-06-02)

### Critical Bug Fixes

- **Vercel Body Timeout** (`api/journal.js`): `readBody()` sekarang cek `req.body` terlebih dahulu sebelum listen ke stream. Vercel auto-parses request body sehingga stream `req.on('data')` tidak pernah fire — penyebab 504 Gateway Timeout pada POST request jurnal.
- **Swipe Navigation** (`index.html`): Ganti `getComputedStyle` check + hard `return` dengan while-loop yang skip tab `dashboard` secara eksplisit pada viewport < 1024px. User mobile tidak lagi tersangkut saat swipe dari/ke tab manapun.
- **Pair Slicing EUR/USD** (`index.html`, 2 lokasi): Fix `pair.slice(3,6)` → `pair.includes('/') ? pair.split('/')` di `ckPrefillJurnal()` dan `openMT5Modal()`. `EUR/USD` sebelumnya menghasilkan `/US` sehingga CB bias tidak ter-apply. Line 5444 sudah benar sejak awal.
- **Service Worker Memory Leak** (`sw.js`): `loadSeenGuids()` sekarang merge (tidak overwrite) Set in-memory. `saveSeenGuids()` trim `seenGuids` di memori ke 200 entri, selaras dengan cache storage — mencegah Set bertumbuh tak terbatas antar wake cycle.

## Changelog Session 37 (2026-06-02)

### Fitur 1 — COT Historical Trend Chart
- **Backend**: tambah branch `?type=cot_history&n=12` di `api/feeds.js` — baca Redis sorted set `cot_history` (sudah di-populate sejak session 20), slice N terbaru, return ascending untuk chart. Cache `cot_history_cache` TTL 3600s.
- **Frontend COT tab**: tombol `[TREN]` muncul di setiap row Leveraged Funds. Klik toggle panel inline SVG line chart 2 garis (AM net = teal `#00c896`, Lev net = pink `#f472b6`).
- SVG pure: viewBox 400×120, y-axis label, x-axis label (tanggal), zero line putus-putus, hover hitbox per titik data dengan tooltip global fixed.
- Client cache `cotHistoryCache` TTL 30 menit. State `cotTrendOpen` per currency, di-reset saat `renderCOT()` rebuild DOM.

### Fitur 2 — Macro Scenario Planner
- Panel inline muncul di bawah setiap event **High-impact** di tab CAL (toggle via tombol `[SIMULASI]`).
- Tombol `[▲ BEAT]` / `[▼ MISS]` → kalkulasi ranking 3 pair terbaik berdasarkan CB bias divergence dari `cbData`.
- Logic `scenarioRankCurrencies`: USD event → ranking 7 counterpart; non-USD event → pair vs USD + crosses.
- Hasil render: pair name, direction LONG/SHORT (warna hijau/merah), alasan CB bias + rate. Warning "tetap validasi via CHECKLIST" + tombol langsung ke checklist dengan pair pre-select.
- State `calScenarioOpen` reset saat `renderCalendar()` rebuild DOM.

### Fitur 3 — Command Center Dashboard (Desktop ≥1024px)
- Tab `DASHBOARD` di top nav — hanya muncul di `@media (min-width: 1024px)` via CSS.
- CSS grid 3-kolom: 280px News | 1fr AI Digest + Thesis | 260px CB Bias + Fund Ranking; event bar full-width di bawah.
- JS: `initDashboard()`, `renderDashNews()`, `renderDashDigest()`, `renderDashBias()`, `renderDashEvents()`, `refreshDashboard()`.
- Semua data reuse dari memory global (`allItems`, `ringkasanCache`, `cbData`, `fundData`, `calData`) — tidak ada fetch tambahan.
- Auto-refresh `setInterval` 60s hanya saat tab aktif; otomatis stop saat pindah tab.
- Keyboard shortcut: `G D`. Swipe mobile: skip dashboard (hidden tab check via `getComputedStyle`).

---

## Changelog Session 36 (2026-06-02)

### Equity Curve — Tab JURNAL
- Tambah tab **KURVA** di sub-nav Journal (sebelah "+ BARU")
- `jnRenderCurve()`: render SVG equity curve dari closed trades yang punya `r_actual`
- Kurva cumulative R-multiple, fill hijau di atas nol, merah di bawah nol
- Stats row: Total R, Win Rate, Avg Win R, Avg Loss R + Max Drawdown
- Zero dependency — pure SVG, load instan
- Auto-render saat tab KURVA dibuka; auto-refresh setelah `jnLoadEntries()` selesai

### Event Strip — Tab TEK
- Tambah horizontal scroll strip `#tekEventStrip` antara TradingView chart dan MTF bar
- `renderTekEventStrip()`: filter `calData` hanya High-impact, dalam 48 jam ke depan, untuk currencies yang relevan dengan pair aktif
- Mapping `PAIR_CURS` (e.g. EURUSD → EUR+USD) untuk filter otomatis per pair
- Setiap event tampil sebagai chip: currency color dot + nama event + time WIB + countdown ("2j 30m")
- Strip disembunyikan (`display:none`) jika tidak ada event relevan
- Di-update saat `initTeknikal()` dan setiap `onTekPairChange()`

---

## API Endpoints

### `GET /api/feeds?type=rss`
Proxy RSS FinancialJuice. Redis `rss_cache` TTL 60s. Header `X-Cache-Source: REDIS/UPSTREAM/STALE`.

### `GET /api/feeds?type=research`
Backend tab "CB WATCH". Fetch 6 RSS feeds paralel via `Promise.allSettled`. Merge, sort by date, 50 items terbaru (max 20/sumber). Redis `research_cache` TTL 6h. Support `?force=1` untuk bypass cache. Response: `{ items:[{ title, pubDate, link, source }], fetched_at, stale? }`.

**Sumber aktif:**
- `FED`  — `federalreserve.gov/feeds/speeches.xml` (direct — pidato governor)
- `FOMC` — `federalreserve.gov/feeds/press_monetary.xml` (direct — rate decisions)
- `FEDN` — `federalreserve.gov/feeds/feds_notes.xml` (direct — FEDS Notes, analytical)
- `ECB`  — `ecb.europa.eu/rss/press.html` (direct — press releases)
- `ECBB` — `ecb.europa.eu/rss/blog.html` (direct — ECB research blog)
- `BIS`  — `bis.org/doclist/cbspeeches.rss` via rss2json proxy (WAF bypass — unverified)

**Diblokir Vercel IPs (403), tidak digunakan:** IMF Blog, FRED Blog, BOE, NY Fed.

> Nitter (`?type=nitter`) sudah dihapus — semua instance return body kosong sejak X/Twitter blokir scraping.

### `GET /api/feeds?type=cot`
Scrape CFTC, parse Leveraged Funds + Asset Manager positions. Redis `cot_cache_v2` TTL 6 jam. Fallback ke stale jika parsed currencies < 5.

### `GET /api/admin?action=health`
Probe 6 external sources paralel. Telegram alert jika DOWN > 2 jam. Auth: `x-admin-secret` header.

### `GET /api/admin?action=redis-keys`
Registry semua Redis keys + live TTL. `POST ?action=redis-keys&cleanup=true` untuk hapus deprecated keys. Auth: `x-admin-secret`.

### `GET/POST/DELETE /api/admin?action=admin-prompts&key=...`
Update Groq prompts di Redis tanpa redeploy. Keys: `prompt_digest`, `prompt_bias`, `prompt_thesis`. Auth: `x-admin-secret`.

### `POST /api/admin?action=push`
Cron-triggered web push + Telegram. Auth: `x-cron-secret` header. Setup di cron-job.org: URL `/api/admin?action=push`.

### `GET /api/market-digest`
Main AI endpoint. Multi-provider chain dengan circuit breaker. Flow:
1. Load `prompt_digest` dari Redis (fallback ke hardcoded `DIGEST_SYSTEM_DEFAULT`)
2. Fetch RSS via internal `/api/feeds?type=rss`
3. Fetch ForexFactory kalender (this week + next week)
4. Load `digest_history` + `real_yields` + **`xau_spot`** dari Redis paralel
5. **`fetchXauSpot()`** — Yahoo Finance `GC=F` → fallback Binance PAXGUSDT. Cache Redis `xau_spot` TTL 5 menit. Inject ke prompt sebagai jangkar harga `$xxx.xx (+y%)`.
6. **Call 1 — Market Briefing (Bahasa Indonesia):**
   - Primary: OpenRouter `openai/gpt-oss-120b:free` (circuit breaker `ai:openrouter`, timeout 28s) — terbukti stabil, output Bahasa Indonesia confirmed via live test
   - Fallback 1: Groq `qwen/qwen3-32b` (timeout 20s, max_tokens 1800)
   - Fallback 2: Groq `llama-3.3-70b-versatile` (timeout 14s, max_tokens 2000)
   - Last resort: template fallback (kumpulan headline)
   - `method` field: `openrouter` / `groq-qwen3` / `groq` / `fallback`
   - Instruksi `PENTING: TULIS SELURUH OUTPUT DALAM BAHASA INDONESIA` ditambahkan ke user message — fix bahasa Inggris yang muncul saat model diabaikan system prompt
   - DeepSeek V4 Flash free dites tapi tidak dipakai — upstream Crucible konsisten 429, tidak reliable
7. Save ke `digest_history` (Redis, LPUSH/LTRIM max 7)
8. **SambaNova Call 2:** CB Bias Assessment — JSON per currency (circuit breaker `ai:sambanova`) — **DeepSeek-V3.2** (upgrade dari V3.1, session 34)
   - **Session 35 — Fundamental Anchor:** Sebelum build prompt, fetch `fundamental:{currency}` dari Redis untuk setiap `relevantCurrency`. Data injected ke prompt sebagai context objektif: `"USD: CPI YoY 3.2% (prev 3.5%), NFP: +180K [2026-05-30]"`. AI diberi instruksi untuk weight fundamentals lebih tinggi dari headline sentiment kalau bertentangan.
   - **Session 35 — Confidence Gate (A):** Kalau AI return confidence `Low` untuk suatu currency → skip update, pertahankan existing bias di Redis. Mencegah flip ke Neutral di hari sepi berita.
   - **Session 35 — Swing Anchor (B):** Kalau new bias bergerak >2 level dari existing bias (skala BIAS_ORDER 7 tingkat) tanpa `High` confidence → skip update. Contoh: `Cautious Dovish → Hawkish` butuh High confidence. Realistic pivot dengan banyak evidence (High conf) tetap langsung update.
   - Prompt diupdate: currency dengan bukti tidak cukup wajib **dihilangkan** dari response (bukan ditebak), instruksi confidence Low prefer omit.
9. Merge + save ke Redis `cb_bias` (hanya currencies yang lolos gate A + B)
10. **SambaNova Call 3:** Structured thesis JSON → fallback Groq llama jika sambanova OPEN — **DeepSeek-V3.2**
11. **Groq Call 4:** Thesis Invalidation Monitor — scan open journal entries vs headlines. Hasil di-cache Redis `thesis_alerts:{device_id}` (TTL 30 menit). Ditampilkan inline di ringkasan + toast notif saat ada kontradiksi. Initial load juga fetch cached alerts via `mode=cached&device_id=...`
12. **`autoUpdateFundamentals`** — parse 100 headline terbaru → HSET `fundamental:{currency}`, deteksi CB rate decision → `cb_decisions`
13. **`autoUpdateFundamentalsFromCalendar`** — FF calendar events dengan `actual` non-null langsung update `fundamental:{currency}` tanpa parsing teks (source: `ff_calendar`)
14. Return: `{article, method, news_count, cal_count, bias_updated, generated_at, thesis, thesis_alerts}`

**Circuit breakers:** `ai:openrouter`, `ai:cerebras`, `ai:sambanova` — reset via `POST /api/admin?action=circuit-reset`. Status via `GET /api/admin?action=circuit-status`.

**Redis keys baru:** `xau_spot` (TTL 300s) — harga XAU/USD live dari Yahoo GC=F atau Binance PAXG.

Rate limited: 4 req/min per IP.

### `GET /api/cb-status`
Static CB data (rates, last meeting) + bias dari Redis `cb_bias`.

### `GET /api/calendar`
ForexFactory high-impact + medium-impact events, 5 hari ke depan. Waktu dikonversi ke WIB (UTC+7).
Return fields per event: `{ date, time_wib, currency, event, impact, forecast, previous, actual }`
**TIDAK ADA field `datetime`** — frontend harus construct dari `date` + `time_wib`.

### `GET /api/risk-regime`
Classifier Risk-On/Neutral/Risk-Off dari VIX (FRED), MOVE (Stooq), HY OAS (FRED). Redis `risk_regime` TTL 1800s.

### `GET /api/real-yields`
Real yield differential. USD: DGS10 − T10YIE. 7 currencies lain hardcoded inflation expectations. Redis `real_yields` TTL 21600s.
Per currency: `{ nominal, inflation_exp, real, source_inflation, inflation_as_of, as_of, stale }`. `stale: true` jika `inflation_as_of > 90 hari`. UI menampilkan `(lama)` kuning + tooltip source + usia hari.

### `GET /api/rate-path`
USD rate path **HEURISTIC** (bukan CME FedWatch / market-implied). FRED SOFR/EFFR + step-function probability. UI menampilkan label "Estimasi (bukan probabilitas pasar)". Redis `rate_path` TTL 14400s.

### `GET /api/correlations`
Cross-asset Pearson 20d + 60d, 12 instrumen via Yahoo Finance. On-demand via button. Redis `correlations_v2` TTL 86400s. Rate limited: 5/min.
Response fields: `instruments`, `matrix_20d`, `matrix_60d`, `anomalies` (max 10, delta >0.4), `gold_correlations` (Gold vs 10 aset: DXY/Silver/Copper/WTI/US10Y/SPX/VIX/JPY/AUD/EUR — selalu ada, bukan hanya anomali), `computed_at`, `stale`.

### `GET /api/correlations?action=ta&symbol=...`
Endpoint TA murni (RSI 14, SMA 50, SMA 200, Volume) dari Yahoo Finance. Rate limited: 5/min (shared dengan correlations).
- `symbol`: default `GC=F`. FX: `EURUSD=X`, `USDJPY=X`, dll. Futures: `GC=F`, `CL=F`. Equities: `^GSPC`.
- `interval`: `5m` `15m` `30m` `1h` `4h` `1d`(default) `1wk`. Range dikunci otomatis per interval (misal `1h`→`60d`, `1d`→`1y`).
- Volume (`current_volume`, `volume_sma_20`, `volume_status`) hanya tersedia untuk futures/equities — `null` untuk FX OTC (`EURUSD=X` dll) karena Yahoo tidak menyediakan data volume OTC yang reliable.
- Redis cache per `ta:{symbol}:{interval}`: TTL 1800s (daily), 600s (intraday).
- Response fields: `symbol`, `interval`, `range`, `current_price`, `rsi_14`, `sma_50`, `sma_200`, `price_vs_sma50`, `price_vs_sma200`, `current_volume`, `volume_sma_20`, `volume_status`, `computed_at`, `from_cache`.
- **Frontend integrasi (session 20):** Panel TA 4-kotak ditampilkan di tab TEK, di bawah MTF bar dan di atas catatan analisa. Auto-fetch saat pair/TF berganti. Client-side cache 90s. FX OTC: volume ditampilkan "n/a FX OTC". TEK_YAHOO_SYM mapping: EURUSD→EURUSD=X, ..., XAUUSD→GC=F.

### `GET /api/correlations?action=ohlcv&symbol=...&tf=...`
Endpoint OHLCV candle data untuk Lightweight Charts (session 24). Rate limited: 10/min.
- `symbol`: Yahoo Finance symbol (e.g. `EURUSD=X`, `GC=F`).
- `tf`: `1d` | `1h` | `4h` | `15m`. Note: `4h` di-fetch sebagai `1h` lalu di-resample ke 4h server-side via `resample4h()` (Yahoo tidak support 4h native).
- Range otomatis per tf: `15m`→`5d`, `1h`→`30d`, `4h`→`60d`, `1d`→`1y`.
- Redis cache per `ohlcv:{symbol}:{tf}`: TTL 1800s (daily), 300s (intraday).
- Response: `{ symbol, tf, candles:[{time, open, high, low, close}], fetched_at }`.
- **Frontend (session 24):** Chart engine diganti dari TradingView embedded widget ke Lightweight Charts v4 (open-source, supports custom drawing). Drawing tools: horizontal line (S/R level), trendline, rectangle (supply-demand zone). Drawing disimpan ke `localStorage['tek_drawings']` per pair+TF key (e.g. `EURUSD_240`). Toolbar: cursor, 4 alat drawing, 4 pilihan warna, undo terakhir, hapus semua. Chart tinggi diperpanjang: `clamp(420px, 62vh, 780px)`.

### `POST/GET /api/sizing-history`
History sizing calculations per device. Redis sorted set `sizing_history:{device_id}`, max 10.

### `POST/PATCH/GET/DELETE /api/journal`
Trade journal CRUD. Soft-delete. Redis `journal:{device_id}:{id}` + sorted set `journal_index:{device_id}`.

### `GET /api/journal?action=analyze&device_id=xxx`
AI analysis of closed trade performance. Fetches all closed entries, sends to Groq `llama-3.3-70b-versatile`, returns analysis text + stats (win rate, total R, avg R). Cached per device_id for 1 hour (`journal_analysis:{device_id}`). `?force=1` bypasses cache. Requires ≥3 closed trades. Endpoint merged into `journal.js` to stay within Vercel 12-function limit.

### `GET /api/admin?action=fundamental_get`
Return semua data fundamental per 8 currency dari Redis (`fundamental:{currency}` HGETALL).

### `POST /api/admin?action=fundamental_seed`
Seed data awal fundamental (dijalankan sekali). Auth: `x-admin-secret`.

### `POST /api/admin?action=fundamental_refresh`
Refresh fundamental dari dua sumber: (1) `news_history` Redis — 100 headline FJ terbaru, (2) FF calendar (this week + last week) — ambil events dengan `actual` non-null. Kedua sumber diproses paralel dan hasilnya di-merge. Auth: `x-admin-secret`.

### `POST /api/admin?action=fundamental_analysis`
AI analysis currency terkuat/terlemah dari data fundamental. Cache Redis `fundamental_analysis` TTL 6h. Provider: Groq `llama-3.3-70b-versatile`.

### `POST /api/admin?action=journal_import`
Bulk import historical trades dengan timestamp asli (preserves `created_at`). Body: `{device_id, entries:[...]}`. Auth: `x-admin-secret`.

### `POST /api/subscribe`
Web Push subscription management.

---

## Desain UI / Color System

```css
:root {
  --bg: #0a0a08;        /* latar belakang utama */
  --surface: #111110;   /* card/nav surface */
  --border: #222220;
  --accent: #c0392b;    /* merah daun merah */
  --accent-dim: #7a1f17;
  --text: #e8e4d9;
  --muted: #6b6860;
  --text-mid: #a8a49a;
  --green: #27ae60;
  --yellow: #e67e22;
  --purple: #a78bfa;
  --pink: #f472b6;
}
```

Font: **Syne** (logo/heading), **DM Mono** (semua teks lainnya)

---

## Navigasi

### Desktop — Top Nav (`.nav-views`)

| Tab | `data-view` | Warna |
|-----|-------------|-------|
| NEWS | `feed` | `--accent` |
| RINGKASAN | `ringkasan` | `--accent` |
| CAL | `cal` | `--green` |
| COT | `cot` | `--purple` |
| FUNDAMENTAL | `fundamental` | `--yellow` |
| CHECKLIST | `checklist` | `--yellow` |
| SIZING | `sizing` | `--accent` |
| JURNAL | `jurnal` | `--pink` |
| PETUNJUK | `petunjuk` | `#60a5fa` |

### Mobile — Bottom Nav (`#botNav`, `.bot-nav`)
Fixed bottom bar, hanya muncul di ≤767px. Top nav disembunyikan di mobile. 8 tombol dengan SVG icon + label pendek. Active state disinkronkan dua arah dengan top nav.
**Catatan implementasi:** Event listener pakai event delegation pada `document` (bukan `querySelectorAll` langsung) karena `#botNav` HTML berada setelah `</script>` tag.

### Keyboard Shortcuts (2026-05-27)
Bloomberg-style keyboard navigation. Aktif hanya saat tidak ada input/textarea yang fokus.

**G + huruf — navigasi antar fitur:**
| Shortcut | Tujuan |
|----------|--------|
| `G N` | News (feed) |
| `G B` | CB Watch |
| `G R` | Ringkasan |
| `G K` | Kalender |
| `G C` | COT |
| `G F` | Fundamental |
| `G L` | Checklist |
| `G S` | Sizing |
| `G J` | Jurnal |
| `G P` | Petunjuk |
| `G T` | Teknikal |

**Angka 1–7 — sub-filter News** (hanya aktif saat di tab News): All, Mkt Moving, Forex, Macro, Econ Data, Energy, Geopolitical.

**Checklist navigation**: `↑`/`↓` navigasi item, `Space`/`Enter` centang/uncentang, `Esc` lepas fokus. Item terfokus diberi highlight kuning `.ck-focused`.

**Global**: `?` buka/tutup help overlay shortcut. `Esc` tutup overlay / lepas fokus checklist.

**G-mode indicator**: Saat `G` ditekan, muncul badge kecil di bawah layar ("G —") selama 1 detik sebagai feedback visual. Implementasi: `kbGSeq` flag + `setTimeout` 1000ms. Semua logika di `// ── KEYBOARD SHORTCUTS ──` section, sebelum `</script>`.

### Swipe Gesture (2026-05-07)
Navigasi antar tab dengan swipe kiri/kanan. Implementasi: `touchstart`/`touchend` listener pada `document` (passive). Logika: `|dx| ≥ 60px` AND `|dx| > |dy|` → navigate. Swipe kiri = tab berikutnya, swipe kanan = tab sebelumnya. Diabaikan jika touch dimulai di `#navViews`, `#navFilters`, `#botNav`, `input`, `select`, atau `textarea`. Reuse logika tab via `.click()` sehingga data fetch otomatis berjalan. Tab order: feed → ringkasan → cal → cot → checklist → sizing → jurnal → petunjuk.
Panel incoming diberi class `swipe-in-right` (swipe kiri) atau `swipe-in-left` (swipe kanan) — CSS keyframe `translateX(±40px)→0 + opacity:0→1`, 220ms ease-out, dihapus setelah `animationend`.

### Category Filters (`.nav-filters`)
Hanya muncul di view NEWS: All, Mkt Moving, Forex, Macro, Econ Data, Energy, Geopolitical.

---

## Checklist — Detail Teknis

DOM: item = `div.ck-item`, checkbox = `div.ck-box` dengan `id="ckbox_{id}"` (**bukan `<input>`**).

```js
const PLAYBOOKS = {
  smc_ict:        { name, color, sections:[...], quick:[...], gates:[...] },
  macro_momentum: { ... },
  event_driven:   { ... },
  mean_reversion: { ... },
};
const PB_REGIME_CHECK = { id:'regime_check', num:'00', ... }; // shared semua playbook
let ckActivePlaybook = localStorage.getItem('daun_merah_playbook') || 'smc_ict';
```

localStorage keys: `daunmerah_v2` (state), `daun_merah_playbook` (active), `daun_merah_device_id` (device ID)

### Scoring System (session 2026-05-27)
- **Weighted scoring** — gate sections (3 per playbook) mendapat bobot ×2, section biasa bobot ×1
- **Hanya parent items** yang dihitung dalam scoring; sub-items tetap interaktif tapi bersifat guidance
- **4 verdict zones:**
  - `0%` → `—` (pending)
  - `1–49%` → `NO TRADE` (merah)
  - `50–74%` → `PERTIMBANGKAN` (kuning)
  - `75–89%` → `SIAP TRADE` (hijau muda)
  - `90–100%` → `ENTRY` (hijau)
- Skor ditampilkan sebagai `Score: X%` di bawah verdict label

### Gate Sections (3 kritis per playbook)
| Playbook | Gates (bobot ×2) |
|---|---|
| SMC/ICT | `regime_check`, `gate` (Driver Validity), `risk` |
| Macro Momentum | `regime_check`, `mm_trend`, `mm_risk` |
| Event-Driven | `regime_check`, `ed_event`, `ed_risk` |
| Mean Reversion | `regime_check`, `mr_range`, `mr_risk` |

### SMC/ICT Simplification
- `postentry` (09) + `antibias` (10) → merge jadi `disiplin` (09), 6 items, tanpa sub-items

### Auto-populate Logic — `ckAutoTickRegimeCheck(pair)` + helper functions
**Shared (rc1–rc5, semua playbook):**
- `rc1` ← regimeData fresh (<30 min)
- `rc2` ← cbData bias untuk base + quote tersedia
- `rc3` ← cotData positions tersedia
- `rc4` ← calData: tidak ada High-impact event <6 jam → auto-tick; ada → auto-block
- `rc5` (hint) ← realYieldsData spread ditampilkan di `#ckPairHint`

**SMC/ICT** — `_ckAutoSMC(base, quote)`:
- `f2` ← cbData[base].bias ≥ Hawkish (level ≥3)
- `f3` ← cbData[quote].bias ≤ Dovish (level ≤1)
- `f1`, `f4b`, `f6` ← kedua kondisi di atas terpenuhi
- `tm1a` ← jam UTC 08–15 (London session)
- `tm1b` ← jam UTC 13–20 (NY session)

**Macro Momentum** — `_ckAutoMacro(base, quote)`:
- `mm_cb1` ← salah satu CB hawkish, yang lain dovish/netral (dari cbData)
- `mm_cb2` ← divergence ≥2 level dari `CB_BIAS_LEVEL` map
- `mm_cb4` ← real yield spread >0.3% mendukung arah
- `mm_co2` ← cotData Asset Manager net positions tersedia

**Event-Driven** — `_ckAutoEvent(base, quote)`:
- `ed_ev1` ← calData: ada High-impact event <24 jam untuk pair
- `ed_ev3` ← calData: event tersebut punya forecast atau previous

**Mean Reversion** — `_ckAutoMeanRev()`:
- `mr_ra4` ← regimeData.regime === 'Neutral'

**CB_BIAS_LEVEL mapping** (digunakan semua helper):
```js
const CB_BIAS_LEVEL = { 'very hawkish':4, 'hawkish':3, 'neutral':2, 'dovish':1, 'very dovish':0 };
```

**Helper `_ckEvTimestamp(ev)`** — construct UTC ms dari `ev.date` + `ev.time_wib` (WIB=UTC+7), replace duplikasi konstruksi timestamp di rc4 dan _ckAutoEvent.

---

## Redis Keys

| Key | Isi | TTL | Owner |
|-----|-----|-----|-------|
| `rss_cache` | `{xml, fetchedAt}` | 60s | `api/feeds.js` |
| `cot_cache_v2` | Full COT payload | 21600s | `api/feeds.js` |
| `cot_history` | Sorted set snapshot mingguan COT (score=timestamp, 90-day rolling) | no TTL (rolling ZREMRANGE) | `api/feeds.js` |
| `cot_hist_lock:{dateKey}` | Dedup lock per minggu COT report | 604800s | `api/feeds.js` |
| `research_cache` | CB Watch items JSON (FED+FOMC+FEDN+ECB+ECBB+BIS, 50 items terbaru) | 21600s | `api/feeds.js` |
| `cb_bias` | `{USD:{bias,confidence,updated_at},...}` | no TTL | `api/market-digest.js` |
| `digest_history` | Redis list max 7 entri digest AI (LPUSH/LTRIM) | no TTL | `api/market-digest.js` |
| `latest_thesis` | Structured thesis JSON | 21600s | `api/market-digest.js` |
| `risk_regime` | VIX/MOVE/HY payload | 1800s | `api/risk-regime.js` |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s | `api/real-yields.js` |
| `rate_path` | `{USD:{probHold,...}}` | 14400s | `api/rate-path.js` |
| `correlations_v2` | Correlation matrix 20d+60d + gold_correlations | 86400s | `api/correlations.js` |
| `health_last_ok` | HSET: source → last OK ISO | no TTL | `api/admin.js` |
| `sizing_history:{device_id}` | Sorted set sizing calculations | no TTL | `api/sizing-history.js` |
| `journal:{device_id}:{id}` | Full journal entry JSON | no TTL | `api/journal.js` |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL | `api/journal.js` |
| `journal_analysis:{device_id}` | AI performance analysis per device | 3600s | `api/journal.js` |
| `prompt_digest` | Override Groq prompt briefing | no TTL | `api/admin.js` |
| `prompt_bias` | Override Groq prompt CB bias | no TTL | `api/admin.js` |
| `prompt_thesis` | Override Groq prompt thesis | no TTL | `api/admin.js` |
| `push_subs` | HSET push subscriptions | no TTL | `api/subscribe.js` |
| `seen_guids_set` | Redis SET GUID berita (SADD/SMEMBERS, atomic dedup) | 86400s | `api/admin.js` |
| `push_lock` | Distributed lock cron push (SET NX EX 55) | 55s | `api/admin.js` |
| `rl:{endpoint}:{ip}:{window}` | Rate limiter counter | auto 2×window | `api/_ratelimit.js` |
| `fundamental:{currency}` | Hash: indicator → `{actual,period,date,source}` | no TTL (overwrite) | `api/admin.js` + `api/market-digest.js` |
| `fundamental_analysis` | JSON AI analysis currency terkuat/terlemah | 21600s | `api/admin.js` |
| `cb_decisions` | Hash: currency → `{last_meeting,last_decision,last_bps}` dari headline | no TTL | `api/market-digest.js` |
| `circuit:{source}` | JSON: `{state,failures,openUntil,lastFailure,lastSuccess}` — circuit breaker per sumber | 3600s | `api/_circuit_breaker.js` |
| `sizing_rates` | `{rates:{EURUSD,GBPUSD,...}, fetched_at}` — live FX rates untuk pip value cross-pair | 300s | `api/correlations.js` |

**Deprecated (sudah bisa dihapus):** `cot_cache`, `fundamentals_cache`, `seen_guids`

---

## Fungsi JS Kunci

```javascript
setFeedUI(show)             // toggle toolbar + navFilters visibility
hideAllPanels()             // hide semua panel (9 panel termasuk fundamentalPanel)
fetchFeed()                 // fetch /api/feeds?type=rss
fetchRegime()               // fetch /api/risk-regime, update banner
generateRingkasan()         // GET /api/market-digest
jnPrefillFromThesis()       // prefill form jurnal dari AI thesis
szGetDeviceId()             // get/create device ID dari localStorage
ckAutoTick(id, hint)        // auto-centang item checklist
ckAutoBlock(id, hint)       // auto-block item checklist (merah)
ckSwitchPlaybook(id)        // ganti playbook + reset state
ckAutoTickRegimeCheck(pair) // auto-tick rc1-rc4 dari live data
startCountdownTimer()       // mulai interval 30s countdown event CAL
stopCountdownTimer()        // hentikan interval saat keluar tab CAL
renderCountdown()           // hitung + render countdown ke high-impact event terdekat (24h window)
fetchFundamental()          // GET /api/admin?action=fundamental_get
renderFundamental()         // render kartu per currency dari fundData
generateFundamentalAnalysis() // POST /api/admin?action=fundamental_analysis
```

---

## Bug History

- **RINGKASAN "0 berita"** — `market-digest.js` masih memanggil `/api/rss` (sudah dihapus). Fix: update ke `/api/feeds?type=rss` (commit 6f48bcb).
- **Vercel 12-function limit** — 17 fungsi melebihi Vercel Hobby limit. Fix: konsolidasi ke 12 (commit 95db702).
- **`sendTelegram` naming conflict** — saat merge push.js + health.js ke admin.js. Fix: rename ke `sendHealthTelegram` + `sendPushTelegram`.
- **qwen-qwq-32b timeout** — model reasoning overhead melewati Vercel 25s limit. Rollback ke `llama-3.3-70b-versatile`.
- **sw.js FETCH_URL Netlify** — endpoint `/.netlify/functions/rss` mati sejak migrasi ke Vercel. Fix: update ke `/api/feeds?type=rss` (session 2026-04-27).
- **rc4 auto-tick false positive** — `ckAutoTickRegimeCheck` compare `ev.impact !== 'high'` (lowercase) tapi API return `'High'` (kapitalized). Dan `ev.datetime` tidak ada — construct dari `ev.date` + `ev.time_wib`. Fix: session 2026-04-27.
- **convertToWIB UTC offset salah** — ForexFactory XML pakai US/Eastern (EST/EDT), bukan UTC. Comment di code salah. `+7` seharusnya `+12` (EST) atau `+11` (EDT). Semua jam event di tab CAL off ~5 jam. Fix: session 2026-04-27.
- **rate-path heuristic tidak honest** — UI tampilkan probabilitas hold/cut tanpa label bahwa ini bukan market-implied. Fix: tambah label "Estimasi" di session 2026-04-27.
- **GOLD_KEYWORDS terlalu sempit** — banyak XAU driver (Fed, real yield, risk sentiment) tidak di-filter ke gold block. Fix: expand keywords + cap goldItems 25→30 (2026-05-04).
- **USDJPY inconsistent dengan FX lain** — label anomali "USDJPY vs Gold" membingungkan (USDJPY = USD kuat, sedangkan EUR/GBP/AUD = currency kuat). Fix: rename ke JPY + invert 1/close sehingga JPY kuat = naik, konsisten X/USD format (2026-05-04).
- **Korelasi gold hanya muncul saat anomali** — tidak ada tabel tetap XAU vs Silver/Copper/dll. Fix: tambah `gold_correlations` section di API + UI tabel selalu-tampil (2026-05-04).
- **CB meeting metadata bisa stale tanpa peringatan** — `last_meeting` dari CB_FALLBACK tidak diupdate otomatis; trader bisa baca konteks dari meeting 2 bulan lalu. Fix: tambah warning merah di CB card jika `last_meeting > 45 hari` (2026-05-04).
- **Real yield stale indicator tidak visible** — dot kuning 5px tidak terlihat; trader tidak sadar EUR/CAD/CHF inflation expectation >90 hari. Fix: nilai real yield berubah warna kuning + teks `(lama)` + tooltip source + usia hari (2026-05-04). API juga tambah field `inflation_as_of`.
- **CB bias timestamp tanpa tanggal** — `fmtCBTime` hanya tampilkan `HH:MM WIB`; bias kemarin terlihat seperti hari ini. Fix: tampilkan tanggal kalau >12 jam lalu (2026-05-04).
- **Petunjuk SOP stale** — step 2.3 hanya sebut 2 dari 4 playbook; tidak ada langkah korelasi. Fix: update step 2.3 + tambah step 1.5 Cross-Asset Correlations (2026-05-04).
- **AUTO refresh hilang setelah pindah tab** — browser mobile (iOS Safari, Chrome Android) bisa discard tab background → halaman reload → `autoToggle` reset ke off, interval hilang. Fix: simpan state ke `localStorage` + restore di `load` handler + `visibilitychange` listener restart interval saat tab aktif lagi + `pageshow` handler untuk bfcache restore (2026-05-05).
- **Ringkasan XAU/USD kehilangan konteks NY session** — `market-digest.js` hanya pakai 12 jam RSS window. Saat London session, berita NY session sebelumnya (20:00–03:00 WIB) sudah di luar window. Fix: `feeds.js` simpan item RSS ke Redis Sorted Set `news_history` (36h rolling, ZADD NX + ZREMRANGEBYSCORE auto-prune, throttle 5 menit via `news_history_lock` SET NX EX 300). `market-digest.js` baca `ZRANGEBYSCORE` paralel dengan RSS live (hard timeout 3s via Promise.race), merge + dedup by GUID. Gold block di-split jadi `[12 JAM TERAKHIR]` + `[KONTEKS HISTORIS 12-36 JAM LALU]` agar Groq bisa weight berita dengan tepat. Prompt Groq sekarang include nama hari (dayStr) + catatan otomatis Senin pagi untuk konteks volume weekend tipis (2026-05-05).
- **Berita duplikat + jadi 200 saat kembali dari background** — (1) `handleNewItems` selalu append → `allItems` bisa melebar sampai 200 kalau banyak GUID "baru". (2) Tidak ada guard concurrent `fetchFeed()` → `visibilitychange` + `window.load` trigger dua fetch bersamaan. Fix: `fetchFeed` diganti full merge-dedup via `Map<guid, item>` + slice ke 100. `isFetching` flag guard — fetch kedua langsung return. `handleNewItems` dihapus. (2026-05-05).
- **Nitter (@DeItaone) tidak mengirim berita apapun** — semua instance (`nitter.net`, `nitter.privacydev.net`, `nitter.poast.org`) return HTTP 200 body kosong karena X/Twitter memblokir scraping. Fix: hapus seluruh Nitter dari frontend + backend (`fetchNitter`, `parseNitterRSS`, `nitterHandler`, `FETCH_NITTER_URL`, `NITTER_INSTANCES`). Sumber berita sekarang hanya FinancialJuice RSS. (2026-05-05).
- **Push notifikasi duplikat** — dua cron trigger berjalan hampir bersamaan, keduanya baca `seen_guids` sebelum salah satu selesai menulis → kedua instance kirim notif yang sama. Fix: (1) distributed lock `push_lock` (SET NX EX 55) — cron kedua langsung return `Locked`. (2) `seen_guids` JSON array (GET/SET, race-prone) → `seen_guids_set` Redis native SET (SADD/SMEMBERS, atomic per-item). Lock dilepas setelah SADD selesai, sebelum kirim notif. (2026-05-06).
- **Push kategori terlalu sempit** — banyak headline forex/macro/econ-data jatuh ke kategori `news` karena keyword terbatas. Fix: pisahkan keyword ke `api/_push_keywords.js` (prefix `_`, tidak dihitung sebagai serverless function). Diperluas signifikan di semua kategori + hapus keyword false-positive (`record high/low`, `all-time high/low` dari MARKET_MOVING karena mislabel econ-data; `jordan` dari MACRO karena SNB governor sudah ganti ke Schlegel + collision dengan negara Jordan; `trade deficit/surplus` dari GEOPOLITICAL karena GEOPOLITICAL dicek lebih dulu sehingga data rilis salah dapat emoji). (2026-05-06).
- **Push notif flooding saat app dibuka + tidak ada notif saat app ditutup** — 3 bug sekaligus: (1) `seenGuids` di SW tersimpan di memori, hilang saat SW di-restart → saat app dibuka, semua artikel terlihat "baru" → flooding. (2) `checkForNewItems()` tidak cek `visibilityState` → tetap kirim browser notification meski app sedang terbuka & visible. (3) `requestNotif()` silent-catch error push subscription → user lihat toast "Aktif ✓" padahal subscription ke server tidak tersimpan, sehingga server tidak bisa kirim push saat app ditutup. Fix sw.js: `seenGuids` dipersist ke Cache Storage (`daun-merah-state` / `/sw-seen-guids`, max 200 GUID); `checkForNewItems()` cek `hasVisible` via `clients.matchAll` — skip browser notification jika ada client visible; `CHECK_NOW` menerima `guids` dari halaman agar sync sebelum fetch. Fix index.html: `startAutoRefresh()` kirim `guids` dengan `CHECK_NOW`; `requestNotif()` selalu unsubscribe + subscribe ulang agar subscription segar; catch block tampilkan toast "Notifikasi Terbatas ⚠" dengan pesan error spesifik (bukan toast sukses palsu). Fix admin.js: (4) stale subscription HDEL menggunakan key format salah (`base64.slice(80)`) berbeda dengan yang disimpan `subscribe.js` (`sha256(endpoint)`) → stale subs tidak pernah dibersihkan; fix: tambah `subKey()` dengan SHA-256 (sama dengan subscribe.js) + perbaiki loop `HGETALL` dari index `i=1` ke `i=0` agar iterasi benar. (2026-05-12).
- **Tambah tab TEKNIKAL** — Trader butuh reference chart dan catatan bias MTF tanpa buka app terpisah. Fix: tambah tab `TEK` baru (urutan ke-10) dengan: (1) TradingView Advanced Chart embed (pair selector 8 pasang + TF selector D1/H4/H1/M15, load lazy via script `s3.tradingview.com/tv.js`, tema dark, timezone Asia/Jakarta, hide side toolbar); (2) MTF Bias table — 4 timeframe × 3 toggle button (▲ Bull / ▼ Bear / → Neut), klik toggle-off, state tersimpan ke `localStorage` per pair, alignment summary otomatis di bawah (BULLISH/BEARISH/MIXED + hitungan TF); (3) textarea Catatan analisa tersimpan per pair di `localStorage`. Data persisted via `tek_bias_v2` + `tek_notes` keys. Terintegrasi di top nav, bottom nav (icon candlestick), dan swipe navigation. (2026-05-12).
- **UI/UX redesign: TAB CAL + FUNDAMENTAL terasa besar dan tidak empatik** — Layout tidak efisien untuk mobile: CB tracker memakai kartu besar 2×4 grid padahal informasi bisa dipadatkan; event card di CAL padding terlalu longgar; Fundamental menampilkan 8 kartu vertikal tanpa overview sehingga trader harus scroll seluruhnya untuk memahami gambaran besar. Fix: (1) **Fundamental** — tambah `Currency Strength Ranking` strip 4×2 grid di atas cards (sorted strongest→weakest, dengan score bar + badge Bull/Bear/Neut); ubah layout cards dari single column ke 2-column grid; kompres card padding + font size tabel; sembunyikan kolom period pada mobile (tampil di desktop). (2) **CAL CB tracker** — ganti dari card grid ke compact table layout: setiap baris = 1 bank sentral dengan kolom [currency | rate+realrate | decision | bias], tinggi menyusut dari ~80px/card ke ~28px/row. (3) **CAL event cards** — kurangi padding dari 12px → 9px, event name dari 13px → 12px, data row padding dari 7px → 5px, semua font label dikecilkan 1px. (4) hapus responsive overrides CB card lama yang tidak relevan. (2026-05-12).
- **Kualitas output ringkasan jelek** — AI output melanggar aturan prompt: membuka dengan kalimat generik ("Pagi ini..."), menggunakan hedging phrases ("dapat mempengaruhi", "dapat memberikan"), kalender hanya list event tanpa skenario beat/miss, XAUUSD section tidak dipisah secara visual. Root cause: (1) prompt dalam satu user message — instruksi tenggelam di bawah data; (2) max_tokens 1500 terlalu pendek; (3) rendering flat tanpa paragraph break atau pemisahan visual FX vs XAUUSD. Fix: (1) split prompt menjadi `system` message (aturan + frasa terlarang eksplisit + tes kalimat) + `user` message (data saja), temperature turun 0.30→0.25, max_tokens naik 1500→2000; (2) `renderArticleSections()` pisah artikel di marker `XAUUSD:` → dua card terpisah, FX card dengan accent merah, XAUUSD card dengan accent gold (#c9a227) + label `XAUUSD`; (3) `articleToHtml()` konversi `\n\n` ke `<p>` paragraf proper (tidak lagi `white-space: pre-line`). (2026-05-18).
- **Analisa XAU bisa menyesatkan: safe haven vs real yield tidak dihubungkan** — AI mengandalkan headline saja tanpa data numerik real yield, sehingga untuk event geopolitik energi (Iran/Hormuz) bisa langsung menyimpulkan "safe haven dominant" tanpa trace second-order: oil naik → inflasi → Fed hawkish → real yield naik → XAU bearish. Ini kebalikan dari safe haven narrative. Fix: (1) inject data real yield USD live dari Redis `real_yields` ke context Call 1 sebagai blok `DATA REAL YIELD USD (LIVE)` — AI kini punya angka USD 10Y nominal, TIPS breakeven, dan real yield aktual, bukan inferensi dari headline; (2) tambah aturan wajib di prompt: untuk geopolitik melibatkan energi/minyak, AI harus trace DUA rantai kausal (oil→inflation→Fed→real yield naik → bearish vs risk aversion→safe haven→bullish) dan bandingkan magnitude keduanya secara eksplisit sebelum menyimpulkan; (3) jika real yield > 2%, safe haven hanya bisa "dominant" jika ada bukti nyata flight-to-safety, bukan hanya narasi geopolitik. (2026-05-18).
- **market-digest.js Vercel 504 + cb_bias race condition** — timeout AI calls lama (20-25s) bisa menyebabkan total eksekusi melewati 25s Vercel limit → 504 Gateway Timeout pada worst case (semua provider gagal dan retry). Race condition: dua invokasi concurrent bisa GET-merge-SET cb_bias secara overlapping → update dari satu invokasi bisa ditimpa. Fix: (1) perketat semua timeout — Cerebras 20s→8s, SambaNova 20s→8s, Groq fallback Call1 25s→14s / Call2 15s→12s / Call3 15s→12s / Call4 15s→8s; (2) hapus SambaNova retry di Call 3 (menghemat 8s worst case); (3) tambah distributed lock `cb_bias_lock` (SET NX EX 10) — hanya satu invokasi yang bisa write cb_bias dalam satu window 10s, sisanya skip (tidak fail, hanya lewat). (2026-05-18).
- **Checklist terlalu ketat dan generik** — sistem binary gate (jika 1 gagal → NO TRADE) terlalu mekanis untuk trading discretionary; item-item penting seperti CB divergence, real yield, COT, dan session timing tidak otomatis terhubung ke data live yang sudah ada di app. Fix (2026-05-27): (1) **Weighted scoring** — gate sections (3 per playbook, bukan semua) bobot ×2, regular sections bobot ×1; hanya parent items dihitung (sub-items tetap interaktif sebagai guidance); (2) **4 verdict zones** — `—` / `NO TRADE` (<50%) / `PERTIMBANGKAN` (50-74%) / `SIAP TRADE` (75-89%) / `ENTRY` (≥90%) menggantikan binary pass/fail; (3) **Structural simplification** SMC/ICT — `postentry`+`antibias` di-merge jadi `DISIPLIN` (6 items); gates dikurangi dari 9 → 3 (hanya `regime_check`, `gate`, `risk`); (4) **Expanded auto-populate** via `_ckAutoSMC`, `_ckAutoMacro`, `_ckAutoEvent`, `_ckAutoMeanRev` — SMC auto-tick f1/f2/f3/f4b/f6/tm1a/tm1b dari cbData+session; Macro auto-tick mm_cb1/mm_cb2/mm_cb4/mm_co2 dari cbData+realYields+cotData; Event-Driven auto-tick ed_ev1/ed_ev3 dari calData; MeanRev auto-tick mr_ra4 dari regimeData; (5) **stopNote teks** diupdate dari bahasa "STOP" ke guidance kontekstual.
- **Cerebras model `qwen-3-235b-a22b-instruct-2507` deprecated 27 Mei 2026** — Call 1 market briefing gagal setiap request → circuit breaker `ai:cerebras` OPEN → app fallback ke Groq. Fix (2026-05-28): ganti `CEREBRAS_MODEL` ke `qwen-3-32b` (Qwen3 32B — masih aktif di Cerebras free tier, tetap kompatibel dengan prefix `/no_think` di prompt). Circuit breaker self-heal otomatis via OPEN→HALF_OPEN→CLOSED cycle (5 menit).
- **Integrasi checklist → jurnal + cross-device sync + playbook info** (2026-05-27): (1) **Checklist → Jurnal** — tombol "→ Buat Jurnal dari Checklist" muncul di sidebar (desktop) dan di atas section list (mobile) saat skor ≥50%; `ckPrefillJurnal()` mengisi form jurnal dengan: pair dari ck selector, direction dari CB bias (base vs quote hawkish level), dan thesis teks yang merangkum item ✅ checked / ⬜ unchecked per section + metadata playbook+skor+verdict; (2) **Device ID sync** — section "Sinkronisasi Device" di tab PETUNJUK: tampilkan Device ID aktif, tombol COPY (clipboard API, fallback select), dan input "Ganti ke Device ID Lain" dengan validasi `dev_` prefix dan konfirmasi; `ptInitDeviceIdDisplay()` dipanggil saat tab dibuka; (3) **Playbook info ⓘ** — button ⓘ di samping playbook selector; `ckTogglePbInfo()` toggle info box dengan judul + deskripsi per playbook dari `PB_INFO` map (SMC/ICT, Macro Momentum, Event-Driven, Mean Reversion); update otomatis sesuai playbook aktif.

---

## AI Provider Research (2026-05-28) — RESOLVED 2026-06-04

### ✅ Status: Selesai
Call 1 telah di-upgrade ke **SambaNova DeepSeek-V3.2** (akun 2) sebagai primary. Upgrade ini menggantikan pencarian provider yang dimulai setelah Cerebras `qwen-3-235b-a22b-instruct-2507` deprecated 27 Mei 2026.

### State Pipeline Final (Current)
```
Call 1: SambaNova DeepSeek-V3.2 akun 2 (primary)
      → OpenRouter gpt-oss-120b:free (fallback 2, 28s timeout)
      → Groq qwen3-32b (fallback 3, 20s timeout)
      → Template fallback (tidak ada AI)
```
`method` field di response: `sambanova` / `openrouter` / `groq-qwen3` / `fallback`

### Catatan Provider (referensi jika ada masalah di masa depan)

| Provider | Model | Status | Catatan |
|---|---|---|---|
| SambaNova | `DeepSeek-V3.2` | ✅ Primary (sejak 2026-06-04) | Kualitas tinggi, instruction following kuat |
| OpenRouter | `openai/gpt-oss-120b:free` | Fallback 2 | ~19s/400t, kadang timeout 28s |
| Groq | `qwen/qwen3-32b` | Fallback 3 | Rate limit per-model, kadang gagal |
| Groq | `llama-3.3-70b-versatile` | Fallback terakhir | Selalu berhasil, kualitas lebih rendah |

---

## Known Issues (P1-P3, belum difix)

### P1 — Risiko akurasi/keamanan modal
- **Push subscription key collision** — ~~sudah difix 2026-05-12~~ (SHA-256 via `subKey()`).
- **CB rates stale** — `api/cb-status.js` data ECB/BOE/RBA/RBNZ kemungkinan sudah ada meeting baru. Update manual diperlukan setelah setiap meeting. **Last updated 2026-05-05** (semua 8 CB sudah diverifikasi via API + web search).
- **Real yields stale** — `api/real-yields.js` data EUR `as_of` 2026-01-15, sekarang Apr 2026 = ~100 hari. Flag stale lebih visible di UI.

### P2 — Robustness
- **Groq calls error isolation** — Call 1/2/3 sequential. Jika Call 1 timeout, 2 dan 3 skip. Tidak ada partial response handling.
- **Service Worker update flow** — tidak ada skipWaiting dengan client notification, tidak ada cache versioning berfungsi.

### P3 — Polish
- **Checklist state per-pair** — `ckState` shared semua pair. Manual items (rc5, gates teknikal) carry over saat ganti pair.
- **Journal N+1 query** — ZRANGE + GET per-id = 51 Redis roundtrips untuk 50 entries. Gunakan MGET.
- **COT column parsing tidak validated** — kolom 4-9 assumed, tidak ada sanity check.
- **CB rates meeting metadata** — `CB_FALLBACK.last_meeting` perlu update manual setelah setiap meeting; UI sekarang menampilkan warning jika >45 hari, tapi data tetap perlu diisi manual.
- **Real yields inflation expectation** — EUR (as_of 2026-01-15), CAD (2026-01-29), CHF (2025-12-12) sudah >90 hari. UI sekarang menampilkan `(lama)` tapi nilai tidak berubah sampai di-update manual di `api/real-yields.js`.

### Fixed (sudah resolved)
- ✅ P1: `_ratelimit.js` INCR+EXPIRE race → SET NX EX + INCR (2026-04-27)
- ✅ P1: `subscribe.js` base64 slice collision → SHA-256 full hex (2026-04-27)
- ✅ P2: `digest_history` GET-push-SET race → LPUSH/LTRIM atomic (2026-04-27)
- ✅ P2: `feeds.js` rssMemCache module-level var → Redis-only (2026-04-27)
- ✅ P3: `_lastThesis` persist → localStorage (2026-04-27)
- ✅ P3: SOP/Petunjuk stale — step 2.3 sekarang sebut 4 playbook + tambah step 1.5 korelasi (2026-05-04)
- ✅ Informatif: CB meeting stale warning (>45 hari) + real yield stale visible + CB bias timestamp dengan tanggal (2026-05-04)
- ✅ Push duplikat: distributed lock + seen_guids → seen_guids_set (SADD atomic) (2026-05-06)
- ✅ Push kategori: keyword diperluas + false-positive dibersihkan, dipindah ke `api/_push_keywords.js` (2026-05-06)
- ✅ Swipe gesture navigasi tab (touchstart/touchend, threshold 60px horizontal, filter nav/input area) (2026-05-07)
- ✅ Hapus badge sumber "FJ" dari news feed — semua berita dari satu sumber (FinancialJuice), badge tidak informatif (2026-05-07)
- ✅ Countdown Timer tab CAL — kartu countdown + badge '!' di tab header, warning merah <30 menit, interval 30s hanya saat di tab CAL (2026-05-08)
- ✅ Tab FUNDAMENTAL — kartu 2×4 grid per currency, data dari Redis `fundamental:{currency}`, AI analysis Groq 6h cache, tombol manual trigger (2026-05-08)
- ✅ Auto-parse fundamental dari headline RSS — `autoUpdateFundamentals` di `market-digest.js`, regex 3-step: currency prefix → indikator keyword → angka, HSET idempotent (2026-05-08)
- ✅ Auto-detect CB rate decision dari headline — `parseCBDecision`, simpan ke `cb_decisions` Redis, `cb-status.js` override `last_decision/last_bps/last_meeting` dari hardcoded fallback (2026-05-08)
- ✅ Multi-provider AI: Cerebras (Call 1), SambaNova (Call 2–3), Groq (Call 4 + fallback) + Thesis Invalidation Monitor (2026-05-08)
- ✅ XAU/USD ditambahkan ke pair selector JURNAL dan SIZING (2026-05-08)
- ✅ `journal_import` endpoint — bulk import historical trades dengan timestamp asli, auth `x-admin-secret` (2026-05-08)
- ✅ **Self-healing system** — `_circuit_breaker.js` (Redis-backed: CLOSED→OPEN→HALF_OPEN, 3 failures → 5 min pause), `_retry.js` (exponential backoff fetch). Circuit breaker aktif di: `market-digest.js` (Cerebras + SambaNova), `risk-regime.js` (FRED + Stooq). `admin.js` health check kini: auto-clear cache sumber DOWN, Telegram notif saat source recover (2026-05-10)
- ✅ **COT display redesign** — stacked bar (L hijau / S merah = proporsi long:short), label L+value S-value per currency, net + weekly change, AM vs Leveraged group. `fmtAbs` helper inline. `makeRows` sekarang terima 4 param (netKey, changeKey, longKey, shortKey) (2026-05-10)
- ✅ **Fundamental display redesign** — dari 2×4 card grid ke full-width per-currency dengan `<table class="fund-table">` 3 kolom (indicator | value | period). Rate ditampilkan bolder di card header. Layout lebih rapi dan mudah dibaca (2026-05-10)
- ✅ **COT historical storage** — `storeCOTHistory()` di `feeds.js`: fire-and-forget per fetch, lock per reportDate (7d), sorted set `cot_history` rolling 90 hari. Data mulai terkumpul untuk future trend chart (2026-05-10)
- ✅ **Fundamental scoring system** — normalisasi per-currency (bukan absolute cross-currency), `FUND_SCORE_RULES` 20 indikator dengan dir+threshold, `parseIndVal` handles K/% suffix, `scoreInd` returns +1/-1/null. Score = bullish% dari indikator yang terscore. Confidence badge: High(≥7)/Med(≥4)/Low(<4) dari jumlah indikator yang tersedia — CHF dengan 3 indikator tetap bisa score tinggi tapi badge "Low". Value cells berwarna hijau/merah sesuai sinyal per indikator (2026-05-10)
- ✅ **AI Journal Analysis** — tombol "ANALISA AI" di tab JURNAL, memanggil `GET /api/journal?action=analyze`. AI (Groq llama-3.3-70b) analisis semua closed trade: pola menang/kalah, kualitas thesis, kelemahan, rekomendasi konkret. Statistik (win rate, total R, avg R) ditampilkan sebagai stat cards. Cache 1 jam per device. `force=1` untuk refresh. Endpoint digabung ke `journal.js` agar tetap di bawah limit 12 function (2026-05-10)
- ✅ **GOLD_KEYWORDS expansion** — tambah `'iran'` standalone, `'hormuz'`, `'beijing'`, `'china visit'`, `'rare earth'`, `'ofac sanction'`, `'iran oil'` dll. Sebelumnya Iran/Hormuz escalation + Trump-China visit menghasilkan 0 gold matches → AI wajib tulis "sinyal gold tipis". Setelah fix: 12/14 headline relevan match (2026-05-11)
- ✅ P2: cb_bias race condition — distributed lock `SET cb_bias_lock NX EX 10` di `market-digest.js`; semua timeout AI diperketat (Cerebras/SambaNova 8s, Groq fallback 12-14s) mencegah Vercel 504; hapus SambaNova retry Call 3 (2026-05-18)
- ✅ P1: Pip value cross-pair approximation — `calcPipValueUSD` sekarang terima param `rates` (live FX rates dari `sizing_rates` Redis). Cross pairs triangulasi via USD/quote nyata: EUR/JPY → 1000 JPY / USDJPY = USD; GBP/CAD → 10 CAD / USDCAD = USD. Fallback ke approximasi entry price jika rates belum tersedia. Backend: `GET /api/correlations?action=rates` (Yahoo v7/quote, Redis cache 5 menit, stale fallback). Frontend: `fetchSizingRates()` dipanggil di `initSizing()`, localStorage cache 4 jam, error message context-aware (2026-05-18)
- ✅ **Tab CB WATCH** — tab baru antara NEWS dan RINGKASAN (sebelumnya bernama "RISET", diubah karena konten lebih ke pidato + press release). Backend: `GET /api/feeds?type=research`, 6 sumber aktif (FED speeches + FOMC decisions + FEDN analytical notes + ECB press + ECBB blog, semua direct; BIS via rss2json proxy), max 20/sumber total 50, Redis TTL 6h, `?force=1` bypass cache. Frontend: dynamic filter per sumber, badge berwarna, judul clickable + tanggal. (2026-05-19)
- ✅ **Fundamental refresh independen dari digest** — `api/_fundamental_parser.js` (helper, tidak dihitung limit): ekstrak semua parsing logic dari `market-digest.js`. `admin.js` tambah action `fundamental_refresh`: baca 100 headline terbaru dari `news_history` Redis → `autoUpdateFundamentals` tanpa AI call. Tombol refresh di tab FUNDAMENTAL kini panggil `fundamental_refresh` dulu lalu `fundamental_get` — update data dalam detik tanpa perlu trigger full digest. (2026-05-21)
- ✅ **Fundamental scoring: change-based** — `scoreInd` kini terima `prevStr`: jika `previous` ada dan berbeda dari `actual`, scoring = perubahan vs sebelumnya (naik/turun × dir). Fallback ke static threshold jika `previous` belum ada. `IND_DIR` map covers semua known indicators; `guessDir()` infer direction dari keyword untuk dynamic indicators (unemploy→-1, employ/gdp/pmi/confidence→+1 dll). Backend `autoUpdateFundamentals` kini HMGET existing sebelum HSET — simpan `previous` di JSON jika nilai berubah. UI tabel: tampilkan arrow ↑↓ + nilai sebelumnya (`prev X`) di cell nilai. (2026-05-21)
- ✅ **Fundamental parser overhaul** — fix bug: `'australian unemploy'` tidak match "Australian Unemployment" (huruf "n" blocking substring) + CHF sama sekali tidak punya `'switzerland unemploy'`/`'swiss unemploy'`. Solusi: (1) expand `FUND_PREFIX_MAP` dengan adjective forms lengkap (australia→australian, japan→japanese, dll) untuk semua 8 currency; (2) tambah `COUNTRY_STRIP` map untuk dynamic indicator extraction — sekarang ANY rilis ekonomi FJ yang menyebut country/adjective + bernilai angka otomatis tercapture, bukan hanya indikator hardcoded; (3) value extraction prioritas "Actual X%" format FJ; (4) expand `FUND_INDICATOR_MAP` dengan 9 indikator baru (Composite PMI, Current Account, Wage Growth, Building Approvals, Consumer/Business Confidence, dll); (5) `FUND_SCORE_RULES` ditambah 12 rule baru. CHF seed ditambah `Unemployment Rate`. (2026-05-21)
- ✅ **Sizing Calculator overhaul** (2026-05-27): (1) **XAU/USD pip value bug** — diperbaiki: kode sebelumnya return $10/lot (10× salah, pakai forex formula). Fix: special case `XAU/USD` = 0.01 × 100 = $1/lot (100 oz/lot, 1 pip = $0.01); (2) **Dual SL mode** — toggle PIPS/HARGA: mode HARGA input entry + SL price → auto-compute stopPips dengan live pip size hint, mode PIPS seperti sebelumnya; (3) **Direction selector** — toggle LONG/SHORT (visual green/red), mempengaruhi arah harga di R-table dan SL/TP price; (4) **R-table harga** — kolom harga ditambah ke R-table jika entry diisi; baris SL dan TP (sesuai R:R) di-highlight dengan warna; (5) **R:R input** — field Target R:R (default 2), auto-hitung TP price + tampilkan di result; (6) **Pip size label** — info `1 pip = X · pip value = $Y/lot` update dinamis per pair + setelah hitung; (7) **Soft risk warning** — >2% warning kuning (tapi tetap hitung), >5% hard block merah; (8) **Sizing → Jurnal bridge** — tombol `→ BUAT TRADE DI JURNAL` di bawah hasil, `szPrefillJurnal()` switch ke tab jurnal + prefill pair/direction/entry/SL/TP/lots; simpan ke `window._lastSizing`.
- ✅ **Journal improvements** (2026-05-27): (1) **Harga di card** — entry/SL/TP/lots ditampilkan per card dalam satu baris compact (hanya field non-null); (2) **Auto-hitung R actual** — `jnStartClose(id)` lookup entry dari `jnAllEntries`, tampilkan referensi Entry/SL/TP di close form, `jnAutoComputeR()` via `oninput` pada Exit Price: R = dir × (exit − entry) / |entry − stop|; trader bisa override manual; (3) **Clear fields setelah save** — `jnSave()` clear semua field setelah berhasil (entry, stop, target, lots, thesis); (4) **showToast** — semua `alert()` di jurnal diganti `showToast()`; (5) **Expand thesis** — teks >120 char ditampilkan truncated + tombol "lihat semua" yang lookup dari `jnAllEntries` (tanpa passing teks di onclick attribute); (6) **ckPrefillJurnal enhancement** — setelah prefill dari checklist, cek `window._lastSizing` — jika pair cocok, prefill lots/entry/SL/TP dari hasil sizing terakhir.
- ✅ **MT5 Bridge auto-start saat Windows login** (2026-06-01) — `start_bridge.bat`: double-click untuk jalankan manual. `start_bridge_min.vbs`: wrapper yang jalankan .bat dalam kondisi minimized. Shortcut VBS ditaruh di `C:\Users\sam\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\DaunMerah-MT5Bridge.lnk` → bridge otomatis jalan di background setiap Windows login, tanpa perlu buka terminal. Untuk nonaktifkan auto-start: hapus shortcut di folder Startup. Bridge tidak bisa di-host di server (Hugging Face dll) karena `MetaTrader5` Python library Windows-only dan berkomunikasi langsung dengan MT5 terminal via IPC.
- ✅ **Checklist keyboard focus via mouse click** (2026-05-31) — klik item checklist dengan mouse tidak mengupdate `ckFocusIdx`, sehingga `Enter` tetap kena item pertama (atas). Fix: event delegation `document.click` → `.closest('#checklistPanel .ck-item, #checklistPanel .ck-sub')` → set `ckFocusIdx` + toggle `.ck-focused` ke item yang diklik. Sekarang bisa klik item mana saja di posisi mana saja, tekan `Enter` = centang item tersebut. Juga fix bug minor `ckNavClearFocus` yang hanya bersihkan `.ck-item.ck-focused` (tidak `.ck-sub.ck-focused`).
- ✅ **Panel kosong: Dashboard, Checklist, TEK, COT, Fundamental, Petunjuk** (2026-06-02) — Root cause: saat menambahkan fitur Export CSV di tab Jurnal, inner `<div>` ganda membuat tag penutup `</div>` untuk `jnListView` "terpakai" sebagai penutup inner div, sehingga `jurnalPanel` tidak pernah ditutup di DOM. Akibatnya semua panel setelah Jurnal (petunjuk, teknikal, dashboard, COT, fundamental, checklist) menjadi child dari `jurnalPanel`. `hideAllPanels()` menyembunyikan `jurnalPanel` → semua child ikut tersembunyi → layar hitam di Dashboard/Checklist/TEK. Fix: hapus inner `<div style="display:flex;gap:6px;margin-bottom:12px">` yang duplikat, sehingga `</div>` yang ada cukup untuk menutup `jnListView` dan `jurnalPanel` dalam urutan yang benar.

---

## Constraint Absolut

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. **Vercel Hobby: TEPAT 12 serverless functions** — files dengan prefix `_` tidak dihitung
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport, bottom nav di ≤767px
9. Indonesian UI text, English code/comments/variables

---

## CB Rates (Fallback Hardcoded — Live Scrape Mengoverride Otomatis)

File: `api/_cb_rates.js`, object `CB_FALLBACK` (di-`require` oleh `api/cb-status.js` dan `api/admin.js` `fundamentalGetHandler` — lihat Session 40).

`rate` di tabel ini cuma fallback kalau scrape live gagal — angka aktual yang ditampilkan ke user (tab CB Bias *dan* tab FUNDAMENTAL) selalu dari `getLiveCbRates()`, scrape 8 official source dengan Redis cache 6h. `last_meeting`/`last_decision`/`last_bps` tetap perlu update manual karena scraper cuma ambil angka rate, bukan metadata meeting.

| CB | Rate (fallback) | Last Meeting | Decision |
|----|------|-------------|----------|
| Fed | 3.75% | 2026-04-29 | hold |
| ECB | 2.15% | 2026-04-30 | hold |
| BOE | 3.75% | 2026-04-30 | hold |
| BOJ | 0.75% | 2026-04-28 | hold |
| BOC | 2.25% | 2026-04-29 | hold |
| RBA | 4.35% | 2026-05-06 | hike +25bps |
| RBNZ | 2.25% | 2026-04-09 | hold |
| SNB | 0.00% | 2026-03-19 | hold |

> **Last verified:** 2026-05-05. Semua rate dikonfirmasi via official APIs (FRED, ECB API, BoC Valet) + web search.
> **2026-06-23:** ECB fallback (2.15%) sudah ketinggalan — live scrape sudah balik 2.40% (hike 2026-06-17) dan ini yang ditampilkan ke user. Fallback constant di atas dibiarkan beda sengaja sebagai bukti `rate_stale` flag bekerja; update manual fallback ini kapan pun sempat, tidak urgent karena user-facing value sudah benar via live scrape.

---

## FOMC Dates Hardcoded

File: `api/rate-path.js`

2026: May 7, Jun 18, Jul 30, Sep 17, Nov 5, Dec 17
2027: Jan 28, Mar 18 (estimasi — belum dipublikasi Fed, diberi label sebagai estimate)

---

## Inflation Expectations Hardcoded (Update Quarterly)

File: `api/real-yields.js`, object `INFLATION_EXPECTATIONS`

Source: ECB SPF, BoE IAS, BoJ Tankan — cek `as_of` field, update jika > 90 hari.
Updated session 45: EUR→ECB SPF Q2 (Apr 2026), CAD→BoC MPR Apr, AUD→RBA SoMP May, NZD→RBNZ MPS May, CHF→SNB Mar, JPY→Tankan Q1 Mar 28. GBP tetap Feb (IAS Q2 belum publish).

---

## Environment

```
Stack:  Vanilla JS + HTML, Vercel Serverless Functions (Node.js CommonJS), Upstash Redis REST
AI:     Groq llama-3.3-70b-versatile (max 25s Vercel timeout)
Font:   Syne (heading) + DM Mono (body)
Colors: --accent: #c0392b (red), --pink: #f472b6 (jurnal), #60a5fa (petunjuk)
Redis:  Upstash REST — pattern: async function redisCmd(...args) di setiap api/*.js
Env:    GROQ_API_KEY, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
        FRED_API_KEY, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT,
        TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, CRON_SECRET
```

---

## Research: Free AI Inference API Providers (2026-05-28)

> Context: Production app Vercel serverless, butuh OpenAI-compatible endpoint, use case = generate Indonesian FX briefing ~2000 tokens output. Butuh model yang patuh instruksi kompleks Bahasa Indonesia.
> Benchmark pembanding: **Qwen3-235B-A22B-Instruct** (235B MoE, 22B aktif, top-tier instruction following).

### Tier 1 — Sangat Layak Produksi (Model Besar + Truly Free)

| Provider | Model ID (exact) | Model Size | Context | Max Output | Rate Limit Free | OpenAI-compat | Qwen3-235B? | Catatan |
|----------|-----------------|-----------|---------|------------|-----------------|---------------|-------------|---------|
| **OpenRouter** | `qwen/qwen3-235b-a22b:free` | 235B MoE | 131K | 8,192 | 20 RPM / 200 RPD | Ya (`openrouter.ai/api/v1`) | **Ya** | Model ID lain: `qwen/qwen3-235b-a22b-07-25:free` (262K ctx). Tambah $10 kredit → unlock 1,000 RPD. Rate limit shared antar semua free models. |
| **OpenRouter** | `meta-llama/llama-4-maverick:free` | 17B×128E MoE | 1M | — | 20 RPM / 200 RPD | Ya | Tidak | Top model OpenRouter per May 2026. Instruction following sangat kuat. |
| **OpenRouter** | `deepseek/deepseek-r1:free` | ~671B MoE | 200K | — | 20 RPM / 200 RPD | Ya | Tidak | Reasoning model, output verbose, bisa terlalu panjang untuk briefing. |
| **OpenRouter** | `openai/gpt-oss-120b:free` | 120B | — | — | 20 RPM / 200 RPD | Ya | Tidak | OpenAI open-source 120B, mulai replace Llama 4 Maverick di beberapa slot. |
| **Cerebras** | `qwen-3-235b-instruct` | 235B MoE | 64K (free) / 131K (paid) | — | 30 RPM / ~60K-100K TPM / 1M TPD | Ya (`inference.cerebras.ai/v1`) | **Ya** | Tercepat: ~1,400 tok/s. Truly free, no credit card. **Rekomendasi utama untuk upgrade Call 1.** Context cap 64K di free tier. |
| **Cerebras** | `qwen-3-32b` | 32B | 128K | — | 30 RPM / 1M TPD | Ya | Partial (32B) | Ini yang sudah dipakai app saat ini (post-deprecation fix 2026-05-28). |
| **SambaNova** | `Meta-Llama-3.1-405B-Instruct` | 405B | 128K | — | 10 RPM | Ya (`cloud.sambanova.ai/api`) | Tidak | Truly free (persistent, bukan credit). Llama 405B = model terbesar di free tier mana pun. 129 tok/s di SambaNova hardware RDU. |
| **SambaNova** | `Qwen2.5-72B-Instruct` | 72B | 128K | — | ~20 RPM | Ya | Tidak (Qwen 2.5, bukan 3) | Tersedia di free tier SambaNova. Qwen 2.5 generasi sebelumnya. |
| **Google AI Studio** | `gemini-2.5-flash` | — (proprietary) | 1M | 65,535 | 10 RPM / 500 RPD / 1M TPM | Ya (`generativelanguage.googleapis.com/v1beta/openai/`) | Tidak | Terbaik untuk output panjang (65K max output). Generous context 1M. Data digunakan untuk training di free tier. |
| **Google AI Studio** | `gemini-2.5-flash-lite` | — | 1M | — | 15 RPM / 1,000 RPD | Ya | Tidak | Lebih murah/cepat dari Flash tapi lebih lemah reasoning. |

### Tier 2 — Layak Tapi Ada Keterbatasan

| Provider | Model ID (exact) | Model Size | Context | Rate Limit Free | OpenAI-compat | Catatan |
|----------|-----------------|-----------|---------|-----------------|---------------|---------|
| **Groq** | `qwen/qwen3-32b` | 32B | 128K | 30 RPM / 6K TPM / 1K RPD | Ya (`api.groq.com/openai/v1`) | Qwen3-235B tidak tersedia di Groq. TPM 6K = bottleneck untuk ~2000 token output (hanya 3 req/menit efektif). Llama 4 Maverick deprecated 20 Feb 2026 → diganti `openai/gpt-oss-120b`. |
| **Groq** | `meta-llama/llama-4-scout-17b-16e-instruct` | 17B×16E MoE | 128K | 30 RPM / 30K TPM / 1K RPD | Ya | TPM lebih tinggi (30K vs 6K). Kecil tapi cepat. |
| **Groq** | `llama-3.3-70b-versatile` | 70B | 128K | 30 RPM / 6K TPM / 1K RPD | Ya | Sudah dipakai di app (Call 2,3,4 + fallback). |
| **Nvidia NIM** | `qwen/qwen3-235b-a22b` | 235B MoE | — | 40 RPM / 1,000 req total (credits) | Ya (`integrate.api.nvidia.com/v1`) | **Bukan truly free** — 1,000 inference credits saat signup (habis). Tidak sustainable untuk production. Bagus untuk testing/benchmarking. |
| **Mistral (La Plateforme)** | `mistral-large-latest` | ~123B | 128K | **2 RPM** / 1B TPM | Ya (`api.mistral.ai/v1`) | Free tier "Experiment" tanpa kartu kredit. RPM sangat rendah (2 RPM) = tidak viable produksi. Tapi 1B token/bulan jika RPM tidak jadi masalah. |
| **Mistral (La Plateforme)** | `mistral-medium-latest` | — | 128K | 2 RPM | Ya | Sama, instruksi following lebih lemah dari Large. |

### Tier 3 — Tidak Cocok untuk Use Case Ini

| Provider | Status Free Tier | Masalah | Qwen3-235B? |
|----------|-----------------|---------|-------------|
| **Together AI** | **Tidak ada sama sekali (per Session 146, 2026-07-07)** — $25 signup credit lama sudah diretired Juli 2025; docs resmi sekarang: no free trial, wajib prepay minimum $5. | Full pay-per-use dari awal, tidak ada jalur gratis apapun tanpa kartu. Qwen3-235B *dan* Qwen3.7-Max tersedia tapi berbayar penuh. | Ya (berbayar) |
| **Fireworks AI** | **Cuma $1 signup credit sekali pakai** (bukan RPM gratis permanen) — 10 RPM cap berlaku selama kartu belum ditambahkan, tapi begitu $1 kredit habis wajib kartu untuk lanjut. | Bukan persistent free — $1 kredit habis dalam hitungan request untuk model besar. Qwen3.6 Plus & Qwen3.7 Max ada di sini tapi berbayar. | Ya (berbayar) |
| **DeepInfra** | **Tidak ada** — wajib kartu/prepay dari signup pertama. `DeepStart` (1B token gratis) cuma untuk startup via aplikasi manual, bukan self-serve instant. | Pay-per-use termurah di pasaran (Qwen3.5-397B-A17B $0.54/$3.40 per 1M) tapi tetap bukan gratis. | Tidak dikonfirmasi (fokus Qwen3.5/3.6, bukan Max) |
| **Anyscale** | **Tidak ada API self-serve sama sekali** — "Anyscale Endpoints" (dulu $0.10-$0.50/1M token, model lama daun_merah pernah cek ini) **dimatikan total 1 Agustus 2024**. Yang tersisa cuma "Anyscale Platform" — Ray compute enterprise, kontrak tahunan lewat sales, bukan API instant-signup. | Bukan LLM inference marketplace lagi sejak 2024 — dashboard yang kelihatan di akun `daunmerah` kemungkinan besar cuma trial/compute platform, bukan API key untuk model serverless. | Tidak relevan (bukan LLM API lagi) |
| **Novita AI** | $0.50 trial credit (habis) | Credit model bukan persistent free. Cocok untuk image gen + LLM combo, bukan produksi. | Tidak dikonfirmasi |
| **Hugging Face Inference API** | ~1,000 req/hari, ~50 req/jam | Cold start 30+ detik untuk model besar. 70B+ model sangat terbatas di free tier. Bukan untuk latency-sensitive produksi. | Tidak (70B+ restricted) |
| **Cloudflare Workers AI** | 10,000 Neurons/hari | 70B model konsumsi banyak neurons → effective limit sangat rendah. 8B model cocok, 70B+ tidak viable free tier. | Tidak |

**Kesimpulan Session 146 lanjutan:** dari 4 provider yang dicek user (Together AI, Fireworks AI, DeepInfra, Anyscale), **tidak satupun** yang punya tier gratis persisten setara Cerebras/OpenRouter/SambaNova/Groq/Gemini AI Studio (lihat Tier 1 di atas) — semuanya credit-trial (habis sekali pakai) atau wajib-kartu dari awal, dan Anyscale malah bukan self-serve API lagi sejak 2024. Tidak ada perubahan kode; rekomendasi Tier 1 tetap berlaku.

**Provider Links (base URL OpenAI-compatible, untuk referensi kalau expand provider):**
```
Together AI:  https://api.together.xyz/v1        (docs: docs.together.ai)
Fireworks AI: https://api.fireworks.ai/inference/v1  (docs: docs.fireworks.ai)
DeepInfra:    https://api.deepinfra.com/v1/openai    (docs: deepinfra.com/docs)
Anyscale:     — (self-serve API mati sejak 2024, sekarang enterprise-only via sales)
```

### Ringkasan Rekomendasi untuk Daun Merah

**Strategi terbaik (multi-provider failover):**

1. **Call 1 (Market Briefing)** — Tetap Cerebras `qwen-3-32b` sebagai primary (sudah dipakai). Upgrade kandidat: `qwen-3-235b-instruct` di Cerebras (235B, 1,400 tok/s, sama-sama free) jika ingin lebih baik. Context cap 64K cukup untuk briefing.

2. **Fallback Call 1** — OpenRouter `qwen/qwen3-235b-a22b:free` sebagai fallback sekunder. Context 131K, rate 20 RPM / 200 RPD. Max output 8K cukup untuk briefing 2K token.

3. **Alternative besar** — SambaNova `Meta-Llama-3.1-405B-Instruct` (405B! truly free, 10 RPM). Llama 405B terbukti sangat patuh instruksi kompleks + multilingual.

4. **Paling generous output** — Google Gemini 2.5 Flash (`gemini-2.5-flash`): max output 65K token (vs 8K OpenRouter), context 1M, base_url swap mudah. Tapi data dipakai training Google.

**Perbandingan langsung Qwen3-235B di berbagai provider:**

| Provider | Model ID | Gratis? | Speed | Context Free | Max Output |
|----------|---------|---------|-------|-------------|------------|
| Cerebras | `qwen-3-235b-instruct` | Ya (persistent) | ~1,400 tok/s | 64K | — |
| OpenRouter | `qwen/qwen3-235b-a22b:free` | Ya (persistent) | Medium | 131K | 8,192 |
| OpenRouter | `qwen/qwen3-235b-a22b-07-25:free` | Ya (persistent) | Medium | 262K | — |
| Nvidia NIM | `qwen/qwen3-235b-a22b` | Credits only | Fast | — | — |
| Together AI | `Qwen/Qwen3-235B-A22B-fp8-tput` | Tidak (berbayar) | Fast | 256K | — |
| Fireworks AI | `accounts/fireworks/models/qwen3-235b-a22b` | Tidak (berbayar) | Fast | — | — |

**Env var yang perlu ditambahkan jika expand provider:**
- `CEREBRAS_API_KEY` — sudah ada
- `OPENROUTER_API_KEY` — belum ada (gratis signup)
- `SAMBANOVA_API_KEY` — sudah ada
- `GEMINI_API_KEY` — belum ada (gratis di ai.google.dev)

**Base URLs:**
```
Cerebras:    https://inference.cerebras.ai/v1
OpenRouter:  https://openrouter.ai/api/v1
SambaNova:   https://cloud.sambanova.ai/api/v1
Gemini OAI:  https://generativelanguage.googleapis.com/v1beta/openai/
Groq:        https://api.groq.com/openai/v1
Nvidia NIM:  https://integrate.api.nvidia.com/v1
Mistral:     https://api.mistral.ai/v1
```

### Update 2026-07-11 — Scan Provider Baru (Cerebras/SambaNova-like)

> Konteks: user minta cari cloud inference AI baru selain yang sudah dinilai di atas. Kriteria sama seperti riset awal: truly free persisten (bukan credit trial), tanpa kartu kredit, OpenAI-compatible, model cukup besar/mumpuni, rate limit viable produksi (bukan 2 RPM ala Mistral).

| Provider | Model Terbesar Gratis | Rate Limit Free | OpenAI-compat | Verdict |
|----------|----------------------|------------------|----------------|---------|
| **Vercel AI Gateway** | Ratusan model (routing ke OpenAI/Anthropic/Gemini/Mistral/xAI/dst) | $5 kredit/bulan (refresh otomatis), pass-through harga provider asli (bukan diskon) | Ya (`ai-gateway.vercel.sh` — AI SDK, OpenAI Chat Completions, Anthropic Messages) | **Menarik karena app sudah di Vercel** — base URL swap doang, tanpa perlu banyak API key. Tapi $5/bulan pass-through ke harga asli provider = tidak lebih murah dari pakai Groq/Cerebras langsung yang $0. Nilai utamanya: auto-failover antar provider built-in, bisa gantikan logic fallback manual di kode. **Worth dicoba sebagai layer routing**, bukan sebagai sumber token gratis tambahan. |
| **GitHub Models** | `Meta-Llama-3.1-405B-Instruct` | Tier gratis: ~50 RPD / 10 RPM untuk model besar (naik kalau akun ada histori GitHub Copilot) | Ya (`models.github.ai/inference`) | **Tidak viable produksi** — 50 RPD terlalu rendah untuk cron/briefing rutin, sama seperti alasan Mistral direject. |
| **Cohere** | Command R+ | 20 RPM tapi cuma 1.000 call/bulan, **trial key eksplisit dilarang dipakai produksi/komersial** di ToS | Tidak native (custom SDK, meski ada wrapper OpenAI-compat pihak ketiga) | **Reject** — dilarang untuk use case produksi oleh ToS sendiri, bukan cuma soal limit. |
| **SiliconFlow** | Hanya model kecil yang gratis permanen: `Qwen3-8B`, `DeepSeek-R1-Distill-Qwen-7B` (model besar seperti DeepSeek-V3/R1 penuh = berbayar) | 100 request/hari untuk model gratis | Ya (`api.siliconflow.com/v1`) | **Reject untuk Call 1** — model gratis terlalu kecil (8B) dibanding Qwen3-235B yang jadi benchmark. Bisa dipertimbangkan kalau butuh model kecil murah untuk tugas ringan (bukan briefing utama). |
| **Zhipu AI / GLM (Z AI)** | GLM-4.5-Flash / GLM-4.7-Flash, 128-200K context | Gratis tanpa kartu, **tapi cuma 1 concurrent request** (sequential only) | Ya (`open.bigmodel.cn/api/paas/v4`) | **Reject** — signup butuh nomor telepon China, jadi blocker duluan sebelum sempat nilai rate limit. |
| **Kluster.ai** | Klaim host DeepSeek-R1, Qwen3-235B | **Rate limit tidak dipublikasikan** — tidak ketemu angka pasti dari dokumentasi maupun review pihak ketiga | Ya (klaim OpenAI-compat) | **Undetermined** — perlu signup manual buat cek limit aktual sebelum bisa dinilai. Tidak direkomendasikan tanpa verifikasi langsung. |
| **LLM7.io** | DeepSeek R1, Qwen2.5 Coder | 15 RPM (30 RPM dengan token gratis tambahan) | Ya | Kandidat tambahan tier 2 (mirip Groq TPM-limited) — belum diverifikasi langsung, tapi tidak masuk kategori "reject" otomatis. Prioritas rendah, provider kecil/kurang dikenal. |
| **Pollinations AI** | `openai-large` (text) | Tanpa signup, tapi rate limit per-IP **tidak terdokumentasi** dan berpotensi shared/exhausted karena IP Vercel serverless sering shared range | Ya (`gen.pollinations.ai/v1`, ada wrapper text/audio/image) | **Reject untuk produksi** — reliabilitas dan kualitas model tidak jelas, rate limit per-IP berisiko besar di lingkungan serverless (IP bisa dipakai bareng tenant lain). |
| **NVIDIA NIM, ModelScope, AnyAPI** | — | — | Variatif (ModelScope tidak OpenAI-compat) | Tidak menambah value dibanding provider yang sudah masuk Tier 1 (NVIDIA NIM sudah dinilai credit-only; AnyAPI cuma agregator dengan limit setara OpenRouter yang sudah dipakai). |

**Kesimpulan:** tidak ada provider baru yang mengalahkan kombinasi Tier 1 yang sudah ada (Cerebras, OpenRouter, SambaNova, Google AI Studio, Groq). Satu-satunya temuan yang benar-benar berguna adalah **Vercel AI Gateway** sebagai potensi *routing layer* (bukan sumber token gratis) karena app sudah native di Vercel — bisa menyederhanakan kode fallback multi-provider jadi satu base URL, tapi butuh keputusan terpisah apakah worth trade-off (harga pass-through penuh vs $0 di provider free tier langsung). Tidak ada perubahan kode dari riset ini.

---

## Backlog — Data Source Upgrades

✅ Semua item di backlog asli ini sudah selesai — detail lengkap (root cause, implementasi, symbol mapping CME CVOL, status per endpoint) ada di entry changelog masing-masing: **Session 44-46** (GDPNow, TGA/Fed Balance Sheet, Cleveland Fed Inflation Nowcast, CME FedWatch fix, Portfolio VaR, FX Risk Reversals) dan **Session 47** (ScraperAPI Proxy + CME CVOL endpoint baru, 6 pair live).

---
