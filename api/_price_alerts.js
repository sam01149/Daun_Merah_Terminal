// api/_price_alerts.js — PLAN AJ: logika murni + I/O Redis untuk alert harga
// discretionary tab Teknikal.
//
// Kenapa modul underscore: Vercel Hobby 12/12 function PENUH (ATURAN.md §4.5).
// Endpoint-nya numpang di api/admin.js?action=price_alerts.
//
// Pembagian tanggung jawab:
//   - modul ini  : validasi input, sanitasi, deduplikasi, serialisasi daftar alert
//   - vps/daemon.js : evaluasi harga live + kirim Telegram (file terpisah karena
//     vps/ di-deploy sebagai image terisolasi, pola duplikasi sadar yang sama
//     dengan isFxMarketOpen)
//
// Alert disimpan sebagai SATU key JSON (bukan hash) supaya baca-tulis tetap
// atomik di level lock admin.js dan daemon cukup GET sekali per jendela cache.

const crypto = require('crypto');

const PRICE_ALERTS_KEY = 'price_alerts:active';
const PRICE_ALERTS_LOCK_KEY = 'lock:price_alerts_write';
const DIRECTIONS = ['touch', 'cross_up', 'cross_down'];
const MAX_NOTE_LEN = 120;
const MAX_ALERTS_TOTAL = 40;
const MAX_ALERTS_PER_PAIR = 6;
// Mata uang yang boleh dipakai alert. BTCUSD/US10Y/US02Y sengaja TIDAK masuk:
// alert dijalankan dari stream Deriv `frx*` (FX + XAU spot), instrumen lain bukan
// cakupan feed itu — lebih baik ditolak jelas daripada alert yang tidak pernah bunyi.
const KNOWN_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'NZD', 'CAD', 'CHF'];

function priceDecimals(pair) {
  if (pair === 'XAUUSD') return 2;
  return pair.slice(3) === 'JPY' ? 3 : 5;
}

// 1 pip = unit gerak terkecil yang wajar dibicarakan trader untuk pair itu.
// Dipakai sebagai toleransi "sentuh" dan pembulatan harga target.
function pipSize(pair) {
  if (pair === 'XAUUSD') return 0.1;
  return pair.slice(3) === 'JPY' ? 0.01 : 0.0001;
}

function sanitizePair(value) {
  if (typeof value !== 'string') return null;
  const pair = value.toUpperCase().replace(/[^A-Z]/g, '');
  if (pair === 'XAUUSD') return pair;
  if (pair.length !== 6) return null;
  const base = pair.slice(0, 3), quote = pair.slice(3);
  if (!KNOWN_CURRENCIES.includes(base) || !KNOWN_CURRENCIES.includes(quote)) return null;
  if (base === quote) return null;
  return pair;
}

function sanitizeNote(value) {
  if (value == null) return '';
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ') // buang karakter kontrol (newline dsb)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOTE_LEN);
}

function roundPrice(pair, value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  const factor = Math.pow(10, priceDecimals(pair));
  return Math.round(num * factor) / factor;
}

function newAlertId(now = Date.now(), rand = crypto.randomBytes(4).toString('hex')) {
  return `pa_${now}_${rand}`;
}

// Arah valid hanya 3 nilai; default 'touch' (level yang dipantau, bukan arah tembus).
function normalizeDirection(value) {
  const dir = String(value || '').trim().toLowerCase();
  return DIRECTIONS.includes(dir) ? dir : null;
}

// Dua alert dianggap duplikat kalau pair + arah sama dan level targetnya hanya
// beda < 0.5 pip — mencegah trader memasang 3 alert berimpit di level yang sama
// (spam Telegram saat tersentuh, dan tiap alert dihapus setelah bunyi).
function isDuplicateAlert(alerts, candidate) {
  if (!Array.isArray(alerts)) return false;
  const tol = pipSize(candidate.pair) * 0.5;
  return alerts.some(a =>
    a && a.pair === candidate.pair &&
    (a.direction || 'touch') === candidate.direction &&
    Number.isFinite(Number(a.target_price)) &&
    Math.abs(Number(a.target_price) - candidate.target_price) < tol
  );
}

