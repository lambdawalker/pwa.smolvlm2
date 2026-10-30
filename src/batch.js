import {authConfig, credentials, signOut} from './account.js';
import {sessionAPI,uploadPhoto,savePhoto,mergePhotos,imageData} from './session-sync.js';
import { defaults } from './defaults.generated.js';
import './language-ui.js';
import { getLanguage, languagePrompt, t } from './i18n.js';
import './handedness.js';
import { appendPhotoDetails } from './photo-details.js';
import './style.css';
import { CLOUD_MODEL, CLOUD_INFO, CLOUD_PRECISION, cloudAvailable } from './cloud.js';
import { logEvent,installDiagnostics } from './diagnostics.js';
installDiagnostics();
import { registerSW } from 'virtual:pwa-register';
import {sameImageHashes,validImageHashes} from './image-hash.js';
import { preparePhoto } from './image.js';
import { resolvePrompt } from './core.js';
import { CATEGORIES, CATEGORY_PROMPT } from './batch-core.js';
const $=id=>document.getElementById(id);
let originalURL=null;
function closeOriginal(){if(originalURL){URL.revokeObjectURL(originalURL);originalURL=null;}$('original-image').removeAttribute('src');}
$('close-original').onclick=()=>$('original-viewer').close();
$('original-viewer').addEventListener('close',closeOriginal);
$('original-viewer').onclick=event=>{if(event.target===$('original-viewer'))$('original-viewer').close();};
async function openOriginal(item){closeOriginal();try{const file=item.originalUrl?await (async()=>{const r=await fetch(item.originalUrl,{cache:'no-store'});if(!r.ok)throw Error('Could not load original photo.');return r.blob();})():item.file;originalURL=URL.createObjectURL(file);$('original-image').src=originalURL;$('original-image').alt=item.description||'Original photo';$('original-viewer').showModal();}catch(e){status(e.message,true);}}
window.addEventListener('pagehide',closeOriginal);
let exporting=false,exportURL=null;
let pickerOpen=false,writeOperations=0,syncError='',retrying=false,duplicateCount=0,hashIndexing=false,hashIndexController=null,cleaningDuplicates=false;
let shared=false,sessionId=null,syncBusy=false,syncing=false,checkingSync=false,pendingUpdates=false,syncGeneration=0,sessionChoicesSignature='',syncSessionChoices=()=>{},accountReady=typeof authConfig!=='function';
let items=[],installPrompt;
const readSetting=(key,fallback)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const saveSetting=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
let cloudEnabled=false;
const batchModel=()=>CLOUD_INFO;
const canRun=()=>accountReady&&shared&&!!sessionId&&cloudEnabled&&$('cloud-consent').checked;
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
$('cloud-consent').checked=readSetting('lens-consent',String(defaults.interface.cloudConsent))==='true';
$('cloud-consent').onchange=()=>{saveSetting('lens-consent',String($('cloud-consent').checked));render();if(canRun())queueWaitingPhotos();};
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
 const changed=activeCategory!==category;activeCategory=category;syncCategorySelection();updateClearAction();
 if(changed&&smooth&&mobileCategories())categoryPages[index].section.className+=' '+(direction<0?'category-enter-left':'category-enter-right');
}
function updateClearAction(){const shred=activeCategory==='Trash';const button=$('clear');button.title=t(shred?'Empty Trash permanently':'Clear photos');button.setAttribute('aria-label',button.title);button.innerHTML=shred?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 2h10v9H7zM3 8h4m10 0h4v9H3V8m4 10v5m4-5v5m4-5v5m4-5v5M9 5h6M9 8h6"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';button.disabled=exporting||!items.some(item=>shred?item.state==='trash':!['trash','uploading'].includes(item.state));}
function hideIcon(id,hidden){const icon=$(id);icon.hidden=hidden;if(hidden)icon.setAttribute('hidden','');else icon.removeAttribute('hidden');}
function moveCategory(direction,from=activeCategory){const index=categoryPages.findIndex(page=>page.category===from);if(categoryPages.length)selectCategory(categoryPages[(index+direction+categoryPages.length)%categoryPages.length].category,true,direction);}
let swipe=null;
$('categorize-page').addEventListener('touchstart',event=>{if(!mobileCategories()||event.touches.length!==1||event.target.closest?.('button,input,select,textarea,a,dialog,#action-bar,#document-settings-panel')){swipe=null;return;}swipe={x:event.touches[0].clientX,y:event.touches[0].clientY,category:activeCategory};},{passive:true});
$('categorize-page').addEventListener('touchend',event=>{if(!swipe)return;const start=swipe;swipe=null;const touch=event.changedTouches[0];if(!touch)return;const dx=touch.clientX-start.x,dy=touch.clientY-start.y;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3)moveCategory(dx<0?1:-1,start.category);},{passive:true});
$('categorize-page').addEventListener('touchcancel',()=>{swipe=null;},{passive:true});
function setView(view){currentView=view;$('groups').className='category-groups '+(view==='list'?'list-view':'');hideIcon('list-view-icon',view==='list');hideIcon('grid-view-icon',view!=='list');$('view-toggle').setAttribute('aria-label',view==='list'?'Switch to grid view':'Switch to list view');$('view-toggle').title=view==='list'?'Switch to grid view':'Switch to list view';saveSetting('lens-view',view);}
$('view-toggle').onclick=()=>setView(currentView==='grid'?'list':'grid');setView(readSetting('lens-view',defaults.interface.view));
$('category-prompt').value=readSetting('lens-category-prompt',CATEGORY_PROMPT);
$('category-prompt').onchange=()=>saveSetting('lens-category-prompt',$('category-prompt').value);
$('reset-prompt').onclick=()=>{$('category-prompt').value=CATEGORY_PROMPT;saveSetting('lens-category-prompt',CATEGORY_PROMPT);};
function modelDetails(){$('cloud-model-label').textContent=CLOUD_INFO.label;$('precision-label').textContent=CLOUD_PRECISION;}
modelDetails();
const status=(text,visible=false)=>{$('status').textContent=text;$('status').hidden=!visible;};
$('attention-count').onclick=()=>{selectCategory('Needs attention');document.getElementById('needs-attention')?.scrollIntoView({behavior:'smooth',block:'start',inline:'nearest'});};
function render(){
 items=items.filter(item=>!item.shredded&&!(item.state==='trash'&&!item.remoteId&&item.expiresAt<=Date.now()/1000));
 const activeItems=items.filter(item=>item.state!=='trash');
 const busy=exporting;
 $('duplicate-notice').hidden=!duplicateCount;$('duplicate-notice').textContent=t('Duplicates skipped:')+' '+duplicateCount;
 $('index-hashes').disabled=!shared||!sessionId||(!hashIndexing&&(busy||retrying||cleaningDuplicates));$('deduplicate-photos').disabled=!shared||!sessionId||busy||retrying||hashIndexing||cleaningDuplicates;$('index-hashes').textContent=t(hashIndexing?'Stop indexing':'Index existing photos');
 $('counter-processed').textContent=String(activeItems.filter(i=>['done','review','error'].includes(i.state)).length)+'/'+String(activeItems.length);$('counter-categorized').textContent=String(activeItems.filter(i=>i.state==='done').length);$('counter-uploaded').textContent=String(activeItems.filter(i=>i.remoteId).length)+'/'+String(activeItems.length);
 syncIcon();
 if($('session-select'))$('session-select').disabled=busy;
 if($('new-session'))$('new-session').disabled=busy;
 $('export-document').disabled=exporting||busy||!items.some(item=>item.state==='done');
 $('cloud-consent').disabled=busy;$('category-prompt').disabled=busy;$('reset-prompt').disabled=busy;
 $('pick').disabled=!accountReady||!shared||!sessionId||exporting;
 $('clear').disabled=busy||!items.length;$('retry-uploads').hidden=!items.some(item=>item.uploadFailed);$('retry-uploads').disabled=busy||retrying;$('reload').disabled=busy;
 const finished=activeItems.filter(i=>['done','review','error'].includes(i.state)).length;
 const attention=items.filter(i=>['review','error'].includes(i.state)).length;
 $('summary').textContent=`${finished} of ${activeItems.length} processed | ${items.filter(i=>i.state==='done').length} categorized | `;
 $('attention-count').setAttribute('data-count',String(attention));$('attention-count').title=t('Needs attention');$('attention-count').textContent=`${attention} need attention`;$('attention-count').disabled=attention===0;$('attention-count').className='attention-count'+(attention?' has-attention':'');

 $('batch-progress').hidden=!activeItems.length;$('batch-progress').max=activeItems.length||1;$('batch-progress').value=finished;
 $('groups').replaceChildren();$('category-tabs').replaceChildren();categoryPages=[];
 for(const category of [...CATEGORIES,'Needs attention','Waiting','Trash']){
  const members=items.filter(i=>category==='Trash'?i.state==='trash':category==='Waiting'?['pending','processing','uploading'].includes(i.state):category==='Needs attention'?['error','review'].includes(i.state):i.category===category&&i.state==='done');
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
   const remove=document.createElement('button');remove.className='icon-button remove-photo';remove.disabled=!!(exporting||item.state==='uploading'||item.dirty);remove.setAttribute('aria-label',item.state==='trash'?'Shred permanently':'Move to Trash');remove.title=t(item.state==='trash'?'Shred permanently':'Move to Trash');remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';if(item.state==='trash')remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 2h10v9H7zM3 8h4m10 0h4v9H3V8m4 10v5m4-5v5m4-5v5m4-5v5M9 5h6M9 8h6"/></svg>';
   remove.onclick=()=>mutateSession(async()=>{
    if(item.state==='trash'){if(item.remoteId){try{await sessionAPI(`/${sessionId}/photos/${item.remoteId}`,'DELETE',{permanent:true});}catch(e){if(e.status!==404)throw e;}}item.shredded=true;if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);items=items.filter(candidate=>candidate!==item);}
    else if(item.remoteId)await savePhoto(sessionId,item,{state:'trash'});
    else {item.state='trash';item.expiresAt=Date.now()/1000+172800;}
   });card.append(remove);
   const label=document.createElement('label');label.className='category-title';const select=document.createElement('select');select.disabled=exporting||item.dirty||['processing','uploading'].includes(item.state);select.setAttribute('aria-label','Image category');
   for(const value of ['',...CATEGORIES]){const option=document.createElement('option');option.value=value;option.textContent=value||(item.state==='trash'?'Restore to category':'Choose category');select.append(option);}select.value=item.state==='trash'||item.conflict?'':item.category||'';
   select.onchange=()=>{if(!select.value)return;const category=select.value;return mutateSession(async()=>{if(item.remoteId){await savePhoto(sessionId,item,{category,state:'done'});}else{item.category=category;item.state='done';item.error='';}if(item.conflict)selectCategory('Needs attention');});};label.append(select);card.append(label);
   if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.description||'Selected photo';img.loading='lazy';img.className='open-original';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Open original photo');img.onclick=()=>openOriginal(item);img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openOriginal(item);}};card.append(img);}
   const state=document.createElement('p');state.className='small';state.textContent=t(item.state==='trash'?'Automatically deleted after 2 days':item.state==='processing'?'Processing in AWS':item.error||(item.state==='pending'?(item.jobId?(item.processingAttempts?'Retrying in AWS':'Queued in AWS'):'Waiting for AWS consent'):item.category));if(item.state!=='done')card.append(state);
   if(item.uploadState){const upload=document.createElement('p');upload.className='photo-upload-status'+(item.uploadFailed?' upload-error':'');upload.textContent=t(item.uploadState);upload.setAttribute('role','status');card.append(upload);}
   const activeJob=item.jobId&&['pending','processing'].includes(item.state);
   if(item.state!=='trash'&&item.state!=='uploading'&&!activeJob&&(item.uploadFailed||item.remoteId)){
    const action=document.createElement('button');action.className='quiet photo-reclassify';action.textContent=t(item.state==='done'?'Reclassify':'Retry');action.disabled=exporting||item.dirty||retrying||(!item.uploadFailed&&!canRun());action.onclick=()=>item.uploadFailed?retryUploads():requestReclassification(item);card.append(action);
   }
   if(item.description){const description=document.createElement('p');description.className='card-description';description.textContent=item.description;card.append(description);}
   const details=document.createElement('details');details.className='card-details';const detailTitle=document.createElement('summary');detailTitle.textContent='Details';details.append(detailTitle);
   appendPhotoDetails(details,item,item.model?batchModel(item.model).label:'unknown',true);
   details.hidden=!$('show-photo-details').checked;card.append(details);grid.append(card);

  }
  $('groups').append(section);
 }
 if(!categoryPages.some(page=>page.category===activeCategory))activeCategory=categoryPages[0]?.category??null;
 selectCategory(activeCategory,false);
 $('category-tabs').hidden=!categoryPages.length;
}
$('pick').onclick=()=>{if(!accountReady||!shared||!sessionId||exporting)return;pickerOpen=true;$('photos').click();};
$('photos').addEventListener('cancel',()=>{pickerOpen=false;});
$('photos').onchange=async event=>{
 pickerOpen=false;
 if(!accountReady||!shared||!sessionId||exporting)return;
 const files=[...event.target.files];event.target.value='';duplicateCount=0;
 if(shared){
 const uploadSessionId=sessionId;
 const added=files.map(file=>({file,state:'uploading',uploadState:'Waiting to upload',thumbnail:URL.createObjectURL(file)}));items.push(...added);render();
 await uploadItems(added,uploadSessionId);
 }else for(const file of files)items.push({file,state:'pending',thumbnail:URL.createObjectURL(file)});

 render();
};
function duplicateInSession(item){return items.some(other=>other!==item&&!other.shredded&&!other.uploadFailed&&other.state!=='uploading'&&sameImageHashes(item.info,validImageHashes(other.info)?other.info:other));}
function skipDuplicate(item){item.shredded=true;if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);if(items.includes(item))duplicateCount++;logEvent('duplicate-photo-skipped',{sourceHash:item.info?.sourceHash,dHash:item.info?.dHash});}
async function uploadItems(photos,targetSession){
 await mutateSession(async()=>{for(const item of photos){
  if(item.shredded||item.state==='trash')continue;
  item.state='uploading';item.uploadFailed=false;item.uploadState='Checking duplicates';item.error='';render();
  try{logEvent('photo-upload-start',{bytes:item.file.size,mime:item.file.type,retry:!!item.info});
   const photo=await preparePhoto(item.file,{centerCrop:true});item.exportImage=photo.url;item.info=photo.info;
   if(sessionId===targetSession&&duplicateInSession(item)){skipDuplicate(item);render();continue;}item.uploadState='Uploading';
   if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);item.thumbnail=photo.url;render();
   const settings=processingSettings();const saved=await uploadPhoto(targetSession,item.file,photo,settings);if(saved.duplicate){skipDuplicate(item);render();continue;}item.remoteId=saved.id;item.revision=saved.revision;item.state=saved.state||'pending';item.jobId=saved.jobId;item.promptHash=saved.promptHash;item.model=CLOUD_MODEL;item.uploadState='Uploaded';if(saved.promptHash)$('prompt-id').textContent='Prompt ID: '+saved.promptHash.slice(0,12);logEvent('photo-upload-complete',{id:saved.id,job:saved.jobId,promptHash:saved.promptHash});
  }catch(error){item.state='error';item.uploadFailed=true;item.uploadState='Upload failed';item.error=error.message;logEvent('photo-upload-error',{message:error.message,status:error.status||0});}
  render();
 }});
}
async function mutateSession(action){if(exporting)return;writeOperations++;syncBusy=true;render();try{const operation=action();render();await operation;}catch(e){logEvent('session-operation-error',{message:e.message,status:e.status||0});status(e.message,true);}finally{writeOperations--;syncBusy=writeOperations>0;render();}}
function processingSettings(){
 const consent=$('cloud-consent').checked;
 if(!consent)return {consent:false,prompt:''};
 const prompt=languagePrompt(resolvePrompt('custom',$('category-prompt').value))+' Keep the description to one sentence, as short as possible.';
 if(Array.from(prompt).length>1000)throw Error('Keep the categorization prompt shorter than 850 characters.');
 return {consent:true,prompt};
}
async function retryUploads(){
 if(exporting||retrying||!shared||!sessionId)return;
 retrying=true;render();try{await uploadItems(items.filter(item=>item.uploadFailed&&item.state==='error'),sessionId);}finally{retrying=false;render();}
}
$('retry-uploads').onclick=retryUploads;
async function requestReclassification(item){
 if(!canRun()||item.dirty||item.shredded||item.state==='trash')return;
 return mutateSession(async()=>{
  item.dirty=true;render();
  try{const settings=processingSettings();const saved=await sessionAPI('/'+sessionId+'/photos/'+item.remoteId+'/classify','POST',{revision:item.revision,...settings});Object.assign(item,{state:saved.state,jobId:saved.jobId,revision:saved.revision,promptHash:saved.promptHash,model:CLOUD_MODEL,error:'',processingAttempts:0});if(saved.promptHash)$('prompt-id').textContent='Prompt ID: '+saved.promptHash.slice(0,12);logEvent('cloud-job-queued',{photo:item.remoteId,job:saved.jobId,promptHash:saved.promptHash});}
  finally{item.dirty=false;render();}
 });
}
let activating=false;
async function queueWaitingPhotos(){
 if(activating||!canRun())return;
 const targetSession=sessionId;activating=true;
 try{for(;;){const result=await sessionAPI('/'+targetSession+'/classify-pending','POST',processingSettings());if(sessionId!==targetSession)return;for(const saved of result.photos||[]){const item=items.find(i=>i.remoteId===saved.id);if(item&&!item.dirty){item.state=saved.state;item.jobId=saved.jobId;item.revision=saved.revision;item.promptHash=saved.promptHash;}}render();if(!result.remaining)break;}}
 catch(error){logEvent('queue-pending-error',{message:error.message});status(error.message,true);}finally{activating=false;if(sessionId!==targetSession&&canRun())queueWaitingPhotos();}
}
$('clear').onclick=()=>mutateSession(async()=>{const clearSession=sessionId,shred=activeCategory==='Trash';for(const item of [...items]){
 if(shred){if(item.state!=='trash')continue;if(item.remoteId){try{await sessionAPI(`/${clearSession}/photos/${item.remoteId}`,'DELETE',{permanent:true});}catch(error){if(error.status!==404)throw error;}}item.shredded=true;}
 else {if(item.state==='trash'||item.shredded||item.state==='uploading')continue;if(item.remoteId)await savePhoto(clearSession,item,{state:'trash'});else{item.state='trash';item.expiresAt=Date.now()/1000+172800;}}
 render();}});

