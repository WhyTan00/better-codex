import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {once} from 'node:events';
import {SharedNative} from '../src/shared-native.mjs';
const require=createRequire('${BETTER_CODEX_HOME}/.better-codex/official-runtime-20260908/opencodex-pinned/package.json'),{WebSocketServer}=require('ws');
test('native observer reconnects with a new generation without replaying uncertain writes',async t=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await once(server,'listening');let writes=0,connections=0;
 server.on('connection',socket=>{connections++;socket.on('message',raw=>{const m=JSON.parse(raw);if(m.method==='initialize')socket.send(JSON.stringify({id:m.id,result:{userAgent:'test/0.153.4'}}));else if(m.method==='turn/start'){writes++;socket.close();}else if(m.id!=null)socket.send(JSON.stringify({id:m.id,result:{ok:true}}));});});
 const n=new SharedNative({url:'ws://127.0.0.1:'+server.address().port,reconnect:true});
 t.after(async()=>{n.close();for(const s of server.clients)s.terminate();await new Promise(resolve=>server.close(resolve));});
 await n.start();assert.equal(n.generation,1);
 const recovered=once(n,'ready');await assert.rejects(n.rpc('turn/start',{threadId:'synthetic'}),e=>e.code===503);await recovered;
 assert.equal(n.generation,2);assert.equal(writes,1);assert.equal(connections,2);assert.deepEqual(await n.rpc('thread/read',{}),{ok:true});
 n.close();await assert.rejects(n.start(),e=>e.code===503);
});
