// Preloader environment untuk test suite. DeepSeek aktif secara default
// (tidak perlu set DEEPSEEK_DISABLED). File ini tetap ada untuk override env lain jika perlu.

// Uji perilaku normal AATAS secara eksplisit; produksi default berhenti.
process.env.AATAS_PAUSED = '0';
