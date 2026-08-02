// api/_news_translate.js
// Terjemahan headline NEWS ke Bahasa Indonesia (S272, 2026-08-02) — underscore
// prefix = bukan endpoint, tidak makan slot Vercel function.
//
// Desain (keputusan user, sesi ini):
// - Field TAMBAHAN (title_id/desc_id), title/description Inggris asli TETAP
//   dipertahankan utuh — dipakai newscat.js (detectCat), filter TEK per-pair,
//   push notification, prompt AI Ringkasan. Menimpa field asli akan merusak
//   semua konsumen itu diam-diam (lihat audit S272 di daun_merah.md).
// - Kategori 'econ-data' DIKECUALIKAN dari translate — angka/rilis kalender
//   ekonomi rawan salah interpretasi LLM, biarkan bahasa Inggris asli.
// - 1x translate per headline (guid), hasil di-cache 36 jam (news_tr:<guid>),
//   dishare SEMUA user/device — bukan per-request, bukan per-user.
// - Di-AWAIT oleh caller (rssHandler cache-miss & newsHistoryHandler), BUKAN
//   fire-and-forget murni — percobaan pertama fire-and-forget TERBUKTI tidak
//   pernah selesai di produksi, Vercel membekukan eksekusi begitu respons
//   dikirim sebelum panggilan AI jaringan sempat jalan. Anggaran waktu ADAPTIF
//   terhadap sisa waktu handler pemanggil, bukan menambah delay tak terbatas.
//   Item yang belum sempat/gagal diterjemahkan cuma tetap bahasa Inggris sampai
//   siklus cache-refill berikutnya (~50-60 detik) mencoba lagi — self-healing.
// - Prompt STRICT (permintaan user): HANYA hasil terjemahan, tanpa penjelasan
//   tambahan apa pun.
//
// BATCH REDESIGN (2026-08-02, usulan user): desain awal kirim 1 panggilan API PER
// HEADLINE — itu biang keladi gampang mepet limit RPM/RPD provider, BUKAN volume
// beritanya yang tinggi (15 headline baru dalam satu siklus = 15 panggilan terpisah).
// Perbaikan sebenarnya: BATCH — SATU panggilan API menerjemahkan sampai BATCH_SIZE
// headline sekaligus. N headline baru sekarang cuma butuh ceil(N/BATCH_SIZE)
// panggilan, bukan N panggilan.
//
// Riwayat provider hari yang sama (2026-08-02), SEMUA diverifikasi LIVE bukan
// tebak-tebakan:
// 1) Gemini (`gemini-flash-latest`) → SambaNova akun 2 (supaya lolos limit RPM
//    Gemini) → TERBUKTI SALAH: akun 2 dipakai bersama 3 fitur lain (fallback
//    Journal/Fundamental, Call 1 Ringkasan), circuit breaker trip berulang (22
//    kegagalan beruntun ketahuan dari Redis produksi), headline sering TIDAK
//    diterjemahkan berjam-jam.
// 2) Balik ke Gemini + desain BATCH ini → TERBUKTI SALAH JUGA, alasan BEDA: bukan
//    RPM, tapi kuota HARIAN — 429 `RESOURCE_EXHAUSTED`, limit CUMA 20
//    request/hari untuk model yang di-resolve alias `gemini-flash-latest` saat ini
//    (`gemini-3.6-flash`), jauh di bawah asumsi lama "1.500 RPD" (kuota Google makin
//    ketat tiap alias `-latest` bergeser generasi — lihat komentar model drift di
//    market-digest.js/admin.js/journal.js, sudah 3x bergeser: 2.5→3.5→3.6).
// 3) Balik ke SambaNova akun 2 + desain BATCH (keputusan user) + fix AbortSignal
//    deadline (translateBatch dulu di-race lawan timer terpisah — panggilan lambat
//    tetap JALAN di background walau sudah "dianggap gagal" di sisi kita, berisiko
//    orphaned/dibekukan Vercel). TERBUKTI TETAP TIDAK CUKUP — walau sudah batch +
//    fix orphaned-fetch, circuit breaker translate trip lagi (72 kegagalan beruntun
//    ketahuan ~1 jam pasca-deploy). Root cause murni akun SambaNova 2 itu sendiri
//    memang tidak stabil (tes isolasi 3 headline kecil pun timeout 20+ detik di lain
//    waktu, padahal batch 10 headline pernah sukses 8,8 detik sebelumnya) — bukan lagi
//    soal desain kode, tapi kesehatan akun itu sendiri.
// 4) Evaluasi ulang 3 kandidat lain (permintaan user), tes empiris 3 ronde @ 10
//    headline: SambaNova akun 1 (3,3-9,7 detik, ada lonjakan), Gemini flash-lite
//    (2,1-9,1 detik, kuota harian TIDAK terkonfirmasi — risiko sama seperti #2),
//    Mistral (5,5-5,7 detik, SANGAT konsisten). **FINAL: Mistral** — satu-satunya
//    kandidat TANPA kontensi fitur produksi lain sama sekali (sebelum ini cuma
//    dipakai jalur diagnostik manual `?test_mistral=1`), kuota bulanan generous
//    sudah terdokumentasi (lihat DEFAULT_LIMITS di _ai_guard.js), akurasi
//    terjemahan diverifikasi setara/lebih baik (konversi format angka
//    desimal/ribuan EN→ID malah lebih presisi).

