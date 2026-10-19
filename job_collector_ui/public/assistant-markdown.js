import {Marked} from './vendor/marked.esm.js';
import createDOMPurify from './vendor/purify.es.js';
import {addCodeActions} from './assistant-message-actions.js';

const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const markdown=new Marked({gfm:true,breaks:true,async:false,renderer:{
  // Raw HTML is data, not instructions to the browser. Do not load model images.
  html({text}){return escapeHtml(text);},
  image({text}){return escapeHtml(text||'图片');},
}});
const purifier=createDOMPurify(globalThis.window);
const allowedTags=['p','br','h1','h2','h3','h4','h5','h6','ul','ol','li','strong','em','del','blockquote','pre','code','hr','table','thead','tbody','tfoot','tr','th','td','a'];

export function renderAssistantMarkdown(value){
  const text=String(value??'').slice(0,100000);
  // Fail closed if a browser cannot initialize the sanitizer or parser.
  try{
    if(typeof purifier.sanitize!=='function')throw new Error('Sanitizer unavailable');
    return purifier.sanitize(markdown.parse(text),{
      ALLOWED_TAGS:allowedTags,ALLOWED_ATTR:['href','title','start','align'],
      ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,
      ALLOWED_URI_REGEXP:/^(?:https?:\/\/|#)/i,
    });
  }catch{return `<p>${escapeHtml(text).replaceAll('\n','<br>')}</p>`;}
}

export const sourceAnchorId=(prefix,index)=>`${String(prefix).replace(/[^a-zA-Z0-9_-]/g,'')}-source-${index+1}`;

export function setAssistantMarkdown(root,value,sources=[],prefix='assistant-answer'){
  root.classList.add('assistant-markdown');
  root.innerHTML=renderAssistantMarkdown(value);
  const doc=root.ownerDocument;
  for(const link of root.querySelectorAll('a')){
    const href=link.getAttribute('href')||'';
    if(href.startsWith('#'))continue;
    let url;try{url=new URL(href);}catch{}
    if(!url||!['http:','https:'].includes(url.protocol)){link.replaceWith(...link.childNodes);continue;}
    link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';
  }
  for(const table of root.querySelectorAll('table')){
    const wrapper=doc.createElement('div');wrapper.className='assistant-markdown-table';
    wrapper.tabIndex=0;wrapper.setAttribute('role','region');wrapper.setAttribute('aria-label','回答数据表，可横向滚动');
    table.before(wrapper);wrapper.append(table);
  }
  const citations=new Map(sources.map((source,index)=>[source.citation,{source,index}]));
  const walker=doc.createTreeWalker(root,4),textNodes=[];
  while(walker.nextNode())if(!walker.currentNode.parentElement.closest('pre,code,a'))textNodes.push(walker.currentNode);
  for(const node of textNodes){
    const matches=[...node.textContent.matchAll(/\[((?:K[a-f0-9]{24})|(?:J\d+))\]/g)];
    if(!matches.some(match=>citations.has(match[1])))continue;
    const fragment=doc.createDocumentFragment();let offset=0;
    for(const match of matches){
      const citation=citations.get(match[1]);if(!citation)continue;
      fragment.append(doc.createTextNode(node.textContent.slice(offset,match.index)));
      const link=doc.createElement('a');link.className='assistant-citation';link.href='#'+sourceAnchorId(prefix,citation.index);
      link.textContent=`[${citation.index+1}]`;link.title=citation.source.title||'查看岗位证据';
      link.setAttribute('aria-label',`查看岗位证据 ${citation.index+1}：${citation.source.title||''}`);
      fragment.append(link);offset=match.index+match[0].length;
    }
    fragment.append(doc.createTextNode(node.textContent.slice(offset)));node.replaceWith(fragment);
  }
  addCodeActions(root,{notify:text=>{const status=doc.querySelector('#assistantNotice');if(status)status.textContent=text;}});
  return root;
}
