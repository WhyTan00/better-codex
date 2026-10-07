import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {patchPreparationMetadataRefresh} from '../src/official-submission-readiness.mjs';
const before=new URL('../../../acceptance/resume-preparation-before/pwa-initial.js',import.meta.url),fallback=new URL('../../../runtime/send-migration-followup-20260928/ui/pwa/native-assets/v1034/app-initial-cadb12d4a15e.js',import.meta.url);
const input=process.env.DSH_PREPARATION_REFRESH_INITIAL?await readFile(process.env.DSH_PREPARATION_REFRESH_INITIAL,'utf8'):await readFile(before,'utf8').catch(e=>{if(e.code!=='ENOENT')throw e;return readFile(fallback,'utf8')});
const source=process.env.DSH_PREPARATION_REFRESH_INITIAL&&!process.env.DSH_PREPARATION_REFRESH_APPLY_PATCH?input:patchPreparationMetadataRefresh(input);
const fn=(text,name)=>{const start=text.indexOf('function '+name+'('),prefix=text.slice(start-6,start)==='async '?'async ':'';assert(start>=0,name);const part=text.slice(start),end=/\}(?:async function |function |var )/.exec(part);assert(end);return prefix+part.slice(0,end.index+1)};
const flush=async()=>{for(let i=0;i<3;i++)await new Promise(r=>setImmediate(r))};
// The retryer, Query, QueryClient and Observer are exact classes from the tested
// actual initial asset. Only host IO and the external signal/query registry are fixtures.
function fixture(t,{home='/fixture/.codex',cacheHook=false}={}){
 const start=source.indexOf('Zy,Qy=t(('),end=source.indexOf('function IUt(',start);assert(start>=0&&end>start);
 const ctx={setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,AbortController,t:f=>{let used=false;return()=>{if(!used){used=true;return f()}}},console};vm.createContext(ctx);
 vm.runInContext('var '+source.slice(start,end)+';MUt();mUt();globalThis.QueryClient=jUt;globalThis.QueryObserver=pb;',ctx);
 const client=new ctx.QueryClient(),key=['vscode','codex-home','{"hostId":"local"}'],pending=[],events=[],logs=[];
 const metadata={codexHome:home,worktreesSegment:home+'/worktrees'};
 const options={queryKey:key,queryFn:({signal})=>new Promise((resolve,reject)=>{events.push('read');signal.addEventListener('abort',()=>events.push('abort'));pending.push({resolve,reject})}),staleTime:0,gcTime:Infinity,retry:false,networkMode:'always'};
 client.setQueryData(key,metadata,{updatedAt:1});const observer=new ctx.QueryObserver(client,options),stop=observer.subscribe(()=>{});
 const invalidate=[];let inspections=0;
 const scope={query:{getOrFetch:kind=>kind==='home'?client.fetchQuery(options):Promise.resolve({roots:['/fixture']}),invalidate:(kind,params,filters,settings)=>{invalidate.push({kind,params,filters,settings});return kind==='home'?client.invalidateQueries({...filters,queryKey:key},settings):Promise.resolve()},fetch:async()=>{inspections++;return {kind:'available'}}}};
 Object.assign(ctx,{ED:'home',jD:'roots',Xls:'inspection',Gls:{kind:'available'},Yls:'worktree_status_unavailable',qls:'worktree_restore_required',J_:v=>v,Nv:(cwd,_home,root)=>cwd.startsWith(root+'/'),__DSH_CLIENT_LOG__:{reportError:(...args)=>logs.push(args)}});
 if(cacheHook)ctx.__DSH_READ_CODEX_HOME__=()=>Promise.resolve(metadata);
 vm.runInContext(['Vls','Hls','Uls'].map(name=>fn(source,name)).join(';'),ctx);
 t.after(()=>{stop();client.clear()});return {ctx,scope,key,pending,events,logs,invalidate,get inspections(){return inspections},metadata,send:thread=>ctx.Vls(scope,{conversationId:thread,cwd:'/fixture/project',hostId:'local'}),refresh:()=>ctx.Uls(scope,'local')};
}
test('actual shared codex-home read survives reconnect invalidation for two explicit sends',async t=>{
 const f=fixture(t),a=f.send('thread-a'),b=f.send('thread-b');let failed=[];a.catch(e=>failed.push(e));b.catch(e=>failed.push(e));await flush();assert.equal(f.pending.length,1);
 const refresh=f.refresh();await flush();t.diagnostic(JSON.stringify({queryKey:f.key,pendingReads:f.pending.length,cancelledConsumers:failed.map(e=>e.message)}));assert.deepEqual(failed.map(e=>e.message),[],'reconnect cancellation must not escape into either send');assert.equal(f.pending.length,1,'reconnect must join the existing metadata fetch rather than cancel it');assert.deepEqual(f.events,['read']);f.pending[0].resolve(f.metadata);await Promise.all([a,b,refresh]);assert.equal(failed.length,0);assert.equal(f.logs.length,0);assert.equal(f.inspections,0);
 const call=f.invalidate.find(x=>x.kind==='home');assert.equal(call.filters.exact,true);assert.equal(call.settings.cancelRefetch,false);assert.deepEqual(f.key,['vscode','codex-home','{"hostId":"local"}']);
});
test('genuine codex-home failure still rejects both sends with the original error and no execution',async t=>{
 const f=fixture(t),error=Error('fixture metadata failure'),a=assert.rejects(f.send('a'),e=>e===error),b=assert.rejects(f.send('b'),e=>e===error),refresh=f.refresh();f.pending[0].reject(error);await Promise.all([a,b,refresh]);assert.equal(f.logs.length,2);assert.equal(f.inspections,0);assert.equal(f.pending.length,1);
});
test('metadata refresh still fetches stale data when idle and preserves original roots invalidation',async t=>{
 const f=fixture(t);f.pending[0].resolve(f.metadata);await flush();await flush();const refresh=f.refresh();await flush();assert.equal(f.pending.length,2);f.pending[1].resolve(f.metadata);await refresh;const roots=f.invalidate.find(x=>x.kind==='roots');assert.equal(roots.settings,undefined);assert.equal(roots.filters.exact,true);
});
test('managed worktree inspection remains mandatory after the same metadata read',async t=>{
 const f=fixture(t,{home:'/fixture',cacheHook:true});f.pending[0].resolve(f.metadata);await f.ctx.Vls(f.scope,{conversationId:'a',cwd:'/fixture/worktrees/branch',hostId:'local'});assert.equal(f.inspections,1);assert(f.invalidate.some(x=>x.kind==='inspection'));
});
test('metadata-only patch rejects changed pinned function and touches no other initial bytes',()=>{
 const needle='async function Uls(e,t){await Promise.all([e.query.invalidate(ED,{hostId:t},{exact:!0}),e.query.invalidate(jD,{hostId:t},{exact:!0})])}',changed=needle.replace('ED,{hostId:t},{exact:!0})','ED,{hostId:t},{exact:!0},{cancelRefetch:!1})');
 assert.equal(patchPreparationMetadataRefresh('prefix'+needle+'suffix'),'prefix'+changed+'suffix');assert.throws(()=>patchPreparationMetadataRefresh('different renderer'),/contract changed/);
});
