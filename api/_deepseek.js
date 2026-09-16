// Sakelar global DeepSeek. Keadaan bawaan sengaja NONAKTIF agar deploy tidak bisa
// mengirim prompt atau memakai saldo DeepSeek sebelum operator mengaktifkannya lagi.
// Untuk mengaktifkan kembali setelah provider pengganti siap, set env produksi
// DEEPSEEK_DISABLED=false lalu deploy/redeploy sesuai prosedur operasional.
function isDeepSeekDisabled() {
  return process.env.DEEPSEEK_DISABLED !== 'false';
}

function getDeepSeekApiKey() {
  if (isDeepSeekDisabled()) return null;
  return process.env.DEEPSEEK_API_KEY || null;
}

module.exports = { isDeepSeekDisabled, getDeepSeekApiKey };