// Return { ok:true, alert } atau { ok:false, error }.
// `existing` opsional: dipakai untuk dedupe + hitung batas per pair.
function validateAlertInput(body, existing = []) {
  const raw = body || {};
  const pair = sanitizePair(raw.pair);
  if (!pair) return { ok: false, error: 'pair tidak valid — gunakan pair FX 6 huruf atau XAUUSD' };

  const direction = normalizeDirection(raw.direction || 'touch');
  if (!direction) return { ok: false, error: `direction harus salah satu: ${DIRECTIONS.join(', ')}` };

  const target = roundPrice(pair, raw.target_price);
  if (target == null) return { ok: false, error: 'target_price harus angka positif' };

  const initial = raw.initial_price == null ? null : roundPrice(pair, raw.initial_price);
  if (raw.initial_price != null && initial == null) {
    return { ok: false, error: 'initial_price harus angka positif atau null' };
  }

  const alert = {
    pair,
    target_price: target,
    direction,
    note: sanitizeNote(raw.note),
    initial_price: initial,
  };

  const list = Array.isArray(existing) ? existing.filter(Boolean) : [];
  if (isDuplicateAlert(list, alert)) {
    return { ok: false, error: 'alert dengan pair, arah, dan level yang sama sudah ada' };
  }
  if (list.filter(a => a.pair === pair).length >= MAX_ALERTS_PER_PAIR) {
    return { ok: false, error: `maksimal ${MAX_ALERTS_PER_PAIR} alert aktif per pair` };
  }
  if (list.length >= MAX_ALERTS_TOTAL) {
    return { ok: false, error: `maksimal ${MAX_ALERTS_TOTAL} alert aktif — batalkan beberapa dulu` };
  }
  return { ok: true, alert };
}

function parseAlerts(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(a => a && a.pair && Number.isFinite(Number(a.target_price))) : [];
  } catch (e) {
    return [];
  }
}

async function getActiveAlerts(redisCmd) {
  const raw = await redisCmd('GET', PRICE_ALERTS_KEY);
  return parseAlerts(raw);
}

async function saveActiveAlerts(redisCmd, alerts) {
  const list = Array.isArray(alerts) ? alerts : [];
  await redisCmd('SET', PRICE_ALERTS_KEY, JSON.stringify(list));
  return list;
}

// Alert yang sudah bunyi DIHAPUS (bukan ditandai) — keputusan yang sama dengan
// deduplikasi Telegram: trader memasang alert baru kalau ingin memantau level lagi.
async function addActiveAlert(redisCmd, alert, { now = Date.now() } = {}) {
  const list = await getActiveAlerts(redisCmd);
  const validated = validateAlertInput(alert, list);
  if (!validated.ok) return validated;
  const stored = {
    id: newAlertId(now),
    ...validated.alert,
    status: 'active',
    created_at: new Date(now).toISOString(),
  };
  list.push(stored);
  await saveActiveAlerts(redisCmd, list);
  return { ok: true, alert: stored };
}

async function removeActiveAlert(redisCmd, alertId) {
  const id = String(alertId || '').trim();
  if (!id) return { ok: false, error: 'id wajib diisi' };
  const list = await getActiveAlerts(redisCmd);
  const next = list.filter(a => a.id !== id);
  if (next.length === list.length) return { ok: false, error: 'alert tidak ditemukan' };
  await saveActiveAlerts(redisCmd, next);
  return { ok: true, removed: id };
}

module.exports = {
  PRICE_ALERTS_KEY,
  PRICE_ALERTS_LOCK_KEY,
  DIRECTIONS,
  MAX_NOTE_LEN,
  MAX_ALERTS_TOTAL,
  MAX_ALERTS_PER_PAIR,
  priceDecimals,
  pipSize,
  sanitizePair,
  sanitizeNote,
  roundPrice,
  newAlertId,
  normalizeDirection,
  isDuplicateAlert,
  validateAlertInput,
  parseAlerts,
  getActiveAlerts,
  saveActiveAlerts,
  addActiveAlert,
  removeActiveAlert,
};
