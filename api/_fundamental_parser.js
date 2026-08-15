// api/_fundamental_parser.js
// Shared fundamental + CB decision parsing logic.
// Used by market-digest.js (via digest pipeline) and admin.js (via fundamental_refresh).
// All functions are pure except autoUpdateFundamentals which requires a redisCmd function.

const FUND_PREFIX_MAP = [
  { kw: [
      'non-farm payroll','nonfarm payroll','non farm payroll',' nfp ','nfp:',
      'jobless claim','initial claim','unemployment claim','continuing claim',
      'ism manufacturing','ism non-manuf','ism pmi','ism services',
      'core pce','personal consumption expend',
      'jolts','job openings','adp employment','adp nonfarm','adp jobs','adp report',
      'chicago pmi','existing home sales','new home sales','capacity utilization',
      'personal income','personal spending','consumer spending','michigan sentiment','michigan consumer',
      'us cpi','us gdp','us ppi','us retail','us trade','us employ','us unemploy',
      'us job','us inflation','us consumer','us producer','us housing','us wage','us durable',
      'u.s. cpi','u.s. gdp','u.s. employ','u.s. unemploy',
      'united states cpi','united states gdp','united states unemploy',
    ], cur: 'USD' },
  { kw: [
      'german cpi','german gdp','german ifo','german retail','german inflation','german unemploy','german pmi','german trade','german wage',
      'germany cpi','germany gdp','germany unemploy','germany retail','germany pmi','germany trade',
      'eurozone cpi','eurozone gdp','eurozone unemploy','eurozone pmi','eurozone retail','eurozone inflation','eurozone trade','eurozone current account',
      'euro zone cpi','euro zone gdp','euro zone unemploy',
      'euro area cpi','euro area gdp','euro area unemploy','euro area pmi','euro area current account',
      'ez cpi','ez gdp','ez pmi',
      'zew','ifo business','ifo climate','gfk',
      'french cpi','french gdp','french unemploy','france cpi','france gdp',
      'italian cpi','italian gdp','italy cpi','italy gdp',
    ], cur: 'EUR' },
  { kw: [
      'uk cpi','uk gdp','uk retail','uk employ','uk unemploy','uk inflation','uk pmi','uk trade','uk wage','uk earnings','uk average earnings','uk industrial',
      'u.k. cpi','u.k. gdp','u.k. unemploy',
      'british cpi','british gdp','british unemploy','british retail',
      'united kingdom cpi','united kingdom gdp','united kingdom unemploy',
      'claimant count',
    ], cur: 'GBP' },
  { kw: [
      'japan cpi','japan gdp','japan retail','japan trade','japan industrial','japan unemploy','japan pmi','japan wage','japan inflation','japan current account',
      'japanese cpi','japanese gdp','japanese retail','japanese trade','japanese industrial','japanese unemploy','japanese pmi','japanese wage','japanese current account',
      'tankan',
    ], cur: 'JPY' },
  { kw: [
      'canada cpi','canada gdp','canada employ','canada unemploy','canada retail','canada trade','canada inflation','canada pmi','canada housing',
      'canadian cpi','canadian gdp','canadian employ','canadian unemploy','canadian retail','canadian trade','canadian inflation','canadian pmi',
      'ivey pmi','ivey purchasing',
    ], cur: 'CAD' },
  { kw: [
      'australia cpi','australia gdp','australia employ','australia unemploy','australia retail','australia trade','australia inflation','australia pmi','australia building','australia consumer','australia business','australia wage',
      'australian cpi','australian gdp','australian employ','australian unemploy','australian retail','australian trade','australian inflation','australian pmi','australian building','australian consumer','australian business','australian wage',
      'nab business','nab confidence','nab survey',
    ], cur: 'AUD' },
  { kw: [
      'new zealand cpi','new zealand gdp','new zealand employ','new zealand unemploy','new zealand trade','new zealand retail','new zealand inflation','new zealand pmi','new zealand business',
      'nz cpi','nz gdp','nz employ','nz unemploy','nz trade','nz retail','nz pmi','nz inflation',
    ], cur: 'NZD' },
  { kw: [
      'swiss cpi','swiss gdp','swiss trade','swiss unemploy','swiss employ','swiss inflation','swiss pmi','swiss retail','swiss industrial','swiss consumer','swiss business','swiss wage',
      'switzerland cpi','switzerland gdp','switzerland unemploy','switzerland employ','switzerland trade','switzerland retail','switzerland inflation','switzerland pmi','switzerland industrial',
      'kof economic','kof barometer',
    ], cur: 'CHF' },
];

const COUNTRY_STRIP = {
  USD: ['united states ','u.s. ','us '],
  EUR: ['euro area ','eurozone ','euro zone ','german ','germany ','french ','france ','italian ','italy ','ez '],
  GBP: ['united kingdom ','british ','england ','uk ','u.k. '],
  JPY: ['japanese ','japan '],
  CAD: ['canadian ','canada '],
  AUD: ['australian ','australia '],
  NZD: ['new zealand ','nz '],
  CHF: ['switzerland ','swiss '],
};

// Fallback currency detection — dipakai HANYA kalau FUND_PREFIX_MAP (di atas) gagal
// match DAN judul berformat rilis kalender (lihat isCalendarFormat di
// parseFundamentalFromHeadline). FUND_PREFIX_MAP butuh frasa nama-negara+indikator
// nempel langsung ("eurozone cpi"), jadi gagal kalau ada kata sisipan seperti "Core"
// atau "Flash" di antaranya ("Eurozone Core CPI YoY", "Eurozone Flash CPI y/y").
// Nama negara di-cek sendiri (word-boundary, bukan .includes menyeluruh) — aman
// dipakai lebih longgar karena sudah dijaga gate isCalendarFormat di pemanggil.
const FUND_COUNTRY_ONLY = [
  { re: /\b(united states|u\.s\.|us)\b/,                                  cur: 'USD' },
  { re: /\b(eurozone|euro area|euro zone|germany|german|france|french|italy|italian)\b/, cur: 'EUR' },
  { re: /\b(united kingdom|u\.k\.|uk|britain|british|gbp)\b/,             cur: 'GBP' },
  { re: /\b(japan|japanese)\b/,                                           cur: 'JPY' },
  { re: /\b(canada|canadian)\b/,                                          cur: 'CAD' },
  { re: /\b(australia|australian)\b/,                                     cur: 'AUD' },
  { re: /\b(new zealand|nz)\b/,                                           cur: 'NZD' },
  { re: /\b(switzerland|swiss)\b/,                                        cur: 'CHF' },
];

