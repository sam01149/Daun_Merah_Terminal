// api/unified-digest.js
const rateLimit    = require('./_ratelimit');
const cb           = require('./_circuit_breaker');
const { autoUpdateFundamentals } = require('./_fundamental_parser');
const { withSingleFlight } = require('./_fetch_lock');
const { getLiveCbRates } = require('./_cb_rates');
const { configureVapid, sendWebPush } = require('./_webpush');
const { allowAiCall, providerFromUrl } = require('./_ai_guard');
const { CB_KW, kwTest, isCbHeadline, stripHtml } = require('./_cb_keywords');
// Session 158: detectCat pindah ke newscat.js (root repo) — single source of truth
// bersama index.html & sw.js; word-boundary match + scoring, bukan substring polos.
const { detectCat } = require('../newscat');

// Call 2 (CB bias) evidence trail: accumulate distinct headlines across cycles instead of
// overwriting with only the current cycle's matches. Without this, a bias correctly carried
// forward from a substantive headline (e.g. an actual rate-decision statement) shows a stale,
// uninformative "Dasar AI" box once that original headline ages out of the 36h news window and
// gets replaced by whatever generic title re-triggered this cycle's re-check.
const MAX_SOURCE_HEADLINES = 8;
function mergeSourceHeadlines(prevList, freshList) {
  const seen = new Set();
  const merged = [];
  for (const h of [...freshList, ...(Array.isArray(prevList) ? prevList : [])]) {
    // Back-compat: entries written before this change are plain strings.
    const normalized = typeof h === 'string' ? { title: h, description: null, matched_at: null } : h;
    if (!normalized?.title || seen.has(normalized.title)) continue;
    seen.add(normalized.title);
    merged.push(normalized);
    if (merged.length >= MAX_SOURCE_HEADLINES) break;
  }
  return merged;
}

// AI provider failure threshold before circuit opens (fewer than external sources
// because AI errors are faster to detect and providers recover quickly)
const AI_CB_THRESHOLD = 2;

// Frasa terlarang dari DIGEST_SYSTEM_DEFAULT — satu sumber kebenaran untuk prompt DAN cek kode (C8)
const FORBIDDEN_PHRASES = [
  'dapat mempengaruhi','dapat memberikan','dapat berdampak','perlu dicermati','patut diwaspadai',
  'tergantung data','masih akan volatile','menjadi fokus','berpotensi menggerakkan',
  'berpotensi mempengaruhi','dapat menekan','memberikan tekanan','memberikan dorongan',
  'perlu diperhatikan','akan terus dipantau','seiring dengan','sejalan dengan','di tengah',
  'memberikan gambaran','masih dalam ketidakpastian','mencermati','perkembangan ini',
  'berdampak pada pasar',
];

const RSS_URL      = 'https://www.financialjuice.com/feed.ashx?xy=rss';
const FF_THIS_WEEK = 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml';
const FF_NEXT_WEEK = 'https://nfs.faireconomy.media/ff_calendar_nextweek.xml';

// AI providers
const SAMBANOVA_URL       = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL     = 'DeepSeek-V3.2';              // Call 2 & 3: structured JSON (akun 1) — upgrade dari V3.1, kualitas lebih baik
const SAMBANOVA_URL_CALL1 = 'https://api.sambanova.ai/v1/chat/completions';
const SAMBANOVA_MODEL_CALL1 = 'DeepSeek-V3.2';            // Call 1: prose (akun 2) — preview, tapi kualitas superior untuk Indonesian
// Circuit breaker source names — pisahkan per-akun agar kegagalan akun 1 tak menjatuhkan akun 2
const CB_SAMBA_C1   = 'ai:sambanova:c1';   // Call 1 prosa, akun 2 (SAMBANOVA_KEY_CALL1)
const CB_SAMBA_MAIN = 'ai:sambanova:main'; // Call 2/3/4 JSON, akun 1 (SAMBANOVA_KEY)
const GROQ_URL        = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL      = 'llama-3.3-70b-versatile';        // Call 2, 3, 4: JSON + thesis
const GROQ_MODEL_PROSE = 'llama-3.3-70b-versatile';        // Call 1 fallback 3: prose. Diganti dari qwen/qwen3-32b (2026-06)
                                                            // — terkonfirmasi via console.groq.com/docs/models statusnya
                                                            // "Preview/Evaluation" (bukan production), kemungkinan besar
                                                            // sumber HTTP 413 saat jadi fallback terakhir. llama-3.3-70b-versatile
                                                            // production-tier, context sama 131K, sudah proven reliable di
                                                            // codebase ini buat Call 2/4, dan didokumentasikan resmi cocok
                                                            // untuk "long-form content".
const OPENROUTER_URL     = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL   = 'openai/gpt-oss-120b:free'; // Call 1 fallback 2: proven stabil, output Bahasa Indonesia
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://financial-feed-app.vercel.app', 'X-Title': 'Daun Merah' };
// Nemotron 3 Ultra (session 145) — primary baru Call 1/2/3: 550B/55B-active MoE hybrid
// Mamba-Transformer, context 1M, GPQA Diamond 86.7%. Circuit breaker terpisah dari
// OpenRouter fallback 2 di atas karena sekarang dipanggil TIAP request sebagai primary
// (bukan fallback jarang) — lihat CB_OPENROUTER_NEMOTRON. providerOverride tetap reuse
// counter 'openrouter' yang sudah ada (account-wide, jangan pecah per-model — lihat _ai_guard.js).
const NEMOTRON_MODEL           = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const CB_OPENROUTER_NEMOTRON   = 'ai:openrouter:nemotron';

// Ollama Cloud sebagai sumber Nemotron 3 Ultra alternatif (session 145 lanjutan) —
// dicoba SEBELUM OpenRouter setelah 2 ronde tes live OpenRouter menunjukkan 0/3 bersih
// (respons kosong + timeout, meski TIDAK 403). API-nya native Ollama (/api/chat, BUKAN
// /v1/chat/completions), jadi butuh helper terpisah — lihat callOllama() di bawah,
// pola sama seperti _callOllama() di admin.js (ohlcv_analyze, session 144 lanjutan 5).
// Reuse counter budget 'ollama' yang sudah ada (satu akun Ollama Cloud dipakai bersama
// dengan ohlcv_analyze di admin.js) — circuit breaker terpisah karena beda model/fitur.
const OLLAMA_URL             = 'https://ollama.com/api/chat';
// PENTING: TANPA suffix ':cloud' — itu konvensi Ollama LOKAL (ollama run <model>:cloud
// di mesin sendiri), BUKAN nama model yang valid untuk direct server-to-server API call
// (lihat root-cause bug GLM-5.2 di daun_merah.md Session 144 lanjutan 5 — pelajaran yang
// sama berlaku di sini, bukan diasumsikan ulang).
const OLLAMA_NEMOTRON_MODEL  = 'nemotron-3-ultra';
const CB_OLLAMA_NEMOTRON     = 'ai:ollama:nemotron';

// Nemotron 3 SUPER (session 145 lanjutan 5) — kandidat berbeda dari Ultra di
// atas: 120B total/12B active (jauh lebih ringan), via OpenRouter. Dipersiapkan untuk
// dites live (belum dijalankan — nunggu konfirmasi user) KHUSUS Call 1 (prosa, bukan
// Call 2/3 yang butuh JSON ketat): OpenRouter sendiri melaporkan statistik produksi
// nyata yang jauh lebih sehat dari Ultra (p50 latency 1.82s, E2E rata-rata 11.2s,
// uptime 97.85%), TAPI Structured Output Error Rate 17.76% — terlalu berisiko untuk
// Call 2/3 (JSON), jadi sengaja dibatasi ke Call 1 saja. Reuse counter 'openrouter'
// (account-wide, sama seperti Nemotron Ultra) dan withNoThink() (satu keluarga model,
// kemungkinan konvensi /think /no_think yang sama berlaku).
const NEMOTRON_SUPER_MODEL         = 'nvidia/nemotron-3-super-120b-a12b:free';
const CB_OPENROUTER_NEMOTRON_SUPER = 'ai:openrouter:nemotron-super';

// Hermes 3 405B Instruct (diagnostik, belum pernah dites live) — kandidat dari riset
// user via OpenRouter free tier. Uptime dilaporkan OpenRouter cuma ~55.79% (jauh di
// bawah Nemotron Super yang 97.85%), jadi TIDAK dipasang di rantai fallback produksi
// sama sekali (beda dari Nemotron Ultra/Super yang sempat jadi primary/fallback nyata)
// — satu-satunya jalur panggil adalah ?test_hermes=1, terisolasi total dari Call 1
// normal (lihat testHermesOnly), supaya kegagalan/lambatnya tidak pernah dirasakan user
// nyata di Ringkasan. Reuse counter budget 'openrouter' (account-wide, sama seperti
// Nemotron) via providerOverride di aiCall().
const HERMES_MODEL           = 'nousresearch/hermes-3-llama-3.1-405b:free';
const CB_OPENROUTER_HERMES   = 'ai:openrouter:hermes';

// Z.ai GLM 4.7 via Cerebras (diagnostik, session 163) — DITOLAK setelah dites live
// (2026-07-13): HTTP 400 "Please reduce the length of the messages or completion.
// Current length is 13029 while limit is 8192" — context window model ini di tier
// Preview Cerebras cuma 8192 token, jauh di bawah prompt Call 1 (~13K token dengan
// headline+kalender+OHLCV). Bukan bug kode (root-caused via perbaikan error-shape di
// aiCall(), lihat komentar di sana) — model-nya sendiri yang terlalu kecil context-nya
// untuk use case ini. Endpoint/API-key SAMA dengan CEREBRAS_URL/CEREBRAS_KEY yang sudah
// dipakai admin.js (fundamental_analysis) & journal.js (AI Coach) untuk gpt-oss-120b.
// Model id dikonfirmasi dari blog resmi Cerebras ("GLM-4.7: Frontier intelligence at
// record speed — now available on Cerebras", 8 Jan 2026): 355B params, tier "Preview"
// ("should not be used in production, as they may be discontinued on short notice").
// Jalur ?test_glm=1 TETAP ada (tidak dihapus, pola sama seperti kandidat lain yang
// ditolak) untuk jaga-jaga kalau Cerebras menaikkan context cap Preview-nya di masa
// depan — tapi TIDAK direkomendasikan lagi jadi kandidat primary/fallback Call 1.
const CEREBRAS_URL           = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL_GLM     = 'zai-glm-4.7';
const CB_CEREBRAS_GLM        = 'ai:cerebras:glm';

const MAJOR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

// Map pair label → Yahoo symbol for OHLCV context lookup
const OHLCV_SYMBOL_MAP = {
  'EUR/USD': 'EURUSD=X', 'GBP/USD': 'GBPUSD=X', 'USD/JPY': 'USDJPY=X',
  'AUD/USD': 'AUDUSD=X', 'USD/CAD': 'USDCAD=X', 'USD/CHF': 'USDCHF=X',
  'NZD/USD': 'NZDUSD=X', 'EUR/JPY': 'EURJPY=X', 'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X', 'AUD/JPY': 'AUDJPY=X', 'EUR/AUD': 'EURAUD=X',
  'GBP/AUD': 'GBPAUD=X', 'GBP/CAD': 'GBPCAD=X', 'XAU/USD': 'GC=F',
};

// Map non-USD major currency → its standard OHLCV pair label (for "today's dominant headline currency" lookup)
const CUR_TO_OHLCV_PAIR = {
  EUR: 'EUR/USD', GBP: 'GBP/USD', JPY: 'USD/JPY',
  CAD: 'USD/CAD', AUD: 'AUD/USD', NZD: 'NZD/USD', CHF: 'USD/CHF',
};

// CB_KW/kwTest moved to ./_cb_keywords.js (shared with feeds.js's storeNewsHistory,
// which needs the same map to decide which headlines are worth keeping a description for).
const GOLD_KEYWORDS = [
  // Direct gold references
  'gold','xau','bullion','spot gold','precious metal','gold price','gold demand','gold rally','gold drop',
  // Real yield / USD channel (gold's #1 driver)
  'real yield','tips yield','breakeven','inflation expect','10y yield','10-year yield','treasury yield','us yield','yield curve',
  'dxy','dollar index',
  // Fed / FOMC — USD fundamentals that directly drive XAU via rate/real yield channel
  'powell','warsh','fomc','federal reserve','fed rate','fed minutes','fed pivot','rate cut','rate hike',
  'us cpi','us inflation','nonfarm','nfp','us gdp','us jobs','us unemployment',
  // ETF / flow
  'gld','gold etf','etf flow','bullion etf','central bank buy','central bank gold','gold reserve',
  // Safe haven — gold-specific phrasing only
  'safe haven','haven demand','flight to safety','flight to gold',
  // Geopolitical — only phrasing explicitly tied to haven/gold impact
  'middle east tension','iran nuclear','russia ukraine','ukraine war','gold safe',
  // Iran / Hormuz — direct geopolitical risk → safe haven gold channel
  // 'iran' standalone: nearly all Iran headlines in financial news imply geopolitical risk
  'iran','hormuz','strait of hormuz','ofac sanction','iran nuclear deal',
  'iran oil','iran blockade','us-iran',
  // Risk sentiment — equities as risk-off/on proxy for haven demand
  'risk aversion','risk-off','risk off','risk-on','risk on',
  'vix spike','vix surge','equity sell-off','stock market crash','market rout','flight to bonds',
  // Geopolitical — broader triggers with clear haven implication
  'trade war','us china tariff','sanction escalat','nuclear threat','conflict escalat',
  // US-China trade / Trump geopolitical — risk-on/off driver affecting gold via sentiment channel
  // 'beijing' captures Trump China visit; 'trump xi' captures summit headlines
  'trump xi','beijing','china visit','us china trade','china trade deal','rare earth',
  // Dollar moves (non-DXY phrasing)
  'dollar rally','dollar drop','dollar strengthen','dollar weaken','usd rally','usd drop',
  // Precious metals family — comex is gold's primary venue
  'comex','silver price','silver rally','silver drop',
];

