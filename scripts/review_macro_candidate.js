'use strict';

// Offline, read-only pre-integration review. No Redis, AI, price forecast or PnL.
// node scripts/review_macro_candidate.js --as-of=2026-11-06T16:20:42.561Z
// Source snapshots are private .cache artifacts from rebuild_macro_foundation.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const assert=require('node:assert/strict');
const macro=require('../api/_macro_surprise');
const {buildMacroCandidate,buildAcademyPreview}=require('../api/_macro_candidate');
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const LABELS={up:'Membaik',down:'Melemah',mixed:'Campur',unclear:'Belum jelas',unchanged:'Tetap',insufficient:'Data kurang',bullish:'Mendukung',bearish:'Menentang',neutral:'Netral'};
const label=value=>LABELS[value] || value;
const inflationLabel=value=>({up:'Memanas',down:'Mendingin',unchanged:'Stabil'})[value] || label(value);
const policyLabel=value=>({bullish:'Hawkish',bearish:'Dovish'})[value] || label(value);
const fmt=value=>Number.isFinite(value) ? Number(value.toFixed(4)).toString() : '—';

function buildReview(snapshots,baselineReleases,contextRows,asOfMs) {
  const observations=snapshots.flatMap(snapshot=>{
    if (snapshot.source!=='tradingview' || !Array.isArray(snapshot.rows) || !Number.isFinite(Date.parse(snapshot.fetched_at))) throw Error('Invalid source snapshot');
    return snapshot.rows.map(event=>macro.normalizeMacroObservation(event,{observedAt:snapshot.fetched_at,vintageKind:'historical_snapshot',allowRevisions:true})).filter(Boolean);
  });
  const before=hash(observations);
  const candidate=buildMacroCandidate(observations,{asOfMs});
  const preview=buildAcademyPreview(candidate,contextRows);
  const baseline=macro.assessMacroScoreStability(baselineReleases,{asOfMs});
  const noProducer=buildMacroCandidate(observations.filter(row=>row.family!=='producer_prices'),{asOfMs});
  const reverse=buildMacroCandidate([...observations].reverse(),{asOfMs});
  const alteredForecast=buildMacroCandidate(observations.map(row=>({...row,forecast:999999})),{asOfMs});
  for(const [currency,item] of Object.entries(candidate.currencies)) {
    assert.deepEqual(item.inflation.components,noProducer.currencies[currency].inflation.components);
    assert.equal(item.inflation.state,noProducer.currencies[currency].inflation.state);
    assert.deepEqual(item,reverse.currencies[currency]);
    assert.equal(item.growth.state,alteredForecast.currencies[currency].growth.state);
    assert.equal(item.inflation.state,alteredForecast.currencies[currency].inflation.state);
    assert.equal(new Set(item.growth.components.map(row=>row.concept)).size,2);
    assert.equal(new Set(item.inflation.components.map(row=>row.concept)).size,2);
  }
  assert.equal(hash(observations),before,'review must not mutate source observations');
  const comparison=preview.map(row=>{
    const item=candidate.currencies[row.currency];
    return {currency:row.currency,
      old_growth_surprise:baseline.currencies[row.currency].growth.status,new_growth_conditions:item.growth.state,
      old_inflation_surprise:baseline.currencies[row.currency].inflation.status,new_consumer_inflation:item.inflation.state,
      growth_coverage:item.growth.coverage,inflation_coverage:item.inflation.coverage,bias:row.overall.state,
      missing_growth:item.growth.components.filter(value=>value.direction==null).map(value=>value.concept),
      missing_inflation:item.inflation.components.filter(value=>value.direction==null).map(value=>value.concept),
    };
  });
  return {
    schema_version:1,purpose:'Academy-style qualitative fundamental bias; not a price prediction model',
    as_of:new Date(asOfMs).toISOString(),source_months:snapshots.length,raw_events:snapshots.reduce((n,s)=>n+s.rows.length,0),
    normalized_observations:observations.length,source_digest:before,
    verification:{test_scope:'semantic_and_data_integrity',order_invariant:true,ppi_cannot_flip_consumer_prices:true,
      consensus_cannot_flip_reported_conditions:true,duplicate_concepts:false,source_not_mutated:true},
    readiness:{implementation_checked:true,integrated:false,
      incomplete_growth:comparison.filter(row=>row.growth_coverage!=='complete').map(row=>row.currency),
      incomplete_inflation:comparison.filter(row=>row.inflation_coverage!=='complete').map(row=>row.currency),
      notes:['Rules are a local conservative adaptation, not a disclosed Prime formula.',
        'Missing data stays missing; no automatic fallback to surprise.',
        'CB, bank research and positioning supplied as context have not been redesigned in this review.',
        'No market hit-rate, probabilities or performance promises are calculated.']},
    comparison,candidate,preview,
  };
}