const FUND_INDICATOR_MAP = [
  { kw: ['non-farm payroll','nonfarm payroll','non farm payroll',' nfp ','nfp:'], key: 'NFP' },
  { kw: ['continuing claim'],                                                     key: 'Continuing Claims' },
  { kw: ['jobless claim','initial claim','unemployment claim'],                   key: 'Jobless Claims' },
  { kw: ['ism manufacturing','ism pmi manufactur'],                               key: 'ISM Manufacturing' },
  { kw: ['ism services','ism non-manuf','ism non manuf'],                         key: 'ISM Services' },
  { kw: ['core pce','personal consumption expend'],                               key: 'Core PCE' },
  { kw: ['core cpi','core consumer price','core inflation'],                      key: 'Core CPI MoM' },
  { kw: ['tankan'],                                                               key: 'Tankan Mfg Index' },
  { kw: ['ivey pmi','ivey purchasing'],                                           key: 'Ivey PMI' },
  { kw: ['nab business','nab confidence','nab survey'],                           key: 'NAB Business Conf' },
  { kw: ['zew'],                                                                  key: 'ZEW Sentiment' },
  { kw: ['ifo business','ifo climate'],                                           key: 'IFO Business' },
  { kw: ['gfk'],                                                                  key: 'GfK Consumer Climate' },
  { kw: ['claimant count'],                                                       key: 'Claimant Count' },
  { kw: ['kof economic','kof barometer','kof indicator','kof leading'],           key: 'KOF Barometer' },
  { kw: ['jolts','job openings'],                                                 key: 'JOLTS Job Openings' },
  { kw: ['adp employment','adp nonfarm','adp jobs','adp report'],                 key: 'ADP Employment' },
  { kw: ['chicago pmi'],                                                          key: 'Chicago PMI' },
  { kw: ['existing home sales'],                                                  key: 'Existing Home Sales' },
  { kw: ['new home sales'],                                                       key: 'New Home Sales' },
  { kw: ['personal income'],                                                      key: 'Personal Income' },
  { kw: ['personal spending','consumer spending'],                                key: 'Personal Spending' },
  { kw: ['capacity utilization'],                                                 key: 'Capacity Utilization' },
  { kw: ['factory orders'],                                                       key: 'Factory Orders' },
  { kw: ['manufacturing pmi'],                                                    key: 'Manufacturing PMI' },
  { kw: ['services pmi','service pmi','non-manufacturing pmi'],                   key: 'Services PMI' },
  { kw: ['composite pmi'],                                                        key: 'Composite PMI' },
  { kw: ['industrial production','industrial output'],                           key: 'Industrial Production' },
  { kw: ['trade balance'],                                                        key: 'Trade Balance' },
  { kw: ['current account'],                                                      key: 'Current Account' },
  { kw: ['employment change','employment count','jobs change'],                   key: 'Employment Change' },
  { kw: ['unemployment rate'],                                                    key: 'Unemployment Rate' },
  { kw: ['participation rate'],                                                   key: 'Participation Rate' },
  { kw: ['average earnings','average hourly earnings','wage growth'],             key: 'Wage Growth' },
  { kw: ['retail sales yoy','retail sales y/y','retail sales annual',
         'retail trade yoy','retail trade y/y'],                                key: 'Retail Sales YoY' },
  { kw: ['retail sales','retail trade'],                                        key: 'Retail Sales MoM' },
  // AUD-only (2026-08-10) — pengganti resmi "Retail Trade, Australia" yang dihentikan
  // ABS sejak rilis Juni 2025 (lihat FUND_SEED.AUD di admin.js). Frasa ini spesifik
  // terminologi ABS, belum pernah bentrok dengan indikator currency lain.
  { kw: ['household spending indicator','monthly household spending','household spending'], key: 'Household Spending MoM' },
  { kw: ['producer price',' ppi ','ppi m/m'],                                    key: 'PPI MoM' },
  { kw: ['flash cpi','cpi flash'],                                                key: 'CPI Flash YoY' },
  { kw: ['german cpi','germany cpi'],                                             key: 'German CPI YoY' },
  { kw: ['cpi y/y','cpi yoy','cpi annual','consumer price index y',
         'cpi overall nationwide','nationwide cpi','national cpi'],             key: 'CPI YoY' },
  { kw: ['cpi q/q','cpi qq','cpi qoq','cpi quarter'],                            key: 'CPI QoQ' },
  { kw: ['cpi m/m','cpi mom','consumer price index m'],                          key: 'CPI MoM' },
  { kw: ['consumer price index','consumer prices'],                               key: 'CPI YoY' },
  { kw: ['gdp q/q','gdp qq','gdp quarter','gdp prelim','gdp flash','gdp growth'],key: 'GDP QoQ' },
  { kw: ['gdp m/m','gdp mom','gdp monthly'],                                     key: 'GDP MoM' },
  { kw: ['flash gdp','gdp advance'],                                              key: 'GDP QoQ Flash' },
  { kw: ['gdp'],                                                                  key: 'GDP QoQ' },
  { kw: ['building approval','construction approval'],                            key: 'Building Approvals' },
  { kw: ['building permit'],                                                      key: 'Building Permits' },
  { kw: ['consumer confidence','consumer sentiment','consumer morale','michigan sentiment'], key: 'Consumer Confidence' },
  { kw: ['business confidence','business sentiment','business climate'],          key: 'Business Confidence' },
  { kw: ['housing start','home start'],                                           key: 'Housing Starts' },
  { kw: ['durable goods'],                                                        key: 'Durable Goods Orders' },
  { kw: ['inflation rate','inflation data'],                                      key: 'CPI YoY' },
];

// lowercase(key) -> key kanonik dari FUND_INDICATOR_MAP di atas. Dipakai fallback
// "tebak key dari judul" (lihat parseFundamentalFromHeadline di bawah) untuk
// mencegah duplikat key yang cuma beda casing — audit 2026-08-10 (laporan user)
// menemukan "CPI QoQ" (key kanonik, seed lama tidak pernah ke-update) vs "Cpi Qoq"
// (hasil tebakan title-case naif per-kata yang merusak akronim CPI/QoQ) hidup
// berdampingan untuk AUD, karena keyword 'cpi qoq' waktu itu belum ada di map di
// atas (sudah ditambah) sehingga headline "CPI QoQ Actual 0.6%..." jatuh ke
// fallback tebakan alih-alih match langsung. Reconciliation ini jadi jaring
// pengaman untuk keyword gap SEJENIS yang belum ketahuan (akronim lain: GDP/PMI/
// PPI/dst), bukan cuma fix satu kasus CPI.
const FUND_INDICATOR_CANONICAL = new Map(FUND_INDICATOR_MAP.map(({ key }) => [key.toLowerCase(), key]));

