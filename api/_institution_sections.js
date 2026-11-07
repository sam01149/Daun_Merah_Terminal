'use strict';

// Keep the scope of time evidence: another currency section or a separate
// calendar cannot lend its horizon to a directional statement.
function sectionsFromHtml(html,plain){
  const sections=[];let title='',parts=[];
  const flush=()=>{const text=parts.filter(Boolean).join(' ');if(text)sections.push({id:'s'+sections.length,title,text});parts=[];};
  const tokens=[...String(html).matchAll(/<(h[2-4]|p)\b[^>]*>([\s\S]*?)<\/\1>/gi)];
  for(const token of tokens){const text=plain(token[2]);if(/^h/i.test(token[1])){flush();title=text;}else if(text)parts.push(text);}
  flush();
  return sections.length?sections:[{id:'s0',title:'',text:plain(html)}];
}
module.exports={sectionsFromHtml};
