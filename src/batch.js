import {bindHoldAction} from './hold-action.js';
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
let shared=false,sessionId=null,syncBusy=false,syncing=false,checkingSync=false,refreshQueued=false,pendingUpdates=false,syncGeneration=0,sessionChoicesSignature='',syncSessionChoices=()=>{},accountReady=typeof authConfig!=='function';
let items=[],installPrompt;
let groupedHistory=null;
let undoStack=[],undoing=false,deleteRequest=null;
const pageCache=new Map();
let sessionCategories=[];
const categories=()=>[...new Set([...CATEGORIES,...sessionCategories,...items.filter(i=>i.state==='done').map(i=>i.category)])];
const readSetting=(key,fallback)=>{try{return localStorage.getItem(key)??fallback;}catch{return fallback;}};
const saveSetting=(key,value)=>{try{localStorage.setItem(key,value);}catch{}};
let cloudEnabled=false;
const batchModel=()=>CLOUD_INFO;
const canRun=()=>accountReady&&shared&&!!sessionId&&cloudEnabled&&$('cloud-consent').checked;
$('show-photo-details').checked=readSetting('lens-photo-details',String(defaults.interface.showImageDetails))==='true';
$('show-photo-details').onchange=()=>{saveSetting('lens-photo-details',String($('show-photo-details').checked));render();};
$('delete-hold-seconds').value=readSetting('audit-delete-hold-seconds',String(defaults.interface.deleteHoldSeconds));
if(!['2','3'].includes($('delete-hold-seconds').value))$('delete-hold-seconds').value='3';
$('delete-hold-seconds').onchange=()=>{cancelDeleteHold();saveSetting('audit-delete-hold-seconds',$('delete-hold-seconds').value);updateClearAction();};
function savedChoice(id,fallback,allowed){const value=readSetting('audit-'+id,String(fallback));$(id).value=allowed.includes(value)?value:String(fallback);}
savedChoice('export-type',defaults.document.type,['docx','pptx','png']);
savedChoice('export-orientation',defaults.document.orientation,['portrait','landscape']);
const dimensions=Array.from({length:16},(_,i)=>String(i+1));
savedChoice('export-rows',defaults.document.rows,dimensions);
savedChoice('export-columns',defaults.document.columns,dimensions);
savedChoice('export-layout',defaults.document.layout,['table','cards']);
$('export-description').checked=readSetting('audit-export-description',String(defaults.document.addDescription))==='true';
function updateExportType(){
 const type=$('export-type').value,powerpoint=type==='pptx';
 $('export-icon-letter').textContent=type==='png'?'PNG':powerpoint?'P':'W';$('export-icon-letter').setAttribute('font-size',type==='png'?'6':'9');
 const label=type==='png'?'Download PNG pages':powerpoint?'Create PowerPoint document':'Create Word document';$('export-document').setAttribute('aria-label',label);$('export-document').title=t(label);
 $('export-layout-field').hidden=false;const previous=$('export-layout').value;$('export-layout').replaceChildren();
 for(const value of (powerpoint?['table','cards']:['table'])){const option=document.createElement('option');option.value=value;option.textContent=value==='cards'?'Cards':'Table';$('export-layout').append(option);}
 $('export-layout').value=powerpoint?(previous||'table'):'table';
}
$('export-type').onchange=updateExportType;updateExportType();
let rememberedLayout=$('export-layout').value;
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
window.addEventListener('audit-language-change',()=>{showSection();render();});
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
function updateClearAction(){const shred=activeCategory==='Trash';const button=$('clear');button.title=t(shred?'Hold to shred all':'Hold to delete all')+' · '+$('delete-hold-seconds').value+' '+t('seconds');button.setAttribute('aria-label',button.title);button.innerHTML=shred?'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 2h10v9H7zM3 8h4m10 0h4v9H3V8m4 10v5m4-5v5m4-5v5m4-5v5M9 5h6M9 8h6"/></svg>':'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';button.disabled=exporting||writeOperations>0||undoing||!items.some(item=>shred?item.state==='trash':!['trash','uploading'].includes(item.state));}
function hideIcon(id,hidden){const icon=$(id);icon.hidden=hidden;if(hidden)icon.setAttribute('hidden','');else icon.removeAttribute('hidden');}
function moveCategory(direction,from=activeCategory){const index=categoryPages.findIndex(page=>page.category===from);if(categoryPages.length)selectCategory(categoryPages[(index+direction+categoryPages.length)%categoryPages.length].category,true,direction);}
let swipe=null;
$('categorize-page').addEventListener('touchstart',event=>{if(!mobileCategories()||event.touches.length!==1||event.target.closest?.('button,input,select,textarea,a,dialog,#action-bar,#document-settings-panel')){swipe=null;return;}swipe={x:event.touches[0].clientX,y:event.touches[0].clientY,category:activeCategory};},{passive:true});
$('categorize-page').addEventListener('touchend',event=>{if(!swipe)return;const start=swipe;swipe=null;const touch=event.changedTouches[0];if(!touch)return;const dx=touch.clientX-start.x,dy=touch.clientY-start.y;if(Math.abs(dx)>45&&Math.abs(dx)>Math.abs(dy)*1.3)moveCategory(dx<0?1:-1,start.category);},{passive:true});
$('categorize-page').addEventListener('touchcancel',()=>{swipe=null;},{passive:true});
function setView(view){currentView=view;$('groups').className='category-groups '+(view==='list'?'list-view':'');hideIcon('list-view-icon',view==='list');hideIcon('grid-view-icon',view!=='list');$('view-toggle').setAttribute('aria-label',view==='list'?'Switch to grid view':'Switch to list view');$('view-toggle').title=view==='list'?'Switch to grid view':'Switch to list view';saveSetting('lens-view',view);}
$('view-toggle').onclick=()=>{const before=currentView;setView(currentView==='grid'?'list':'grid');recordAction({label:'Change view',async undo(){setView(before);}});render();};setView(readSetting('lens-view',defaults.interface.view));
$('category-prompt').value=readSetting('lens-category-prompt',CATEGORY_PROMPT);
$('category-prompt').onchange=()=>saveSetting('lens-category-prompt',$('category-prompt').value);
$('category-prompt').addEventListener('input',()=>saveSetting('lens-category-prompt',$('category-prompt').value));
$('reset-prompt').onclick=()=>{$('category-prompt').value=CATEGORY_PROMPT;saveSetting('lens-category-prompt',CATEGORY_PROMPT);};
function modelDetails(){$('cloud-model-label').textContent=CLOUD_INFO.label;$('precision-label').textContent=CLOUD_PRECISION;}
modelDetails();
const status=(text,visible=false)=>{$('status').textContent=text;$('status').hidden=!visible;};
$('attention-count').onclick=()=>{selectCategory('Needs attention');document.getElementById('needs-attention')?.scrollIntoView({behavior:'smooth',block:'start',inline:'nearest'});};
function textIfChanged(node,value){if(node.textContent!==value)node.textContent=value;}
function placeChild(parent,node,index){if(parent.children[index]!==node)parent.insertBefore(node,parent.children[index]||null);}
let allSort=readSetting('audit-all-sort','newest');
function captureCards(){
 const result=[];for(const page of pageCache.values())if(page.category===activeCategory)for(const [item,{card}] of page.cards||[]){const rect=card.getBoundingClientRect?.();if(rect?.width)result.push({item,card,rect,category:page.category});}return result;
}
function animateCards(before){
 if(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
 for(const old of before){
  const next=pageCache.get(old.category)?.cards?.get(old.item)?.card;
  if(next?.isConnected){const rect=next.getBoundingClientRect();const x=old.rect.left-rect.left,y=old.rect.top-rect.top;if(x||y)next.animate?.([{transform:`translate(${x}px,${y}px)`},{transform:'none'}],{duration:240,easing:'ease-out'});}
  else if(old.card.cloneNode&&document.body){const ghost=old.card.cloneNode(true);ghost.setAttribute('aria-hidden','true');ghost.inert=true;Object.assign(ghost.style,{position:'fixed',left:old.rect.left+'px',top:old.rect.top+'px',width:old.rect.width+'px',height:old.rect.height+'px',margin:'0',pointerEvents:'none',zIndex:'20'});document.body.append(ghost);const animation=ghost.animate?.([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(.85) translateY(-15px)'}],{duration:220,easing:'ease-in'});if(animation)animation.finished.catch(()=>{}).finally(()=>ghost.remove());else ghost.remove();}
 }
}
function render(){
 const before=captureCards();
 items=items.filter(item=>!item.shredded&&!(item.state==='trash'&&!item.remoteId&&item.expiresAt<=Date.now()/1000));
 const activeItems=items.filter(item=>item.state!=='trash');
 const uploading=activeItems.some(item=>item.state==='uploading');
 const processing=activeItems.some(item=>item.jobId&&['pending','processing'].includes(item.state));
 for(const [id,active] of [['upload-activity',uploading],['upload-icon',uploading],['processed-activity',processing]])$(id).setAttribute('data-active',String(active));
 $('undo').disabled=undoing||exporting||writeOperations>0||!undoStack.length;
 $('undo').title=t('Undo')+(undoStack.length?' · '+t(undoStack.at(-1).label):'');$('undo').setAttribute('aria-label',$('undo').title);

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

 categoryPages=[];const liveCards=new Set(),livePages=new Set();
 for(const category of ['View all',...categories(),'Needs attention','Waiting','Trash']){
  const members=items.filter(i=>category==='View all'?i.state!=='trash':category==='Trash'?i.state==='trash':category==='Waiting'?['pending','processing','uploading'].includes(i.state):category==='Needs attention'?['error','review'].includes(i.state):i.category===category&&i.state==='done');
  if(category!=='View all')members.sort((a,b)=>(a.order||0)-(b.order||0));
  if(window.auditFeatures?.filter)members.splice(0,members.length,...members.filter(window.auditFeatures.filter));
  if(category==='View all')members.sort((a,b)=>{const date=item=>Date.parse(item.updated||'')||item.file?.lastModified||0;return (allSort==='category'?t(a.category||'Waiting').localeCompare(t(b.category||'Waiting')):0)||(allSort==='oldest'?date(a)-date(b):date(b)-date(a));});
  if(!members.length)continue;
  livePages.add(category);
  let page=pageCache.get(category);
  if(!page){
   const section=document.createElement('section');section.className='category-group';
   section.id=category==='Needs attention'?'needs-attention':'category-page-'+category.replaceAll(' ','-');section.setAttribute('role','tabpanel');section.setAttribute('aria-label',category);
   const title=document.createElement('h2');section.append(title);
   const grid=document.createElement('div');grid.className='photo-grid';section.append(grid);
   const tab=document.createElement('button');tab.setAttribute('role','tab');tab.setAttribute('aria-controls',section.id);tab.onclick=()=>selectCategory(category);
   tab.onkeydown=event=>{const index=categoryPages.findIndex(p=>p.category===category);let next=index;if(event.key==='ArrowRight')next=(index+1)%categoryPages.length;else if(event.key==='ArrowLeft')next=(index+categoryPages.length-1)%categoryPages.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=categoryPages.length-1;else return;event.preventDefault();selectCategory(categoryPages[next].category);categoryPages[next].tab.focus?.();};
   if(category==='View all'){const sort=document.createElement('select');sort.className='all-sort';sort.setAttribute('aria-label','Sort photos');for(const [value,label] of [['newest','Recently updated'],['oldest','Oldest updated'],['category','Category']]){const option=document.createElement('option');option.value=value;option.textContent=t(label);sort.append(option);}sort.value=allSort;sort.onchange=()=>{allSort=sort.value;saveSetting('audit-all-sort',allSort);render();};section.insertBefore(sort,grid);}
   page={category,section,title,grid,tab,cards:new Map()};pageCache.set(category,page);
  }
  const {section,title,grid,tab}=page;textIfChanged(title,t(category)+' · '+members.length);textIfChanged(tab,t(category)+' · '+members.length);categoryPages.push(page);
  const cardCache=page.cards;
  for(const item of members){
   liveCards.add(item);
   const signature=JSON.stringify([!!window.auditFeatures,getLanguage(),item.order,sessionCategories,item.state,item.category,item.description,item.error,item.uploadState,item.uploadFailed,item.jobId,item.processingAttempts,item.dirty,item.conflict,item.thumbnail,item.info,item.rawOutput,item.model,item.promptHash,exporting,retrying,canRun(),$('show-photo-details').checked]);
   const previous=cardCache.get(item);
   if(previous?.signature===signature){placeChild(grid,previous.card,members.indexOf(item));continue;}
   const card=document.createElement('article');card.className='photo-card';
   const remove=document.createElement('button');remove.className='icon-button remove-photo';remove.disabled=!!(exporting||item.state==='uploading'||item.dirty);remove.setAttribute('aria-label',item.state==='trash'?'Shred permanently':'Move to Trash');remove.title=t(item.state==='trash'?'Shred permanently':'Move to Trash');remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';if(item.state==='trash')remove.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M7 2h10v9H7zM3 8h4m10 0h4v9H3V8m4 10v5m4-5v5m4-5v5m4-5v5M9 5h6M9 8h6"/></svg>';
   remove.onclick=()=>mutateSession(async()=>{
    if(item.state==='trash'){if(item.remoteId){try{await sessionAPI(`/${sessionId}/photos/${item.remoteId}`,'DELETE',{permanent:true});}catch(e){if(e.status!==404)throw e;}}item.shredded=true;if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);items=items.filter(candidate=>candidate!==item);}
    else await moveToTrash([item],sessionId);
   });card.append(remove);
   const label=document.createElement('label');label.className='category-title';const select=document.createElement('select');select.disabled=exporting||item.dirty||['processing','uploading'].includes(item.state);select.setAttribute('aria-label','Image category');
   for(const value of ['',...categories()]){const option=document.createElement('option');option.value=value;option.textContent=value||(item.state==='trash'?'Restore to category':'Choose category');select.append(option);}select.value=item.state==='trash'||item.conflict?'':item.category||'';
   select.onchange=()=>{if(!select.value)return;const category=select.value;return mutateSession(async()=>{const before=photoSnapshot(item);if(item.remoteId){await savePhoto(sessionId,item,{category,state:'done'});}else{item.category=category;item.state='done';item.error='';}if(!item.conflict&&!item.shredded)recordPhotos('Change category',[before],sessionId);if(item.conflict)selectCategory('Needs attention');});};label.append(select);card.append(label);
   if(item.thumbnail){const img=document.createElement('img');img.src=item.thumbnail;img.alt=item.description||'Selected photo';img.loading='lazy';img.className='open-original';img.tabIndex=0;img.setAttribute('role','button');img.setAttribute('aria-label','Open original photo');img.onclick=()=>openOriginal(item);img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();openOriginal(item);}};card.append(img);}
   const state=document.createElement('p');state.className='small';state.textContent=t(item.state==='trash'?'Automatically deleted after 2 days':item.state==='processing'?'Processing in AWS':item.error||(item.state==='pending'?(item.jobId?(item.processingAttempts?'Retrying in AWS':'Queued in AWS'):'Waiting for AWS consent'):item.category));if(item.state!=='done')card.append(state);
   if(item.uploadState){const upload=document.createElement('p');upload.className='photo-upload-status'+(item.uploadFailed?' upload-error':'');upload.textContent=t(item.uploadState);upload.setAttribute('role','status');card.append(upload);}
   const caption=document.createElement('div');caption.className='card-caption';card.append(caption);
   if(item.description){const description=document.createElement('p');description.className='card-description';description.textContent=item.description;caption.append(description);}
   const activeJob=item.jobId&&['pending','processing'].includes(item.state);
   if(item.state!=='trash'&&item.state!=='uploading'&&!activeJob&&(item.uploadFailed||item.remoteId)){
    const action=document.createElement('button');action.className='icon-button photo-reclassify';action.title=t(item.state==='done'?'Reclassify':'Retry');action.setAttribute('aria-label',action.title);action.innerHTML='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M12 5c-2-4-7-2-6 2-4 0-4 6-1 7-2 4 3 7 7 5V5Zm0 0c2-4 7-2 6 2 4 0 4 6 1 7 2 4-3 7-7 5M6 7l2 2m-3 5 3-1m10-6-2 2m3 5-3-1"/></svg>';action.disabled=exporting||item.dirty||retrying||(!item.uploadFailed&&!canRun());action.onclick=()=>item.uploadFailed?retryUploads():requestReclassification(item);caption.append(action);
   }
   const details=document.createElement('details');details.className='card-details';const detailTitle=document.createElement('summary');detailTitle.textContent='Details';details.append(detailTitle);
   appendPhotoDetails(details,item,item.model?batchModel(item.model).label:'unknown',true);
   details.hidden=!$('show-photo-details').checked;card.append(details);
   window.auditFeatures?.decorate?.(card,item);
   if(previous){const oldImage=previous.card.querySelector?.('img.open-original');const newImage=card.querySelector?.('img.open-original');if(oldImage&&newImage&&oldImage.src===newImage.src){oldImage.alt=newImage.alt;newImage.replaceWith(oldImage);}}
   cardCache.set(item,{card,signature});placeChild(grid,card,members.indexOf(item));if(previous)previous.card.remove();

  }
  for(const [item,cached] of cardCache)if(!members.includes(item)){cached.card.remove();cardCache.delete(item);}
  placeChild($('groups'),section,categoryPages.length-1);placeChild($('category-tabs'),tab,categoryPages.length-1);
 }
 for(const [category,page] of pageCache)if(!livePages.has(category)){page.section.remove();page.tab.remove();pageCache.delete(category);}
 if(!categoryPages.some(page=>page.category===activeCategory))activeCategory=categoryPages[0]?.category??null;
 selectCategory(activeCategory,false);
 $('category-tabs').hidden=!categoryPages.length;
 animateCards(before);
 window.auditFeatures?.afterRender?.();
}
$('pick').onclick=()=>{if(!accountReady||!shared||!sessionId||exporting)return;pickerOpen=true;$('photos').click();};
$('photos').addEventListener('cancel',()=>{pickerOpen=false;});
window.addEventListener('dragover',event=>{if([...event.dataTransfer?.types||[]].includes('Files')){event.preventDefault();event.dataTransfer.dropEffect=$('pick').disabled?'none':'copy';}});
window.addEventListener('drop',event=>{
 if(![...event.dataTransfer?.types||[]].includes('Files'))return;event.preventDefault();
 if($('pick').disabled||$('drop-confirm').open)return;
 const files=[...event.dataTransfer.files].filter(file=>file.type.startsWith('image/')||(!file.type&&/\.(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.name)));
 if(!files.length)return;
 const targetSession=sessionId;$('drop-count').textContent=String(files.length);$('drop-confirm').showModal();
 $('drop-upload').onclick=()=>{$('drop-confirm').close();if(sessionId!==targetSession)return;void $('photos').onchange({target:{files,value:''}});};
});
$('drop-cancel').onclick=()=>$('drop-confirm').close();

$('photos').onchange=async event=>{
 pickerOpen=false;
 if(!accountReady||!shared||!sessionId||exporting)return;
 const files=[...event.target.files];event.target.value='';duplicateCount=0;
 if(shared){
 const uploadSessionId=sessionId;
 const added=files.map(file=>({file,state:'uploading',uploadState:'Waiting to upload',thumbnail:URL.createObjectURL(file)}));items.push(...added);render();
 await window.auditFeatures?.persistFiles?.(files,uploadSessionId);
 await uploadItems(added,uploadSessionId);
 }else for(const file of files)items.push({file,state:'pending',thumbnail:URL.createObjectURL(file)});

 render();
};
function duplicateInSession(item){return items.some(other=>other!==item&&!other.shredded&&!other.uploadFailed&&other.state!=='uploading'&&sameImageHashes(item.info,validImageHashes(other.info)?other.info:other));}
function skipDuplicate(item){window.auditFeatures?.uploadComplete?.(item);item.shredded=true;if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);if(items.includes(item))duplicateCount++;logEvent('duplicate-photo-skipped',{sourceHash:item.info?.sourceHash,dHash:item.info?.dHash});}
async function uploadItems(photos,targetSession){
 const uploaded=[];
 await mutateSession(async()=>{for(const item of photos){
  if(item.shredded||item.state==='trash')continue;
  item.state='uploading';item.uploadFailed=false;item.uploadState='Checking duplicates';item.error='';render();
  try{logEvent('photo-upload-start',{bytes:item.file.size,mime:item.file.type,retry:!!item.info});
   const photo=await preparePhoto(item.file,{centerCrop:true});item.exportImage=photo.url;item.info=photo.info;
   if(sessionId===targetSession&&duplicateInSession(item)){skipDuplicate(item);render();continue;}item.uploadState='Uploading';
   if(item.thumbnail?.startsWith('blob:'))URL.revokeObjectURL(item.thumbnail);item.thumbnail=photo.url;render();
   const settings=processingSettings();const saved=await uploadPhoto(targetSession,item.file,photo,settings);if(saved.duplicate){skipDuplicate(item);render();continue;}item.remoteId=saved.id;item.revision=saved.revision;item.userRevision=saved.userRevision;item.state=saved.state||'pending';item.jobId=saved.jobId;item.promptHash=saved.promptHash;item.model=CLOUD_MODEL;item.uploadState='Uploaded';window.auditFeatures?.uploadComplete?.(item);if(saved.promptHash)$('prompt-id').textContent='Prompt ID: '+saved.promptHash.slice(0,12);logEvent('photo-upload-complete',{id:saved.id,job:saved.jobId,promptHash:saved.promptHash});uploaded.push(item);
  }catch(error){item.state='error';item.uploadFailed=true;item.uploadState='Upload failed';item.error=error.message;logEvent('photo-upload-error',{message:error.message,status:error.status||0});}
  render();
 }});
 if(uploaded.length)recordAction({label:'Add photos',session:targetSession,async undo(){if(sessionId!==targetSession)throw Error(t('Open the original session to undo this action.'));await moveToTrash(uploaded.map(photo=>photo.remoteId?items.find(item=>item.remoteId===photo.remoteId):photo).filter(Boolean),targetSession);}});render();
}
async function mutateSession(action){if(exporting)return;writeOperations++;syncBusy=true;render();try{const operation=action();render();await operation;}catch(e){logEvent('session-operation-error',{message:e.message,status:e.status||0});status(e.message,true);}finally{writeOperations--;syncBusy=writeOperations>0;render();if(!writeOperations&&pendingUpdates)refreshSession();}}
function processingSettings(){
 const consent=$('cloud-consent').checked;
 if(!consent)return {consent:false,prompt:''};
 const prompt=languagePrompt(resolvePrompt('custom',$('category-prompt').value))+' Keep the description to one sentence, as short as possible.'+(sessionCategories.length?' Allowed categories (use exactly one): '+categories().join(', ')+'.':'');
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
  const before=photoSnapshot(item),targetSession=sessionId;item.dirty=true;render();
  try{const settings=processingSettings();const saved=await sessionAPI('/'+targetSession+'/photos/'+item.remoteId+'/classify','POST',{revision:item.revision,...settings});Object.assign(item,{state:saved.state,jobId:saved.jobId,revision:saved.revision,userRevision:saved.userRevision,promptHash:saved.promptHash,model:CLOUD_MODEL,error:'',processingAttempts:0});if(saved.promptHash)$('prompt-id').textContent='Prompt ID: '+saved.promptHash.slice(0,12);logEvent('cloud-job-queued',{photo:item.remoteId,job:saved.jobId,promptHash:saved.promptHash});recordPhotos('Reclassify',[before],targetSession);}
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
function historyLimit(){const value=Number($('undo-limit').value);return Number.isInteger(value)&&value>=1&&value<=100?value:20;}
function recordAction(entry){if(undoing)return;if(groupedHistory&&entry.photos&&entry.session===groupedHistory.session){groupedHistory.photos.push(...entry.photos);return;}window.auditFeatures?.actionRecorded?.(entry);undoStack.push(entry);undoStack=undoStack.slice(-historyLimit());}
function photoSnapshot(item){return {item,order:item.order||0,remoteId:item.remoteId,state:item.state,category:item.category||'',description:item.description||'',rawOutput:item.rawOutput||'',error:item.error||''};}
function recordPhotos(label,photos,targetSession){
 if(!photos.length||undoing)return;
 for(const saved of photos){saved.revision??=saved.item?.revision;saved.userRevision??=saved.item?.userRevision||saved.revision;}
 recordAction({label,session:targetSession,photos,async undo(){
  if(sessionId!==targetSession)throw Error(t('Open the original session to undo this action.'));
  for(const saved of [...this.photos]){
   const item=saved.remoteId?items.find(photo=>photo.remoteId===saved.remoteId):saved.item;
   if(!item||item.shredded||!items.includes(item)){this.photos=this.photos.filter(p=>p!==saved);continue;}
   if((item.userRevision||item.revision)!==saved.userRevision){status(t('This photo changed in the cloud. Undo skipped to protect newer changes.'),true);this.photos=this.photos.filter(p=>p!==saved);continue;}
   const restart=['processing','pending'].includes(saved.state);
   const changes={order:saved.order||0,state:restart?'review':saved.state,category:saved.category,description:saved.description,rawOutput:saved.rawOutput};
   if(item.remoteId){await savePhoto(targetSession,item,changes);if(restart&&!item.shredded&&!item.conflict&&canRun()){const result=await sessionAPI('/'+targetSession+'/photos/'+item.remoteId+'/classify','POST',{revision:item.revision,...processingSettings()});Object.assign(item,{state:result.state,revision:result.revision,userRevision:result.userRevision,jobId:result.jobId});}}
   else Object.assign(item,changes,{expiresAt:0,error:saved.error});
   this.photos=this.photos.filter(p=>p!==saved);rebaseUndo(item);render();
  }
 }});
}
function rebaseUndo(item){for(let i=undoStack.length-2;i>=0;i--){const saved=undoStack[i].photos?.find(p=>p.item===item||(p.remoteId&&p.remoteId===item.remoteId&&undoStack[i].session===sessionId));if(saved){saved.revision=item.revision;saved.userRevision=item.userRevision||item.revision;break;}}}
async function moveToTrash(photos,targetSession){
 const removed=[];
 try{for(const item of photos){
  if(sessionId!==targetSession)break;
  if(item.shredded||['trash','uploading'].includes(item.state))continue;
  const saved=photoSnapshot(item);
  if(item.remoteId)await savePhoto(targetSession,item,{state:'trash'});else{item.state='trash';item.expiresAt=Date.now()/1000+172800;}
  if(item.state==='trash'&&!item.shredded)removed.push(saved);
  render();
 }}finally{recordPhotos('Move to Trash',removed,targetSession);}
}
$('undo').onclick=async()=>{
 if(!undoStack.length||undoing||writeOperations>0)return;
 const entry=undoStack.at(-1);undoing=true;
 try{await mutateSession(async()=>{await entry.undo();undoStack=undoStack.filter(candidate=>candidate!==entry);});}finally{undoing=false;render();}
};
function openDeleteConfirmation(){
 const shred=activeCategory==='Trash';
 const photos=items.filter(item=>!item.shredded&&(shred?item.state==='trash':!['trash','uploading'].includes(item.state)));
 if(!photos.length||exporting||writeOperations>0)return;
 deleteRequest={session:sessionId,shred,photos:[...photos]};
 $('delete-dialog-title').textContent=t(shred?'Shred all photos?':'Delete all photos?');
 $('delete-dialog-description').textContent=photos.length+' · '+t(shred?'Permanently deletes photos in Trash. This cannot be undone.':'Moves photos to Trash for 2 days. You can undo this.');
 $('confirm-delete').textContent=t(shred?'Shred all':'Delete all');$('delete-dialog').showModal();$('cancel-delete').focus?.();
}
const cancelDeleteHold=bindHoldAction($('clear'),{seconds:()=>Number($('delete-hold-seconds').value),ready:openDeleteConfirmation});
window.addEventListener('blur',cancelDeleteHold);
document.addEventListener?.('visibilitychange',()=>{if(document.hidden)cancelDeleteHold();});
$('cancel-delete').onclick=()=>{$('delete-dialog').close();deleteRequest=null;};
$('delete-dialog').addEventListener('close',()=>{deleteRequest=null;});
$('confirm-delete').onclick=async()=>{
 const request=deleteRequest;if(!request)return;deleteRequest=null;$('delete-dialog').close();
 if(sessionId!==request.session)return;
 await mutateSession(async()=>{
  if(!request.shred){await moveToTrash(request.photos,request.session);return;}
  for(const item of request.photos){if(sessionId!==request.session)break;if(item.state!=='trash'||item.shredded)continue;
   if(item.remoteId){try{await sessionAPI('/'+request.session+'/photos/'+item.remoteId,'DELETE',{permanent:true});}catch(error){if(error.status!==404)throw error;}}
   item.shredded=true;render();
  }
 });
};

$('undo-limit').value=readSetting('audit-undo-limit',String(defaults.interface.undoLimit));
if(!Number.isInteger(Number($('undo-limit').value))||Number($('undo-limit').value)<1||Number($('undo-limit').value)>100)$('undo-limit').value='20';
$('undo-limit').onchange=()=>{const value=historyLimit();$('undo-limit').value=String(value);saveSetting('audit-undo-limit',String(value));undoStack=undoStack.slice(-value);render();};
const settingBaselines=new Map();
function trackSetting(id,property='value'){
 const control=$(id);settingBaselines.set(id,control[property]);
 control.addEventListener('change',()=>{
  const before=settingBaselines.get(id),beforeLayout=rememberedLayout,after=control[property];
  settingBaselines.set(id,after);rememberedLayout=$('export-layout').value;
  if(id==='export-type'){saveSetting('audit-export-layout',rememberedLayout);settingBaselines.set('export-layout',rememberedLayout);}
  if(id.startsWith('export-'))saveSetting('audit-'+id,String(after));
  if(before===after||undoing)return;
  recordAction({label:'Change settings',async undo(){
   control[property]=before;control.dispatchEvent(new Event('change',{bubbles:true}));
   if(id==='export-type'){$('export-layout').value=beforeLayout;saveSetting('audit-export-layout',beforeLayout);settingBaselines.set('export-layout',beforeLayout);}
   settingBaselines.set(id,control[property]);rememberedLayout=$('export-layout').value;render();
  }});render();
 });
}
for(const id of ['export-type','export-orientation','export-columns','export-rows','export-layout','category-prompt','delete-hold-seconds','undo-limit','language'])trackSetting(id);
for(const id of ['cloud-consent','show-photo-details','show-diagnostics','left-handed','export-description'])trackSetting(id,'checked');
$('reset-prompt').onclick=()=>{$('category-prompt').value=CATEGORY_PROMPT;$('category-prompt').dispatchEvent(new Event('change',{bubbles:true}));};
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
  const options={onProgress:(page,total)=>{$('export-status').textContent=(getLanguage()==='es'?'Creando página PNG ':'Creating PNG page ')+page+'/'+total;},type,rows:$('export-rows').value,columns:$('export-columns').value,layout:$('export-layout').value,showDescription:$('export-description').checked,orientation:$('export-orientation').value,language:getLanguage()};
  for(const item of items)if(item.state==='done'&&!item.exportImage&&item.preparedUrl)item.exportImage=await imageData(item.preparedUrl);
  const {createDocument}=await import('./export-document.js');
  const blob=await createDocument(window.auditFeatures?.exportItems?.()||items,options);
  if(exportURL)URL.revokeObjectURL(exportURL);
  exportURL=URL.createObjectURL(blob);const link=document.createElement('a');link.href=exportURL;link.download=`audit-${new Date().toISOString().slice(0,10)}.${blob.type==='application/zip'?'zip':type}`;document.body.append(link);link.click();link.remove();
  const createdURL=exportURL;setTimeout(()=>{URL.revokeObjectURL(createdURL);if(exportURL===createdURL)exportURL=null;},60000);
  $('export-status').textContent=t(type==='png'?(blob.type==='application/zip'?'PNG pages created. ZIP download started.':'PNG created. Download started.'):'Document created. Download started.');
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
 const targetSession=sessionId,cleanupUndo=[];let moved=0;cleaningDuplicates=true;render();
 try{
  for(;;){
   const result=await sessionAPI('/'+targetSession+'/deduplicate','POST');moved+=result.moved||0;cleanupUndo.push(...(result.undoPhotos||[]));
   $('hash-index-status').textContent=t('Duplicate copies moved to Trash:')+' '+moved;
   if(result.moved&&sessionId===targetSession){pendingUpdates=true;syncIcon();}
   if(!result.remaining){if(result.unindexed)$('hash-index-status').textContent+=' · '+t('Index remaining photos to check all duplicates.');break;}
   if(!result.moved)throw Error('Duplicate cleanup did not make progress. Retry.');
  }
  if(moved)await refreshSession();
 }catch(error){cleanupUndo.push(...(error.data?.undoPhotos||[]));$('hash-index-status').textContent=t('Duplicate cleanup stopped. Retry to continue.')+' '+moved;logEvent('duplicate-cleanup-error',{message:error.message});}
 finally{cleaningDuplicates=false;render();if(pendingUpdates||cleanupUndo.length)await refreshSession();const photos=cleanupUndo.map(saved=>({...saved.before,remoteId:saved.before.id,revision:saved.revision,userRevision:saved.revision}));recordPhotos('Move duplicate copies to Trash',photos,targetSession);render();}
};
window.addEventListener('pagehide',()=>hashIndexController?.abort());
function syncIcon(){
 const icon=$('sync-cloud');icon.hidden=!shared;icon.setAttribute('data-updates',String(pendingUpdates));
 icon.disabled=syncing||exporting||retrying||cleaningDuplicates||writeOperations>0;
 icon.title=t(syncError?'Could not sync. Press to retry.':pendingUpdates?'Syncing updates…':'Synchronized');
 icon.setAttribute('aria-label',icon.title);
}
function sessionSignature(sessions){return JSON.stringify(sessions.filter(s=>!s.deleting).map(s=>[s.id,s.name,s.revision,s.categories]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
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
  pendingUpdates ||= changed;syncError='';syncIcon();if(pendingUpdates)await refreshSession();
 }catch(e){if(sessionId===checkedSession&&generation===syncGeneration){syncError=e.message;syncIcon();}}
 finally{checkingSync=false;}
}
async function refreshSession(){
 if(syncing){refreshQueued=true;return;}
 if(!shared||pickerOpen||syncing||exporting||cleaningDuplicates)return;
 const polledSession=sessionId,before=syncFingerprint(),knownAtStart=new Map(items.filter(item=>item.remoteId).map(item=>[item.remoteId,item.revision]));syncing=true;syncGeneration++;syncIcon();
 try{const listing=await sessionAPI();if(sessionId!==polledSession)return;syncSessionChoices(listing.sessions);
 if(!sessionId){items=[];pendingUpdates=false;syncError='';$('session-status').textContent='No sessions yet. Create one to add photos.';if(before!==syncFingerprint())render();return;}
 const requestedSession=sessionId,data=await sessionAPI('/'+requestedSession,'GET',undefined,{conditional:false});
 const categoriesChanged=JSON.stringify(sessionCategories)!==JSON.stringify(listing.sessions.find(s=>s.id===requestedSession)?.categories||[]);sessionCategories=listing.sessions.find(s=>s.id===requestedSession)?.categories||[];
 const merged=await mergePhotos(items,data.photos,{knownAtStart});
 if(!shared||sessionId!==requestedSession)return;
 items=[...new Map(merged.filter(item=>!item.shredded).map(item=>[item.remoteId||item,item])).values()];pendingUpdates=false;syncError='';$('session-status').textContent='Synced';if(categoriesChanged||before!==syncFingerprint())render();
 }catch(e){syncError=e.message;$('session-status').textContent=e.message;}finally{syncing=false;syncIcon();if(refreshQueued){refreshQueued=false;await refreshSession();}}
}
$('sync-cloud').onclick=()=>refreshSession();
async function loadSession(id){if(exporting)return;cancelDeleteHold();sessionId=id;sessionCategories=[];saveSetting('audit-session',id);items=[];duplicateCount=0;pendingUpdates=false;syncError='';syncGeneration++;render();await refreshSession();if(canRun())queueWaitingPhotos();}
async function initSharedSessions(){
 if(typeof authConfig!=='function')return;
 try{const config=await authConfig();if(!config.enabled){accountReady=false;status('Background categorization requires a deployed signed-in session. Use Describe for a local single photo.',true);return;}if(!credentials()){location.replace('./login.html');return;}shared=true;$('sessions-panel').hidden=false;$('sign-out').hidden=false;$('sign-out').onclick=()=>{shared=false;accountReady=false;items=[];undoStack=[];cancelDeleteHold();closeOriginal();if(exportURL){URL.revokeObjectURL(exportURL);exportURL=null;}render();signOut();};
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
 $('new-session-form').onsubmit=async event=>{event.preventDefault();await mutateSession(async()=>{const session=await sessionAPI('','POST',{name:$('session-name').value.trim()});sessions.push(session);options();$('session-select').value=session.id;sessionId=session.id;sessionCategories=session.categories||[];saveSetting('audit-session',session.id);items=[];$('session-dialog').close();});};
 accountReady=true;render();setInterval(checkSession,5000);window.addEventListener('focus',checkSession);window.addEventListener('pageshow',()=>{if(shared&&!credentials())location.replace('./login.html');});
 }catch(e){status(e.message,true);$('pick').disabled=true;}
}

window.auditBridge={async group(action){const group={session:sessionId,photos:[]};groupedHistory=group;try{await action()}finally{groupedHistory=null;recordPhotos('Edit photos',group.photos,group.session);}},get items(){return items},get session(){return sessionId},get categories(){return categories()},setCategories(value){sessionCategories=value;render()},render,async edit(photo,changes){const before=photoSnapshot(photo),target=sessionId;await mutateSession(async()=>{await savePhoto(target,photo,changes);recordPhotos('Edit photos',[before],target)});},async trash(photos){await mutateSession(()=>moveToTrash(photos,sessionId))},reclassify:requestReclassification,async resume(files){await $('photos').onchange({target:{files,value:''}})},notify:message=>status(message,true),async previewItems(){const chosen=window.auditFeatures?.exportItems?.()||items;for(const item of chosen)if(item.state==='done'&&!item.exportImage&&item.preparedUrl)item.exportImage=await imageData(item.preparedUrl);return chosen;}};
window.dispatchEvent?.(new Event('audit-ready'));
