import { CATEGORIES } from './batch-core.js';
export function exportPlan(items,{type='docx',perPage=6,columns=2,layout='cards'}={}){
 perPage=Number(perPage);columns=Number(columns);
 if(!['docx','pptx'].includes(type)||!['cards','table'].includes(layout))throw Error('Choose a document type and layout.');
 if(!Number.isInteger(perPage)||perPage<1||perPage>12||!Number.isInteger(columns)||columns<1||columns>3||columns>perPage)throw Error('Use 1–12 images per page and 1–3 columns, no more columns than images.');
 if(Math.ceil(perPage/columns)>4)throw Error('Use at most four rows per page. Increase columns or reduce images per page.');
 const pages=[];
 for(const category of CATEGORIES){
  const group=items.filter(item=>item.state==='done'&&item.category===category);
  for(let i=0;i<group.length;i+=perPage)pages.push({category,part:i/perPage+1,items:group.slice(i,i+perPage).map(item=>({image:item.exportImage,description:item.description||'No description available.'}))});
 }
 if(!pages.length)throw Error('Categorize at least one photo before exporting.');
 if(pages.some(page=>page.items.some(item=>!item.image)))throw Error('An image is unavailable. Categorize that photo again before exporting.');
 return {type,perPage,columns,layout,rows:Math.ceil(perPage/columns),pages};
}
