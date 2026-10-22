import './style.css';
import { createDownloadView } from './download-view.js';
import { registerSW } from 'virtual:pwa-register';
import { preparePhoto } from './image.js';
import { availableModels } from './model-storage.js';
import { friendlyError, resolvePrompt } from './core.js';
import { DEFAULT_MODEL, MODELS, getModel } from './models.js';
import { CATEGORIES, CATEGORY_PROMPT, runBatch } from './batch-core.js';
const $=id=>document.getElementById(id);
const downloads=createDownloadView($('file-downloads'));
let items=[],worker=null,pending=null,running=false,supported=false,cancelled=false,installPrompt;
let selectedModel=DEFAULT_MODEL;
let installed=[];
$('category-prompt').value=CATEGORY_PROMPT;
$('reset-prompt').onclick=()=>{if(!running)$('category-prompt').value=CATEGORY_PROMPT;};
function modelDetails(){const model=getModel(selectedModel);$('batch-model-details').textContent=`${model.download}. ${model.hint}`;}
modelDetails();
$('batch-model').onchange=()=>{
 const next=$('batch-model').value;
 if(running||!installed.includes(next)||!Object.hasOwn(MODELS,next)||getModel(next).family==='florence'){$('batch-model').value=selectedModel;return;}
 if(next===selectedModel)return;
 stopWorker();selectedModel=next;downloads.reset();$('download').hidden=true;modelDetails();render();status(`${getModel(selectedModel).label} selected. Completed categories are kept. Tap Categorize photos to continue.`);
};
const status=text=>{$('status').textContent=text;};
function render(){
 $('batch-model').disabled=running||!installed.length;$('category-prompt').disabled=running;$('reset-prompt').disabled=running;
 $('pick').disabled=running;$('clear').disabled=running||!items.length;$('start').disabled=running||!supported||!installed.includes(selectedModel)||!items.some(i=>i.state==='pending');$('start').textContent=items.some(i=>i.state==='done')?'Continue categorizing':'Categorize photos';
 $('cancel').hidden=!running;$('spinner').hidden=!running;$('retry').hidden=running||!items.some(i=>i.state==='error');$('reload').disabled=running;
 const finished=items.filter(i=>['done','review','error'].includes(i.state)).length;
 $('summary').textContent=items.length?`${finished} of ${items.length} processed · ${items.filter(i=>i.state==='done').length} categorized · ${items.filter(i=>['review','error'].includes(i.state)).length} need attention`:'No photos selected.';
 $('batch-progress').hidden=!items.length;$('batch-progress').max=items.length||1;$('batch-progress').value=finished;
 $('groups').replaceChildren();
 for(const category of [...CATEGORIES,'Needs attention','Waiting']){
  const members=items.filter(i=>category==='Waiting'?['pending','processing'].includes(i.state):category==='Needs attention'?['error','review'].includes(i.state):i.category===category&&i.state==='done');
  if(!members.length&&!CATEGORIES.includes(category))continue;
  const section=document.createElement('section');section.className='category-group';const title=document.createElement('h2');title.textContent=`${category} · ${members.length}`;section.append(title);
  const grid=document.createElement('div');grid.className='photo-grid';section.append(grid);
  if(!members.length){const empty=document.createElement('p');empty.className='small';empty.textContent='Photos in this category will appear here.';grid.append(empty);}
  for(const item of members){
   const card=document.createElement('article');card.className='photo-card';
   if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.file.name;img.loading='lazy';card.append(img);}
   const name=document.createElement('p');name.textContent=item.file.name;card.append(name);
   const state=document.createElement('p');state.className='small';state.textContent=item.state==='processing'?'Looking closely…':item.error||(item.state==='pending'?'Waiting':item.category);card.append(state);
   if(item.rawOutput!==undefined){const raw=document.createElement('pre');raw.className='raw-output';raw.textContent=item.rawOutput;const heading=document.createElement('p');heading.textContent='Raw model output';card.append(heading,raw);}
   const label=document.createElement('label');label.textContent='Category';const select=document.createElement('select');select.disabled=running;
   for(const value of ['',...CATEGORIES]){const option=document.createElement('option');option.value=value;option.textContent=value||'Choose category';select.append(option);}select.value=item.category||'';
   select.onchange=()=>{if(!select.value)return;item.category=select.value;item.state='done';item.error='';render();};label.append(select);card.append(label);grid.append(card);
  }
  $('groups').append(section);
 }
}
function stopWorker(){worker?.terminate();worker=null;if(pending){pending.reject(new Error('Stopped'));pending=null;}}
function request(type,extra={}){
 if(!worker){
  worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});const current=worker;
  worker.onmessage=({data})=>{
   if(worker!==current)return;
   if(data.type==='progress'){
    $('download').hidden=false;const p=data.progress;downloads.update(p);
    if(Number.isFinite(p.progress))$('download-progress').value=p.progress;else $('download-progress').removeAttribute('value');
    $('download-label').textContent=`${p.file?.split('/').at(-1)||'Model'} · ${Math.round((p.loaded||0)/1024/1024)} MB`;
   }
   if(data.type==='ready'){$('download').hidden=true;if(pending?.type==='load'){const p=pending;pending=null;p.resolve();}}
   if(data.type==='complete'&&pending){const p=pending;pending=null;p.resolve(data.text);}
   if(data.type==='error'){const p=pending;pending=null;stopWorker();p?.reject(new Error(friendlyError(data.message)));}
  };
  worker.onerror=event=>{event.preventDefault();const p=pending;pending=null;stopWorker();p?.reject(new Error(friendlyError(event.message||'AI worker failed. Try again.')));};
 }
 return new Promise((resolve,reject)=>{pending={type,resolve,reject};try{worker.postMessage({type,model:selectedModel,cachedOnly:true,...extra});}catch(error){pending=null;stopWorker();reject(error);}});
}
async function thumbnail(photo){
 const img=new Image();img.src=photo.url;await img.decode();const canvas=document.createElement('canvas');const scale=Math.min(1,180/photo.width,180/photo.height);canvas.width=Math.max(1,Math.round(photo.width*scale));canvas.height=Math.max(1,Math.round(photo.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.7);
}
$('pick').onclick=()=>$('photos').click();
$('photos').onchange=event=>{for(const file of event.target.files||[])items.push({file,state:'pending',category:null});event.target.value='';render();if(supported)status('Ready. Tap Categorize photos to start.');};
$('start').onclick=async()=>{
 if(running||!supported||!installed.includes(selectedModel))return;
 let prompt;try{prompt=resolvePrompt('custom',$('category-prompt').value);}catch(error){status(error.message);return;}
 running=true;cancelled=false;downloads.reset();render();status(`Preparing ${getModel(selectedModel).label}. Loading saved files into memory…`);
 navigator.storage?.persist?.().catch(()=>{});
 try{
  await request('load');
  if(cancelled)return;
  await runBatch(items,async item=>{
   status(`Processing ${items.indexOf(item)+1} of ${items.length}: ${item.file.name}`);
   const photo=await preparePhoto(item.file);if(cancelled)throw Error('Stopped');
   item.thumbnail=await thumbnail(photo);if(cancelled)throw Error('Stopped');render();
   return request('describe',{image:photo.url,prompt});
  },render,()=>cancelled);
  status(cancelled?'Stopped. Your completed categories are kept. Continue when ready.':'Finished. Review your categories below.');
 }catch(error){status(cancelled?'Stopped. Continue when ready.':friendlyError(error.message));}
 finally{running=false;$('download').hidden=true;render();}
};
$('cancel').onclick=()=>{cancelled=true;stopWorker();status('Stopping…');};
$('retry').onclick=()=>{for(const item of items)if(item.state==='error'){item.state='pending';item.error='';}render();$('start').click();};
$('clear').onclick=()=>{if(running)return;items=[];render();status('Choose photos to begin.');};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('pagehide',stopWorker);
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;}});$('reload').onclick=()=>{if(!running)updateSW(true);};
(async()=>{try{const adapter=await navigator.gpu?.requestAdapter();supported=!!adapter;installed=await availableModels(!!adapter?.features?.has('shader-f16'));}catch{}
 installed=installed.filter(key=>getModel(key).family!=='florence');$('batch-model').replaceChildren();for(const key of installed){const option=document.createElement('option');option.value=key;option.textContent=getModel(key).label;$('batch-model').append(option);}
 selectedModel=installed.includes(DEFAULT_MODEL)?DEFAULT_MODEL:installed[0]||DEFAULT_MODEL;$('batch-model').value=installed.length?selectedModel:'';$('no-models').hidden=!!installed.length;modelDetails();status(supported?'Choose photos to begin.':'WebGPU is unavailable. Open this HTTPS site in an updated compatible browser.');render();})();