const CB_RATE_MAP = [
  { kw: ['federal reserve','fed ','fomc rate','fed rate','fed funds'],       cur: 'USD' },
  { kw: ['european central bank','ecb rate','ecb deposit','ecb interest'],   cur: 'EUR' },
  { kw: ['bank of england','boe rate','boe bank rate','mpc rate'],           cur: 'GBP' },
  { kw: ['bank of japan','boj rate','boj policy','boj interest'],            cur: 'JPY' },
  { kw: ['reserve bank of australia','rba rate','rba cash rate'],            cur: 'AUD' },
  { kw: ['reserve bank of new zealand','rbnz rate','rbnz ocr'],              cur: 'NZD' },
  { kw: ['bank of canada','boc rate','boc overnight','boc interest'],        cur: 'CAD' },
  { kw: ['swiss national bank','snb rate','snb policy'],                     cur: 'CHF' },
];

// Indicators whose values must be counts (K/M suffix), never percentages.
// A headline yielding e.g. NFP=0.0% is a parse error — reject it.
// NOTE: 'Employment Change' intentionally excluded — NZD reports this as QoQ %
// (e.g. "0.2%"), so rejecting % would silently discard all NZD updates.
// NOTE: 'Building Approvals' (AU) intentionally excluded — reported as MoM %
// (matches its FUND_SCORE_RULES dir/threshold), unlike 'Building Permits' (US),
// which is an absolute count (e.g. "1.45M").
const QUANTITY_INDICATORS = new Set([
  'NFP', 'Jobless Claims', 'Claimant Count', 'Continuing Claims',
  'Building Permits', 'Housing Starts', 'Durable Goods Orders',
  'JOLTS Job Openings', 'ADP Employment', 'ADP Employment Weekly', 'Existing Home Sales', 'New Home Sales',
]);