// ── XAU/USD spot price fetch (Yahoo GC=F → Binance PAXG fallback) ─────────────
async function fetchXauSpot() {
  try {
    const cached = await redisCmd('GET', 'xau_spot');
    if (cached) {
      const d = JSON.parse(cached);
      if (Date.now() - new Date(d.fetched_at).getTime() < 5 * 60 * 1000) return d;
    }
  } catch(e) {}

  const sf = await withSingleFlight(redisCmd, {
    lockKey: 'lock:xau_spot',
    cacheKey: 'xau_spot',
    isFresh: (raw) => { try { return Date.now() - new Date(JSON.parse(raw).fetched_at).getTime() < 5 * 60 * 1000; } catch(e) { return false; } },
  });
  if (!sf.gotLock && sf.fresh) return JSON.parse(sf.fresh);

  // Primary: Yahoo Finance GC=F (COMEX gold front-month futures)
  try {
    const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/GC=F?range=1d&interval=5m', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const json = await r.json();
      const meta  = json?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      const prev  = meta?.previousClose || meta?.chartPreviousClose;
      if (price && price > 0) {
        const changePct = prev ? +((price - prev) / prev * 100).toFixed(2) : null;
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: changePct, source: 'Yahoo GC=F', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        if (sf.gotLock) sf.release();
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Yahoo failed:', e.message); }

  // Fallback: Binance PAXGUSDT (24/7, no auth, tracks spot 1:1)
  try {
    const r = await fetch('https://api.binance.com/api/v3/ticker/24hr?symbol=PAXGUSDT', {
      signal: AbortSignal.timeout(6000),
    });
    if (r.ok) {
      const d = await r.json();
      const price     = parseFloat(d.lastPrice);
      const changePct = parseFloat(d.priceChangePercent);
      const prev      = parseFloat(d.openPrice);
      if (price > 0) {
        const wib = new Date(Date.now() + 7 * 3600000);
        const asOf = `${String(wib.getUTCHours()).padStart(2,'0')}:${String(wib.getUTCMinutes()).padStart(2,'0')} WIB`;
        const result = { price, prev_close: prev || null, change_pct: +changePct.toFixed(2), source: 'Binance PAXG', fetched_at: new Date().toISOString(), as_of: asOf };
        await redisCmd('SET', 'xau_spot', JSON.stringify(result), 'EX', 300);
        if (sf.gotLock) sf.release();
        return result;
      }
    }
  } catch(e) { console.warn('fetchXauSpot Binance failed:', e.message); }

  if (sf.gotLock) sf.release();
  return null;
}

// Read daily TA (RSI/SMA) from Redis cache (written by /api/correlations?action=ta).
// Generic — works for XAU (GC=F) and any FX pair Yahoo symbol.
async function fetchTaCache(symbol) {
  try {
    const cached = await redisCmd('GET', `ta:${symbol}:1d`);
    if (!cached) return null;
    const d = JSON.parse(cached);
    // Allow up to 2h stale — daily TA doesn't change fast
    if (Date.now() - new Date(d.computed_at).getTime() > 2 * 3600 * 1000) return null;
    return d;
  } catch(e) {
    console.warn(`fetchTaCache ${symbol} failed:`, e.message);
    return null;
  }
}
async function fetchXauTA() { return fetchTaCache('GC=F'); }

// Call 3 (trade thesis) schema constants + validators — pure functions, module scope
// so they're unit-testable without spinning up the full handler.
const THESIS_VALID_DIR        = ['long', 'short', 'no_trade'];
const THESIS_VALID_REG        = ['risk_on', 'risk_off', 'neutral'];
const THESIS_VALID_CURR       = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
const THESIS_VALID_XAU_BIAS   = ['bullish', 'bearish', 'neutral', 'conflicting'];
const THESIS_VALID_XAU_DRIVER = ['real_yield', 'safe_haven', 'risk_sentiment', 'usd_strength', 'insufficient_data'];
const THESIS_CURRENCY_CODE_RE = /\b(USD|EUR|GBP|JPY|CAD|AUD|NZD|CHF)\b/g;

// "USD/JPY" -> ['USD','JPY']; null kalau formatnya rusak, sisi kiri=kanan, atau bukan major currency.
function thesisPairCurrencies(pairRecommendation) {
  if (typeof pairRecommendation !== 'string') return null;
  const m = pairRecommendation.trim().toUpperCase().match(/^([A-Z]{3})\/([A-Z]{3})$/);
  if (!m) return null;
  const [, base, quote] = m;
  if (base === quote || !THESIS_VALID_CURR.has(base) || !THESIS_VALID_CURR.has(quote)) return null;
  return [base, quote];
}

// Cegah model mengutip currency di luar pair sebagai invalidation trigger — mis. event
// kalender CAD dipakai jadi alasan invalidasi thesis USD/JPY, padahal CAD bukan bagian
// pair itu. calBlock yang dikirim ke prompt berisi event dari semua 8 major currency
// (belum tentu currency pair yang direkomendasikan), jadi model bisa salah comot.
function thesisInvalidationCurrencyConsistent(parsed) {
  if (parsed.direction === 'no_trade') return true;
  const pairCurrencies = thesisPairCurrencies(parsed.pair_recommendation);
  if (!pairCurrencies) return false;
  const mentioned = String(parsed.invalidation_condition || '').match(THESIS_CURRENCY_CODE_RE) || [];
  return mentioned.every(code => pairCurrencies.includes(code));
}

function validateThesis(parsed) {
  return (
    THESIS_VALID_REG.includes(parsed.dominant_regime) &&
    THESIS_VALID_CURR.has(parsed.strongest_currency) &&
    THESIS_VALID_CURR.has(parsed.weakest_currency) &&
    THESIS_VALID_DIR.includes(parsed.direction) &&
    typeof parsed.confidence_1_to_5 === 'number' &&
    parsed.confidence_1_to_5 >= 1 && parsed.confidence_1_to_5 <= 5 &&
    THESIS_VALID_XAU_BIAS.includes(parsed.xau_bias) &&
    THESIS_VALID_XAU_DRIVER.includes(parsed.xau_dominant_driver) &&
    thesisInvalidationCurrencyConsistent(parsed)
  );
}

// ── Regime cross-check (plan G5) — jaring pengaman KODE, bukan instruksi prompt ──
// riskRegimeData.regime (4 tier mentah dari /api/risk-regime — ground truth VIX/MOVE/HY)
// dipakai sebagai sumber keputusan, BUKAN dominant_regime hasil restate AI (3 tier).
// Scope MVP: hanya tier paling ekstrem 'risk_off'; 'elevated' DITAHAN — pantau dulu
// frekuensi trigger via log sebelum diperluas (pola [QUAL-2]).
const REGIME_RISK_SENSITIVE = new Set(['AUD', 'NZD']);
const REGIME_SAFE_HAVEN     = new Set(['USD', 'JPY', 'CHF']);

// Pure function, dipanggil SETELAH validateThesis lolos & SEBELUM cache/return.
// Fail-open: riskRegimeData null/regime bukan risk_off/pair tak valid → thesis utuh.
// Saat trigger: cap confidence_1_to_5 maks 2 + field baru regime_note (bukan
// mengubah invalidation_condition yang punya validasi konsistensi currency sendiri).
function applyRegimeConfidenceGuard(thesis, riskRegimeData) {
  if (!thesis || !riskRegimeData || riskRegimeData.regime !== 'risk_off') return thesis;
  if (thesis.direction !== 'long' && thesis.direction !== 'short') return thesis;
  const pair = thesisPairCurrencies(thesis.pair_recommendation);
  if (!pair) return thesis;
  const [base, quote] = pair;
  const bought = thesis.direction === 'long' ? base : quote;
  const sold   = thesis.direction === 'long' ? quote : base;
  if (!(REGIME_RISK_SENSITIVE.has(bought) && REGIME_SAFE_HAVEN.has(sold))) return thesis;
  return {
    ...thesis,
    confidence_1_to_5: Math.min(thesis.confidence_1_to_5, 2),
    regime_note: `Regime pasar terukur (VIX dkk) sedang risk_off — posisi ini efektif long ${bought} (sensitif-risiko) vs ${sold} (safe haven), berlawanan dengan regime; confidence dibatasi maksimum 2.`,
  };
}

// ── Sign effect — bobot severitas data rilis (plan G3, Call 4 saja) ──────────
// Andersen/Bollerslev/Diebold/Vega 2003: berita "lemah" (bad news) historis
// menggerakkan harga lebih besar daripada berita kuat setara. Klasifikasi dihitung
// DI KODE dari actual vs forecast yang sudah rilis (bukan minta AI menilai sendiri).
// "Miss = lemah" TIDAK seragam per indikator — pakai mapping eksplisit dengan
// `invert` (pola sama dgn classifyIndicator di _labour_market.js):
//   invert=false → actual DI BAWAH forecast = pelemahan ekonomi (NFP, retail sales).
//   invert=true  → actual DI ATAS forecast = pelemahan (unemployment rate, claims).
// CPI/PPI/inflasi SENGAJA tidak di-mapping: miss inflasi itu ambigu (dovish, bukan
// "ekonomi lemah"). Indikator di luar mapping → netral, tanpa tag (fail-safe).
const SIGN_EFFECT_INDICATORS = [
  { key: 'nfp',           re: /non[- ]?farm (employment|payrolls?)|\bnfp\b/i,          invert: false },
  { key: 'adp',           re: /\badp\b.*employment|employment.*\badp\b/i,              invert: false },
  { key: 'retail_sales',  re: /retail sales/i,                                         invert: false },
  { key: 'gdp',           re: /\bgdp\b/i,                                              invert: false },
  { key: 'pmi_ism',       re: /\bpmi\b|\bism\b/i,                                      invert: false },
  { key: 'industrial',    re: /industrial production/i,                                invert: false },
  { key: 'consumer_conf', re: /consumer (confidence|sentiment)/i,                      invert: false },
  { key: 'unemployment',  re: /unemployment rate/i,                                    invert: true  },
  { key: 'claims',        re: /jobless claims|initial claims|continuing claims/i,      invert: true  },
];

const SEVERITY_TAG_WEAK = '[SEVERITAS: TINGGI — data lemah, dampak harga historis lebih besar (sign effect)]';

// "147K"/"3.5%"/"-0.2"/"1,250K" → angka absolut (K/M/B dikalikan; % apa adanya). null kalau bukan angka.
function parseEconNumber(s) {
  if (typeof s !== 'string') return null;
  const m = s.replace(/,/g, '').trim().match(/^(-?\d+(?:\.\d+)?)\s*([KMB%])?$/i);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const suf = (m[2] || '').toUpperCase();
  if (suf === 'K') v *= 1e3;
  else if (suf === 'M') v *= 1e6;
  else if (suf === 'B') v *= 1e9;
  return v;
}

// Pure function: { weak, magnitude, urgencyTag }. indicatorKey = teks bebas
// (judul headline/nama event) yang dicocokkan ke mapping di atas.
function classifyDataSurpriseSeverity(actual, forecast, indicatorKey) {
  const neutral = { weak: false, magnitude: 0, urgencyTag: '' };
  if (typeof actual !== 'number' || !isFinite(actual)) return neutral;
  if (typeof forecast !== 'number' || !isFinite(forecast)) return neutral;
  const cfg = SIGN_EFFECT_INDICATORS.find(c => c.re.test(String(indicatorKey || '')));
  if (!cfg) return neutral; // di luar mapping → jangan menebak arah
  const surprise = actual - forecast;
  if (surprise === 0) return neutral;
  const magnitude = +(Math.abs(surprise) / Math.max(Math.abs(forecast), 1e-9)).toFixed(4);
  const weak = cfg.invert ? surprise > 0 : surprise < 0;
  return { weak, magnitude, urgencyTag: weak ? SEVERITY_TAG_WEAK : '' };
}

// Ekstrak actual/forecast dari headline rilis format FinancialJuice
// ("US Nonfarm Payrolls Actual 147K (Forecast 110K, Previous 139K)") lalu
// klasifikasikan. Return tag string atau '' (headline non-rilis lolos tanpa tag).
function severityTagForHeadline(title) {
  const t = String(title || '');
  const am = t.match(/actual:?\s*(-?[\d.,]+\s*[KMB%]?)/i);
  const fm = t.match(/forecast:?\s*(-?[\d.,]+\s*[KMB%]?)/i);
  if (!am || !fm) return '';
  const actual   = parseEconNumber(am[1]);
  const forecast = parseEconNumber(fm[1]);
  if (actual == null || forecast == null) return '';
  return classifyDataSurpriseSeverity(actual, forecast, t).urgencyTag;
}

// Strip <think>...</think> blocks from Qwen3 thinking models — content after </think> is the actual response.
// Kalau tag <think> kebuka tapi tidak pernah ketutup (num_predict habis di tengah reasoning —
// terbukti session 162 lanjutan 4: user lapor output Nemotron kepotong & bahasa Inggris-Indonesia
// campur), regex fallback lama tidak match (butuh closing tag) sehingga seluruh raw reasoning
// ikut lolos ke user. Buang semua dari "<think>" ke akhir kalau tidak ada penutup — lebih baik
// hasil kosong/pendek (ke-reject validasi di call site) daripada bocorin reasoning mentah.
function stripThinking(text) {
  const lastClose = text.lastIndexOf('</think>');
  if (lastClose !== -1) return text.slice(lastClose + 8).trim();
  const openIdx = text.indexOf('<think>');
  if (openIdx !== -1) return text.slice(0, openIdx).trim();
  return text.trim();
}

// Nemotron 3 (session 145 lanjutan 3) toggles its reasoning trace via a literal
// "/think" / "/no_think" directive in the system prompt (NVIDIA's documented
// convention, same family as Qwen3's steering tokens) — not a separate API field like
// Ollama's `think` param used for GLM-5.2. Suspected root cause of the timeouts seen in
// live tests (both OpenRouter 25s and Ollama Cloud 18s): the model may default to
// generating a full reasoning trace before the real answer, which our use case (write a
// briefing, not solve a puzzle) doesn't need. Force /no_think for Nemotron calls only —
// other providers (SambaNova/Groq/gpt-oss) don't use this convention and must NOT get it
// injected into their prompt.
function withNoThink(messages) {
  const sysIdx = messages.findIndex(m => m.role === 'system');
  if (sysIdx !== -1) {
    const copy = messages.map(m => ({ ...m }));
    copy[sysIdx] = { ...copy[sysIdx], content: copy[sysIdx].content + '\n/no_think' };
    return copy;
  }
  return [{ role: 'system', content: '/no_think' }, ...messages];
}

// Shared low-level fetch for any OpenAI-compatible provider.
// providerOverride: SAMBANOVA_URL dan SAMBANOVA_URL_CALL1 (2 akun berbeda) identik
// string-nya, jadi providerFromUrl(url) tidak bisa membedakan akun — call site WAJIB
// kirim override eksplisit ('sambanova_main' / 'sambanova_c1') untuk SambaNova.
async function aiCall(url, apiKey, model, messages, maxTokens, temperature, timeoutMs, extraHeaders = {}, extraBody = {}, providerOverride = null) {
  // Guard kuota harian per provider — kalau habis, lempar error agar caller
  // jatuh ke provider berikutnya lewat jalur fallback yang sudah ada.
  if (!await allowAiCall(providerOverride || providerFromUrl(url))) {
    const e = new Error('AI_BUDGET_EXCEEDED');
    e.status = 429;
    throw e;
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}`, ...extraHeaders },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, ...extraBody }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // Providers vary in error shape: OpenAI-style nests it ({error:{message}}), Cerebras
    // returns it flat ({message, type, param, code}) — try both before falling back to a
    // generic status string (session 163: Cerebras GLM 400 got swallowed as "HTTP 400"
    // with zero detail because only the nested shape was checked).
    const e = new Error(err?.error?.message || err?.message || `HTTP ${res.status}`);
    e.status = res.status;
    throw e;
  }
  const data = await res.json();
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    console.warn(`aiCall truncated (finish_reason=length, model=${model}, max_tokens=${maxTokens})`);
  }
  const content = choice?.message?.content || '';
  return stripThinking(content).trim();
}

// Ollama Cloud — API native (BUKAN OpenAI-compatible), dipakai khusus untuk Nemotron 3
// Ultra (session 145 lanjutan). Pola & guard budget/error identik dengan _callOllama()
// di admin.js (dua file duplikasi sengaja per konvensi project ini — lihat komentar
// OPENROUTER_URL/MODEL di file lain untuk rasionalnya).
async function callOllama(apiKey, model, messages, maxTokens, temperature, timeoutMs, providerOverride, think = null) {
  if (!await allowAiCall(providerOverride)) {
    const e = new Error('AI_BUDGET_EXCEEDED');
    e.status = 429;
    throw e;
  }
  const body = { model, messages, stream: false, options: { temperature, num_predict: maxTokens } };
  if (think !== null) body.think = think;
  const t0 = Date.now();
  const r = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) { const e = new Error(`HTTP ${r.status}`); e.status = r.status; throw e; }
  const j = await r.json();
  const wallMs = Date.now() - t0;
  const serverMs = j?.total_duration != null ? Math.round(j.total_duration / 1e6) : null;
  console.log(`callOllama: model=${model} wall=${wallMs}ms server=${serverMs}ms eval_count=${j?.eval_count ?? '?'} prompt_eval_count=${j?.prompt_eval_count ?? '?'} done_reason=${j?.done_reason ?? '?'}`);
  if (j?.done_reason === 'length') {
    console.warn(`callOllama truncated (done_reason=length, model=${model}, num_predict=${maxTokens})`);
  }
  const content = j?.message?.content?.trim() || null;
  if (!content) throw new Error('Empty response');
  return stripThinking(content).trim();
}


// Read 1H OHLCV from Redis (written by ohlcv_sync cron) and format for AI context.
// Returns compact pre-processed block: 3D summary + raw 24H candles for entry context.
async function fetchOhlcvContext(symbol, label) {
  try {
    const isXau = symbol === 'GC=F';
    const isJpy = symbol.includes('JPY');
    const dec   = isXau ? 2 : isJpy ? 3 : 5;
    const fmt   = n => n.toFixed(dec);

    const fmtWib = ts => {
      const d = new Date((ts + 7 * 3600) * 1000);
      return `${String(d.getUTCMonth()+1).padStart(2,'0')}/${String(d.getUTCDate()).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}WIB`;
    };

    // Read all 3 timeframes in parallel
    const [raw1h, raw4h, raw1d] = await Promise.all([
      redisCmd('GET', `ohlcv:${symbol}:1h`),
      redisCmd('GET', `ohlcv:${symbol}:4h`),
      redisCmd('GET', `ohlcv:${symbol}:1d`),
    ]);

    const c1h     = raw1h ? JSON.parse(raw1h) : null;
    const c4h     = raw4h ? JSON.parse(raw4h) : null;
    const c1dFull = raw1d ? JSON.parse(raw1d) : null;    // s/d 135 bar (6 bulan) sejak ohlcv_sync range=6mo
    const c1d     = c1dFull ? c1dFull.slice(-30) : null; // blok "Daily 30D" tetap 30 bar biar labelnya jujur

    if (!c1h || c1h.length < 6) return null;

    const lines = [`=== ${label} MULTI-TIMEFRAME ===`];

    // ── Daily block — macro structure ─────────────────────────
    if (c1d && c1d.length >= 5) {
      const high1d = Math.max(...c1d.map(c => c.h));
      const low1d  = Math.min(...c1d.map(c => c.l));
      const curr1d = c1d[c1d.length - 1].c;
      const open1d = c1d[0].o;
      const chg1d  = +((curr1d - open1d) / open1d * 100).toFixed(2);

      const half   = Math.floor(c1d.length / 2);
      const avgOld = c1d.slice(0, half).reduce((s,c) => s+c.c, 0) / half;
      const avgNew = c1d.slice(half).reduce((s,c) => s+c.c, 0) / (c1d.length - half);
      const tPct   = (avgNew - avgOld) / avgOld * 100;
      const trend1d = tPct > 0.3 ? 'Uptrend' : tPct < -0.3 ? 'Downtrend' : 'Sideways';

      const topR = [...c1d].sort((a,b) => b.h - a.h).slice(0, 2).map(c => fmt(c.h));
      const botS = [...c1d].sort((a,b) => a.l - b.l).slice(0, 2).map(c => fmt(c.l));

      lines.push(`[MAKRO — Daily 30D] Range: ${fmt(low1d)}–${fmt(high1d)} | Now: ${fmt(curr1d)} | 30D: ${chg1d >= 0 ? '+' : ''}${chg1d}% | Trend: ${trend1d}`);
      lines.push(`  Resistance: ${topR.join(', ')} | Support: ${botS.join(', ')}`);

      // Anchor 6 bulan (guard >=40 bar: cache lama pre-6mo cuma 30 bar) — tanpa ini
      // AI tidak bisa membedakan "di puncak 6 bulan" vs "di tengah range" saat framing makro.
      if (c1dFull.length >= 40) {
        const hi6 = Math.max(...c1dFull.map(c => c.h));
        const lo6 = Math.min(...c1dFull.map(c => c.l));
        if (hi6 > lo6) {
          const pos6  = Math.round((curr1d - lo6) / (hi6 - lo6) * 100);
          const dist6 = ((curr1d - hi6) / hi6 * 100).toFixed(2);
          lines.push(`  [6 BULAN] Range: ${fmt(lo6)}–${fmt(hi6)} | Posisi now: ${pos6}% dari range (0%=low, 100%=high) | Jarak dari puncak 6M: ${dist6}%`);
        }
      }

      if (isXau) {
        const vArr = c1d.map(c => c.v).filter(v => v > 0);
        if (vArr.length > 3) {
          const vAvg  = Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length);
          const vLast = c1d[c1d.length - 1].v;
          const vStat = vLast > vAvg * 1.5 ? 'HIGH' : vLast < vAvg * 0.7 ? 'low' : 'Normal';
          lines.push(`  Volume avg: ${(vAvg/1000).toFixed(0)}K | Today: ${(vLast/1000).toFixed(0)}K [${vStat}]`);
        }
      }
    }

    // ── 4H block — swing structure ────────────────────────────
    if (c4h && c4h.length >= 6) {
      const high4h = Math.max(...c4h.map(c => c.h));
      const low4h  = Math.min(...c4h.map(c => c.l));
      const curr4h = c4h[c4h.length - 1].c;
      const open4h = c4h[0].o;
      const chg4h  = +((curr4h - open4h) / open4h * 100).toFixed(2);

      const recent10 = c4h.slice(-10);
      const avgOld4  = c4h.slice(0, c4h.length - 10).reduce((s,c) => s+c.c, 0) / Math.max(1, c4h.length - 10);
      const avgNew4  = recent10.reduce((s,c) => s+c.c, 0) / recent10.length;
      const tPct4    = (avgNew4 - avgOld4) / avgOld4 * 100;
      const trend4h  = tPct4 > 0.15 ? 'Uptrend' : tPct4 < -0.15 ? 'Downtrend' : 'Sideways';

      const sHigh = [...c4h].sort((a,b) => b.h - a.h)[0];
      const sLow  = [...c4h].sort((a,b) => a.l - b.l)[0];

      lines.push(`[SWING — 4H 10D] Range: ${fmt(low4h)}–${fmt(high4h)} | Trend: ${trend4h} | 10D: ${chg4h >= 0 ? '+' : ''}${chg4h}%`);
      lines.push(`  Swing High: ${fmt(sHigh.h)} (${fmtWib(sHigh.t)}) | Swing Low: ${fmt(sLow.l)} (${fmtWib(sLow.t)})`);
    }

    // ── 1H block — entry context ──────────────────────────────
    const c72 = c1h.slice(-72);
    const c24 = c1h.slice(-24);

    const high1h = Math.max(...c72.map(c => c.h));
    const low1h  = Math.min(...c72.map(c => c.l));
    const curr1h = c72[c72.length - 1].c;
    const open1h = c72[0].o;
    const chg1h  = +((curr1h - open1h) / open1h * 100).toFixed(2);

    const older1h = c72.slice(0, Math.max(1, c72.length - 24));
    const avgO1h  = older1h.reduce((s,c) => s+c.c, 0) / older1h.length;
    const avgN1h  = c24.reduce((s,c) => s+c.c, 0) / c24.length;
    const tPct1h  = (avgN1h - avgO1h) / avgO1h * 100;
    const trend1h = tPct1h > 0.08 ? 'Uptrend' : tPct1h < -0.08 ? 'Downtrend' : 'Sideways';

    lines.push(`[ENTRY — 1H 3D] Range: ${fmt(low1h)}–${fmt(high1h)} | Now: ${fmt(curr1h)} | 3D: ${chg1h >= 0 ? '+' : ''}${chg1h}% | Trend: ${trend1h}`);

    // Pre-compute vol avg (XAU only) for per-candle labelling
    let vAvg1h = 0;
    if (isXau) {
      const vArr = c72.map(c => c.v).filter(v => v > 0);
      vAvg1h = vArr.length > 0 ? Math.round(vArr.reduce((s,v) => s+v, 0) / vArr.length) : 0;
    }

    lines.push(`[24H candles — entry context:]`);
    c24.forEach(c => {
      const base = `${fmtWib(c.t)} H:${fmt(c.h)} L:${fmt(c.l)} C:${fmt(c.c)}`;
      if (isXau && c.v > 0 && vAvg1h > 0) {
        const vStat = c.v > vAvg1h * 1.5 ? ' [HIGH]' : c.v < vAvg1h * 0.7 ? ' [low]' : '';
        lines.push(`${base} V:${(c.v/1000).toFixed(1)}K${vStat}`);
      } else {
        lines.push(base);
      }
    });

    return lines.join('\n');
  } catch(e) {
    console.warn(`fetchOhlcvContext ${symbol}:`, e.message);
    return null;
  }
}

// Open (status:'open', non-empty thesis_text) journal entries for one device,
// newest first, capped at 5 — shared by the live per-request Call 4 (single
// device, from query ?device_id=) and the cron-scheduled multi-device sweep
// below (fetchOpenThesisEntries is called once per known device).
async function fetchOpenThesisEntries(deviceId) {
  const ids = await redisCmd('ZRANGE', `journal_index:${deviceId}`, 0, -1, 'REV') || [];
  const openEntries = [];
  for (const id of ids.slice(0, 10)) {
    try {
      const raw = await redisCmd('GET', `journal:${deviceId}:${id}`);
      if (!raw) continue;
      const entry = JSON.parse(raw);
      if (entry.status === 'open' && entry.thesis_text?.trim()) openEntries.push(entry);
      if (openEntries.length >= 5) break;
    } catch(e) {}
  }
  return openEntries;
}

// Call 4 — "does any recent headline contradict this trader's open thesis?".
// Extracted so it can run for one device inline (live request) or looped over
// every device with journal data (cron run — see thesis-monitor sweep below).
async function checkThesisContradictions(openEntries, recentItems, SAMBANOVA_KEY, GROQ_KEY) {
  const thesesBlock = openEntries.map((e, i) => `${i+1}. [ID:${e.id}] ${e.pair} ${(e.direction||'').toUpperCase()}: ${e.thesis_text}`).join('\n');
  const headlineTitles = recentItems.slice(0, 30).map(h => h.title);
  // Plan G3 (sign effect): tag severitas dihitung di kode dari actual vs forecast,
  // ditempel sebagai baris anotasi TERPISAH di bawah headline — bukan digabung ke
  // teks headline, supaya aturan copy-verbatim + validasi headlineSet tetap utuh.
  const headlines30 = headlineTitles.map((t, i) => {
    const tag = severityTagForHeadline(t);
    return `${i+1}. ${t}` + (tag ? `\n   ${tag}` : '');
  }).join('\n');
  const monitorPrompt = [
    'You are a forex trade thesis monitor.', '',
    'Open trade theses:', thesesBlock, '', 'Recent headlines (newest first):', headlines30, '',
    'Check if ANY headline directly contradicts or significantly undermines the stated reason for ANY open thesis.',
    'Only flag genuine contradictions — news that directly opposes the trade direction rationale, not tangentially related news.',
    'Ignore price-level headlines; focus on fundamental basis changes (macro data, CB policy shifts, geopolitical reversals).',
    'Ignore "Currency Strength Chart" / currency ranking headlines entirely — they are price-derived technical snapshots, not fundamental catalysts, and their "Strongest: A, B, C... - Weakest" ordering is easy to misread (do NOT use them as contradiction evidence even if a currency appears to sit in the strong or weak half).', '',
    'Some headlines are followed by an indented [SEVERITAS: ...] annotation line — it is computed from the released actual-vs-forecast numbers, not part of the headline. Treat those headlines as HIGHER-urgency contradiction candidates (weak data historically moves price more). Never copy the annotation into the "headline" field.', '',
    'The "headline" field MUST be copied verbatim, character-for-character, from the numbered list above — do not paraphrase or summarize it.',
    'The "entry_id" field MUST be copied verbatim from the [ID:...] tag of the thesis it contradicts.', '',
    'Return ONLY valid JSON, no markdown, no explanation:',
    '{"alerts":[{"entry_id":"...","headline":"exact headline text copied from the list above","reason":"one sentence why this contradicts the thesis"}]}',
    'If no genuine contradictions found: {"alerts":[]}',
  ].join('\n');
  const call4Messages = [{ role: 'user', content: monitorPrompt }];
  let raw4 = null;
  // Primary: SambaNova DeepSeek-V3.2 (akun 1) — same model used for Call 2 & 3
  if (SAMBANOVA_KEY && await cb.canCall(CB_SAMBA_MAIN)) {
    try {
      console.log('Call 4: trying SambaNova');
      raw4 = await aiCall(SAMBANOVA_URL, SAMBANOVA_KEY, SAMBANOVA_MODEL, call4Messages, 700, 0.1, 8000, {}, {}, 'sambanova_main');
      console.log('Call 4: SambaNova OK');
      await cb.onSuccess(CB_SAMBA_MAIN);
    } catch(e) {
      console.warn('Call 4 SambaNova failed:', e.status || e.message);
      await cb.onFailure(CB_SAMBA_MAIN, AI_CB_THRESHOLD);
    }
  }
  // Fallback: Groq llama-3.3-70b
  if (!raw4 && GROQ_KEY) {
    try {
      console.log('Call 4: falling back to Groq');
      raw4 = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, call4Messages, 700, 0.1, 8000);
      console.log('Call 4: Groq fallback OK');
    } catch(e) { console.warn('Call 4 Groq fallback failed:', e.status || e.message); }
  }
  if (!raw4) return null;
  const parsed4 = JSON.parse(raw4.replace(/```json|```/g, '').trim());
  if (!Array.isArray(parsed4.alerts)) return null;
  // A2.4: don't trust AI-echoed pair/direction/headline blindly — an LLM restating
  // structured fields drifts (e.g. "buy" instead of "long"), which silently breaks
  // the pair+direction match downstream and makes the alert invisible everywhere.
  // Cross-reference entry_id against server-known openEntries for pair/direction
  // (ground truth), and require the headline to appear verbatim in the source list
  // sent to the model — this rejects hallucinated "evidence" instead of showing a
  // trader a citation that was never actually published.
  const entryById = new Map(openEntries.map(e => [String(e.id), e]));
  const headlineSet = new Set(headlineTitles.map(t => t.trim().toLowerCase()));
  const validated = [];
  for (const a of parsed4.alerts) {
    if (!a || typeof a !== 'object') continue;
    const entry = entryById.get(String(a.entry_id));
    if (!entry) { console.warn('Call 4: dropped alert — unknown entry_id', a.entry_id); continue; }
    const headline = typeof a.headline === 'string' ? a.headline.trim() : '';
    if (!headline || !headlineSet.has(headline.toLowerCase())) {
      console.warn('Call 4: dropped alert — headline not verbatim in source feed:', headline.slice(0, 80));
      continue;
    }
    const reason = typeof a.reason === 'string' ? a.reason.trim() : '';
    if (!reason) continue;
    validated.push({ entry_id: entry.id, pair: entry.pair, direction: entry.direction, headline, reason });
  }
  console.log('Call 4: found', parsed4.alerts.length, 'raw alert(s),', validated.length, 'validated');
  return validated;
}

// Maps push_subs (keyed by endpoint hash) down to device_id → subscription, so
// the cron thesis sweep can push-notify a specific device about its own alert.
// device_id is only present on subs registered after A2.6 (see subscribe.js) —
// older subscriptions without it are simply skipped for this targeted push.
async function loadPushSubsByDevice() {
  const map = new Map();
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try {
          const sub = JSON.parse(raw[i + 1]);
          if (sub.device_id) map.set(sub.device_id, sub);
        } catch(e) {}
      }
    }
  } catch(e) { console.warn('loadPushSubsByDevice failed:', e.message); }
  return map;
}

// Thesis Alert sweep for scheduled runs — Call 4 (single-device, inline in the
// handler) only checks the ONE device that made a live request; on the 3x/day
// cron runs there's no device_id, so Call 4 is skipped entirely and
// thesis_alerts silently expires 30 min after the trader's last live "Ringkas
// Ulang" tap. That made Thesis Alert the only thing in the app that wasn't
// automatic/scheduled like the digest or the XAU/USD analysis.
// Fix: on cron runs, loop every device that has ever saved a journal entry
// (`journal_devices`, populated by journal.js on entry create), run the same
// contradiction check for each, cache the result long enough to survive until
// the next scheduled run, and push-notify the device if a NEW contradiction
// (not already alerted) is found.
//
// Called fire-and-forget (not awaited) from the handler, same pattern as
// notifyDigestReady() below — the GitHub Actions cron curls this endpoint with
// `--max-time 55` (see market-digest.yml) and Vercel's own maxDuration is 60s;
// awaiting a per-device AI sweep here would stack on top of Call 1-3's own
// latency and could blow both budgets, timing out the ENTIRE digest response
// (article/bias/thesis) just to finish a side-effect. Devices within the sweep
// still run concurrently (Promise.allSettled, not a sequential loop) so a
// slow/failing provider for one device doesn't multiply into the others.
async function runCronThesisSweep(recentItems, SAMBANOVA_KEY, GROQ_KEY) {
  const CRON_THESIS_TTL = 8 * 60 * 60; // 8h — spans the ~5-7h gap between the 3 daily runs
  const deviceIds = (await redisCmd('SMEMBERS', 'journal_devices') || []).slice(0, 10);
  if (deviceIds.length === 0) return;
  const subsByDevice = await loadPushSubsByDevice();
  await Promise.allSettled(deviceIds.map(async devId => {
    try {
      const openEntries = await fetchOpenThesisEntries(devId);
      if (openEntries.length === 0) return;
      let prevAlerts = [];
      try {
        const prevRaw = await redisCmd('GET', `thesis_alerts:${devId}`);
        if (prevRaw) prevAlerts = JSON.parse(prevRaw);
      } catch(e) {}
      const prevKeys = new Set((Array.isArray(prevAlerts) ? prevAlerts : []).map(a => `${a.entry_id}|${a.headline}`));
      const validated = await checkThesisContradictions(openEntries, recentItems, SAMBANOVA_KEY, GROQ_KEY);
      if (validated === null) return;
      if (validated.length > 0) {
        await redisCmd('SET', `thesis_alerts:${devId}`, JSON.stringify(validated), 'EX', CRON_THESIS_TTL);
      } else {
        await redisCmd('DEL', `thesis_alerts:${devId}`);
      }
      const freshAlerts = validated.filter(a => !prevKeys.has(`${a.entry_id}|${a.headline}`));
      if (freshAlerts.length > 0) {
        const sub = subsByDevice.get(devId);
        if (sub && configureVapid()) {
          const first = freshAlerts[0];
          const payload = {
            title: `⚠ Thesis Alert · ${first.pair} ${(first.direction || '').toUpperCase()}`,
            body: freshAlerts.length > 1 ? `${freshAlerts.length} headline kontra thesis terbuka` : first.reason,
            url: '/#ringkasan', icon: '/icon.svg',
          };
          const staleKeys = await sendWebPush([sub], payload);
          if (staleKeys.length > 0) await redisCmd('HDEL', 'push_subs', ...staleKeys).catch(() => {});
        }
      }
    } catch(e) { console.warn('Cron thesis sweep failed for device', devId, ':', e.message); }
  }));
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  console.log('market-digest v3 START', new Date().toISOString());
  const handlerStart = Date.now();
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Cached mode — serve last saved digest from Redis, no AI calls
  if (req.query?.mode === 'cached') {
    try {
      const raw = await redisCmd('GET', 'latest_article');
      const cachedDeviceId = req.query?.device_id;
      let cachedAlerts = null;
      if (cachedDeviceId) {
        try {
          const alertsRaw = await redisCmd('GET', `thesis_alerts:${cachedDeviceId}`);
          if (alertsRaw) cachedAlerts = JSON.parse(alertsRaw);
        } catch(e) { /* skip — non-critical */ }
      }
      if (raw) return res.status(200).json({ ...JSON.parse(raw), from_cache: true, thesis_alerts: cachedAlerts });
    } catch(e) { console.warn('cached mode Redis read failed:', e.message); }
    return res.status(200).json({ from_cache: true, article: null });
  }

  // Auth for scheduled session-open runs (Vercel cron sends x-vercel-cron; GitHub
  // Actions/cron-job.org fallback sends x-cron-secret) — these bypass the per-IP
  // rate limit below since they're 3 authenticated calls/day, not user traffic.
  // No device_id on these calls, which is intentional: Call 4 (thesis monitor,
  // gated on `&& deviceId` further down) is per-user journal data and is skipped,
  // while the shared briefing/bias/thesis still generate and populate the cache
  // every user's dashboard reads via mode=cached.
  const isVercelCron = req.headers['x-vercel-cron'] === '1';
  const cronSecret    = req.headers['x-cron-secret'];
  const isCronCall    = isVercelCron || (cronSecret && cronSecret === process.env.CRON_SECRET);

  // Multi-provider AI calls — rate limit to 4 req/min per IP
  if (!isCronCall && await rateLimit(req, res, { limit: 4, windowSecs: 60, endpoint: 'market-digest' })) return;
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('x-vercel-cache', 'BYPASS');

  // Single-flight throttle (non-cron only): kalau ada request LAIN yang lagi generate
  // atau baru saja selesai generate dalam DIGEST_LOCK_TTL detik terakhir, jangan ikut
  // generate lagi — Call 1/2/3 hasilnya SAMA untuk semua orang (shared, bukan per-device,
  // lihat latest_article), jadi generate ulang cuma menghasilkan kalimat beda-beda dari
  // data yang sama, boros jatah AI harian (_ai_guard.js) untuk nol informasi baru.
  // Beda dari withSingleFlight()/_fetch_lock.js yang polling pendek (cocok untuk fetch
  // cepat ~1-2s) — generate digest bisa makan sampai 45-55s, jadi di sini losers TIDAK
  // polling, langsung sajikan `latest_article` apa adanya (walau dari cron beberapa jam
  // lalu) daripada ikut antre / ikut generate. TTL 55 detik ganda fungsi: mutex selama
  // generate aktif + jeda pendek setelah selesai (tidak di-release manual — biar TTL
  // alami jadi cooldown, request berikutnya yang datang saat TTL masih hidup otomatis
  // dapat hasil segar yang baru saja ditulis pemenang, tanpa perlu generate baru lagi).
  // Cron dikecualikan total — 3 jadwal tetap berjam-jam terpisah, tidak pernah tabrakan,
  // dan harus selalu generate fresh apapun kondisi cache.
  const DIGEST_LOCK_KEY = 'lock:market_digest_generate';
  const DIGEST_LOCK_TTL = 55;
  if (!isCronCall) {
    let gotDigestLock = true;
    try {
      gotDigestLock = !!(await redisCmd('SET', DIGEST_LOCK_KEY, '1', 'NX', 'EX', DIGEST_LOCK_TTL));
    } catch(e) { console.warn('Digest single-flight lock check failed (fail-open):', e.message); }
    if (!gotDigestLock) {
      try {
        const raw = await redisCmd('GET', 'latest_article');
        if (raw) {
          console.log('market-digest: single-flight busy — serving latest_article without generating');
          return res.status(200).json({ ...JSON.parse(raw), thesis_alerts: null, from_cache: 'busy' });
        }
      } catch(e) { console.warn('Digest single-flight cache read failed — falling through to generate:', e.message); }
      // Tidak ada cache sama sekali (cold start) — lanjut generate walau lock dipegang
      // request lain, lebih baik dobel generate sesekali di awal daripada user dapat
      // respons kosong total.
    }
  }

  const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
  const SAMBANOVA_KEY  = process.env.SAMBANOVA_API_KEY;
  const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
  const GROQ_KEY       = process.env.GROQ_API_KEY;
  const OLLAMA_KEY     = process.env.OLLAMA_API_KEY;
  const CEREBRAS_KEY   = process.env.CEREBRAS_API_KEY;

  // Diagnostik sementara (session 145, pola sama seperti ?test_ollama=1 di admin.js
  // session 144): paksa Call 1/2/3 lewat Nemotron 3 Ultra saja, skip tier lain, supaya
  // bisa diverifikasi live sebelum jadi primary permanen (precedent: GLM-5.2/Kimi K2.6
  // "katanya gratis" ternyata 403 subscription-required saat dites nyata).
  const testNemotronOnly = req.query.test_nemotron === '1';

  // Diagnostik terpisah (session 145 lanjutan 5) untuk kandidat BERBEDA: Nemotron 3
  // SUPER (120B/12B active, lebih ringan dari Ultra) — cuma dites di Call 1 (prosa),
  // TIDAK di Call 2/3 (JSON, lihat Structured Output Error Rate 17.76% yang jadi alasan
  // pembatasan ini). Belum pernah dites live — disiapkan dulu, dijalankan setelah
  // konfirmasi user.
  const testNemotronSuperOnly = req.query.test_nemotron_super === '1';

  // Diagnostik Hermes 3 405B (lihat HERMES_MODEL) — sama pola isolasi seperti dua di
  // atas: skip semua tier lain di Call 1, dan (beda dari test_nemotron*) HASILNYA JUGA
  // tidak pernah ditulis ke digest_history/latest_article sama sekali — lihat
  // isIsolatedTest di bawah. Uptime rendah model ini membuat isolasi ekstra ini lebih
  // penting dibanding Nemotron yang sudah proven cukup sehat untuk diuji "semi-live".
  const testHermesOnly = req.query.test_hermes === '1';

  // Diagnostik Z.ai GLM 4.7 via Cerebras (lihat CEREBRAS_MODEL_GLM) — pola isolasi sama
  // seperti Hermes: skip semua tier lain di Call 1, hasil TIDAK ditulis ke
  // digest_history/latest_article (lihat isIsolatedTest di bawah).
  const testGlmOnly = req.query.test_glm === '1';
  const isIsolatedTest = testHermesOnly || testNemotronOnly || testNemotronSuperOnly || testGlmOnly;

  const host  = req.headers.host || 'financial-feed-app.vercel.app';
  const proto = host.includes('localhost') ? 'http' : 'https';

  // 1. RSS — current feed + 36h Redis history in parallel
  let rssItems = [];
  try {
    const cutoff36h = Date.now() - 36 * 60 * 60 * 1000;
    const histTimeout = new Promise(resolve => setTimeout(() => resolve(null), 3000));
    const [rssRes, histRaw] = await Promise.allSettled([
      fetch(`${proto}://${host}/api/feeds?type=rss`, { signal: AbortSignal.timeout(12000) }),
      Promise.race([redisCmd('ZRANGEBYSCORE', 'news_history', cutoff36h, '+inf'), histTimeout]),
    ]);

    let currentItems = [];
    if (rssRes.status === 'fulfilled' && rssRes.value.ok) {
      const xml = await rssRes.value.text();
      if (xml.includes('<rss')) currentItems = parseRSS(xml);
    }

    let historyItems = [];
    if (histRaw.status === 'fulfilled' && Array.isArray(histRaw.value)) {
      historyItems = histRaw.value.map(s => { try { return JSON.parse(s); } catch(_) { return null; } }).filter(Boolean);
    }

    // Merge: current RSS takes priority, dedup by guid
    const seen = new Set(currentItems.map(i => i.guid));
    const merged = [...currentItems, ...historyItems.filter(i => i.guid && !seen.has(i.guid))];
    rssItems = merged
      .filter(i => new Date(i.pubDate).getTime() > cutoff36h)
      .sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    console.log(`RSS items: ${currentItems.length} current + ${historyItems.length} history → ${rssItems.length} merged`);
  } catch(e) {
    console.warn('RSS/history fetch failed:', e.message);
  }

  const recentItems = rssItems.slice(0, 150);

  // 2. Calendar
  let calEvents = [];
  try {
    const [resThis, resNext] = await Promise.allSettled([
      fetch(FF_THIS_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
      fetch(FF_NEXT_WEEK, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FJFeed/1.0)' }, signal: AbortSignal.timeout(10000) }),
    ]);
    let allEvents = [];
    for (const result of [resThis, resNext]) {
      if (result.status === 'fulfilled' && result.value.ok) {
        const xml = await result.value.text();
        if (xml.includes('<event>')) allEvents = allEvents.concat(parseFFXML(xml));
      }
    }
    const nowWib = new Date(Date.now() + 7 * 3600000);
    const dateRange = new Set();
    for (let i = 0; i <= 3; i++) dateRange.add(toDateStr(new Date(nowWib.getTime() + i * 86400000)));
    const seen = new Set();
    calEvents = allEvents
      .filter(e => dateRange.has(e.date) && e.impact === 'High' && MAJOR_CURRENCIES.has(e.currency))
      .filter(e => { const k=`${e.date}|${e.time_wib}|${e.currency}|${e.event}`; if(seen.has(k))return false; seen.add(k); return true; })
      .sort((a,b) => (a.date+a.time_wib).localeCompare(b.date+b.time_wib));
  } catch(e) { console.warn('Cal:', e.message); }

  // 3. Context
  const wibNow  = new Date(Date.now() + 7 * 3600000);
  const dateStr = `${String(wibNow.getUTCDate()).padStart(2,'0')}/${String(wibNow.getUTCMonth()+1).padStart(2,'0')}/${wibNow.getUTCFullYear()}`;
  const timeStr = `${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;
  const DAYS_ID = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const dayStr  = DAYS_ID[wibNow.getUTCDay()];
  const isMonEarly = wibNow.getUTCDay() === 1 && wibNow.getUTCHours() < 15;
  const weekendNote = isMonEarly ? '\nCATATAN KONTEKS: Ini Senin pagi — bagian "12-36 jam lalu" mencakup weekend, volume berita tipis, tidak market-moving.' : '';
  // QUAL-12: pre-rank headlines by the same per-currency mention signal already used below to
  // pick the dominant OHLCV pair (~line 556) — float headlines tied to today's dominant currency
  // theme to the top so the model focuses there, instead of feeding 80 headlines in raw chronological
  // order with no relevance signal. Sort is stable, so recency order is preserved within equal scores.
  const _headlinesLowerForRank = recentItems.map(i => i.title.toLowerCase());
  const curMentionCounts = {};
  for (const cur of Object.keys(CB_KW)) {
    const count = _headlinesLowerForRank.filter(h => CB_KW[cur].some(kw => kwTest(h, kw))).length;
    if (count > 0) curMentionCounts[cur] = count;
  }
  const _headlineRelevance = title => {
    const lower = title.toLowerCase();
    return Object.entries(curMentionCounts).reduce((sum, [cur, count]) => (
      CB_KW[cur].some(kw => kwTest(lower, kw)) ? sum + count : sum
    ), 0);
  };
  const headlinesForBriefing = [...recentItems].sort((a, b) => _headlineRelevance(b.title) - _headlineRelevance(a.title)).slice(0, 80);
  const headlinesBlock = headlinesForBriefing.length > 0 ? headlinesForBriefing.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n') : '(Tidak ada headline)';
  // Beri tag status SUDAH RILIS / AKAN RILIS yang dihitung di kode (bukan diserahkan
  // ke LLM untuk hitung sendiri dari "date | time" mentah) — LLM nggak reliable buat
  // aritmatika tanggal/jam relatif, dan ini ketahuan bikin kesalahan nyata: event hari
  // ini jam 08:30 WIB yang sudah lewat (generate jam 19:30+) malah disebut "besok pagi"
  // di output, padahal datanya sudah rilis beberapa jam sebelumnya.
  function _calEventStatusTag(e) {
    if (!e.time_wib || e.time_wib === 'Tentative') return '';
    const [hStr, mStr] = e.time_wib.replace(' WIB', '').split(':');
    const h = parseInt(hStr, 10), m = parseInt(mStr, 10);
    if (isNaN(h) || isNaN(m)) return '';
    const [y, mo, d] = e.date.split('-').map(Number);
    const evMs = Date.UTC(y, mo - 1, d, h - 7, m); // WIB = UTC+7
    const diffH = (evMs - Date.now()) / 3600000;
    if (diffH < 0) {
      const ago = Math.abs(diffH) < 1 ? `${Math.round(Math.abs(diffH) * 60)} menit` : `${Math.round(Math.abs(diffH))} jam`;
      return ` [SUDAH RILIS ${ago} lalu — JANGAN sebut "besok"/"akan datang", actual mungkin belum masuk]`;
    }
    const until = diffH < 1 ? `${Math.round(diffH * 60)} menit` : `${Math.round(diffH)} jam`;
    return ` [AKAN RILIS dalam ${until}]`;
  }
  // Sertakan konsensus (Forecast/Previous) di tiap baris — bahan konkret untuk
  // instruksi "asymmetri beat/miss" di prompt, bukan sekadar nama event.
  const _calFP = e => (e.forecast || e.previous)
    ? ` [F: ${e.forecast || '—'} | P: ${e.previous || '—'}]`
    : '';
  const calBlock = calEvents.length > 0 ? calEvents.map(e=>`- ${e.date} | ${e.time_wib} | ${e.currency} | ${e.event}${_calFP(e)}${_calEventStatusTag(e)}`).join('\n') : '(Tidak ada event high-impact)';

  // Gold-specific headline filter — split recent vs historical so AI weights correctly
  const cutoff12h = Date.now() - 12 * 60 * 60 * 1000;
  const isGold = i => GOLD_KEYWORDS.some(kw => i.title.toLowerCase().includes(kw));
  const goldRecent = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() > cutoff12h).slice(0, 20);
  const goldOlder  = recentItems.filter(i => isGold(i) && new Date(i.pubDate).getTime() <= cutoff12h).slice(0, 15);
  const goldItems  = [...goldRecent, ...goldOlder];
  const goldBlock  = [
    goldRecent.length > 0
      ? `[12 JAM TERAKHIR — ${goldRecent.length} berita]\n${goldRecent.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '[12 JAM TERAKHIR] (tidak ada)',
    goldOlder.length > 0
      ? `\n[KONTEKS HISTORIS 12-36 JAM LALU — ${goldOlder.length} berita]\n${goldOlder.map((i,idx)=>`${idx+1}. ${i.title}`).join('\n')}`
      : '\n[KONTEKS HISTORIS 12-36 JAM LALU] (tidak ada)',
  ].join('');

  // Self-healing cache read: if the Redis key is cold (no cron populates these — they're
  // normally warmed by frontend tab visits), fetch the source endpoint directly so the
  // digest still gets fresh data, and the endpoint's own SET refreshes the cache for next time.
  async function fetchOrWarm(key, path, timeoutMs = 15000) {
    try {
      const cached = await redisCmd('GET', key);
      if (cached) return cached;
    } catch(e) {}
    try {
      // x-cron-secret: panggilan internal server-ke-server — wajib lolos gate APP_KEY
      // (_app_key.js) saat endpoint tujuan ikut digate.
      const r = await fetch(`${proto}://${host}${path}`, {
        headers: { 'x-cron-secret': process.env.CRON_SECRET || '' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (r.ok) return JSON.stringify(await r.json());
    } catch(e) { console.warn(`fetchOrWarm ${key} failed:`, e.message); }
    return null;
  }

  // 3b. Load digest history + xau history + real yields + XAU spot + XAU TA + liquidity + yield curve
  //     + risk regime (VIX/MOVE/HY) + rate path (Fed Funds futures) + cross-asset correlations + FX skew, in parallel
  let digestHistory = [], xauHistory = [], realYieldsData = null, xauSpot = null, xauTa = null, liqData = null, ycData = null, rawPrevThesis = null;
  let riskRegimeData = null, ratePathData = null, correlationsData = null, riskReversalData = null, cotData = null, polymarketData = null;
  try {
    const [rawHist, rawXauHist, rawRY, spotResult, taResult, rawLiq, rawYc, _rawPrevThesis, rawRisk, rawRate, rawCorr, rawRR, rawCot, rawPoly] = await Promise.all([
      redisCmd('LRANGE', 'digest_history', 0, 6),
      redisCmd('LRANGE', 'xau_history', 0, 3),
      redisCmd('GET', 'real_yields'),
      fetchXauSpot(),
      fetchXauTA(),
      redisCmd('GET', 'liquidity_usd'),
      redisCmd('GET', 'yield_curve'),
      redisCmd('GET', 'latest_thesis'),
      fetchOrWarm('risk_regime', '/api/risk-regime'),
      fetchOrWarm('rate_path', '/api/rate-path'),
      fetchOrWarm('correlations_v3', '/api/correlations'),
      fetchOrWarm('rr_cache_v2', '/api/correlations?action=risk-reversal'),
      // Distribusi makro → Ringkasan (2026-07-12): COT & Polymarket adalah konteks
      // makro (positioning mingguan institusional + probabilitas event pasar prediksi)
      // — masuk prompt Ringkasan sebagai INFORMASI, bukan sinyal. Cache-first seperti
      // blok lain; warm hanya kalau kosong.
      fetchOrWarm('cot_cache_v2', '/api/feeds?type=cot', 25000),
      fetchOrWarm('polymarket_signal_v3', '/api/admin?action=polymarket'),
    ]);
    rawPrevThesis = _rawPrevThesis;
    if (rawCot)  { try { cotData        = JSON.parse(rawCot);  } catch(_) {} }
    if (rawPoly) { try { polymarketData = JSON.parse(rawPoly); } catch(_) {} }
    if (Array.isArray(rawHist)) digestHistory = rawHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (Array.isArray(rawXauHist)) xauHistory = rawXauHist.map(e => { try { return JSON.parse(e); } catch(_) { return null; } }).filter(Boolean);
    if (rawRY) realYieldsData = JSON.parse(rawRY);
    xauSpot = spotResult;
    xauTa   = taResult;
    if (rawLiq)  { try { liqData          = JSON.parse(rawLiq);  } catch(_) {} }
    if (rawYc)   { try { ycData           = JSON.parse(rawYc);   } catch(_) {} }
    if (rawRisk) { try { riskRegimeData   = JSON.parse(rawRisk); } catch(_) {} }
    if (rawRate) { try { ratePathData     = JSON.parse(rawRate); } catch(_) {} }
    if (rawCorr) { try { correlationsData = JSON.parse(rawCorr); } catch(_) {} }
    if (rawRR)   { try { riskReversalData = JSON.parse(rawRR);   } catch(_) {} }
    console.log('XAU spot:', xauSpot ? `$${xauSpot.price} (${xauSpot.source})` : 'unavailable');
    console.log('XAU TA:', xauTa ? `RSI=${xauTa.rsi_14} SMA50=${xauTa.price_vs_sma50}` : 'unavailable (cache cold)');
    console.log('Risk regime:', riskRegimeData ? riskRegimeData.regime : 'unavailable (cache cold)');
  } catch(e) {}
  const historyBlock = digestHistory.length > 0
    ? digestHistory.map(h => `[${h.wib}] ${h.summary}`).join('\n')
    : '(Belum ada riwayat — ini sesi pertama)';
  const xauHistoryBlock = xauHistory.length > 0
    ? xauHistory.map(h => `[${h.wib}] ${h.xau_summary}`).join('\n')
    : '(Belum ada riwayat XAU — ini sesi pertama)';

  // Load OHLCV context: XAU always + FX pair picked from TODAY'S dominant headline currency
  // (falls back to previous thesis recommendation, then EUR/USD, if no major-currency headline today).
  let fxOhlcvSymbol = 'EURUSD=X', fxOhlcvLabel = 'EUR/USD';
  try {
    const headlinesLowerForPair = recentItems.map(i => i.title.toLowerCase());
    const curCounts = {};
    for (const cur of Object.keys(CUR_TO_OHLCV_PAIR)) {
      const count = headlinesLowerForPair.filter(h => CB_KW[cur].some(kw => kwTest(h, kw))).length;
      if (count > 0) curCounts[cur] = count;
    }
    const topCur = Object.entries(curCounts).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (topCur) {
      fxOhlcvSymbol = OHLCV_SYMBOL_MAP[CUR_TO_OHLCV_PAIR[topCur]];
      fxOhlcvLabel  = CUR_TO_OHLCV_PAIR[topCur];
      console.log(`OHLCV pair: dominant headline currency = ${topCur} (${curCounts[topCur]} mentions) → ${fxOhlcvLabel}`);
    } else if (rawPrevThesis) {
      const prevT = JSON.parse(rawPrevThesis);
      const rec = prevT?.pair_recommendation;
      if (rec && OHLCV_SYMBOL_MAP[rec] && OHLCV_SYMBOL_MAP[rec] !== 'GC=F') {
        fxOhlcvSymbol = OHLCV_SYMBOL_MAP[rec];
        fxOhlcvLabel  = rec;
        console.log(`OHLCV pair: no dominant headline currency today, falling back to prev thesis pair → ${fxOhlcvLabel}`);
      }
    }
  } catch(e) {
    console.warn('OHLCV pair selection failed, using default EUR/USD:', e.message);
  }
  let xauOhlcvBlock = null, fxOhlcvBlock = null, fxTa = null;
  try {
    [xauOhlcvBlock, fxOhlcvBlock, fxTa] = await Promise.all([
      fetchOhlcvContext('GC=F', 'XAU/USD'),
      fetchOhlcvContext(fxOhlcvSymbol, fxOhlcvLabel),
      fetchTaCache(fxOhlcvSymbol),
    ]);
    console.log('OHLCV context:', xauOhlcvBlock ? 'XAU ok' : 'XAU miss', fxOhlcvBlock ? `${fxOhlcvLabel} ok` : `${fxOhlcvLabel} miss`);
  } catch(e) {
    console.warn('OHLCV context load failed:', e.message);
  }

  // Build real yield block for Call 1 context
  let realYieldBlock = '(Data real yield tidak tersedia — inferensi dari headline saja)';
  if (realYieldsData?.currencies?.USD) {
    const ry = realYieldsData.currencies.USD;
    const trendNote = ry.real > 2.0 ? 'ELEVATED — tekanan struktural bearish pada XAU' : ry.real > 1.0 ? 'moderat' : 'rendah/negatif — relatif supportif XAU';
    realYieldBlock = `USD 10Y Nominal: ${ry.nominal}% | TIPS Breakeven: ${ry.inflation_exp}% | Real Yield: ${ry.real}% (${trendNote}) | per ${ry.as_of}`;
  }
  if (liqData?.tga_balance_bn != null) {
    const ch = liqData.tga_change_bn ?? 0;
    const tgaDir = ch > 5 ? `NAIK +$${ch}B (drain likuiditas)` : ch < -5 ? `TURUN $${ch}B (injeksi likuiditas)` : 'stabil';
    realYieldBlock += `\nLIKUIDITAS USD: TGA $${liqData.tga_balance_bn}B [${tgaDir}] | Fed Balance Sheet $${liqData.fed_assets_bn ?? '?'}B`;
    // RRP + net liquidity (WALCL − TGA − RRP) — kaki ketiga yang dulu hilang (2026-07-12)
    if (liqData.rrp_bn != null) {
      const rch = liqData.rrp_change_bn ?? 0;
      const rrpDir = rch > 5 ? `naik +$${rch}B (parkir uang bertambah = drain)` : rch < -5 ? `turun $${rch}B (uang keluar parkiran = injeksi)` : 'stabil';
      realYieldBlock += ` | RRP $${liqData.rrp_bn}B [${rrpDir}]`;
    }
    if (liqData.net_liquidity_bn != null) {
      realYieldBlock += `\nNET LIQUIDITY (Fed BS − TGA − RRP): $${liqData.net_liquidity_bn.toLocaleString('en-US')}B — pakai ini (bukan TGA saja) untuk klaim likuiditas dolar: TGA turun yang cuma pindah ke RRP BUKAN injeksi likuiditas nyata`;
    }
  }
  if (ycData?.USD?.spread_2y10y != null) {
    const spread = ycData.USD.spread_2y10y;
    const curveShape = spread < 0 ? 'INVERTED (recessionary signal)' : spread < 0.3 ? 'flat' : 'normal/steep';
    realYieldBlock += `\nYIELD CURVE USD: 2Y ${ycData.USD['2y'] ?? '?'}% | 10Y ${ycData.USD['10y'] ?? '?'}% | Spread 2Y10Y ${spread}% [${curveShape}]`;
  }

  // Build XAU spot block
  let xauSpotBlock = '(Data harga XAU tidak tersedia sesi ini — gunakan tekanan fundamental saja)';
  if (xauSpot) {
    const sign  = xauSpot.change_pct > 0 ? '+' : '';
    const pctStr = xauSpot.change_pct !== null ? ` (${sign}${xauSpot.change_pct}% dari sesi sebelumnya)` : '';
    xauSpotBlock = `${xauSpot.source}: $${xauSpot.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${pctStr} | per ${xauSpot.as_of}`;
  }

  // Build XAU daily TA block
  let xauTaBlock = '(Cache TA belum tersedia — kunjungi tab TEK untuk mengisi cache, atau abaikan bagian ini)';
  if (xauTa) {
    const parts = [];
    if (xauTa.rsi_14 != null) {
      const rsiLabel = xauTa.rsi_14 > 70 ? 'Overbought' : xauTa.rsi_14 < 30 ? 'Oversold' : 'Netral';
      parts.push(`RSI 14: ${xauTa.rsi_14.toFixed(1)} (${rsiLabel})`);
    }
    if (xauTa.sma_50 != null && xauTa.price_vs_sma50)
      parts.push(`SMA 50: ${xauTa.sma_50.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma50 === 'above' ? 'di atas' : 'di bawah'}`);
    if (xauTa.sma_200 != null && xauTa.price_vs_sma200)
      parts.push(`SMA 200: ${xauTa.sma_200.toLocaleString('en-US', {maximumFractionDigits:2})} — harga ${xauTa.price_vs_sma200 === 'above' ? 'di atas' : 'di bawah'}`);
    xauTaBlock = parts.length > 0 ? parts.join(' | ') : '(Data TA terbatas)';
  }

  // Build FX pair daily TA block (RSI/SMA) — same cache mechanism as XAU, keyed by recommended pair's symbol
  let fxTaBlock = '(Cache TA belum tersedia untuk pair ini — kunjungi tab TEK untuk mengisi cache)';
  if (fxTa) {
    const parts = [];
    if (fxTa.rsi_14 != null) {
      const rsiLabel = fxTa.rsi_14 > 70 ? 'Overbought' : fxTa.rsi_14 < 30 ? 'Oversold' : 'Netral';
      parts.push(`RSI 14: ${fxTa.rsi_14.toFixed(1)} (${rsiLabel})`);
    }
    if (fxTa.sma_50 != null && fxTa.price_vs_sma50)
      parts.push(`SMA 50 — harga ${fxTa.price_vs_sma50 === 'above' ? 'di atas' : 'di bawah'}`);
    if (fxTa.sma_200 != null && fxTa.price_vs_sma200)
      parts.push(`SMA 200 — harga ${fxTa.price_vs_sma200 === 'above' ? 'di atas' : 'di bawah'}`);
    fxTaBlock = parts.length > 0 ? parts.join(' | ') : '(Data TA terbatas)';
  }

  // Build risk regime block (VIX/MOVE/HY) — ground-truth for risk-on/off claims instead of inferring from headlines
  let riskRegimeBlock = '(Data risk regime tidak tersedia — inferensi risk-on/off dari headline saja)';
  if (riskRegimeData) {
    const r = riskRegimeData;
    const parts = [`Regime: ${(r.regime || 'unknown').toUpperCase()}`];
    if (r.vix != null) parts.push(`VIX ${r.vix}${r.vix_change_2d != null ? ` (${r.vix_change_2d >= 0 ? '+' : ''}${r.vix_change_2d} 2d)` : ''}`);
    if (r.move != null) parts.push(`MOVE ${r.move}${r.move_change_2d != null ? ` (${r.move_change_2d >= 0 ? '+' : ''}${r.move_change_2d} 2d)` : ''}`);
    if (r.hy_spread != null) parts.push(`HY OAS ${r.hy_spread}%${r.hy_change_2d != null ? ` (${r.hy_change_2d >= 0 ? '+' : ''}${r.hy_change_2d} 2d)` : ''}`);
    if (r.vix_term_structure?.structure) parts.push(`VIX term structure: ${r.vix_term_structure.structure}`);
    riskRegimeBlock = parts.join(' | ');
  }

  // Build rate path block (market-implied Fed Funds path) — ground-truth for "rate differential" mechanism claims
  let ratePathBlock = '(Data rate path tidak tersedia — inferensi rate differential dari headline saja)';
  if (ratePathData?.USD?.cumulative_3m_bps != null) {
    const rp = ratePathData.USD;
    const dir3m = rp.cumulative_3m_bps < 0 ? `${Math.abs(rp.cumulative_3m_bps)}bps CUT priced (3m)` : rp.cumulative_3m_bps > 0 ? `${rp.cumulative_3m_bps}bps HIKE priced (3m)` : 'tidak ada perubahan diharga (3m)';
    const parts = [`USD: ${dir3m}`];
    if (rp.cumulative_6m_bps != null) {
      const dir6m = rp.cumulative_6m_bps < 0 ? `${Math.abs(rp.cumulative_6m_bps)}bps CUT (6m)` : rp.cumulative_6m_bps > 0 ? `${rp.cumulative_6m_bps}bps HIKE (6m)` : 'flat (6m)';
      parts.push(dir6m);
    }
    ratePathBlock = parts.join(' | ');
  }

  // Build cross-asset correlation block — anomalies (regime breaks) + gold's key correlations + FX grounding
  let correlationBlock = '(Data korelasi cross-asset tidak tersedia)';
  if (correlationsData) {
    const lines = [];
    // Anomali: prioritaskan pasangan yang relevan ke Gold/DXY (relevance-aware), baru sisanya by |delta|
    if (Array.isArray(correlationsData.anomalies) && correlationsData.anomalies.length > 0) {
      const isRelevant = (a) => /Gold|DXY/.test(a.label);
      const ranked = [...correlationsData.anomalies].sort((a, b) => {
        const ra = isRelevant(a) ? 1 : 0, rb = isRelevant(b) ? 1 : 0;
        if (ra !== rb) return rb - ra;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
      const dirHint = (a) => {
        const sameSign = (a.r20 >= 0) === (a.r60 >= 0);
        return sameSign ? 'melemah/menguat (arah sama)' : 'berbalik arah (sign-flip)';
      };
      lines.push('Anomali korelasi 20D vs 60D (deviasi >0.4 dari norma — sinyal regime berubah, prioritas Gold/DXY): ' +
        ranked.slice(0, 5).map(a => `${a.label} (20D:${a.r20} vs 60D:${a.r60}, Δ${a.delta}, ${dirHint(a)})`).join('; '));
    }
    if (correlationsData.gold_correlations && Object.keys(correlationsData.gold_correlations).length > 0) {
      lines.push('Korelasi Gold (20D vs norma 60D): ' +
        Object.entries(correlationsData.gold_correlations).map(([k, v]) =>
          `${k}:${v.r20 ?? '?'} (norma60D:${v.r60 ?? '?'}, Δ${v.delta ?? '?'})`).join(', '));
    }
    // Grounding korelasi FX — pasangan yang sering dipakai narasi benang merah FX
    if (correlationsData.matrix_20d && correlationsData.matrix_60d) {
      const getPair = (a, b) => {
        const k1 = `${a}|${b}`, k2 = `${b}|${a}`;
        const r20 = correlationsData.matrix_20d[k1] ?? correlationsData.matrix_20d[k2];
        const r60 = correlationsData.matrix_60d[k1] ?? correlationsData.matrix_60d[k2];
        return (r20 == null || r60 == null) ? null : { r20, r60 };
      };
      const FX_PAIRS = [['DXY','EUR'], ['DXY','GBP'], ['DXY','AUD'], ['DXY','JPY'], ['AUD','SPX'], ['JPY','US10Y']];
      const fxLines = FX_PAIRS.map(([a, b]) => {
        const d = getPair(a, b);
        return d ? `${a}-${b}:${d.r20} (60D:${d.r60})` : null;
      }).filter(Boolean);
      if (fxLines.length > 0) {
        lines.push('Korelasi FX (20D vs norma 60D): ' + fxLines.join(', '));
      }
    }
    correlationBlock = lines.length > 0 ? lines.join('\n') : '(Tidak ada anomali signifikan — korelasi sesuai norma historis)';
  }

  // Build FX/XAU options positioning block (25-delta risk reversal skew) — institutional positioning signal
  // Umur data disisipkan di sini (bukan cuma di CATATAN STALENESS generik) karena TTL-nya
  // sekarang 6 jam (session 157 lanjutan 4, naik dari 1 jam — lihat correlations.js) —
  // AI perlu tahu persis seberapa basi angka ini, sama seperti pola makroAgeH di ohlcv_analyze.
  let riskReversalBlock = '(Data risk reversal/skew opsi tidak tersedia)';
  if (riskReversalData?.available && riskReversalData.pairs) {
    const entries = Object.entries(riskReversalData.pairs);
    if (entries.length > 0) {
      riskReversalBlock = entries.map(([pair, d]) => {
        const skew = d.rr_value;
        const lean = skew > 0.05 ? 'call-skewed (bullish bias)' : skew < -0.05 ? 'put-skewed (bearish bias)' : 'netral';
        return `${pair}: ${skew} (${lean})`;
      }).join(' | ');
      const rrAgeH = riskReversalData.computed_at ? (Date.now() - new Date(riskReversalData.computed_at).getTime()) / 3600000 : null;
      if (rrAgeH != null && !isNaN(rrAgeH) && rrAgeH >= 0) {
        riskReversalBlock += ` [data ${rrAgeH < 1 ? '<1' : Math.round(rrAgeH * 10) / 10} jam lalu]`;
      }
    }
  }

  // Build COT positioning block — konteks makro POSITIONING mingguan (CFTC), masuk
  // Ringkasan sebagai INFORMASI: siapa yang sudah berat sebelah, bukan sinyal arah.
  // %OI = net dinormalisasi ke open interest; P## = percentile 3 tahun (ekstremitas).
  let cotBlock = '(Data COT tidak tersedia)';
  if (cotData?.positions && Object.keys(cotData.positions).length > 0) {
    const ORDER = ['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF'];
    const k = n => `${n >= 0 ? '+' : ''}${(n / 1000).toFixed(1)}K`;
    const lines = [];
    for (const cur of ORDER) {
      const p = cotData.positions[cur];
      if (!p || typeof p.lev_net !== 'number') continue;
      const pct = cotData.percentiles?.[cur];
      const levTag = [
        typeof p.lev_change_net === 'number' ? `${k(p.lev_change_net)} w/w` : null,
        p.lev_net_pct_oi != null ? `${p.lev_net_pct_oi > 0 ? '+' : ''}${p.lev_net_pct_oi}% OI` : null,
        pct?.lev_pctile != null ? `P${pct.lev_pctile}/3thn${pct.lev_pctile >= 90 ? ' EKSTREM-LONG' : pct.lev_pctile <= 10 ? ' EKSTREM-SHORT' : ''}` : null,
      ].filter(Boolean).join(', ');
      const amTag = [
        p.am_net_pct_oi != null ? `${p.am_net_pct_oi > 0 ? '+' : ''}${p.am_net_pct_oi}% OI` : null,
        pct?.am_pctile != null ? `P${pct.am_pctile}/3thn` : null,
      ].filter(Boolean).join(', ');
      lines.push(`${cur}: Lev net ${k(p.lev_net)}${levTag ? ` (${levTag})` : ''} | AM net ${typeof p.am_net === 'number' ? k(p.am_net) : '?'}${amTag ? ` (${amTag})` : ''}`);
    }
    if (lines.length > 0) {
      cotBlock = lines.join('\n');
      if (cotData.report_date) cotBlock += `\n[posisi per ${cotData.report_date} — COT dirilis mingguan, ini positioning TERPASANG, bukan arah hari ini]`;
    }
  }

  // Build Polymarket block — konteks makro SENTIMEN pasar prediksi. Δ1d = pergeseran
  // probabilitas 24 jam (poin persen) — pergeseran besar lebih informatif dari levelnya.
  let polymarketBlock = '(Data prediction market tidak tersedia)';
  if (Array.isArray(polymarketData?.markets) && polymarketData.markets.length > 0) {
    const withProb = polymarketData.markets.filter(m => m.yes_prob != null);
    const movers = withProb
      .filter(m => m.change_1d != null && Math.abs(m.change_1d) >= 4)
      .sort((a, b) => Math.abs(b.change_1d) - Math.abs(a.change_1d))
      .slice(0, 4);
    const rest = withProb
      .filter(m => !movers.includes(m))
      .sort((a, b) => (b.volume24h || 0) - (a.volume24h || 0))
      .slice(0, Math.max(0, 6 - movers.length));
    const fmt = m => {
      const chg = m.change_1d != null && m.change_1d !== 0 ? ` (Δ1d ${m.change_1d > 0 ? '+' : ''}${m.change_1d}pp)` : '';
      return `- [${m.category}] "${m.question}" → ${m.yes_prob}% YA${chg}`;
    };
    const lines = [...movers.map(fmt), ...rest.map(fmt)];
    if (lines.length > 0) {
      polymarketBlock = lines.join('\n');
      if (movers.length > 0) polymarketBlock += `\n[${movers.length} market teratas diurutkan berdasar pergeseran 24 jam terbesar — pergeseran tajam = pasar prediksi baru berubah pikiran, cek apakah headline menjelaskan kenapa]`;
    }
  }

  // 3c. Load externalized prompts from Redis — fall back to hardcoded if missing
  let promptDigestInstr = null;
  try {
    promptDigestInstr = await redisCmd('GET', 'prompt_digest');
  } catch(e) {
    console.warn('prompt_digest Redis load failed:', e.message);
  }

  // Pre-fire Call 2 (CB bias) and Call 4 (thesis monitor) concurrently with Call 1.
  // Both only need recentItems (already available) — no dependency on Call 1's article.
  const deviceId = req.query?.device_id;

  const _biasPromise = recentItems.length > 0 ? (async () => {
    const _biasUpdated = [];
    // CB_KW / kwTest are defined at module level — shared with the OHLCV dominant-pair lookup above.
    const relevantCurrencies = [];
    const headlinesLower = recentItems.map(i => i.title.toLowerCase());
    for (const [cur, kws] of Object.entries(CB_KW)) {
      if (kws.some(kw => headlinesLower.some(h => kwTest(h, kw)))) relevantCurrencies.push(cur);
    }
    console.log('relevantCurrencies (async):', JSON.stringify(relevantCurrencies));
    if (relevantCurrencies.length > 0) {
      const relevantHeadlines = recentItems.filter(i => {
        const lower = i.title.toLowerCase();
        return relevantCurrencies.some(cur => CB_KW[cur].some(kw => kwTest(lower, kw)));
      });
      // Description (when captured — see isCbHeadline in parseRSS/parseRSSItems) gives the
      // model actual content instead of just a title, which for wire-service boilerplate
      // ("RBNZ Interest Rate Probabilities") carries zero directional signal on its own.
      const biasHeadlines = relevantHeadlines.slice(0, 50).map((i,idx) => {
        const desc = i.description ? ' — ' + stripHtml(i.description).slice(0, 200) : '';
        return (idx+1) + '. ' + i.title + desc;
      }).join('\n');
      const biasCurrencies = relevantCurrencies.join(', ');
      // A1.1: read prior stance (read-only — the write path below still re-reads under lock
      // right before saving) + live policy rates, so the model judges a SHIFT, not an absolute stance.
      let prevBiasMap = {};
      try { const prevBiasRaw = await redisCmd('GET', 'cb_bias'); if (prevBiasRaw) prevBiasMap = JSON.parse(prevBiasRaw); } catch(e) {}
      let cbRatesMap = {};
      try {
        const cbRatesArr = await getLiveCbRates();
        cbRatesMap = Object.fromEntries(cbRatesArr.map(r => [r.currency, r.rate]));
      } catch(e) { console.warn('Call 2: getLiveCbRates failed:', e.message); }
      const priorStanceLines = relevantCurrencies.map(cur => {
        const prev = prevBiasMap[cur];
        const stanceStr = prev ? `stance sebelumnya = "${prev.bias}" (confidence ${prev.confidence}, ${prev.updated_at ? prev.updated_at.slice(0, 10) : '-'})` : 'stance sebelumnya = belum ada';
        const rate = cbRatesMap[cur];
        const rateStr = rate != null ? `policy rate sekarang = ${rate}%` : 'rate = n/a';
        return `${cur}: ${stanceStr}; ${rateStr}`;
      }).join('\n');
      const priorStanceSection = priorStanceLines ? [
        '', '=== PRIOR STANCE & POLICY RATE (gunakan sebagai titik acuan — nilai PERGESERAN, bukan stance absolut dari nol) ===',
        priorStanceLines,
      ].join('\n') : '';
      const fundDataForPrompt = {};
      try {
        await Promise.all(relevantCurrencies.map(async cur => {
          const fields = await redisCmd('HGETALL', `fundamental:${cur}`);
          if (Array.isArray(fields) && fields.length > 0) {
            const obj = {};
            for (let i = 0; i < fields.length; i += 2) { try { obj[fields[i]] = JSON.parse(fields[i + 1]); } catch(_) {} }
            fundDataForPrompt[cur] = obj;
          }
        }));
      } catch(e) { console.warn('Fundamental fetch for Call 2 failed:', e.message); }
      const fundLines = Object.entries(fundDataForPrompt).map(([cur, data]) => {
        const items = Object.entries(data).filter(([, v]) => v?.actual).map(([k, v]) => `${k}: ${v.actual}${v.previous ? ` (prev ${v.previous})` : ''} [${v.date || '—'}]`);
        return items.length ? `${cur}: ${items.slice(0, 8).join(', ')}` : null;
      }).filter(Boolean);
      const fundSection = fundLines.length > 0 ? [
        '', '=== LATEST MACRO FUNDAMENTALS (from headline releases — use as objective anchor) ===',
        fundLines.join('\n'),
        '(If fundamentals contradict headline sentiment: fundamentals may change the DIRECTION of the bias, not just lower confidence — actual data is more objective than headline tone.)',
      ].join('\n') : '';
      const biasPrompt = [
        'You are a central bank policy analyst. Based on the following recent financial news headlines AND the latest macro fundamental data, assess the current monetary policy stance for each central bank mentioned.',
        priorStanceSection,
        '- Hawkish/dovish is RELATIVE to the prior stance and market expectations. If a headline only CONFIRMS the prior stance, keep the prior bias and do NOT raise confidence. Only shift the bias when there is a clear NEW signal (rate change, guidance change, data surprise).',
        '', 'Headlines (sorted NEWEST first — #1 is most recent; weight recent signals higher, do not average in stale commentary already overtaken by newer data):', biasHeadlines, fundSection, '',
        'For each of these currencies that have relevant headlines: ' + biasCurrencies, '',
        '- Ignore headlines that ONLY report currency price action (e.g. "Yen falls to 161"). Judge stance ONLY from: CB official communication, rate decisions/signals, inflation/employment releases, or meeting minutes.',
        'Return ONLY a valid JSON object. No explanation, no markdown, no code block. Just the raw JSON.',
        'Use ONLY these exact bias values: "Hawkish", "Cautious Hawkish", "Neutral", "Data Dependent", "On Hold", "Cautious Dovish", "Dovish", "Split"',
        '  "Data Dependent" = CB explicitly defers direction, waiting on data (NOT hawkish/dovish — conditional neutral).',
        '  "On Hold" = rate held with no clear signal on the next move.',
        '  "Split" = MPC/governing council is divided (significant dissent vote).',
        'For confidence, use ONLY: "High", "Medium", "Low"',
        '  High = multiple clear, direct signals from officials or data releases',
        '  Medium = some signals but mixed or indirect',
        '  Low = minimal or ambiguous evidence — prefer omitting the currency over Low confidence', '',
        'Example format:', '{"USD":{"bias":"Cautious Hawkish","confidence":"High"},"EUR":{"bias":"Dovish","confidence":"Medium"}}', '',
        'Only include currencies where you have enough evidence. If insufficient evidence for a currency, OMIT it entirely — do not guess.',
      ].join('\n');
      const call2Messages = [{ role: 'user', content: biasPrompt }];
      let biasRaw = null;
      // Nemotron 3 Ultra — DIDEMOTE dari primary (session 145 lanjutan 4, lihat catatan
      // lengkap di Call 1). Hanya dicoba saat ?test_nemotron=1, tidak di jalur produksi.
      if (testNemotronOnly) {
        if (OLLAMA_KEY && await cb.canCall(CB_OLLAMA_NEMOTRON)) {
          try {
            console.log('Call 2: trying Nemotron 3 Ultra (Ollama Cloud)');
            biasRaw = await callOllama(OLLAMA_KEY, OLLAMA_NEMOTRON_MODEL, withNoThink(call2Messages), 700, 0.1, 15000, 'ollama');
            console.log('Call 2: Ollama Nemotron OK');
            await cb.onSuccess(CB_OLLAMA_NEMOTRON);
          } catch(e) { console.warn('Call 2 Ollama Nemotron failed:', e.status || e.message); await cb.onFailure(CB_OLLAMA_NEMOTRON, AI_CB_THRESHOLD); }
        }
        if (!biasRaw && OPENROUTER_KEY && await cb.canCall(CB_OPENROUTER_NEMOTRON)) {
          try {
            console.log('Call 2: trying Nemotron 3 Ultra (OpenRouter)');
            biasRaw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, NEMOTRON_MODEL, withNoThink(call2Messages), 700, 0.1, 10000, OPENROUTER_HEADERS, {}, 'openrouter');
            console.log('Call 2: OpenRouter Nemotron OK');
            await cb.onSuccess(CB_OPENROUTER_NEMOTRON);
          } catch(e) { console.warn('Call 2 OpenRouter Nemotron failed:', e.status || e.message); await cb.onFailure(CB_OPENROUTER_NEMOTRON, AI_CB_THRESHOLD); }
        }
      }
      if (!biasRaw && !testNemotronOnly && SAMBANOVA_KEY && await cb.canCall(CB_SAMBA_MAIN)) {
        try {
          console.log('Call 2: trying SambaNova');
          biasRaw = await aiCall(SAMBANOVA_URL, SAMBANOVA_KEY, SAMBANOVA_MODEL, call2Messages, 700, 0.1, 8000, {}, {}, 'sambanova_main');
          console.log('Call 2: SambaNova OK');
          await cb.onSuccess(CB_SAMBA_MAIN);
        } catch(e) { console.warn('Call 2 SambaNova failed:', e.status || e.message); await cb.onFailure(CB_SAMBA_MAIN, AI_CB_THRESHOLD); }
      } else if (!biasRaw && SAMBANOVA_KEY && !testNemotronOnly) { console.log('Call 2: SambaNova circuit OPEN — skipping to Groq'); }
      if (!biasRaw && !testNemotronOnly && GROQ_KEY) {
        try {
          console.log('Call 2: falling back to Groq');
          biasRaw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL, call2Messages, 700, 0.1, 12000);
          console.log('Call 2: Groq fallback OK');
        } catch(e) { console.warn('Call 2 Groq fallback failed:', e.status || e.message); }
      }
      if (biasRaw) {
        try {
          const clean = biasRaw.replace(/```json|```/g, '').trim();
          console.log('Call 2 bias raw:', biasRaw.substring(0, 300));
          const parsed = JSON.parse(clean);
          console.log('Call 2 bias parsed:', JSON.stringify(parsed));
          const VALID_BIASES = ['Hawkish','Cautious Hawkish','Neutral','Data Dependent','On Hold','Cautious Dovish','Dovish','Split'];
          // A1.5: hawk-dove magnitude is measured ONLY on this axis. "Data Dependent"/"On Hold"/"Split"
          // are orthogonal labels (not a degree of dovishness) — they map to 'Neutral' for magnitude
          // purposes so a Hawkish→On Hold transition isn't mistaken for a 4-level swing.
          const HAWK_DOVE_AXIS = ['Hawkish','Cautious Hawkish','Neutral','Cautious Dovish','Dovish'];
          const ORTHOGONAL_LABELS = new Set(['Data Dependent','On Hold','Split']);
          const VALID_CONFIDENCES = ['High','Medium','Low'];
          const VALID_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);
          // A1.6: AI may reply with different casing/whitespace — normalize before validating
          // instead of dropping an otherwise-valid signal on an exact-case mismatch.
          const BIAS_CANON = new Map(VALID_BIASES.map(b => [b.toLowerCase(), b]));
          const CONFIDENCE_CANON = new Map(VALID_CONFIDENCES.map(c => [c.toLowerCase(), c]));
          const now2 = new Date().toISOString();
          const lockAcquired = await redisCmd('SET', 'cb_bias_lock', '1', 'NX', 'EX', '10');
          if (lockAcquired) {
            let existing = {};
            try { const rawBias = await redisCmd('GET', 'cb_bias'); if (rawBias) existing = JSON.parse(rawBias); } catch(e) {}
            for (const [cur, entry] of Object.entries(parsed)) {
              const curOk = VALID_CURRENCIES.has(cur);
              const entryBias = (typeof entry === 'object' && entry !== null) ? entry.bias : entry;
              const confidenceRaw = (typeof entry === 'object' && entry !== null) ? entry.confidence : null;
              const bias = BIAS_CANON.get(String(entryBias).trim().toLowerCase());
              const confidence = CONFIDENCE_CANON.get(String(confidenceRaw).trim().toLowerCase());
              if (!curOk || !bias) continue;
              if (!confidence || confidence === 'Low') { console.log(`Call 2: skip ${cur} — confidence Low`); continue; }
              const prevEntry = existing[cur];
              const prevBias  = prevEntry?.bias;
              const kws = CB_KW[cur] || [];
              const freshHeadlines = recentItems
                .filter(i => kws.some(kw => kwTest(i.title.toLowerCase(), kw)))
                .slice(0, 5)
                .map(i => ({ title: i.title, description: i.description ? stripHtml(i.description).slice(0, 300) || null : null, matched_at: now2 }));
              // Magnitude check only applies when BOTH biases sit on the hawk-dove axis — a transition
              // to/from an orthogonal label (Data Dependent/On Hold/Split) never trips false divergence.
              const prevOnAxis = prevBias && !ORTHOGONAL_LABELS.has(prevBias) && HAWK_DOVE_AXIS.includes(prevBias);
              const newOnAxis  = !ORTHOGONAL_LABELS.has(bias) && HAWK_DOVE_AXIS.includes(bias);
              if (prevBias && confidence !== 'High' && prevOnAxis && newOnAxis) {
                const prevIdx = HAWK_DOVE_AXIS.indexOf(prevBias); const newIdx = HAWK_DOVE_AXIS.indexOf(bias);
                if (prevIdx !== -1 && newIdx !== -1 && Math.abs(newIdx - prevIdx) > 2) {
                  // Large swing but not High-confidence: keep the established bias rather than
                  // flip on ambiguous evidence, but surface a divergence warning instead of
                  // silently discarding the signal — downgrade displayed confidence to Low.
                  // source_headlines here is deliberately the FRESH list only (not merged) — it's
                  // evidence for the suggested shift, not the established bias, so it shouldn't
                  // blend into that bias's accumulated trail (prevEntry.source_headlines untouched below).
                  console.log(`Call 2: divergence ${cur} — ${prevBias}→${bias} (confidence ${confidence}), keeping prev bias + flagging`);
                  existing[cur] = {
                    ...prevEntry,
                    confidence: 'Low',
                    divergence_warning: { suggested_bias: bias, suggested_confidence: confidence, detected_at: now2, source_headlines: freshHeadlines },
                  };
                  _biasUpdated.push(cur);
                  continue;
                }
              }
              existing[cur] = { bias, confidence, updated_at: now2, source_headlines: mergeSourceHeadlines(prevEntry?.source_headlines, freshHeadlines) };
              _biasUpdated.push(cur);
            }
            if (_biasUpdated.length > 0) {
              const saveResult = await redisCmd('SET', 'cb_bias', JSON.stringify(existing));
              console.log('CB bias Redis SET result:', saveResult);
            }
            await redisCmd('DEL', 'cb_bias_lock').catch(()=>{});
          }
        } catch(e) { console.warn('Call 2 bias parse/save failed:', e.message); }
      }
    }
    return _biasUpdated;
  })() : Promise.resolve([]);

  const _call4Promise = ((SAMBANOVA_KEY || GROQ_KEY) && deviceId && recentItems.length > 0) ? (async () => {
    try {
      const openEntries = await fetchOpenThesisEntries(deviceId);
      if (openEntries.length === 0) { console.log('Call 4: no open entries, skipping'); return null; }
      console.log('Call 4: checking', openEntries.length, 'open entries against headlines');
      const validated = await checkThesisContradictions(openEntries, recentItems, SAMBANOVA_KEY, GROQ_KEY);
      if (validated === null) return null;
      if (validated.length > 0) {
        redisCmd('SET', `thesis_alerts:${deviceId}`, JSON.stringify(validated), 'EX', 1800).catch(() => {});
      } else {
        redisCmd('DEL', `thesis_alerts:${deviceId}`).catch(() => {});
      }
      return validated;
    } catch(e) { console.warn('Call 4 Thesis Monitor failed:', e.message); return null; }
  })() : Promise.resolve(null);

  // ── 4. Call 1: Market Briefing — SambaNova primary → OpenRouter fallback 1 →
  // Groq fallback 2 (Nemotron non-aktif di produksi, diagnostik saja — lihat lanjutan 7) ──
  let article = null, method = 'fallback';
  const providerLog = [];
  if (recentItems.length > 0) {
    const DIGEST_SYSTEM_DEFAULT = `Kamu analis macro FX senior. Tulis briefing pre-session Bahasa Indonesia untuk trader Indonesia yang sudah fasih: DXY, real yield, carry, risk-on/off, basis point — jangan jelaskan istilah ini.

FORMAT OUTPUT:
- Prosa mengalir. Tanpa bullet, heading, bold, emoji.
- Dua bagian: (1) bagian FX, (2) bagian XAUUSD diawali tepat "XAUUSD:" (baris baru, tanpa spasi sebelum tanda titik dua).
- Mulai LANGSUNG dengan fakta paling spesifik yang market-moving dari headline. DILARANG KERAS membuka dengan: "Pagi ini", "Hari ini", "Sesi ini", "Flow berita", "Pasar hari ini", "Dalam konteks ini", "Minggu ini", atau kalimat konteks/ringkasan apapun. Kalimat pertama harus menyebut nama pejabat, angka spesifik, atau pair FX konkret (USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF — BUKAN XAU/emas/gold).
- Target panjang: bagian FX 4-7 kalimat, bagian XAUUSD 4-6 kalimat (kecuali sinyal tipis, lihat ATURAN XAUUSD). Ini batas lunak untuk menjaga fokus — jangan memotong fakta penting demi memenuhi angka ini, tapi jangan juga menumpuk tema lepas hanya untuk memenuhi panjang.

FRASA TERLARANG — periksa output sebelum kirim, tidak ada pengecualian:
dapat mempengaruhi · dapat memberikan · dapat berdampak · perlu dicermati · patut diwaspadai · tergantung data · masih akan volatile · menjadi fokus · trader harus berhati-hati · sentimen mixed · berpotensi menggerakkan · berpotensi mempengaruhi · dapat menekan · memberikan tekanan · memberikan dorongan · perlu diperhatikan · akan terus dipantau · seiring dengan · sejalan dengan · di tengah · memberikan gambaran · masih dalam ketidakpastian · mencermati · cukup padat · perkembangan ini · hal ini · dalam beberapa jam ke depan (tanpa spesifik) · berdampak pada pasar

TES WAJIB TIAP KALIMAT: Bisakah kalimat ini ditulis tanpa membaca headlines hari ini? Kalau ya → hapus.

ATURAN FX:
PENTING: Bagian FX adalah KHUSUS untuk analisa FX pair dan USD. DILARANG KERAS membahas XAU, emas, gold, bullion, atau harga emas di bagian ini — semua gold content masuk ke bagian XAUUSD. Kalau hari ini yang paling market-moving adalah gold, tetap buka dengan dampaknya ke FX pairs (misal: "Kenaikan tajam XAU memicu risk-off, mengangkat JPY dan CHF vs USD") — bukan membahas gold itu sendiri.
ANTI-HALLUCINATION: Jangan gabungkan dua headline berbeda menjadi satu klaim baru yang tidak ada di headline aslinya. Jika headline A menyebut X dan headline B menyebut Y, jangan tulis "X berkoordinasi dengan Y" kecuali kalimat itu memang ada di salah satu headline.

PENDEKATAN BENANG MERAH FX — ikuti urutan ini, JANGAN tulis tema-tema sebagai paragraf lepas yang ditumpuk:
1. JANGKAR TEMA: Tentukan SATU tema paling market-moving hari ini (CB tertentu, data rilis, atau divergence currency tertentu). Ini titik awal narasi.
2. RAJUT TEMA: Tema lain HARUS dikaitkan ke tema utama lewat driver bersama yang eksplisit — paling sering USD (DXY arah, real yield, rate path Fed) atau risk sentiment global. Pakai konektor sebab-akibat ("ini berbarengan dengan...", "di sisi lain, ... juga bergerak karena driver yang sama/berlawanan") — JANGAN mulai kalimat baru dengan currency lain tanpa menjelaskan kaitannya ke tema sebelumnya.
3. Kalau tema-tema benar-benar tidak berkaitan (misal CB Asia vs data AS, tidak ada irisan driver) — boleh dipisah, tapi maksimal 2 tema independen per output. Tema ketiga ke bawah yang tidak terkait → skip, sebut hanya jika punya magnitude kuat. Tema dengan kaitan kausal lemah/tidak langsung (mis. ekuitas regional sebagai proksi sentimen currency) — SKIP, kecuali magnitude-nya jelas kuat dan disebut dengan mekanisme konkret. Jangan masukkan tema hanya untuk menambah panjang.
4. Continuity DIJALIN ke tema yang relevan, bukan ditulis sebagai kalimat penutup terpisah yang tidak terhubung dengan paragraf sebelumnya (misal: "...berlanjut dari pola sesi sebelumnya" disisipkan langsung setelah klaim terkait, bukan kalimat baru berdiri sendiri).
5. Penutup FX menyimpulkan dari benang merah yang sudah dibangun, bukan currency baru yang belum disebut di paragraf sebelumnya.
6. LABEL TOPIK (navigasi visual untuk pembaca — BUKAN pengganti konektor di poin 2, keduanya WAJIB ada bersamaan): setiap kali fokus bergeser ke currency/tema baru, sisipkan tag PERSIS sebelum kalimat itu dengan format {{TAG: NAMA}}.
   - WAJIB tag SETIAP currency yang dibahas dengan klaim/mekanisme sendiri (punya alasan/data sendiri kenapa bergerak) — bukan cuma yang numpang disebut di kalimat currency lain. EUR, AUD/CAD, USD/JPY di contoh ini cuma CONTOH FORMAT, BUKAN daftar lengkap — currency lain (JPY, CHF, GBP, NZD, dst) yang dibahas dengan alasannya sendiri WAJIB dapat tag sendiri juga, pakai nama currency itu sendiri sebagai NAMA tag. JANGAN gabungkan currency yang tidak berhubungan langsung ke tag currency lain hanya karena disebut di paragraf yang sama — kalau JPY/CHF dibahas sebagai mekanisme safe-haven yang berdiri sendiri, beri tag {{TAG: JPY/CHF}} sendiri, jangan dibiarkan menyatu tanpa tag di bawah tag currency sebelumnya.
   - Kalimat jangkar (tema utama/pembuka) TETAP tanpa tag — itu titik awal narasi, bukan pergeseran tema.
   - Kalimat penutup (kesimpulan kekuatan mata uang, TEPAT SATU currency kuat + TEPAT SATU currency lemah) WAJIB diberi tag {{TAG: Konfirmasi}} — JANGAN biarkan menyatu tanpa jeda ke paragraf tema currency sebelumnya, ini harus jadi blok tersendiri.
   - Tag ini beda dari format kalender "[EVENT] (CURRENCY) [TIME]" di bawah — jangan tertukar formatnya, dan jangan sampai menghapus kalimat konektor sebab-akibat yang sudah diwajibkan hanya karena sudah ada tag.

DETAIL PER TEMA (terapkan ke tema yang lolos seleksi di atas):
Klaim: Sebut nama pejabat, angka, atau pair spesifik dari headline. Tidak ada? Skip tema itu sepenuhnya.
Mekanisme: Jalur transmisi konkret (rate differential, real yield gap, risk channel, flow). Bukan "berdampak ke pair X" — sebutkan via mekanisme apa.
Magnitude: Kuat atau marginal. Marginal harus disebut marginal.
Teknikal: Jika blok PRICE ACTION pair tersedia, sisipkan konteks trend (uptrend/downtrend/sideways), level support/resistance terdekat, atau swing high/low dalam satu kalimat natural — terutama untuk pair yang paling relevan dengan tema fundamental yang dibahas. Jika blok TEKNIKAL pair tersedia juga (RSI/SMA), sisipkan singkat sebagai penguat (misal: "RSI 28 oversold, konsisten dengan tekanan jual yang sudah berlebihan"). Bukan paragraf analisa teknikal terpisah, cukup penguat konteks.
Rate Differential: Kalau tema menyangkut ekspektasi kebijakan Fed/CB lain, gunakan data RATE PATH (bps cut/hike yang sudah di-price market) sebagai angka konkret — bukan "diperkirakan akan menurunkan suku bunga", tapi "market sudah price-in X bps cut dalam 3 bulan". Kalau data tidak tersedia, boleh infer dari headline tapi jangan klaim angka pasti.
Risk Sentiment: Kalau tema melibatkan risk-on/risk-off (safe haven flow, JPY/CHF strength, dst), rujuk data RISK REGIME (VIX/MOVE/HY) sebagai bukti konkret, bukan asumsi dari judul berita saja. VIX/MOVE naik tajam = konfirmasi risk-off nyata, bukan cuma persepsi. VIX/MOVE rendah dan stabil = risk-off di headline kemungkinan overstated, sebut ini sebagai konflik kalau relevan.
Positioning: Jika blok SKEW OPSI FX tersedia untuk pair yang dibahas, sisipkan singkat sebagai konfirmasi atau kontradiksi terhadap arah fundamental (misal: "skew EUR/USD masih put-skewed, menunjukkan positioning belum mengikuti pelemahan dolar ini" — sinyal potensi reversal/catch-up). Positioning/skew adalah KONFIRMASI atau KONTRADIKSI, BUKAN jangkar arah. Jangan buka analisa pair dengan positioning. Kalau fundamental (data rilis) atau level teknikal (resistance/support kuat) berlawanan dengan positioning, sebut ketegangan itu eksplisit dan timbang mana lebih berat — jangan diam-diam ikut positioning.
Konflik: Dua signal berlawanan dalam satu tema? Sebut keduanya, putuskan mana lebih berat, jelaskan kenapa.
Kalender: Hanya event dengan asymmetri beat/miss jelas. Untuk setiap event yang dianalisis, gunakan format prosa ini persis: "[EVENT] ([CURRENCY]) [TIME WIB] — jika beat: [pair] [naik/turun] karena [mekanisme konkret]; jika miss: [pair] [naik/turun] karena [mekanisme konkret]." Event tanpa edge antisipatif → skip sepenuhnya, jangan disebutkan. WAJIB: tiap event kalender sudah punya tag "[SUDAH RILIS X lalu]" atau "[AKAN RILIS dalam X]" di blok KALENDER EKONOMI — PAKAI TAG ITU APA ADANYA untuk menentukan tense ("tadi pagi", "nanti", "besok"), JANGAN hitung sendiri dari tanggal/jam mentah (rawan salah). Event yang ber-tag "SUDAH RILIS" tidak boleh disebut "akan datang"/"besok" — kalau actual-nya belum diketahui dari headline, sebut sebagai "hasil belum tercermin di headline" bukan menebak arah.
Pejabat CB: Hanya analisa jika menyentuh rate path, balance sheet, atau inflation framework. Non-policy → sebut sekali "tidak ada sinyal kebijakan dari [nama]" lalu lanjut.
Penutup FX: Satu kalimat menyimpulkan kekuatan mata uang hari ini (HANYA pilih dari 8 majors: USD, EUR, GBP, JPY, CAD, AUD, NZD, CHF). Kalau ada SATU currency yang jelas paling kuat dan SATU yang paling lemah tanpa kontradiksi — sebut TEPAT SATU di tiap sisi, dengan alasan spesifik dari headline. Kalau buktinya genuinely campuran (misal USD kuat vs satu currency tapi lemah vs currency lain) — JANGAN dipaksa pilih satu pemenang palsu, sebut eksplisit sebagai "sinyal campuran" dan jelaskan singkat kenapa (kuat vs siapa, lemah vs siapa). Currency paling lemah/rentan tetap WAJIB disebut kalau buktinya jelas, dengan alasan spesifik dari headline — jangan jatuh ke "pasar volatile" generik tanpa alasan, baik di skenario satu pemenang maupun campuran.

ATURAN XAUUSD (paragraf baru, mulai tepat "XAUUSD:"):
Trader gold baca ini standalone — harus self-contained.
Gunakan HANYA headline dari blok HEADLINE RELEVAN XAUUSD di bawah.
< 3 headline substantif → buka "Sinyal gold tipis" dan persingkat ke 2-3 kalimat saja.
ANTI-HALLUCINATION: Jangan gabungkan dua headline berbeda menjadi satu klaim baru yang tidak ada di headline aslinya. Jika headline A menyebut X dan headline B menyebut Y, jangan tulis "X berkoordinasi dengan Y" kecuali kalimat itu memang ada di salah satu headline.

PENDEKATAN BENANG MERAH — ikuti urutan ini:
1. JANGKAR HARGA: Jika blok HARGA XAU/USD LIVE tersedia, buka dengan harga dan pergerakan hari ini (naik/turun berapa persen). Jika blok PRICE ACTION menyertakan baris [6 BULAN], sebut posisi harga dalam range 6 bulan dalam frasa singkat di kalimat jangkar (misal "di puncak range 6 bulan" / "10% di bawah puncak 6 bulan") — ini anchor makro penting, bukan analisa teknikal terpisah. Ini titik awal narasi — semua fakta berikutnya menjelaskan MENGAPA harga ada di sini.
2. RAJUT FAKTA: Hubungkan harga → headline → real yield → geopolitik secara natural, seperti analis yang bercerita. Tidak perlu rantai kausal formal. Cukup: "kenaikan ini didukung oleh X, meski dibatasi oleh Y." Fakta yang saling memperkuat → gabungkan. Fakta yang berlawanan → sebut keduanya, putuskan mana lebih berat dalam satu kalimat. Jika blok TEKNIKAL XAU tersedia, sisipkan RSI dan posisi vs SMA dalam satu kalimat natural sebagai konteks teknikal pendukung (misal: "secara teknikal harga masih di atas SMA 50 dengan RSI 45 di zona netral") — bukan paragraf terpisah.
3. REAL YIELD sebagai pembatas: Jika real yield > 2%, emas mahal secara struktural — wajib disebut sebagai rem, bukan diabaikan. Tapi jika harga tetap naik meski yield tinggi, artinya tekanan bullish cukup kuat untuk offset — nyatakan ini secara eksplisit. Kalau harga emas naik/bertahan tinggi PADAHAL real yield juga tinggi (hubungan invers normal melemah), sebut eksplisit sebagai sinyal regime: driver emas sedang BUKAN real yield (kemungkinan CB buying / debasement / safe-haven struktural). Jangan cuma sebut "dibatasi yield" lalu lanjut.
4. TIDAK ADA RANTAI KAUSAL WAJIB: Untuk geopolitik minyak (Iran, Hormuz, OPEC) — tidak perlu trace oil→inflasi→Fed→yield secara kaku. Cukup: apakah ada bukti di headline bahwa ini mempengaruhi XAU? Jika ya, sebut. Jika tidak, skip.
5. RISK REGIME sebagai konfirmasi safe-haven: Jika blok RISK REGIME tersedia, gunakan VIX/MOVE sebagai bukti konkret bahwa demand safe-haven nyata (bukan cuma narasi geopolitik tanpa data). Regime "risk_off" + harga naik = haven demand terkonfirmasi data. Regime "risk_on" tapi harga tetap naik = driver bukan safe-haven, harus dijelaskan via mekanisme lain (real yield turun, CB buying, dst).
6. KORELASI sebagai cek silang: Jika blok KORELASI tersedia dan ada anomali (misal Gold-DXY yang biasanya negatif kuat tapi sekarang melemah), sebut ini sebagai sinyal regime berubah — satu kalimat saja, jangan jelaskan matematika korelasinya.
7. POSITIONING: Jika blok SKEW OPSI XAU tersedia, sisipkan sebagai konfirmasi/kontradiksi arah (call-skewed = positioning sudah bullish, jadi rally lanjutan butuh trigger baru; put-skewed saat harga naik = skeptisisme market, potensi short squeeze). Kalau menyebut positioning crowded sebagai risiko reversal, WAJIB sertakan mekanismenya dalam kalimat yang sama (mis. "long sudah ramai, jadi kalau support X jebol, likuidasi posisi itu sendiri jadi bahan bakar penurunan") — jangan tinggalkan sebagai lompatan logika.
8. Driver sama dengan sesi sebelumnya → nyatakan eksplisit, itu informasi valid.
9. LABEL TOPIK (navigasi visual, BUKAN pengganti rangkaian fakta di poin 2 — keduanya WAJIB ada bersamaan): setiap kali masuk ke sub-angle baru di luar JANGKAR HARGA awal, sisipkan tag PERSIS sebelum kalimat itu dengan format {{TAG: NAMA}}. Korelasi, Geopolitik, Positioning di sini cuma CONTOH FORMAT, BUKAN daftar lengkap — sub-angle lain (Risk Regime, Rate Differential, ETF Flow, CB Buying, dst, apa pun yang punya klaim/mekanisme sendiri) WAJIB dapat tag sendiri juga dengan nama yang sesuai, jangan dibiarkan menyatu tanpa tag di bawah sub-angle sebelumnya hanya karena tidak ada di contoh. Jangan beri tag pada kalimat jangkar harga (pembuka). Tag ini beda dari format trigger kalender "[EVENT] [TIME WIB]" di bawah — jangan tertukar formatnya.

TRIGGER TERDEKAT 24 JAM: Pilih event dari kalender dengan PRIORITAS TERTINGGI: (1) FOMC/Fed — Minutes, pidato Powell, rate decision; (2) US data — CPI, NFP, GDP; (3) event major currency lain. Format wajib: "[EVENT] [TIME WIB] — jika [outcome]: tekanan [bullish/bearish] XAU karena [mekanisme]; jika [outcome berlawanan]: tekanan [bullish/bearish] XAU karena [mekanisme]." Harus ada DUA skenario. Jika tidak ada event kalender relevan untuk XAU dalam 24 jam, tulis "Tidak ada trigger kalender untuk XAU dalam 24 jam ke depan."

CEK AKHIR SEBELUM KIRIM: (1) Ganti semua "dapat mempengaruhi/berpotensi/mungkin/dalam beberapa jam ke depan" dengan pernyataan tegas berbasis data. (2) Penutup FX: tepat satu currency kuat + tepat satu lemah — ATAU nyatakan eksplisit "sinyal campuran" dengan menjelaskan kuat-vs-siapa dan lemah-vs-siapa. Baris "dan X juga" tanpa penjelasan campuran = salah.`;

    function isValidDigestPrompt(p) {
      if (typeof p !== 'string') return false;
      const t = p.trim();
      if (t.length < 1000) return false;
      if (!t.includes('XAUUSD')) return false;
      if (!t.includes('ATURAN FX')) return false;
      return true;
    }
    if (promptDigestInstr && !isValidDigestPrompt(promptDigestInstr)) {
      console.warn('prompt_digest override invalid (too short / missing markers) — using DIGEST_SYSTEM_DEFAULT');
    }
    const digestSystemMsg = isValidDigestPrompt(promptDigestInstr) ? promptDigestInstr : DIGEST_SYSTEM_DEFAULT;
    const digestUserMsg = `PENTING: TULIS SELURUH OUTPUT DALAM BAHASA INDONESIA. JANGAN GUNAKAN BAHASA INGGRIS SAMA SEKALI.
WAKTU: ${dayStr}, ${dateStr}, ${timeStr}${weekendNote}

=== HARGA XAU/USD LIVE (jangkar harga — gunakan sebagai titik awal narasi) ===
${xauSpotBlock}

=== TEKNIKAL XAU/USD DAILY (dari Yahoo GC=F — sebutkan singkat dalam 1 kalimat sebagai konteks, bukan analisa teknikal terpisah) ===
${xauTaBlock}

=== PRICE ACTION XAU/USD (Daily/4H/1H — identifikasi trend makro, swing, dan level entry/invalidation) ===
${xauOhlcvBlock || '(Cache OHLCV belum tersedia — ohlcv_sync cron belum berjalan. Abaikan bagian ini.)'}

=== PRICE ACTION ${fxOhlcvLabel} (Daily/4H/1H — context teknikal multi-timeframe untuk pair FX rekomendasi) ===
${fxOhlcvBlock || '(Cache OHLCV belum tersedia untuk pair ini.)'}

=== TEKNIKAL ${fxOhlcvLabel} DAILY (RSI/SMA — sebutkan singkat sebagai penguat konteks) ===
${fxTaBlock}

=== DATA REAL YIELD USD (LIVE — gunakan ini, jangan inferensi dari headline) ===
${realYieldBlock}

=== RISK REGIME GLOBAL (VIX/MOVE/HY — ground-truth untuk klaim risk-on/risk-off, jangan asumsi dari judul berita saja) ===
${riskRegimeBlock}

=== RATE PATH USD (market-implied dari Fed Funds futures — angka konkret untuk mekanisme rate differential) ===
${ratePathBlock}

=== KORELASI CROSS-ASSET (anomali = sinyal regime berubah, gunakan sebagai cek silang) ===
${correlationBlock}

=== SKEW OPSI FX/XAU 25-delta (positioning institusional — confirm/contradict arah fundamental) ===
${riskReversalBlock}

=== POSITIONING CFTC COT (INFORMASI KONTEKS — positioning mingguan yang SUDAH terpasang, bukan sinyal arah hari ini; pakai untuk menilai apakah narasi headline melawan atau searah posisi institusional, dan sebut ekstremitas P90+/P10− sebagai risiko crowded/squeeze) ===
${cotBlock}

=== PREDICTION MARKETS Polymarket (INFORMASI KONTEKS — probabilitas event versi pasar prediksi; pakai HANYA kalau relevan dengan tema yang sedang dibahas, misal probabilitas keputusan Fed/gencatan senjata/tarif. Pergeseran Δ1d tajam yang sejalan/berlawanan dengan headline layak disebut satu kalimat; JANGAN bikin tema baru hanya dari blok ini) ===
${polymarketBlock}

CATATAN STALENESS: Blok REAL YIELD/RISK REGIME/RATE PATH/SKEW OPSI di atas di-cache (TTL menit-jam, SKEW OPSI sampai 6 jam — lihat penanda umur di blok itu sendiri), bisa sedikit basi. Kalau ada headline yang JELAS lebih baru dan bertentangan dengan angka di blok itu (misal yield spike besar baru saja, VIX melonjak tajam yang belum tercermin di RISK REGIME, atau shock volatilitas besar yang belum tercermin di SKEW OPSI) — sebut konflik itu eksplisit dan beri bobot lebih ke sinyal yang lebih segar, jangan diam-diam pilih salah satu tanpa penjelasan.

=== HEADLINE BERITA TERKINI (${headlinesForBriefing.length} dari ${recentItems.length} berita, 36 jam terakhir) ===
${headlinesBlock}

=== HEADLINE RELEVAN XAUUSD (${goldItems.length} dari ${recentItems.length} berita, 36 jam, difilter) ===
${goldBlock}

=== EVENT KALENDER EKONOMI HIGH-IMPACT (3 hari ke depan) ===
(Tag [F: x | P: y] = konsensus Forecast & angka Previous — gunakan untuk menilai asymmetri beat/miss secara konkret: seberapa jauh konsensus dari previous menentukan skenario mana yang lebih mengejutkan market.)
${calBlock}

=== RINGKASAN SESI SEBELUMNYA (FX) ===
${historyBlock}

=== RIWAYAT XAUUSD SESI SEBELUMNYA (4 sesi terakhir) ===
${xauHistoryBlock}`;

    const call1Messages = [
      { role: 'system', content: digestSystemMsg },
      { role: 'user', content: digestUserMsg },
    ];

    // Hermes 3 405B — diagnostik terisolasi via ?test_hermes=1 (lihat HERMES_MODEL).
    // Dicek PALING ATAS (sebelum Nemotron Super/Ultra) supaya skip semua tier lain,
    // sama seperti dua diagnostik test_nemotron* di bawah.
    if (testHermesOnly) {
      const hermesTimeout1 = 30000;
      if (OPENROUTER_KEY && await cb.canCall(CB_OPENROUTER_HERMES)) {
        const t0h = Date.now();
        try {
          console.log('Call 1: trying Hermes 3 405B (OpenRouter) — diagnostik test_hermes=1');
          const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, HERMES_MODEL, call1Messages, 1300, 0.25, hermesTimeout1, OPENROUTER_HEADERS, {}, 'openrouter');
          const elapsed = Date.now() - t0h;
          if (raw.trim()) {
            article = raw.trim(); method = 'hermes-3-405b';
            providerLog.push(`hermes:ok(${elapsed}ms,${article.length}c)`);
          } else {
            providerLog.push(`hermes:empty(${elapsed}ms)`);
          }
          console.log('Call 1: Hermes 3 405B OK, length', article?.length);
          await cb.onSuccess(CB_OPENROUTER_HERMES);
        } catch(e) {
          const elapsed = Date.now() - t0h;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`hermes:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 Hermes 3 405B failed:', e.status || e.message);
          await cb.onFailure(CB_OPENROUTER_HERMES, AI_CB_THRESHOLD);
        }
      } else if (OPENROUTER_KEY) {
        providerLog.push('hermes:circuit_open');
      } else {
        providerLog.push('hermes:no_key');
      }
    }

    // Z.ai GLM 4.7 (Cerebras) — diagnostik terisolasi via ?test_glm=1 (lihat
    // CEREBRAS_MODEL_GLM). Timeout dipasang moderat (20s) meski Cerebras mengklaim
    // ~1000 tok/s untuk model ini — tier "Preview" belum ada data latency nyata sama
    // sekali, jadi tidak diasumsikan langsung secepat klaim marketing.
    if (testGlmOnly) {
      const glmTimeout1 = 20000;
      if (CEREBRAS_KEY && await cb.canCall(CB_CEREBRAS_GLM)) {
        const t0g = Date.now();
        try {
          console.log('Call 1: trying Z.ai GLM 4.7 (Cerebras) — diagnostik test_glm=1');
          const raw = await aiCall(CEREBRAS_URL, CEREBRAS_KEY, CEREBRAS_MODEL_GLM, call1Messages, 1300, 0.25, glmTimeout1, {}, {}, 'cerebras');
          const elapsed = Date.now() - t0g;
          if (raw.trim()) {
            article = raw.trim(); method = 'glm-4.7';
            providerLog.push(`glm:ok(${elapsed}ms,${article.length}c)`);
          } else {
            providerLog.push(`glm:empty(${elapsed}ms)`);
          }
          console.log('Call 1: GLM 4.7 OK, length', article?.length);
          await cb.onSuccess(CB_CEREBRAS_GLM);
        } catch(e) {
          const elapsed = Date.now() - t0g;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`glm:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 GLM 4.7 failed:', e.status, e.message);
          await cb.onFailure(CB_CEREBRAS_GLM, AI_CB_THRESHOLD);
        }
      } else if (CEREBRAS_KEY) {
        providerLog.push('glm:circuit_open');
      } else {
        providerLog.push('glm:no_key');
      }
    }

    // Nemotron 3 Ultra — PRIMARY Call 1 (session 162 lanjutan 3, naik dari idle setelah
    // 7/7 percobaan live sukses pakai parameter native think:false, ganti trik prompt
    // /no_think lama yang selalu gagal 4/4 di session 145. Timeout awalnya 20s tapi
    // session 162 lanjutan 4 (5 sampel completion time nyata di production: 7s, 17.5s,
    // 23.9s, 29.5s, 41.2s) membuktikan 20s terlalu ketat — mayoritas percobaan nyata
    // butuh >20s, bikin Nemotron nyaris tidak pernah kepakai (circuit breaker keburu OPEN
    // dari timeout beruntun) padahal kualitas outputnya nyata lebih patuh prompt (0
    // pelanggaran frasa terlarang di 3 sampel vs SambaNova yang kedapatan leak "dapat
    // memberikan"/"di tengah" di production hari yang sama) — dinaikkan ke 35s atas
    // keputusan eksplisit user (worth it demi kualitas, terima risiko Call 3 kadang skip
    // di elapsedBeforeCall3 > CALL3_BUDGET_MS kalau kebetulan Nemotron lambat DAN masih
    // jatuh ke fallback). Cakupan cuma Call 1 (prosa bebas) — SENGAJA TIDAK dipakai
    // di Call 2/3 (JSON ketat) karena keluarga model ini (varian Super) dilaporkan
    // OpenRouter 17,76% structured-output error rate, belum divalidasi untuk Ultra.
    // Nemotron 3 SUPER (session 145 lanjutan 5) — kandidat berbeda, belum pernah dites
    // live. Dites TERISOLASI (skip semua tier lain termasuk Ultra) via ?test_nemotron_super=1.
    if (testNemotronSuperOnly) {
      const superTimeout1 = 30000; // dinaikkan dari 20s (Ronde 3) — kasih ruang wall-clock penuh, stream:false berarti nol konten balik sampai model benar-benar selesai
      if (OPENROUTER_KEY && await cb.canCall(CB_OPENROUTER_NEMOTRON_SUPER)) {
        const t0s = Date.now();
        try {
          console.log('Call 1: trying Nemotron 3 Super (OpenRouter)');
          // Ronde 1 (/no_think directive teks): 0/3 (1 timeout, 2 reasoning trace mentah).
          // Ronde 2 (reasoning:{effort:'none'}, param OpenRouter sendiri): 0/2, timeout PENUH
          // di batas 20s kedua kali — tidak bisa dibedakan dari resource contention murni
          // KARENA stream:false (kalau model masih mikir penuh, kita nol lihat sampai selesai).
          // Ronde 3 (sekarang): pakai chat_template_kwargs:{enable_thinking:false} — parameter
          // NATIVE model/vLLM sendiri (dikonfirmasi dari dokumentasi resmi NVIDIA/build.nvidia.com),
          // BUKAN lapisan abstraksi reasoning milik OpenRouter yang mungkin belum benar
          // diterjemahkan untuk model hybrid Mamba-Transformer yang masih sangat baru ini.
          // Sengaja TIDAK dicampur dengan /no_think atau reasoning.effort lagi — satu variabel
          // per eksperimen. max_tokens & timeout juga dilonggarkan supaya bukan constraint kita
          // sendiri yang jadi penyebab kalau gagal lagi.
          const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, NEMOTRON_SUPER_MODEL, call1Messages, 4096, 0.25, superTimeout1, OPENROUTER_HEADERS, { chat_template_kwargs: { enable_thinking: false } }, 'openrouter');
          const elapsed = Date.now() - t0s;
          if (raw.trim()) {
            article = raw.trim(); method = 'nemotron-3-super';
            providerLog.push(`nemotron_super:ok(${elapsed}ms,${article.length}c)`);
          } else {
            providerLog.push(`nemotron_super:empty(${elapsed}ms)`);
          }
          console.log('Call 1: Nemotron Super OK, length', article?.length);
          await cb.onSuccess(CB_OPENROUTER_NEMOTRON_SUPER);
        } catch(e) {
          const elapsed = Date.now() - t0s;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`nemotron_super:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 Nemotron Super failed:', e.status || e.message);
          await cb.onFailure(CB_OPENROUTER_NEMOTRON_SUPER, AI_CB_THRESHOLD);
        }
      } else if (OPENROUTER_KEY) {
        providerLog.push('nemotron_super:circuit_open');
      } else {
        providerLog.push('nemotron_super:no_key');
      }
    } else if (testNemotronOnly) {
      // Session 162 lanjutan 6: eksperimen think:true (reasoning dinyalakan) + timeout 60s +
      // num_predict 3500 sudah dicoba — hasilnya LEBIH BURUK (1 sukses 17.6s, 1 gagal TOTAL
      // 44.9s dengan Empty response karena seluruh budget token habis di reasoning tanpa pernah
      // sampai jawaban). Dikembalikan ke think:false/45s/1300 (baseline sebelum eksperimen).
      const ollamaNemotronTimeout1 = 45000;
      if (OLLAMA_KEY && await cb.canCall(CB_OLLAMA_NEMOTRON)) {
        const t0s = Date.now();
        try {
          console.log('Call 1: trying Nemotron 3 Ultra (Ollama Cloud, think:false native), timeout', ollamaNemotronTimeout1);
          const raw = await callOllama(OLLAMA_KEY, OLLAMA_NEMOTRON_MODEL, call1Messages, 1300, 0.25, ollamaNemotronTimeout1, 'ollama', false);
          const elapsed = Date.now() - t0s;
          article = raw.trim(); method = 'nemotron-3-ultra';
          providerLog.push(`ollama_nemotron:ok(${elapsed}ms,${article.length}c)`);
          console.log('Call 1: Ollama Nemotron OK, length', article.length);
          await cb.onSuccess(CB_OLLAMA_NEMOTRON);
        } catch(e) {
          const elapsed = Date.now() - t0s;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`ollama_nemotron:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 Ollama Nemotron failed:', e.status || e.message);
          await cb.onFailure(CB_OLLAMA_NEMOTRON, AI_CB_THRESHOLD);
        }
      } else if (OLLAMA_KEY) {
        providerLog.push('ollama_nemotron:circuit_open');
      } else {
        providerLog.push('ollama_nemotron:no_key');
      }

      const openrouterNemotronTimeout1 = 12000;
      if (!article && OPENROUTER_KEY && await cb.canCall(CB_OPENROUTER_NEMOTRON)) {
        const t0s = Date.now();
        try {
          console.log('Call 1: trying Nemotron 3 Ultra (OpenRouter)');
          const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, NEMOTRON_MODEL, withNoThink(call1Messages), 1300, 0.25, openrouterNemotronTimeout1, OPENROUTER_HEADERS, {}, 'openrouter');
          const elapsed = Date.now() - t0s;
          if (raw.trim()) {
            article = raw.trim(); method = 'nemotron-3-ultra';
            providerLog.push(`openrouter_nemotron:ok(${elapsed}ms,${article.length}c)`);
          } else {
            providerLog.push(`openrouter_nemotron:empty(${elapsed}ms)`);
          }
          console.log('Call 1: OpenRouter Nemotron OK, length', article?.length);
          await cb.onSuccess(CB_OPENROUTER_NEMOTRON);
        } catch(e) {
          const elapsed = Date.now() - t0s;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`openrouter_nemotron:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 OpenRouter Nemotron failed:', e.status || e.message);
          await cb.onFailure(CB_OPENROUTER_NEMOTRON, AI_CB_THRESHOLD);
        }
      } else if (!article && OPENROUTER_KEY) {
        providerLog.push('openrouter_nemotron:circuit_open');
      } else if (!article) {
        providerLog.push('openrouter_nemotron:no_key');
      }
    } else if (isCronCall && !isIsolatedTest) {
      // Session 163 (2026-07-13): Nemotron Ultra (Ollama) dicoba lagi, KHUSUS untuk 3
      // jadwal cron session-open (GitHub Actions market-digest.yml — Asia/Eropa/NY),
      // bukan tiap live request. Root cause demote sebelumnya (session 162 lanjutan 7)
      // adalah latency 100% tidak terprediksi (5 sampel 7s/17.5s/23.9s/29.5s/41.2s) yang
      // fatal untuk live user menunggu di layar — tapi TIDAK masalah untuk cron: hasil
      // cron ditulis ke latest_article/cache dan dibaca semua user lewat mode=cached,
      // jadi tidak ada satupun live request yang ikut menunggu Nemotron secara sinkron.
      // Budget waktu cron (GH Actions --max-time 55s, Vercel maxDuration 60s) masih
      // cukup untuk timeout 45s ini; CALL3_BUDGET_MS (50s, lihat di bawah) tetap jadi
      // jaring pengaman kalau kebetulan lambat — thesis cukup skip sekali, dicoba lagi
      // cron berikutnya 5-7 jam kemudian, bukan tiap request seperti live traffic.
      // Live/on-demand request (!isCronCall) TETAP pakai gpt-oss-120b primary di bawah
      // — kualitasnya lebih rendah tapi latency-nya predictable, cocok untuk user yang
      // menunggu sinkron.
      const cronOllamaTimeout1 = 45000;
      if (OLLAMA_KEY && await cb.canCall(CB_OLLAMA_NEMOTRON)) {
        const t0c = Date.now();
        try {
          console.log('Call 1: trying Nemotron 3 Ultra (Ollama Cloud) — cron session-open run');
          const raw = await callOllama(OLLAMA_KEY, OLLAMA_NEMOTRON_MODEL, call1Messages, 1300, 0.25, cronOllamaTimeout1, 'ollama', false);
          const elapsed = Date.now() - t0c;
          article = raw.trim(); method = 'nemotron-3-ultra';
          providerLog.push(`ollama_nemotron:ok(${elapsed}ms,${article.length}c)`);
          console.log('Call 1: Ollama Nemotron OK (cron), length', article.length);
          await cb.onSuccess(CB_OLLAMA_NEMOTRON);
        } catch(e) {
          const elapsed = Date.now() - t0c;
          const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
          providerLog.push(`ollama_nemotron:${errMsg}(${elapsed}ms)`);
          console.warn('Call 1 Ollama Nemotron failed (cron):', e.status || e.message);
          await cb.onFailure(CB_OLLAMA_NEMOTRON, AI_CB_THRESHOLD);
        }
      } else if (OLLAMA_KEY) {
        providerLog.push('ollama_nemotron:circuit_open');
      } else {
        providerLog.push('ollama_nemotron:no_key');
      }
      providerLog.push('nemotron_super:skipped_not_primary', 'openrouter_nemotron:skipped_not_primary');
    } else {
      // Nemotron didemote dari primary LIVE (session 162 lanjutan 7) — root cause bukan
      // kualitas (0 pelanggaran frasa terlarang di semua sampel live, malah lebih patuh
      // prompt daripada SambaNova) tapi latency 100% tidak terprediksi: 5 sampel
      // completion time nyata 7s/17.5s/23.9s/29.5s/41.2s, pola naik bukan stabil
      // (resource contention tier gratis model 550B). Timeout berapa pun (20s → 35s
      // sudah dicoba, masih miss kasus lambat) tidak menyelesaikan akar masalah karena
      // variannya sendiri yang liar, bukan sekadar kurang longgar — fatal untuk live
      // request tapi TIDAK untuk cron (lihat cabang isCronCall di atas, session 163).
      // Jalur diagnostik ?test_nemotron=1/?test_nemotron_super=1 tetap aktif di luar cabang ini.
      providerLog.push('nemotron_super:skipped_not_primary', 'openrouter_nemotron:skipped_not_primary', 'ollama_nemotron:skipped_not_primary');
    }

    // Batas waktu keras sisa cascade Call 1 (session 163) — sejak cabang isCronCall di
    // atas bisa menghabiskan 45s (Nemotron Ultra Ollama) sebelum sampai sini, gpt-
    // oss+SambaNova+Groq berturut-turut (15s+22s+15s=52s) bisa dorong total Call 1
    // tembus maxDuration 60s Vercel kalau semua tier gagal berantai — bukan cuma bikin
    // Call 3 skip (CALL3_BUDGET_MS di bawah sudah jaga itu) tapi bisa bikin SELURUH
    // function dibunuh Vercel sebelum sempat balas apa pun. Guard ini skip tier
    // berikutnya kalau waktu sejak handler mulai sudah mepet, terima 'fallback' method
    // daripada resiko function mati total.
    const CALL1_HARD_BUDGET_MS = 48000;
    const call1BudgetLeft = () => Date.now() - handlerStart < CALL1_HARD_BUDGET_MS;

    // Primary: OpenRouter gpt-oss-120b (session 163, 2026-07-13) — dipromosikan dari
    // fallback 1 jadi primary karena akun SambaNova (SAMBANOVA_KEY_CALL1) sudah kena
    // limit harian. Kualitas gpt-oss-120b lebih rendah dari DeepSeek-V3.2 — diterima
    // sementara sambil user cari kandidat model lain (GLM 4.7 via Cerebras sudah dites
    // & DITOLAK, lihat CEREBRAS_MODEL_GLM). SambaNova TIDAK dihapus, digeser jadi
    // fallback 1 di bawah — otomatis kepakai lagi begitu limitnya reset/naik.
    if (isIsolatedTest) {
      if (!article) providerLog.push('openrouter_gptoss:skipped_test');
    } else if (!article && !call1BudgetLeft()) {
      providerLog.push('openrouter:skipped_budget');
    } else if (!article && OPENROUTER_KEY) {
      const t2s = Date.now();
      try {
        console.log('Call 1: trying OpenRouter gpt-oss-120b:free (primary)');
        const raw = await aiCall(OPENROUTER_URL, OPENROUTER_KEY, OPENROUTER_MODEL, call1Messages, 1300, 0.25, 15000, OPENROUTER_HEADERS);
        const elapsed = Date.now() - t2s;
        if (raw.trim()) {
          article = raw.trim(); method = 'gpt-oss-120b';
          providerLog.push(`openrouter:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`openrouter:empty(${elapsed}ms)`);
        }
        console.log('Call 1: OpenRouter OK, length', article?.length);
      } catch(e) {
        const elapsed = Date.now() - t2s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`openrouter:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 OpenRouter failed:', e.status || e.message);
      }
    } else if (!article) {
      providerLog.push('openrouter:no_key');
    }

    // Fallback 1: SambaNova DeepSeek-V3.2 (akun 2, Call 1 prose only) — digeser dari
    // primary (session 163, lihat catatan gpt-oss di atas: akun ini sudah kena limit
    // harian). Tetap di-skip saat ?test_nemotron=1 / ?test_nemotron_super=1 /
    // ?test_hermes=1 / ?test_glm=1 supaya hasil diagnostik tidak tersamar.
    if (isIsolatedTest) {
      if (!article) providerLog.push('sambanova:skipped_test');
    } else if (!article && !call1BudgetLeft()) {
      providerLog.push('sambanova:skipped_budget');
    } else if (!article && SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1)) {
      const t1s = Date.now();
      try {
        console.log('Call 1: fallback 1 to SambaNova DeepSeek-V3.2 (akun 2 prose)');
        const raw = await aiCall(SAMBANOVA_URL_CALL1, SAMBANOVA_KEY_CALL1, SAMBANOVA_MODEL_CALL1, call1Messages, 1300, 0.25, 22000, {}, {}, 'sambanova_c1');
        const elapsed = Date.now() - t1s;
        if (raw.trim()) {
          article = raw.trim(); method = 'deepseek-v3.2';
          providerLog.push(`sambanova:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`sambanova:empty(${elapsed}ms)`);
        }
        console.log('Call 1: SambaNova V3.2 OK, length', article?.length);
        await cb.onSuccess(CB_SAMBA_C1);
      } catch(e) {
        const elapsed = Date.now() - t1s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`sambanova:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 SambaNova V3.2 fallback failed:', e.status || e.message);
        await cb.onFailure(CB_SAMBA_C1, AI_CB_THRESHOLD);
      }
    } else if (!article && SAMBANOVA_KEY_CALL1) {
      providerLog.push('sambanova:circuit_open');
      console.log('Call 1: SambaNova circuit OPEN — skipping to Groq');
    } else if (!article) {
      providerLog.push('sambanova:no_key');
    }

    // Fallback 2: Groq qwen3-32b (if OpenRouter failed/empty)
    if (isIsolatedTest) {
      if (!article) providerLog.push('groq_qwen3:skipped_test');
    } else if (!article && !call1BudgetLeft()) {
      providerLog.push('groq_qwen3:skipped_budget');
    } else if (!article && GROQ_KEY) {
      const t3s = Date.now();
      try {
        console.log('Call 1: fallback 3 to Groq qwen3-32b');
        const raw = await aiCall(GROQ_URL, GROQ_KEY, GROQ_MODEL_PROSE, call1Messages, 1300, 0.25, 15000);
        const elapsed = Date.now() - t3s;
        if (raw.trim()) {
          article = raw.trim(); method = 'qwen3-32b';
          providerLog.push(`groq_qwen3:ok(${elapsed}ms,${article.length}c)`);
        } else {
          providerLog.push(`groq_qwen3:empty(${elapsed}ms)`);
        }
        console.log('Call 1: Groq qwen3 OK, length', article?.length);
      } catch(e) {
        const elapsed = Date.now() - t3s;
        const errMsg = e.status ? `HTTP${e.status}` : (e.message || 'err').slice(0, 40);
        providerLog.push(`groq_qwen3:${errMsg}(${elapsed}ms)`);
        console.warn('Call 1 Groq qwen3 fallback failed:', e.status || e.message);
      }
    } else if (!article) {
      providerLog.push('groq_qwen3:no_key');
    }

    if (!article) method = 'fallback';
  } else {
    method = 'fallback';
  }

  // ── 5. Manual fallback (no AI) ────────────────────────────────────────────────
  if (!article) {
    method = 'fallback';
    if (recentItems.length === 0) {
      article = 'Tidak ada berita baru dalam 36 jam terakhir.';
    } else {
      const catGroups = {};
      recentItems.forEach(i => { const c=detectCat(i.title); if(!catGroups[c])catGroups[c]=[]; catGroups[c].push(i.title); });
      const priority = ['market-moving','macro','energy','geopolitical','forex','econ-data','equities','commodities','bonds'];
      const CAT_ID = { 'market-moving':'Penggerak utama pasar','macro':'Dari sisi kebijakan moneter','energy':'Di sektor energi','geopolitical':'Dari sisi geopolitik','forex':'Pada pasar valuta asing','econ-data':'Data ekonomi menunjukkan','equities':'Pasar saham mencatat','commodities':'Di pasar komoditas','bonds':'Pasar obligasi' };
      const parts = [];
      for (const cat of priority) { if (catGroups[cat]?.length > 0 && parts.length < 3) parts.push(`${CAT_ID[cat]||cat}: ${catGroups[cat][0].toLowerCase()}.`); }
      const calPart = calEvents.length > 0 ? `Event high-impact terdekat adalah ${calEvents[0].event} (${calEvents[0].currency}) pada ${calEvents[0].time_wib}, ${calEvents[0].date}.` : 'Tidak ada event high-impact terjadwal.';
      article = parts.join(' ') + '\n\n' + calPart;
    }
  }

  // ── 5a. Safety net: kalimat penutup FX selalu ditag {{TAG: Konfirmasi}} ──────
  // AI nggak selalu comply instruksi "WAJIB tag kalimat penutup" (terbukti di test
  // live — kadang nempel tanpa tag di paragraf currency sebelumnya). Daripada cuma
  // gantungin ke prompt compliance, pastikan juga di kode: kalimat penutup FX itu
  // by design SELALU ada (instruksi "Penutup FX" di atas wajib menghasilkan satu
  // kalimat kuat/lemah currency) dan SELALU jadi kalimat terakhir sebelum marker
  // "XAUUSD:" — jadi aman ditandai di sini kalau AI lupa nge-tag sendiri.
  function _ensureConfirmasiTag(text) {
    if (!text) return text;
    const xauIdx = text.indexOf('XAUUSD:');
    const fxPart = xauIdx === -1 ? text : text.slice(0, xauIdx);
    if (fxPart.includes('{{TAG:')) {
      if (fxPart.includes('{{TAG: Konfirmasi}}')) return text; // AI sudah comply
      // AI sudah pakai tag untuk topik lain tapi lupa di penutup — tetap cari batas
      // kalimat terakhir di bawah, jangan skip cuma karena ada tag lain.
    }
    // Batas kalimat: titik diikuti spasi+huruf besar — pola ini sengaja menghindari
    // angka desimal ("2.32%") karena tidak diikuti spasi+huruf besar.
    const sentenceBoundary = /\.\s+(?=[A-Z])/g;
    let lastIdx = -1, m;
    while ((m = sentenceBoundary.exec(fxPart)) !== null) lastIdx = m.index + m[0].length;
    if (lastIdx === -1) return text; // cuma 1 kalimat atau pola nggak ketemu, jangan dipaksa
    return text.slice(0, lastIdx) + '{{TAG: Konfirmasi}} ' + text.slice(lastIdx);
  }
  // QUAL-11: Opening sentence validation — the prompt forbids these openers but code
  // didn't enforce it; now we log a warning so quality issues surface in server logs.
  const FORBIDDEN_OPENERS = [
    'pagi ini', 'hari ini', 'sesi ini', 'flow berita', 'pasar hari ini',
    'dalam konteks ini', 'minggu ini', 'dalam sesi', 'berita utama',
  ];
  let phraseHits = [];
  if (article && method !== 'fallback' && method !== 'fallback_quota') {
    article = _ensureConfirmasiTag(article);
    // C8: Deteksi frasa terlarang yang lolos dari instruksi prompt (observability — tidak auto-edit)
    const lowerArt = article.toLowerCase();
    phraseHits = FORBIDDEN_PHRASES.filter(p => lowerArt.includes(p));
    if (phraseHits.length > 0) {
      console.warn('Call 1 forbidden phrases leaked:', phraseHits.join(', '));
      providerLog.push(`forbidden:${phraseHits.length}`);
    }
    // QUAL-11: Check if article opens with a forbidden opener
    const firstSentence = article.slice(0, 80).toLowerCase();
    const badOpener = FORBIDDEN_OPENERS.find(o => firstSentence.startsWith(o));
    if (badOpener) {
      console.warn(`Call 1 forbidden opener: "${badOpener}" — prompt compliance failure`);
      providerLog.push(`bad_opener:${badOpener}`);
    }
  }

  // ── 5b. Save digest + xau history (parallel) ──
  // isIsolatedTest dikecualikan (bug pre-existing: hanya latest_article yang dulu
  // dikecualikan setelah insiden 2026-07-07, digest_history TIDAK — celah ini
  // ditemukan & ditutup sekalian saat menambah diagnostik Hermes, karena kalau
  // dibiarkan, digest_history yang dipakai sebagai konteks "sesi sebelumnya" di
  // prompt Call 1 berikutnya bisa tercemar oleh hasil model eksperimental).
  if (article && method !== 'fallback' && method !== 'fallback_quota' && !isIsolatedTest) {
    try {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const wibStr = `${String(wibNow.getUTCDate()).padStart(2,'0')} ${MONTHS[wibNow.getUTCMonth()]} ${String(wibNow.getUTCHours()).padStart(2,'0')}:${String(wibNow.getUTCMinutes()).padStart(2,'0')} WIB`;

      // FX digest history — first 700 chars (FX section)
      const xauIdx = article.indexOf('XAUUSD:');
      const fxSummary = (xauIdx > 0 ? article.slice(0, xauIdx) : article).replace(/\n/g, ' ').slice(0, 700);
      const fxEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, summary: fxSummary });

      // XAU-specific history — extract XAUUSD paragraph only
      const xauParagraph = xauIdx !== -1 ? article.slice(xauIdx, xauIdx + 600).replace(/\n/g, ' ') : null;
      const saves = [
        redisCmd('LPUSH', 'digest_history', fxEntry).then(() => redisCmd('LTRIM', 'digest_history', 0, 6)),
      ];
      // Only save XAU history when gold headlines are substantive — prevents hallucinated
      // thin-day analysis from polluting future sessions via xauHistoryBlock continuity prompt
      if (xauParagraph && goldItems.length >= 3) {
        const xauEntry = JSON.stringify({ at: new Date().toISOString(), wib: wibStr, xau_summary: xauParagraph });
        saves.push(redisCmd('LPUSH', 'xau_history', xauEntry).then(() => redisCmd('LTRIM', 'xau_history', 0, 3)));
      } else if (xauParagraph) {
        console.log(`XAU history skipped — goldItems ${goldItems.length} < 3, output unreliable`);
      }
      await Promise.all(saves);
      console.log('Digest + XAU history saved');
    } catch(e) { console.warn('Digest history save failed:', e.message); }
  }

  // ── 6. Await Call 2 (ran concurrently with Call 1) ───────────────────────────
  const biasUpdated = await _biasPromise;

  // ── 7. Call 3: Structured Trade Thesis — SambaNova → Groq fallback ───────────
  let thesis = null;
  const elapsedBeforeCall3 = Date.now() - handlerStart;
  const CALL3_BUDGET_MS = 50000; // sisakan ~10s headroom dari maxDuration 60s
  if (elapsedBeforeCall3 > CALL3_BUDGET_MS) {
    console.warn(`Call 3 skipped — time budget exhausted (${elapsedBeforeCall3}ms elapsed)`);
    // thesis tetap null → UI sajikan latest_thesis lama dari Redis (tak fatal)
  } else if (recentItems.length > 0 && article) {
    const cbSummary = biasUpdated.length > 0
      ? `CB biases just updated for: ${biasUpdated.join(', ')}`
      : 'CB biases unchanged this cycle';
    const xauSectionMatch = article.indexOf('XAUUSD:');
    const xauSection = xauSectionMatch !== -1 ? article.slice(xauSectionMatch, xauSectionMatch + 700) : '';
    const briefingForThesis = article.slice(0, 900) + (xauSection && xauSectionMatch > 900 ? '\n\n' + xauSection : '');
    const goldHeadlinesForThesis = goldItems.slice(0, 15).map((i, idx) => `${idx + 1}. ${i.title}`).join('\n') || '(none)';
    const rawHeadlinesForThesis = headlinesForBriefing.slice(0, 15).map((h, i) => `${i + 1}. ${h.title}`).join('\n');

    const thesisPrompt = [
      'You are a macro FX and gold strategist. Based on the market context below, output a structured JSON with both an FX trade thesis and an XAU/USD fundamental thesis.',
      '',
      `Market briefing (current session): ${briefingForThesis}`,
      '',
      `Top headlines (raw, newest first — use as the factual anchor):\n${rawHeadlinesForThesis}`,
      '',
      'If the prose briefing above appears to contradict these raw headlines, prioritise the raw headlines — the briefing is a derived summary and may compress or distort.',
      '',
      cbSummary,
      '',
      `Upcoming high-impact calendar events (next 3 days, WIB): ${calBlock}`,
      '',
      `Gold-relevant headlines: ${goldHeadlinesForThesis}`,
      '',
      xauOhlcvBlock ? `XAU/USD multi-TF price context (use for precise entry, target, invalidation):\n${xauOhlcvBlock.split('\n').slice(1, 8).join('\n')}` : '',
      fxOhlcvBlock  ? `${fxOhlcvLabel} multi-TF price context:\n${fxOhlcvBlock.split('\n').slice(1, 8).join('\n')}`  : '',
      '',
      `Risk regime (VIX/MOVE/HY, ground-truth — use this to set dominant_regime, do not infer purely from headlines): ${riskRegimeBlock}`,
      `Rate path (market-implied Fed Funds, bps priced): ${ratePathBlock}`,
      `Cross-asset correlation anomalies (regime-break signal): ${correlationBlock}`,
      `FX/XAU options skew (25-delta risk reversal, institutional positioning): ${riskReversalBlock}`,
      xauTa ? `XAU daily TA: ${xauTaBlock}` : '',
      fxTa  ? `${fxOhlcvLabel} daily TA: ${fxTaBlock}` : '',
      '',
      'Return ONLY valid JSON with this exact schema (no markdown, no explanation):',
      '{',
      '  "dominant_regime": "risk_on" | "risk_off" | "neutral",',
      '  "strongest_currency": "USD",',
      '  "weakest_currency": "JPY",',
      '  "pair_recommendation": "USD/JPY",',
      '  "direction": "long" | "short" | "no_trade",',
      '  "confidence_1_to_5": 3,',
      '  "invalidation_condition": "string, in Bahasa Indonesia",',
      '  "time_horizon_days": 5,',
      '  "catalyst_dependency": "string, in Bahasa Indonesia",',
      '  "xau_bias": "bullish" | "bearish" | "neutral" | "conflicting",',
      '  "xau_dominant_driver": "real_yield" | "safe_haven" | "risk_sentiment" | "usd_strength" | "insufficient_data",',
      '  "xau_driver_evidence": "string in Bahasa Indonesia — specific data point or event from headlines",',
      '  "xau_key_trigger": "string in Bahasa Indonesia — event name + WIB time + specific spike scenario, or \'Tidak ada trigger jelas dalam 24 jam\' if none",',
      '  "xau_confidence": 3',
      '}',
      '',
      'All free-text string fields (invalidation_condition, catalyst_dependency, xau_driver_evidence, xau_key_trigger) must be written in Bahasa Indonesia — the trader reading this is Indonesian. Keep standard finance terms (DXY, real yield, basis point, dll) as-is, do not translate those.',
      '',
      'FX rules:',
      'Use only 8 major currencies: USD EUR GBP JPY CAD AUD NZD CHF.',
      'Set direction to "no_trade" and confidence to 1-2 if conviction is low.',
      'Only recommend a pair if CB bias divergence between the two currencies is at least 2 levels apart (e.g. Hawkish vs Dovish).',
      'Use the calendar events to inform invalidation_condition — if a high-impact event for one of the pair currencies is scheduled within time_horizon_days, name it as the primary invalidation trigger. CRITICAL: the calendar list contains events for all 8 major currencies, not just the recommended pair — only cite an event whose currency is literally one of the two currencies in pair_recommendation (e.g. for USD/JPY, only a USD or JPY event qualifies; never cite a CAD, EUR, GBP, AUD, NZD or CHF event even if it is the most prominent one in the list). If no calendar event matches the pair\'s two currencies, base invalidation_condition on price/technical or fundamental grounds instead — do not borrow an unrelated currency\'s event.',
      'dominant_regime must directly copy the "Regime" classification from the risk regime data above when available, using this exact mapping: risk_off or elevated → "risk_off"; risk_on → "risk_on"; neutral → "neutral". Do not reinterpret or override this with headline sentiment — if the data says neutral, output "neutral" even if headlines feel risk-on or risk-off. Only fall back to inferring from headlines if risk regime data is unavailable.',
      'If rate path data shows bps already priced in for USD, weigh this into confidence — a pair recommendation that fights an already-priced rate path needs stronger non-rate justification.',
      'If options skew for the recommended pair contradicts the recommended direction (e.g. recommending long but skew is put-skewed), lower confidence by at least 1 point and mention the conflict in catalyst_dependency.',
      '',
      'XAU rules:',
      'xau_bias must be based on fundamental pressure from headlines, NOT price prediction.',
      'xau_driver_evidence must cite a specific number, official name, or event from the gold headlines — not a generic statement.',
      'If gold headlines are sparse (fewer than 3 substantive), set xau_dominant_driver to "insufficient_data" and xau_confidence to 1.',
      'xau_key_trigger must include WIB time if available from calendar, otherwise note "time TBD".',
      'xau_confidence: 1-5 where 5 = multiple converging headlines with clear direction.',
      'If xau_dominant_driver is "safe_haven", it must be corroborated by the risk regime data (VIX/MOVE elevated or risk_off) — if risk regime is benign/risk_on, do not select "safe_haven" as dominant_driver unless headlines show a very fresh, unpriced shock.',
      'If gold correlation anomalies show a breakdown vs DXY or real yield (the usual negative correlation weakening), factor this into xau_confidence — a correlation breakdown signals the dominant driver may be shifting.',
    ].join('\n');

    const call3Messages = [{ role: 'user', content: thesisPrompt }];

    // Nemotron 3 Ultra — DIDEMOTE dari primary (session 145 lanjutan 4, lihat catatan
    // lengkap di Call 1): 4/4 tes live gagal across 2 sumber, tidak dipanggil lagi di
    // jalur produksi. Hanya masuk array saat ?test_nemotron=1 (SambaNova/Groq lalu
    // menggantikannya sebagai primary/fallback asli di jalur produksi normal).
    // Nemotron 3 Super (session 145 lanjutan 5) sengaja TIDAK masuk sini — dibatasi ke
    // Call 1 saja (lihat catatan di Call 1). Saat ?test_nemotron_super=1, Call 3 berjalan
    // NORMAL (SambaNova/Groq seperti biasa) karena yang sedang didiagnosis cuma Call 1.
    const call3Providers = [];
    if (testNemotronOnly) {
      if (OLLAMA_KEY)     call3Providers.push({ ollama: true, key: OLLAMA_KEY, model: OLLAMA_NEMOTRON_MODEL, label: 'Ollama Nemotron', timeout: 15000, provider: 'ollama', circuit: CB_OLLAMA_NEMOTRON, noThink: true });
      if (OPENROUTER_KEY) call3Providers.push({ url: OPENROUTER_URL, key: OPENROUTER_KEY, model: NEMOTRON_MODEL, label: 'OpenRouter Nemotron', timeout: 10000, provider: 'openrouter', circuit: CB_OPENROUTER_NEMOTRON, headers: OPENROUTER_HEADERS, noThink: true });
    } else {
      if (SAMBANOVA_KEY) call3Providers.push({ url: SAMBANOVA_URL, key: SAMBANOVA_KEY, model: SAMBANOVA_MODEL, label: 'SambaNova', timeout: 8000, provider: 'sambanova_main', circuit: CB_SAMBA_MAIN });
      if (GROQ_KEY)      call3Providers.push({ url: GROQ_URL,      key: GROQ_KEY,      model: GROQ_MODEL,      label: 'Groq fallback', timeout: 12000, provider: 'groq', circuit: null });
    }

    for (const provider of call3Providers) {
      if (thesis) break;
      const circuitSource = provider.circuit;
      if (circuitSource && !await cb.canCall(circuitSource)) {
        console.log('Call 3:', provider.label, 'circuit OPEN — skipping');
        continue;
      }
      try {
        console.log('Call 3: trying', provider.label);
        const messages3 = provider.noThink ? withNoThink(call3Messages) : call3Messages;
        const raw = provider.ollama
          ? await callOllama(provider.key, provider.model, messages3, 800, 0.1, provider.timeout, provider.provider)
          : await aiCall(provider.url, provider.key, provider.model, messages3, 800, 0.1, provider.timeout, provider.headers || {}, {}, provider.provider);
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        if (validateThesis(parsed)) {
          thesis = parsed;
          console.log('Call 3: OK via', provider.label);
          if (circuitSource) await cb.onSuccess(circuitSource);
        } else {
          console.warn('Call 3: schema invalid via', provider.label, JSON.stringify(parsed).slice(0, 200));
          // Schema invalid ≠ provider failure — don't penalize circuit
        }
      } catch(e) {
        console.warn('Call 3', provider.label, 'failed:', e.status || e.message);
        if (circuitSource) await cb.onFailure(circuitSource, AI_CB_THRESHOLD);
      }
    }

    if (thesis) {
      // Plan G5: guard regime dijalankan setelah validateThesis lolos, sebelum
      // cache/return. Log setiap trigger — bahan evaluasi sebelum tier 'elevated'
      // dipertimbangkan.
      const guarded = applyRegimeConfidenceGuard(thesis, riskRegimeData);
      if (guarded !== thesis) {
        console.log(`Regime guard TRIGGERED: risk_off cap — ${thesis.pair_recommendation} ${thesis.direction} conf ${thesis.confidence_1_to_5}→${guarded.confidence_1_to_5}`);
        thesis = guarded;
      }
      try {
        await redisCmd('SET', 'latest_thesis', JSON.stringify(thesis), 'EX', 21600);
        console.log('Thesis saved to Redis');
      } catch(e) {
        console.warn('Thesis Redis save failed:', e.message);
      }
    } else {
      console.warn('Call 3: all attempts failed — thesis null');
    }
  }

  // ── 8. Await Call 4 (ran concurrently with Call 1) ───────────────────────────
  // A2.4: Call 4 is an independent AI call from Call 1 (article prose) — its result
  // must not be discarded just because Call 1 fell back to the no-AI summary. A
  // Call 1 failure (quota, provider outage) previously wiped out real, already-
  // validated thesis_alerts, silently hiding genuine contra-headline warnings.
  const thesisAlerts = await _call4Promise;

  // ── Auto-update fundamental data + CB decisions from headlines ───────────────
  try {
    await autoUpdateFundamentals(recentItems.slice(0, 100), redisCmd);
  } catch(e) {
    console.warn('autoUpdateFundamentals failed:', e.message);
  }

  const payload = {
    article, method, thesis,
    thesis_alerts:  thesisAlerts,
    news_count:     recentItems.length,
    gold_count:     goldItems.length,
    cal_count:      calEvents.length,
    bias_updated:   biasUpdated,
    provider_log:   providerLog,
    quality_flags:  phraseHits.length > 0 ? { forbidden_phrases: phraseHits } : undefined,
    generated_at:   new Date().toISOString(),
  };

  // Persist full payload to Redis so cached mode works (exclude thesis_alerts — device-specific).
  // Diagnostic-only requests (?test_nemotron=1 / ?test_nemotron_super=1 / ?test_hermes=1 /
  // ?test_glm=1) must
  // NEVER reach here — they're meant to be isolated from production state (see isIsolatedTest
  // above), but this check was missing for test_nemotron* initially, so a "successful"
  // diagnostic response (HTTP 200 with raw reasoning-trace content instead of a real article)
  // got cached into `latest_article` and served to every user via mode=cached, and would have
  // also fired a push notification with that garbage content (found in production 2026-07-07).
  if (article && method !== 'fallback' && method !== 'fallback_quota' && !isIsolatedTest) {
    const toCache = { ...payload, thesis_alerts: null };
    redisCmd('SET', 'latest_article', JSON.stringify(toCache), 'EX', 21600).catch(() => {});
    // A2.2: notify subscribers once per successful digest — fire-and-forget, never block the response.
    notifyDigestReady(article).catch(e => console.warn('Digest-ready push failed:', e.message));
  }

  // Fire-and-forget (see runCronThesisSweep's own comment for why) — doesn't
  // depend on Call 1's article succeeding, only on there being headlines to
  // check theses against.
  if (isCronCall && (SAMBANOVA_KEY || GROQ_KEY) && recentItems.length > 0) {
    runCronThesisSweep(recentItems, SAMBANOVA_KEY, GROQ_KEY).catch(e => console.warn('Cron thesis sweep failed:', e.message));
  }

  return res.status(200).json(payload);
};

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const res = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(5000),
  });
  return (await res.json()).result;
}

// A2.2 — sesi label matches the 3 vercel.json cron times (UTC 00:00 / 07:00 / 12:30).
function sesiLabel() {
  const h = new Date().getUTCHours();
  if (h < 4)  return 'sesi Asia';
  if (h < 10) return 'sesi Eropa';
  return 'sesi NY';
}

// A2.2 — sends exactly one "Ringkasan siap" push per successful digest. Fire-and-forget:
// failures here must never affect the digest response itself.
async function notifyDigestReady(articleText) {
  if (!configureVapid()) return;
  let subs = [];
  try {
    const raw = await redisCmd('HGETALL', 'push_subs');
    if (Array.isArray(raw)) {
      for (let i = 0; i < raw.length; i += 2) {
        try { subs.push(JSON.parse(raw[i + 1])); } catch(e) {}
      }
    }
  } catch(e) {}
  if (subs.length === 0) return;

  const firstSentence = (articleText.split(/\n/).find(l => l.trim()) || articleText).trim();
  const body = firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence;
  const payload = { title: `📰 Ringkasan ${sesiLabel()} siap`, body, url: '/#ringkasan', icon: '/icon.svg' };

  const staleKeys = await sendWebPush(subs, payload);
  if (staleKeys.length > 0) await redisCmd('HDEL', 'push_subs', ...staleKeys).catch(() => {});
}

function toDateStr(d) { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

function parseRSS(xml) {
  const items = [], re = /<item>([\s\S]*?)<\/item>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const get = tag => { const r1=new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`).exec(b); const r2=new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(b); return (r1||r2)?.[1]?.trim()||''; };
    const title=get('title').replace(/^FinancialJuice:\s*/i,'').trim(), guid=get('guid'), pubDate=get('pubDate'), link=b.match(/<link>(.*?)<\/link>/)?.[1]||'';
    if (guid&&title) {
      const item = { title, guid, pubDate, link };
      // Same rule as feeds.js's parseRSSItems: only keep the body text for CB-relevant
      // headlines (Call 2 evidence needs more than a bare title) — everything else stays
      // title-only so this doesn't balloon the in-memory item list.
      if (isCbHeadline(title)) item.description = get('description');
      items.push(item);
    }
  }
  return items;
}

