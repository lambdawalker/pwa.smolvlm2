import {authConfig, credentials, signOut} from './account.js';
import {sessionAPI,uploadPhoto,savePhoto,mergePhotos} from './session-sync.js';
import { defaults } from './defaults.generated.js';
import './language-ui.js';
import { getLanguage, languagePrompt, t } from './i18n.js';
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
import { CATEGORIES, CATEGORY_PROMPT, runBatch, parseResult } from './batch-core.js';
const $=id=>document.getElementById(id);
let originalURL=null;
function closeOriginal(){if(originalURL){URL.revokeObjectURL(originalURL);originalURL=null;}$('original-image').removeAttribute('src');}
$('close-original').onclick=()=>$('original-viewer').close();
$('original-viewer').addEventListener('close',closeOriginal);
$('original-viewer').onclick=event=>{if(event.target===$('original-viewer'))$('original-viewer').close();};
async function openOriginal(item){closeOriginal();try{const file=item.originalUrl?await (async()=>{const r=await fetch(item.originalUrl,{cache:'no-store'});if(!r.ok)throw Error('Could not load original photo.');return r.blob();})():item.file;originalURL=URL.createObjectURL(file);$('original-image').src=originalURL;$('original-image').alt=item.description||'Original photo';$('original-viewer').showModal();}catch(e){status(e.message,true);}}
window.addEventListener('pagehide',closeOriginal);
const downloads=createDownloadView($('file-downloads'));
let exporting=false,exportURL=null;
let pickerOpen=false;
let shared=false,sessionId=null,syncBusy=false,syncing=false,syncSessionChoices=()=>{},accountReady=typeof authConfig!=='function';
let items=[],worker=null,pending=null,running=false,supported=false,cancelled=false,installPrompt;
const readSetting=(key,fallback)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const saveSetting=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
let selectedModel=defaults.interface.model;
let installed=[],activeItem=null,precision=null,cloudEnabled=false,cloudControllers=new Set(),batchPause='';
const isCloud=()=>selectedModel===CLOUD_MODEL;
const batchModel=key=>key===CLOUD_MODEL?CLOUD_INFO:getModel(key);
const canRun=()=>accountReady&&(!shared||!!sessionId)&&(isCloud()?cloudEnabled&&$('cloud-consent').checked:supported&&installed.includes(selectedModel));
$('show-photo-details').checked=readSetting('lens-photo-details',String(defaults.interface.showImageDetails))==='true';
$('show-photo-details').onchange=()=>{saveSetting('lens-photo-details',String($('show-photo-details').checked));render();};
$('export-type').value=defaults.document.type;
$('export-orientation').value=defaults.document.orientation;
$('export-rows').value=String(defaults.document.rows);
$('export-columns').value=String(defaults.document.columns);
$('export-layout').value=defaults.document.layout;
$('export-description').checked=defaults.document.addDescription;
function updateExportType(){const word=$('export-type').value==='docx';$('export-icon-letter').textContent=word?'W':'P';$('export-document').setAttribute('aria-label',word?'Create Word document':'Create PowerPoint document');$('export-document').title=word?'Create Word document':'Create PowerPoint document';$('export-layout-field').hidden=false;const previous=$('export-layout').value;$('export-layout').replaceChildren();for(const value of (word?['table']:['table','cards'])){const option=document.createElement('option');option.value=value;option.textContent=value==='cards'?'Cards':'Table';$('export-layout').append(option);}$('export-layout').value=word?'table':previous||'table';}
$('export-type').onchange=updateExportType;updateExportType();
$('auto-categorize').checked=readSetting('lens-auto-categorize',String(defaults.interface.autoCategorize))==='true';
$('auto-categorize').onchange=()=>{saveSetting('lens-auto-categorize',String($('auto-categorize').checked));render();};
$('cloud-consent').checked=readSetting('lens-consent',String(defaults.interface.cloudConsent))==='true';
$('cloud-consent').onchange=()=>{saveSetting('lens-consent',String($('cloud-consent').checked));render();};
function setDocumentPanel(open){
 $('document-settings-panel').hidden=!open;$('document-settings').setAttribute('aria-expanded',String(open));
 if(open)$('export-type').focus?.();
}
$('document-settings').onclick=()=>setDocumentPanel($('document-settings-panel').hidden);
$('close-document-settings').onclick=()=>{setDocumentPanel(false);$('document-settings').focus?.();};
window.addEventListener('keydown',event=>{if(event.key==='Escape'&&!$('document-settings-panel').hidden){setDocumentPanel(false);$('document-settings').focus?.();}});
window.addEventListener('click',event=>{if(!$('document-settings-panel').hidden&&!$('document-settings-panel').contains(event.target)&&!$('document-settings').contains(event.target))setDocumentPanel(false);});
function showSection(){const settings=window.location?.hash==='#settings';if(settings)setDocumentPanel(false);$('section-title').textContent=settings?'Settings':'Categorize';$('settings-page').hidden=!settings;$('categorize-page').hidden=settings;document.querySelector?.('.hamburger')?.removeAttribute('open');}
window.addEventListener('hashchange',showSection);showSection();
let currentView='grid',activeCategory=null,categoryPages=[];
const mobileCategories=()=>window.matchMedia?.('(max-width: 700px)').matches??false;
function syncCategorySelection(){
 for(const page of categoryPages){const active=page.category===activeCategory;page.section.className='category-group'+(active?' active-category':'');page.tab.setAttribute('aria-selected',String(active));page.tab.tabIndex=active?0:-1;}
}
function selectCategory(category,smooth=true,direction=1){
 const index=categoryPages.findIndex(page=>page.category===category);if(index<0)return;
 const changed=activeCategory!==category;activeCategory=category;syncCategorySelection();
 if(changed&&smooth&&mobileCategories())categoryPages[index].section.className+=' '+(direction<0?'category-enter-left':'category-enter-right');
}
function hideIcon(id,hidden){const icon=$(id);icon.hidden=hidden;if(hidden)icon.setAttribute('hidden','');else icon.removeAttribute('hidden');}
$('image-concurrency').value=readSetting('audit-concurrency',String(defaults.interface.simultaneousImages));
$('image-concurrency').onchange=()=>saveSetting('audit-concurrency',$('image-concurrency').value);
function moveCategory(direction,from=activeCategory){const index=categoryPages.findIndex(page=>page.category===from);if(categoryPages.length)selectCategory(categoryPages[(index+direction+categoryPages.length)%categoryPages.length].category,true,direction);}
let swipe=null;
$('categorize-page').addEventListener('touchstart',event=>{if(!mobileCategories()||event.touches.length!==1||event.target.closest?.('button,input,select,textarea,a,dialog,#action-bar,#document-settings-panel')){swipe=null;return;}swipe={x:event.touches[0].clientX,y:event.touches[0].clientY,category:activeCategory};},{passive:true});
$('categorize-page').addEventListener('touchend',event=>{if(!swipe)return;const start=swipe;swipe=null;const touch=event.changedTouches[0];if(!touch)return;const dx=touch.clientX-start.x,dy=touch.clientY-start.y;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3)moveCategory(dx<0?1:-1,start.category);},{passive:true});
$('categorize-page').addEventListener('touchcancel',()=>{swipe=null;},{passive:true});
function setView(view){currentView=view;$('groups').className='category-groups '+(view==='list'?'list-view':'');hideIcon('list-view-icon',view==='list');hideIcon('grid-view-icon',view!=='list');$('view-toggle').setAttribute('aria-label',view==='list'?'Switch to grid view':'Switch to list view');$('view-toggle').title=view==='list'?'Switch to grid view':'Switch to list view';saveSetting('lens-view',view);}
$('view-toggle').onclick=()=>setView(currentView==='grid'?'list':'grid');setView(readSetting('lens-view',defaults.interface.view));
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
$('attention-count').onclick=()=>{selectCategory('Needs attention');document.getElementById('needs-attention')?.scrollIntoView({behavior:'smooth',block:'start',inline:'nearest'});};
function render(){
 const busy=running||exporting||syncBusy||syncing;
 if($('session-select'))$('session-select').disabled=busy;
 if($('new-session'))$('new-session').disabled=busy;$('image-concurrency').disabled=busy;
 $('export-document').disabled=exporting||busy||!items.some(item=>item.state==='done');
 $('cloud-consent').disabled=busy;$('batch-model').disabled=busy||(!installed.length&&!cloudEnabled);$('category-prompt').disabled=busy;$('reset-prompt').disabled=busy;
 $('pick').disabled=!accountReady||(shared&&!sessionId)||exporting||syncBusy||syncing;hideIcon('upload-icon',running);hideIcon('cancel-brain-icon',!running);$('pick').className='icon-button '+(running?'cancel-floating':'primary');$('pick').setAttribute('aria-label',t(running?'Cancel categorization':'Add photos'));$('pick').title=t(running?'Cancel categorization':'Add photos');$('clear').disabled=busy||!items.length;$('start').disabled=exporting||(!running&&(!canRun()||!items.some(i=>i.state==='pending')));hideIcon('brain-icon',running);hideIcon('stop-icon',!running);$('start').hidden=running||($('auto-categorize').checked&&!cancelled&&!batchPause);$('start').setAttribute('aria-label',running?'Stop':'Categorize');$('start').title=running?'Cancel categorization':'Categorize';$('start').className='icon-button '+(running?'cancel-floating':'primary');$('auto-categorize').disabled=busy;
 $('cancel').hidden=true;$('spinner').hidden=!busy;$('retry').hidden=busy||!items.some(i=>i.state==='error');$('reload').disabled=busy;
 const finished=items.filter(i=>['done','review','error'].includes(i.state)).length;
 const attention=items.filter(i=>['review','error'].includes(i.state)).length;
 $('summary').textContent=`${finished} of ${items.length} processed | ${items.filter(i=>i.state==='done').length} categorized | `;
 $('attention-count').textContent=`${attention} need attention`;$('attention-count').disabled=attention===0;$('attention-count').className='attention-count'+(attention?' has-attention':'');

 $('batch-progress').hidden=!items.length;$('batch-progress').max=items.length||1;$('batch-progress').value=finished;
 $('groups').replaceChildren();$('category-tabs').replaceChildren();categoryPages=[];
 for(const category of [...CATEGORIES,'Needs attention','Waiting']){
  const members=items.filter(i=>category==='Waiting'?['pending','processing'].includes(i.state):category==='Needs attention'?['error','review'].includes(i.state):i.category===category&&i.state==='done');
  if(!members.length)continue;
  const section=document.createElement('section');section.className='category-group';if(category==='Needs attention')section.id='needs-attention';const title=document.createElement('h2');title.textContent=`${category} · ${members.length}`;section.append(title);
  const pageId='category-page-'+categoryPages.length;section.id=category==='Needs attention'?'needs-attention':pageId;section.setAttribute('role','tabpanel');section.setAttribute('aria-label',category);
  const tab=document.createElement('button');tab.textContent=`${category} · ${members.length}`;tab.setAttribute('role','tab');tab.setAttribute('aria-controls',section.id);tab.onclick=()=>selectCategory(category);
  tab.onkeydown=event=>{const index=categoryPages.findIndex(page=>page.category===category);let next=index;if(event.key==='ArrowRight')next=(index+1)%categoryPages.length;else if(event.key==='ArrowLeft')next=(index+categoryPages.length-1)%categoryPages.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=categoryPages.length-1;else return;event.preventDefault();selectCategory(categoryPages[next].category);categoryPages[next].tab.focus?.();};
  $('category-tabs').append(tab);categoryPages.push({category,section,tab});


  const grid=document.createElement('div');grid.className='photo-grid';section.append(grid);
  if(!members.length){const empty=document.createElement('p');empty.className='small';empty.textContent='Photos in this category will appear here.';grid.append(empty);}
  for(const item of members){
   const card=document.createElement('article');card.className='photo-card';
   const remove=document.createElement('button');remove.className='icon-button remove-photo';remove.disabled=busy;remove.setAttribute('aria-label','Remove image');remove.title='Remove image';remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';remove.onclick=()=>mutateSession(async()=>{if(item.remoteId)await sessionAPI(`/${sessionId}/photos/${item.remoteId}`,'DELETE');items=items.filter(candidate=>candidate!==item);});card.append(remove);
   const label=document.createElement('label');label.className='category-title';const select=document.createElement('select');select.disabled=busy;select.setAttribute('aria-label','Image category');
   for(const value of ['',...CATEGORIES]){const option=document.createElement('option');option.value=value;option.textContent=value||'Choose category';select.append(option);}select.value=item.category||'';
   select.onchange=()=>{if(!select.value)return;const category=select.value;return mutateSession(async()=>{if(item.remoteId)await savePhoto(sessionId,item,{category,state:'done'});item.category=category;item.state='done';item.error='';});};label.append(select);card.append(label);
   if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.description||'Selected photo';img.loading='lazy';img.className='open-original';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Open original photo');img.onclick=()=>openOriginal(item);img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openOriginal(item);}};card.append(img);}
   const state=document.createElement('p');state.className='small';state.textContent=item.state==='processing'?'Looking closely…':item.error||(item.state==='pending'?'Waiting':item.category);if(item.state!=='done')card.append(state);
   if(item.description){const description=document.createElement('p');description.className='card-description';description.textContent=item.description;card.append(description);}
   const details=document.createElement('details');details.className='card-details';const detailTitle=document.createElement('summary');detailTitle.textContent='Details';details.append(detailTitle);
   appendPhotoDetails(details,item,item.model?batchModel(item.model).label:'unknown',item.model===CLOUD_MODEL);
   details.hidden=!$('show-photo-details').checked;card.append(details);grid.append(card);

  }
  $('groups').append(section);
 }
 if(!categoryPages.some(page=>page.category===activeCategory))activeCategory=categoryPages[0]?.category??null;
 selectCategory(activeCategory,false);
 $('category-tabs').hidden=!categoryPages.length;
}
function stopWorker(){for(const controller of cloudControllers)controller.abort();cloudControllers.clear();monitor.stop();logEvent('worker-stopped');worker?.terminate();worker=null;if(pending){pending.reject(new Error('Stopped'));pending=null;}}
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
$('pick').onclick=()=>{if(!accountReady||(shared&&!sessionId)||syncBusy||syncing||exporting)return;if(running){cancelled=true;stopWorker();status('Stopping…');return;}if(!exporting){pickerOpen=true;$('photos').click();}};
$('photos').addEventListener('cancel',()=>{pickerOpen=false;});
$('photos').onchange=async event=>{
 pickerOpen=false;
 if(!accountReady||(shared&&!sessionId)||syncBusy||syncing||exporting||running)return;
 const files=[...event.target.files];event.target.value='';
 if(shared){await mutateSession(async()=>{for(const file of files){status('Uploading photos…',true);logEvent('photo-upload-start',{bytes:file.size,mime:file.type});const photo=await preparePhoto(file,{centerCrop:true});const saved=await uploadPhoto(sessionId,file,photo);logEvent('photo-upload-complete',{id:saved.id});items.push({file,state:'pending',remoteId:saved.id,revision:saved.revision,exportImage:photo.url,thumbnail:photo.url,info:photo.info});render();}});}
 else for(const file of files)items.push({file,state:'pending'});
 cancelled=false;render();if($('auto-categorize').checked&&canRun())$('start').click();
};
async function mutateSession(action){if(running||exporting||syncBusy||syncing)return;syncBusy=true;render();try{await action();}catch(e){logEvent('session-operation-error',{message:e.message,status:e.status||0});status(e.message,true);}finally{syncBusy=false;render();}}
async function persistAnswer(item,answer){if(item.remoteId){const parsed=parseResult(answer);await savePhoto(sessionId,item,{state:parsed?'done':'review',category:parsed?.category||'',description:parsed?.description||'',rawOutput:String(answer).slice(0,8192)});}return answer;}
$('start').onclick=async()=>{
 if(running){cancelled=true;stopWorker();status('Stopping…');return;}
 if(exporting||syncBusy||syncing||!canRun())return;
 let prompt;try{prompt=languagePrompt(resolvePrompt('custom',$('category-prompt').value))+' Keep the description to one sentence, as short as possible.';}catch(error){status(error.message,true);return;}
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
   const photo=item.remoteId&&item.exportImage?{url:item.exportImage,width:384,height:384,info:item.info}:await preparePhoto(item.file,{centerCrop:true});
   item.info=photo.info;logEvent('photo-prepare-complete',{index:items.indexOf(item),...photo.info,width:photo.width,height:photo.height});if(cancelled)throw Error('Stopped');
   item.exportImage=photo.url;item.thumbnail=await thumbnail(photo);if(cancelled)throw Error('Stopped');render();
   if(!isCloud())return persistAnswer(item,await request('describe',{image:photo.url,prompt}));
   const controller=new AbortController();cloudControllers.add(controller);
   const timeout=setTimeout(()=>controller.abort(),30000);
   logEvent('cloud-request',{model:'gemma-4-26b-a4b-it',index:items.indexOf(item),preparedHash:photo.info?.preparedHash,promptHash});
   try{const answer=await classifyCloud(photo.url,prompt,controller.signal);logEvent('cloud-complete',{index:items.indexOf(item)});return await persistAnswer(item,answer);}
   catch(error){
    logEvent('cloud-error',{status:error.status||0,code:error.code,providerStatus:error.providerStatus,finishReason:error.finishReason,cancelled});
    if(!cancelled){batchPause=error.name==='AbortError'?'Cloud request timed out. Retry failed photos or continue later.':error.message;const failure=new Error(batchPause);failure.pauseBatch=true;throw failure;}
    throw error;
   }finally{clearTimeout(timeout);cloudControllers.delete(controller);}

  },render,()=>cancelled,isCloud()?Number($('image-concurrency').value)||2:1);
  status(batchPause|| (cancelled?'Stopped. Your completed categories are kept. Continue when ready.':'Finished. Review your categories below.'),!!batchPause);
 }catch(error){status(cancelled?'Stopped. Continue when ready.':friendlyError(error.message),!cancelled);}
 finally{activeItem=null;running=false;$('download').hidden=true;render();}
};
$('cancel').onclick=()=>{cancelled=true;stopWorker();status('Stopping…');};
$('retry').onclick=()=>{for(const item of items)if(item.state==='error'){item.state='pending';item.error='';}render();$('start').click();};
$('clear').onclick=()=>mutateSession(async()=>{for(const item of items)if(item.remoteId)await sessionAPI(`/${sessionId}/photos/${item.remoteId}`,'DELETE');items=[];status('');});
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('pagehide',stopWorker);
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;}});$('reload').onclick=()=>{if(!running)updateSW(true);};
render();
(async()=>{if(typeof initSharedSessions==='function')await initSharedSessions();try{const adapter=await navigator.gpu?.requestAdapter();supported=!!adapter;logEvent('adapter-check',{supported,fp16:!!adapter?.features?.has('shader-f16')});installed=await availableModels(!!adapter?.features?.has('shader-f16'));}catch{}
 cloudEnabled=await cloudAvailable();logEvent('cloud-availability',{enabled:cloudEnabled});
 logEvent('cached-models',{installed});
 installed=installed.filter(key=>getModel(key).family!=='florence');$('batch-model').replaceChildren();for(const key of installed){const option=document.createElement('option');option.value=key;option.textContent=getModel(key).label;$('batch-model').append(option);}
 if(cloudEnabled){const option=document.createElement('option');option.value=CLOUD_MODEL;option.textContent=CLOUD_INFO.label;$('batch-model').append(option);}
 const saved=readSetting('lens-model',defaults.interface.model);selectedModel=saved===CLOUD_MODEL&&cloudEnabled?CLOUD_MODEL:supported&&installed.includes(saved)?saved:cloudEnabled?CLOUD_MODEL:installed[0]||DEFAULT_MODEL;$('batch-model').value=installed.length||cloudEnabled?selectedModel:'';$('no-models').hidden=!!installed.length||cloudEnabled;modelDetails();status(cloudEnabled||supported?'Choose photos to begin.':'WebGPU is unavailable and cloud mode is not configured.');render();})();

