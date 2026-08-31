// test/market_digest/digest_makro_scope.test.js
// 2026-08-31 — Ringkasan dikembalikan ke jobdesknya: MAKRO MURNI dari headline.
// Teknikal, COT, retail sentiment, dan korelasi dipindah sepenuhnya ke tab Analisa
// (keputusan user: "RINGKASAN UNTUK MAKRO, ANALISA UNTUK TEKNIKAL").
//
// Tes ini mengunci tiga hal yang kalau lepas, gejalanya kembali persis seperti audit
// 2026-08-31: briefing FX yang 4 dari 5 blok temanya tidak punya satu pun klaim dari
// headline, dan seluruh klaster eskalasi AS-Iran hari itu tidak disebut sama sekali.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  headlineRankScore,
  offTopicTermsIn,
  OFF_TOPIC_TERMS,
  FORBIDDEN_PHRASES,
} = require('../../api/market-digest.js');

const NOW = Date.parse('2026-08-31T03:30:00Z');
const h = (title, pubDate) => ({ title, pubDate });

// ── Peringkat headline ───────────────────────────────────────────────────────

test('rank: berita geopolitik segar mengalahkan headline CB rutin yang sudah basi', () => {
  const perang = h('Iran’s Revolutionary Guards: They shot down U.S. MQ-9 drone over Strait of Hormuz',
    'Mon, 31 Aug 2026 03:22:14 GMT');
  const cbBasi = h('Iceland rejects eurozone accession talks: broadcaster RUV reports',
    'Sun, 30 Aug 2026 07:24:00 GMT');
  assert.ok(headlineRankScore(perang, NOW) > headlineRankScore(cbBasi, NOW),
    'headline perang 2 jam lalu harus di atas berita eurozone 20 jam lalu');
});

test('rank: skor lama memberi NOL ke geopolitik/energi/data China — sekarang harus > 0', () => {
  // Persis headline yang pada 2026-08-31 berskor 0 di fungsi lama (CB_KW-only) dan
  // terlempar ke bawah rilis rutin Jepang.
  const nol = [
    h('Trump: Kharg Island being destroyed', 'Mon, 31 Aug 2026 02:19:31 GMT'),
    h('China August official manufacturing PMI at 49.8 Poll 49.6 vs 49.2 in July', 'Mon, 31 Aug 2026 01:37:09 GMT'),
    h('Commodity ships passing through Strait of Hormuz fall to 5 daily over weekend - data', 'Sun, 30 Aug 2026 21:00:00 GMT'),
    h("Iran's IRGC: launched ballistic missile strikes on two US bases in Jordan in retaliation", 'Sun, 30 Aug 2026 22:00:00 GMT'),
  ];
  for (const item of nol) {
    assert.ok(headlineRankScore(item, NOW) >= 5, `harus punya bobot nyata: ${item.title}`);
  }
});

test('rank: judul tak terklasifikasi tidak boleh kebagian bobot makro (fallback detectCat)', () => {
  // detectCat mengembalikan 'macro' juga sebagai fallback saat tidak ada kategori yang
  // cocok — tanpa guard, judul sampah menyalip berita perang cuma karena lebih baru.
  const sampah = h('Xal: Grok bot now compatible with X', 'Mon, 31 Aug 2026 03:00:00 GMT');
  const perang = h('Trump: Kharg Island being destroyed', 'Mon, 31 Aug 2026 02:19:31 GMT');
  assert.ok(headlineRankScore(sampah, NOW) < headlineRankScore(perang, NOW));
  assert.ok(headlineRankScore(sampah, NOW) <= 4, 'sampah hanya boleh dapat bonus kesegaran');
});

test('rank: kesegaran menaikkan skor, berita >24 jam tidak dapat bonus', () => {
  const judul = 'Fed’s Powell: policy remains restrictive';
  const baru  = headlineRankScore(h(judul, 'Mon, 31 Aug 2026 03:00:00 GMT'), NOW);
  const lama  = headlineRankScore(h(judul, 'Sat, 29 Aug 2026 20:00:00 GMT'), NOW);
  assert.ok(baru > lama, 'headline sama, yang lebih baru harus lebih tinggi');
  assert.equal(baru - lama, 4);
});

