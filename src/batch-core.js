export const CATEGORIES=['Indoors','Outdoors','Documents','Computer screens'];
export const CATEGORY_PROMPT='Classify this image into exactly one category: Indoors, Outdoors, Documents, Computer screens. If the main subject is a computer monitor or a screenshot of a computer interface, choose Computer screens. If the main subject is a page, receipt, form, or printed document, choose Documents. Otherwise choose Indoors for an interior scene or Outdoors for an exterior scene. Reply with only the category name.';
export function parseCategory(text){
 const normalized=String(text).trim().replace(/^["'`\s]+|["'`.\s]+$/g,'').toLowerCase();
 return CATEGORIES.find(category=>category.toLowerCase()===normalized)??null;
}
export async function runBatch(items,classify,changed,cancelled){
 for(const item of items){
  if(cancelled())break;
  if(item.state!=='pending')continue;
  item.state='processing';changed();
  try{
   const answer=await classify(item);
   if(cancelled()){item.state='pending';break;}
   item.rawOutput=String(answer);item.category=parseCategory(answer);item.state=item.category?'done':'review';item.error=item.category?'':'The model did not return a clear category. Choose one below.';
  }catch(error){if(cancelled()){item.state='pending';break;}item.state='error';item.error=error.message;if(error.pauseBatch){changed();break;}}
  changed();
 }
 changed();
}
