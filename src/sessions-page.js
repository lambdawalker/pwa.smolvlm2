import './style.css';
import './language-ui.js';
import './handedness.js';
import {authConfig,credentials,signOut} from './account.js';
import {sessionAPI,deleteSharedSession} from './session-sync.js';
import {getLanguage,t} from './i18n.js';

export async function startSessionsPage({document,location,api=sessionAPI,config=authConfig,account=credentials,logout=signOut,interval=setInterval,onFocus=handler=>window.addEventListener('focus',handler)}){
 const $=id=>document.getElementById(id);
 let sessions=[],selected=null,busy=false,ready=false,refreshing=false;
 const message=text=>{$('sessions-status').textContent=t(text);};
 function controls(){for(const id of ['create-session','refresh-sessions','create-session-name','save-session-name','confirm-delete-session'])$(id).disabled=busy||refreshing||!ready;}
 function draw(){
  controls();$('session-list').replaceChildren();$('no-sessions').hidden=sessions.length!==0;
  for(const session of sessions){
   const row=document.createElement('article');row.className='session-row';
   const info=document.createElement('div');info.className='session-row-info';const name=document.createElement('h3');name.textContent=session.name;info.append(name);
   const date=document.createElement('p');date.className='small';date.textContent=new Date(session.created).toLocaleString(getLanguage());info.append(date);
   if(session.deleting){const state=document.createElement('p');state.textContent=t('Deletion incomplete. Retry to finish.');state.className='small';info.append(state);}
   const actions=document.createElement('div');actions.className='session-row-actions';
   const open=document.createElement('a');open.textContent=t('Open');open.className='session-open';open.href=`./?session=${encodeURIComponent(session.id)}`;
   if(session.deleting||busy||refreshing){open.removeAttribute('href');open.setAttribute('aria-disabled','true');}
   const rename=document.createElement('button');rename.className='quiet';rename.textContent=t('Rename');rename.disabled=busy||refreshing||session.deleting;
   rename.onclick=()=>{selected=session;$('rename-session-name').value=session.name;$('rename-status').textContent='';$('rename-session-dialog').showModal();$('rename-session-name').focus();};
   const remove=document.createElement('button');remove.className='quiet danger';remove.textContent=t(session.deleting?'Retry deletion':'Delete');remove.disabled=busy||refreshing;
   remove.onclick=()=>{selected=session;$('delete-session-name').textContent=session.name;$('delete-session-dialog').showModal();};
   actions.append(open,rename,remove);row.append(info,actions);$('session-list').append(row);
  }
 }
 async function refresh(announce=true){if(!ready||busy||refreshing)return;refreshing=true;controls();if(announce)message('Loading sessions…');try{const result=await api();sessions=result.sessions.slice().sort((a,b)=>b.created.localeCompare(a.created));if(announce)message('');}catch(error){message(error.message);}finally{refreshing=false;draw();}}
 async function change(action){if(!ready||busy||refreshing)return;busy=true;draw();try{await action();message('');}catch(error){message(error.message);}finally{busy=false;await refresh(false);}}
 $('create-session-form').onsubmit=event=>{event.preventDefault();return change(async()=>{const name=$('create-session-name').value.trim();if(!name||Array.from(name).length>80)throw Error('Session names must contain 1–80 characters.');await api('','POST',{name});$('create-session-name').value='';});};
 $('rename-session-form').onsubmit=async event=>{event.preventDefault();const session=selected;if(!session)return;await change(async()=>{const name=$('rename-session-name').value.trim();if(!name||Array.from(name).length>80){$('rename-status').textContent=t('Session names must contain 1–80 characters.');throw Error('Session names must contain 1–80 characters.');}try{await api('/'+session.id,'PATCH',{name,revision:session.revision||1});$('rename-session-dialog').close();}catch(error){$('rename-status').textContent=t(error.message);throw error;}});};
 $('cancel-rename').onclick=()=>$('rename-session-dialog').close();
 $('cancel-delete-session').onclick=()=>$('delete-session-dialog').close();
 $('confirm-delete-session').onclick=()=>{const session=selected;if(!session)return;return change(async()=>{$('delete-session-dialog').close();message('Deleting session…');await deleteSharedSession(session.id,api);});};
 $('refresh-sessions').onclick=()=>refresh();
 $('sign-out').onclick=logout;controls();
 try{const auth=await config();if(!auth.enabled){message('Shared sessions require the AWS account service.');return;}if(!account()){location.replace('./login.html');return;}
  ready=true;$('sign-out').hidden=false;await refresh();interval(()=>refresh(false),10000);onFocus(()=>refresh(false));
 }catch(error){message(error.message);}
}
if(typeof document!=='undefined')startSessionsPage({document,location});
