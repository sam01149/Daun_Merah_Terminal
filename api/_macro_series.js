'use strict';

// Explicit definitions, not keyword inference. Aliases share an economic series
// only when their definitions agree; different series can still share a family.
const CURRENCY_COUNTRY = { USD:'US', EUR:'EU', GBP:'GB', JPY:'JP', CHF:'CH', CAD:'CA', AUD:'AU', NZD:'NZ' };
const NATIONAL_EUR = /\b(german(?:y)?|france|french|italy|italian|spain|spanish|belgium|belgian|netherlands|dutch|austria|austrian|ireland|irish|portugal|portuguese|greece|greek)\b/i;
const REVISED = /\b(final|revised|revision|2nd|second|3rd|third)\b/i;
const DEFINITIONS = new Map();
function define(id, pillar, family, names, options = {}) {
  for (const name of names) {
    if (DEFINITIONS.has(name)) throw Error(`Duplicate macro alias: ${name}`);
    DEFINITIONS.set(name, { id, pillar, family, ...options });
  }
}

define('gdp', 'growth', 'output', ['gdp growth rate', 'gdp growth', 'gross domestic product growth rate'], { cadence:'quarterly', periods:['qoq','yoy','annualized'] });
define('gdp_monthly', 'growth', 'output', ['gdp', 'monthly gdp'], { cadence:'monthly', periods:['mom','yoy'], countries:['GB','CA'] });
define('industrial_production', 'growth', 'output', ['industrial production','industrial output'], { periods:['mom','yoy'] });
define('retail_sales', 'growth', 'consumption', ['retail sales'], { periods:['mom','yoy'] });
define('retail_sales_ex_autos', 'growth', 'consumption', ['retail sales ex autos'], { periods:['mom','yoy'] });
define('retail_sales_ex_fuel', 'growth', 'consumption', ['retail sales ex fuel'], { periods:['mom','yoy'] });
define('retail_sales_ex_gas_autos', 'growth', 'consumption', ['retail sales ex gas autos'], { periods:['mom','yoy'] });
define('retail_control_group', 'growth', 'consumption', ['retail sales control group'], { defaultPeriod:'mom', periods:['mom'], countries:['US'] });
define('household_spending', 'growth', 'consumption', ['household spending'], { periods:['mom','yoy'] });
define('manufacturing_pmi', 'growth', 'activity_survey', ['manufacturing pmi','h c o b manufacturing pmi','hcob manufacturing pmi','s p global manufacturing pmi','procure ch manufacturing pmi'], { periods:['level'] });
define('services_pmi', 'growth', 'activity_survey', ['services pmi','h c o b services pmi','hcob services pmi','s p global services pmi'], { periods:['level'] });
define('composite_pmi', 'growth', 'activity_survey', ['composite pmi','h c o b composite pmi','hcob composite pmi','s p global composite pmi','euro area composite pmi'], { periods:['level'] });
define('ism_manufacturing_pmi', 'growth', 'activity_survey', ['ism manufacturing pmi'], { countries:['US'], periods:['level'] });
define('ism_services_pmi', 'growth', 'activity_survey', ['ism services pmi','ism non manufacturing pmi'], { countries:['US'], periods:['level'] });
define('ivey_pmi', 'growth', 'activity_survey', ['ivey pmi'], { countries:['CA'], periods:['level'] });
define('payrolls', 'growth', 'labour', ['non farm payrolls','nonfarm payrolls','nfp'], { countries:['US'], periods:['level'], unit:'count' });
define('private_payrolls', 'growth', 'labour', ['nonfarm payrolls private','non farm payrolls private'], { countries:['US'], periods:['level'], unit:'count' });
define('adp_employment', 'growth', 'labour', ['adp employment change'], { countries:['US'], periods:['level'], unit:'count' });
define('employment_change', 'growth', 'labour', ['employment change'], { periods:['level','qoq','yoy'] });
define('unemployment_rate', 'growth', 'labour', ['unemployment rate'], { inverse:true, periods:['level'] });
define('u6_unemployment_rate', 'growth', 'labour', ['u 6 unemployment rate'], { countries:['US'], inverse:true, periods:['level'] });
define('initial_jobless_claims', 'growth', 'labour', ['initial jobless claims'], { countries:['US'], inverse:true, cadence:'weekly', periods:['level'], unit:'count' });
define('continuing_jobless_claims', 'growth', 'labour', ['continuing jobless claims'], { countries:['US'], inverse:true, cadence:'weekly', periods:['level'], unit:'count' });
define('claimant_count', 'growth', 'labour', ['claimant count change','claimant count'], { countries:['GB'], inverse:true, periods:['level'], unit:'count' });
define('hourly_earnings', 'growth', 'labour', ['average hourly earnings'], { countries:['US'], periods:['mom','yoy'] });
define('earnings_incl_bonus', 'growth', 'labour', ['average earnings incl bonus'], { countries:['GB'], periods:['yoy'] });
define('earnings_ex_bonus', 'growth', 'labour', ['average earnings excluding bonus'], { countries:['GB'], defaultPeriod:'yoy', periods:['yoy'] });
define('wage_growth', 'growth', 'labour', ['wage growth','wage price index'], { periods:['qoq','yoy'] });
define('consumer_confidence', 'growth', 'demand_survey', ['consumer confidence','consumer confidence index','gfk consumer confidence']);
define('cb_consumer_confidence', 'growth', 'demand_survey', ['cb consumer confidence'], { countries:['US'] });
define('michigan_consumer_sentiment', 'growth', 'demand_survey', ['michigan consumer sentiment'], { countries:['US'] });
define('ifo_business', 'growth', 'business_survey', ['ifo business climate','ifo business climate index']);
define('zew_sentiment', 'growth', 'business_survey', ['zew economic sentiment','zew economic sentiment index']);
define('kof_barometer', 'growth', 'business_survey', ['kof economic barometer','kof leading indicators'], { countries:['CH'] });
for (const [id, title] of [
  ['tankan_large_manufacturers','tankan large manufacturers index'],
  ['tankan_large_nonmanufacturers','tankan large non manufacturing index'],
  ['tankan_small_manufacturers','tankan small manufacturers index'],
  ['tankan_small_nonmanufacturers','tankan small non manufacturers index'],
  ['tankan_manufacturing_outlook','tankan large manufacturing outlook'],
  ['tankan_nonmanufacturing_outlook','tankan non manufacturing outlook'],
]) define(id, 'growth', 'business_survey', [title], { countries:['JP'], cadence:'quarterly', periods:['level'] });
define('business_confidence', 'growth', 'business_survey', ['business confidence','business confidence index','business climate']);

