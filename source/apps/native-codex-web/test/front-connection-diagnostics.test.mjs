import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter,once} from 'node:events';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createOfficialFront} from '../src/official-front.mjs';
const require=createRequire(new URL('../../../../packages/host-cli/package.json',import.meta.url)),WS=require('ws');
test('actual front upgrade, hello, native interruption and close are durably correlated',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-front-connection-'));
 const native=new EventEmitter();native.state='ready';native.start=async()=>{};native.close=()=>{};
 native.rpc=async method=>method==='thread/loaded/list'?{data:[]}:method==='config/read'?{config:{sandbox_mode:'danger-full-access',approval_policy:'never'}}:{};
 const front=await createOfficialFront({port:0,native,stateDir:dir});await new Promise(r=>front.server.listen(0,'127.0.0.1',r));
 let socket;t.after(async()=>{socket?.terminate();await front.close();await rm(dir,{recursive:true,force:true});});
 const origin='http://127.0.0.1:'+front.server.address().port,binding=await(await fetch(origin+'/dsh-scope-session?workspace=ai',{headers:{origin,'x-dsh-diagnostic-trace':'00000000-0000-4000-8000-000000000003'}})).json();
 const connectionId='00000000-0000-4000-8000-000000000002';
 socket=new WS(origin.replace('http','ws')+'/w/ai/ws?scopeToken='+binding.token+'&dshDiag='+connectionId+'&dshDiagPage=abcd1234',{headers:{origin},perMessageDeflate:false});await once(socket,'open');
 const ack=once(socket,'message');socket.send(JSON.stringify({type:'hello',clientId:'diagnostic-test'}));assert.equal(JSON.parse(String((await ack)[0])).type,'hello-ack');
 native.state='disconnected';native.emit('interrupted');const closed=once(socket,'close');socket.close(1000);await closed;
 const deadline=Date.now()+1000;let observed=false;while(Date.now()<deadline){try{observed=(await readFile(path.join(dir,'connections.jsonl'),'utf8')).split('\n').some(line=>{try{const e=JSON.parse(line);return e.connectionId===connectionId&&e.stage==='closed';}catch{return false;}});}catch{}if(observed)break;await new Promise(r=>setTimeout(r,5));}assert(observed,'server close logged');
 // Front logger is asynchronous and bounded; read after its close path flushes.
 await front.close();const raw=await readFile(path.join(dir,'connections.jsonl'),'utf8'),events=raw.trim().split('\n').map(JSON.parse);
 for(const stage of ['attempt','open','hello','closed'])assert(events.some(e=>e.component==='page-ws'&&e.stage===stage&&e.connectionId===connectionId),stage);
 for(const stage of ['received','committed'])assert(events.some(e=>e.traceId==='00000000-0000-4000-8000-000000000003'&&e.routeClass==='scope_session'&&e.stage===stage),'scope trace '+stage);
 assert(events.some(e=>e.reason==='native_disconnected'));assert(!raw.includes(binding.token));assert(!raw.includes('scopeToken'));assert(!raw.includes('diagnostic-test'));
 // Already closed: prevent cleanup from invoking server.close twice.
 front.close=async()=>{};
});
