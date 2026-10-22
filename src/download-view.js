export function createDownloadView(container){
 const files=new Map();
 return {
  reset(){files.clear();container.replaceChildren();},
  update(p){
   if(!p.file)return;
   const name=p.file.includes('/resolve/')?p.file.split('/resolve/')[1].split('/').slice(1).join('/'):p.file;
   let row=files.get(name);const isNew=!row;
   if(!row){const element=document.createElement('div');element.className='download-file';const label=document.createElement('p');label.textContent=name;const bar=document.createElement('progress');bar.max=100;bar.setAttribute('aria-label',`Download ${name}`);const detail=document.createElement('span');detail.className='small';element.append(label,bar,detail);container.append(element);row={element,bar,detail,network:false,complete:false,rank:1};files.set(name,row);}
   if(p.transfer)row.network=true;
   if(row.complete&&p.status!=='error')return;
   const rank=['download','progress'].includes(p.status)?0:['done','unavailable'].includes(p.status)?3:p.status==='error'?2:1;
   const reorder=isNew||row.rank!==rank;row.rank=rank;
   const mb=n=>`${(n/1024/1024).toFixed(1)} MB`;
   if(p.status==='done'){row.complete=true;row.bar.value=100;row.detail.textContent=row.network?'Downloaded':'Ready from cache';}
   else if(p.status==='unavailable'){row.complete=true;row.bar.value=0;row.detail.textContent='Not supplied by this model';}
   else if(p.status==='error'){row.detail.textContent='Download failed';row.bar.removeAttribute('value');}
   else if(p.status==='queued'){row.bar.value=0;row.detail.textContent=`Waiting${p.total?' · '+mb(p.total):''}`;}
   else if(p.status==='progress'){if(Number.isFinite(p.progress))row.bar.value=p.progress;else row.bar.removeAttribute('value');row.detail.textContent=`${mb(p.loaded||0)}${p.total?' / '+mb(p.total):''}`;}
   else{row.bar.removeAttribute('value');row.detail.textContent=p.status==='initiate'?'Checking cache…':'Downloading…';}
   if(reorder)container.replaceChildren(...[...files.values()].sort((a,b)=>a.rank-b.rank).map(file=>file.element));
  },
 };
}
