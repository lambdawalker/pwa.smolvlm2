import './handedness.js';
import { appendPhotoDetails } from './photo-details.js';
import './style.css';
import { CLOUD_MODEL, CLOUD_INFO, CLOUD_PRECISION, cloudAvailable, classifyCloud } from './cloud.js';
import { sha256, HASH_LABEL_LENGTH, precisionLabel, imageInfoLabel } from './input-info.js';
import { logEvent,installDiagnostics,watchOperation } from './diagnostics.js';
installDiagnostics();
import { createDownloadView } from './download-view.js';
import { registerSW } from 'virtual:pwa-register';
import { preparePhoto } from './image.js';
import { availableModels } from './model-storage.js';
import { friendlyError, resolvePrompt } from './core.js';
import { DEFAULT_MODEL, MODELS, getModel } from './models.js';
import { CATEGORIES, CATEGORY_PROMPT, runBatch } from './batch-core.js';
const $=id=>document.getElementById(id);
const downloads=createDownloadView($('file-downloads'));
let exporting=false,exportURL=null;
let items=[],worker=null,pending=null,running=false,supported=false,cancelled=false,installPrompt;
const readSetting=(key,fallback)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const saveSetting=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
let selectedModel=CLOUD_MODEL;
let installed=[],activeItem=null,precision=null,cloudEnabled=false,cloudController=null,batchPause='';
const isCloud=()=>selectedModel===CLOUD_MODEL;
const batchModel=key=>key===CLOUD_MODEL?CLOUD_INFO:getModel(key);
const canRun=()=>isCloud()?cloudEnabled&&$('cloud-consent').checked:supported&&installed.includes(selectedModel);
$('show-photo-details').checked=readSetting('lens-photo-details','false')==='true';
$('show-photo-details').onchange=()=>{saveSetting('lens-photo-details',String($('show-photo-details').checked));render();};
$('export-type').onchange=()=>{const word=$('export-type').value==='docx';$('export-icon-letter').textContent=word?'W':'P';$('export-document').setAttribute('aria-label',word?'Create Word document':'Create PowerPoint document');$('export-document').title=word?'Create Word document':'Create PowerPoint document';};
$('auto-categorize').checked=readSetting('lens-auto-categorize','true')==='true';
$('auto-categorize').onchange=()=>{saveSetting('lens-auto-categorize',String($('auto-categorize').checked));render();};
$('cloud-consent').checked=readSetting('lens-consent','true')==='true';
$('cloud-consent').onchange=()=>{saveSetting('lens-consent',String($('cloud-consent').checked));render();};
function showSection(){const settings=window.location?.hash==='#settings';$('section-title').textContent=settings?'Settings':'Categorize';$('settings-page').hidden=!settings;$('categorize-page').hidden=settings;document.querySelector?.('.hamburger')?.removeAttribute('open');}
window.addEventListener('hashchange',showSection);showSection();
function setView(view){$('groups').className='category-groups '+(view==='list'?'list-view':'');$('grid-view').setAttribute('aria-pressed',String(view!=='list'));$('list-view').setAttribute('aria-pressed',String(view==='list'));saveSetting('lens-view',view);}
$('grid-view').onclick=()=>setView('grid');$('list-view').onclick=()=>setView('list');setView(readSetting('lens-view','grid'));
$('category-prompt').value=readSetting('lens-category-prompt',CATEGORY_PROMPT);
$('category-prompt').onchange=()=>saveSetting('lens-category-prompt',$('category-prompt').value);
$('reset-prompt').onclick=()=>{if(!running){$('category-prompt').value=CATEGORY_PROMPT;saveSetting('lens-category-prompt',CATEGORY_PROMPT);}};
function modelDetails(){const model=batchModel(selectedModel);$('batch-model-details').textContent=`${model.download}. ${model.hint}`;$('cloud-notice').hidden=!isCloud();$('precision-label').textContent=isCloud()?CLOUD_PRECISION:precisionLabel(precision);}
modelDetails();
$('batch-model').onchange=()=>{
 const next=$('batch-model').value;
 if(running||(next===CLOUD_MODEL?!cloudEnabled:!installed.includes(next)||!Object.hasOwn(MODELS,next)||getModel(next).family==='florence')){$('batch-model').value=selectedModel;return;}
 if(next===selectedModel)return;
 stopWorker();precision=null;$('precision-label').textContent=precisionLabel(null);selectedModel=next;saveSetting('lens-model',next);downloads.reset();$('download').hidden=true;modelDetails();render();status(`${batchModel(selectedModel).label} selected. Completed categories are kept. Tap Categorize photos to continue.`);
};
const monitor=watchOperation(stage=>{logEvent('operation-slow',{stage});status(`Still waiting: ${stage}. You can stop and copy the troubleshooting report below.`);},stage=>{logEvent('operation-timeout',{stage});const p=pending;pending=null;stopWorker();p?.reject(new Error(`No progress for 3 minutes during ${stage}. Retry or copy the troubleshooting report.`));});
const status=(text,visible=false)=>{$('status').textContent=text;$('status').hidden=!visible;};
$('attention-count').onclick=()=>document.getElementById('needs-attention')?.scrollIntoView({behavior:'smooth',block:'start'});
function render(){
 const busy=running||exporting;
 $('export-document').disabled=exporting||busy||!items.some(item=>item.state==='done');
 $('cloud-consent').disabled=busy;$('batch-model').disabled=busy||(!installed.length&&!cloudEnabled);$('category-prompt').disabled=busy;$('reset-prompt').disabled=busy;
 $('pick').disabled=busy;$('clear').disabled=busy||!items.length;$('start').disabled=exporting||(!running&&(!canRun()||!items.some(i=>i.state==='pending')));$('brain-icon').hidden=running;$('stop-icon').hidden=!running;$('start').hidden=$('auto-categorize').checked&&!running&&!cancelled&&!batchPause;$('start').setAttribute('aria-label',running?'Stop':'Categorize');$('start').title=running?'Stop':'Categorize';$('auto-categorize').disabled=busy;
 $('cancel').hidden=true;$('spinner').hidden=!busy;$('retry').hidden=busy||!items.some(i=>i.state==='error');$('reload').disabled=busy;
 const finished=items.filter(i=>['done','review','error'].includes(i.state)).length;
 const attention=items.filter(i=>['review','error'].includes(i.state)).length;
 $('summary').textContent=`${finished} of ${items.length} processed | ${items.filter(i=>i.state==='done').length} categorized | `;
 $('attention-count').textContent=`${attention} need attention`;$('attention-count').disabled=attention===0;$('attention-count').className='attention-count'+(attention?' has-attention':'');

 $('batch-progress').hidden=!items.length;$('batch-progress').max=items.length||1;$('batch-progress').value=finished;
 $('groups').replaceChildren();
 for(const category of [...CATEGORIES,'Needs attention','Waiting']){
  const members=items.filter(i=>category==='Waiting'?['pending','processing'].includes(i.state):category==='Needs attention'?['error','review'].includes(i.state):i.category===category&&i.state==='done');
  if(!members.length)continue;
  const section=document.createElement('section');section.className='category-group';if(category==='Needs attention')section.id='needs-attention';const title=document.createElement('h2');title.textContent=`${category} · ${members.length}`;section.append(title);
  const grid=document.createElement('div');grid.className='photo-grid';section.append(grid);
  if(!members.length){const empty=document.createElement('p');empty.className='small';empty.textContent='Photos in this category will appear here.';grid.append(empty);}
  for(const item of members){
   const card=document.createElement('article');card.className='photo-card';
   const label=document.createElement('label');label.className='category-title';const select=document.createElement('select');select.disabled=busy;select.setAttribute('aria-label','Image category');
   for(const value of ['',...CATEGORIES]){const option=document.createElement('option');option.value=value;option.textContent=value||'Choose category';select.append(option);}select.value=item.category||'';
   select.onchange=()=>{if(!select.value)return;item.category=select.value;item.state='done';item.error='';render();};label.append(select);card.append(label);
   if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.description||'Selected photo';img.loading='lazy';card.append(img);}
   const state=document.createElement('p');state.className='small';state.textContent=item.state==='processing'?'Looking closely…':item.error||(item.state==='pending'?'Waiting':item.category);if(item.state!=='done')card.append(state);
   if(item.description){const description=document.createElement('p');description.className='card-description';description.textContent=item.description;card.append(description);}
   const details=document.createElement('details');details.className='card-details';const detailTitle=document.createElement('summary');detailTitle.textContent='Details';details.append(detailTitle);
   appendPhotoDetails(details,item,item.model?batchModel(item.model).label:'unknown',item.model===CLOUD_MODEL);
   details.hidden=!$('show-photo-details').checked;card.append(details);grid.append(card);

  }
  $('groups').append(section);
 }
}
function stopWorker(){cloudController?.abort();cloudController=null;monitor.stop();logEvent('worker-stopped');worker?.terminate();worker=null;if(pending){pending.reject(new Error('Stopped'));pending=null;}}
function request(type,extra={}){
 if(!worker){
  worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});const current=worker;
  worker.onmessage=({data})=>{
   if(worker!==current)return;
   if(data.type==='diagnostic'){if(data.phase==='precision'){precision=data.details.dtype;$('precision-label').textContent=precisionLabel(precision);}
   if(activeItem&&data.phase==='decoded image')activeItem.decodedHash=data.details.pixelHash;
   if(activeItem&&data.phase==='generating'){activeItem.tensors=data.details.tensors;logEvent('image-model-input',{index:items.indexOf(activeItem),...data.details});}
   logEvent('worker-stage',{phase:data.phase,...data.details});monitor.touch(data.phase);status(`Model: ${data.phase}…`);return;}
   monitor.touch();
   if(data.type==='progress'&&data.progress.status!=='progress')logEvent('file-status',{file:data.progress.file,status:data.progress.status});
   if(data.type==='progress'){
    $('download').hidden=false;const p=data.progress;downloads.update(p);
    if(Number.isFinite(p.progress))$('download-progress').value=p.progress;else $('download-progress').removeAttribute('value');
    $('download-label').textContent=`${p.file?.split('/').at(-1)||'Model'} · ${Math.round((p.loaded||0)/1024/1024)} MB`;
   }
   if(data.type==='ready'){$('download').hidden=true;if(pending?.type==='load'){const p=pending;pending=null;monitor.stop();p.resolve();}}
   if(data.type==='generating')status('Generating a category…');
   if(data.type==='token')status('Generating a category… receiving output.');
   if(data.type==='complete'&&pending){const p=pending;pending=null;monitor.stop();p.resolve(data.text);}
   if(data.type==='error'){const p=pending;pending=null;stopWorker();p?.reject(new Error(friendlyError(data.message)));}
  };
  worker.onmessageerror=()=>{const p=pending;pending=null;stopWorker();logEvent('worker-message-error');p?.reject(new Error('Could not decode the worker response. Reload and retry.'));};
  worker.onerror=event=>{event.preventDefault();logEvent('worker-error',{message:event.message});const p=pending;pending=null;stopWorker();p?.reject(new Error(friendlyError(event.message||'AI worker failed. Try again.')));};
 }
 return new Promise((resolve,reject)=>{pending={type,resolve,reject};monitor.touch(type==='load'?'loading cached model':'processing image');logEvent('worker-request',{type,model:selectedModel});try{worker.postMessage({type,model:selectedModel,cachedOnly:true,...extra});}catch(error){pending=null;stopWorker();reject(error);}});
}
async function thumbnail(photo){
 const img=new Image();img.src=photo.url;await img.decode();const canvas=document.createElement('canvas');const scale=Math.min(1,180/photo.width,180/photo.height);canvas.width=Math.max(1,Math.round(photo.width*scale));canvas.height=Math.max(1,Math.round(photo.height*scale));canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);return canvas.toDataURL('image/jpeg',.7);
}
$('pick').onclick=()=>$('photos').click();
$('photos').onchange=event=>{for(const file of event.target.files||[])items.push({file,state:'pending',category:null});event.target.value='';render();if($('auto-categorize').checked&&canRun())$('start').click();else if(!canRun())status('Check your model and consent in Settings.',true);else status('Ready. Tap Categorize to start.');};
$('start').onclick=async()=>{
 if(running){cancelled=true;stopWorker();status('Stopping…');return;}
 if(exporting||!canRun())return;
 let prompt;try{prompt=resolvePrompt('custom',$('category-prompt').value);}catch(error){status(error.message,true);return;}
 running=true;cancelled=false;batchPause='';downloads.reset();render();status(isCloud()?'Preparing cloud categorization…':`Preparing ${batchModel(selectedModel).label}. Loading saved files into memory…`);
 navigator.storage?.persist?.().catch(()=>{});
 try{
  if(!isCloud())await request('load');
  else {precision=null;logEvent('cloud-model',{model:'gemma-4-26b-a4b-it',precision:'provider-managed'});}
  if(cancelled)return;
  const promptHash=await sha256(prompt);$('prompt-id').textContent=`Prompt ID: ${promptHash.slice(0,HASH_LABEL_LENGTH)}`;logEvent('prompt-fingerprint',{sha256:promptHash,characters:prompt.length,model:selectedModel});
  if(cancelled)return;
  await runBatch(items,async item=>{
   activeItem=item;item.promptHash=promptHash;item.model=selectedModel;item.precision=precision;
   status(`Processing ${items.indexOf(item)+1} of ${items.length}`);
   logEvent('photo-prepare-start',{index:items.indexOf(item),bytes:item.file.size,mime:item.file.type});
   const photo=await preparePhoto(item.file,{centerCrop:true});
   item.info=photo.info;logEvent('photo-prepare-complete',{index:items.indexOf(item),...photo.info,width:photo.width,height:photo.height});if(cancelled)throw Error('Stopped');
   item.exportImage=photo.url;item.thumbnail=await thumbnail(photo);if(cancelled)throw Error('Stopped');render();
   if(!isCloud())return request('describe',{image:photo.url,prompt});
   cloudController=new AbortController();const controller=cloudController;
   const timeout=setTimeout(()=>controller.abort(),30000);
   logEvent('cloud-request',{model:'gemma-4-26b-a4b-it',index:items.indexOf(item),preparedHash:photo.info?.preparedHash,promptHash});
   try{const answer=await classifyCloud(photo.url,prompt,controller.signal);logEvent('cloud-complete',{index:items.indexOf(item)});return answer;}
   catch(error){
    logEvent('cloud-error',{status:error.status||0,code:error.code,providerStatus:error.providerStatus,finishReason:error.finishReason,cancelled});
    if(!cancelled){batchPause=error.name==='AbortError'?'Cloud request timed out. Retry failed photos or continue later.':error.message;const failure=new Error(batchPause);failure.pauseBatch=true;throw failure;}
    throw error;
   }finally{clearTimeout(timeout);if(cloudController===controller)cloudController=null;}

  },render,()=>cancelled);
  status(batchPause|| (cancelled?'Stopped. Your completed categories are kept. Continue when ready.':'Finished. Review your categories below.'),!!batchPause);
 }catch(error){status(cancelled?'Stopped. Continue when ready.':friendlyError(error.message),!cancelled);}
 finally{activeItem=null;running=false;$('download').hidden=true;render();}
};
$('cancel').onclick=()=>{cancelled=true;stopWorker();status('Stopping…');};
$('retry').onclick=()=>{for(const item of items)if(item.state==='error'){item.state='pending';item.error='';}render();$('start').click();};
$('clear').onclick=()=>{if(running)return;items=[];render();status('Choose photos to begin.');};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('pagehide',stopWorker);
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;}});$('reload').onclick=()=>{if(!running)updateSW(true);};
(async()=>{try{const adapter=await navigator.gpu?.requestAdapter();supported=!!adapter;logEvent('adapter-check',{supported,fp16:!!adapter?.features?.has('shader-f16')});installed=await availableModels(!!adapter?.features?.has('shader-f16'));}catch{}
 cloudEnabled=await cloudAvailable();logEvent('cloud-availability',{enabled:cloudEnabled});
 logEvent('cached-models',{installed});
 installed=installed.filter(key=>getModel(key).family!=='florence');$('batch-model').replaceChildren();for(const key of installed){const option=document.createElement('option');option.value=key;option.textContent=getModel(key).label;$('batch-model').append(option);}
 if(cloudEnabled){const option=document.createElement('option');option.value=CLOUD_MODEL;option.textContent=CLOUD_INFO.label;$('batch-model').append(option);}
 const saved=readSetting('lens-model',CLOUD_MODEL);selectedModel=saved===CLOUD_MODEL&&cloudEnabled?CLOUD_MODEL:supported&&installed.includes(saved)?saved:cloudEnabled?CLOUD_MODEL:installed[0]||DEFAULT_MODEL;$('batch-model').value=installed.length||cloudEnabled?selectedModel:'';$('no-models').hidden=!!installed.length||cloudEnabled;modelDetails();status(cloudEnabled||supported?'Choose photos to begin.':'WebGPU is unavailable and cloud mode is not configured.');render();})();

$('export-document').onclick=async()=>{
 if(exporting||running)return;
 exporting=true;render();$('export-status').textContent='Creating document…';
 try{
  const type=$('export-type').value;
  const options={type,imageSize:$('export-size').value,columns:$('export-columns').value,layout:$('export-layout').value,showDescription:$('export-description').checked,orientation:$('export-orientation').value};
  const {createDocument}=await import('./export-document.js');
  const blob=await createDocument(items,options);
  if(exportURL)URL.revokeObjectURL(exportURL);
  exportURL=URL.createObjectURL(blob);const link=document.createElement('a');link.href=exportURL;link.download=`audit-${new Date().toISOString().slice(0,10)}.${type}`;document.body.append(link);link.click();link.remove();
  const createdURL=exportURL;setTimeout(()=>{URL.revokeObjectURL(createdURL);if(exportURL===createdURL)exportURL=null;},60000);
  $('export-status').textContent='Document created. Download started.';
 }catch(error){$('export-status').textContent=error.message||'Could not create the document. Try fewer photos.';}
 finally{exporting=false;render();}
};
