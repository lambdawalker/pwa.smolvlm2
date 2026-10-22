import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { resolvePrompt, friendlyError } from './core.js';
import { preparePhoto } from './image.js';
import { MODELS, DEFAULT_MODEL, getModel } from './models.js';
const $=id=>document.getElementById(id);
let photo=null,worker=null,busy=false,supported=false,pickVersion=0,installPrompt,modelReady=false,loadingModel=false;
let selectedModel=DEFAULT_MODEL,rememberedModel=false;
try{const saved=localStorage.getItem('little-lens-model');if(Object.hasOwn(MODELS,saved)){selectedModel=saved;rememberedModel=true;}}catch{}
$('model-select').value=selectedModel;
function updateModelDetails(){const m=getModel(selectedModel);$('model-details').textContent=`${m.download}. ${m.hint} M means millions of parameters, not megabytes.`;$('active-model').textContent=m.label;}
updateModelDetails();
const status=message=>{$('status').textContent=message;};
function activity(active){$('spinner').hidden=!active;$('activity').setAttribute('aria-busy',String(active));}
function showSetup(){ $('setup').hidden=false;$('workspace').hidden=true;$('continue').hidden=true;$('load-model').hidden=false; }
function loadModel(){
 if(busy||!supported)return;
 try{localStorage.setItem('little-lens-model',selectedModel);}catch{}
 loadingModel=true;setBusy(true);$('progress-area').hidden=false;$('progress').removeAttribute('value');$('progress-label').textContent='Connecting to model storage…';$('load-model').textContent='Loading model…';$('step-model').textContent='Downloading and preparing SmolVLM2…';status('Starting the model. This can take a few minutes on a phone.');
 navigator.storage?.persist?.().catch(()=>{});
 try{startWorker().postMessage({type:'load',model:selectedModel});}catch(e){fail(e.message);}
}
function setBusy(value){busy=value;$('model-select').disabled=value;$('change-model').disabled=value;$('custom-prompt').disabled=value;activity(value);$('load-model').disabled=value||!supported;$('describe').disabled=value||!photo||!supported;$('pick').disabled=value;$('remove').disabled=value;$('style').disabled=value;$('clear').disabled=value;$('cancel').hidden=!value;$('reload').disabled=value;}
function stopWorker(){worker?.terminate();worker=null;modelReady=false;}
function startWorker(){
 if(worker)return worker;
 worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
 const currentWorker=worker;
 worker.onmessage=({data})=>{
  if(worker!==currentWorker)return;
  switch(data.type){
   case 'loading':status('Downloading or restoring the model…');$('progress-area').hidden=false;break;
   case 'progress':{
    const p=data.progress;if(p.status==='progress'){
     if(Number.isFinite(p.progress))$('progress').value=p.progress;else $('progress').removeAttribute('value');
     $('progress-label').textContent=`${p.file?.split('/').at(-1)||'Model file'} · ${Math.round(p.loaded/1024/1024)||0} MB${p.total?` / ${Math.round(p.total/1024/1024)} MB`:''}`;
    }else if(p.status==='done'){$('progress-label').textContent='File ready. Preparing the remaining model…';}
    break;
   }
   case 'ready':modelReady=true;$('progress-area').hidden=true;
    if(loadingModel){loadingModel=false;setBusy(false);$('load-model').hidden=true;$('continue').hidden=false;$('step-model').textContent='✓ Model ready';status('All set! Continue to choose a photo.');}
    else status('Preparing your photo…');break;
   case 'generating':$('result-box').hidden=false;status('Looking closely…');break;
   case 'token':$('result').textContent+=data.text;break;
   case 'complete':$('result').textContent=data.text||'No description returned. Try another photo.';$('timing').textContent=`${data.seconds.toFixed(1)}s · on device`;$('copy').disabled=!data.text;setBusy(false);status('Description complete.');break;
   case 'error':fail(data.message);break;
  }
 };
 worker.onerror=event=>{event.preventDefault();if(worker!==currentWorker)return;fail(event.message||'Could not start the AI worker. Reload and try again.');};
 return worker;
}
function fail(message){stopWorker();if(loadingModel){loadingModel=false;showSetup();$('load-model').textContent='Retry download';$('step-model').textContent='Model could not load. Retry below.';}setBusy(false);$('progress-area').hidden=true;status(friendlyError(message));$('copy').disabled=!$('result').textContent;}
$('load-model').onclick=loadModel;
$('model-select').onchange=()=>{
 if(busy)return;
 const next=$('model-select').value;try{getModel(next);}catch{return;}
 if(next===selectedModel)return;
 stopWorker();selectedModel=next;updateModelDetails();showSetup();$('load-model').textContent='Download model';$('step-model').textContent='Download and prepare your selected model';$('progress-area').hidden=true;$('result-box').hidden=true;status('Model selected. Tap Download model to continue.');
};
$('change-model').onclick=()=>{if(busy)return;showSetup();if(modelReady){$('continue').hidden=false;$('load-model').hidden=true;}status('Choose a model, or continue with the current one.');$('model-select').focus();};
$('style').onchange=()=>{$('custom-prompt-area').hidden=$('style').value!=='custom';if($('style').value==='custom')$('custom-prompt').focus();};
$('continue').onclick=()=>{if(!modelReady)return;$('setup').hidden=true;$('workspace').hidden=false;status('Choose a photo to begin.');$('pick').focus();};
$('pick').onclick=()=>$('photo').click();
$('photo').onchange=async event=>{
 const file=event.target.files?.[0];if(!file)return;const version=++pickVersion;setBusy(true);$('cancel').hidden=true;status('Preparing your photo…');
 try{
  const next=await preparePhoto(file);if(version!==pickVersion)return;photo=next;
  $('preview').src=next.url;$('preview').hidden=false;$('empty').hidden=true;$('remove').hidden=false;
  $('photo-meta').textContent=`${next.width} × ${next.height}`;$('pick').textContent='↻ Change photo';$('result-box').hidden=true;
  status(supported?'Ready when you are.': 'Photo ready, but this browser does not provide WebGPU.');
 }catch(e){status(e.message);}finally{event.target.value='';setBusy(false);}
};
$('remove').onclick=()=>{photo=null;$('preview').removeAttribute('src');$('preview').hidden=true;$('empty').hidden=false;$('remove').hidden=true;$('result-box').hidden=true;$('photo-meta').textContent='One moment at a time';$('pick').textContent='＋ Choose a photo';setBusy(false);status('Choose a new photo.');};
$('describe').onclick=async()=>{
 if(busy||!photo||!supported)return;
 let prompt;try{prompt=resolvePrompt($('style').value,$('custom-prompt').value);}catch(e){status(e.message);$('custom-prompt').focus();return;}
 setBusy(true);$('result').textContent='';$('result-box').hidden=true;$('timing').textContent='';$('copy').disabled=true;$('progress').removeAttribute('value');
 status('Starting SmolVLM2…');
 // Best-effort persistence; denial never blocks inference.
 navigator.storage?.persist?.().catch(()=>{});
 try{startWorker().postMessage({type:'describe',image:photo.url,model:selectedModel,prompt});}catch(e){fail(e.message);}
};
$('cancel').onclick=()=>{stopWorker();if(loadingModel){loadingModel=false;showSetup();$('load-model').textContent='Retry download';$('step-model').textContent='Download cancelled';}setBusy(false);$('progress-area').hidden=true;$('copy').disabled=!$('result').textContent;status('Cancelled. Completed downloads can be reused on retry.');};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('result').textContent);status('Description copied.');}catch{status('Copy unavailable. Select and copy the description manually.');}};
$('clear').onclick=async()=>{
 if(busy)return;stopWorker();
 try{await caches.delete('transformers-cache');showSetup();$('load-model').textContent='Download model';$('step-model').textContent='Download and prepare SmolVLM2';status('Downloaded models cache deleted. The app itself remains available offline.');}catch{status('Could not clear model storage. Use browser site settings to clear it.');}
};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('appinstalled',()=>{$('install').hidden=true;});
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;},onRegisterError(){status('Offline installation could not finish. You can still use the app online.');}});
$('reload').onclick=()=>{if(!busy)updateSW(true);};
(async()=>{
 try{supported=!!(await navigator.gpu?.requestAdapter());}catch{supported=false;}
 $('step-browser').textContent=supported?'✓ Browser compatible':'Browser does not support WebGPU';
 status(supported?'Browser ready. Choose a model and tap Download model.':'WebGPU is unavailable. Try updated Chrome on Android or Safari on iOS 26+ on a compatible device.');setBusy(false);
 if(supported&&rememberedModel)loadModel();
})();
