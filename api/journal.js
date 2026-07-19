// api/journal.js
// Trade journal — POST (create), PATCH (close), GET (list), DELETE (soft-delete)
// GET ?action=analyze — AI analysis of closed trades (Groq, cached 1h per device)
// Redis: journal:{device_id}:{id} (full entry), journal_index:{device_id} (sorted set by created_at ms)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

const rateLimit = require('./_ratelimit');
const { allowAiCall } = require('./_ai_guard');
const cb = require('./_circuit_breaker');

// device_id dipakai langsung sebagai bagian key Redis — batasi charset & panjang
const DEVICE_ID_RE   = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 32 * 1024; // entry punya thesis_text + snapshot CB/COT
const VALID_DIRECTIONS = new Set(['long', 'short', '']);
const VALID_STATUS     = new Set(['open', 'closed', 'archived']);
const VALID_FILL_STATE = new Set(['pending', 'filled', 'cancelled']);

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

// Checklist tick-state at the moment a trade was saved (see jnSave() in index.html) —
// a flat map of item-id -> boolean. Whitelisted to plain booleans and a sane key
// count/length so a malformed client payload can't blow up storage or the
// edge_stats aggregation below.
function sanitizeChecklistSnapshot(snap) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return null;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(snap)) {
    if (n >= 40) break;
    if (typeof k !== 'string' || !k || k.length > 40) continue;
    out[k] = !!v;
    n++;
  }
  return n > 0 ? out : null;
}

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
// Cerebras gpt-oss-120b (session 145) — primary baru AI Coach, pool token/hari sendiri
// (terpisah dari OpenRouter yang dipakai Nemotron 3 Ultra di market-digest.js).
const CEREBRAS_URL      = 'https://api.cerebras.ai/v1/chat/completions';
const CEREBRAS_MODEL    = 'gpt-oss-120b';
const CB_CEREBRAS_GPTOSS = 'ai:cerebras:gptoss';
// Sama seperti CB_SAMBA_C1 di market-digest.js — akun 2 SambaNova dipakai bersama
// sebagai fallback1 journal_analysis + fundamental_analysis + primary Call 1 digest.
const CB_SAMBA_C1 = 'ai:sambanova:c1';
// Gemini AI Studio — fallback terakhir AI Coach (2026-07-19), konstanta & alasan sama
// dengan GEMINI_URL_FUND di admin.js (alias -latest → gemini-3.5-flash; lolos gate ToS
// produksi daun_merah_riset.md S183; budget guard 'gemini' sudah ada di _ai_guard.js).
const GEMINI_URL   = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_MODEL = 'gemini-flash-latest';
const CB_GEMINI    = 'ai:gemini'; // circuit dipakai bersama market-digest.js & admin.js — provider sama
const ANALYSIS_CACHE_TTL = 60 * 60; // 1 hour

