import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {frozenNativeUI} from '../src/frozen-native-ui.mjs';
const release=await frozenNativeUI(process.env.DSH_TEST_NATIVE_UI_PACKAGE);
assert(release,'send target acceptance requires the frozen UI package');
const imports=JSON.parse(release.files.get(release.manifest.shell).match(/<script type="importmap"[^>]*>(.*?)<\/script>/s)[1]).imports;
const primary=imports['/official-patched-v8/assets/app-primary-6cd7b8b3f5e3.js'];
assert.equal(primary,release.manifest.primary,'test the primary the final shell actually imports');
const source=release.files.get(primary);assert.equal(typeof source,'string','the primary must be in the hash-verified frozen package');
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
function composer(){
 let release;const paint=new Promise(r=>release=r),calls=[],state={thread:A},cancelled=[],errors=[];
 const scope={value:{kind:'local',clientThreadId:null},get:()=>false,set(){}};
 const instant={pending:{presented:()=>paint,isCurrent:()=>state.thread===A},cancel:reason=>cancelled.push(reason)};
 const ctx={location:{pathname:'/local/'+A},window:{},globalThis:{},zx:()=>scope,yi:0,uH:()=>({}),_T:()=>({modelSettings:{}}),PC:()=>state.thread,Cv:x=>x,aYr:()=>false,AXr:()=>({queueAttachmentSubmit:()=>false,queueLocalConfigSubmit:()=>false}),Oh:0,PS:0,Lb:0,kl:0,Lw:()=>false,Fqr:()=>[],Lqr:()=>true,gXr:async x=>{instant.claimed=true;calls.push(x);}};
 const start=source.indexOf('function PXr('),end=source.indexOf('var FXr=',start);
 const api=vm.runInNewContext(source.slice(start,end)+';PXr',ctx)({callbacks:{getDefaultFollowUpSubmitAction:()=>'send-now',handleSubmitError:e=>errors.push(e)},submissionState:{submitDisabled:false,submitBlockContext:{},localConfigTarget:{},submitTargetKey:A},submitTarget:{type:'local'}});
 return {ctx,state,instant,api,release,calls,cancelled,errors};
}


test('route and mounted composer disagree before capture: do not send or clear',async()=>{
 const x=composer();x.ctx.location.pathname='/local/'+B;x.release();await x.api.submitComposer({dshInstantSend:x.instant});assert.equal(x.calls.length,0);assert.equal(x.errors.length,1);assert.match(x.errors[0].message,/会话正在切换/);
});
test('home route cannot submit a still-mounted existing composer',async()=>{
 const x=composer();x.ctx.location.pathname='/';x.release();await x.api.submitComposer({dshInstantSend:x.instant});assert.equal(x.calls.length,0);assert.equal(x.errors.length,1);assert.match(x.errors[0].message,/会话正在切换/);
});
test('same-thread paint completes with original target exactly once',async()=>{
 const x=composer(),work=x.api.submitComposer({dshInstantSend:x.instant});x.release();await work;assert.equal(x.calls.length,1);assert.equal(x.calls[0].conversationId,A);
});
function localSubmit(actual,client=null){
 const calls=[];const ctx={c:actual?{type:'local',localConversationId:actual}:undefined,o:client,e:{get:()=>null},fT:0,u:false,S:undefined,b:undefined,y:undefined,_:undefined,L:async(...args)=>{calls.push(args);return {messageResult:{status:'sent'}}},P:async(...args)=>{calls.push(args);return {messageResult:{status:'sent'}}}};
 const start=source.indexOf('z=async(t,n,r,i,a,s,l,d)=>'),end=source.indexOf(',B=!1;return{queuedFollowUpSubmission:',start);
 return {calls,run:vm.runInNewContext('('+source.slice(start+2,end)+')',ctx)};
}
test('late-bound callback refuses A context when callback now targets B',async()=>{
 const x=localSubmit(B);await assert.rejects(x.run({prompt:'fixture',dshSendTarget:{threadId:A}}),/发送目标会话已变化/);assert.equal(x.calls.length,0);
});
test('new-conversation callback cannot consume an existing-thread message',async()=>{
 const x=localSubmit(null);await assert.rejects(x.run({prompt:'fixture',dshSendTarget:{threadId:A}}),/发送目标会话已变化/);assert.equal(x.calls.length,0);
});
test('new draft identity is verified before creating a conversation',async()=>{
 const x=localSubmit(null,B);await assert.rejects(x.run({prompt:'fixture',dshSendTarget:{threadId:null,clientThreadId:A}}),/发送目标会话已变化/);assert.equal(x.calls.length,0);
});
test('matching target passes unchanged prompt and strips local identity guard metadata',async()=>{
 const x=localSubmit(A);await x.run({prompt:'fixture',dshSendTarget:{threadId:A}});assert.equal(x.calls.length,1);assert.equal(x.calls[0][0].prompt,'fixture');assert.equal('dshSendTarget' in x.calls[0][0],false);
});
