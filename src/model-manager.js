import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { MODELS } from './models.js';
import { availableModels,removeModel } from './model-storage.js';
import { createDownloadView } from './download-view.js';
import { friendlyError } from './core.js';
const $=id=>document.getElementById(id);const downloads=createDownloadView($('file-downloads'));
let installed=[],supported=false,fp16=false,worker=null,busy=false;
const status=text=>{$('status').textContent=text;};
function render(){
 $('model-list').replaceChildren();$('cancel').hidden=!busy;$('spinner').hidden=!busy;
 for(const [key,model] of Object.entries(MODELS)){
  const card=document.createElement('section');card.className='model-note';
  const title=document.createElement('h2');title.textContent=model.label;
  const detail=document.createElement('p');detail.textContent=`${model.download}. ${model.hint}`;
  const state=document.createElement('p');state.textContent=installed.includes(key)?'Downloaded and verified':'Not verified as fully downloaded';
  const button=document.createElement('button');button.className='primary';button.textContent=installed.includes(key)?'Verify again':'Download / verify';button.disabled=busy||!supported;button.onclick=()=>load(key);
  const remove=document.createElement('button');remove.className='quiet';remove.textContent='Delete cached files';remove.disabled=busy;remove.onclick=async()=>{busy=true;render();try{await removeModel(key);installed=await availableModels(fp16);status('Cached model files deleted.');}catch(error){status(error.message);}finally{busy=false;render();}};
  card.append(title,detail,state,button,remove);$('model-list').append(card);
 }
}
function stop(){worker?.terminate();worker=null;busy=false;render();}
function load(key){
 if(busy||!supported)return;busy=true;downloads.reset();render();status(`Preparing ${MODELS[key].label}…`);
 navigator.storage?.persist?.().catch(()=>{});
 try{worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});const current=worker;
 worker.onmessage=async({data})=>{
  if(worker!==current)return;
  if(data.type==='progress')downloads.update(data.progress);
  if(data.type==='ready'){installed=await availableModels(fp16);if(worker!==current)return;stop();status('Downloaded and verified. This model is now available on the photo pages.');}
  if(data.type==='error'){stop();status(friendlyError(data.message));}
 };
 worker.onerror=event=>{event.preventDefault();if(worker!==current)return;stop();status(friendlyError(event.message));};
 worker.postMessage({type:'load',model:key});
 }catch(error){stop();status(friendlyError(error.message));}
}
$('cancel').onclick=()=>{stop();status('Cancelled. Completed cached files can be reused on retry.');};
window.addEventListener('pagehide',stop);
registerSW();
(async()=>{try{const adapter=await navigator.gpu?.requestAdapter();supported=!!adapter;fp16=!!adapter?.features?.has('shader-f16');installed=await availableModels(fp16);}catch{}render();status(supported?'Choose a model to download or verify.':'This browser does not provide a compatible WebGPU adapter.');})();
