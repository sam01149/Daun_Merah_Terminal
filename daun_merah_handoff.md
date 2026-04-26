# DAUN MERAH — HANDOFF DOKUMEN
> **Diupdate:** 2026-04-26  
> **Branch:** main — semua task sudah di-push  
> **Working directory:** `c:\Users\sam\Downloads\Financial_Feed_App`  
> **Deployment:** Vercel + Upstash Redis  
> **Context file terlengkap:** `daun_merah.md` (baca ini dulu sebelum mulai)

---

## STATUS SESSION INI (2026-04-26)

### ✅ Semua sudah di-commit dan di-push

| Commit | File | Task |
|--------|------|------|
| `bd16d06` | `api/rss.js`, `index.html`, `api/real-yields.js` | Task 10c, 10d, Task 2 backend |
| `80030ce` | `index.html` | Task 2 frontend |
| `9e5f7fa` | `index.html`, `api/sizing-history.js` | Task 4 |

---

## APA YANG SUDAH SELESAI

### ✅ Task 10c — RSS Cache to Redis
### ✅ Task 10d — Calendar Refetch 60 menit + "last updated" indicator
### ✅ Task 2 — Real Yield Differential
- Backend: `api/real-yields.js` — USD dari FRED DGS10-T10YIE, 7 currency lain hardcoded inflation expectations, Redis TTL 6 jam
- Frontend: Real yield muncul di setiap CB card (tab CAL) — color coded, tooltip, stale indicator dot kuning

### ✅ Task 4 — Position Sizing Calculator
- Backend: `api/sizing-history.js` — POST/GET per device-id, Redis sorted set, max 10 entries
- Frontend: Tab SIZING baru — input equity/risk/pair/stop/entry, hard block >2%, R-multiple table, history dari Redis
- Pip value logic: XXX/USD=fixed $10, USD/YYY=calculated dari entry price, cross pairs=approximated

---

## TASK BERIKUTNYA: Task 7 — Regime Gate Checklist

**Prerequisite sudah terpenuhi:** Task 1 ✓ Task 2 ✓

### Yang perlu dikerjakan di `index.html`:

**Step 1 — Tambah section baru di `CK_SECTIONS` sebagai elemen pertama:**

Cari `const CK_SECTIONS = [` (sekitar line 1964), tambahkan SEBELUM elemen pertama yang ada:

```js
{
  id:'regime_check', num:'00', title:'REGIME CHECK', badge:'PRE-GATE',
  desc:'Verifikasi alignment makro sebelum masuk ke checklist teknikal.',
  items:[
    { id:'rc1', text:'Regime saat ini sudah ditentukan (Risk-On / Neutral / Risk-Off)', auto: true },
    { id:'rc2', text:'CB bias kedua currency dalam pair sudah dikonfirmasi', auto: true },
    { id:'rc3', text:'COT positioning aligned dengan directional bias', auto: true },
    { id:'rc4', text:'Tidak ada high-impact event <6 jam ke depan untuk pair ini', auto: true },
    { id:'rc5', text:'Real yield differential mendukung directional bias (konfirmasi manual)', auto: false },
  ]
},
```

**Step 2 — Tambah pair selector di awal CHECKLIST panel:**

Cari `<div class="feed-scroll" id="checklistPanel"`, tambahkan setelah div wrapper awal:

```html
<div style="padding:8px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
  <select id="ckPairSelector" onchange="ckOnPairChange()" style="background:var(--surface);color:var(--text);border:1px solid var(--border);padding:4px 8px;font-family:'DM Mono',monospace;font-size:11px">
    <option value="">— Pilih pair untuk auto-tick —</option>
    <!-- 28 pairs, inject via JS in initChecklist() -->
  </select>
  <span id="ckPairHint" style="font-size:9px;color:var(--muted);margin-left:8px"></span>
</div>
```

**Step 3 — Fungsi `ckAutoTickRegimeCheck(pair)` baru:**

