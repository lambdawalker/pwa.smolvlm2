import test from 'node:test';
import assert from 'node:assert/strict';
import {bindHoldAction} from '../src/hold-action.js';
function fixture(){
 const events={},timers=new Map();let serial=0,opened=0,delay;
 const button={disabled:false,style:{setProperty(){}},setAttribute(){},addEventListener:(name,fn)=>events[name]=fn};
 const cancel=bindHoldAction(button,{seconds:()=>2,ready:()=>opened++,schedule:(fn,ms)=>{delay=ms;timers.set(++serial,fn);return serial},unschedule:id=>timers.delete(id)});
 return {events,timers,button,cancel,get opened(){return opened},get delay(){return delay}};
}
test('short press and click do not open confirmation; completed hold opens it once',()=>{
 const f=fixture();f.events.pointerdown({button:0,pointerId:1});assert.equal(f.delay,2000);f.events.pointerup();assert.equal(f.timers.size,0);f.events.click({preventDefault(){}});assert.equal(f.opened,0);
 f.events.pointerdown({button:0,pointerId:2});[...f.timers.values()][0]();assert.equal(f.opened,1);f.events.pointerup();assert.equal(f.opened,1);
});
test('keyboard hold supports Space and Enter; blur and cancellation cancel the hold',()=>{
 const f=fixture();f.events.keydown({key:' ',preventDefault(){}});assert.equal(f.timers.size,1);f.events.blur();assert.equal(f.timers.size,0);
 f.events.keydown({key:'Enter',preventDefault(){}});f.events.keydown({key:'Enter',repeat:true,preventDefault(){}});assert.equal(f.timers.size,1);f.cancel();assert.equal(f.timers.size,0);
 f.button.disabled=true;f.events.pointerdown({button:0});assert.equal(f.timers.size,0);
});
