import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { PROMPTS, friendlyError } from './core.js';
import { preparePhoto } from './image.js';
const $=id=>document.getElementById(id);
let photo=null,worker=null,busy=false,supported=false,pickVersion=0,installPrompt;
const status=message=>{$('status').textContent=message;};
function setBusy(value){busy=value;$('describe').disabled=value||!photo||!supported;$('pick').disabled=value;$('remove').disabled=value;$('style').disabled=value;$('clear').disabled=value;$('cancel').hidden=!value;$('reload').disabled=value;}
function stopWorker(){worker?.terminate();worker=null;}
function startWorker(){
 if(worker)return worker;
 worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
 worker.onmessage=({data})=>{
  switch(data.type){
   case 'loading':status('Downloading or restoring the model…');$('progress-area').hidden=false;break;
   case 'progress':{
    const p=data.progress;if(p.status==='progress'){
     if(Number.isFinite(p.progress))$('progress').value=p.progress;else $('progress').removeAttribute('value');
     $('progress-label').textContent=`${p.file?.split('/').at(-1)||'Model file'} · ${Math.round(p.loaded/1024/1024)||0} MB${p.total?` / ${Math.round(p.total/1024/1024)} MB`:''}`;
    }else if(p.status==='done'){$('progress-label').textContent='File ready. Preparing the remaining model…';}
    break;
   }
   case 'ready':$('progress-area').hidden=true;status('Preparing your photo…');break;
   case 'generating':$('result-box').hidden=false;status('Looking closely…');break;
   case 'token':$('result').textContent+=data.text;break;
   case 'complete':$('result').textContent=data.text||'No description returned. Try another photo.';$('timing').textContent=`${data.seconds.toFixed(1)}s · on device`;$('copy').disabled=!data.text;setBusy(false);status('Description complete.');break;
   case 'error':fail(data.message);break;
  }
 };
 worker.onerror=event=>{event.preventDefault();fail(event.message||'Could not start the AI worker. Reload and try again.');};
 return worker;
}
function fail(message){stopWorker();setBusy(false);$('progress-area').hidden=true;status(friendlyError(message));$('copy').disabled=!$('result').textContent;}
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
 setBusy(true);$('result').textContent='';$('result-box').hidden=true;$('timing').textContent='';$('copy').disabled=true;$('progress').removeAttribute('value');
 status('Starting SmolVLM2…');
 // Best-effort persistence; denial never blocks inference.
 navigator.storage?.persist?.().catch(()=>{});
 try{startWorker().postMessage({type:'describe',image:photo.url,prompt:PROMPTS[$('style').value]});}catch(e){fail(e.message);}
};
$('cancel').onclick=()=>{stopWorker();setBusy(false);$('progress-area').hidden=true;$('copy').disabled=!$('result').textContent;status('Cancelled. Completed downloads can be reused on retry.');};
$('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('result').textContent);status('Description copied.');}catch{status('Copy unavailable. Select and copy the description manually.');}};
$('clear').onclick=async()=>{
 if(busy)return;stopWorker();
 try{await caches.delete('transformers-cache');status('Downloaded model cache deleted. The app itself remains available offline.');}catch{status('Could not clear model storage. Use browser site settings to clear it.');}
};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('appinstalled',()=>{$('install').hidden=true;});
const updateSW=registerSW({onNeedRefresh(){$('update').hidden=false;},onRegisterError(){status('Offline installation could not finish. You can still use the app online.');}});
$('reload').onclick=()=>{if(!busy)updateSW(true);};
(async()=>{
 try{supported=!!(await navigator.gpu?.requestAdapter());}catch{supported=false;}
 status(supported?'Choose a photo to begin. Model downloads only when you tap Describe.':'WebGPU is unavailable. Try updated Chrome on Android or Safari on iOS 26+ on a compatible device.');setBusy(false);
})();
