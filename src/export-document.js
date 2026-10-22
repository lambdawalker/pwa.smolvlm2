import { exportPlan } from './export-plan.js';
const title=page=>page.category+(page.part>1?` (continued ${page.part})`:'');
export async function createDocument(items,options){
 const plan=exportPlan(items,options);
 return plan.type==='docx'?word(plan):powerpoint(plan);
}
async function word(plan){
 const d=await import('docx');
 const {Document,Packer,Paragraph,TextRun,ImageRun,Table,TableRow,TableCell,WidthType,BorderStyle,PageOrientation,HeadingLevel}=d;
 const border={style:BorderStyle.SINGLE,size:4,color:'D9D9D9'};
 const none={style:BorderStyle.NONE,size:0,color:'FFFFFF'};
 const pageWidth=plan.orientation==='portrait'?9900:14800;
 const cellWidth=Math.floor(pageWidth/plan.columns);
 const rowHeight=(plan.orientation==='portrait'?9:5.9)/plan.rows;
 const imageSize=Math.min({small:.75,medium:1.15,big:1.75}[plan.imageSize],rowHeight-.22,cellWidth/1440*(plan.showDescription?.48:.85));
 const children=[];
 plan.pages.forEach((page,pageIndex)=>{
  children.push(new Paragraph({text:title(page),heading:HeadingLevel.HEADING_1,pageBreakBefore:pageIndex>0,spacing:{after:220}}));
  const rows=[];
  for(let r=0;r<Math.ceil(page.items.length/plan.columns);r++){
   const cells=[];
   for(let c=0;c<plan.columns;c++){
    const item=page.items[r*plan.columns+c];
    const parts=item?[new Table({width:{size:cellWidth-240,type:WidthType.DXA},columnWidths:[Math.round(imageSize*1440)+120,cellWidth-360-Math.round(imageSize*1440)],borders:{top:none,bottom:none,left:none,right:none,insideHorizontal:none,insideVertical:none},rows:[new TableRow({cantSplit:true,children:[
     new TableCell({borders:{top:none,bottom:none,left:none,right:none},children:[new Paragraph({children:[new ImageRun({type:'jpg',data:Uint8Array.from(atob(item.image.split(',')[1]),c=>c.charCodeAt(0)),transformation:{width:imageSize*96,height:imageSize*96}})]})]}),
     new TableCell({borders:{top:none,bottom:none,left:none,right:none},children:[new Paragraph({children:[new TextRun({text:plan.showDescription?item.description:'',size:plan.columns===4?18:20})],spacing:{after:0}})]})
    ]})]}),new Paragraph({spacing:{after:0,before:0},children:[]})]:[new Paragraph('')];
    cells.push(new TableCell({width:{size:cellWidth,type:WidthType.DXA},margins:{top:120,bottom:120,left:120,right:120},shading:plan.layout==='cards'?{fill:'F0F5F2'}:undefined,borders:{top:border,bottom:border,left:border,right:border},children:parts}));
   }
   rows.push(new TableRow({cantSplit:true,children:cells}));
  }
  children.push(new Table({width:{size:pageWidth,type:WidthType.DXA},columnWidths:Array(plan.columns).fill(cellWidth),cellSpacing:{value:plan.layout==='cards'?80:0},rows}));
 });
 return Packer.toBlob(new Document({styles:{default:{document:{run:{font:'Calibri',size:20}},heading1:{run:{color:'000000',size:32,bold:true}}}},sections:[{properties:{page:{size:{orientation:plan.orientation==='portrait'?PageOrientation.PORTRAIT:PageOrientation.LANDSCAPE,width:11906,height:16838},margin:{top:600,bottom:600,left:720,right:720}}},children}]}));
}
async function powerpoint(plan){
 const {default:PptxGenJS}=await import('pptxgenjs');
 const pptx=new PptxGenJS();pptx.defineLayout({name:'AUDIT_PORTRAIT',width:7.5,height:13.333});pptx.layout=plan.orientation==='portrait'?'AUDIT_PORTRAIT':'LAYOUT_WIDE';pptx.author='Audit';pptx.subject='Categorized photos';pptx.title='Photo categories';pptx.lang='en-US';
 const contentWidth=plan.orientation==='portrait'?6.5:12.33,contentHeight=plan.orientation==='portrait'?11.68:5.85;
 const gap=plan.layout==='cards'?.16:0,w=(contentWidth-gap*(plan.columns-1))/plan.columns,h=(contentHeight-gap*(plan.rows-1))/plan.rows;
 for(const page of plan.pages){
  const slide=pptx.addSlide();slide.background={color:'FFFFFF'};
  slide.addText(title(page),{x:.5,y:.25,w:contentWidth,h:.55,fontSize:26,bold:true,color:'000000',margin:0});
  page.items.forEach((item,i)=>{
   const x=.5+(i%plan.columns)*(w+gap),y=1+Math.floor(i/plan.columns)*(h+gap),size=Math.min({small:.85,medium:1.3,big:2.1}[plan.imageSize],h-.2,w*(plan.showDescription?.45:.85));
   if(plan.layout==='table')slide.addTable([['',plan.showDescription?item.description:'']],{x,y,w,h,rowH:h,colW:[size+.2,w-size-.2],fontSize:11,margin:.1,border:{type:'solid',pt:.6,color:'D9D9D9'},color:'222222',valign:'mid',autoPage:false});
   else {
    slide.addShape(pptx.ShapeType.roundRect,{x,y,w,h,rectRadius:.08,fill:{color:'F0F5F2'},line:{color:'D9D9D9',width:.6},radius:.08});
    if(plan.showDescription)slide.addText(item.description,{x:x+size+.2,y:y+.1,w:w-size-.3,h:h-.2,fontSize:11,color:'222222',margin:0,breakLine:false,fit:'shrink',valign:'mid'});
   }
   slide.addImage({data:item.image,x:x+.1,y:y+(h-size)/2,w:size,h:size});
  });
 }
 return pptx.write({outputType:'blob'});
}
