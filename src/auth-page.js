import './style.css';
import './language-ui.js';
import {authConfig,cognito,signIn} from './account.js';
const $=id=>document.getElementById(id);let mode=document.body.dataset.mode;
function state(next){mode=next;$('password-field').hidden=!['login','signup'].includes(mode);$('code-field').hidden=!['confirm','reset'].includes(mode);$('password-field').hidden=mode==='confirm'||mode==='forgot';$('password').required=['login','signup','reset'].includes(mode);$('code').required=['confirm','reset'].includes(mode);$('auth-title').textContent=({login:'Log in',signup:'Create account',confirm:'Verify email',forgot:'Reset password',reset:'Set new password'})[mode];$('submit-auth').textContent=$('auth-title').textContent;}
state(mode);
$('forgot').onclick=()=>state('forgot');$('resend').onclick=async()=>{try{await cognito('ResendConfirmationCode',{Username:$('email').value});$('auth-status').textContent='A new code was sent to your email.';}catch(e){$('auth-status').textContent=e.message;}};
$('auth-form').onsubmit=async event=>{event.preventDefault();$('submit-auth').disabled=true;try{const email=$('email').value.trim(),password=$('password').value,code=$('code').value.trim();
 if(mode==='login'){await signIn(email,password);location.replace('./');}
 else if(mode==='signup'){await cognito('SignUp',{Username:email,Password:password,UserAttributes:[{Name:'email',Value:email}]});state('confirm');$('auth-status').textContent='Enter the verification code sent to your email.';}
 else if(mode==='confirm'){await cognito('ConfirmSignUp',{Username:email,ConfirmationCode:code});state('login');$('auth-status').textContent='Email verified. Log in to continue.';}
 else if(mode==='forgot'){await cognito('ForgotPassword',{Username:email});state('reset');$('auth-status').textContent='Enter your email code and a new password.';}
 else {await cognito('ConfirmForgotPassword',{Username:email,ConfirmationCode:code,Password:password});state('login');$('auth-status').textContent='Password changed. Log in to continue.';}
 }catch(error){$('auth-status').textContent=error.message;if(/not confirmed/i.test(error.message))state('confirm');}finally{$('submit-auth').disabled=false;}};
authConfig().then(c=>{if(!c.enabled){$('auth-status').textContent='Accounts are not configured in this environment.';$('submit-auth').disabled=true;}}).catch(e=>{$('auth-status').textContent=e.message;});
