const CACHE_NAME = 'fjfeed-v1';
const FETCH_URL = '/api/feeds?type=rss';
const STATE_CACHE = 'daun-merah-state';
const SEEN_GUIDS_URL = '/sw-seen-guids';

let seenGuids = new Set();

self.addEventListener('install', e => { self.skipWaiting(); });

self.addEventListener('activate', e => {
  e.waitUntil(clients.claim().then(() => loadSeenGuids()));
});

// Persist seenGuids ke Cache Storage agar tidak hilang saat SW di-restart
async function loadSeenGuids() {
  try {
    const cache = await caches.open(STATE_CACHE);
    const res = await cache.match(SEEN_GUIDS_URL);
    if (res) {
      const arr = await res.json();
      if (Array.isArray(arr)) seenGuids = new Set(arr);
    }
  } catch(e) {}
}

async function saveSeenGuids() {
  try {
    const cache = await caches.open(STATE_CACHE);
    // Simpan max 200 GUID terbaru
    const arr = [...seenGuids].slice(-200);
    await cache.put(SEEN_GUIDS_URL, new Response(JSON.stringify(arr), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch(e) {}
}

self.addEventListener('periodicsync', e => {
  if (e.tag === 'fjfeed-sync') e.waitUntil(checkForNewItems());
});

self.addEventListener('message', e => {
  if (e.data.type === 'INIT_GUIDS') {
    seenGuids = new Set(e.data.guids);
    saveSeenGuids();
  }
  if (e.data.type === 'CHECK_NOW') {
    // Terima guids terkini dari halaman agar tidak ada race condition
    if (Array.isArray(e.data.guids)) seenGuids = new Set(e.data.guids);
    checkForNewItems();
  }
  if (e.data.type === 'ADD_GUID') {
    seenGuids.add(e.data.guid);
    saveSeenGuids();
  }
  if (e.data.type === 'SHOW_DIGEST_NOTIF') {
    self.registration.showNotification(e.data.title, {
      body: e.data.body,
      tag: 'digest-' + e.data.session,
      icon: './icon.svg',
      badge: './icon.svg',
      vibrate: [200, 100, 200],
      data: { url: '/' },
    });
  }
});

async function fetchRSS() {
  try {
    const c = new AbortController();
    setTimeout(() => c.abort(), 12000);
    const r = await fetch(FETCH_URL, { signal: c.signal });
    if (r.ok) {
      const t = await r.text();
      if (t.includes('<rss')) return t;
    }
  } catch(e) {}
  return null;
}

function parseItems(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const title = (/<title><!\[CDATA\[(.*?)\]\]><\/title>/.exec(block) || /<title>(.*?)<\/title>/.exec(block))?.[1] || '';
    const guid = (/<guid[^>]*>(.*?)<\/guid>/.exec(block))?.[1] || '';
    const pubDate = (/<pubDate>(.*?)<\/pubDate>/.exec(block))?.[1] || '';
    const link = (/<link>(.*?)<\/link>/.exec(block))?.[1] || '';
    const desc = (/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/.exec(block) || /<description>([\s\S]*?)<\/description>/.exec(block))?.[1] || '';
    const clean = title.replace(/^FinancialJuice:\s*/i, '').trim();
    if (guid) items.push({ title: clean, guid, pubDate, link, desc });
  }
  return items;
}

function detectCat(title) {
  const t = title.toLowerCase();
  const CATS = {
    'market-moving': ['market moving', 'breaking', 'flash', 'urgent', 'alert'],
    'forex':    ['eur/', '/usd', 'gbp/', '/jpy', 'aud/', 'cad/', 'nzd/', '/chf', 'fx options', 'options expir', 'usd/cad', 'eur/usd', 'gbp/usd', 'dollar index', 'dxy'],
    'equities': ['s&p', 'nasdaq', 'dow', 'ftse', 'dax', 'nikkei', 'hang seng', 'stock', 'equity', 'shares', 'earnings', 'ipo', 'nyse', 'spx', 'nvda', 'apple', 'tesla', 'meta ', 'alphabet', 'microsoft'],
    'commodities': ['gold', 'silver', 'copper', 'wheat', 'corn', 'soybean', 'coffee', 'cocoa', 'cotton', 'lumber', 'palladium', 'platinum', 'xau', 'xag', 'commodity'],
    'energy':   ['oil', 'crude', 'brent', 'wti', 'opec', 'energy', 'gasoline', 'diesel', 'natural gas', 'barrel', 'petroleum', 'hormuz', 'strait', 'iea', 'blockade', 'tanker', 'refiner', 'pipeline', 'lng'],
    'bonds':    ['bond', 'yield', 'treasury', 'gilt', 'bund', 'note', '2-year', '10-year', '30-year', 'basis point', 'bps', 'fixed income', 'debt', 'sovereign'],
    'crypto':   ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'blockchain', 'coinbase', 'binance', 'stablecoin', 'defi', 'nft', 'altcoin'],
    'indexes':  ['index', 'indices', 'pmi', 'purchasing manager', 'composite', 'manufacturing index', 'services index'],
    'macro':    ['fed', 'fomc', 'powell', 'goolsbee', 'waller', 'kashkari', 'warsh', 'federal reserve', 'rate cut', 'rate hike', 'interest rate', 'ecb', 'boe', 'rba', 'boj', 'pboc', 'central bank', 'monetary policy', 'inflation', 'gdp', 'recession', 'imf', 'world bank', 'g7', 'g20', 'lagarde', 'bailey', 'ueda'],
    'econ-data': ['actual', 'forecast', 'previous', 'cpi', 'nfp', 'unemployment', 'retail sales', 'trade balance', 'consumer confidence', 'business confidence', 'industrial production', 'housing', 'jobs', 'payroll', 'nab business', 'westpac', 'sentiment'],
    'geopolitical': ['iran', 'iranian', 'tehran', 'nuclear', 'ceasefire', 'hezbollah', 'israel', 'lebanon', 'russia', 'ukraine', 'china', 'chinese', 'xi jinping', 'pboc', 'yuan', 'beijing', 'taiwan', 'north korea', 'sanctions', 'tariff', 'trade war', 'trump', 'white house', 'nato', 'war', 'military'],
  };
  for (const [cat, kws] of Object.entries(CATS)) {
    if (kws.some(k => t.includes(k))) return cat;
  }
  return 'macro';
}

async function checkForNewItems() {
  const xml = await fetchRSS();
  if (!xml) return;

  const items = parseItems(xml);
  const newItems = items.filter(i => !seenGuids.has(i.guid));

  if (newItems.length === 0) return;

  newItems.forEach(i => seenGuids.add(i.guid));
  await saveSeenGuids();

  // Kirim ke semua tab yang terbuka
  const allClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
  allClients.forEach(c => c.postMessage({ type: 'NEW_ITEMS', items: newItems }));

  // Jika app sedang terbuka dan visible, skip browser notification
  // — halaman sudah menerima update via postMessage di atas
  const hasVisible = allClients.some(c => c.visibilityState === 'visible');
  if (hasVisible) return;

  // App ditutup atau di background — tampilkan notifikasi
  const toNotify = newItems.slice(0, 3);
  for (const item of toNotify) {
    const cat = detectCat(item.title);
    const catLabel = cat.replace(/-/g, ' ').toUpperCase();
    await self.registration.showNotification(`[${catLabel}] Daun Merah`, {
      body: item.title,
      icon: './icon.svg',
      badge: './icon.svg',
      tag: item.guid,
      data: { url: item.link || '/' },
      vibrate: [100, 50, 100],
      requireInteraction: false,
      silent: false
    });
  }

  if (newItems.length > 3) {
    await self.registration.showNotification(`Daun Merah — ${newItems.length} berita baru`, {
      body: newItems.slice(0, 2).map(i => i.title).join('\n'),
      icon: './icon.svg',
      tag: 'batch-' + Date.now(),
      vibrate: [100, 50, 100]
    });
  }
}

self.addEventListener('push', e => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch(err) { data = { title: 'Daun Merah', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(data.title || 'Daun Merah', {
      body: data.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      tag: 'push-' + Date.now(),
      data: { url: data.url || '/' },
      vibrate: [100, 50, 100],
      requireInteraction: false,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(clients.openWindow(url));
});