const cb = require('./_circuit_breaker');
const { allowAiCall } = require('./_ai_guard');
const { detectCat } = require('../newscat');

// Circuit breaker key TERPISAH dari circuit Mistral lain (kalau ada di masa depan)
// — konvensi sama seperti isolasi provider lain di file ini sejak awal (S272).
const CB_MISTRAL = 'ai:mistral:newstranslate';
const MISTRAL_URL   = 'https://api.mistral.ai/v1/chat/completions';
const MISTRAL_MODEL = 'mistral-small-latest';

const TR_KEY_TTL = 36 * 3600; // detik — samakan retensi 36 jam dengan news_history
// Berapa headline digabung dalam SATU panggilan API (lihat catatan BATCH REDESIGN di
// atas). Makin besar makin hemat panggilan, tapi makin besar juga risiko model salah
// urut/lewat nomor di respons yang panjang. 20 titik keseimbangan: prompt & respons
// masih ringkas + gampang di-parse per blok, tapi tetap >10x lebih hemat panggilan
// API dibanding desain lama (1 headline/panggilan).
const BATCH_SIZE = 20;
// Mistral diverifikasi live (2026-08-02): batch 10 headline konsisten ~5,5-5,7 detik
// di 3 ronde tes berturut. 15 detik kasih headroom >2x dari observasi nyata untuk
// batch penuh 20 headline, tanpa terlalu longgar menahan Vercel/client kalau memang
// benar-benar macet.
const PER_CALL_TIMEOUT_MS = 15000;
// Default anggaran waktu translate kalau caller tidak kasih budgetMs eksplisit —
// caller SEHARUSNYA selalu kasih (lihat rssHandler/newsHistoryHandler di api/feeds.js,
// adaptif terhadap sisa waktu masing-masing), ini cuma fallback aman.
const DEFAULT_BUDGET_MS = 6000;

function buildPrompt(title, desc) {
  const hasDesc = !!(desc && desc.trim());
  let body = `JUDUL:\n${title}`;
  if (hasDesc) body += `\n\nISI:\n${desc}`;
  return `Terjemahkan teks berita finansial berikut dari Bahasa Inggris ke Bahasa Indonesia. ATURAN KETAT:
- HANYA keluarkan hasil terjemahan. JANGAN tambahkan penjelasan, catatan, opini, disclaimer, atau komentar apa pun di luar terjemahan itu sendiri.
- Pertahankan istilah/singkatan finansial standar, nama orang, nama tempat, dan ticker APA ADANYA (contoh: Fed, FOMC, CPI, GDP, ECB, Powell, Trump, S&P 500, WTI) — JANGAN diterjemahkan atau diberi padanan.
- Terjemahan harus akurat dan tidak ambigu — kalau kalimat sumber bermakna ganda, pilih makna yang paling masuk akal dalam konteks berita finansial/pasar.
- Jangan menambah informasi apa pun yang tidak ada di teks sumber.

${body}

Jawab PERSIS format berikut, tanpa teks lain apa pun di luar format ini:
JUDUL_ID: <hasil terjemahan judul>${hasDesc ? '\nISI_ID: <hasil terjemahan isi>' : ''}`;
}

function parseResponse(raw, hasDesc) {
  if (!raw) return null;
  // Lookahead (bukan consuming group) untuk batas ISI_ID — kalau pakai \s* biasa di kedua
  // sisi, \s* di sisi kiri capture group bisa "mencuri" newline pembatas sebelum ISI_ID
  // duluan (greedy), bikin capture lazy meluber sampai akhir string dan ikut menelan
  // "ISI_ID: ..." sebagai bagian dari judul (bug ketahuan dari test unit ini sendiri).
  const titleM = raw.match(/JUDUL_ID:[ \t]*([\s\S]*?)(?=\r?\n\s*ISI_ID:|$)/i);
  const title_id = titleM ? titleM[1].trim() : '';
  if (!title_id) return null;
  let desc_id = '';
  if (hasDesc) {
    const descM = raw.match(/ISI_ID:\s*([\s\S]*)$/i);
    desc_id = descM ? descM[1].trim() : '';
  }
  return { title_id, desc_id };
}