```js
function ckAutoTickRegimeCheck(pair) {
  if (!pair) return;
  const [base, quote] = pair.split('/');

  // rc1: regime data fresh (<30 min)
  if (regimeData && (Date.now() - regimeFetchedAt) < 30 * 60 * 1000) {
    ckAutoTick('rc1', `Regime: ${regimeData.regime}`);
  }

  // rc2: CB bias known for both currencies
  if (cbData) {
    const b = cbData.find(c => c.currency === base);
    const q = cbData.find(c => c.currency === quote);
    if (b && b.bias && q && q.bias) {
      ckAutoTick('rc2', `${base}: ${b.bias} | ${quote}: ${q.bias}`);
    }
  }

  // rc3: COT alignment check
  if (cotData && cotData.positions) {
    const qPos = cotData.positions[quote];
    if (qPos) {
      const net = qPos.lev_net || qPos.net || 0;
      // Long pair = want quote currency to be net short (negative net)
      ckAutoTick('rc3', `${quote} Lev Net: ${net > 0 ? '+' : ''}${net}`);
    }
  }

  // rc4: no high-impact event <6 hours for base or quote
  if (calData) {
    const now = Date.now();
    const sixH = 6 * 60 * 60 * 1000;
    const dangerous = calData.filter(ev => {
      if (ev.impact !== 'high') return false;
      const t = new Date(ev.datetime).getTime();
      return t > now && t < now + sixH && (ev.currency === base || ev.currency === quote);
    });
    if (dangerous.length === 0) {
      ckAutoTick('rc4', 'Tidak ada event high-impact <6 jam');
    } else {
      ckAutoBlock('rc4', `${dangerous.length} event high-impact <6 jam: ${dangerous.map(e=>e.title).join(', ')}`);
    }
  }

  // rc5: real yield hint (manual)
  if (realYieldsData) {
    const ryB = realYieldsData[base];
    const ryQ = realYieldsData[quote];
    if (ryB && ryQ && ryB.real != null && ryQ.real != null) {
      const diff = (ryB.real - ryQ.real).toFixed(2);
      const sign = diff >= 0 ? '+' : '';
      document.getElementById('ckPairHint').textContent =
        `Real yield ${base} ${ryB.real >= 0 ? '+' : ''}${ryB.real.toFixed(2)}% vs ${quote} ${ryQ.real >= 0 ? '+' : ''}${ryQ.real.toFixed(2)}% → spread ${sign}${diff}%`;
    }
  }
}
```

**Step 4 — Helper `ckAutoTick(id, hint)` dan `ckAutoBlock(id, hint)`:**

```js
function ckAutoTick(id, hint) {
  const el = document.querySelector(`[data-ck-id="${id}"]`);
  if (!el) return;
  el.checked = true;
  el.dataset.auto = '1';
  const label = el.closest('.ck-item-row');
  if (label) {
    let badge = label.querySelector('.auto-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'auto-badge';
      badge.style.cssText = 'font-size:8px;color:var(--green);margin-left:6px;opacity:.7';
      badge.textContent = '✓ auto';
      label.appendChild(badge);
    }
    badge.title = hint;
  }
  ckSave(); ckRender();
}

function ckAutoBlock(id, hint) {
  const el = document.querySelector(`[data-ck-id="${id}"]`);
  if (!el) return;
  el.checked = false;
  el.dataset.auto = '0';
  const label = el.closest('.ck-item-row');
  if (label) {
    let badge = label.querySelector('.auto-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'auto-badge';
      badge.style.cssText = 'font-size:8px;color:var(--red);margin-left:6px;opacity:.7';
      label.appendChild(badge);
    }
    badge.style.color = 'var(--red)';
    badge.textContent = '⚠ blocked';
    badge.title = hint;
  }
  ckSave(); ckRender();
}

function ckOnPairChange() {
  const pair = document.getElementById('ckPairSelector').value;
  ckAutoTickRegimeCheck(pair);
}
```

**Step 5 — Inject pair options di `initChecklist()`:**