// Text (headline ATAU judul event calendar_v1) -> key FUND_INDICATOR_MAP, plus
// disambiguasi yang sama untuk kedua sumber (Plan W-5, 2026-08-03 — diekstrak
// dari parseFundamentalFromHeadline supaya autoUpdateFundamentalsFromCalendar
// di bawah pakai logic yang SAMA PERSIS, bukan duplikat yang bisa drift kayak
// bug urutan keyword W-4).
function _matchIndicatorKey(t, currency) {
  // BUG DITEMUKAN & DIFIX (2026-08-11, laporan user — kartu USD nampilin ADP 8,25K
  // yang jelas bukan skala rilis bulanan ADP National Employment/ADPMNUSNERSA):
  // FinancialJuice/calendar_v1 mulai publish rilis eksperimental "ADP Employment
  // Change Weekly" (preliminary, four-week moving average, skala ribuan — beda
  // total dari rilis resmi bulanan yang sudah lama di-track sebagai 'ADP
  // Employment', lihat LABOUR_ROW_MAP.ADPMNUSNERSA di index.html). Qualifier
  // "Weekly"/"Wkly" posisinya TIDAK KONSISTEN antar sumber — kalender menulis
  // "ADP Employment Change Weekly" (nempel ke 'adp employment', lolos matcher di
  // bawah), tapi headline FinancialJuice menulis "ADP Wkly Employment Change"
  // (qualifier di TENGAH — tidak nempel ke 'adp employment' SAMA SEKALI, malah
  // nyasar ke keyword generik 'employment change' → key 'Employment Change',
  // indikator yang seharusnya cuma dipakai GBP/CAD/AUD, bukan USD). Cek eksplisit
  // "adp" + qualifier weekly di mana pun posisinya, SEBELUM loop keyword generik,
  // supaya kedua bentuk konsisten diarahkan ke key terpisah dan tidak ada yang
  // menimpa rilis bulanan resmi ataupun nyasar ke key currency lain.
  if (/\badp\b/i.test(t) && /\bweekly\b|\bwkly\b/i.test(t)) {
    return 'ADP Employment Weekly';
  }

  let indicatorKey = null;
  for (const { kw, key } of FUND_INDICATOR_MAP) {
    if (kw.some(k => t.includes(k))) { indicatorKey = key; break; }
  }

  // Disambiguate Core PCE: YoY vs MoM — store separately so YoY headlines don't overwrite MoM seed.
  if (indicatorKey === 'Core PCE') {
    if (/y\/y|yoy|annual|year.on.year/i.test(t)) indicatorKey = 'Core PCE YoY';
    // MoM or ambiguous → keep 'Core PCE' (matches the seed key)
  }
  // Same for Core CPI
  if (indicatorKey === 'Core CPI MoM') {
    if (/y\/y|yoy|annual|year.on.year/i.test(t)) indicatorKey = 'Core CPI YoY';
  }
  // BUG DITEMUKAN & DIFIX (2026-08-15, audit §3.1): "Core PPI"/"Core Producer
  // Price" dan "Retail Sales Control Group" match keyword generik 'ppi'/'retail
  // sales' di FUND_INDICATOR_MAP di atas SAMA PERSIS seperti versi headline biasa
  // ("PPI m/m", "Retail Sales m/m") — beda level agregasi total (core = exclude
  // food & energy, control group = exclude auto/gas/building materials/food
  // service, dipakai BEA untuk hitung PCE) tapi rilisnya SAMA HARI dengan versi
  // headline, jadi siapa pun yang diproses terakhir menimpa slot 'PPI MoM'/
  // 'Retail Sales MoM' — kartu USD bisa nampilkan "PPI MoM"/"Retail Sales MoM"
  // yang isinya sebenarnya varian sempit (verifikasi live 2026-08-15: Redis PPI
  // MoM 0.2/prev 0.4/forecast 0.3 cocok persis Core PPI BLS, headline resmi PPI
  // MoM = 0.0/forecast 0.2/prev -0.1 — TIDAK cocok). Pisah ke key sendiri
  // (pola sama Core CPI/Core PCE di atas), supaya tidak menimpa slot headline.
  if (indicatorKey === 'PPI MoM' && /\bcore\b/i.test(t)) {
    indicatorKey = 'Core PPI MoM';
  }
  if (indicatorKey === 'Retail Sales MoM' && /\bcontrol group\b/i.test(t)) {
    indicatorKey = 'Retail Sales Control Group MoM';
  }
  // 'NFP' = terminologi rilis jobs report AS (skala K/M). Prancis juga publish
  // "Non-Farm Payrolls QoQ" (skala % kuartalan) — beda satuan & sumber sama sekali,
  // jangan disatukan ke key 'NFP' walau lolos currency-fix di atas, supaya tidak
  // ketimpa/campur dengan NFP AS yang asli di kartu Fundamental USD.
  if (indicatorKey === 'NFP' && currency !== 'USD') {
    indicatorKey = 'Non-Farm Payrolls QoQ';
  }
  // BUG DITEMUKAN & DIFIX (2026-07-30, audit produksi): headline "GDP YoY" ikut
  // ketimpa ke key 'GDP QoQ' karena keyword 'gdp prelim'/'gdp flash'/'gdp growth'
  // di FUND_INDICATOR_MAP match duluan sebelum penanda y/y sempat dicek — tidak
  // seperti Core PCE/Core CPI di atas yang sudah didisambiguasi. Kejadian nyata:
  // "French GDP QoQ Prelim Actual 0.2%" & "French GDP YoY Prelim Actual 0.7%"
  // sama-sama masuk key 'GDP QoQ' dalam satu batch HSET — siapa yang diproses
  // terakhir menang, mengetimpa nilai QoQ yang benar dengan YoY (atau sebaliknya)
  // tergantung urutan array, bukan berdasar isi headline. Pisah key seperti CPI.
  if (indicatorKey === 'GDP QoQ' && /y\/y|yoy|year.on.year/i.test(t) && !/q\/q|qoq|quarter.on.quarter/i.test(t)) {
    indicatorKey = 'GDP YoY';
  }
  // BUG DITEMUKAN & DIFIX (2026-08-15, laporan user — curiga kartu EUR nampilkan
  // "CPI YoY 2,1%" yang bukan rilis Eurozone asli): Eurostat/FinancialJuice pakai
  // istilah "HICP" (Harmonised Index of Consumer Prices) untuk inflasi Eurozone
  // resmi — kata "hicp" TIDAK ADA SAMA SEKALI di FUND_INDICATOR_MAP di atas, jadi
  // SEMUA headline HICP (Eurozone maupun Jerman, Final/Prelim, Y/Y/M/M) jatuh ke
  // fallback tebak-nama di parseFundamentalFromHeadline. Qualifier "Final"/"Prelim"
  // posisinya tidak konsisten antar headline ("HICP Y/Y Final" vs "HICP Final
  // Y/Y") sehingga tiap variasi urutan bikin key fallback BEDA ("Hicp Yoy Final"
  // vs "Hicp Final Yoy") walau rilis yang sama — pecah jadi banyak field yang
  // saling menimpa acak & menggembungkan totalScorable (confidence tier EUR
  // turun palsu), sekaligus menyerobot slot kartu yang harusnya dipakai indikator
  // lain (lihat FUND_KNOWN_SYNONYM_KEYS.EUR untuk migrasi field lama yang sudah
  // terlanjur tertulis dengan nama fallback ini). Disatukan ke slot yang SUDAH
  // ADA (bukan key baru) supaya tidak menambah sinyal inflasi independen EUR
  // ke-3 — lihat FUND_IND_IMPORTANCE['German CPI YoY'] soal alasan sinyal inflasi
  // EUR sengaja tidak diperbanyak (CPI Flash YoY & German CPI YoY sudah sangat
  // berkorelasi). Jerman tetap ke 'German CPI YoY' (persis logic 'german
  // cpi'/'germany cpi' di atas — key itu juga sudah lama tidak dipisah Y/Y vs
  // M/M, jadi HICP M/M Jerman sengaja dibiarkan lewat fallback lama, bukan
  // ditimpakan ke slot Y/Y). Non-Jerman (Eurozone agregat atau anggota lain) ke
  // 'CPI YoY'/'CPI MoM' seperti rilis versi non-HICP yang senilai. "Final"/
  // "Prelim" sengaja diabaikan (bukan dipisah key baru seperti Flash) — keduanya
  // cuma tahap revisi rilis yang SAMA, bukan estimasi dini terpisah seperti Flash.
  if (!indicatorKey && /\bhicp\b/i.test(t)) {
    const isGerman = /\bgerman(y)?\b/i.test(t);
    if (/y\/y|yoy|annual/i.test(t)) indicatorKey = isGerman ? 'German CPI YoY' : 'CPI YoY';
    else if (!isGerman && /m\/m|mom|monthly/i.test(t)) indicatorKey = 'CPI MoM';
  }
  // Flash/preliminary qualifier — kata "flash" bisa muncul di posisi mana pun di judul
  // ("Flash CPI", "CPI Flash", "CPI YoY Flash" — feed FinancialJuice paling sering
  // pakai bentuk terakhir, indikator dulu baru "Flash" di akhir). Kata sisipan ini
  // membuat keyword adjacency 'flash cpi'/'cpi flash' di FUND_INDICATOR_MAP di atas
  // gagal match, jadi redirect di sini berdasarkan base key yang sudah ketemu —
  // supaya nempel ke key seed yang sama ('CPI Flash YoY'/'GDP QoQ Flash'), bukan
  // bikin row terpisah yang isinya sama tapi nama key beda.
  if (/\bflash\b/i.test(t)) {
    if (indicatorKey === 'CPI YoY') indicatorKey = 'CPI Flash YoY';
    else if (indicatorKey === 'GDP QoQ') indicatorKey = 'GDP QoQ Flash';
    else if (indicatorKey === 'GDP YoY') indicatorKey = 'GDP YoY Flash';
  }

  // BUG DITEMUKAN & DIFIX (2026-08-15, laporan user — minta kartu "CPI EUR"
  // cuma pakai data Eurozone ASLI, bukan rilis 1 negara anggota): FUND_COUNTRY_ONLY
  // di atas menyamakan SEMUA negara anggota (Prancis/Italia/dst — bukan cuma
  // Jerman yang sudah dipisah ke key sendiri di atas) sebagai currency EUR, tapi
  // key indikator inflasi generik ('CPI YoY' dkk) tidak pernah dibedakan antara
  // headline "Eurozone HICP..." (agregat resmi seluruh kawasan, dari Eurostat)
  // vs "French CPI..."/"Italian CPI..." (rilis nasional 1 negara doang). Bukti
  // nyata: kartu EUR sempat kepampang rilis INSEE (Prancis, headline "French CPI
  // YoY NSA Actual 2.1%...") di slot yang mestinya representasi Eurozone —
  // autoUpdateFundamentals (jalur headline) tidak ada proteksi source-priority
  // sama sekali (beda dari jalur calendar_v1 yang sudah aman by design: TradingView
  // di-query pakai kode negara "EU", lihat CCY_TO_TV_COUNTRY.EUR di calendar.js —
  // "EU" itu MEMANG cuma agregat Eurozone, tidak pernah tercampur rilis 1 negara),
  // jadi siapa pun headline yang diproses TERAKHIR menang menimpa slot generik.
  // Fix: field inflasi generik EUR HANYA diterima dari headline yang eksplisit
  // sebut "Eurozone"/"Euro Area"/"Euro Zone" (dikonfirmasi ini format asli vendor,
  // lihat headline nyata "Eurozone GDP YoY Flash Estimate Actual..." tgl sama) —
  // rilis 1 negara anggota (Jerman sudah dialihkan duluan di atas jadi tidak
  // pernah sampai sini) DIBUANG total sesuai instruksi user, bukan dipindah ke
  // key lain. Konsekuensi: field ini bisa kosong/basi sampai rilis Eurozone-wide
  // resmi berikutnya keluar (biasanya ~seminggu setelah rilis nasional negara
  // anggota) — trade-off yang disengaja, bukan bug.
  const EUR_INFLATION_KEYS = new Set(['CPI YoY', 'CPI MoM', 'CPI QoQ', 'Core CPI YoY', 'Core CPI MoM', 'CPI Flash YoY']);
  if (currency === 'EUR' && EUR_INFLATION_KEYS.has(indicatorKey)) {
    const isEurozoneWide = /\beurozone\b|\beuro area\b|\beuro zone\b|\beuropean union\b/i.test(t);
    const isMemberState = /\bfrance\b|\bfrench\b|\bitaly\b|\bitalian\b|\bspain\b|\bspanish\b|\bnetherlands\b|\bdutch\b|\bbelgium\b|\bbelgian\b|\bportugal\b|\bportuguese\b|\bgreece\b|\bgreek\b|\bireland\b|\birish\b|\baustria\b|\baustrian\b/i.test(t);
    // `false` (bukan `null`) sengaja dipakai sebagai sinyal "ditolak eksplisit,
    // JANGAN ditebak jadi key baru" — caller parseFundamentalFromHeadline (di
    // bawah) punya fallback tebak-nama title-case naif tiap kali indicatorKey
    // falsy, yang tanpa pembeda ini bakal tetap menciptakan key sampah baru
    // (mis. "Cpi Yoy Nsa"/"Hicp Yoy Final") persis masalah yang barusan diperbaiki
    // di atas — bukan benar-benar membuang rilis 1 negara sesuai maksud fix ini.
    if (isMemberState && !isEurozoneWide) indicatorKey = false;
  }

  return indicatorKey;
}

