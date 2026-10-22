export const CATEGORIES=['Indoors','Outdoors','Documents','Computer screens'];
export const CATEGORY_PROMPT='Classify this image into exactly one category: Indoors, Outdoors, Documents, Computer screens. If the main subject is a computer monitor or a screenshot of a computer interface, choose Computer screens. If the main subject is a page, receipt, form, or printed document, choose Documents. Otherwise choose Indoors for an interior scene or Outdoors for an exterior scene. Return only JSON: {"category":"one of these categories","description":"a short description, at most 180 characters"}.';
export function parseCategory(text){
 const normalized=String(text).trim().replace(/^["'`\s]+|["'`.\s]+$/g,'').toLowerCase();
 return CATEGORIES.find(category=>category.toLowerCase()===normalized)??null;
}
export const DESCRIPTION_LIMIT=180;
export function parseResult(text){
 try{
  const value=JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g,''));
  if(!value||typeof value.description!=='string'||!value.description.trim()||!CATEGORIES.includes(value.category))return null;
  return {category:value.category,description:Array.from(value.description.trim()).slice(0,DESCRIPTION_LIMIT).join('')};
 }catch{return null;}
}
export async function runBatch(items,classify,changed,cancelled,concurrency=1){
 let cursor=0,paused=false;
 const queue=items.filter(item=>item.state==='pending');
 async function consume(){
  while(!cancelled()&&!paused&&cursor<queue.length){
   const item=queue[cursor++];item.state='processing';changed();
   try{
    const answer=await classify(item);
    if(cancelled()){item.state='pending';break;}
    item.rawOutput=String(answer);const result=parseResult(answer);item.category=result?.category??null;item.description=result?.description??'';item.state=item.category?'done':'review';item.error=item.category?'':'The model did not return a clear category. Choose one below.';
   }catch(error){if(cancelled()){item.state='pending';break;}item.state='error';item.error=error.message;if(error.pauseBatch)paused=true;}
   changed();
  }
 }
 const slots=Math.max(1,Math.min(3,Math.floor(Number(concurrency))||1));
 await Promise.all(Array.from({length:slots},consume));changed();
}