test('rank: rilis yang mengejutkan ke sisi lemah dapat bonus severity', () => {
  const lemah = h('US Nonfarm Payrolls Actual 90K (Forecast 180K, Previous 175K)', 'Mon, 31 Aug 2026 03:00:00 GMT');
  const pas   = h('US Nonfarm Payrolls Actual 180K (Forecast 180K, Previous 175K)', 'Mon, 31 Aug 2026 03:00:00 GMT');
  assert.ok(headlineRankScore(lemah, NOW) > headlineRankScore(pas, NOW));
});

test('rank: tanggal rusak tidak bikin NaN (skor tetap angka)', () => {
  const s = headlineRankScore(h('Fed’s Powell speaks', 'bukan-tanggal'), NOW);
  assert.ok(Number.isFinite(s), 'skor harus tetap finite walau pubDate tidak bisa diparse');
});

// ── Detektor penyimpangan jobdesk ────────────────────────────────────────────

test('offTopic: artikel gaya lama (teknikal + positioning + korelasi) tertangkap', () => {
  const artikelLama = 'Posisi teknikal pair ini masih uptrend di 4H dengan support 158.356, dan skew opsi '
    + 'USD/JPY call-skewed. EUR/USD tertekan oleh posisi leveraged net short EUR yang ekstrem, '
    + 'sementara korelasi DXY vs Copper berbalik arah.';
  const hits = offTopicTermsIn(artikelLama);
  for (const wajib of ['support', 'uptrend', 'net short', 'korelasi']) {
    assert.ok(hits.includes(wajib), `harus menangkap "${wajib}"`);
  }
});

test('offTopic: kosakata makro yang sah tidak boleh kena alarm palsu', () => {
  const artikelMakro = 'Bessent menyatakan fluktuasi yen terkendali, sementara level suku bunga Fed '
    + 'bertahan dan trend inflasi melandai. Harga cotton di Scotland naik, range harga minyak melebar '
    + 'setelah gangguan pasokan di Selat Hormuz.';
  assert.deepEqual(offTopicTermsIn(artikelMakro), []);
});

test('offTopic: daftar term tidak boleh memuat kata ambigu yang lazim di narasi makro', () => {
  for (const ambigu of ['level', 'trend', 'range', 'posisi']) {
    assert.ok(!OFF_TOPIC_TERMS.includes(ambigu), `"${ambigu}" terlalu ambigu untuk jadi pemicu`);
  }
});

test('frasa terlarang: varian "dicermati" ikut tertangkap (dulu lolos)', () => {
  // Artikel 31 Agustus memakai "patut dicermati" dan lolos karena daftar lama hanya
  // punya 'perlu dicermati' + 'mencermati'.
  const teks = 'AUD juga patut dicermati karena posisinya.'.toLowerCase();
  assert.ok(FORBIDDEN_PHRASES.some(p => teks.includes(p)),
    'daftar frasa terlarang harus menangkap "patut dicermati"');
});

// ── Prompt Ringkasan tidak lagi menerima data teknikal/positioning ────────────

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'api', 'market-digest.js'), 'utf8');

test('prompt: blok teknikal/positioning/korelasi tidak lagi disuapkan ke Call 1 & Call 3', () => {
  for (const blok of ['PRICE ACTION', 'TEKNIKAL XAU/USD DAILY', 'SKEW OPSI', 'POSITIONING CFTC COT',
                      'KORELASI CROSS-ASSET', 'multi-TF price context', 'daily TA']) {
    assert.ok(!SRC.includes(blok), `blok "${blok}" seharusnya sudah dicabut dari prompt Ringkasan`);
  }
});

test('prompt: fetch cache COT/skew/korelasi TETAP ada (pemanas cache auto-entry, POLICY_EPOCHS v35)', () => {
  // Mencabut blok dari prompt TIDAK boleh ikut mencabut fetch-nya: cron Ringkasan
  // adalah pemanas cache yang dipakai tab Analisa & jalur auto-entry.
  for (const key of ['cot_cache_v2', 'rr_cache_v2', 'correlations_v3']) {
    assert.ok(SRC.includes(key), `fetchOrWarm '${key}' tidak boleh ikut terhapus`);
  }
});

test('prompt: jobdesk makro + gerbang tema tertulis eksplisit di system prompt', () => {
  assert.ok(SRC.includes('GERBANG TEMA'), 'aturan tema wajib berjangkar kejadian harus ada');
  assert.ok(SRC.includes('BUKAN analisa teknikal'), 'pemisahan Ringkasan vs Analisa harus eksplisit');
  assert.ok(SRC.includes('BUKAN "konten emas"'),
    'geopolitik/minyak/tarif/data China harus dinyatakan bukan konten emas, biar tidak dioper ke paragraf XAU');
});