function parseFundamentalFromHeadline(title) {
  const t = title.toLowerCase();

  // BUG DITEMUKAN & DIFIX (2026-07-30, laporan user — data fundamental salah di
  // banyak currency): headline PROSA (artikel/kutipan, bukan cetakan rilis
  // kalender) sempat lolos parse lewat fallback regex "angka pertama di judul" di
  // bawah. 2 insiden nyata terkonfirmasi di produksi: artikel INSEE prosa "French
  // June consumer spending rises 0.4% m/m vs forecast -0.1%, May revised up to
  // 0.3%" (tanpa kata "Actual" sama sekali) ketimpa jadi 'Personal Spending' USD;
  // "French Non-Farm Payrolls QoQ Actual -0.1..." (format rilis asli, tapi
  // currency salah — lihat fix di bawah) ketimpa jadi NFP USD. Audit news_history
  // produksi (2026-07-30): SEMUA cetakan rilis asli FinancialJuice selalu pakai
  // kata "Actual" — gate ini aman, tidak menghapus rilis sah manapun.
  if (!/\bactual\b/i.test(t)) return null;

  // Rilis kalender ("... Actual X Forecast Y Previous Z") adalah sinyal kuat rilis
  // data asli — dipakai di bawah supaya FUND_COUNTRY_ONLY tidak salah tangkap
  // judul umum yang kebetulan menyebut nama negara tanpa forecast/previous.
  const isCalendarFormat = /\bforecast\b/i.test(t) || /\bprevious\b/i.test(t);

  let currency = null;
  // BUG DITEMUKAN & DIFIX (2026-07-30, laporan user — NFP muncul "rilis hari ini"
  // di USD padahal tidak ada di kalender): root cause "French Non-Farm Payrolls QoQ
  // Actual -0.1..." salah ditandai USD karena FUND_PREFIX_MAP cek keyword bare USD
  // ('non-farm payroll' tanpa prefix "us ") DULUAN sebelum nama negara eksplisit
  // "French" sempat dicek — array USD ada paling depan, loop berhenti di match
  // pertama. Beberapa indikator "bare" lain (non-farm payroll: Prancis; new home
  // sales: Australia HIA) dipakai >1 negara, jadi bug ini sistemik, bukan cuma NFP.
  // Fix: kalau formatnya rilis kalender (gate di atas), cek nama negara EKSPLISIT
  // dulu — sinyal lebih kuat & lebih spesifik daripada keyword indikator generik.
  if (isCalendarFormat) {
    for (const { re, cur } of FUND_COUNTRY_ONLY) {
      if (re.test(t)) { currency = cur; break; }
    }
  }
  if (!currency) {
    for (const { kw, cur } of FUND_PREFIX_MAP) {
      if (kw.some(k => t.includes(k))) { currency = cur; break; }
    }
  }
  if (!currency) return null;

  let indicatorKey = _matchIndicatorKey(t, currency);
  // `false` = ditolak eksplisit (mis. rilis inflasi 1 negara anggota EUR, lihat
  // guard EUR_INFLATION_KEYS di _matchIndicatorKey) — JANGAN masuk fallback
  // tebak-nama di bawah, itu bakal menciptakan key sampah baru yang isinya
  // rilis yang sama persis yang barusan sengaja ditolak.
  if (indicatorKey === false) return null;

  if (!indicatorKey) {
    let stripped = title.trim();
    const strips = (COUNTRY_STRIP[currency] || []).sort((a, b) => b.length - a.length);
    for (const term of strips) {
      const re = new RegExp(`^${term}`, 'i');
      if (re.test(stripped)) { stripped = stripped.replace(re, '').trim(); break; }
    }
    stripped = stripped
      .replace(/\s*[:\-]?\s*(?:actual|act\.?)\s+[+-]?\d+.*$/i, '')
      .replace(/\s+[+-]?\d+\.?\d*\s*(?:%|[KMBbps]|pts?).*$/i, '')
      .replace(/\s*\(.*$/i, '')
      .trim();
    if (stripped && stripped.length >= 3 && stripped.length <= 60) {
      const guessed = stripped.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
      // Reuse casing kanonik kalau tebakan ini sebenarnya sudah dikenal FUND_INDICATOR_MAP
      // (cuma gagal match keyword-nya) — cegah duplikat key beda casing, lihat komentar
      // FUND_INDICATOR_CANONICAL di atas.
      indicatorKey = FUND_INDICATOR_CANONICAL.get(guessed.toLowerCase()) || guessed;
    }
  }

  if (!indicatorKey) return null;

  let value = null;
  // BUG DITEMUKAN & DIFIX (2026-08-15, audit §3.1): \d+\.?\d* tidak menerima koma
  // ribuan — angka format "1,214.3B" (rilis skala besar: Foreign Bond Investment
  // JPY, Visitor Arrivals NZD, dst) kepotong jadi "1" (regex berhenti di koma
  // pertama). [\d,]+ menerima koma di dalam angka, lalu di-strip sebelum disimpan.
  const fjActual = title.match(/[Aa]ctual\s+([+-]?[\d,]+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?/);
  if (fjActual) {
    value = fjActual[1].replace(/,/g, '') + (fjActual[2] || '');
  } else {
    const m = title.match(/([+-]?\d+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?(?:\s|$|,|\(|vs)/);
    if (m) value = m[1] + (m[2] || '');
  }
  if (!value) return null;

  // Reject % values for count-based indicators (e.g. NFP=0.0% is a parse error).
  if (QUANTITY_INDICATORS.has(indicatorKey) && value.endsWith('%')) return null;

  let previous = null;
  const fjPrev = title.match(/[Pp]revious\s+([+-]?[\d,]+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?/);
  if (fjPrev) previous = fjPrev[1].replace(/,/g, '') + (fjPrev[2] || '');

  // Audit 2026-08-12 (respons user, "apa lagi yang bisa diperluas"): "Forecast"
  // (ekspektasi konsensus pasar) sudah lama dipakai buat DETEKSI format rilis
  // (isCalendarFormat di atas) tapi nilainya sendiri tidak pernah diekstrak/disimpan
  // — AI cuma tahu actual vs previous (arah bulan-ke-bulan), padahal actual vs
  // forecast (beat/miss vs ekspektasi pasar) sering lebih menggerakkan harga
  // daripada arah vs bulan lalu.
  let forecast = null;
  const fjForecast = title.match(/[Ff]orecast\s+([+-]?[\d,]+\.?\d*)\s*(K|M|B|%|bps|pts?|points?)?/);
  if (fjForecast) forecast = fjForecast[1].replace(/,/g, '') + (fjForecast[2] || '');

  return { currency, key: indicatorKey, value, previous, forecast };
}

// 8 currency yang punya kartu Fundamental (sama persis FUND_CURRENCIES di
// admin.js — didefinisikan lokal di sini karena modul ini sengaja tanpa
// dependensi ke admin.js, lihat header file).
const FUND_CALENDAR_CURRENCIES = new Set(['USD','EUR','GBP','JPY','CAD','AUD','NZD','CHF']);

// Plan W-5 (2026-08-03, keputusan desain: calendar_v1.actual sebagai LAPIS
// TAMBAHAN yang dicoba DULU, FinancialJuice parsing tetap jalan sebagai
// pelengkap/fallback — lihat api/calendar.js untuk shape event & catatan
// "Audit vendor 2026-07-12" soal field *Raw).
//
// Event calendar_v1/calendar_next_v1 (TradingView) SUDAH terstruktur: currency
// eksplisit (kode ISO, bukan perlu ditebak dari nama negara seperti headline
// FinancialJuice) dan actual/previous SUDAH diformat string siap pakai
// ("2.0%"/"175K", lihat formatTVValue di calendar.js) — value TIDAK perlu regex
// ekstraksi angka seperti parseFundamentalFromHeadline, cukup pakai apa adanya.
//
// Judul event (`e.event`, mis. "Retail Sales YoY") dicocokkan ke KEY YANG SUDAH
// ADA lewat _matchIndicatorKey (fungsi SAMA yang dipakai parseFundamentalFromHeadline
// di atas) — sengaja TIDAK ada fallback "tebak key dari judul" seperti headline
// parser: TradingView punya puluhan indikator per negara yang FUND_INDICATOR_MAP
// belum tentu cover, dan menebak key baru berisiko bikin key/skema baru yang
// tidak konsisten dengan FUND_SEED/UI (dilarang di plan W-5) — event yang key-nya
// tidak dikenal cukup DILEWATI (return null), bukan salah.
function extractFundamentalFromCalendarEvent(e) {
  if (!e) return null;
  const currency = String(e.currency || '').toUpperCase();
  if (!FUND_CALENDAR_CURRENCIES.has(currency)) return null;
  if (e.actual == null || e.actual === '') return null; // rilis belum keluar
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(e.date || ''))) return null;

  const t = String(e.event || '').toLowerCase();
  const indicatorKey = _matchIndicatorKey(t, currency);
  if (!indicatorKey) return null;

  const value = String(e.actual);
  // Reject % values for count-based indicators (sama guard parseFundamentalFromHeadline).
  if (QUANTITY_INDICATORS.has(indicatorKey) && value.endsWith('%')) return null;

  const previous = (e.previous != null && e.previous !== '') ? String(e.previous) : null;
  // Audit 2026-08-12: calendar_v1 (api/calendar.js) sudah menyimpan `forecast`
  // (formatted, lihat formatTVValue) per event — sebelumnya dibuang begitu saja,
  // AI tidak pernah tahu apakah rilis beat/miss ekspektasi pasar.
  const forecast = (e.forecast != null && e.forecast !== '') ? String(e.forecast) : null;
  return { currency, key: indicatorKey, value, previous, forecast, date: e.date };
}

// Ambil event calendar_v1 (minggu berjalan) + calendar_next_v1 (minggu depan) —
// helper dipakai bersama oleh SEMUA caller autoUpdateFundamentalsFromCalendar
// (admin.js/feeds.js/market-digest.js) supaya fetch-nya tidak diduplikasi 3x
// (pola sama _fetchCalendarEventsForFomc di api/rate-path.js). Fail-open: gagal
// fetch/parse → array kosong, caller cukup skip lapis calendar untuk tick itu.
async function _fetchCalendarEventsForFund(redisCmd) {
  try {
    const [raw1, raw2] = await Promise.all([
      redisCmd('GET', 'calendar_v1'),
      redisCmd('GET', 'calendar_next_v1'),
    ]);
    const events = [];
    for (const raw of [raw1, raw2]) {
      if (!raw) continue;
      try {
        const c = JSON.parse(raw);
        if (Array.isArray(c?.events)) events.push(...c.events);
      } catch(_) { /* fail-open, skip batch yang rusak */ }
    }
    return events;
  } catch(e) {
    console.warn('fundamental: fetch calendar_v1/calendar_next_v1 gagal:', e.message);
    return [];
  }
}

// redisCmd dilewatkan sebagai parameter (pola sama autoUpdateFundamentals).
// Ditulis sejajar (bukan menggantikan) autoUpdateFundamentals — caller yang
// memanggil KEDUANYA harus panggil fungsi ini DULU (calendar = lapis tambahan
// yang dicoba lebih dulu, keputusan desain Plan W-5), supaya kalau headline
// FinancialJuice untuk rilis yang sama menyusul, nilainya konsisten (real-world
// sama) dan bukan berebut siapa yang menang secara kebetulan urutan async.
async function autoUpdateFundamentalsFromCalendar(calendarEvents, redisCmd) {
  if (!Array.isArray(calendarEvents)) return {};
  const byCurrency = {};
  for (const e of calendarEvents) {
    const fund = extractFundamentalFromCalendarEvent(e);
    if (!fund) continue;
    if (!byCurrency[fund.currency]) byCurrency[fund.currency] = [];
    byCurrency[fund.currency].push(fund);
  }

  const updated = {};
  for (const [currency, items] of Object.entries(byCurrency)) {
    try {
      const existingRaw = await redisCmd('HMGET', `fundamental:${currency}`, ...items.map(i => i.key));
      const args = ['HSET', `fundamental:${currency}`];
      const writtenKeys = [];
      for (let i = 0; i < items.length; i++) {
        const { key, value, previous, forecast, date } = items[i];
        let existingEntry = null;
        if (existingRaw && existingRaw[i]) {
          try { existingEntry = JSON.parse(existingRaw[i]); } catch(_) {}
        }
        // calendar_v1 `date` SUDAH tanggal rilis pasti (bukan "now" seperti
        // headline parser) — tidak butuh logic isNewValue re-scan, tapi tetap
        // jangan MUNDUR kalau entry existing sudah dari rilis yang lebih baru
        // (mis. calendar_v1 sempat serve cache basi minggu lalu).
        if (existingEntry && existingEntry.date && existingEntry.date > date) continue;
        const entry = { actual: value, period: '—', date, source: 'calendar' };
        if (previous) entry.previous = previous;
        else if (existingEntry && existingEntry.previous) entry.previous = existingEntry.previous;
        // Audit 2026-08-12: forecast (ekspektasi konsensus) — beat/miss vs ini
        // sering lebih menggerakkan pasar daripada arah vs previous saja.
        if (forecast) entry.forecast = forecast;
        else if (existingEntry && existingEntry.forecast) entry.forecast = existingEntry.forecast;
        args.push(key, JSON.stringify(entry));
        writtenKeys.push(key);
      }
      if (writtenKeys.length === 0) continue;
      await redisCmd(...args);
      updated[currency] = writtenKeys;
    } catch(e) { console.warn(`fundamental HSET (calendar) failed for ${currency}:`, e.message); }
  }
  return updated;
}

function parseCBDecision(title) {
  const t = title.toLowerCase();
  if (!/rate|interest|bps|basis point|hold|hike|cut|raise|lower|unchanged/i.test(t)) return null;

  let currency = null;
  for (const { kw, cur } of CB_RATE_MAP) {
    if (kw.some(k => t.includes(k))) { currency = cur; break; }
  }
  if (!currency) return null;

  // Terima bentuk present-tense headline ("Fed cuts", "BoJ holds", "SNB hikes") —
  // tanpa s? opsional, semua headline bentuk orang-ketiga lolos tak terdeteksi.
  const isCut  = /\bcuts?\b|\blowers?\b|\breduce[sd]?\b/i.test(t);
  const isHike = /\bhikes?\b|\braise[sd]?\b|\bincreas|\btighten/i.test(t);
  const isHold = /\bholds?\b|\bunchanged\b|\bleave[sd]?\b|\bkeeps?\b|\bmaintain/i.test(t);
  if (!isCut && !isHike && !isHold) return null;
  const decision = isCut ? 'cut' : isHike ? 'hike' : 'hold';

  const absM = title.match(/(?:at|to)\s+([+-]?\d+\.?\d*)\s*%/i);
  const bpsM = title.match(/(\d+\.?\d*)\s*bps/i);
  const rate = absM ? parseFloat(absM[1]) : null;
  let   bps  = bpsM ? parseFloat(bpsM[1]) : null;
  if (bps !== null && isCut && bps > 0) bps = -bps;
  if (rate === null && bps === null) return null;

  return { currency, rate, bps, decision };
}

// redisCmd is passed as parameter so this module stays free of env dependencies
async function autoUpdateFundamentals(headlines, redisCmd) {
  const byCurrency = {};
  const now = new Date().toISOString().slice(0, 10);

  for (const item of headlines) {
    const fund = parseFundamentalFromHeadline(item.title);
    if (fund) {
      if (!byCurrency[fund.currency]) byCurrency[fund.currency] = [];
      byCurrency[fund.currency].push({ key: fund.key, value: fund.value, headlinePrev: fund.previous, headlineForecast: fund.forecast });
    }

    const cb = parseCBDecision(item.title);
    if (cb) {
      try {
        const existing = await redisCmd('HGET', 'cb_decisions', cb.currency);
        const prev = existing ? JSON.parse(existing) : {};
        const entry = {
          rate:            cb.rate ?? prev.rate ?? null,
          last_bps:        cb.bps  ?? prev.last_bps ?? 0,
          last_decision:   cb.decision,
          last_meeting:    now,
          updated_at:      new Date().toISOString(),
          source_headline: item.title.slice(0, 120),
        };
        await redisCmd('HSET', 'cb_decisions', cb.currency, JSON.stringify(entry));
      } catch(e) { console.warn('cb_decisions write failed:', e.message); }
    }
  }

  const updated = {};
  for (const [currency, items] of Object.entries(byCurrency)) {
    try {
      const existingRaw = await redisCmd('HMGET', `fundamental:${currency}`, ...items.map(i => i.key));
      const args = ['HSET', `fundamental:${currency}`];
      for (let i = 0; i < items.length; i++) {
        const { key, value, headlinePrev, headlineForecast } = items[i];
        let existingEntry = null;
        if (existingRaw && existingRaw[i]) {
          try { existingEntry = JSON.parse(existingRaw[i]); } catch(_) {}
        }
        // BUG DITEMUKAN & DIFIX (2026-07-30): headline yang sama masih muncul di
        // recentItems lintas beberapa run digest (news_history 36h + cron ganda
        // GH Actions/vps daemon, lihat komentar _cron_dedup.js) → sebelum fix ini,
        // `date` SELALU di-set `now` walau actual tidak berubah, jadi indikator lama
        // terus tampil "rilis hari ini" berhari-hari. Sekarang date cuma maju kalau
        // actual benar-benar baru (headline release baru), bukan re-scan headline lama.
        const isNewValue = !existingEntry || existingEntry.actual !== value;
        const entry = { actual: value, period: '—', date: isNewValue ? now : (existingEntry.date || now), source: 'headline' };
        // Headline "Previous X" takes priority; fall back to existing Redis value.
        // Kalau actual TIDAK berubah (re-scan headline lama), pertahankan `previous`
        // yang sudah tersimpan — sebelum fix ini field previous hilang begitu saja
        // di scan kedua karena entry selalu dibangun dari objek kosong.
        if (headlinePrev && headlinePrev !== value) {
          entry.previous = headlinePrev;
        } else if (existingEntry && existingEntry.actual && existingEntry.actual !== value) {
          entry.previous = existingEntry.actual;
        } else if (existingEntry && existingEntry.previous) {
          entry.previous = existingEntry.previous;
        }
        // Audit 2026-08-12: forecast (ekspektasi konsensus) — pola sama seperti
        // previous di atas, pertahankan nilai lama kalau re-scan tidak bawa forecast baru.
        if (headlineForecast) entry.forecast = headlineForecast;
        else if (existingEntry && existingEntry.forecast) entry.forecast = existingEntry.forecast;
        args.push(key, JSON.stringify(entry));
      }
      await redisCmd(...args);
      updated[currency] = items.map(i => i.key);
      console.log(`Fundamental updated: ${currency} — ${items.map(i => i.key).join(', ')}`);
    } catch(e) { console.warn(`fundamental HSET failed for ${currency}:`, e.message); }
  }
  return updated;
}

// Pasangan sinonim TERKONFIRMASI MANUAL — indikator sama, judul rilis beda dari
// keyword FUND_INDICATOR_MAP yang berlaku SAAT key itu pertama ditulis (sudah
// ditambah di atas untuk cegah kasus baru, tapi field yang SUDAH terlanjur tertulis
// dengan nama lama tidak otomatis pindah tanpa reconciliation). Ditemukan lewat
// audit 2026-08-12 (laporan user: kenapa confidence JPY selalu "rendah") — root
// cause: `Cpi Overall Nationwide`/`Industrial Output Prelim Mom Sa`/`Kof Indicator`
// adalah judul rilis asli TradingView/FinancialJuice untuk Jepang & Swiss yang
// TIDAK match keyword lama, jadi jatuh ke fallback tebak-nama dan numpuk sebagai
// field baru alih-alih menimpa field seed `CPI YoY`/`Industrial Production`/
// `KOF Barometer` — seed itu jadi macet PERMANEN (bukan cuma basi ~45 hari) karena
// data segarnya justru ada, cuma di key lain yang tidak pernah dibaca render kartu
// atau prompt AI sebagai representasi indikator itu.
const FUND_KNOWN_SYNONYM_KEYS = {
  JPY: [
    ['Cpi Overall Nationwide', 'CPI YoY'],
    ['Industrial Output Prelim Mom Sa', 'Industrial Production'],
  ],
  CHF: [
    ['Kof Indicator', 'KOF Barometer'],
  ],
  // Audit 2026-08-15 (laporan user) — pecahan fallback-tebak dari headline HICP
  // sebelum fix 'hicp' di _matchIndicatorKey di atas (lihat komentar di sana).
  // Ditulis manual di sini (bukan otomatis lewat byLower) karena beda kata, bukan
  // cuma beda kapitalisasi seperti kasus JPY/CHF di atas.
  EUR: [
    ['Hicp Yoy Final', 'CPI YoY'],
    ['Hicp Final Yoy', 'CPI YoY'],
    ['Hicp Yoy Prelim', 'CPI YoY'],
    ['Hicp Mom Final', 'CPI MoM'],
    ['Hicp Final Mom', 'CPI MoM'],
    ['Hicp Mom Prelim', 'CPI MoM'],
  ],
};

// Bersihkan key fundamental yang jadi "yatim": duplikat konsep yang sama tapi
// ditulis Redis dengan nama beda — baik cuma beda kapitalisasi (tebakan title-case
// naif dari fallback parseFundamentalFromHeadline SEBELUM FUND_INDICATOR_CANONICAL
// sempat mengenalinya, mis. "Cpi Qoq" vs "CPI QoQ") maupun sinonim penamaan rilis
// (FUND_KNOWN_SYNONYM_KEYS di atas). Idempotent & aman dipanggil berulang — tidak
// melakukan apa-apa kalau sudah bersih. Dipasang di fundamental_refresh (admin.js)
// DAN pipeline digest (market-digest.js) supaya self-heal otomatis tiap siklus cron,
// bukan operasi manual sekali jalan yang harus diulang setiap bug sejenis muncul lagi.
async function reconcileFundamentalKeys(redisCmd) {
  const reconciled = {};
  for (const cur of FUND_CALENDAR_CURRENCIES) {
    try {
      const raw = await redisCmd('HGETALL', `fundamental:${cur}`);
      if (!Array.isArray(raw) || raw.length === 0) continue;
      const data = {};
      for (let i = 0; i < raw.length; i += 2) {
        try { data[raw[i]] = JSON.parse(raw[i + 1]); } catch(_) {}
      }
      const keys = Object.keys(data);

      const pairs = []; // [orphanKey, canonicalKey][]

      const byLower = {};
      for (const k of keys) { const lk = k.toLowerCase(); (byLower[lk] = byLower[lk] || []).push(k); }
      for (const arr of Object.values(byLower)) {
        if (arr.length < 2) continue;
        let canonicalKey = null;
        for (const k of arr) {
          const c = FUND_INDICATOR_CANONICAL.get(k.toLowerCase());
          if (c) { canonicalKey = c; break; }
        }
        if (!canonicalKey) canonicalKey = arr[0];
        for (const k of arr) if (k !== canonicalKey) pairs.push([k, canonicalKey]);
      }

      for (const [orphan, canonical] of (FUND_KNOWN_SYNONYM_KEYS[cur] || [])) {
        if (data[orphan]) pairs.push([orphan, canonical]);
      }

      if (pairs.length === 0) continue;

      const setArgs = ['HSET', `fundamental:${cur}`];
      const delArgs = ['HDEL', `fundamental:${cur}`];
      for (const [orphanKey, canonicalKey] of pairs) {
        const orphanEntry = data[orphanKey];
        const canonicalEntry = data[canonicalKey];
        if (!orphanEntry) continue;
        // Menang: non-seed vs seed -> non-seed menang; non-seed vs non-seed -> date
        // lebih baru menang; tak ada canonical existing -> orphan jadi isi canonical.
        let winner = canonicalEntry || orphanEntry;
        if (canonicalEntry && canonicalEntry.source === 'seed' && orphanEntry.source !== 'seed') {
          winner = orphanEntry;
        } else if (canonicalEntry && canonicalEntry.source !== 'seed' && orphanEntry.source !== 'seed') {
          const cDate = /^\d{4}-\d{2}-\d{2}/.test(canonicalEntry.date || '') ? canonicalEntry.date : null;
          const oDate = /^\d{4}-\d{2}-\d{2}/.test(orphanEntry.date || '') ? orphanEntry.date : null;
          if (oDate && (!cDate || oDate > cDate)) winner = orphanEntry;
        }
        if (winner !== canonicalEntry) setArgs.push(canonicalKey, JSON.stringify(winner));
        delArgs.push(orphanKey);
      }
      if (setArgs.length > 2) await redisCmd(...setArgs);
      if (delArgs.length > 2) await redisCmd(...delArgs);
      reconciled[cur] = pairs.map(([o, c]) => `${o} -> ${c}`);
    } catch(e) { console.warn(`reconcileFundamentalKeys failed for ${cur}:`, e.message); }
  }
  return reconciled;
}

module.exports = {
  parseFundamentalFromHeadline,
  parseCBDecision,
  autoUpdateFundamentals,
  extractFundamentalFromCalendarEvent,
  autoUpdateFundamentalsFromCalendar,
  _fetchCalendarEventsForFund,
  reconcileFundamentalKeys,
};