function parseFFXML(xml) {
  const events = [], re = /<event>([\s\S]*?)<\/event>/g; let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => { const r=new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(block); if(!r)return''; return r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g,'$1').trim(); };
    const title=get('title'), country=get('country').toUpperCase(), date=get('date'), time=get('time'), impact=get('impact');
    // forecast/previous ADA di XML ForexFactory tapi dulu dibuang — padahal prompt
    // Call 1/3 menuntut skenario beat/miss per event; tanpa angka konsensus, AI
    // menebak asimetrinya sendiri. Sekarang ikut dibawa ke calBlock.
    const forecast=get('forecast'), previous=get('previous');
    if (!title||!country) continue;
    const dp=date.match(/(\d{2})-(\d{2})-(\d{4})/); if(!dp) continue;
    events.push({ date:`${dp[3]}-${dp[1]}-${dp[2]}`, time_wib:convertToWIB(time), currency:country, event:title, impact, forecast:forecast||null, previous:previous||null });
  }
  return events;
}

function convertToWIB(timeStr) {
  if (!timeStr||timeStr==='All Day'||timeStr==='Tentative') return 'Tentative';
  const m=timeStr.match(/(\d{1,2}):(\d{2})(am|pm)/i); if(!m) return timeStr;
  let hour=parseInt(m[1]); const min=parseInt(m[2]), ampm=m[3].toLowerCase();
  if(ampm==='pm'&&hour!==12)hour+=12; if(ampm==='am'&&hour===12)hour=0;
  return `${String((hour+7)%24).padStart(2,'0')}:${String(min).padStart(2,'0')} WIB`;
}