test('prompt: tense event kalender dikunci ke tag/tanggal, kata relatif dilarang', () => {
  // Pelanggaran nyata 2026-08-31: RBNZ bertag "[AKAN RILIS dalam 41 jam]" (Rabu) ditulis
  // "besok" (Selasa) — salah satu hari penuh. Akarnya instruksi lama yang justru
  // MENYONTOHKAN kata "besok" sebagai tense yang boleh dipakai.
  assert.ok(SRC.includes('DILARANG KERAS menerjemahkannya sendiri jadi "besok"'),
    'kata relatif hasil hitungan sendiri harus dilarang eksplisit');
  assert.ok(!/menentukan tense \("tadi pagi", "nanti", "besok"\)/.test(SRC),
    'contoh lama yang mengundang parafrase "besok" tidak boleh hidup lagi');
});

test('prompt: tema wajib berbobot, rilis tier rendah bukan tema', () => {
  assert.ok(SRC.includes('JANGKAR KEJADIAN SAJA TIDAK CUKUP'),
    'gerbang tema harus menolak rilis tier rendah, bukan cuma menolak tema tanpa berita');
  for (const contoh of ['inventories', 'kredit sektor swasta']) {
    assert.ok(SRC.includes(contoh), `contoh data tier rendah "${contoh}" harus disebut`);
  }
});

test('prompt: kaitan yang sering terlewat (China->AUD/NZD, minyak->CAD) wajib dirajut', () => {
  assert.ok(SRC.includes('data China ke AUD/NZD'),
    'kaitan China->AUD/NZD harus disebut eksplisit — paling sering terlewat');
});

test('prompt: konteks SESI ikut dikirim (dulu sesiLabel cuma dipakai judul notifikasi)', () => {
  // Laporan user 2026-08-31: "kita kan di sesi London, kok tidak ada bahasan mata uang
  // London?". Ternyata prompt yang kalimat pertamanya berbunyi "briefing pre-session"
  // tidak pernah diberi tahu sesi mana yang dibuka.
  assert.ok(SRC.includes('SESI YANG SEDANG/AKAN DIBUKA'), 'blok sesi wajib masuk prompt');
  assert.ok(SRC.includes('${sesiNote}'), 'sesiNote wajib disisipkan ke blok WAKTU prompt');
  assert.ok(/'sesi Eropa':\s*'EUR, GBP, CHF'/.test(SRC), 'peta mata uang per sesi harus ada');
});

test('prompt: sesi tanpa katalis WAJIB dinyatakan, bukan didiamkan atau ditambal tema', () => {
  assert.ok(SRC.includes('dibuka tanpa katalis domestik'),
    'harus mewajibkan satu kalimat eksplisit saat mata uang sesi sepi berita');
  assert.ok(SRC.includes('JANGAN mengarang tema untuknya'),
    'jangan sampai aturan ini jadi pintu belakang tema pengisi yang baru ditutup Gerbang Tema');
  assert.ok(SRC.includes('Interest Rate Probabilities'),
    'boilerplate wire harus dinyatakan BUKAN katalis — dua bug lama (S284, S302) lahir dari sini');
});

test('digest_history: self-heal tipe key sebelum LPUSH (bug WRONGTYPE senyap 4 bulan)', () => {
  assert.ok(/TYPE', 'digest_history'/.test(SRC), 'harus mengecek TYPE sebelum LPUSH');
  assert.ok(/DEL', 'digest_history'/.test(SRC), 'harus menghapus key bertipe salah supaya LPUSH jalan lagi');
});

test('payload: daftar headline sumber ikut dikirim ke klien', () => {
  assert.ok(SRC.includes('headlines_sent:'), 'response wajib membawa headline yang dikirim ke AI');
  assert.ok(SRC.includes('headlines_sent_total:'), 'total wajib ikut supaya UI jujur soal "N dari total"');
});

test('penamaan: field TIDAK boleh bernama headlines_used (menyesatkan)', () => {
  // Nama lama bikin user mengira angka 25 itu hasil PILIHAN AI, padahal murni potongan
  // kode dari peringkat kode — AI tidak pernah diminta memilih. Nama harus menggambarkan
  // apa yang benar-benar terjadi: headline DIKIRIM, bukan dipakai.
  assert.ok(!/headlines_used\s*:/.test(SRC),
    'jangan hidupkan lagi nama headlines_used — pakai headlines_sent');
});
