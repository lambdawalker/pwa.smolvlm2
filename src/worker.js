import { AutoProcessor, AutoTokenizer, AutoModelForVision2Seq, Florence2ForConditionalGeneration, Moondream1ForConditionalGeneration, RawImage, TextStreamer, env } from '@huggingface/transformers';
import { installModelDownloads } from './downloads.js';
import { recordModel } from './model-storage.js';
import { getModel } from './models.js';
import { florenceTask, modelDtypes, prepareInputs, decodeResult } from './inference.js';
env.allowLocalModels=false;
env.useBrowserCache=true;
env.backends.onnx.wasm.numThreads=1;
env.backends.onnx.wasm.wasmPaths=new URL(`${import.meta.env.BASE_URL}ort/`,self.location.origin).href;
let processor, tokenizer, model, modelKey, busy=false;
self.onmessage=async ({data})=>{
 if(!['load','describe'].includes(data.type)||busy)return;
 busy=true;
 const send=(type,extra={})=>self.postMessage({type,...extra});
 const stage=(phase,details={})=>send('diagnostic',{phase,details});
 stage('request received',{type:data.type,model:data.model,cachedOnly:!!data.cachedOnly});
 try{
  const selected=getModel(data.model);
  if(model && modelKey!==data.model)throw new Error('Restart the worker before changing models.');
  stage('requesting WebGPU adapter');
  const adapter=await navigator.gpu?.requestAdapter();
  if(!adapter)throw new Error('No compatible WebGPU adapter. Try an updated Chrome on Android or Safari on iOS 26+.');
  stage('WebGPU adapter ready',{fp16:adapter.features.has('shader-f16'),maxBufferSize:adapter.limits?.maxBufferSize,maxStorageBufferBindingSize:adapter.limits?.maxStorageBufferBindingSize});
  if(!model){
   send('loading');
   const files=new Set();
   const progress_callback=p=>{if(p.status==='done'&&!p.transfer)files.add(p.file);send('progress',{progress:p});};
   if(!data.cachedOnly)await installModelDownloads(selected,p=>progress_callback({...p,transfer:true}));
   stage('loading processor');
   processor=await AutoProcessor.from_pretrained(selected.id,{progress_callback,local_files_only:!!data.cachedOnly,revision:selected.revision});
   const fp16=adapter.features.has('shader-f16');
   stage('loading tokenizer');
   tokenizer=selected.family==='moondream'?await AutoTokenizer.from_pretrained(selected.id,{progress_callback,local_files_only:!!data.cachedOnly,revision:selected.revision}):processor.tokenizer;
   const Model=selected.family==='florence'?Florence2ForConditionalGeneration:selected.family==='moondream'?Moondream1ForConditionalGeneration:AutoModelForVision2Seq;
   stage('loading ONNX sessions',{dtype:modelDtypes(selected.family,fp16)});
   model=await Model.from_pretrained(selected.id,{
    local_files_only:!!data.cachedOnly,revision:selected.revision,device:'webgpu',dtype:modelDtypes(selected.family,fp16),progress_callback,
   });
   if(!data.cachedOnly)await recordModel(data.model,fp16,files);
  }
  stage('model ready');
  modelKey=data.model;
  send('ready');
  if(data.type==='load')return;
  stage('decoding image');
  const image=await RawImage.fromURL(data.image);

  const task=selected.family==='florence'?florenceTask(data.task):undefined;
  stage('preparing model inputs',{width:image.width,height:image.height});
  const inputs=await prepareInputs(selected.family,processor,tokenizer,image,data.prompt,task);
  stage('generating',{tensors:Object.fromEntries(Object.entries(inputs).map(([key,value])=>[key,value?.dims]))});
  send('generating');const start=performance.now();
  const generation={...inputs,max_new_tokens:selected.family==='florence'?512:180,do_sample:false};
  if(selected.family!=='florence'){
   generation.repetition_penalty=1.1;
   generation.streamer=new TextStreamer(tokenizer,{skip_prompt:true,skip_special_tokens:true,callback_function:text=>send('token',{text})});
  }
  const output=await model.generate(generation);
  stage('decoding output');
  const result=decodeResult(selected.family,processor,tokenizer,output,inputs,task,image.size);
  send('complete',{text:result,seconds:(performance.now()-start)/1000});
 }catch(error){stage('worker error',{message:error.message,stack:error.stack});send('error',{message:error.message||String(error)});}
 finally{busy=false;}
};
