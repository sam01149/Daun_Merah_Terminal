'use strict';
const {sectionsFromHtml}=require('./_institution_sections');
// ABN AMRO permits attributed private use. Enabled for this user's explicitly
// confirmed personal dashboard; not a licence for commercial redistribution.
const INDEX_URL='https://www.abnamro.com/research/en/overview/our-research';
function safeUrl(value){try{const u=new URL(value,INDEX_URL);return u.origin==='https://www.abnamro.com'&&!u.username&&!u.password&&!u.search&&!u.hash
  &&/^\/research\/en\/our-research\/fx-weekly-[a-z0-9-]+$/.test(u.pathname)?u.href:null;}catch(_){return null;}}
function discover(html){return [...new Set([...String(html).matchAll(/href="(\/research\/en\/our-research\/fx-weekly-[a-z0-9-]+)"/g)].map(m=>safeUrl(m[1])).filter(Boolean))];}
function parseArticle(html,url,plain,nowMs=Date.now()){
  if(!safeUrl(url))throw Error('abn_url_invalid');
  const raw=String(html),data=JSON.parse(raw.match(/id="__NUXT_DATA__">([\s\S]*?)<\/script>/)?.[1]||'null');
  if(!Array.isArray(data))throw Error('abn_structure_changed');
  const slug=new URL(url).pathname.split('/').at(-1);
  const matches=data.filter(v=>v&&typeof v==='object'&&!Array.isArray(v)&&v.mainText&&v.enSlug&&data[v.enSlug]===slug);
  if(matches.length!==1)throw Error('abn_article_identity_changed');
  const a=matches[0],published=data[a.publicationDate],title=data[a.title];
  if(!Number.isFinite(published)||published>nowMs||nowMs-published>14*86400000||!/^FX Weekly - /i.test(title))throw Error('abn_date_or_title_invalid');
  const renderedTitle=plain(raw.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/)?.[1]);
  if(renderedTitle!==title||!raw.includes('ABN AMRO Bank N.V.'))throw Error('abn_rendered_identity_changed');
  const blocks=[...raw.matchAll(/<div[^>]*data-component-type="rich-text"[^>]*>([\s\S]*?)<\/div>/g)].map(m=>m[1]);
  const parts=blocks.map(plain);
  const text=plain(data[a.introduction])+' '+parts.join(' ');
  if(parts.length<2||text.length<500||text.length>40000)throw Error('abn_article_length_invalid');
  return {institution:'ABN AMRO',title,url,published_at:new Date(published).toISOString(),text,
    sections:sectionsFromHtml(blocks.join('\n'),plain)};
}
async function fetchLatest(get,plain,nowMs=Date.now()){
  const urls=discover(await get(INDEX_URL)).slice(0,3);
  if(!urls.length)throw Error('abn_weekly_not_found');
  const articles=[];
  for(const url of urls){try{articles.push(parseArticle(await get(url),url,plain,nowMs));}catch(error){if(!/abn_date_or_title_invalid/.test(error.message))throw error;}}
  articles.sort((a,b)=>Date.parse(b.published_at)-Date.parse(a.published_at));
  if(!articles.length)throw Error('abn_no_recent_weekly');
  return articles[0];
}
module.exports={INDEX_URL,safeUrl,discover,parseArticle,fetchLatest};
