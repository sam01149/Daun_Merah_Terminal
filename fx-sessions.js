/* fx-sessions.js — sesi FX (UTC) single source of truth (audit adaptivitas 2026-08-08).
 *
 * Sebelum file ini ada, batas jam sesi (Tokyo/London/Overlap/NY/Closed = 0/8/13/16/21
 * UTC) ditulis manual di 3 tempat berbeda: JN_CSV_SESSIONS (index.html, dipakai CSV
 * export jurnal), JOURNAL_BIAS_SESSIONS (api/journal.js, dipakai diagnosa bias jurnal),
 * dan literal angka lepas (8/13/16/21) di auto-tick checklist tm1/tm1a/tm1b/tm2
 * (index.html, _ckAutoSMC). Kalau jam sesi pernah perlu diubah, hanya salinan yang
 * kebetulan diingat yang ke-update — 2 lainnya diam-diam basi. File ini satu-satunya
 * sumber; semua konsumen WAJIB pakai ini, jangan bikin tabel/angka literal baru.
 *
 * Konsumen:
 *   - index.html    : <script src="/fx-sessions.js?v=…"> → window.FxSessions
 *   - api/journal.js: require('../fx-sessions')
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FxSessions = factory();
})(this, function () {
  const SESSIONS = [
    { key: 'tokyo',   label: 'Tokyo',              start: 0,       end: 8 * 60 },
    { key: 'london',  label: 'London',             start: 8 * 60,  end: 13 * 60 },
    { key: 'overlap', label: 'London+NY Overlap',  start: 13 * 60, end: 16 * 60 },
    { key: 'ny',      label: 'New York',           start: 16 * 60, end: 21 * 60 },
    { key: 'closed',  label: 'Market Closed',      start: 21 * 60, end: 24 * 60 },
  ];

  // mins = menit-ke-hari UTC (0-1439)
  function sessionAtMinutes(mins) {
    return SESSIONS.find(s => mins >= s.start && mins < s.end) || SESSIONS[SESSIONS.length - 1];
  }

  function sessionAtIso(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return sessionAtMinutes(d.getUTCHours() * 60 + d.getUTCMinutes());
  }

  // Jam mulai (UTC, 0-23) sesi tertentu — dipakai pembanding "h >= X" di checklist
  // auto-tick supaya tidak menyalin literal 8/13/16/21 sendiri-sendiri.
  function startHour(key) {
    const s = SESSIONS.find(s => s.key === key);
    return s ? s.start / 60 : null;
  }

  return {
    SESSIONS: SESSIONS,
    sessionAtMinutes: sessionAtMinutes,
    sessionAtIso: sessionAtIso,
    startHour: startHour,
  };
});
