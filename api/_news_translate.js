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
// - Di-AWAIT oleh api/feeds.js (rssHandler, cache-miss path saja), dengan
//   anggaran waktu ADAPTIF (bukan fire-and-forget murni — percobaan pertama
//   fire-and-forget TERBUKTI tidak pernah selesai di produksi, Vercel
//   membekukan eksekusi begitu respons dikirim sebelum panggilan AI
//   jaringan sempat jalan; beda dari storeNewsHistory di file yang sama yang
//   cukup cepat, regex+Redis doang, lolos sebelum dibekukan). Endpoint RSS
//   pernah kena bug timeout terpisah (lihat catatan di index.html fetchRSS()),
//   jadi anggaran waktu translate SENGAJA dibatasi ketat & adaptif terhadap
//   sisa waktu RSS fetch, bukan menambah delay tak terbatas. Item yang belum
//   sempat/gagal diterjemahkan cuma tetap bahasa Inggris sampai siklus
//   cache-refill berikutnya (~50-60 detik) mencoba lagi — self-healing.
// - Prompt STRICT (permintaan user): HANYA hasil terjemahan, tanpa penjelasan
//   tambahan apa pun.

const cb = require('./_circuit_breaker');
const { allowAiCall } = require('./_ai_guard');
const { detectCat } = require('../newscat');

// SambaNova akun 2 (SAMBANOVA_API_KEY_CALL1) — akun sama yang dipakai fallback Ringkasan
// Berita Call 1/Analisa Fundamental/AI Coach (lihat market-digest.js/admin.js/journal.js),
// diganti dari Gemini (permintaan user, 2026-08-02) supaya translate lebih cepat — Gemini
// dibatasi 10 RPM (keras, provider AI Studio free tier), sedangkan SambaNova ~10-20 RPM
// DAN tidak numpang kuota gabungan dengan fitur lain yang juga rebutan RPM Gemini yang
// sama. SENGAJA SEMENTARA (keputusan user): begitu backlog translate NEWS sudah habis dan
// arus headline balik normal (tidak deras lagi), rencananya balik ke Gemini lagi — SambaNova
// akun 2 cuma dipinjam untuk mengejar kecepatan selagi backlog besar. Kalau nanti diminta
// balik, tinggal reverse konstanta di bawah + 'sambanova_c1_newstranslate' balik ke
// 'gemini_newstranslate' di _ai_guard.js (lihat git history commit sesi ini).
// Circuit breaker key TERPISAH dari 'ai:sambanova:c1' yang dipakai file-file itu — supaya
// bug spesifik parsing/prompt translate ini tidak ikut men-trip circuit fitur lain.
const CB_SAMBANOVA = 'ai:sambanova:c1:newstranslate';
const SAMBANOVA_URL   = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL = 'DeepSeek-V3.2';

const TR_KEY_TTL = 36 * 3600; // detik — samakan retensi 36 jam dengan news_history
// SambaNova free tier ~10-20 RPM (lihat daun_merah_ai.md §4) — SATU gelombang per
// pemanggilan (bukan loop multi-gelombang) dijaga di bawah itu, supaya backlog besar
// (mis. pasca-deploy) tidak menembak >10 request dalam jendela <60 detik dan memicu
// 429/circuit trip. Sisa backlog nyusul siklus cache-refill berikutnya (~50-60 detik
// kemudian, RPM window sudah reset).
const MAX_CONCURRENT      = 8;
// Anti-starvation (S273, 2026-08-02): tanpa ini, wave SELALU mengambil todo[0..8)
// yang berarti headline TERBARU (urutan feed = terbaru dulu) — saat breaking news
// deras (>8 headline baru per siklus refresh), headline yang agak lama tapi belum
// sempat diterjemahkan terus digeser ke belakang antrean oleh headline yang lebih
// baru lagi, dan bisa nyangkut bahasa Inggris selama arus berita belum mereda
// (ditemukan lewat verifikasi live: 9/30 headline tetap Inggris 2 siklus berturut).
// Reserve sebagian slot tiap gelombang khusus headline TERTUA di antrean (ujung
// belakang todo[], bukan array terbaru) supaya backlog dijamin habis bertahap,
// sisa slot tetap prioritas headline terbaru (paling relevan buat pembaca).
const BACKLOG_RESERVE_SLOTS = 2;
const PER_CALL_TIMEOUT_MS = 4000;
// Default anggaran waktu translate kalau caller tidak kasih budgetMs eksplisit —
// caller SEHARUSNYA selalu kasih (lihat rssHandler di api/feeds.js, adaptif
// terhadap sisa waktu RSS fetch), ini cuma fallback aman.
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

