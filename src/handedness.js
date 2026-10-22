import { defaults } from './defaults.generated.js';
function applyHandedness(){
 let left=defaults.interface.leftHanded;try{left=(localStorage.getItem('audit-left-handed')??String(defaults.interface.leftHanded))==='true';}catch{}
 document.documentElement.classList.toggle('left-handed',left);
 const toggle=document.getElementById('left-handed');
 if(toggle){toggle.checked=left;toggle.onchange=()=>{document.documentElement.classList.toggle('left-handed',toggle.checked);try{localStorage.setItem('audit-left-handed',String(toggle.checked));}catch{}};}
}
applyHandedness();
window.addEventListener('storage',event=>{if(event.key==='audit-left-handed')applyHandedness();});
