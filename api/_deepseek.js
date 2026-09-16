// Sakelar global DeepSeek. Default AKTIF — DeepSeek dinonaktifkan hanya jika
// DEEPSEEK_DISABLED=true diset eksplisit di env. Kalau var tidak ada atau kosong,
// DeepSeek tetap jalan selama DEEPSEEK_API_KEY tersedia.
function isDeepSeekDisabled() {
  return process.env.DEEPSEEK_DISABLED === 'true';
}

function getDeepSeekApiKey() {
  if (isDeepSeekDisabled()) return null;
  return process.env.DEEPSEEK_API_KEY || null;
}

module.exports = { isDeepSeekDisabled, getDeepSeekApiKey };