// Gabung sampai BATCH_SIZE headline jadi SATU prompt bernomor [1]..[N] — lihat catatan
// BATCH REDESIGN di atas. Tiap nomor dipetakan balik ke headline aslinya lewat
// parseBatchResponse().
function buildBatchPrompt(items) {
  const blocks = items.map((it, i) => {
    let s = `[${i + 1}]\nJUDUL: ${it.title}`;
    if (it.description && it.description.trim()) s += `\nISI: ${it.description.trim()}`;
    return s;
  }).join('\n\n');
  return `Terjemahkan ${items.length} headline berita finansial berikut dari Bahasa Inggris ke Bahasa Indonesia, satu per satu sesuai nomornya masing-masing. ATURAN KETAT:
- HANYA keluarkan hasil terjemahan sesuai format jawaban di bawah, untuk SEMUA ${items.length} nomor tanpa terkecuali — JANGAN ada nomor yang dilewati, digabung, atau ditukar urutannya.
- JANGAN tambahkan penjelasan, catatan, opini, disclaimer, atau komentar apa pun di luar format jawaban.
- Pertahankan istilah/singkatan finansial standar, nama orang, nama tempat, dan ticker APA ADANYA (contoh: Fed, FOMC, CPI, GDP, ECB, Powell, Trump, S&P 500, WTI) — JANGAN diterjemahkan atau diberi padanan.
- Tiap nomor berdiri sendiri (headline berbeda-beda) — JANGAN campur konteks antar nomor.

${blocks}

Jawab PERSIS format berikut per nomor, urutan nomor SAMA seperti input, tanpa teks lain apa pun di luar format ini:
[1]
JUDUL_ID: <hasil terjemahan judul nomor 1>
ISI_ID: <hasil terjemahan isi nomor 1, kosongkan baris ini kalau nomor 1 tidak punya ISI>
[2]
JUDUL_ID: <hasil terjemahan judul nomor 2>
...dst sampai [${items.length}]`;
}

// Pecah respons batch jadi per-blok [N], lalu pakai ULANG parseResponse() (proven,
// sudah teruji sejak desain 1-headline/panggilan) untuk masing-masing blok — tidak
// perlu regex parsing baru yang berisiko, cukup potong per marker dulu.
function parseBatchResponse(raw, count) {
  const out = new Array(count).fill(null);
  if (!raw) return out;
  const markerRe = /\[(\d+)\]\s*/g;
  const markers = [];
  let m;
  while ((m = markerRe.exec(raw)) !== null) {
    markers.push({ idx: parseInt(m[1], 10), matchStart: m.index, contentStart: markerRe.lastIndex });
  }
  for (let i = 0; i < markers.length; i++) {
    const { idx, contentStart } = markers[i];
    const contentEnd = i + 1 < markers.length ? markers[i + 1].matchStart : raw.length;
    const arrIdx = idx - 1;
    if (arrIdx < 0 || arrIdx >= count) continue;
    const parsed = parseResponse(raw.slice(contentStart, contentEnd), true);
    if (parsed) out[arrIdx] = parsed;
  }
  return out;
}

