import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createControlPathTiming,createControlPathLog} from '../src/control-path-timing.mjs';
import {safeConnectionEvent,ConnectionDiagnostics} from '../src/connection-diagnostics.mjs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
function fixture(component='proxy'){
 let t=0,callback;const events=[],req={method:'GET',url:'/dsh-scope-session?workspace=ai',headers:{'x-dsh-diagnostic-trace':'11111111-1111-4111-a111-111111111111','cookie':'private','x-dsh-edge-at':'1791944000000'}},res=new EventEmitter();res.statusCode=200;res.writableFinished=true;
 const timing=createControlPathTiming({component,emit:e=>events.push(safeConnectionEvent(e)),now:()=>t,wall:()=>1791944000010,setTimer:cb=>{callback=cb;return 1;},clearTimer:()=>{callback=null;}});
 return {req,res,events,timing,advance:n=>{t+=n;},tick:()=>callback?.()};
}
test('same trace links edge, proxy and front; no secret captured',()=>{
 const a=fixture();a.timing.observe(a.req,a.res);assert.equal(a.req.headers['x-dsh-proxy-at'],'1791944000010');
 const b=fixture('front');b.req.headers=a.req.headers;b.timing.observe(b.req,b.res);
 assert.equal(b.events[0].traceId,a.events[0].traceId);assert.equal(b.events[0].proxyReceivedAtMs,1791944000010);assert.equal(a.events[0].edgeReceivedAtMs,1791944000000);assert.ok(!JSON.stringify(a.events).includes('private'));a.timing.close();b.timing.close();
});
test('fast success has only ingress; aborted/slow completion retained once',()=>{
 const a=fixture();a.timing.observe(a.req,a.res);a.advance(10);a.res.emit('finish');a.res.emit('close');assert.equal(a.events.length,1);a.timing.close();
 const b=fixture();b.timing.observe(b.req,b.res);b.advance(14000);b.res.writableFinished=false;b.res.emit('close');b.res.emit('finish');assert.equal(b.events.length,2);assert.equal(b.events[1].durationMs,14000);assert.equal(b.events[1].stage,'failed');b.timing.close();
});
test('loop delay only during bounded activity window and shutdown cancels timer',()=>{
 const f=fixture();f.timing.observe(f.req,f.res);f.advance(8000);f.tick();assert.equal(f.events.at(-1).timerLagMs,7000);f.advance(1000);f.tick();assert.equal(f.events.length,2);f.timing.close();f.advance(9000);f.tick();assert.equal(f.events.length,2);
});
test('unrelated traffic, foreign scope and malformed trace do not start tracking',()=>{
 const f=fixture();f.req.url='/other';f.timing.observe(f.req,f.res);f.req.url='/dsh-scope-session?workspace=zyy';f.timing.observe(f.req,f.res);f.req.url='/dsh-scope-session?workspace=ai';f.req.headers['x-dsh-diagnostic-trace']='private';f.timing.observe(f.req,f.res);assert.equal(f.events.length,0);
});
test('noisy RPC rotations cannot evict the separately retained control incident',async t=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'control-evidence-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const control=createControlPathLog(path.join(dir,'control-path.jsonl'));
 const noisy=new ConnectionDiagnostics({file:path.join(dir,'connections.jsonl'),maxBytes:512,maxArchives:1});
 control.event({component:'front',reason:'control_timing',stage:'received',traceId:'11111111-1111-4111-a111-111111111111',receivedAtMs:1791944000010,cookie:'secret'});await control.flush();
 for(let i=0;i<100;i++)noisy.event({component:'native',method:'thread/read',stage:'received',durationMs:i});
 await noisy.close();await control.close();
 const rows=(await readFile(control.file,'utf8')).trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,1);assert.equal(rows[0].traceId,'11111111-1111-4111-a111-111111111111');assert.equal(rows[0].cookie,undefined);
 assert.equal((await readFile(noisy.file,'utf8')).includes('control_timing'),false);
});
test('proxy-owned timestamp replaces untrusted incoming proxy timestamp in both header and event',()=>{
 const f=fixture();f.req.headers['x-dsh-proxy-at']='1791943999999';f.timing.observe(f.req,f.res);
 assert.equal(f.events[0].proxyReceivedAtMs,1791944000010);assert.equal(f.req.headers['x-dsh-proxy-at'],'1791944000010');f.timing.close();
});
