import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {SubmissionContexts} from '../src/submission-context.mjs';
test('actual front receipt producer includes its own host descriptor and live policy',async()=>{
 const source=await readFile(process.env.DSH_FRONT_SOURCE||new URL('../src/official-front.mjs',import.meta.url),'utf8');
 const a=source.indexOf(' const submissionContexts='),b=source.indexOf(' const queuedSendLocks=',a);assert(a>0&&b>a);
 const boundary={checked:async()=>({id:'qa'}),call:async(_scope,{method})=>method==='config/read'?{config:{}}:{requirements:null}};
 const ctx={SubmissionContexts,boundary,epoch:'front',native:{generation:1},workspace:()=>({}),state:async()=>({globals:{}}),readWorkspaceGlobalState:()=>null,connectionLog:{event:()=>{}}};
 // Model exactly the binding available in this real frozen file. A private
 // build must not accidentally retain the portable source's runtimeProfile.
 ctx[source.includes("import {privateBindings}")?'privateBindings':'runtimeProfile']={codexHome:'/fixture/native-home'};
 vm.runInNewContext(source.slice(a,b),ctx);
 const receipt=(await boundary.readSubmissionContext('ai','qa')).submissionContext;
 assert.equal(receipt.hostPaths.codexHome,'/fixture/native-home');await boundary.verifySubmissionContext('ai','qa',receipt.token);
});
