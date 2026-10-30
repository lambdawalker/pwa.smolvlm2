import {t} from './i18n.js';
import {exportPlan} from './export-plan.js';
export const pageTitle=(page,plan)=>t(page.category,plan.language)+(page.part>1?` (${plan.language==='es'?'continuación':'continued'} ${page.part})`:'');
export async function createDocument(items,options){const plan=exportPlan(items,options);if(plan.type==='png'){const {createPngExport}=await import('./export-png.js');return createPngExport(plan,options);}return plan.type==='docx'?word(plan):powerpoint(plan);}
// All layouts share a clean photo grid. A small gutter belongs to each cell;
// descriptions always sit below the photo and never compete alongside it.
export function gridGeometry(width,height,columns,rows,description){
 const gap=Math.min(.08,width/columns*.08,height/rows*.08);
 const w=(width-gap*(columns-1))/columns,h=(height-gap*(rows-1))/rows;
 const text=description?Math.min(.45,h*.30):0;
 return {gap,w,h,text,size:Math.max(.01,Math.min(w,h-text-(description?.035:0)))};
}
async function word(plan){
 const {Document,Packer,Paragraph,TextRun,ImageRun,Table,TableRow,TableCell,WidthType,BorderStyle,PageOrientation,HeadingLevel,TableLayoutType,AlignmentType}=await import('docx');
 const portrait=plan.orientation==='portrait',width=portrait?11906:16838,height=portrait?16838:11906;
 const contentWidth=(width-1440)/1440,contentHeight=(height-1200-760)/1440;
 const g=gridGeometry(contentWidth,contentHeight,plan.columns,plan.rows,plan.showDescription);
 const none={style:BorderStyle.NONE,size:0,color:'FFFFFF'},borders={top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none};
 const cellWidth=Math.floor(contentWidth*1440/plan.columns),children=[];
 const imageSize=Math.min(g.size,cellWidth/1440-g.gap); 
 for(const [pageIndex,page] of plan.pages.entries()){
  children.push(new Paragraph({text:pageTitle(page,plan),heading:HeadingLevel.HEADING_1,pageBreakBefore:pageIndex>0,spacing:{before:0,after:120}}));
  const rows=[];
  for(let r=0;r<Math.ceil(page.items.length/plan.columns);r++){
   const cells=[];
   for(let c=0;c<plan.columns;c++){
    const item=page.items[r*plan.columns+c],parts=[];
    if(item){parts.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:0,after:0,line:Math.ceil(imageSize*1440+8),lineRule:'exact'},children:[new ImageRun({type:'jpg',data:Uint8Array.from(atob(item.image.split(',')[1]),c=>c.charCodeAt(0)),transformation:{width:imageSize*96,height:imageSize*96}})]}));
     if(plan.showDescription){const font=Math.max(1,Math.min(9,Math.sqrt(g.text*g.w*5184/Math.max(item.description.length*.7,1))*.7));parts.push(new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:35,after:0,line:Math.ceil(font*24),lineRule:'exact'},children:[new TextRun({text:item.description,size:Math.round(font*2)})]}));}
    }else parts.push(new Paragraph({spacing:{after:0}}));
    cells.push(new TableCell({width:{size:cellWidth,type:WidthType.DXA},borders,margins:{top:0,bottom:Math.round(g.gap*1440),left:Math.round(g.gap*720),right:Math.round(g.gap*720)},children:parts}));
   }
   rows.push(new TableRow({cantSplit:true,children:cells}));
  }
  children.push(new Table({width:{size:cellWidth*plan.columns,type:WidthType.DXA},layout:TableLayoutType.FIXED,columnWidths:Array(plan.columns).fill(cellWidth),borders,rows}));
 }
 return Packer.toBlob(new Document({styles:{default:{document:{run:{font:'Calibri',size:18}},heading1:{run:{color:'000000',size:28,bold:true}}}},sections:[{properties:{page:{size:{orientation:portrait?PageOrientation.PORTRAIT:PageOrientation.LANDSCAPE,width:11906,height:16838},margin:{top:600,bottom:600,left:720,right:720}}},children}]}));
}
async function powerpoint(plan){
 const {default:PptxGenJS}=await import('pptxgenjs');const pptx=new PptxGenJS();
 pptx.defineLayout({name:'AUDIT_PORTRAIT',width:7.5,height:13.333});pptx.layout=plan.orientation==='portrait'?'AUDIT_PORTRAIT':'LAYOUT_WIDE';pptx.author='Audit';pptx.title='Photo categories';pptx.lang=plan.language==='es'?'es-MX':'en-US';
 const width=plan.orientation==='portrait'?6.7:12.53,height=plan.orientation==='portrait'?12.05:6.22;
 const g=gridGeometry(width,height,plan.columns,plan.rows,plan.showDescription);
 for(const page of plan.pages){const slide=pptx.addSlide();slide.addText(pageTitle(page,plan),{x:.4,y:.25,w:width,h:.45,fontSize:22,bold:true,color:'000000',margin:0});
  page.items.forEach((item,i)=>{const x=.4+i%plan.columns*(g.w+g.gap),y=.85+Math.floor(i/plan.columns)*(g.h+g.gap);
   slide.addImage({data:item.image,x:x+(g.w-g.size)/2,y,w:g.size,h:g.size});
   if(plan.showDescription)slide.addText(item.description,{x,y:y+g.size+.035,w:g.w,h:g.text,fontSize:Math.max(4,Math.min(11,g.h*13)),color:'222222',margin:0,fit:'shrink',valign:'top',align:'center',breakLine:false});
  });
 }
 return pptx.write({outputType:'blob'});
}
