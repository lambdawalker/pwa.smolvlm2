import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {t} from '../src/i18n.js';
for(const lineEnding of ['\n','\r\n'])test('language changes persist without reloading with '+JSON.stringify(lineEnding),()=>{
 let language='en';const text={textContent:'Settings',parentElement:{tagName:'H2',closest:()=>null}},selector={value:'en'},documentElement={lang:'en'};
 const source=readFileSync(new URL('../src/language-ui.js',import.meta.url),'utf8').replace(/\r?\n/g,lineEnding).replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'');
 const document={documentElement,body:{querySelectorAll:()=>[]},getElementById:()=>selector,createTreeWalker:()=>{let visited=false;return {nextNode:()=>visited?null:(visited=true,text)}}};
 vm.runInNewContext(source,{document,NodeFilter:{SHOW_TEXT:4},getLanguage:()=>language,t:word=>t(word,language),localStorage:{setItem:(key,value)=>language=value},location:{reload(){}},MutationObserver:class{observe(){}},queueMicrotask,window:{dispatchEvent(){}},Event});
 selector.value='es';selector.onchange();assert.equal(language,'es');assert.equal(text.textContent,'Configuración');assert.equal(documentElement.lang,'es');selector.value='en';selector.onchange();assert.equal(text.textContent,'Settings');assert.equal(documentElement.lang,'en');
});
