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
// HEADLINE — itu biang keladi gampang mepet limit RPM, BUKAN volume beritanya yang
// tinggi (15 headline baru dalam satu siklus = 15 panggilan terpisah). Sempat dicoba
// ganti provider ke SambaNova akun 2 (lihat git history, commit sesi HP 2026-08-02)
// supaya lolos limit 10 RPM Gemini — TERBUKTI SALAH lewat verifikasi live: akun 2
// dipakai bersama 3 fitur lain (fallback Journal/Fundamental, Call 1 Ringkasan) dan
// circuit breaker-nya trip berulang (22 kegagalan beruntun ketahuan saat diagnosis
// langsung ke Redis produksi), headline malah sering TIDAK diterjemahkan sama sekali
// berjam-jam — lebih buruk dari kondisi sebelumnya. Perbaikan sebenarnya: BATCH —
// SATU panggilan API menerjemahkan sampai BATCH_SIZE headline sekaligus. N headline
// baru sekarang cuma butuh ceil(N/BATCH_SIZE) panggilan, bukan N panggilan — jumlah
// PANGGILAN per menit nyaris tidak pernah dekat limit 10 RPM Gemini walau breaking
// news deras. Balik ke Gemini (gratis, terbukti stabil sebelum eksperimen SambaNova).

const cb = require('./_circuit_breaker');
const { allowAiCall } = require('./_ai_guard');
const { detectCat } = require('../newscat');

// Circuit breaker key TERPISAH dari 'ai:gemini' yang dipakai admin.js/market-digest.js/
// journal.js — supaya bug spesifik parsing/prompt translate ini tidak ikut men-trip
// circuit fitur lain (Analisa Fundamental/AI Coach) yang juga fallback ke Gemini.
const CB_GEMINI = 'ai:gemini:newstranslate';
const GEMINI_URL   = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = 'gemini-flash-latest';

const TR_KEY_TTL = 36 * 3600; // detik — samakan retensi 36 jam dengan news_history
// Berapa headline digabung dalam SATU panggilan API (lihat catatan BATCH REDESIGN di
// atas). Makin besar makin hemat panggilan, tapi makin besar juga risiko model salah
// urut/lewat nomor di respons yang panjang. 20 titik keseimbangan: prompt & respons
// masih ringkas + gampang di-parse per blok, tapi tetap >10x lebih hemat panggilan
// API dibanding desain lama (1 headline/panggilan).
const BATCH_SIZE = 20;
const PER_CALL_TIMEOUT_MS = 9000; // batch butuh lebih banyak token/waktu daripada 1 headline
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

async function translateBatch(items, redisCmd) {
  if (!await allowAiCall('gemini_newstranslate')) return; // pagar kuota — nyusul siklus berikutnya
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return;
  try {
    const r = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GEMINI_KEY}` },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        messages: [{ role: 'user', content: buildBatchPrompt(items) }],
        max_tokens: 6000,
        temperature: 0.2,
        reasoning_effort: 'low',
      }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = parseBatchResponse(raw, items.length);
    if (!parsed.some(Boolean)) throw new Error('Unparseable batch response');
    await Promise.all(parsed.map((p, i) => (p ? redisCmd('SET', `news_tr:${items[i].guid}`, JSON.stringify(p), 'EX', TR_KEY_TTL) : null)));
    await cb.onSuccess(CB_GEMINI);
  } catch(e) {
    await cb.onFailure(CB_GEMINI);
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
  if (!process.env.GEMINI_API_KEY) return;
  if (!await cb.canCall(CB_GEMINI)) return; // circuit open — coba lagi siklus berikutnya

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

  const deadline = Date.now() + budgetMs;
  for (const chunk of chunks) {
    if (Date.now() >= deadline) break;
    // clearTimeout di finally — tanpa ini, timer sisa budget yang KALAH race (batch
    // selesai duluan) tetap hidup sampai durasi penuhnya habis sendiri, cuma diam-diam
    // menahan proses Node tetap berjalan (ketahuan dari runtime unit test yang harusnya
    // instan malah ikut nunggu puluhan detik).
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); });
    try {
      await Promise.race([translateBatch(chunk, redisCmd), timeout]);
    } finally {
      clearTimeout(timer);
    }
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