$('export-document').onclick=async()=>{
 if(exporting||running)return;
 exporting=true;render();$('export-status').textContent='Creating document…';
 try{
  const type=$('export-type').value;
  const options={type,rows:$('export-rows').value,columns:$('export-columns').value,layout:$('export-layout').value,showDescription:$('export-description').checked,orientation:$('export-orientation').value,language:getLanguage()};
  const {createDocument}=await import('./export-document.js');
  const blob=await createDocument(items,options);
  if(exportURL)URL.revokeObjectURL(exportURL);
  exportURL=URL.createObjectURL(blob);const link=document.createElement('a');link.href=exportURL;link.download=`audit-${new Date().toISOString().slice(0,10)}.${type}`;document.body.append(link);link.click();link.remove();
  const createdURL=exportURL;setTimeout(()=>{URL.revokeObjectURL(createdURL);if(exportURL===createdURL)exportURL=null;},60000);
  $('export-status').textContent='Document created. Download started.';
 }catch(error){$('export-status').textContent=error.message||'Could not create the document. Try fewer photos.';}
 finally{exporting=false;render();}
};

async function refreshSession(){
 if(!shared||pickerOpen||running||exporting||syncBusy||syncing)return;
 syncing=true;$('session-status').textContent='Syncing…';render();
 try{const listing=await sessionAPI();syncSessionChoices(listing.sessions);if(!sessionId){items=[];$('session-status').textContent='No sessions yet. Create one to add photos.';return;}
 const requestedSession=sessionId,data=await sessionAPI('/'+requestedSession);const merged=await mergePhotos(items,data.photos);if(!shared||sessionId!==requestedSession)return;items=merged;$('session-status').textContent='Synced';
 }catch(e){$('session-status').textContent=e.message;}finally{syncing=false;render();}
}
async function loadSession(id){if(running||exporting||syncBusy||syncing)return;sessionId=id;saveSetting('audit-session',id);items=[];await refreshSession();}
async function initSharedSessions(){
 if(typeof authConfig!=='function')return;
 try{const config=await authConfig();if(!config.enabled){accountReady=true;return;}if(!credentials()){location.replace('./login.html');return;}shared=true;$('sessions-panel').hidden=false;$('sign-out').hidden=false;$('sign-out').onclick=()=>{stopWorker();shared=false;accountReady=false;items=[];closeOriginal();if(exportURL){URL.revokeObjectURL(exportURL);exportURL=null;}render();signOut();};
 const listing=await sessionAPI();const sessions=listing.sessions.filter(session=>!session.deleting);
 function options(){ $('session-select').replaceChildren();for(const session of sessions){const option=document.createElement('option');option.value=session.id;option.textContent=session.name;$('session-select').append(option);}}
 syncSessionChoices=next=>{
 next=next.filter(session=>!session.deleting);
 const selected=$('session-select').value;
 if(next.map(s=>s.id+s.name).join('|')===sessions.map(s=>s.id+s.name).join('|'))return;
 sessions.splice(0,sessions.length,...next);options();
 if(next.some(session=>session.id===selected))$('session-select').value=selected;
 else {sessionId=next[0]?.id||null;$('session-select').value=sessionId||'';items=[];saveSetting('audit-session',sessionId||'');}
 };
 options();const requested=window.location?.href?new URL(window.location.href).searchParams.get('session'):null;
 const saved=requested||readSetting('audit-session','');$('session-select').value=sessions.some(s=>s.id===saved)?saved:sessions[0]?.id||'';
 if($('session-select').value)await loadSession($('session-select').value);else $('session-status').textContent='No sessions yet. Create one to add photos.';
 if(requested&&window.history?.replaceState){const url=new URL(window.location.href);url.searchParams.delete('session');window.history.replaceState(null,'',url);}
 $('session-select').onchange=()=>loadSession($('session-select').value);
 $('new-session').onclick=()=>{$('session-dialog').showModal();};
 $('cancel-session').onclick=()=>$('session-dialog').close();
 $('new-session-form').onsubmit=async event=>{event.preventDefault();await mutateSession(async()=>{const session=await sessionAPI('','POST',{name:$('session-name').value.trim()});sessions.push(session);options();$('session-select').value=session.id;sessionId=session.id;saveSetting('audit-session',session.id);items=[];$('session-dialog').close();});};
 accountReady=true;render();setInterval(refreshSession,10000);window.addEventListener('focus',refreshSession);window.addEventListener('pageshow',()=>{if(shared&&!credentials())location.replace('./login.html');});
 }catch(e){status(e.message,true);$('pick').disabled=true;}
}