function reviewMarkdown(report) {
  let text='# Pemeriksaan sebelum integrasi: tabel Bias ala Prime Academy\n\n';
  text+='Snapshot: '+report.as_of+'. Tujuan: bias fundamental kualitatif, bukan probabilitas/target harga.\n\n';
  text+='Tabel, urutan kolom dan hierarki tetap mengikuti Dashboard aktif. Aturan otomatis adalah adaptasi lokal karena Academy tidak mempublikasikan bobot numerik lengkap.\n\n';
  text+='| Mata uang | Pertumbuhan | Inflasi konsumen | Bank sentral | Pandangan ekonom | Posisi pasar | Bias |\n|---|---|---|---|---|---|---|\n';
  for(const row of report.preview) text+='| '+[row.currency,label(row.growth.conditions.state),inflationLabel(row.inflation.conditions.state),policyLabel(row.central_bank.state),label(row.banks.state),label(row.positioning.state),label(row.overall.state)].join(' | ')+' |\n';
  text+='\nPertumbuhan di atas menjelaskan perubahan kondisi; status inflasi menjelaskan laju harga konsumen YoY. Keduanya berbeda dari perbandingan actual versus consensus.\n\n';
  for(const row of report.preview) {
    text+='## '+row.currency+'\n\n';
    for(const item of [...row.growth.conditions.components,...row.inflation.conditions.components]) {
      text+='- '+item.concept+': '+(item.indicator || 'Belum ada data yang memenuhi definisi/umur')+'; actual '+fmt(item.actual)+'; sebelumnya '+fmt(item.previous)+'; konsensus '+fmt(item.forecast)+'.';
      if(item.released_at) text+=' Rilis '+item.released_at+'; periode '+item.period+'; sumber ID '+item.source_event_id+'.';
      if(item.concept==='output' && item.level_direction===1 && item.direction===-1) text+=' Ekonomi masih tumbuh, tetapi laju pertumbuhannya melambat.';
      if(item.concept==='survey' && item.level_direction===-1 && item.direction===1) text+=' Survei membaik, tetapi aktivitas masih di bawah batas tanpa perubahan.';
      text+='\n';
    }
    const survey=row.growth.conditions.survey_context,consumption=row.growth.conditions.consumption_context;
    text+='- Pelengkap: PMI '+fmt(survey.actual)+' vs sebelumnya '+fmt(survey.previous)+'; konsumsi '+fmt(consumption.actual)+' vs sebelumnya '+fmt(consumption.previous)+'. Tidak membalik inti GDP/tenaga kerja.\n';
    const producer=row.inflation.conditions.producer_context;
    text+='- Harga produsen: '+(producer.indicator || 'data kurang')+' '+fmt(producer.actual)+' vs sebelumnya '+fmt(producer.previous)+'. Konteks terpisah, bukan suara inflasi konsumen.\n';
    text+='- Kualitas bukti: pertumbuhan '+row.growth.conditions.coverage+', inflasi '+row.inflation.conditions.coverage+'. Tidak diterjemahkan menjadi persentase peluang benar.\n\n';
  }
  text+='## Hasil pemeriksaan\n\n';
  text+='Urutan input tidak mengubah hasil; perubahan consensus tidak mengubah kondisi aktual; menghapus PPI tidak membalik inflasi konsumen; satu konsep dihitung sekali; data mentah tidak dimutasi.\n\n';
  text+='Cakupan belum lengkap — pertumbuhan: '+(report.readiness.incomplete_growth.join(', ') || 'tidak ada')+'; inflasi: '+(report.readiness.incomplete_inflation.join(', ') || 'tidak ada')+'. Data kurang tidak dipaksakan menjadi arah.\n\n';
  text+='Belum diintegrasikan ke endpoint/tampilan produksi. Bank sentral, pandangan ekonom dan posisi pasar berasal dari snapshot pembanding; pemeriksaan ini bukan audit ulang ketiganya.\n';
  return text;
}

function main() {
  const arg=(name,fallback)=>process.argv.find(value=>value.startsWith('--'+name+'='))?.slice(name.length+3) || fallback;
  const rawDir=arg('raw-dir','.cache/macro-foundation-v2/raw');
  const baseline=JSON.parse(fs.readFileSync(arg('baseline','.cache/macro-foundation-v2/normalized.json'),'utf8'));
  const context=JSON.parse(fs.readFileSync(arg('context','.cache/macro-foundation-v2/live.json'),'utf8'));
  const asOfMs=Date.parse(arg('as-of',context.computed_at));
  if (!Number.isFinite(asOfMs)) throw Error('Invalid as-of');
  const snapshots=fs.readdirSync(rawDir).filter(file=>/^\d{4}-\d{2}\.json$/.test(file)).sort().map(file=>JSON.parse(fs.readFileSync(path.join(rawDir,file),'utf8')));
  const report=buildReview(snapshots,baseline,context.rows,asOfMs);
  const out=arg('out','.cache/macro-candidate-review');fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'review.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'review.md'),reviewMarkdown(report));
  console.log(JSON.stringify({as_of:report.as_of,observations:report.normalized_observations,comparison:report.comparison,verification:report.verification,readiness:report.readiness},null,2));
}
if (require.main===module) { try { main(); } catch(error) { console.error(error.message);process.exitCode=1; } }
module.exports={buildReview,reviewMarkdown};
