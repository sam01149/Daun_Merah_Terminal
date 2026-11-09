'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const followUp = require('../../api/_analysis_follow_up');
const marketHours = require('../../api/_market_hours');
const admin = require('../../api/admin');

test('Follow Up covers the 28 canonical FX crosses and XAU/USD with three separate daily slots', () => {
  assert.equal(followUp.PAIR_LABELS.size, 29);
  assert.equal(followUp.PAIR_LABELS.get('NZDCAD=X'), 'NZD/CAD');
  assert.equal(followUp.PAIR_LABELS.get('GC=F'), 'XAU/USD');
  const slot = time => followUp.currentSlot(new Date(`2026-11-09T${time}Z`));
  assert.equal(slot('00:01:59'), null);
  assert.equal(slot('00:02:00'), slot('00:31:59'));
  assert.equal(slot('00:32:00'), null);
  assert.equal(new Set(['00:02:00', '07:02:00', '12:32:00'].map(slot)).size, 3);
});

test('Follow Up protects toggle and cron routes and never generates a disabled or closed-market pair', async t => {
  process.env.APP_KEY = 'fixture-app';
  process.env.CRON_SECRET = 'fixture-cron';
  process.env.UPSTASH_REDIS_REST_URL = 'https://fixture-follow-up.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fixture-redis';
  t.mock.method(global, 'fetch', async () => { throw new Error('Unexpected network request'); });
  const market = t.mock.method(marketHours, 'isFxMarketOpen', () => true);
  t.mock.method(followUp, 'currentSlot', () => 'fixture-slot');

  let state = null;
  const claimed = [];
  t.mock.method(followUp, 'createStore', () => ({
    read: async () => state,
    list: async () => state ? ['NZDCAD=X'] : [],
    setEnabled: async (_, enabled) => {
      state = enabled ? { activation: 'fixture-activation', status: 'queued' } : null;
      return state;
    },
    claim: async (symbol, _, slot, activation) => {
      claimed.push({ symbol, slot, activation });
      return null;
    },
  }));
  const app = { 'x-app-key': 'fixture-app' };
  const cron = { 'x-cron-secret': 'fixture-cron' };
  async function request({ headers = app, mode, body, method = body ? 'POST' : 'GET', symbol = 'NZDCAD=X' } = {}) {
    const response = {
      setHeader() {},
      status(code) { this.code = code; return this; },
      json(payload) { this.payload = payload; return this; },
    };
    await admin({ method, body, headers, query: { action: 'analysis_follow_up', mode, symbol } }, response);
    return response;
  }

  assert.equal((await request({ headers: {}, body: { enabled: true } })).code, 401);
  assert.equal((await request({ mode: 'list' })).code, 403);
  assert.equal((await request({ headers: cron, body: { enabled: true } })).code, 403);
  assert.equal((await request({ symbol: 'INVALID=X', body: { enabled: true } })).code, 400);
  assert.equal((await request()).payload.enabled, false);
  const enabled = await request({ body: { enabled: true } });
  assert.equal(enabled.payload.status, 'queued');
  assert.deepEqual((await request({ headers: cron, mode: 'list' })).payload.symbols, ['NZDCAD=X']);

  market.mock.mockImplementation(() => false);
  assert.equal((await request({ mode: 'initial', body: { activation: enabled.payload.activation } })).payload.market_closed, true);
  assert.deepEqual((await request({ headers: cron, mode: 'list' })).payload.symbols, []);
  assert.equal(claimed.length, 0);

  market.mock.mockImplementation(() => true);
  assert.equal((await request({ body: { enabled: false } })).payload.enabled, false);
  assert.deepEqual((await request({ headers: cron, mode: 'list' })).payload.symbols, []);
  assert.equal((await request({ headers: cron, mode: 'scheduled', method: 'POST' })).payload.enabled, false);
  assert.deepEqual(claimed, [{ symbol: 'NZDCAD=X', slot: 'fixture-slot', activation: '' }]);
});
