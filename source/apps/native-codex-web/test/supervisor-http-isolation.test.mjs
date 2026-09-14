import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {createServer} from '../src/server.mjs';

test('workspace HTTP capabilities and event streams stay separated', {timeout:10000}, async () => {
  const reservation=net.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  const port=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
  const hub=new EventEmitter();
  Object.assign(hub,{generation:randomUUID(),sequence:{ai:0,secondary:0},hosts:new Map(),async host(){return {state:'ready'};}});
  const server=createServer({hub,journal:{get(){return null;}},attachments:{},plugins:{list(ws){return [{id:ws.id+'-only'}];}},port});
  await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${port}`,contexts={},controllers=[];
  try {
    const navigation=path=>new Promise((resolve,reject)=>http.get(base+path,{headers:{origin:'null','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'}},r=>{r.resume();r.on('end',()=>resolve({status:r.statusCode,location:r.headers.location}));}).on('error',reject));
    const home=await navigation('/');assert.equal(home.status,303);assert.equal(home.location,'/?workspace=ai');
    for(const path of ['/ui/official?workspace=secondary','/workspaces/secondary','/official/?workspace=secondary']){const r=await navigation(path);assert.equal(r.status,303);assert.equal(r.location,'/?workspace=secondary');}
    assert.equal((await navigation('/api/context')).status,403);
    for(const workspace of ['ai','secondary']){
      const response=await fetch(base+'/api/context',{method:'POST',body:JSON.stringify({workspace})});
      assert.equal(response.status,200);
      contexts[workspace]=await response.json();
    }
    for(const [from,to] of [['ai','secondary'],['secondary','ai']]){
      const response=await fetch(`${base}/api/w/${to}/plugins`,{headers:{Authorization:'Bearer '+contexts[from].token}});
      assert.equal(response.status,403,'A capability is bound to exactly one workspace.');
    }
    const unknown=await fetch(base+'/api/context',{method:'POST',body:JSON.stringify({workspace:'../../SECONDARY'})});
    assert.equal(unknown.status,403);
    const cross=await fetch(base+'/api/context',{method:'POST',headers:{Origin:'https://untrusted.example'},body:JSON.stringify({workspace:'ai'})});
    assert.equal(cross.status,403);
    const override=await fetch(base+'/api/w/ai/mutate',{method:'POST',headers:{Authorization:'Bearer '+contexts.ai.token},body:JSON.stringify({op:'new',requestId:randomUUID(),cwd:'/arbitrary/path'})});
    assert.equal(override.status,400,'The browser cannot widen the execution root.');
    const readers={};
    for(const workspace of ['ai','secondary']){
      const abort=new AbortController();controllers.push(abort);
      const response=await fetch(`${base}/api/w/${workspace}/events`,{headers:{Authorization:'Bearer '+contexts[workspace].token},signal:abort.signal});
      assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/event-stream/);
      readers[workspace]=response.body.getReader();
      const first=await readers[workspace].read();
      assert.match(new TextDecoder().decode(first.value),/sync\/required/);
    }
    hub.emit('event',{workspace:'ai',generation:hub.generation,seq:1,method:'item/agentMessage/delta',params:{threadId:randomUUID(),delta:'AI_ONLY_SENTINEL'}});
    const ai=new TextDecoder().decode((await readers.ai.read()).value);
    hub.emit('event',{workspace:'secondary',generation:hub.generation,seq:1,method:'item/agentMessage/delta',params:{threadId:randomUUID(),delta:'SECONDARY_ONLY_SENTINEL'}});
    const secondary=new TextDecoder().decode((await readers.secondary.read()).value);
    assert.match(ai,/AI_ONLY_SENTINEL/);assert.doesNotMatch(ai,/SECONDARY_ONLY_SENTINEL/);
    assert.match(secondary,/SECONDARY_ONLY_SENTINEL/);assert.doesNotMatch(secondary,/AI_ONLY_SENTINEL/);
  } finally {
    for(const controller of controllers)controller.abort();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  }
});
