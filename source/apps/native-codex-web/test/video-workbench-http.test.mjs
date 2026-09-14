import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createVideoWorkbenchHttp,byteRange} from '../src/video-workbench-http.mjs';
import {createServer} from '../src/server.mjs';
import {isWorkspaceNavigation} from '../src/navigation.mjs';

test('range semantics reject malformed, multiple, beyond-end and zero suffix ranges',()=>{
 assert.deepEqual(byteRange('bytes=2-5',10),{start:2,end:5});assert.deepEqual(byteRange('bytes=-3',10),{start:7,end:9});assert.deepEqual(byteRange('bytes=7-',10),{start:7,end:9});
 for(const value of ['bytes=10-','bytes=7-2','bytes=-0','bytes=0-1,3-4','bytes=-','wat'])assert.throws(()=>byteRange(value,10),e=>e.code===416);
});
test('opaque SSO navigation permits only the video document, not its API writes or media grants',()=>{
 const headers={origin:'null','sec-fetch-site':'cross-site','sec-fetch-mode':'navigate','sec-fetch-dest':'document'};
 assert(isWorkspaceNavigation({url:'/video-workbench?workspace=ai',method:'GET',headers}));
 assert(!isWorkspaceNavigation({url:'/api/w/ai/video-workbench/feedback',method:'POST',headers}));
 assert(!isWorkspaceNavigation({url:'/api/video-media/invalid/video',method:'GET',headers}));
});
test('video media requires a scoped ticket, streams precise ranges, supports HEAD, and rejects changed versions',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'video-http-'));const file=path.join(dir,'fixture.mp4'),bytes=Buffer.from('0123456789abcdef');await writeFile(file,bytes);
 const id='a'.repeat(24);let revision='v1';let feedbackCalls=0;
 const service={async record(value){if(value!==id)throw Object.assign(Error('unknown'),{code:404});return {id,revision};},async media(){return {file,revision,type:'video/mp4',fileName:'测试.mp4'};},async list(){return {items:[]};},async feedback(){feedbackCalls++;return {ok:true};}};
 let projectActive=true;
 const handler=createVideoWorkbenchHttp({service,checkProject:async()=>{if(!projectActive)throw Object.assign(Error('project retired'),{code:403});}});
 const server=http.createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');if(await handler.media(u,req,res))return;const m=u.pathname.match(/^\/(ai|secondary)\/(.*)$/);if(!m){res.writeHead(404);return res.end();}await handler.api({id:m[1],plugins:['video']},m[2],u,req,res);}catch(e){res.writeHead(e.code||500);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 try{assert.equal((await fetch(base+'/secondary/video-workbench/catalog')).status,403);assert.equal((await fetch(base+'/api/video-media/'+'x'.repeat(32)+'/video')).status,404);
  const t=await (await fetch(base+'/ai/video-workbench/assets/'+id+'/ticket',{method:'POST'})).json();
  const range=await fetch(base+t.videoUrl,{headers:{range:'bytes=2-7'}});assert.equal(range.status,206);assert.equal(await range.text(),'234567');assert.equal(range.headers.get('content-range'),'bytes 2-7/16');assert.match(range.headers.get('cache-control'),/no-store/);
  const head=await fetch(base+t.videoUrl,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'16');assert.equal((await head.arrayBuffer()).byteLength,0);
  const suffix=await fetch(base+t.videoUrl,{headers:{range:'bytes=-3'}});assert.equal(await suffix.text(),'def');
  const multi=await fetch(base+t.videoUrl,{headers:{range:'bytes=0-1,4-6'}});assert.equal(multi.status,416);
  assert.match((await fetch(base+t.downloadUrl)).headers.get('content-disposition'),/filename\*=UTF-8/);
  revision='v2';assert.equal((await fetch(base+t.videoUrl)).status,409);
  projectActive=false;assert.equal((await fetch(base+t.videoUrl)).status,403);assert.equal((await fetch(base+'/ai/video-workbench/catalog')).status,403);projectActive=true;
  assert.equal((await fetch(base+'/secondary/video-workbench/feedback',{method:'POST',body:'{}'})).status,403);assert.equal(feedbackCalls,0);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('existing plugin HTTP server serves the new page without the native front and enforces workspace/CSRF',async()=>{
 const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 const hub=new EventEmitter();Object.assign(hub,{generation:'test',hosts:new Map(),active:new Map()});
 const server=createServer({hub,journal:{},attachments:{},plugins:{list:()=>[]},port});await new Promise(r=>server.listen(port,'127.0.0.1',r));const base='http://127.0.0.1:'+port;
 try{const r=await fetch(base+'/video-workbench?workspace=ai');assert.equal(r.status,200);assert.match(await r.text(),/视频工作台/);
  for(const file of ['/video-workbench.js','/video-workbench.css'])assert.equal((await fetch(base+file)).status,200);
  assert.equal((await fetch(base+'/video-workbench?workspace=secondary')).status,403);
  const ai=await (await fetch(base+'/api/context',{method:'POST',body:JSON.stringify({workspace:'ai'})})).json();
  assert.equal((await fetch(base+'/api/w/secondary/video-workbench/catalog',{headers:{authorization:'Bearer '+ai.token}})).status,403);
  const secondary=await (await fetch(base+'/api/context',{method:'POST',body:JSON.stringify({workspace:'secondary'})})).json();
  assert.equal((await fetch(base+'/api/w/secondary/video-workbench/catalog',{headers:{authorization:'Bearer '+secondary.token}})).status,403);
  assert.equal((await fetch(base+'/api/w/ai/video-workbench/feedback',{method:'POST',headers:{authorization:'Bearer '+ai.token,origin:'https://untrusted.example'},body:'{}'})).status,403);
  assert.equal((await fetch(base+'/api/w/ai/video-workbench/submit',{method:'POST',headers:{authorization:'Bearer '+ai.token},body:'{}'})).status,404);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
