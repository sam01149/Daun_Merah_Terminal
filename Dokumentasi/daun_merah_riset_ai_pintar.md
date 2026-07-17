# Riset: Membuat AI Analisa "Lebih Pintar Baca Pasar" — Peta Jalan Sampai Mentok

> Ditulis session 166 (2026-07-14) atas permintaan user: "cari tau lagi potensi yang bisa
> bikin AI pintar lagi sampai mentok". Dokumen keputusan/rujukan — bukan plan eksekusi.
> Kalau salah satu tier mau dikerjakan, buat plan terpisah di `daun_merah_plan.md`.

## Batas fundamental yang tidak bisa ditembus (baca dulu)

1. **LLM (DeepSeek-V3.2 dkk) adalah model bahasa, bukan model prediksi harga.** Dia pintar
   mengaitkan dan menarasikan angka yang DIBERIKAN, tapi tidak pernah belajar dari histori
   pergerakan harga sungguhan. Ganti model sekuat apapun tidak mengubah sifat ini.
2. **Market itu probabilistik.** Sinyal apapun (AI atau analis manusia) pasti salah sebagian
   waktu. Target yang realistis: edge kecil yang konsisten + risk management ketat (sudah
   ada di app: sizing, checklist, RR gate) — bukan "tidak pernah keliru".
3. **Referensi historis proyek ini sendiri:** riset NFP causal (Fase 1, session 153) gagal
   0/25 — bukti internal bahwa "menebak arah dari data publik" itu memang sulit. Jangan
   ulangi ekspektasi yang sama di fitur Analisa.

Dengan plafon itu, di bawah ini yang MASIH BISA diusahakan, diurutkan dari ROI tertinggi.

## Tier 1 — Track record / outcome logging (ROI paling tinggi, belum ada sama sekali)

**Masalah:** setiap hasil Analisa AI hilang begitu saja. Tidak ada yang tahu — termasuk kita —
apakah rekomendasinya lebih sering benar atau salah. Label "keyakinan tinggi" murni
self-assessment LLM tanpa dasar historis.

**Yang dibangun:**
- Setiap `ohlcv_analyze` yang menghasilkan setup lengkap (entry/sl/tp) → tulis snapshot ke
  Redis list/stream: `{symbol, bias, entry, sl, tp, rr, confluence_score, ts}`.
- Cron harian (GitHub Actions, tanpa AI call — murni baca harga Yahoo yang sudah di-sync)
  mengecek tiap setup terbuka: harga menyentuh TP duluan, SL duluan, atau expired
  (lewat `time_horizon_days` tanpa kena keduanya).
- Agregasi win-rate per pair / per bias / per skor konfluensi → tampilkan di UI.

**Biaya:** 0 AI call tambahan. Hanya storage Redis kecil + 1 cron ringan.
**Hasil:** angka akurasi NYATA ("dari 100 saran XAU/USD, 54 kena TP") — fondasi semua tier lain.

## Tier 2 — Kalibrasi keyakinan & gate kualitas

Bergantung pada Tier 1 (butuh data outcome).
- Badge keyakinan diikat ke win-rate historis segmen serupa (pair + bias + rentang skor
  konfluensi), bukan klaim LLM.
- Gate: sembunyikan setup kalau skor konfluensi < ambang ATAU RR < 1.5 (sekarang baru RR ≥ 1
  di sanity-check server) — `entry_zone: null` + alasan, lebih jujur daripada setup lemah.
- Kalau win-rate segmen tertentu terbukti < ~45% dalam jangka panjang → tampilkan peringatan
  eksplisit di UI untuk segmen itu (atau matikan setup otomatisnya).

**Biaya:** 0 AI call tambahan.

## Tier 3 — Backtest zona konfluensi (bisa jalan duluan, offline)

Data 6 bulan Daily + 10 hari 4H + 5 hari 1H per pair sudah ada di Redis (`ohlcv_sync`).
- Replay historis: untuk tiap titik waktu t di masa lalu, hitung `_confluenceZones` dari data
  sampai t, lalu ukur: seberapa sering harga BEREAKSI (memantul/menembus lalu retest) di zona
  skor tinggi vs level acak?
- Murni komputasi lokal / script Node — **0 AI call, 0 biaya**, bisa dites di test runner.
- Hasilnya memvalidasi (atau membantah) asumsi inti fitur Analisa: "konfluensi = area reaksi".
  Kalau terbukti tidak prediktif, semua tier lain perlu dipikir ulang — makanya ini layak
  dikerjakan awal.

### HASIL (dijalankan via `scripts/backtest_confluence.js`)