async function translateOne(item, redisCmd) {
  if (!await allowAiCall('sambanova_c1_newstranslate')) return; // pagar kuota — nyusul siklus berikutnya
  const SAMBANOVA_KEY = process.env.SAMBANOVA_API_KEY_CALL1;
  if (!SAMBANOVA_KEY) return;
  try {
    const hasDesc = !!(item.description && item.description.trim());
    const r = await fetch(SAMBANOVA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SAMBANOVA_KEY}` },
      body: JSON.stringify({
        model: SAMBANOVA_MODEL,
        messages: [{ role: 'user', content: buildPrompt(item.title, item.description) }],
        max_tokens: 800,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const parsed = parseResponse(raw, hasDesc);
    if (!parsed) throw new Error('Unparseable response');
    await redisCmd('SET', `news_tr:${item.guid}`, JSON.stringify(parsed), 'EX', TR_KEY_TTL);
    await cb.onSuccess(CB_SAMBANOVA);
  } catch(e) {
    await cb.onFailure(CB_SAMBANOVA);
    console.warn('news_translate item failed:', item.guid, e.message);
  }
}

/**
 * Terjemahkan item baru yang belum pernah diterjemahkan. HARUS di-await oleh
 * caller (lihat rssHandler api/feeds.js) — fire-and-forget murni TERBUKTI tidak
 * selesai di produksi karena Vercel membekukan eksekusi begitu respons dikirim,
 * sebelum panggilan SambaNova (jaringan) sempat jalan (bug S272, ditemukan lewat
 * verifikasi live setelah deploy, bukan cuma unit test).
 * @param {Array} items - hasil parseRSSItems() (title, guid, pubDate, link, description)
 * @param {Function} redisCmd - helper Redis (shared dengan caller)
 * @param {number} budgetMs - anggaran waktu total (adaptif, lihat caller)
 */
async function translateNewItems(items, redisCmd, budgetMs = DEFAULT_BUDGET_MS) {
  if (!Array.isArray(items) || items.length === 0) return;
  if (!process.env.SAMBANOVA_API_KEY_CALL1) return;
  if (!await cb.canCall(CB_SAMBANOVA)) return; // circuit open — coba lagi siklus berikutnya

  // ECON DATA dikecualikan (permintaan user 2026-08-02): angka/rilis kalender
  // rawan salah interpretasi kalau diterjemahkan LLM — biarkan bahasa Inggris asli.
  const candidates = items.filter(it => it.guid && it.title && detectCat(it.title) !== 'econ-data');
  if (candidates.length === 0) return;

  // Skip item yang sudah pernah diterjemahkan (1x per guid, dishare semua user)
  const keys = candidates.map(it => `news_tr:${it.guid}`);
  const existing = await redisCmd('MGET', ...keys);
  const todo = candidates.filter((_, i) => !existing || existing[i] == null);
  if (todo.length === 0) return;

  // SATU gelombang saja per pemanggilan (bukan loop multi-gelombang) — lihat
  // catatan MAX_CONCURRENT di atas soal alasan RPM. budgetMs tetap dipakai
  // sebagai timeout keseluruhan gelombang ini (jaga-jaga kalau Promise.all
  // lebih lambat dari perkiraan), bukan buat looping banyak gelombang.
  let wave;
  if (todo.length <= MAX_CONCURRENT) {
    wave = todo;
  } else {
    // Lihat catatan BACKLOG_RESERVE_SLOTS di atas — pisah slot terbaru vs tertua,
    // todo.length > MAX_CONCURRENT di sini jadi kedua potongan dijamin tidak tumpang tindih.
    const newestSlots = MAX_CONCURRENT - BACKLOG_RESERVE_SLOTS;
    wave = todo.slice(0, newestSlots).concat(todo.slice(-BACKLOG_RESERVE_SLOTS));
  }
  await Promise.race([
    Promise.all(wave.map(it => translateOne(it, redisCmd))),
    new Promise(resolve => setTimeout(resolve, budgetMs)),
  ]);
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

module.exports = { translateNewItems, getTranslations, parseResponse, buildPrompt };
