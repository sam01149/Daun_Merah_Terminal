const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepSeekDisabled, getDeepSeekApiKey, getDeepSeekUrl,
  resolveDeepSeekProvider, resolveDeepSeekCircuit } = require('../../api/_deepseek');

function withEnv(values, fn) {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('DeepSeek nonaktif hanya bila DEEPSEEK_DISABLED=true diset eksplisit', () => {
  withEnv({ DEEPSEEK_DISABLED: 'true', DEEPSEEK_API_KEY: 'secret-test' }, () => {
    assert.equal(isDeepSeekDisabled(), true);
    assert.equal(getDeepSeekApiKey(), null);
  });
});

test('Relink memakai kunci dan host berpasangan, dengan pool dan circuit terisolasi', () => {
  withEnv({ RELINK_AI: ' relink-test ', DEEPSEEK_API_KEY: 'official-test', DEEPSEEK_DISABLED: 'false' }, () => {
    assert.equal(getDeepSeekApiKey(), 'relink-test');
    assert.equal(getDeepSeekUrl(), 'https://api.relink-gateway.biz.id/v1/chat/completions');
    assert.equal(resolveDeepSeekProvider('deepseek'), 'relink');
    assert.equal(resolveDeepSeekProvider('deepseek_experimental'), 'relink_experimental');
    assert.equal(resolveDeepSeekCircuit('ai:deepseek:experimental'), 'ai:relink:experimental');
    assert.equal(resolveDeepSeekCircuit('ai:gemini:digest'), 'ai:gemini:digest');
  });
  withEnv({ RELINK_AI: 'relink-test', DEEPSEEK_DISABLED: 'true' }, () => {
    assert.equal(getDeepSeekApiKey(), null);
  });
  withEnv({ RELINK_AI: ' ', DEEPSEEK_API_KEY: 'official-test', DEEPSEEK_DISABLED: 'false' }, () => {
    assert.equal(getDeepSeekApiKey(), 'official-test');
    assert.equal(getDeepSeekUrl(), 'https://api.deepseek.com/chat/completions');
    assert.equal(resolveDeepSeekProvider('deepseek'), 'deepseek');
  });
});

test('seluruh call site generate memakai resolver URL, tidak mengirim key Relink ke host resmi', () => {
  for (const file of ['api/admin.js', 'api/market-digest.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.doesNotMatch(source, /https:\/\/api\.deepseek\.com\/chat\/completions/);
    assert.match(source, /getDeepSeekUrl/);
  }
});

test('DeepSeek aktif secara default (tanpa env var) dan konsumen memakai sakelar pusat', () => {
  withEnv({ DEEPSEEK_DISABLED: undefined, DEEPSEEK_API_KEY: 'secret-test' }, () => {
    assert.equal(isDeepSeekDisabled(), false);
    assert.equal(getDeepSeekApiKey(), 'secret-test');
  });

  for (const file of ['api/admin.js', 'api/market-digest.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.doesNotMatch(source, /process\.env\.DEEPSEEK_API_KEY/,
      `${file} tidak boleh melewati sakelar global`);
    assert.match(source, /getDeepSeekApiKey/,
      `${file} harus mengambil kunci melalui sakelar global`);
  }
});
