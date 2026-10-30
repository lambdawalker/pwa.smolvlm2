import {getLanguage,t} from './i18n.js';
// Remember original text so switching language can be undone without a reload.
const originals=new WeakMap();
function translatedValue(node,key,current){
 let fields=originals.get(node);if(!fields){fields=new Map();originals.set(node,fields);}
 let record=fields.get(key);if(!record||record.rendered!==current)record={source:current,rendered:current};
 const trimmed=record.source.trim(),translated=t(trimmed);
 record.rendered=record.source.replace(trimmed,translated);fields.set(key,record);return record.rendered;
}
function translate(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode())){
  if(['SCRIPT','STYLE','TEXTAREA','PRE','OPTION'].includes(node.parentElement?.tagName)||node.parentElement?.closest('pre,textarea'))continue;
  const value=translatedValue(node,'text',node.textContent);if(value!==node.textContent)node.textContent=value;
 }
 for(const element of root.querySelectorAll?.('[title],[aria-label]')||[])for(const attr of ['title','aria-label'])if(element.hasAttribute(attr)){
  const current=element.getAttribute(attr),value=translatedValue(element,attr,current);if(value!==current)element.setAttribute(attr,value);
 }
 for(const option of root.querySelectorAll?.('option')||[]){const value=translatedValue(option,'text',option.textContent);if(value!==option.textContent)option.textContent=value;}
}
function applyLanguage(){document.documentElement.lang=getLanguage();translate(document.body);}
const selector=document.getElementById('language');
if(selector){selector.value=getLanguage();selector.onchange=()=>{try{localStorage.setItem('audit-language',selector.value);}catch{}applyLanguage();window.dispatchEvent(new Event('audit-language-change'));};}
applyLanguage();
let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;translate(document.body);});}).observe(document.body,{childList:true,subtree:true,characterData:true});
