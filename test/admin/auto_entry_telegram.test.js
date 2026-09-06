// test/admin/auto_entry_telegram.test.js — 2026-09-06 (rapat user)
// Unit test fungsi pure notifikasi Telegram siklus sinyal auto-entry
// (_autoEntryDirectionLabel/_resolveFundamentalPct/_autoEntryStatusLabel/
// _formatAutoEntrySignalMessage di api/admin.js). Network (_sendTelegramRaw)
// SENGAJA tidak dites di sini — pola sama position_notify.test.js (vps/daemon.js):
// pure functions saja, network dites live/manual.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  _autoEntryDirectionLabel, _resolveFundamentalPct, _autoEntryStatusLabel,
  _formatAutoEntrySignalMessage,
} = require('../../api/admin.js');

// ── _autoEntryDirectionLabel ─────────────────────────────────────────────────

test('_autoEntryDirectionLabel: bullish -> BUY, bearish -> SELL, lainnya -> em dash', () => {
  assert.equal(_autoEntryDirectionLabel('bullish'), 'BUY');
  assert.equal(_autoEntryDirectionLabel('bearish'), 'SELL');
  assert.equal(_autoEntryDirectionLabel('neutral'), '—');
  assert.equal(_autoEntryDirectionLabel(null), '—');
});

// ── _resolveFundamentalPct ───────────────────────────────────────────────────

test('_resolveFundamentalPct: bullish -> ambil case_bullish_pct (sisi yang menang)', () => {
  assert.equal(_resolveFundamentalPct({ case_bullish_pct: 68, case_bearish_pct: 32 }, 'bullish'), 68);
});

test('_resolveFundamentalPct: bearish -> ambil case_bearish_pct', () => {
  assert.equal(_resolveFundamentalPct({ case_bullish_pct: 32, case_bearish_pct: 68 }, 'bearish'), 68);
});

test('_resolveFundamentalPct: fundamental_bias null -> null', () => {
  assert.equal(_resolveFundamentalPct(null, 'bullish'), null);
});

test('_resolveFundamentalPct: field hilang/bukan angka -> null (bukan NaN)', () => {
  assert.equal(_resolveFundamentalPct({}, 'bullish'), null);
  assert.equal(_resolveFundamentalPct({ case_bullish_pct: 'x' }, 'bullish'), null);
});

// ── _autoEntryStatusLabel ────────────────────────────────────────────────────

test('_autoEntryStatusLabel: canceled -> cancel (wording user), lainnya apa adanya', () => {
  assert.equal(_autoEntryStatusLabel('canceled'), 'cancel');
  assert.equal(_autoEntryStatusLabel('pending'), 'pending');
  assert.equal(_autoEntryStatusLabel('open'), 'open');
  assert.equal(_autoEntryStatusLabel('expired'), 'expired');
  assert.equal(_autoEntryStatusLabel('tp'), 'tp');
  assert.equal(_autoEntryStatusLabel('sl'), 'sl');
  assert.equal(_autoEntryStatusLabel('ambiguous'), 'ambiguous');
});

// ── _formatAutoEntrySignalMessage ────────────────────────────────────────────

test('_formatAutoEntrySignalMessage: sinyal baru (pending), format persis sesuai keputusan rapat', () => {
  const text = _formatAutoEntrySignalMessage({
    pair: 'EUR/USD', bias: 'bullish', price: '1.0850-1.0860', tp: '1.0950', sl: '1.0800',
    fundamentalPct: 68, teknikalPct: 75, status: 'pending', refined: false,
  });
  assert.equal(text, [
    'signal entry',
    'EUR/USD BUY',
    'Price: 1.0850-1.0860',
    'Take Profit : 1.0950',
    'Stop Loss: 1.0800',
    'Fundamental: 68%',
    'Teknikal: 75%',
    'status: pending',
  ].join('\n'));
});

test('_formatAutoEntrySignalMessage: refined -> tag "(refined)" nempel di baris Price', () => {
  const text = _formatAutoEntrySignalMessage({
    pair: 'XAU/USD', bias: 'bearish', price: '2650.00', tp: '2600.00', sl: '2680.00',
    fundamentalPct: 55, teknikalPct: 60, status: 'pending', refined: true,
  });
  assert.match(text, /^Price: 2650\.00 \(refined\)$/m);
  assert.match(text, /^XAU\/USD SELL$/m);
});

test('_formatAutoEntrySignalMessage: status cancel (bias_flip) & expired dikonversi lewat _autoEntryStatusLabel', () => {
  const cancelText = _formatAutoEntrySignalMessage({
    pair: 'GBP/USD', bias: 'bullish', price: '1.2500', tp: '1.2600', sl: '1.2450',
    fundamentalPct: 60, teknikalPct: 70, status: _autoEntryStatusLabel('canceled'),
  });
  assert.match(cancelText, /^status: cancel$/m);

  const expiredText = _formatAutoEntrySignalMessage({
    pair: 'AUD/NZD', bias: 'bearish', price: '1.0800', tp: '1.0700', sl: '1.0850',
    fundamentalPct: null, teknikalPct: null, status: 'expired',
  });
  assert.match(expiredText, /^status: expired$/m);
  assert.match(expiredText, /^Fundamental: —$/m);
  assert.match(expiredText, /^Teknikal: —$/m);
});

test('_formatAutoEntrySignalMessage: closed tp/sl/ambiguous pakai status apa adanya', () => {
  for (const status of ['tp', 'sl', 'ambiguous']) {
    const text = _formatAutoEntrySignalMessage({
      pair: 'USD/JPY', bias: 'bullish', price: '150.00', tp: '152.00', sl: '149.00',
      fundamentalPct: 70, teknikalPct: 80, status,
    });
    assert.match(text, new RegExp(`^status: ${status}$`, 'm'));
  }
});
