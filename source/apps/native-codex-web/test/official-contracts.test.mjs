import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink,mkdir} from 'node:fs/promises';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import {OfficialState} from '../src/official-state.mjs';
import {OfficialFiles} from '../src/official-files.mjs';
import {createAppHostFactory} from '../src/official-app-host.mjs';
import {scopeRuntimeAssets} from '../src/official-assets.mjs';
import {RpcSession,RpcTarget} from '${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/adapter-deps/node_modules/capnweb/dist/index.js';
async function temporary(t){const dir=await mkdtemp(path.join(os.tmpdir(),'betterCodex-contracts-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
const boundary={checked:async(ws,id)=>{if(id!=='00000000-0000-4000-8000-4ba7215b54d2')throw Object.assign(Error('scope'),{code:404});return {id};},writable:async()=>{},serial:async(k,fn)=>fn()};
test('state loads once, concurrent saves are atomic, corrupt state cannot be overwritten',async t=>{
 const dir=await temporary(t),store=new OfficialState(dir),[a,b]=await Promise.all([store.read('ai'),store.read('ai')]);assert.equal(a,b);a.atoms.first='draft';const one=store.persist('ai');b.atoms.second='other draft';await Promise.all([one,store.persist('ai')]);assert.deepEqual(JSON.parse(await readFile(path.join(dir,'ai.json'),'utf8')).atoms,{first:'draft',second:'other draft'});
 await writeFile(path.join(dir,'secondary.json'),'{broken');await assert.rejects(store.read('secondary'));assert.equal(await readFile(path.join(dir,'secondary.json'),'utf8'),'{broken');
});
test('official uploads, reads, etag writes and guessed cross-workspace paths preserve scope',async t=>{
 const dir=await temporary(t),files=new OfficialFiles({stateDir:dir,boundary});const [{path:file,label}]=(await files.upload('ai',[{name:'review.md',contentsBase64:Buffer.from('draft').toString('base64'),size:5}])).files;assert.equal(label,'review.md');const initial=await files.read('ai',{hostId:'local',path:file,representation:'text'});assert.equal(initial.text,'draft');
 await assert.rejects(files.read('secondary',{hostId:'local',path:file,representation:'text'}),e=>e.code===403);
 assert.equal((await files.write('ai',{path:file,bytes:new TextEncoder().encode('edited'),ifMatch:'wrong'})).outcome,'conflict');assert.equal((await files.read('ai',{path:file})).text,'draft');assert.equal((await files.write('ai',{path:file,bytes:new TextEncoder().encode('edited'),ifMatch:initial.etag})).outcome,'saved');assert.equal((await files.metadata('ai',{path:file})).contentKind,'text');
 await assert.rejects(files.upload('ai',[{name:'bad',contentsBase64:'***',size:1}]),e=>e.code===400);
 await assert.rejects(files.resolve('ai','${BETTER_CODEX_HOME}/.codex/auth.json'),e=>e.code===403);
});
test('symlinks cannot grant another workspace files or create directories outside the root',async t=>{
 const dir=await temporary(t),files=new OfficialFiles({stateDir:dir,boundary});await mkdir(path.join(dir,'uploads/ai'),{recursive:true});await mkdir(path.join(dir,'outside'));await writeFile(path.join(dir,'outside/private.txt'),'private');await symlink(path.join(dir,'outside'),path.join(dir,'uploads/ai/link'));
 await assert.rejects(files.read('ai',{path:path.join(dir,'uploads/ai/link/private.txt')}),e=>e.code===403);await assert.rejects(files.directory('ai',path.join(dir,'uploads/ai/link/new-dir')),e=>e.code===403);
});
function pair(){const sides=[{queue:[],waiters:[]},{queue:[],waiters:[]}];return sides.map((side,i)=>({send:async v=>{const other=sides[1-i];if(other.waiters.length)other.waiters.shift()(v);else other.queue.push(v);},receive:()=>side.queue.length?Promise.resolve(side.queue.shift()):new Promise(r=>side.waiters.push(r)),abort:()=>{}}));}
test('real CapnWeb handshake resolves required services and renderer callbacks without empty success stubs',async t=>{
 const dir=await temporary(t),stateStore=new OfficialState(dir),files=new OfficialFiles({stateDir:dir,boundary}),client={scope:'ai',pageId:'one',readyState:1},clients=new Set([client]);let clipboard;
 const make=createAppHostFactory({RpcTarget,boundary,files,state:s=>stateStore.read(s),persist:s=>stateStore.persist(s),native:{start:async()=>{}},clients,send:()=>true,browserAction:async(c,action,p)=>{clipboard={action,p};},fileUrl:()=>'/scoped-file'}),[one,two]=pair();
 const server=new RpcSession(one,make('ai',client)),browser=new RpcSession(two,{});t.after(()=>{server.getRemoteMain()[Symbol.dispose]();browser.getRemoteMain()[Symbol.dispose]();});const app=browser.getRemoteMain();const services=await app.services;
 await services.startup.whenReady();assert.equal((await services.appInfo.get()).version,'26.901.51231');await services.clipboard.writeText('hello');assert.deepEqual(clipboard,{action:'clipboard',p:{text:'hello'}});
 const bootstrap=await services.httpFetch.fetch('native-question-ui',{url:'https://ab.chatgpt.com/v1/initialize'}),flags=await bootstrap.response.json();assert.deepEqual(Object.keys(flags.feature_gates).sort(),['3125406982','580984490']);assert(Object.values(flags.feature_gates).every(g=>g.value===true));
 assert.equal((await services.httpFetch.fetch('other-endpoint',{url:'https://other.invalid/private'})).status,403);
 const temp=await services.workspaceFiles.createTemporaryFile({bytes:new TextEncoder().encode('test'),fileName:'qa.txt'});assert.equal((await services.workspaceFiles.read({hostId:'local',path:temp.path,representation:'text'})).text,'test');
 const p={hostId:'local',threadId:'00000000-0000-4000-8000-4ba7215b54d2',turnId:'one',callId:'one'};assert.equal(await services.dynamicToolCalls.tryClaimExecution(p),true);assert.equal(await services.dynamicToolCalls.tryClaimExecution(p),false);
 assert.equal(await services.clientCoordination.findThreadOwner({hostId:'local',conversationId:p.threadId}),null);await services.clientCoordination.setThreadOwnership({hostId:'local',conversationId:p.threadId,ownsThread:true});assert.equal(await services.clientCoordination.findThreadOwner({hostId:'local',conversationId:p.threadId}),'one');
});
test('pinned browser asset patches are checked and reject upstream contract changes',async()=>{
 const source=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/web-shell/internal/providers/codex-bridge-polyfill.js','utf8'),patched=scopeRuntimeAssets(source);assert.match(patched,/scopeToken/);assert.match(patched,/Window focus is not cancellation/);assert.throws(()=>scopeRuntimeAssets('unknown version'),/contract changed/);assert.throws(()=>scopeRuntimeAssets(source+source),/contract changed/);
});

test('official directory entries keep relative paths, exclude escaping symlinks, and reject parent traversal',async t=>{
 const dir=await temporary(t),files=new OfficialFiles({stateDir:dir,boundary});const f=(await files.upload('ai',[{name:'a.txt',contentsBase64:'YQ==',size:1}])).files[0];const root=path.dirname(f.path);await mkdir(path.join(root,'folder'));await symlink('${BETTER_CODEX_HOME}/.codex',path.join(root,'outside'));
 const result=await files.entries('ai',{hostId:'local',workspaceRoot:root,directoryPath:''});assert.deepEqual(result.entries.map(e=>[e.name,e.type]),[['folder','directory'],['a.txt','file']]);assert.equal(result.directoryPath,'');assert.equal(result.parentPath,null);await assert.rejects(files.entries('ai',{workspaceRoot:root,directoryPath:'..'}),e=>e.code===403);
});
test('temporary preview release removes only its issued file; ordinary uploaded attachments remain',async t=>{
 const dir=await temporary(t),files=new OfficialFiles({stateDir:dir,boundary}),temp=await files.createTemporary('ai',{bytes:new Uint8Array([1,2]),fileName:'qa.bin'}),upload=(await files.upload('ai',[{name:'keep.txt',contentsBase64:'YQ==',size:1}])).files[0];await files.releaseTemporary('secondary',temp.path);assert.equal((await readFile(temp.path)).length,2);await files.releaseTemporary('ai',temp.path);await assert.rejects(readFile(temp.path),e=>e.code==='ENOENT');await files.releaseTemporary('ai',upload.path);assert.equal((await readFile(upload.path)).length,1);
});

test('actual patched browser picker waits for change or native cancel, not incidental window focus',async()=>{
 const raw=await readFile('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/web-shell/internal/providers/codex-bridge-polyfill.js','utf8'),patched=scopeRuntimeAssets(raw),start=patched.indexOf('  function openBrowserFilePicker(params) {'),end=patched.indexOf('  /** 实现 pick-files',start),source=patched.slice(start,end);
 for(const modern of [true,false]){const listeners={},focus=[],timers=new Map();let counter=0,removed=false;const input={...(modern?{oncancel:null}:{}),files:[],style:{},addEventListener:(k,f)=>listeners[k]=f,remove:()=>removed=true,click:()=>{}};const context={w:{},modificationEffects:null,activeBrowserFilePickerCancel:null,FILE_PICKER_SESSION_TIMEOUT_MS:60000,pickFilesAllowsMultiple:()=>true,pickFilesAccept:()=>'',scheduler:{setTimeout:(f,ms)=>{const id=++counter;timers.set(id,{f,ms});return id;},clearTimeout:id=>timers.delete(id)},adapterHost:{events:{observe:p=>{focus.push(p.callback);return ()=>{};}}},document:{createElement:()=>input,body:{appendChild:()=>{}}}};
  vm.runInNewContext(source+';globalThis.choose=openBrowserFilePicker;',context);const selected=context.choose({});assert.equal(focus.length,0);assert.equal(removed,false);input.files=[{name:'qa.txt'}];listeners.change();assert.equal((await selected)[0].name,'qa.txt');assert.equal(removed,true);
 }
});
