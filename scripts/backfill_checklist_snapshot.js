// One-time backfill: reconstruct checklist_snapshot for OLD closed journal entries
// (session 162, "Edge per Kondisi Checklist") from the ✅/⬜ lines already embedded
// in thesis_text by ckPrefillJurnal() in index.html. Idempotent — only touches
// entries whose checklist_snapshot is currently missing, never overwrites any
// other field, and re-checks right before each write to avoid clobbering a
// concurrent update.
//
// Kept in-repo (not run automatically) in case a device restores old trades or
// another legacy dataset needs the same treatment later — rerunning is safe.
//
// Usage:
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backfill_checklist_snapshot.js            (dry run)
//   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backfill_checklist_snapshot.js --write    (writes)
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WRITE = process.argv.includes('--write');
const REPO_INDEX_HTML = path.join(__dirname, '..', 'index.html');

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REDIS_URL || !REDIS_TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set.');
  process.exit(1);
}

async function redisCmd(...args) {
  const r = await fetch(REDIS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return (await r.json()).result;
}

// ── Extract PB_REGIME_CHECK / PLAYBOOKS straight from index.html (single source
// of truth) instead of hand-duplicating the label->id map, which would drift. ──
function matchBlock(html, needle, openChar, closeChar) {
  const start = html.indexOf(needle);
  if (start === -1) throw new Error('not found: ' + needle);
  const openIdx = html.indexOf(openChar, start);
  let depth = 0, endIdx = -1;
  for (let i = openIdx; i < html.length; i++) {
    if (html[i] === openChar) depth++;
    else if (html[i] === closeChar) { depth--; if (depth === 0) { endIdx = i + 1; break; } }
  }
  return html.slice(start, endIdx);
}

function loadPlaybooks() {
  const html = fs.readFileSync(REPO_INDEX_HTML, 'utf8');
  const src1 = matchBlock(html, 'const PB_REGIME_CHECK', '{', '}');
  const src2 = matchBlock(html, 'const PLAYBOOKS = {', '{', '}');
  const src3 = matchBlock(html, 'PLAYBOOKS.smc_ict.sections = [', '[', ']');
  const src = [src1, src2, src3].join(';\n') + ';';
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(src + '\nthis.__PB = PB_REGIME_CHECK; this.__PLAYBOOKS = PLAYBOOKS;', sandbox);
  return { PB_REGIME_CHECK: sandbox.__PB, PLAYBOOKS: sandbox.__PLAYBOOKS };
}

const { PB_REGIME_CHECK, PLAYBOOKS } = loadPlaybooks();

// playbookKey -> { label -> id }, each including the shared PB_REGIME_CHECK items
const labelMapByPlaybook = {};
const nameToKey = {};
for (const [key, pb] of Object.entries(PLAYBOOKS)) {
  const map = {};
  [PB_REGIME_CHECK, ...pb.sections].forEach(sec => {
    sec.items.forEach(it => {
      if (map[it.label] && map[it.label] !== it.id) {
        console.warn(`WARN duplicate label within playbook ${key}: "${it.label}" -> ${map[it.label]} vs ${it.id}`);
      }
      map[it.label] = it.id;
    });
  });
  labelMapByPlaybook[key] = map;
  nameToKey[pb.name] = key;
}

const HEADER_RE = /^\[(.+?) \| (\d+)% — .+?\]/;
const LINE_RE = /^\s*(✅|⬜)\s+(.*?)(\s*\(⚠ override:.*\))?\s*$/;

function parseThesis(thesisText) {
  const lines = (thesisText || '').split(/\r?\n/);
  const header = lines[0] ? lines[0].match(HEADER_RE) : null;
  if (!header) return null;
  const pbName = header[1];
  const pct = parseInt(header[2], 10);
  const playbookKey = nameToKey[pbName];
  if (!playbookKey) return { unmatched: true, pbName };

  const labelMap = labelMapByPlaybook[playbookKey];
  const snapshot = {};
  let matched = 0, unmatchedLines = 0;
  for (const line of lines) {
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, tick, label] = m;
    const id = labelMap[label.trim()];
    if (id) { snapshot[id] = tick === '✅'; matched++; }
    else unmatchedLines++;
  }
  return { playbookKey, pct, snapshot, matched, unmatchedLines };
}

async function main() {
  const devices = await redisCmd('SMEMBERS', 'journal_devices') || [];
  console.log(`journal_devices: ${devices.length}`);
  console.log(`mode: ${WRITE ? 'WRITE (will mutate Redis)' : 'DRY RUN (no writes)'}\n`);

  let scanned = 0, alreadyHas = 0, backfilled = 0, skippedNoMarkers = 0, skippedUnmatchedPlaybook = 0, skippedNoKeysMatched = 0;

  for (const deviceId of devices) {
    const indexKey = `journal_index:${deviceId}`;
    const ids = await redisCmd('ZRANGE', indexKey, 0, -1, 'REV') || [];
    if (ids.length === 0) continue;
    const keys = ids.map(id => `journal:${deviceId}:${id}`);
    const raws = await redisCmd('MGET', ...keys) || [];

    for (let idx = 0; idx < ids.length; idx++) {
      const raw = raws[idx];
      if (!raw) continue;
      let entry;
      try { entry = JSON.parse(raw); } catch (_) { continue; }
      if (entry.status !== 'closed') continue;
      scanned++;
      if (entry.checklist_snapshot) { alreadyHas++; continue; }

      const parsed = parseThesis(entry.thesis_text);
      if (!parsed) { skippedNoMarkers++; continue; }
      if (parsed.unmatched) {
        skippedUnmatchedPlaybook++;
        console.log(`  SKIP ${deviceId}/${entry.id} (${entry.pair}) — playbook name "${parsed.pbName}" tidak cocok dengan PLAYBOOKS manapun`);
        continue;
      }
      if (Object.keys(parsed.snapshot).length === 0) { skippedNoKeysMatched++; continue; }

      console.log(`  ${WRITE ? 'WRITE' : 'PLAN'} ${deviceId}/${entry.id} (${entry.pair}, r_actual=${entry.r_actual}) — playbook=${parsed.playbookKey} pct=${parsed.pct} matched=${parsed.matched} unmatched_lines=${parsed.unmatchedLines} keys=${Object.keys(parsed.snapshot).length}`);
      backfilled++;

      if (WRITE) {
        const key = `journal:${deviceId}:${entry.id}`;
        const freshRaw = await redisCmd('GET', key);
        if (!freshRaw) continue;
        const fresh = JSON.parse(freshRaw);
        if (fresh.checklist_snapshot) continue; // updated concurrently since scan — don't clobber
        fresh.checklist_snapshot = parsed.snapshot;
        fresh.checklist_playbook = parsed.playbookKey;
        fresh.checklist_pct = Math.max(0, Math.min(100, parsed.pct));
        await redisCmd('SET', key, JSON.stringify(fresh));
      }
    }
  }

  console.log('\n--- SUMMARY ---');
  console.log('closed entries scanned:', scanned);
  console.log('already had checklist_snapshot:', alreadyHas);
  console.log(`${WRITE ? 'backfilled' : 'would backfill'}:`, backfilled);
  console.log('skipped (no ✅/⬜ header/markers — manual entry):', skippedNoMarkers);
  console.log('skipped (playbook name in thesis unrecognized):', skippedUnmatchedPlaybook);
  console.log('skipped (header ok but 0 labels matched):', skippedNoKeysMatched);
}

main().catch(e => { console.error('ERROR', e); process.exit(1); });
