import {getLanguage,t} from './i18n.js';
function translate(root){
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode())){if(['SCRIPT','STYLE','TEXTAREA','PRE','OPTION'].includes(node.parentElement?.tagName)||node.parentElement?.closest('pre,textarea'))continue;const original=node.textContent;const trimmed=original.trim();const translated=t(trimmed);if(translated!==trimmed)node.textContent=original.replace(trimmed,translated);}
 for(const element of root.querySelectorAll?.('[title],[aria-label]')||[])for(const attr of ['title','aria-label'])if(element.hasAttribute(attr))element.setAttribute(attr,t(element.getAttribute(attr)));
 for(const option of root.querySelectorAll?.('option')||[]){const value=t(option.textContent);if(value!==option.textContent)option.textContent=value;}
}
document.documentElement.lang=getLanguage();
const selector=document.getElementById('language');if(selector){selector.value=getLanguage();selector.onchange=()=>{try{localStorage.setItem('audit-language',selector.value);}catch{}location.reload();};}
translate(document.body);
let queued=false;new MutationObserver(()=>{if(queued)return;queued=true;queueMicrotask(()=>{queued=false;translate(document.body);});}).observe(document.body,{childList:true,subtree:true,characterData:true});