// Ekspor helper murni untuk unit test (module.exports = handler function; properti
// tambahan tidak mengganggu Vercel yang cuma memanggilnya sebagai function biasa)
module.exports.aiCall = aiCall;
module.exports.NEMOTRON_MODEL = NEMOTRON_MODEL;
module.exports.CB_OPENROUTER_NEMOTRON = CB_OPENROUTER_NEMOTRON;
module.exports.OPENROUTER_URL = OPENROUTER_URL;
module.exports.OPENROUTER_HEADERS = OPENROUTER_HEADERS;
module.exports.callOllama = callOllama;
module.exports.OLLAMA_URL = OLLAMA_URL;
module.exports.OLLAMA_NEMOTRON_MODEL = OLLAMA_NEMOTRON_MODEL;
module.exports.CB_OLLAMA_NEMOTRON = CB_OLLAMA_NEMOTRON;
module.exports.withNoThink = withNoThink;
module.exports.NEMOTRON_SUPER_MODEL = NEMOTRON_SUPER_MODEL;
module.exports.validateThesis = validateThesis;
module.exports.applyRegimeConfidenceGuard = applyRegimeConfidenceGuard;
module.exports.classifyDataSurpriseSeverity = classifyDataSurpriseSeverity;
module.exports.severityTagForHeadline = severityTagForHeadline;
module.exports.parseEconNumber = parseEconNumber;
module.exports.thesisPairCurrencies = thesisPairCurrencies;
module.exports.thesisInvalidationCurrencyConsistent = thesisInvalidationCurrencyConsistent;
module.exports.CB_OPENROUTER_NEMOTRON_SUPER = CB_OPENROUTER_NEMOTRON_SUPER;
module.exports.HERMES_MODEL = HERMES_MODEL;
module.exports.CB_OPENROUTER_HERMES = CB_OPENROUTER_HERMES;
module.exports.mergeSourceHeadlines = mergeSourceHeadlines;
