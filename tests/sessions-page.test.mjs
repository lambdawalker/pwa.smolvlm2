import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {deleteSharedSession} from '../src/session-sync.js';
const prepareSource=text=>text.replace(/\r\n/g,'\n').replace(/^import .*;\n/gm,'').replace('export async function','async function').replace("if(typeof document!=='undefined')startSessionsPage({document,location});",'globalThis.start=startSessionsPage;');
const rawSource=readFileSync(new URL('../src/sessions-page.js',import.meta.url),'utf8');
const source=prepareSource(rawSource);
for(const ending of ['\n','\r\n'])test('session harness supports '+JSON.stringify(ending),()=>{const context={};vm.runInNewContext(prepareSource(rawSource.replace(/\r\n/g,'\n').replace(/\n/g,ending)),context);assert.equal(typeof context.start,'function');});
const submit={preventDefault(){}};
async function app({enabled=true,loggedIn=true}={}){
 const element=()=>({children:[],value:'',append(...items){this.children.push(...items)},replaceChildren(){this.children=[]},setAttribute(k,v){this[k]=v},removeAttribute(k){delete this[k]},showModal(){this.open=true},close(){this.open=false},focus(){}});
 const html=readFileSync(new URL('../sessions.html',import.meta.url),'utf8');const elements=Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(([,id])=>[id,element()]));
 const sessions=[{id:'a',name:'Site visit',created:'2026-10-29T00:00:00Z',revision:1}];const calls=[];let refresh,redirect;
 const api=async(path='',method='GET',body)=>{calls.push({path,method,body});if(method==='GET')return {sessions:sessions.map(s=>({...s}))};if(method==='POST'){sessions.push({id:'b',name:body.name,created:'2026-10-30T00:00:00Z',revision:1});return sessions.at(-1)}const session=sessions.find(s=>path==='/'+s.id);if(method==='PATCH'){assert.equal(body.revision,session.revision);session.name=body.name;session.revision++;return session}if(method==='DELETE'){sessions.splice(sessions.indexOf(session),1);return {deleted:true}};};
 const context={deleteSharedSession,t:v=>v,getLanguage:()=> 'en'};vm.runInNewContext(source,context);
 await context.start({document:{getElementById:id=>elements[id],createElement:element},location:{replace:value=>{redirect=value}},api,config:async()=>({enabled}),account:()=>loggedIn?{}:null,logout(){},interval:handler=>{refresh=handler},onFocus(){}});
 return {e:elements,sessions,calls,refresh,redirect};
}
test('sessions page creates, renames and opens sessions; delete requires confirmation',async()=>{
 const {e,sessions,calls}=await app();assert.equal(e['session-list'].children.length,1);
 const actions=()=>e['session-list'].children[0].children[1].children;
 assert.equal(actions()[0].href,'./?session=a');actions()[1].onclick();assert.equal(e['rename-session-dialog'].open,true);e['rename-session-name'].value='Renamed visit';await e['rename-session-form'].onsubmit(submit);assert.equal(sessions[0].name,'Renamed visit');assert.equal(sessions[0].revision,2);
 e['create-session-name'].value='Laptop photos';await e['create-session-form'].onsubmit(submit);assert.equal(sessions.length,2);assert.equal(e['create-session-name'].value,'');assert.equal(e['session-list'].children.length,2);
 actions()[2].onclick();assert.equal(e['delete-session-dialog'].open,true);assert.equal(calls.filter(c=>c.method==='DELETE').length,0);e['cancel-delete-session'].onclick();assert.equal(sessions.length,2);
 actions()[2].onclick();await e['confirm-delete-session'].onclick();assert.equal(sessions.length,1);assert.equal(e['delete-session-dialog'].open,false);
});
test('sessions page redirects anonymous users and disables management without account service',async()=>{
 assert.equal((await app({loggedIn:false})).redirect,'./login.html');const {e,calls}=await app({enabled:false});assert.equal(e['create-session'].disabled,true);assert.equal(calls.length,0);assert.match(e['sessions-status'].textContent,/require the AWS/);
});
test('deleted sessions disappear on refresh, interrupted deletion offers retry',async()=>{
 const {e,sessions,refresh}=await app();sessions[0].deleting=true;await refresh();const actions=e['session-list'].children[0].children[1].children;assert.equal(actions[0].href,undefined);assert.equal(actions[1].disabled,true);assert.equal(actions[2].textContent,'Retry deletion');sessions.length=0;await refresh();assert.equal(e['session-list'].children.length,0);assert.equal(e['no-sessions'].hidden,false);
});
test('session deletion continues cleanup batches and tolerates deletion from another device',async()=>{
 let calls=0;await deleteSharedSession('id',async()=>++calls===1?{deleting:true}:{deleted:true});assert.equal(calls,2);
 await deleteSharedSession('id',async()=>{const error=Error('not found');error.status=404;throw error});
 await assert.rejects(deleteSharedSession('id',async()=>({})),/invalid response/);
});
