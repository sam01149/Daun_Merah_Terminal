const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.CRON_SECRET = 'test-secret';
process.env.AATAS_PAUSED = '1';
const handler = require('../../api/admin');
test('pause AATAS menghentikan jalur otomatis sebelum akses Redis', async () => {
  const oldFetch = global.fetch;
  global.fetch = () => { throw new Error('pause must not reach Redis'); };
  try {
    for (const query of [
      {action:'setup_stats', scope:'auto', source:'cron5'},
      {action:'ohlcv_analyze', auto:'1'},
      {action:'position_review'}, {action:'friday_tighten'}, {action:'setup_log_archive'},
    ]) {
      const req = {query, headers:{'x-cron-secret':'test-secret'}, method:'GET'};
      const res = {setHeader(){}, status(n){this.code=n;return this;}, json(body){this.body=body;return this;}};
      await handler(req,res);
      assert.equal(res.code,503);
      assert.equal(res.body.paused,true);
    }
  } finally { global.fetch = oldFetch; }
});