window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;}});$('reload').onclick=()=>updateSW(true);
render();
(async()=>{await initSharedSessions();cloudEnabled=await cloudAvailable();modelDetails();if(canRun())queueWaitingPhotos();if(accountReady&&!cloudEnabled)status('AWS Gemma is not configured. Run the deployment wizard.',true);render();})();

$('export-document').onclick=async()=>{
 if(exporting)return;
 exporting=true;render();$('export-status').textContent='Creating document…';
 try{
  const type=$('export-type').value;
  const options={type,rows:$('export-rows').value,columns:$('export-columns').value,layout:$('export-layout').value,showDescription:$('export-description').checked,orientation:$('export-orientation').value,language:getLanguage()};
  for(const item of items)if(item.state==='done'&&!item.exportImage&&item.preparedUrl)item.exportImage=await imageData(item.preparedUrl);
  const {createDocument}=await import('./export-document.js');
  const blob=await createDocument(items,options);
  if(exportURL)URL.revokeObjectURL(exportURL);
  exportURL=URL.createObjectURL(blob);const link=document.createElement('a');link.href=exportURL;link.download=`audit-${new Date().toISOString().slice(0,10)}.${type}`;document.body.append(link);link.click();link.remove();
  const createdURL=exportURL;setTimeout(()=>{URL.revokeObjectURL(createdURL);if(exportURL===createdURL)exportURL=null;},60000);
  $('export-status').textContent='Document created. Download started.';
 }catch(error){$('export-status').textContent=error.message||'Could not create the document. Try fewer photos.';}
 finally{exporting=false;render();}
};