Setelah `ckInitialized = true;` tambahkan:
```js
const ckSel = document.getElementById('ckPairSelector');
if (ckSel && ckSel.options.length === 1) {
  SZ_PAIRS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p; opt.textContent = p;
    ckSel.appendChild(opt);
  });
}
```

> **Catatan:** `SZ_PAIRS` sudah didefinisikan di Task 4 code, bisa langsung reuse.

**Step 6 — Panggil `ckAutoTickRegimeCheck` setelah fetch berhasil:**

Di `fetchCBStatus()` setelah `renderCBTracker()`:
```js
const selPair = document.getElementById('ckPairSelector');
if (selPair && selPair.value) ckAutoTickRegimeCheck(selPair.value);
```

Sama untuk `fetchRegime()`, `fetchCOT()`, `fetchCalendar()`, dan `fetchRealYields()`.

---

## URUTAN TASK YANG TERSISA

```
NEXT → Task 7 — Regime Gate Checklist (langkah di atas)
     → Task 5 — Trade Journal (needs Task 4 ✓)
     → Task 6 — Structured Trade Thesis (needs Task 5 ✓)
     → Task 8a — Playbook Foundation refactor (needs Task 7 ✓)
     → Task 3 — Rate Path Expectations (uncertain source, defer)
     → Task 9 — Cross-Asset Correlations
     → Task 8b/c/d — Additional Playbooks
     → Task 10a — Branding consistency
     → Task 10b — CFTC parser robustness
     → Task 10e — Prompt externalization
     → Task 10f — Health monitoring
     → Task 10g — Redis key registry
     → Task 10h — Rate limiting
```

Detail lengkap setiap task ada di `daun_merah_progress.md`.

---

## CONSTRAINT ABSOLUT (RINGKASAN)

1. No new npm dependencies
2. Frontend tetap single `index.html` — no bundler, no framework
3. Backward compatible — jangan break endpoints/Redis keys yang ada
4. Setiap external API call harus ada Redis cache dengan explicit TTL
5. Cold-start safe — pakai Redis, bukan module-level cache
6. No silent failures — log context di setiap failure
7. Honest data — tampilkan "unavailable" bukan angka palsu
8. Mobile-first — test 380px viewport
9. Indonesian UI text, English code/comments/variables

---

## ENVIRONMENT

```
Stack:  Vanilla JS + HTML, Vercel Serverless Functions (Node.js CommonJS), Upstash Redis REST
AI:     Groq llama-3.3-70b-versatile
CSS:    --accent: #c0392b (merah), Font: Syne + DM Mono
Redis:  Upstash REST — pola: redisCmd('GET'/'SET'/'ZADD'/...) async function di setiap api/*.js
FRED:   env var FRED_API_KEY (sudah di-set di Vercel)
```

## REDIS KEYS (LENGKAP)

| Key | Isi | TTL |
|-----|-----|-----|
| `cb_bias` | `{USD:{bias,confidence,updated_at},...}` | no TTL |
| `digest_history` | Array max 7 entri | no TTL |
| `cot_cache_v2` | Full COT payload | no TTL (6h manual check) |
| `risk_regime` | Regime payload | 1800s |
| `rss_cache` | `{xml, fetchedAt}` | 60s |
| `real_yields` | `{currencies:{...}, computed_at}` | 21600s |
| `push_subs` | HSET subscriptions | no TTL |
| `seen_guids` | Set GUID berita | 24h |
| `latest_thesis` | Structured thesis JSON | 43200s (Task 6) |
| `sizing_history:{device_id}` | Sorted set calculations | no TTL |
| `journal:{device_id}:{id}` | Full journal entry | no TTL (Task 5) |
| `journal_index:{device_id}` | Sorted set entry IDs | no TTL (Task 5) |
| `correlations` | Correlation matrix | 86400s (Task 9) |
| `rate_path` | Rate path probabilities | 14400s (Task 3) |
| `prompt_digest` | Groq prompt string | no TTL (Task 10e) |
| `prompt_bias` | Groq prompt string | no TTL (Task 10e) |
| `prompt_thesis` | Groq prompt string | no TTL (Task 10e) |