define('consumer_prices', 'inflation', 'headline_consumer_prices', ['inflation rate','cpi','hicp','consumer price index'], { periods:['mom','yoy','qoq','level'] });
define('core_consumer_prices', 'inflation', 'core_consumer_prices', ['core inflation rate','core cpi','core hicp','core consumer price index'], { periods:['mom','yoy','qoq','level'] });
// Euro area core also excludes alcohol/tobacco; ex food/energy is a different aggregate.
define('hicp_ex_food_energy', 'inflation', 'core_consumer_prices', ['hicp ex food and energy'], { countries:['EU'], periods:['mom','yoy'] });
define('pce_prices', 'inflation', 'headline_consumer_prices', ['pce price index','pce prices'], { countries:['US'], periods:['mom','yoy','qoq'] });
define('core_pce', 'inflation', 'core_consumer_prices', ['core pce price index','core pce prices'], { countries:['US'], periods:['mom','yoy','qoq'] });
define('trimmed_mean_cpi', 'inflation', 'core_consumer_prices', ['rba trimmed mean cpi'], { countries:['AU'], periods:['mom','yoy','qoq'] });
define('weighted_median_cpi', 'inflation', 'core_consumer_prices', ['rba weighted median cpi','australia inflation rba weightd medn cpi'], { countries:['AU'], periods:['mom','yoy','qoq'] });
define('monthly_cpi_indicator', 'inflation', 'headline_consumer_prices', ['monthly cpi indicator'], { countries:['AU'], defaultPeriod:'yoy', cadence:'monthly', periods:['yoy'] });
define('cpi_trimmed_mean', 'inflation', 'core_consumer_prices', ['cpi trimmed mean'], { countries:['CA'], periods:['yoy'] });
define('cpi_median', 'inflation', 'core_consumer_prices', ['cpi median'], { countries:['CA'], periods:['yoy'] });
define('cpi_common', 'inflation', 'core_consumer_prices', ['cpi common'], { countries:['CA'], periods:['yoy'] });
define('tokyo_core_cpi', 'inflation', 'core_consumer_prices', ['tokyo core cpi'], { countries:['JP'], periods:['yoy'] });
define('tokyo_cpi_ex_food_energy', 'inflation', 'core_consumer_prices', ['tokyo cpi ex food and energy'], { countries:['JP'], periods:['yoy'] });
define('services_inflation', 'inflation', 'core_consumer_prices', ['services inflation'], { countries:['GB'], periods:['mom','yoy'] });
define('producer_prices', 'inflation', 'producer_prices', ['ppi','producer price index','producer prices'], { periods:['mom','yoy','qoq'] });
define('core_producer_prices', 'inflation', 'producer_prices', ['core ppi','core producer price index'], { periods:['mom','yoy'] });
define('ppi_input', 'inflation', 'producer_prices', ['ppi input'], { periods:['mom','yoy','qoq'] });
define('ppi_output', 'inflation', 'producer_prices', ['ppi output'], { periods:['mom','yoy','qoq'] });
define('ppi_ex_food_energy_trade', 'inflation', 'producer_prices', ['ppi ex food energy and trade services','ppi ex food energy and trade'], { countries:['US'], periods:['mom','yoy'] });

