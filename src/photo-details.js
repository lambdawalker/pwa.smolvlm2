import { HASH_LABEL_LENGTH, precisionLabel } from './input-info.js';
export function jsonTokens(raw){
 let text;
 try{text=JSON.stringify(JSON.parse(String(raw).trim().replace(/^```(?:json)?\s*|\s*```$/g,'')),null,2);}catch{return [{text:String(raw),kind:''}];}
 const pattern=/"(?:\\.|[^"\\])*"\s*:|"(?:\\.|[^"\\])*"|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;
 const tokens=[];let offset=0;
 for(const match of text.matchAll(pattern)){
  if(match.index>offset)tokens.push({text:text.slice(offset,match.index),kind:''});
  const token=match[0];tokens.push({text:token,kind:token.startsWith('"')?(token.endsWith(':')?'key':'string'):token==='null'?'null':/^(true|false)$/.test(token)?'boolean':'number'});offset=match.index+token.length;
 }
 if(offset<text.length)tokens.push({text:text.slice(offset),kind:''});return tokens;
}
export function appendPhotoDetails(container,item,modelLabel,cloud=false,doc=document){
 const section=(title,fields)=>{
  const heading=doc.createElement('h3');heading.textContent=title;
  const list=doc.createElement('dl');list.className='photo-metadata';
  for(const [key,value] of fields){const term=doc.createElement('dt');term.textContent=key+':';const data=doc.createElement('dd');data.textContent=value;list.append(term,data);}
  container.append(heading,list);
 };
 const info=item.info;
 if(info){
  section('Original',[['Size',`${info.sourceWidth} × ${info.sourceHeight}`],['Format',info.sourceMime||'unknown'],['Bytes',String(info.sourceBytes??'unknown')]]);
  section('Sent',[['Size',`${info.width} × ${info.height}`],['Format','image/jpeg'],['Bytes',String(info.preparedBytes??'unknown')]]);
 }
 if(item.promptHash)section('Prompt',[['id',item.promptHash.slice(0,HASH_LABEL_LENGTH)],['model',modelLabel],['precision',cloud||!item.precision?'unknown':precisionLabel(item.precision)]]);
 if(item.rawOutput!==undefined){
  const heading=doc.createElement('h3');heading.textContent='Raw output:';
  const pre=doc.createElement('pre');pre.className='raw-output json-output';
  for(const token of jsonTokens(item.rawOutput)){const span=doc.createElement('span');span.className=token.kind?'json-'+token.kind:'';span.textContent=token.text;pre.append(span);}
  container.append(heading,pre);
 }
}
