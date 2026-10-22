import { defaults } from './defaults.generated.js';
import { CATEGORIES } from './batch-core.js';
export function exportPlan(items,{type=defaults.document.type,rows=defaults.document.rows,columns=defaults.document.columns,layout=defaults.document.layout,showDescription=defaults.document.addDescription,orientation=defaults.document.orientation,language=defaults.interface.language}={}){
 columns=Number(columns);rows=Number(rows);
 if(!Number.isInteger(rows)||rows<1||rows>12)throw Error('Choose 1–12 rows.');
 if(type==='docx')layout='table';
 if(!['docx','pptx'].includes(type)||!['cards','table'].includes(layout))throw Error('Choose a document type, rows, and layout.');
 if(!['portrait','landscape'].includes(orientation))throw Error('Choose portrait or landscape.');
 if(!Number.isInteger(columns)||columns<1||columns>12)throw Error('Choose 1–12 columns.');
 const perPage=rows*columns;
 const pages=[];
 for(const category of CATEGORIES){
  const group=items.filter(item=>item.state==='done'&&item.category===category);
  for(let i=0;i<group.length;i+=perPage)pages.push({category,part:i/perPage+1,items:group.slice(i,i+perPage).map(item=>({image:item.exportImage,description:item.description||'No description available.'}))});
 }
 if(!pages.length)throw Error('Categorize at least one photo before exporting.');
 if(pages.some(page=>page.items.some(item=>!item.image)))throw Error('An image is unavailable. Categorize that photo again before exporting.');
 return {type,perPage,columns,layout,language,showDescription,orientation,rows,pages};
}