function classifyMacroRelease(title, currency, metadata = {}, { allowRevisions=false } = {}) {
  const cur = String(currency || '').toUpperCase();
  let text = String(title || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  if (!CURRENCY_COUNTRY[cur] || !text || (!allowRevisions && REVISED.test(text)) || (cur === 'EUR' && NATIONAL_EUR.test(text))) return null;
  text = text.replace(/\b3mo\/yr\b/g, 'yoy').replace(/\by\/y\b|year[- ]on[- ]year/g, 'yoy')
    .replace(/\bm\/m\b|month[- ]on[- ]month/g, 'mom').replace(/\bq\/q\b/g, 'qoq')
    .replace(/\bqq\b/g, 'qoq').replace(/\bs\s*&\s*p\b/g,'s p').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
  const period = text.match(/\b(mom|yoy|qoq|annualized)\b/)?.[1];
  const quarterly = /\bquarterly\b/.test(text);
  const sa = /\bs a\b|\bseasonally adjusted\b/.test(text)
    || /\bSA\b/.test(String(metadata.source_indicator || metadata.indicator || ''));
  if (allowRevisions) text=text.replace(/\b(?:2nd|second|3rd|third) (?:est|estimate)\b|\b(final|revised|revision|2nd|second|3rd|third)\b/g,' ');
  text = text.replace(/\b(mom|yoy|qoq|annualized|quarterly|prel|prelim|preliminary|flash|adv|advance)\b/g, ' ')
    .replace(/\b1st (?:est|estimate)\b|\bfirst estimate\b|\bs a\b|\bseasonally adjusted\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
  // "GDP Growth Annualized" is real output; GDP price/sales/components have no alias.
  const definition = text === 'gdp' && ['qoq','annualized'].includes(period)
    ? DEFINITIONS.get('gdp growth rate') : DEFINITIONS.get(text);
  if (!definition || (definition.countries && !definition.countries.includes(CURRENCY_COUNTRY[cur]))) return null;
  const measure = period || definition.defaultPeriod || 'level';
  if (definition.periods && !definition.periods.includes(measure)) return null;
  const reference = String(metadata.reference_period || metadata.referencePeriod || metadata.period || '');
  const cadence = definition.cadence === 'weekly' ? 'weekly'
    : /\bQ[1-4]\b/i.test(reference) || quarterly || ['qoq','annualized'].includes(measure) ? 'quarterly'
      : definition.cadence || ((cur === 'NZD' && ['consumer_prices','core_consumer_prices','employment_change','unemployment_rate'].includes(definition.id)) || (cur === 'EUR' && definition.id === 'employment_change') || (cur === 'AUD' && definition.id === 'wage_growth') || (cur === 'AUD' && definition.id === 'weighted_median_cpi' && !sa) ? 'quarterly' : 'monthly');
  if (text === 'inflation rate' && measure === 'level') return null;
  const unit = definition.unit || (definition.id === 'employment_change' && measure === 'level' ? 'count'
    : measure === 'level' && !definition.id.includes('unemployment') ? 'index' : 'percent');
  return { pillar:definition.pillar, family:definition.family, series:`${definition.id}:${measure}:${cadence}${sa ? ':sa' : ''}`, inverse:!!definition.inverse, cadence, unit };
}

module.exports = { classifyMacroRelease, CURRENCY_COUNTRY };
