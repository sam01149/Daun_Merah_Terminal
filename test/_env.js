// Suite menguji perilaku provider aktif dengan mock key. Produksi justru
// nonaktif secara default; preloader ini membuat fixture historis tetap eksplisit.
process.env.DEEPSEEK_DISABLED = 'false';
