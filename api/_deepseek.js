// Sakelar global DeepSeek. Default AKTIF — DeepSeek dinonaktifkan hanya jika
// DEEPSEEK_DISABLED=true diset eksplisit di env. Kalau var tidak ada atau kosong,
// DeepSeek tetap jalan selama RELINK_AI atau DEEPSEEK_API_KEY tersedia.
function isDeepSeekDisabled() {
  return process.env.DEEPSEEK_DISABLED === 'true';
}

function getDeepSeekApiKey() {
  if (isDeepSeekDisabled()) return null;
  return process.env.RELINK_AI?.trim() || process.env.DEEPSEEK_API_KEY || null;
}

function isRelinkActive() {
  return Boolean(process.env.RELINK_AI?.trim());
}

function getDeepSeekUrl() {
  return isRelinkActive()
    ? 'https://api.relink-gateway.biz.id/v1/chat/completions'
    : 'https://api.deepseek.com/chat/completions';
}

// Pool publik/eksperimen tetap terpisah, termasuk saat berganti gateway.
function resolveDeepSeekProvider(provider) {
  if (!isRelinkActive()) return provider;
  return provider.replace(/^deepseek(?=_|$)/, 'relink');
}

function resolveDeepSeekCircuit(source) {
  if (!isRelinkActive()) return source;
  return source.replace(/^ai:deepseek(?=:|$)/, 'ai:relink');
}

module.exports = { isDeepSeekDisabled, getDeepSeekApiKey, isRelinkActive, getDeepSeekUrl,
  resolveDeepSeekProvider, resolveDeepSeekCircuit };
