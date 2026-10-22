export const FLORENCE_TASKS = {
 caption:'<CAPTION>', detail:'<MORE_DETAILED_CAPTION>', ocr:'<OCR>', objects:'<OD>',
};
export function florenceTask(key){
 if(!Object.hasOwn(FLORENCE_TASKS,key))throw new Error('Choose a supported Florence task.');
 return FLORENCE_TASKS[key];
}
export function modelDtypes(family,fp16){
 const float=fp16?'fp16':'fp32';
 if(family==='florence')return {embed_tokens:float,vision_encoder:float,encoder_model:float,decoder_model_merged:fp16?'q4f16':'q4'};
 if(family==='moondream')return {embed_tokens:float,vision_encoder:'q8',decoder_model_merged:'q4'};
 return {embed_tokens:float,vision_encoder:float,decoder_model_merged:fp16?'q4f16':'q4'};
}
export async function prepareInputs(family,processor,tokenizer,image,prompt,task){
 if(family==='florence')return processor(image,processor.construct_prompts(task));
 if(family==='moondream')return {...tokenizer(`<image>\n\nQuestion: ${prompt}\n\nAnswer:`),...await processor(image)};
 const text=processor.apply_chat_template([{role:'user',content:[{type:'image'},{type:'text',text:prompt}]}],{add_generation_prompt:true});
 return processor(text,[image],{do_image_splitting:false});
}
export function decodeResult(family,processor,tokenizer,output,inputs,task,imageSize){
 if(family==='florence'){
  const text=processor.batch_decode(output,{skip_special_tokens:false})[0];
  const parsed=processor.post_process_generation(text,task,imageSize)[task];
  return typeof parsed==='string'?parsed.trim():JSON.stringify(parsed??{},null,2);
 }
 const generated=output.slice(null,[inputs.input_ids.dims.at(-1),null]);
 return tokenizer.batch_decode(generated,{skip_special_tokens:true})[0].trim();
}
