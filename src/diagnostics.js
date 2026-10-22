const entries=[];
const clean=value=>String(value).replace(/data:[^\s"']+/g,'[image data omitted]');
export function logEvent(event,details={}){
 const entry={time:new Date().toISOString(),event,...details};
 const line=clean(JSON.stringify(entry));entries.push(line);if(entries.length>250)entries.shift();
 console.info('[Little Lens]',line);
 return line;
}
export function installDiagnostics(){
 logEvent('page-start',{path:location.pathname,userAgent:navigator.userAgent,secureContext:globalThis.isSecureContext,webgpu:!!navigator.gpu});
 const panel=document.createElement('details');panel.className='about';const title=document.createElement('summary');title.textContent='Troubleshooting logs';
 const help=document.createElement('p');help.textContent='If processing stalls, copy this report. Photos, filenames, prompts, and generated text are not included.';
 const copy=document.createElement('button');copy.className='quiet';copy.textContent='Copy diagnostic report';
 const output=document.createElement('textarea');output.readOnly=true;output.rows=8;output.setAttribute('aria-label','Diagnostic report');
 const report=()=>entries.join('\n');panel.ontoggle=()=>{output.value=report();};
 copy.onclick=async()=>{output.value=report();try{await navigator.clipboard.writeText(output.value);copy.textContent='Report copied';}catch{output.focus();output.select();copy.textContent='Select and copy the report below';}};
 panel.append(title,help,copy,output);document.querySelector('main').append(panel);
 window.addEventListener('error',event=>logEvent('page-error',{message:clean(event.message),stack:clean(event.error?.stack||'')}));
 window.addEventListener('unhandledrejection',event=>logEvent('unhandled-rejection',{message:clean(event.reason?.message||event.reason),stack:clean(event.reason?.stack||'')}));
}
export function watchOperation(onSlow,onTimeout,{slowMs=45000,timeoutMs=180000}={}){
 let slow,timeout;let stage='worker startup';
 const clear=()=>{clearTimeout(slow);clearTimeout(timeout);};
 return {touch(next){if(next)stage=next;clear();slow=setTimeout(()=>onSlow(stage),slowMs);timeout=setTimeout(()=>{clear();onTimeout(stage);},timeoutMs);},stop:clear};
}
