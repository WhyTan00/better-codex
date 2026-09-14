import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
import {patchInitialHistoryBudget} from '../src/official-history-assets.mjs';
test('official initial-history budget follows touch policy without changing other methods',()=>{const source='class Client{getConversation(){return {}}getConversationTurnItemLimit(e){return this.getConversation(e),1/0}loadOlder(){return 100}};new Client()';const patched=patchInitialHistoryBudget(source,{legacy:true});const client=vm.runInNewContext(patched,{__BETTER_CODEX_HISTORY_POLICY__:{initialTurnItems:20}});assert.equal(client.getConversationTurnItemLimit('thread'),20);assert.equal(client.loadOlder(),100);assert.throws(()=>patchInitialHistoryBudget(source+source),/contract changed/);});
test('real official pagination keeps older cursors and opening user input with smaller initial budget',async()=>{const source=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/official-bundle/webview/assets/app-initial-cadb12d4a15e.js','utf8');const start=source.indexOf('async function Q4t('),end=source.indexOf('var FS=',start),calls=[];assert(start>0&&end>start);const page=vm.runInNewContext(source.slice(start,end)+';Q4t',{Xg:x=>x,wS:()=>[],PS:async(_send,_thread,turn,cursor,_opts,limit,direction='desc')=>{calls.push({turn,limit,direction});if(direction==='asc')return {items:[{id:'user-'+turn,type:'userMessage',content:[{type:'text',text:'original input'}]}],nextCursor:'older'};return {items:Array.from({length:limit},(_,i)=>({id:turn+'-'+i,type:'agentMessage',text:'text'})),nextCursor:'older-'+turn};}});const result=await page({sendRequest:async()=>({data:[{id:'t1',status:'completed'},{id:'t2',status:'completed'}],nextCursor:'more-turns'}),getConversation:()=>null},20,{},'thread',null,null,5,{});assert.equal(result.response.data[0].items.length,20);assert.equal(result.response.data[0].itemsView,'summary');assert.equal(result.itemsPaginationByTurnId.t1.olderCursor,'older-t1');assert.equal(result.itemsPaginationByTurnId.t1.hasLoadedOldest,false);assert.equal(result.itemsPaginationByTurnId.t1.oldestUserInput[0].text,'original input');assert.equal(result.response.nextCursor,'more-turns');assert.equal(calls.filter(c=>c.direction==='desc').reduce((n,c)=>n+c.limit,0),40);});

test('real native composer exposes follow-up choice through its original settings mutation',async()=>{
 const {patchFollowUpControls}=await import('../src/official-history-assets.mjs');
 const source=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/official-bundle/webview/assets/app-primary-6cd7b8b3f5e3.js','utf8'),patched=patchFollowUpControls(source);
 const start=patched.indexOf('let st=ot,ct;ct=E&&'),end=patched.indexOf(',ut=!K',start),calls=[];
 assert(start>0&&end>start);const sourceControl=patched.slice(start,end)+';ct';
 const jsx=(type,props)=>({type,props}),scope={native:'scope'};
 const context={E:true,r:'local',nt:null,ot:null,rt:{nativeSubmit:true},D:true,d:true,O:false,j:false,U:scope,$b:{followUpQueueMode:{key:'followUpQueueMode'}},aVe:(...args)=>calls.push(args),D7:{jsx,jsxs:jsx}};
 const label=vm.runInNewContext(sourceControl,context),select=label.props.children[1];assert.equal(select.type,'select');assert.equal(select.props.value,'queue');
 select.props.onChange({currentTarget:{value:'steer'}});assert.equal(calls[0][0],scope);assert.equal(calls[0][1].key,'followUpQueueMode');assert.equal(calls[0][2],'steer');
 assert.equal(vm.runInNewContext(sourceControl,{...context,E:false}),null);assert.throws(()=>patchFollowUpControls('unknown'),/contract changed/);
});

test('patched modules resolve one native React instance through non-recursive browser import maps',async()=>{
 const source=await readFile(new URL('../public/native-sidebar-page.js',import.meta.url),'utf8');
 const install=source.split('\n').find(line=>line.includes("if(HTMLScriptElement.supports?.('importmap')"));assert(install);let imports;
 vm.runInNewContext(install,{HTMLScriptElement:{supports:()=>true},document:{querySelector:()=>null,createElement:()=>({dataset:{}}),head:{append:script=>{imports=JSON.parse(script.textContent).imports;}}}});assert(imports);
 const resolve=url=>{if(imports[url])return imports[url];const prefix=Object.keys(imports).filter(k=>k.endsWith('/')&&url.startsWith(k)).sort((a,b)=>b.length-a.length)[0];return prefix?imports[prefix]+url.slice(prefix.length):url;};
 const {historyAssetPrefix,followUpAssetPrefix,upstreamAssetPrefix,historyClientAsset,followUpClientAsset}=await import('../src/official-history-assets.mjs');
 const canonical=historyAssetPrefix+historyClientAsset;
 assert.equal(resolve(upstreamAssetPrefix+historyClientAsset),canonical);
 // Import maps do not apply recursively. A broad v1004 -> v8 prefix alone
 // would give the patched primary module a second, unpatched React singleton.
 assert.equal(resolve(historyAssetPrefix+historyClientAsset),canonical);
 assert.equal(resolve(historyAssetPrefix+followUpClientAsset),followUpAssetPrefix+followUpClientAsset);
 assert.equal(resolve(followUpAssetPrefix+historyClientAsset),canonical);
 assert.equal(resolve(followUpAssetPrefix+followUpClientAsset),followUpAssetPrefix+followUpClientAsset);
 assert.equal(resolve(historyAssetPrefix+'unchanged-module.js'),upstreamAssetPrefix+'unchanged-module.js');
});

test('preload hints target the executed modules once without invalidating the unchanged history module',async()=>{const {patchNativeModulePreloads,historyAssetPrefix,followUpAssetPrefix,historyClientAsset,followUpClientAsset}=await import('../src/official-history-assets.mjs');const old='/official-patched-v8/assets/';const html='<head><link rel="modulepreload" href="'+old+historyClientAsset+'"><link rel="modulepreload" href="'+old+historyClientAsset+'"><link rel="modulepreload" href="'+old+followUpClientAsset+'"><link rel="stylesheet" href="native.css"></head>';const result=patchNativeModulePreloads(html);assert.equal((result.match(/rel="modulepreload"/g)||[]).length,2);assert(result.includes(historyAssetPrefix+historyClientAsset));assert(result.includes(followUpAssetPrefix+followUpClientAsset));assert(!result.includes(old+historyClientAsset));assert(result.includes('native.css'));});


test('published v1004 input module remains byte-identical for already-open pages',async()=>{const {createHash}=await import('node:crypto'),{patchFollowUpControls}=await import('../src/official-history-assets.mjs');const source=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/official-bundle/webview/assets/app-primary-6cd7b8b3f5e3.js','utf8');const old=patchFollowUpControls(source,{legacy:true});assert.equal(createHash('sha256').update(old).digest('hex'),'c73f0d93a840fee120528d57e740b990b9786a3dcae28456e748531bebb484f3');});

test('published v1005 input module remains byte-identical while the new choice uses the native inline slot',async()=>{const {createHash}=await import('node:crypto'),{patchFollowUpControls}=await import('../src/official-history-assets.mjs');const source=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/official-bundle/webview/assets/app-primary-6cd7b8b3f5e3.js','utf8');assert.equal(createHash('sha256').update(patchFollowUpControls(source,{previous:true})).digest('hex'),'4084f0f5644a34c1a087aea997931b161098d048e25a2d0424558f3dd4738b1a');const current=patchFollowUpControls(source);assert(current.includes('let lt=ct,ut=!K'));assert(!current.includes('betterCodex-follow-up-row'));});
