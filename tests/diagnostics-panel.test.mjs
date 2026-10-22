import { defaults } from '../src/defaults.generated.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
test('troubleshooting is hidden by default and controlled by the settings toggle',()=>{
 const node=()=>({children:[],append(...items){this.children.push(...items)},setAttribute(){}});
 const slot=node(),toggle=node(),values=new Map();
 const source=readFileSync(new URL('../src/diagnostics.js',import.meta.url),'utf8').replace(/^import .*;$/gm,'').replaceAll('export ','');
 const context=vm.createContext({defaults,document:{createElement:node,getElementById:id=>id==='diagnostics-slot'?slot:toggle},localStorage:{getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)},location:{pathname:'/'},navigator:{userAgent:'test'},window:{addEventListener(){}},console:{info(){}}});
 vm.runInContext(source+'\ninstallDiagnostics();',context);
 assert.equal(slot.children[0].hidden,true);assert.equal(toggle.checked,false);
 toggle.checked=true;toggle.onchange();assert.equal(slot.children[0].hidden,false);assert.equal(values.get('lens-diagnostics'),'true');
 toggle.checked=false;toggle.onchange();assert.equal(slot.children[0].hidden,true);
});
