import { CATEGORIES } from './batch-core.js';
export function exportPlan(items,{type='docx',imageSize='medium',columns=2,layout='cards',showDescription=true,showCategory=false}={}){
 columns=Number(columns);
 if(!['docx','pptx'].includes(type)||!['cards','table'].includes(layout)||!['small','medium','big'].includes(imageSize))throw Error('Choose a document type, image size, and layout.');
 if(!Number.isInteger(columns)||columns<1||columns>4)throw Error('Choose 1–4 columns.');
 const rows={small:4,medium:3,big:2}[imageSize],perPage=rows*columns;
 const pages=[];
 for(const category of CATEGORIES){
  const group=items.filter(item=>item.state==='done'&&item.category===category);
  for(let i=0;i<group.length;i+=perPage)pages.push({category,part:i/perPage+1,items:group.slice(i,i+perPage).map(item=>({image:item.exportImage,description:item.description||'No description available.'}))});
 }
 if(!pages.length)throw Error('Categorize at least one photo before exporting.');
 if(pages.some(page=>page.items.some(item=>!item.image)))throw Error('An image is unavailable. Categorize that photo again before exporting.');
 return {type,perPage,columns,layout,imageSize,showDescription,showCategory,rows,pages};
}
