// A click never authorizes a bulk action. Completing a continuous hold only opens its dialog.
export function bindHoldAction(button,{seconds,ready,schedule=setTimeout,unschedule=clearTimeout}){
 let timer=null;
 function cancel(){if(timer!==null)unschedule(timer);timer=null;button.setAttribute('data-holding','false');}
 function start(){
  if(button.disabled||timer!==null)return;
  const duration=Number(seconds())*1000;
  button.style.setProperty('--hold-duration',duration+'ms');button.setAttribute('data-holding','true');
  timer=schedule(()=>{cancel();if(!button.disabled)ready();},duration);
 }
 button.addEventListener('pointerdown',event=>{if(event.button!==0)return;button.setPointerCapture?.(event.pointerId);start();});
 for(const event of ['pointerup','pointercancel','lostpointercapture','pointerleave','blur'])button.addEventListener(event,cancel);
 button.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();if(!event.repeat)start();}});
 button.addEventListener('keyup',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();cancel();}});
 button.addEventListener('click',event=>event.preventDefault());
 button.addEventListener('contextmenu',event=>event.preventDefault());
 return cancel;
}
