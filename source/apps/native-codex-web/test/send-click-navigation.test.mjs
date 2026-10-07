import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {frozenNativeUI} from '../src/frozen-native-ui.mjs';
import {patchSendTargetNavigation,patchSendPreparationPaint} from '../src/official-send-target.mjs';
const accepted=process.env.DSH_CLICK_PRIMARY?null:await frozenNativeUI();
const raw=accepted&&!process.env.DSH_CLICK_PRIMARY?accepted.files.get(accepted.manifest.primary):await readFile(process.env.DSH_CLICK_PRIMARY||new URL('../../../runtime/startup-concurrency-20260929/ui/android-ui/files/official-patched-v1040/assets/app-primary-6cd7b8b3f5e3.js',import.meta.url),'utf8');
const primary=process.env.DSH_CLICK_PRIMARY||process.env.DSH_CLICK_BEFORE?raw:patchSendPreparationPaint(patchSendTargetNavigation(raw));
const nav=await readFile(new URL('../public/native-navigation.js',import.meta.url),'utf8');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function fixture({thread=A,intended='/local/'+A,path='/local/'+A}={}){
 let release;const paint=new Promise(r=>release=r),calls=[],errors=[],state={thread},cancelled=[],events=[];
 const location={href:'https://workbench.example.test'+path,pathname:path},scope={value:{kind:thread?'local':'new',clientThreadId:null},get:()=>false,set(){}};
 const instant={pending:{presented:()=>paint,isCurrent:()=>true},cancel:reason=>{if(instant.finished)return;instant.finished=true;cancelled.push(reason)}};
 const ctx={URL,CustomEvent,location,selectedPresentation:intended,history:{state:{}},state:x=>x,url:x=>x,replace(_s,_t,href){location.href=href;location.pathname=new URL(href).pathname},window:{dispatchEvent:e=>events.push(e)},globalThis:{},zx:()=>scope,yi:0,uH:()=>({}),_T:()=>({modelSettings:{}}),PC:()=>state.thread,Cv:x=>x,aYr:()=>false,AXr:()=>({queueAttachmentSubmit:()=>false,queueLocalConfigSubmit:()=>false}),Oh:0,PS:0,Lb:0,kl:0,Lw:()=>false,Fqr:()=>[],Lqr:()=>true,gXr:async x=>{instant.claimed=true;calls.push(x)}};
 vm.createContext(ctx);
 const navStart=nav.indexOf('  confirmSendTarget('),navEnd=nav.indexOf('\n  // Downloads',navStart);
 vm.runInContext('window.__DSH_NAVIGATION__={'+nav.slice(navStart,navEnd)+'}',ctx);
 const start=primary.indexOf('function PXr('),end=primary.indexOf('var FXr=',start);
 const api=vm.runInContext(primary.slice(start,end)+';PXr',ctx)({callbacks:{getDefaultFollowUpSubmitAction:()=>'send-now',handleSubmitError:e=>errors.push(e)},submissionState:{submitDisabled:false,submitBlockContext:{},localConfigTarget:{},submitTargetKey:thread},submitTarget:{type:'local'}});
 return {ctx,state,instant,api,release,calls,errors,cancelled,events};
}
for(const thread of [B,null])test('visible '+(thread?'existing':'new')+' composer sends while the address mirror still points at the prior conversation',async()=>{
 const f=fixture({thread,intended:thread?'/local/'+thread:'/',path:'/local/'+A});const send=f.api.submitComposer({dshInstantSend:f.instant});f.release();await send;
 assert.equal(f.errors.length,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].conversationId,thread);assert.equal(f.ctx.location.pathname,thread?'/local/'+thread:'/');
});
test('stale mounted composer is visibly rejected before capturing or clearing the draft',async()=>{
 const f=fixture({thread:A,intended:'/local/'+B});f.release();await f.api.submitComposer({dshInstantSend:f.instant});assert.equal(f.calls.length,0);assert.equal(f.errors.length,1);assert.match(f.errors[0].message,/尚未发送/);assert.equal(f.ctx.location.pathname,'/local/'+A);
});
test('captured send begins preparation while its first paint is still pending',async()=>{
 const f=fixture(),send=f.api.submitComposer({dshInstantSend:f.instant});
 try{for(let i=0;i<8;i++)await Promise.resolve();assert.equal(f.calls.length,1,'configuration/network preparation must not wait for two display frames');assert.equal(f.calls[0].conversationId,A);}
 finally{f.release();await send;}
});
if(primary.includes('await dshInstant?.pending.presented()'))test('switching conversation during presentation still cancels and cannot send to the new thread',async()=>{
 const f=fixture(),pending=f.api.submitComposer({dshInstantSend:f.instant});f.state.thread=B;f.ctx.location.pathname='/local/'+B;f.release();await pending;assert.equal(f.calls.length,0);assert.equal(f.cancelled.length,1);
});