$('index-hashes').onclick=async()=>{
 if(hashIndexing){hashIndexController?.abort();return;}
 if(!shared||!sessionId||exporting||retrying||cleaningDuplicates)return;
 const targetSession=sessionId,controller=new AbortController();hashIndexController=controller;hashIndexing=true;render();
 let completed=0,total=0,duplicates=0;
 const progress=()=>{$('hash-index-status').textContent=t('Photos indexed:')+' '+completed+'/'+total+(duplicates?' · '+t('Existing duplicates:')+' '+duplicates:'');};
 try{
  const data=await sessionAPI('/'+targetSession,'GET',undefined,{signal:controller.signal});
  const queue=data.photos.filter(photo=>!['uploading','shredded'].includes(photo.state));total=queue.length;progress();
  for(const photo of queue){
   if(controller.signal.aborted||sessionId!==targetSession)throw new DOMException('Stopped','AbortError');
   const timeout=setTimeout(()=>controller.abort(),60000);
   try{
    let info=photo;
    if(!photo.sha256Verified||!validImageHashes(photo)){
     const response=await fetch(photo.originalUrl,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('Could not load original photo. Retry indexing.');
     const file=await response.blob();if(file.size>25*1024*1024)throw Error('Original photo is too large to index.');
     info=(await preparePhoto(file,{centerCrop:true})).info;
    }
    const result=await sessionAPI('/'+targetSession+'/photos/'+photo.id+'/hashes','POST',{sourceHash:info.sourceHash,dHash:info.dHash,hashVersion:info.hashVersion},{signal:controller.signal});
    completed++;if(result.duplicateOf)duplicates++;if(result.updated&&sessionId===targetSession){pendingUpdates=true;syncIcon();}progress();
    logEvent('photo-hashes-indexed',{id:photo.id,duplicate:!!result.duplicateOf});
   }finally{clearTimeout(timeout);}
  }
  $('hash-index-status').textContent+=' · '+t('Indexing complete.');
 }catch(error){$('hash-index-status').textContent=t(error.name==='AbortError'?'Indexing stopped. Run again to continue.':'Indexing failed. Run again to retry.')+' '+completed+'/'+total;logEvent('photo-hash-index-error',{message:error.message});}
 finally{hashIndexing=false;hashIndexController=null;render();}
};
$('deduplicate-photos').onclick=async()=>{
 if(!shared||!sessionId||exporting||retrying||hashIndexing||cleaningDuplicates)return;
 const targetSession=sessionId;let moved=0;cleaningDuplicates=true;render();
 try{
  for(;;){
   const result=await sessionAPI('/'+targetSession+'/deduplicate','POST');moved+=result.moved||0;
   $('hash-index-status').textContent=t('Duplicate copies moved to Trash:')+' '+moved;
   if(result.moved&&sessionId===targetSession){pendingUpdates=true;syncIcon();}
   if(!result.remaining){if(result.unindexed)$('hash-index-status').textContent+=' · '+t('Index remaining photos to check all duplicates.');break;}
   if(!result.moved)throw Error('Duplicate cleanup did not make progress. Retry.');
  }
  if(moved)$('hash-index-status').textContent+=' · '+t('Press the cloud icon to apply changes.');
 }catch(error){$('hash-index-status').textContent=t('Duplicate cleanup stopped. Retry to continue.')+' '+moved;logEvent('duplicate-cleanup-error',{message:error.message});}
 finally{cleaningDuplicates=false;render();}
};
window.addEventListener('pagehide',()=>hashIndexController?.abort());
function syncIcon(){
 const icon=$('sync-cloud');icon.hidden=!shared;icon.setAttribute('data-updates',String(pendingUpdates));
 icon.disabled=syncing||exporting||retrying||cleaningDuplicates||writeOperations>0;
 icon.title=t(syncError?'Could not check sync. Press to retry.':pendingUpdates?'Updates available. Press to sync.':'Synchronized. Press to sync.');
 icon.setAttribute('aria-label',icon.title);
}
function sessionSignature(sessions){return JSON.stringify(sessions.filter(s=>!s.deleting).map(s=>[s.id,s.name]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
function remoteSignature(photos){return JSON.stringify(photos.filter(p=>!['uploading','shredded'].includes(p.state)).map(p=>[p.id??p.remoteId,p.revision]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
function syncFingerprint(){return JSON.stringify([sessionId,items.map(item=>[item.remoteId,item.revision,item.state,item.shredded])]);}
async function checkSession(){
 if(!shared||pickerOpen||syncing||checkingSync)return;
 const checkedSession=sessionId,generation=syncGeneration;checkingSync=true;
 try{
  const listing=await sessionAPI();if(!shared||sessionId!==checkedSession||generation!==syncGeneration)return;
  let changed=sessionSignature(listing.sessions)!==sessionChoicesSignature;
  if(checkedSession&&listing.sessions.some(s=>s.id===checkedSession&&!s.deleting)){
   const data=await sessionAPI('/'+checkedSession,'GET',undefined,{conditional:true});
   if(!shared||sessionId!==checkedSession||generation!==syncGeneration)return;
   if(!data.unchanged)changed ||= remoteSignature(data.photos)!==remoteSignature(items.filter(i=>i.remoteId&&!i.shredded).map(i=>({...i,id:i.remoteId})));
  }
  pendingUpdates ||= changed;syncError='';syncIcon();
 }catch(e){if(sessionId===checkedSession&&generation===syncGeneration){syncError=e.message;syncIcon();}}
 finally{checkingSync=false;}
}
async function refreshSession(){
 if(!shared||pickerOpen||syncing||exporting||retrying||cleaningDuplicates||writeOperations>0)return;
 const polledSession=sessionId,before=syncFingerprint(),knownAtStart=new Map(items.filter(item=>item.remoteId).map(item=>[item.remoteId,item.revision]));syncing=true;syncGeneration++;syncIcon();
 try{const listing=await sessionAPI();if(sessionId!==polledSession)return;syncSessionChoices(listing.sessions);
 if(!sessionId){items=[];pendingUpdates=false;syncError='';$('session-status').textContent='No sessions yet. Create one to add photos.';if(before!==syncFingerprint())render();return;}
 const requestedSession=sessionId,data=await sessionAPI('/'+requestedSession,'GET',undefined,{conditional:false});
 const merged=await mergePhotos(items,data.photos,{knownAtStart});
 if(!shared||sessionId!==requestedSession)return;
 items=[...new Map(merged.filter(item=>!item.shredded).map(item=>[item.remoteId||item,item])).values()];pendingUpdates=false;syncError='';$('session-status').textContent='Synced';if(before!==syncFingerprint())render();
 }catch(e){syncError=e.message;$('session-status').textContent=e.message;}finally{syncing=false;syncIcon();}
}
$('sync-cloud').onclick=()=>refreshSession();
async function loadSession(id){if(exporting)return;sessionId=id;saveSetting('audit-session',id);items=[];duplicateCount=0;pendingUpdates=false;syncError='';syncGeneration++;await refreshSession();if(canRun())queueWaitingPhotos();}
async function initSharedSessions(){
 if(typeof authConfig!=='function')return;
 try{const config=await authConfig();if(!config.enabled){accountReady=false;status('Background categorization requires a deployed signed-in session. Use Describe for a local single photo.',true);return;}if(!credentials()){location.replace('./login.html');return;}shared=true;$('sessions-panel').hidden=false;$('sign-out').hidden=false;$('sign-out').onclick=()=>{shared=false;accountReady=false;items=[];closeOriginal();if(exportURL){URL.revokeObjectURL(exportURL);exportURL=null;}render();signOut();};
 const listing=await sessionAPI();const sessions=listing.sessions.filter(session=>!session.deleting).map(session=>({...session}));
 function options(){ sessionChoicesSignature=sessionSignature(sessions);$('session-select').replaceChildren();for(const session of sessions){const option=document.createElement('option');option.value=session.id;option.textContent=session.name;$('session-select').append(option);}}
 syncSessionChoices=next=>{
 next=next.filter(session=>!session.deleting);
 const selected=$('session-select').value;
 if(next.map(s=>s.id+s.name).join('|')===sessions.map(s=>s.id+s.name).join('|'))return;
 sessions.splice(0,sessions.length,...next.map(session=>({...session})));options();
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
 accountReady=true;render();setInterval(checkSession,10000);window.addEventListener('focus',checkSession);window.addEventListener('pageshow',()=>{if(shared&&!credentials())location.replace('./login.html');});
 }catch(e){status(e.message,true);$('pick').disabled=true;}
}
