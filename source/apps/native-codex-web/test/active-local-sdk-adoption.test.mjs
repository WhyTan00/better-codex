import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const sdkPath=process.env.DSH_INITIAL_SDK;
const source=sdkPath?await readFile(sdkPath,'utf8'):'';
const sdkTest=(name,fn)=>test(name,{skip:!sdkPath&&'Requires an adopter-owned SDK; run test:renderer with a generated UI'},fn);
const a=source.indexOf('async hydrateThreads('),b=source.indexOf('async readHydrationThread(',a);if(sdkPath)assert(a>=0&&b>a);
const code=source.slice(a,b).replace('async hydrateThreads(','async function hydrateThreads('),id='fixture';
async function fixture({initial=true,live=false,guard=true}={}){
 const cached={initialLocalPaint:initial,applied:false},old={id,updatedAt:20,status:{type:'active'}},incoming={id,updatedAt:10,status:{type:'idle'},turns:[{id:'turn'}]},model={turns:live?[{turnId:'turn',items:[{id:'live'}]}]:[]},metadata=[];
 const client={hydrationGeneration:1,conversations:new Map([[id,model]]),threadsById:new Map([[id,old]]),threadReadStates:new Map(),recentConversationIds:[],appliedHydrationResults:new Set(),params:{logger:{}},isConversationSuppressed:()=>false,readHydrationThread:async()=>({response:{thread:incoming},threadStatusAtReadStart:old.status,turnsPagination:{hasLoadedOldest:true}}),upsertRecentConversationState:(_id,head)=>metadata.push(head),updateConversationState:(_id,fn)=>fn(model),notifyAnyConversationCallbacks(){},notifyConversationCallbacks(){},loadThreadHydrationState(){throw Error('unrelated hydration preparation');}};
 const ctx={Xg:x=>x,wS:x=>x.turns,XS:{},sC:()=>false,u5t:()=>true,hC:{default:(a,b)=>JSON.stringify(a)===JSON.stringify(b)},Y8t:()=>[{turnId:'turn',items:[{id:'cached'}]}],yS:(a,b)=>a.concat(b),AS:(m,t)=>m.turns=t,kS:(m,t)=>m.turns=t,r4t:()=>false,s9t:async p=>{for(const id of p.threadIds){const result=await p.readThread(id);if(p.shouldApplyHydratedThread())p.upsertHydratedConversationState(id,result);}}};
 const fn=vm.runInNewContext(code+';hydrateThreads',ctx);await fn.call(client,[id],{includeTurns:true,maxTurns:2,refreshTurns:'dsh_local_cache',refreshGuard:()=>guard,cachedSnapshot:cached});return{cached,metadata,model,old};
}
sdkTest('actual final SDK adopts an empty local body despite a newer live metadata head and retains that head',async()=>{const f=await fixture();assert.equal(f.cached.applied,true);assert.equal(f.metadata[0],f.old);assert(f.model.turns.some(t=>t.items.some(i=>i.id==='cached')));});
sdkTest('actual final SDK cannot use first-paint permission to replace an existing live body',async()=>{const f=await fixture({live:true});assert.equal(f.cached.applied,false);assert.equal(f.metadata.length,0);assert.equal(f.model.turns[0].items[0].id,'live');});
sdkTest('actual final SDK obeys cancelled adoption and normal stale-history rejection',async()=>{for(const option of[{guard:false},{initial:false}]){const f=await fixture(option);assert.equal(f.cached.applied,false);assert.equal(f.metadata.length,0);}});