**Run 2026-07-17** (4 pair, 60 hari 1H, 177 titik evaluasi, jendela sentuh 48 jam,
jendela reaksi 12 jam, ambang gerak 0.3x ATR Daily):

| Bucket | Zona | Tersentuh | Bounce | Break | Chop |
|---|---|---|---|---|---|
| Skor TINGGI (≥3) | 927 | 376 (41%) | **55%** | 22% | 24% |
| Skor RENDAH (≤1.5) | 30 | 7 (23%) | 57% | 29% | 14% |

Per pair (bounce-rate zona tinggi): XAU/USD 59% (91 sentuh), EUR/USD 59% (95),
USD/JPY 53% (86), GBP/USD 47% (104).

**Interpretasi jujur:**
1. **Yang valid:** di zona skor tinggi, bounce (55%) mengalahkan break (22%) ~2.5:1 —
   zona konfluensi memang lebih sering jadi area pantulan daripada tembusan. Asumsi
   "konfluensi = area reaksi" DIDUKUNG dalam arti ini.
2. **Yang TIDAK bisa diklaim:** perbandingan "skor tinggi vs rendah" tidak konklusif —
   kontrol skor rendah cuma 30 zona / 7 sentuhan (ranking top-3 by skor memang jarang
   meloloskan zona lemah, cacat desain kontrol). Klaim changelog session 167 ("68% vs
   50%, sangat positif") berasal dari run jendela sebelumnya dan TERLALU OPTIMIS —
   angka run terbaru lebih rendah (55%) dan kontrolnya terlalu kecil untuk dibandingkan.
3. **Catatan GBP/USD** paling lemah (47%) — kalau nanti track record live (Tier 1)
   juga konsisten lemah di pair ini, pertimbangkan peringatan khusus di UI.
4. **Angka bergerak antar-run** karena jendela 60 hari bergeser — jangan kutip satu
   angka sebagai konstanta; jalankan ulang berkala (gratis) dan bandingkan tren.

## Tier 4 — Ensemble / cross-check dua model (selektif, bukan tiap request)

- Jalankan model kedua (mis. Cerebras gpt-oss-120b yang sudah terpasang sebagai fallback)
  HANYA saat momen penting (menjelang entry riil, bukan tiap klik).
- Sepakat (bias & zona sama) → sinyal lebih kuat; beda jauh → pasar ambigu, itu sendiri
  informasi ("jangan entry").
- **Biaya:** +1 AI call per pemakaian — jadikan tombol manual terpisah ("second opinion"),
  bukan otomatis, supaya hemat kuota.

## Tier 5 — Data baru yang benar-benar menambah informasi (marginal, paling akhir)

Sudah dipakai: OHLCV multi-TF, indikator, struktur/swing/BOS, S/R cluster, fib, pivot,
option expiry, CB bias, COT, risk regime, retail sentiment, options RR/CVOL, konteks makro
artikel. Yang tersisa dan realistis gratis:
- **Seasonality bulanan/mingguan** per pair (hitung sendiri dari data Daily historis — offline).
- **Volatility regime** (percentile ATR vs 6 bulan) sebagai konteks "market lagi tenang/liar".
- **Posisi harga vs option expiry besar H-1** (sudah ada datanya, bisa diberi bobot lebih).
Yang TIDAK realistis di stack gratis: order flow/depth sungguhan, positioning bank, data tick.

## Yang secara sadar TIDAK direkomendasikan

- **Fine-tuning / training model sendiri** — butuh data label outcome bertahun-tahun,
  infra GPU, dan hasilnya belum tentu mengalahkan confluence-scorer sederhana. Jauh melebihi
  skala proyek ini.
- **Menambah lagi jumlah indikator ke prompt** — prompt sudah padat; masalahnya bukan
  kurang data, tapi belum ada feedback loop (Tier 1). Data berlebih = noise (kekhawatiran
  user soal "catatan kebanyakan" valid di sini).
- **Model "lebih besar" sebagai solusi tunggal** — sudah dibuktikan berkali-kali di proyek
  ini (saga Nemotron, GLM, Qwen): ganti model efeknya kecil dibanding memperbaiki struktur
  input/output.

## Urutan eksekusi yang disarankan

1. Tier 3 (backtest offline — validasi asumsi, gratis, tanpa risiko produksi)
2. Tier 1 (outcome logging — mulai kumpulkan data secepatnya, makin lama makin berharga)
3. Tier 2 (kalibrasi — setelah data Tier 1 terkumpul minimal ~1-2 bulan)
4. Tier 4 (second opinion manual — kapan saja, murah)
5. Tier 5 (data tambahan — hanya kalau Tier 3 membuktikan konfluensi memang prediktif)
