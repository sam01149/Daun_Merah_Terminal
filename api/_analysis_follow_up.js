'use strict';

const { randomUUID } = require('node:crypto');

const KEY = '{analysis_follow_up}:state:v1';
const ACTIVE_KEY = '{analysis_follow_up}:active:v1';
const CURRENCIES = ['EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];
const PAIR_LABELS = new Map([['GC=F', 'XAU/USD']]);
for (const [i, base] of CURRENCIES.entries()) {
  for (const quote of CURRENCIES.slice(i + 1)) {
    PAIR_LABELS.set(`${base}${quote}=X`, `${base}/${quote}`);
  }
}

function currentSlot(now = new Date()) {
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  const slot = [2, 7 * 60 + 2, 12 * 60 + 32].find(start => minute >= start && minute < start + 30);
  return slot === undefined ? null : `${now.toISOString().slice(0, 10)}:${slot}`;
}

// Keep activation, slot claims and result publication atomic across invocations.
const TRANSITION = `
local raw = redis.call('HGET', KEYS[1], ARGV[1])
local state = raw and cjson.decode(raw)
local action, token, slot = ARGV[2], ARGV[3], ARGV[4]
local now = tonumber(ARGV[5])
if action == 'enable' then
  if state and state.activation then return raw end
  state = { activation = token, status = 'queued', result = state and state.result or nil }
  redis.call('SADD', KEYS[2], ARGV[1])
elseif action == 'disable' then
  redis.call('SREM', KEYS[2], ARGV[1])
  if not state or not state.result then
    redis.call('HDEL', KEYS[1], ARGV[1])
    return 'false'
  end
  state = { result = state.result }
elseif action == 'claim' then
  if not state or not state.activation or (state.lease and state.lease > now) then return 'false' end
  if slot == '' then
    if state.activation ~= ARGV[6] or state.status ~= 'queued' then return 'false' end
  else
    if state.slot == slot then return 'false' end
    state.slot = slot
  end
  state.run = token
  state.lease = now + 75000
  state.status = 'running'
  state.message = nil
elseif action == 'finish' then
  if not state or state.run ~= token then return 'false' end
  local outcome = cjson.decode(ARGV[6])
  state.run = nil
  state.lease = nil
  state.status = outcome.status
  state.message = outcome.message
  if outcome.result then state.result = outcome.result end
end
local encoded = cjson.encode(state)
redis.call('HSET', KEYS[1], ARGV[1], encoded)
return encoded`;

function createStore(redis) {
  async function read(symbol) {
    const raw = await redis('HGET', KEY, symbol);
    if (raw === undefined) throw new Error('Follow Up storage unavailable');
    return raw ? JSON.parse(raw) : null;
  }

  async function transition(symbol, action, token = '', slot = '', payload = '') {
    const raw = await redis('EVAL', TRANSITION, '2', KEY, ACTIVE_KEY, symbol, action, token, slot, String(Date.now()), payload);
    if (typeof raw !== 'string') throw new Error('Follow Up storage unavailable');
    return JSON.parse(raw) || null;
  }

  return {
    read,
    async list() {
      const symbols = await redis('SMEMBERS', ACTIVE_KEY);
      if (!Array.isArray(symbols)) throw new Error('Follow Up storage unavailable');
      return symbols.filter(symbol => PAIR_LABELS.has(symbol));
    },
    setEnabled: (symbol, enabled) => transition(symbol, enabled ? 'enable' : 'disable', randomUUID()),
    claim: (symbol, run, slot, activation) => transition(symbol, 'claim', run, slot, activation),
    finish: (symbol, run, outcome) => transition(symbol, 'finish', run, '', JSON.stringify(outcome)),
  };
}

function publicState(state, marketClosed) {
  const result = state?.result ? JSON.parse(state.result) : null;
  if (!state?.activation) return { enabled: false, result, market_closed: marketClosed };
  const expired = state.status === 'running' && state.lease <= Date.now();
  return {
    enabled: true,
    activation: state.activation,
    status: expired ? 'error' : state.status,
    message: expired ? 'Analisa terakhir tidak selesai. Follow Up akan mencoba lagi pada jadwal berikutnya.' : state.message,
    result,
    market_closed: marketClosed,
  };
}

module.exports = { PAIR_LABELS, currentSlot, createStore, publicState };
