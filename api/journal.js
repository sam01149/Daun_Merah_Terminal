// api/journal.js
// Trade journal — POST (create), PATCH (close), GET (list), DELETE (soft-delete)
// GET ?action=analyze — AI analysis of closed trades (Groq, cached 1h per device)
// Redis: journal:{device_id}:{id} (full entry), journal_index:{device_id} (sorted set by created_at ms)

const CORS = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' };

const rateLimit = require('./_ratelimit');
const { allowAiCall } = require('./_ai_guard');

// device_id dipakai langsung sebagai bagian key Redis — batasi charset & panjang
const DEVICE_ID_RE   = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY_BYTES = 32 * 1024; // entry punya thesis_text + snapshot CB/COT
const VALID_DIRECTIONS = new Set(['long', 'short', '']);
const VALID_STATUS     = new Set(['open', 'closed', 'archived']);
const VALID_FILL_STATE = new Set(['pending', 'filled', 'cancelled']);

function clampStr(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

const GROQ_URL   = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const ANALYSIS_CACHE_TTL = 60 * 60; // 1 hour

async function aiCall(messages, maxTokens = 1000) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('GROQ_API_KEY not set');
  if (!await allowAiCall('groq')) throw new Error('AI daily budget exceeded');
  const r = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: GROQ_MODEL, messages, max_tokens: maxTokens, temperature: 0.4 }),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(err?.error?.message || `HTTP ${r.status}`);
  }
  const data = await r.json();
  return data?.choices?.[0]?.message?.content?.trim() || '';
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
        { role: 'user', content: `Analisis ${entries.length} trade closed berikut:\n\nStatistik: Win rate ${winRate}% | Total R ${typeof totalR === 'number' ? totalR.toFixed(2) : totalR} | Avg R/trade ${avgR}\n\n${tradeSummaries}\n\nAnalisis:\n1. **Pola Hasil** — identifikasi pola win/loss berdasarkan regime, pair, atau horizon. Apakah ada kondisi spesifik di mana trader ini lebih sering menang atau kalah?\n2. **Keselarasan Framework** — untuk setiap trade, apakah CB bias kedua currency, regime, dan positioning institusional (COT) mendukung arah trade saat entry? Sebutkan trade mana yang masuk meski konteks tidak selaras (termasuk yang ditandai "KONTRA smart money"), dan apakah hasilnya konsisten dengan itu.\n3. **Kualitas Thesis & Driver** — seberapa spesifik dan dapat difalsifikasi thesis yang dicantumkan? Apakah driver yang disebutkan terbukti relevan dengan hasil?\n4. **Realitas Eksekusi (MFE/MAE)** — kalau data excursion tersedia, bedakan trade yang LOSS karena thesis salah (MFE kecil, harga nggak pernah ke arah yang diharapkan) vs trade yang LOSS karena panic-exit/noise (MFE besar/menguntungkan tapi tetap exit rugi — artinya thesis sempat benar tapi eksekusinya yang gagal). Sebutkan trade spesifik mana yang masuk kategori panic-exit kalau ada.\n5. **Kelemahan Utama** — 2-3 kelemahan paling jelas yang terpola dari data, bukan dari teori\n6. **Rekomendasi Konkret** — 3 hal spesifik yang bisa langsung diubah dalam proses entry/eksekusi berikutnya\n\nMaksimal 650 kata.` },
      ], 1400);
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