async function callProvider(url, apiKey, model, messages, maxTokens, temperature, timeoutMs, extraBody = {}) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature, ...extraBody }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    const e = new Error(err?.error?.message || `HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const data = await r.json();
  const choice = data?.choices?.[0];
  if (choice?.finish_reason === 'length') {
    console.warn(`journal aiCall truncated (finish_reason=length, model=${model}, max_tokens=${maxTokens})`);
  }
  const txt = choice?.message?.content?.trim() || '';
  if (!txt) throw new Error('Empty response');
  return txt;
}

// session 145: dulu Groq-only tanpa fallback/circuit breaker sama sekali — sekarang
// 4-tier (Cerebras gpt-oss-120b primary -> SambaNova akun2 fallback1 -> Groq fallback2
// -> Gemini flash fallback3 (2026-07-19), last resort baru; Groq kini ikut di-try/catch
// supaya kegagalannya jatuh ke Gemini, bukan langsung melempar ke caller).
async function aiCall(messages, maxTokens = 1000) {
  const CEREBRAS_KEY        = process.env.CEREBRAS_API_KEY;
  const SAMBANOVA_KEY_CALL1 = process.env.SAMBANOVA_API_KEY_CALL1;
  const GROQ_KEY            = process.env.GROQ_API_KEY;
  const GEMINI_KEY          = process.env.GEMINI_API_KEY;

  if (CEREBRAS_KEY && await cb.canCall(CB_CEREBRAS_GPTOSS)) {
    try {
      if (!await allowAiCall('cerebras')) throw new Error('AI daily budget exceeded');
      const txt = await callProvider(CEREBRAS_URL, CEREBRAS_KEY, CEREBRAS_MODEL, messages, maxTokens, 0.4, 20000);
      await cb.onSuccess(CB_CEREBRAS_GPTOSS);
      return txt;
    } catch(e) {
      console.warn('journal aiCall: Cerebras failed:', e.message);
      await cb.onFailure(CB_CEREBRAS_GPTOSS);
    }
  }

  if (SAMBANOVA_KEY_CALL1 && await cb.canCall(CB_SAMBA_C1)) {
    try {
      if (!await allowAiCall('sambanova_c1')) throw new Error('AI daily budget exceeded');
      const txt = await callProvider('https://api.sambanova.ai/v1/chat/completions', SAMBANOVA_KEY_CALL1, 'DeepSeek-V3.2', messages, maxTokens, 0.4, 30000);
      await cb.onSuccess(CB_SAMBA_C1);
      return txt;
    } catch(e) {
      console.warn('journal aiCall: SambaNova akun2 failed:', e.message);
      await cb.onFailure(CB_SAMBA_C1);
    }
  }

  if (GROQ_KEY) {
    try {
      if (!await allowAiCall('groq')) throw new Error('AI daily budget exceeded');
      return await callProvider(GROQ_URL, GROQ_KEY, GROQ_MODEL, messages, maxTokens, 0.4, 30000);
    } catch(e) {
      console.warn('journal aiCall: Groq failed:', e.message);
    }
  }

  if (GEMINI_KEY && await cb.canCall(CB_GEMINI)) {
    try {
      if (!await allowAiCall('gemini')) throw new Error('AI daily budget exceeded');
      const txt = await callProvider(GEMINI_URL, GEMINI_KEY, GEMINI_MODEL, messages, maxTokens, 0.4, 25000, { reasoning_effort: 'low' });
      await cb.onSuccess(CB_GEMINI);
      return txt;
    } catch(e) {
      console.warn('journal aiCall: Gemini failed:', e.message);
      await cb.onFailure(CB_GEMINI);
    }
  }

  throw new Error('All AI providers failed or none configured (CEREBRAS_API_KEY / SAMBANOVA_API_KEY_CALL1 / GROQ_API_KEY / GEMINI_API_KEY)');
}

async function redisCmd(...args) {
  const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
  const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(6000),
  });
  return (await r.json()).result;
}

async function readBody(req) {
  if (req.body !== undefined) {
    return typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
  }
  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  return body;
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── MFE/MAE (max favorable/adverse excursion) ─────────────────────────────
// Computed once, at the moment a trade is closed, from OHLCV candles already
// synced by the ohlcv_sync cron (api/admin.js). This is a rolling cache (~5d
// at 1H, ~10d at 4H, ~30d at 1D) — NOT a permanent price-path store — so it
// only works if [entry_time, close_time] still falls inside that window.
// Older/longer-held trades, or pairs the cron never synced, get an explicit
// "unavailable" quality flag instead of a fabricated/partial number.
const PAIR_SYMBOL_MAP = {
  EURUSD: 'EURUSD=X', GBPUSD: 'GBPUSD=X', USDJPY: 'USDJPY=X',
  AUDUSD: 'AUDUSD=X', USDCAD: 'USDCAD=X', USDCHF: 'USDCHF=X',
  NZDUSD: 'NZDUSD=X', EURJPY: 'EURJPY=X', GBPJPY: 'GBPJPY=X',
  EURGBP: 'EURGBP=X', AUDJPY: 'AUDJPY=X', EURAUD: 'EURAUD=X',
  GBPAUD: 'GBPAUD=X', GBPCAD: 'GBPCAD=X', XAUUSD: 'GC=F',
};

function computeExcursion(direction, entryPrice, candles) {
  let best = entryPrice, worst = entryPrice;
  for (const c of candles) {
    if (direction === 'long') {
      if (c.h > best)  best  = c.h;
      if (c.l < worst) worst = c.l;
    } else {
      if (c.l < best)  best  = c.l;
      if (c.h > worst) worst = c.h;
    }
  }
  return {
    mfe_price: +best.toFixed(6),
    mae_price: +worst.toFixed(6),
    mfe_dist:  +(direction === 'long' ? best  - entryPrice : entryPrice - best ).toFixed(6),
    mae_dist:  +(direction === 'long' ? entryPrice - worst : worst - entryPrice).toFixed(6),
  };
}

async function computeMfeMae(entry) {
  if (entry.entry_price == null || !entry.created_at || !entry.direction) {
    return { quality: 'unavailable', reason: 'missing_fields' };
  }
  const pairKey = (entry.pair || '').toUpperCase().replace('/', '');
  const symbol  = PAIR_SYMBOL_MAP[pairKey];
  if (!symbol) return { quality: 'unavailable', reason: 'pair_not_synced' };

  const entryTs = new Date(entry.created_at).getTime() / 1000;
  const exitTs  = Date.now() / 1000;
  const tiers   = [
    { key: `ohlcv:${symbol}:1h`, label: '1h' },
    { key: `ohlcv:${symbol}:4h`, label: '4h' },
    { key: `ohlcv:${symbol}:1d`, label: '1d' },
  ];

  for (const tier of tiers) {
    try {
      const raw = await redisCmd('GET', tier.key);
      if (!raw) continue;
      const candles = JSON.parse(raw);
      if (!Array.isArray(candles) || candles.length === 0) continue;
      if (candles[0].t > entryTs) continue; // window doesn't reach back to entry — try a coarser tier
      const windowed = candles.filter(c => c.t >= entryTs && c.t <= exitTs);
      if (windowed.length === 0) continue;
      return { ...computeExcursion(entry.direction, entry.entry_price, windowed), quality: tier.label };
    } catch(e) { continue; }
  }
  return { quality: 'unavailable', reason: 'data_window_exceeded' };
}

// ── Journal Bias Analyzer (Plan I item 5, session 180) ────────────────────────
// Diagnosa kebiasaan buruk trading dari data jurnal yang SUDAH ada — statistik
// dihitung KODE (deterministik, testable), AI cuma menarasikan 1x saat user minta
// (lihat biasDiagnosisHandler di bawah). Konsep dari referensi user (Vibe-Trading),
// diadaptasi versi mini: bukan sinyal trading, cermin disiplin dari jurnal sendiri.
const JOURNAL_BIAS_MIN_SAMPLE = 10;
const JOURNAL_BIAS_SESSIONS = [
  { key: 'tokyo',   label: 'Tokyo',              start: 0,      end: 8 * 60 },
  { key: 'london',  label: 'London',             start: 8 * 60, end: 13 * 60 },
  { key: 'overlap', label: 'London+NY Overlap',  start: 13 * 60, end: 16 * 60 },
  { key: 'ny',      label: 'New York',           start: 16 * 60, end: 21 * 60 },
  { key: 'closed',  label: 'Market Closed',      start: 21 * 60, end: 24 * 60 },
];

function _journalBiasStats(entries) {
  const closed = (Array.isArray(entries) ? entries : [])
    .filter(e => e && e.status === 'closed' && typeof e.r_actual === 'number' && !isNaN(e.r_actual) && e.created_at);
  if (closed.length < JOURNAL_BIAS_MIN_SAMPLE) {
    return { sufficient: false, sample_count: closed.length, min_required: JOURNAL_BIAS_MIN_SAMPLE };
  }
  const sorted = [...closed].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : null;

  // 1. Disposition effect: rasio avg win R / avg loss R (magnitude). < 1 = profit
  // kecil-kecil diambil buru-buru, loss dibiarkan besar — indikasi klasik.
  const winsR   = sorted.filter(e => e.r_actual > 0).map(e => e.r_actual);
  const lossesR = sorted.filter(e => e.r_actual < 0).map(e => Math.abs(e.r_actual));
  const avgWinR  = avg(winsR), avgLossR = avg(lossesR);
  const dispositionRatio = (avgWinR != null && avgLossR != null && avgLossR > 0)
    ? +(avgWinR / avgLossR).toFixed(2) : null;

  // 2. Overtrading/revenge trading: jarak (jam) dari CLOSE trade sebelumnya ke
  // ENTRY trade berikutnya, dipisah berdasarkan apakah trade sebelumnya win/loss.
  // Jarak jauh lebih pendek setelah loss = indikasi revenge trading.
  const gapsAfterWin = [], gapsAfterLoss = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    const prevCloseMs = new Date(prev.closed_at || prev.created_at).getTime();
    const curEntryMs  = new Date(cur.created_at).getTime();
    const gapH = (curEntryMs - prevCloseMs) / 3600000;
    if (!isFinite(gapH) || gapH < 0) continue;
    if (prev.r_actual > 0) gapsAfterWin.push(gapH);
    else if (prev.r_actual < 0) gapsAfterLoss.push(gapH);
  }
  const avgGapAfterWin  = avg(gapsAfterWin);
  const avgGapAfterLoss = avg(gapsAfterLoss);
  const overtradingSignal = (avgGapAfterWin != null && avgGapAfterLoss != null && avgGapAfterWin > 0)
    ? avgGapAfterLoss < avgGapAfterWin * 0.6
    : null;

  // 3. Distribusi jam entry vs sesi FX (UTC) — sesi mana yang paling sering
  // dipakai entry, dan win-rate-nya masing-masing (mis. sering entry pas CLOSED
  // / Tokyo yang minim likuiditas).
  const sessionOf = iso => {
    const d = new Date(iso);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return JOURNAL_BIAS_SESSIONS.find(s => mins >= s.start && mins < s.end) || JOURNAL_BIAS_SESSIONS[JOURNAL_BIAS_SESSIONS.length - 1];
  };
  const bySession = {};
  for (const e of sorted) {
    const key = sessionOf(e.created_at).key;
    if (!bySession[key]) bySession[key] = { n: 0, wins: 0, totalR: 0 };
    bySession[key].n++;
    if (e.r_actual > 0) bySession[key].wins++;
    bySession[key].totalR += e.r_actual;
  }
  const sessionStats = Object.entries(bySession)
    .map(([key, v]) => ({ session: key, n: v.n, win_rate: Math.round(v.wins / v.n * 100), avg_r: +(v.totalR / v.n).toFixed(2) }))
    .sort((a, b) => b.n - a.n);

  // 4. Win-rate per playbook (checklist_playbook — null = entri manual tanpa checklist).
  const byPb = {};
  for (const e of sorted) {
    const key = e.checklist_playbook || 'manual (tanpa checklist)';
    if (!byPb[key]) byPb[key] = { n: 0, wins: 0, totalR: 0 };
    byPb[key].n++;
    if (e.r_actual > 0) byPb[key].wins++;
    byPb[key].totalR += e.r_actual;
  }
  const playbookStats = Object.entries(byPb)
    .map(([key, v]) => ({ playbook: key, n: v.n, win_rate: Math.round(v.wins / v.n * 100), avg_r: +(v.totalR / v.n).toFixed(2) }))
    .sort((a, b) => b.n - a.n);

  // 5. Streak: beruntun saat ini (dari trade terbaru mundur) + loss streak terpanjang historis.
  let currentStreak = 0, currentStreakType = null;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const isWin = sorted[i].r_actual > 0;
    if (i === sorted.length - 1) { currentStreakType = isWin ? 'win' : 'loss'; currentStreak = 1; }
    else if ((isWin && currentStreakType === 'win') || (!isWin && currentStreakType === 'loss')) currentStreak++;
    else break;
  }
  let longestLossStreak = 0, runLoss = 0;
  for (const e of sorted) {
    if (e.r_actual <= 0) { runLoss++; longestLossStreak = Math.max(longestLossStreak, runLoss); }
    else runLoss = 0;
  }

  return {
    sufficient: true,
    sample_count: sorted.length,
    disposition: { avg_win_r: avgWinR != null ? +avgWinR.toFixed(2) : null, avg_loss_r: avgLossR != null ? +avgLossR.toFixed(2) : null, ratio: dispositionRatio },
    overtrading: { avg_gap_after_win_h: avgGapAfterWin != null ? +avgGapAfterWin.toFixed(1) : null, avg_gap_after_loss_h: avgGapAfterLoss != null ? +avgGapAfterLoss.toFixed(1) : null, signal: overtradingSignal },
    session_stats: sessionStats,
    playbook_stats: playbookStats,
    streak: { current: currentStreak, current_type: currentStreakType, longest_loss_streak: longestLossStreak },
  };
}

const { requireAppKey } = require('./_app_key');
module.exports = async function handler(req, res) {
  if (requireAppKey(req, res)) return; // gate APP_KEY (cron/admin secret lolos) — lihat api/_app_key.js
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === 'OPTIONS') return res.status(204).end();

  const deviceId = req.query.device_id;
  if (!deviceId || !DEVICE_ID_RE.test(deviceId)) return res.status(400).json({ error: 'device_id required' });

  if (await rateLimit(req, res, { limit: 30, windowSecs: 60, endpoint: 'journal' })) return;

  const indexKey = `journal_index:${deviceId}`;

  // ── POST — create entry ───────────────────────────────
  if (req.method === 'POST') {
    const rawBody = await readBody(req);
    if (Buffer.byteLength(rawBody || '', 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Body too large' });
    }
    let data;
    try { data = JSON.parse(rawBody); }
    catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid entry' });
    }
    if (data.direction != null && !VALID_DIRECTIONS.has(data.direction)) {
      return res.status(400).json({ error: 'direction must be long/short' });
    }

    const id = uid();
    const now = Date.now();
    const entry = {
      id, device_id: deviceId, created_at: new Date(now).toISOString(),
      // open fields
      pair:              clampStr(data.pair, 16),
      direction:         data.direction        || '',
      regime_at_entry:   data.regime_at_entry  || null,
      thesis_text:       clampStr(data.thesis_text, 8000),
      driver_references: Array.isArray(data.driver_references) ? data.driver_references.slice(0, 20) : [],
      cb_bias_snapshot:  data.cb_bias_snapshot  || null,
      cot_snapshot:      data.cot_snapshot      || null,
      cot_alignment:     data.cot_alignment     != null ? !!data.cot_alignment : null,
      entry_price:       data.entry_price       != null ? parseFloat(data.entry_price) : null,
      stop_price:        data.stop_price        != null ? parseFloat(data.stop_price)  : null,
      target_price:      data.target_price      != null ? parseFloat(data.target_price): null,
      size_lots:         data.size_lots         != null ? parseFloat(data.size_lots)   : null,
      rr_planned:        data.rr_planned        != null ? parseFloat(data.rr_planned)  : null,
      time_horizon:      data.time_horizon      || '',
      // Checklist state at save time — see sanitizeChecklistSnapshot() and
      // GET ?action=edge_stats below. null when the entry wasn't created via a
      // Checklist run for this exact pair (e.g. manual "+ BARU" entry).
      checklist_snapshot: sanitizeChecklistSnapshot(data.checklist_snapshot),
      checklist_playbook: clampStr(data.checklist_playbook, 40) || null,
      checklist_pct:      data.checklist_pct != null ? Math.max(0, Math.min(100, parseInt(data.checklist_pct, 10) || 0)) : null,
      // pending-order tracking — see jnReconcilePendingOrders() in index.html
      order_kind:        clampStr(data.order_kind, 20) || null,
      mt5_ticket:        data.mt5_ticket        != null ? parseInt(data.mt5_ticket, 10) || null : null,
      fill_state:        data.fill_state === 'pending' ? 'pending' : 'filled',
      // closed fields (filled on PATCH)
      status:            'open',
      exit_price:        null,
      exit_reason:       null,
      r_actual:          null,
      attribution_notes: null,
      closed_at:         null,
      excursion:         null, // filled on close — see computeMfeMae()
    };

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      await redisCmd('SET', entryKey, JSON.stringify(entry));
      await redisCmd('ZADD', indexKey, now, id);
      // Registry of devices with journal data — lets the scheduled market-digest
      // cron run the thesis invalidation monitor (Call 4) for every device with
      // open trades, not just whichever device happens to be live in-app (see
      // market-digest.js `journal_devices` usage).
      await redisCmd('SADD', 'journal_devices', deviceId).catch(() => {});
      return res.status(200).json({ ok: true, id });
    } catch(e) {
      console.error('journal POST failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── PATCH — close/update entry ────────────────────────
  if (req.method === 'PATCH') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const rawBody = await readBody(req);
    if (Buffer.byteLength(rawBody || '', 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Body too large' });
    }
    let data;
    try { data = JSON.parse(rawBody); }
    catch(e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return res.status(400).json({ error: 'Invalid body' });
    }
    if (data.status && !VALID_STATUS.has(data.status)) {
      return res.status(400).json({ error: 'status must be open/closed/archived' });
    }
    if (data.fill_state && !VALID_FILL_STATE.has(data.fill_state)) {
      return res.status(400).json({ error: 'fill_state must be pending/filled/cancelled' });
    }

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      const raw = await redisCmd('GET', entryKey);
      if (!raw) return res.status(404).json({ error: 'Entry not found' });
      const entry = JSON.parse(raw);

      // Allow partial update of any close fields
      if (data.exit_price    != null) entry.exit_price    = parseFloat(data.exit_price);
      if (data.exit_reason               ) entry.exit_reason    = clampStr(data.exit_reason, 200);
      if (data.r_actual      != null) entry.r_actual      = parseFloat(data.r_actual);
      if (data.attribution_notes         ) entry.attribution_notes = clampStr(data.attribution_notes, 8000);
      if (data.status                    ) entry.status          = data.status;
      if (data.fill_state                ) entry.fill_state      = data.fill_state;

      // Auto-set closed_at when status becomes closed/archived
      if (data.status === 'closed' || data.status === 'archived') {
        entry.closed_at = entry.closed_at || new Date().toISOString();
      }

      // Compute MFE/MAE once, right when the trade actually closes — this is the
      // only moment the OHLCV rolling cache is guaranteed to still cover entry_time.
      if ((entry.status === 'closed' || entry.status === 'archived') && !entry.excursion) {
        try { entry.excursion = await computeMfeMae(entry); }
        catch(e) { entry.excursion = { quality: 'unavailable', reason: e.message }; }
      }

      await redisCmd('SET', entryKey, JSON.stringify(entry));
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('journal PATCH failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── GET ?action=analyze — AI performance analysis ────
  if (req.method === 'GET' && req.query.action === 'analyze') {
    const cacheKey = `journal_analysis:${deviceId}`;
    const force    = req.query.force === '1';

    if (!force) {
      try {
        const cached = await redisCmd('GET', cacheKey);
        if (cached) return res.status(200).json({ ...JSON.parse(cached), from_cache: true });
      } catch(e) { console.warn('journal analyze: Redis GET failed:', e.message); }
    }

    // Load all closed entries via MGET batch
    let entries = [];
    try {
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      if (ids.length > 0) {
        const keys = ids.map(id => `journal:${deviceId}:${id}`);
        const rawEntries = await redisCmd('MGET', ...keys);
        entries = (Array.isArray(rawEntries) ? rawEntries : [])
          .map(raw => { try { return raw ? JSON.parse(raw) : null; } catch(_) { return null; } })
          .filter(e => e && e.status === 'closed');
      }
    } catch(e) {
      console.error('journal analyze: Redis fetch failed:', e.message);
      return res.status(500).json({ error: 'Gagal membaca data jurnal' });
    }

    if (entries.length < 3) {
      return res.status(200).json({
        analysis: null, insufficient_data: true, closed_count: entries.length,
        message: `Butuh minimal 3 trade closed untuk analisis. Saat ini baru ada ${entries.length}.`,
      });
    }

    const withR   = entries.filter(e => e.r_actual != null);
    const wins    = withR.filter(e => e.r_actual > 0).length;
    const totalR  = withR.reduce((s, e) => s + e.r_actual, 0);
    const avgR    = withR.length > 0 ? (totalR / withR.length).toFixed(2) : 'N/A';
    const winRate = withR.length > 0 ? Math.round(wins / withR.length * 100) : 'N/A';

    const tradeSummaries = entries.map((e, i) => {
      const result = e.r_actual != null ? (e.r_actual >= 0 ? `WIN +${e.r_actual}R` : `LOSS ${e.r_actual}R`) : 'RESULT UNKNOWN';
      const cotInfo = e.cot_snapshot ? Object.entries(e.cot_snapshot).map(([c, v]) => `${c} COT net=${v.lev_net}${v.lev_change_net != null ? ` (Δ${v.lev_change_net >= 0 ? '+' : ''}${v.lev_change_net})` : ''}`).join(', ') : 'no COT';
      const alignInfo = e.cot_alignment === true ? 'selaras smart money' : e.cot_alignment === false ? 'KONTRA smart money' : null;
      const entryDate = e.created_at ? e.created_at.slice(0, 10) : 'N/A';
      // Pair tersimpan ber-slash ("EUR/USD") — slice(3,6) lama menghasilkan "/US",
      // sehingga CB bias quote currency tidak pernah masuk prompt AI coach.
      const pairCurrencies = e.pair
        ? (e.pair.includes('/') ? e.pair.split('/') : [e.pair.slice(0, 3), e.pair.slice(3, 6)])
        : [];
      const cbInfo = e.cb_bias_snapshot
        ? pairCurrencies.map(c => { const b = e.cb_bias_snapshot[c]; return b ? `${c}=${b.bias}` : null; }).filter(Boolean).join(', ') || 'no CB data'
        : 'no CB data';
      const drivers = Array.isArray(e.driver_references) && e.driver_references.length > 0
        ? e.driver_references.join(', ') : null;
      // MFE/MAE — "execution reality check": lets the AI tell apart a thesis that
      // was simply wrong vs one that was right but exited early on panic/noise.
      // Only included when the OHLCV rolling cache actually covered the trade's
      // full duration (see computeMfeMae in this file) — never a guessed number.
      const exc = e.excursion;
      const excInfo = exc && exc.quality !== 'unavailable'
        ? `  Excursion (data ${exc.quality}): MFE +${exc.mfe_dist} (harga terbaik ${exc.mfe_price}) | MAE -${Math.abs(exc.mae_dist)} (harga terburuk ${exc.mae_price})`
        : '  Excursion: data tidak cukup (di luar jangkauan cache OHLCV)';
      return [
        `Trade ${i + 1}: ${e.pair} ${(e.direction || '').toUpperCase()} | ${result} | ${entryDate}`,
        `  RR planned: ${e.rr_planned || 'N/A'} | Horizon: ${e.time_horizon || 'N/A'} | Regime: ${e.regime_at_entry || 'N/A'}`,
        `  CB bias at entry: ${cbInfo}`,
        `  ${cotInfo}${alignInfo ? ` — ${alignInfo}` : ''}`,
        drivers ? `  Drivers: ${drivers}` : '',
        `  Thesis: ${(e.thesis_text || '').slice(0, 250)}`,
        e.attribution_notes ? `  Post-trade note: ${e.attribution_notes.slice(0, 200)}` : '',
        `  Exit reason: ${e.exit_reason || 'N/A'}`,
        excInfo,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    let analysis = '';
    try {
      analysis = await aiCall([
        { role: 'system', content: 'Kamu adalah coach trading forex profesional yang menganalisis jurnal trading seorang trader discretionary macro. Trader ini menggunakan framework berbasis: CB bias per currency (hawkish/dovish), regime pasar (risk_on/off/neutral), COT positioning, dan thesis fundamental makro. Berikan analisis jujur, spesifik, dan actionable dalam Bahasa Indonesia. Format: heading dengan **bold**, poin-poin ringkas. Fokus pada pola nyata dari data — jangan generik, jangan teori umum trading.' },
        { role: 'user', content: `Analisis ${entries.length} trade closed berikut:\n\nStatistik: Win rate ${winRate}% | Total R ${typeof totalR === 'number' ? totalR.toFixed(2) : totalR} | Avg R/trade ${avgR}\n\n${tradeSummaries}\n\nAnalisis:\n1. **Pola Hasil** — identifikasi pola win/loss berdasarkan regime, pair, atau horizon. Apakah ada kondisi spesifik di mana trader ini lebih sering menang atau kalah?\n2. **Keselarasan Framework** — untuk setiap trade, apakah CB bias kedua currency, regime, dan positioning institusional (COT) mendukung arah trade saat entry? Sebutkan trade mana yang masuk meski konteks tidak selaras (termasuk yang ditandai "KONTRA smart money"), dan apakah hasilnya konsisten dengan itu.\n3. **Kualitas Thesis & Driver** — seberapa spesifik dan dapat difalsifikasi thesis yang dicantumkan? Apakah driver yang disebutkan terbukti relevan dengan hasil?\n4. **Realitas Eksekusi (MFE/MAE)** — kalau data excursion tersedia, bedakan trade yang LOSS karena thesis salah (MFE kecil, harga nggak pernah ke arah yang diharapkan) vs trade yang LOSS karena panic-exit/noise (MFE besar/menguntungkan tapi tetap exit rugi — artinya thesis sempat benar tapi eksekusinya yang gagal). Sebutkan trade spesifik mana yang masuk kategori panic-exit kalau ada.\n5. **Kelemahan Utama** — 2-3 kelemahan paling jelas yang terpola dari data, bukan dari teori\n6. **Rekomendasi Konkret** — 3 hal spesifik yang bisa langsung diubah dalam proses entry/eksekusi berikutnya\n\nJangan pakai tabel markdown (boros token, sering kepotong) — pakai poin-poin ringkas untuk semua section. Maksimal 650 kata TOTAL untuk semua 6 section gabungan.` },
      ], 2200);
    } catch(e) {
      console.error('journal analyze: AI call failed:', e.message);
      return res.status(502).json({ error: 'AI tidak tersedia: ' + e.message });
    }

    const payload = {
      analysis, closed_count: entries.length,
      win_rate: winRate,
      total_r:  withR.length > 0 ? parseFloat(totalR.toFixed(2)) : null,
      avg_r:    avgR !== 'N/A' ? parseFloat(avgR) : null,
      generated_at: new Date().toISOString(),
    };
    redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', ANALYSIS_CACHE_TTL).catch(() => {});
    return res.status(200).json(payload);
  }

  // ── GET ?action=edge_stats — win-rate/expectancy split by checklist condition ──
  // Answers "does this checklist condition actually predict a win?" using the
  // trader's own closed trades — not a backtest, an aggregation of real outcomes
  // segmented by which items were ticked at entry (see checklist_snapshot above).
  if (req.method === 'GET' && req.query.action === 'edge_stats') {
    const MIN_TOTAL  = 5; // same floor as ?action=analyze
    const MIN_BUCKET = 3; // per-side minimum so one lucky/unlucky trade can't swing a %

    let entries = [];
    try {
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      if (ids.length > 0) {
        const keys = ids.map(id => `journal:${deviceId}:${id}`);
        const rawEntries = await redisCmd('MGET', ...keys);
        entries = (Array.isArray(rawEntries) ? rawEntries : [])
          .map(raw => { try { return raw ? JSON.parse(raw) : null; } catch(_) { return null; } })
          .filter(e => e && e.status === 'closed' && e.r_actual != null && e.checklist_snapshot);
      }
    } catch(e) {
      console.error('journal edge_stats: Redis fetch failed:', e.message);
      return res.status(500).json({ error: 'Gagal membaca data jurnal' });
    }

    if (entries.length < MIN_TOTAL) {
      return res.status(200).json({
        conditions: [], insufficient_data: true, sample_count: entries.length,
        message: `Butuh minimal ${MIN_TOTAL} trade closed dengan checklist tercatat. Saat ini baru ada ${entries.length}.`,
      });
    }

    const ids = new Set();
    entries.forEach(e => Object.keys(e.checklist_snapshot).forEach(k => ids.add(k)));

    const stat = (group) => {
      const wins   = group.filter(e => e.r_actual > 0).length;
      const totalR = group.reduce((s, e) => s + e.r_actual, 0);
      return {
        n: group.length,
        win_rate: Math.round(wins / group.length * 100),
        avg_r: parseFloat((totalR / group.length).toFixed(2)),
      };
    };

    const conditions = [];
    ids.forEach(id => {
      const checked   = entries.filter(e => e.checklist_snapshot[id] === true);
      const unchecked = entries.filter(e => e.checklist_snapshot[id] === false);
      if (checked.length < MIN_BUCKET || unchecked.length < MIN_BUCKET) return; // not enough data either side yet
      const checkedStat = stat(checked), uncheckedStat = stat(unchecked);
      conditions.push({
        id,
        checked: checkedStat,
        unchecked: uncheckedStat,
        avg_r_delta: parseFloat((checkedStat.avg_r - uncheckedStat.avg_r).toFixed(2)),
        win_rate_delta: checkedStat.win_rate - uncheckedStat.win_rate,
      });
    });

    // Most predictive first — biggest absolute swing in expectancy between ticked/not
    conditions.sort((a, b) => Math.abs(b.avg_r_delta) - Math.abs(a.avg_r_delta));

    return res.status(200).json({ conditions, insufficient_data: false, sample_count: entries.length });
  }

  // ── GET ?action=bias_diagnosis — Journal Bias Analyzer (Plan I item 5) ────
  // Stats deterministik dari _journalBiasStats (0 AI call kalau sampel kurang);
  // narasi AI 1x per klik, cache 24h (dipakai mingguan, bukan tiap buka jurnal).
  if (req.method === 'GET' && req.query.action === 'bias_diagnosis') {
    const cacheKey = `journal_bias:${deviceId}`;
    const force    = req.query.force === '1';

    let entries = [];
    try {
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      if (ids.length > 0) {
        const keys = ids.map(id => `journal:${deviceId}:${id}`);
        const rawEntries = await redisCmd('MGET', ...keys);
        entries = (Array.isArray(rawEntries) ? rawEntries : [])
          .map(raw => { try { return raw ? JSON.parse(raw) : null; } catch(_) { return null; } })
          .filter(Boolean);
      }
    } catch(e) {
      console.error('journal bias_diagnosis: Redis fetch failed:', e.message);
      return res.status(500).json({ error: 'Gagal membaca data jurnal' });
    }

    const stats = _journalBiasStats(entries);
    if (!stats.sufficient) {
      return res.status(200).json({
        ...stats, narrative: null,
        message: `Butuh minimal ${stats.min_required} trade closed untuk diagnosa perilaku. Saat ini baru ada ${stats.sample_count}.`,
      });
    }

    if (!force) {
      try {
        const cached = await redisCmd('GET', cacheKey);
        if (cached) {
          const obj = JSON.parse(cached);
          // Cache hanya valid kalau sample_count sama — trade baru ditambah/ditutup
          // sejak diagnosa terakhir harus memicu narasi ulang, bukan angka basi.
          if (obj.stats?.sample_count === stats.sample_count) {
            return res.status(200).json({ ...obj, from_cache: true });
          }
        }
      } catch(e) { console.warn('journal bias_diagnosis: Redis GET failed:', e.message); }
    }

    const SESS_ID = { tokyo: 'Tokyo', london: 'London', overlap: 'London+NY Overlap', ny: 'New York', closed: 'Market Closed (low liquidity)' };
    const sessionLines = stats.session_stats.map(s => `  ${SESS_ID[s.session] || s.session}: ${s.n} trade, win-rate ${s.win_rate}%, avg ${s.avg_r >= 0 ? '+' : ''}${s.avg_r}R`).join('\n');
    const playbookLines = stats.playbook_stats.map(p => `  ${p.playbook}: ${p.n} trade, win-rate ${p.win_rate}%, avg ${p.avg_r >= 0 ? '+' : ''}${p.avg_r}R`).join('\n');
    const statsBlock = [
      `Sampel: ${stats.sample_count} trade closed.`,
      `Disposition effect: avg win ${stats.disposition.avg_win_r ?? 'N/A'}R vs avg loss ${stats.disposition.avg_loss_r ?? 'N/A'}R (rasio ${stats.disposition.ratio ?? 'N/A'}).`,
      `Overtrading: rata-rata jarak entry setelah WIN ${stats.overtrading.avg_gap_after_win_h ?? 'N/A'} jam, setelah LOSS ${stats.overtrading.avg_gap_after_loss_h ?? 'N/A'} jam (sinyal revenge trading: ${stats.overtrading.signal === true ? 'YA' : stats.overtrading.signal === false ? 'tidak' : 'data kurang'}).`,
      `Distribusi sesi:\n${sessionLines}`,
      `Win-rate per playbook:\n${playbookLines}`,
      `Streak saat ini: ${stats.streak.current}x ${stats.streak.current_type === 'win' ? 'menang' : 'kalah'} beruntun. Loss streak terpanjang historis: ${stats.streak.longest_loss_streak}x.`,
    ].join('\n');

    let narrative = null;
    try {
      narrative = await aiCall([
        { role: 'system', content: 'Kamu adalah coach psikologi trading yang suportif dan non-menghakimi. Tugasmu menarasikan statistik jurnal trading (SUDAH dihitung, jangan hitung ulang atau ubah angkanya) jadi bahasa yang mudah dipahami trader. Sebut angka-angka konkret yang diberikan, jangan generik. Kalau ada indikasi bias (disposition effect, revenge trading, dst), sampaikan sebagai observasi + saran konkret, BUKAN vonis atau kritik keras — trader yang baca ini sedang berusaha memperbaiki diri, bukan dihakimi. Kalau angkanya justru sehat (tidak ada indikasi bias), katakan itu juga secara jujur — jangan mengarang masalah yang tidak ada. Bahasa Indonesia, maksimal 250 kata, poin-poin ringkas bukan tabel.' },
        { role: 'user', content: `Statistik jurnal trading:\n\n${statsBlock}\n\nNarasikan dalam 3 bagian singkat: (1) Pola yang paling menonjol dari data di atas, (2) apakah ada indikasi disposition effect / revenge trading / sesi yang perlu dihindari — jelaskan dengan angka spesifik dari data, (3) satu saran konkret paling actionable untuk minggu depan.` },
      ], 900);
    } catch(e) {
      console.warn('journal bias_diagnosis: AI narrative failed:', e.message);
      // Stats tetap dikembalikan tanpa narasi — fitur inti (angka) tidak boleh gagal
      // gara-gara AI down, sesuai filosofi "statistik dihitung kode, AI cuma narasi opsional".
    }

    const payload = { stats, narrative, generated_at: new Date().toISOString() };
    redisCmd('SET', cacheKey, JSON.stringify(payload), 'EX', 24 * 3600).catch(() => {});
    return res.status(200).json(payload);
  }

  // ── GET — list entries ────────────────────────────────
  if (req.method === 'GET') {
    const statusFilter = req.query.status || 'all'; // all | open | closed | archived
    try {
      const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
      if (ids.length === 0) return res.status(200).json({ entries: [] });

      // Batch-fetch all entries in a single MGET call instead of N sequential GETs
      const keys = ids.map(id => `journal:${deviceId}:${id}`);
      const rawEntries = await redisCmd('MGET', ...keys);
      const entries = (Array.isArray(rawEntries) ? rawEntries : [])
        .map((raw, i) => {
          if (!raw) return null;
          try { return JSON.parse(raw); } catch(e) {
            console.warn('journal GET parse error for id', ids[i], ':', e.message);
            return null;
          }
        })
        .filter(e => e && (statusFilter === 'all' || e.status === statusFilter));

      return res.status(200).json({ entries });
    } catch(e) {
      console.error('journal GET failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  // ── DELETE — soft delete (set status = archived), or ?hard=1 for permanent removal ──
  if (req.method === 'DELETE') {
    const id = req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    try {
      const entryKey = `journal:${deviceId}:${id}`;
      const raw = await redisCmd('GET', entryKey);
      if (!raw) return res.status(404).json({ error: 'Entry not found' });

      if (req.query.hard === '1') {
        // Permanent removal — for erroneous entries (e.g. bad test data from a
        // broken feature) that shouldn't be kept around even in Arsip. Restricted
        // to already-archived entries: enforced server-side too (not just hiding
        // the button client-side) so an open/closed trade record can't be wiped by
        // one bad request.
        const existing = JSON.parse(raw);
        if (existing.status !== 'archived') {
          return res.status(400).json({ error: 'Arsipkan entri ini dulu sebelum hapus permanen' });
        }
        await redisCmd('DEL', entryKey);
        await redisCmd('ZREM', indexKey, id);
        return res.status(200).json({ ok: true, deleted: true });
      }

      const entry = JSON.parse(raw);
      entry.status = 'archived';
      entry.closed_at = entry.closed_at || new Date().toISOString();
      await redisCmd('SET', entryKey, JSON.stringify(entry));
      return res.status(200).json({ ok: true });
    } catch(e) {
      console.error('journal DELETE failed:', e.message);
      return res.status(500).json({ error: 'Storage error' });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};

// Ekspor helper murni untuk unit test (module.exports = handler function; properti
// tambahan tidak mengganggu Vercel yang cuma memanggilnya sebagai function biasa)
module.exports._aiCall = aiCall;
module.exports._sanitizeChecklistSnapshot = sanitizeChecklistSnapshot;
module.exports._journalBiasStats = _journalBiasStats;