async function translateBatch(items, redisCmd, timeoutMs) {
  if (!await allowAiCall('mistral_newstranslate')) return; // pagar kuota — nyusul siklus berikutnya
  const MISTRAL_KEY = process.env.MISTRAL_API_KEY;
  if (!MISTRAL_KEY) return;
  try {
    const r = await fetch(MISTRAL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${MISTRAL_KEY}` },
      body: JSON.stringify({
        model: MISTRAL_MODEL,
        messages: [{ role: 'user', content: buildBatchPrompt(items) }],
        max_tokens: 6000,
        temperature: 0.2,
      }),
      // signal pakai timeoutMs dari CALLER (sisa budget siklus ini), BUKAN konstanta
      // tetap — lihat catatan di translateNewItems soal kenapa ini penting (mencegah
      // panggilan lambat jadi orphaned/fire-and-forget diam-diam kalau dibiarkan
      // jalan lebih lama dari budget yang tersisa).
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = parseBatchResponse(raw, items.length);
    if (!parsed.some(Boolean)) throw new Error('Unparseable batch response');
    await Promise.all(parsed.map((p, i) => (p ? redisCmd('SET', `news_tr:${items[i].guid}`, JSON.stringify(p), 'EX', TR_KEY_TTL) : null)));
    await cb.onSuccess(CB_MISTRAL);
  } catch(e) {
    await cb.onFailure(CB_MISTRAL);
    console.warn('news_translate batch failed:', items.map(it => it.guid).join(','), e.message);
  }
}

/**
 * Terjemahkan item baru yang belum pernah diterjemahkan, dalam batch sampai
 * BATCH_SIZE headline per panggilan API. HARUS di-await oleh caller (lihat
 * rssHandler/newsHistoryHandler api/feeds.js) — lihat catatan fire-and-forget
 * di atas.
 * @param {Array} items - hasil parseRSSItems() (title, guid, pubDate, link, description)
 * @param {Function} redisCmd - helper Redis (shared dengan caller)
 * @param {number} budgetMs - anggaran waktu total (adaptif, lihat caller)
 */
async function translateNewItems(items, redisCmd, budgetMs = DEFAULT_BUDGET_MS) {
  if (!Array.isArray(items) || items.length === 0) return;
  if (!process.env.MISTRAL_API_KEY) return;
  if (!await cb.canCall(CB_MISTRAL)) return; // circuit open — coba lagi siklus berikutnya

  // ECON DATA dikecualikan (permintaan user 2026-08-02): angka/rilis kalender
  // rawan salah interpretasi kalau diterjemahkan LLM — biarkan bahasa Inggris asli.
  const candidates = items.filter(it => it.guid && it.title && detectCat(it.title) !== 'econ-data');
  if (candidates.length === 0) return;

  // Skip item yang sudah pernah diterjemahkan (1x per guid, dishare semua user)
  const keys = candidates.map(it => `news_tr:${it.guid}`);
  const existing = await redisCmd('MGET', ...keys);
  const todo = candidates.filter((_, i) => !existing || existing[i] == null);
  if (todo.length === 0) return;

  // Pecah jadi batch BATCH_SIZE. Anti-starvation (S273, dipertahankan di desain batch):
  // kalau lebih dari 2 batch, batch KEDUA yang diproses selalu ambil dari ujung PALING
  // LAMA (ekor todo[]) dulu — supaya headline lama tetap kebagian slot walau budget
  // cuma cukup untuk 2 batch, bukan terus digeser headline baru yang lebih deras.
  const chunks = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) chunks.push(todo.slice(i, i + BATCH_SIZE));
  if (chunks.length > 2) chunks.splice(1, 0, chunks.pop());

  // Deadline per-chunk pakai AbortSignal SUNGGUHAN di translateBatch (sisa budget,
  // dibatasi juga oleh PER_CALL_TIMEOUT_MS) — BUKAN Promise.race melawan timer
  // terpisah. Bedanya penting: kalau cuma di-race, panggilan yang lebih lambat dari
  // sisa budget tetap JALAN di background sampai selesai sendiri (fetch tidak
  // benar-benar dibatalkan) — begitu handler pemanggil sudah kirim respons, proses
  // itu jadi orphaned dan berisiko dibekukan Vercel sebelum sempat cb.onSuccess/
  // redisCmd('SET', ...) — persis bug fire-and-forget yang sudah pernah ditemukan &
  // difix sebelumnya (lihat catatan di atas), cuma muncul lagi dalam bentuk baru.
  // AbortSignal dari fetch() ITU SENDIRI yang mengunci deadline supaya translateBatch
  // SELALU selesai (sukses atau gagal tercatat) sebelum sisa budget habis — tidak ada
  // eksekusi yang bisa lolos tanpa ke-await penuh.
  const deadline = Date.now() + budgetMs;
  for (const chunk of chunks) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await translateBatch(chunk, redisCmd, Math.min(PER_CALL_TIMEOUT_MS, remaining));
  }
}

/**
 * Baca hasil translate yang sudah siap untuk daftar guid tertentu.
 * @returns {Object} map guid -> {title_id, desc_id} (cuma yang ketemu)
 */
async function getTranslations(guids, redisCmd) {
  const list = Array.isArray(guids) ? guids.filter(Boolean) : [];
  if (list.length === 0) return {};
  const keys = list.map(g => `news_tr:${g}`);
  const raw = await redisCmd('MGET', ...keys);
  const out = {};
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => {
      if (!v) return;
      try { out[list[i]] = JSON.parse(v); } catch(e) {}
    });
  }
  return out;
}

module.exports = { translateNewItems, getTranslations, parseResponse, buildPrompt, buildBatchPrompt, parseBatchResponse };
