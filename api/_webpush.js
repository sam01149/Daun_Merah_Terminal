// api/_webpush.js — shared web-push sender, used by api/admin.js (pushHandler)
// and api/market-digest.js (digest-ready notification, A2.2).
const crypto  = require('crypto');
const webpush = require('web-push');

function subKey(endpoint) {
  return crypto.createHash('sha256').update(endpoint).digest('hex');
}

function configureVapid() {
  const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
  const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
  const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@daun-merah.app';
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  return true;
}

// Sends `payload` (object, will be JSON-stringified) to every subscription in `subs`.
// Returns the subKey() hashes of subscriptions that came back 410/404 (stale — caller
// should HDEL them from push_subs).
async function sendWebPush(subs, payload) {
  const body = JSON.stringify(payload);
  const staleKeys = [];
  await Promise.allSettled(subs.map(async sub => {
    try { await webpush.sendNotification(sub, body); }
    catch(e) { if (e.statusCode === 410 || e.statusCode === 404) staleKeys.push(subKey(sub.endpoint)); }
  }));
  return staleKeys;
}

module.exports = { configureVapid, sendWebPush, subKey };
