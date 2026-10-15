import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const script = await readFile(new URL('../public/client-diagnostics.js', import.meta.url), 'utf8');

function fixture({ackCount=Infinity,scripts=[script]}={}) {
  class Storage {
    constructor() { this.values = new Map(); }
    get length() { return this.values.size; }
    key(index) { return [...this.values.keys()][index] ?? null; }
    getItem(key) { return this.values.get(key) ?? null; }
    setItem(key, value) { this.values.set(key, String(value)); }
    removeItem(key) { this.values.delete(key); }
  }
  const listeners = {};
  const timers = new Map();
  let timerId = 0;
  let uuid = 0;
  let clock = 1_000_000;
  const context = {
    Date: { now: () => clock },
    performance,
    navigator: { onLine: true },
    localStorage: new Storage(),
    URL,
    AbortController,
    crypto: { randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, '0')}` },
    location: { pathname: '/', href: 'https://workbench.example.test/', origin: 'https://workbench.example.test' },
    document: { visibilityState: 'visible', addEventListener: (type, listener) => { listeners[type] = listener; } },
    addEventListener: (type, listener) => { listeners[type] = listener; },
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  };
  context.window = {
    __DSH_SCOPE__: { id: 'ai', token: 'scope-token' },
    fetch: async (_url,options) => ({ ok: true, json: async () => ({ received: true, acknowledgedEventIds:JSON.parse(options.body).events.slice(0,ackCount).map(row=>row.eventId) }) }),
  };
  for(const value of scripts)vm.runInNewContext(value, context);
  return {
    log: context.window.__DSH_CLIENT_LOG__,
    error(event) { listeners.error({target:context.window,...event}); },
    setClock(value) { clock = value; },
  };
}

if(process.env.DSH_DIAGNOSTIC_LOADER&&process.env.DSH_DIAGNOSTIC_SCOPE)test('the real early loader and lazy scope keep the latest diagnostic behavior in load order',async()=>{
 const extract=s=>{const at=s.indexOf("KEY='client-diagnostics-v2'"),start=s.lastIndexOf('(()=>{',at),end=s.indexOf('\n})();',at);assert(at>=0&&start>=0&&end>start);return s.slice(start,end+6);};
 const values=await Promise.all([process.env.DSH_DIAGNOSTIC_LOADER,process.env.DSH_DIAGNOSTIC_SCOPE].map(async p=>extract(await readFile(p,'utf8'))));
 const x=fixture({scripts:values});x.log.reportError('promise_rejection',Object.assign(Error('PRIVATE'),{errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',status:503}));
 const error=x.log.snapshot().events.find(e=>e.kind==='promise_rejection');assert.equal(error.failureClass,'connection');assert.equal(error.reason,'offline');assert.equal(error.statusCode,503);
 const request={type:'fetch',requestId:'fixture-load-order',url:'vscode://codex/ensure-directory'};x.log.ipc('codex_desktop:message-from-view',request);x.log.handled(request);
 assert.equal(x.log.snapshot().events.filter(e=>e.kind==='rpc').length,1);x.log.response({type:'fetch-response',requestId:request.requestId,responseType:'error',status:503,errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',error:'PRIVATE'});
 assert.deepEqual(Array.from(x.log.snapshot().events.filter(e=>e.kind==='rpc'),e=>e.stage),['requested','failed']);
 assert(!JSON.stringify(x.log.snapshot()).includes('PRIVATE'));
});

test('local routing acknowledgement cannot replace a fetch result or hide a rejected preparation',()=>{
 const x=fixture(),p={type:'fetch',requestId:'fixture-request',url:'vscode://codex/ensure-directory'};
 x.log.ipc('codex_desktop:message-from-view',p);x.log.handled(p);
 assert.equal(x.log.snapshot().events.filter(e=>e.kind==='rpc').length,1);
 x.log.response({type:'fetch-response',requestId:p.requestId,responseType:'error',status:503,errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',error:'PRIVATE_TEXT'});
 x.log.response({type:'fetch-response',requestId:p.requestId,responseType:'error',status:503,errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',error:'PRIVATE_TEXT'});
 const rows=x.log.snapshot().events.filter(e=>e.kind==='rpc');assert.deepEqual(Array.from(rows,e=>e.stage),['requested','failed']);assert.equal(rows[1].reason,'offline');assert.equal(rows[1].statusCode,503);
 assert(!JSON.stringify(rows).includes('PRIVATE_TEXT'));
});
test('only the exact offline gate code classifies an expected SDK rejection without dropping it',()=>{
 const x=fixture();
 for(const error of [Object.assign(Error('PRIVATE_TEXT'),{errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',status:503}),Object.assign(Error('PRIVATE_TEXT'),{errorCode:'OTHER',status:503}),Object.assign(Error('PRIVATE_TEXT'),{errorCode:'DSH_NATIVE_OFFLINE_REQUIRED',status:500})])x.log.reportError('promise_rejection',error);
 const rows=x.log.snapshot().events.filter(e=>e.kind==='promise_rejection');assert.equal(rows.length,3);
 assert.equal(rows[0].failureClass,'connection');assert.equal(rows[0].reason,'offline');assert.equal(rows[0].statusCode,503);
 assert.equal(rows[1].failureClass,'unknown');assert.equal(rows[2].failureClass,'unknown');assert(!JSON.stringify(rows).includes('PRIVATE_TEXT'));
});
test('layout notifications stay visible without being mislabeled as missing resources or swallowing exceptions',()=>{
 const x=fixture();
 x.error({message:'ResizeObserver loop completed with undelivered notifications.'});
 x.error({message:'ResizeObserver loop limit exceeded'});
 const notifications=x.log.snapshot().events.filter(e=>e.reason==='resize_observer');
 assert.equal(notifications.length,2);assert(notifications.every(e=>e.kind==='render_error'&&e.failureClass==='layout_observer'));
 x.error({message:'ResizeObserver loop limit exceeded',error:new TypeError('PRIVATE_TOKEN'),target:{tagName:'SCRIPT'}});
 x.error({message:'PRIVATE_WINDOW_ERROR'});
 x.error({target:{tagName:'IMG',src:'https://example.test/private?token=SECRET'}});
 const rows=x.log.snapshot().events;
 assert.equal(rows.filter(e=>e.kind==='js_error').length,2);
 assert.equal(rows.filter(e=>e.kind==='resource_error'&&e.resourceKind==='image').length,1);
 assert(!JSON.stringify(rows).includes('PRIVATE'));assert(!JSON.stringify(rows).includes('SECRET'));
});

test('a partial durable receipt removes only its exact acknowledged events',async()=>{
 const x=fixture({ackCount:1});
 x.log.event('history_applied',{});x.log.event('history_read',{});
 const before=x.log.snapshot().pendingCount;
 await x.log.flush();
 assert.equal(x.log.snapshot().pendingCount,before-1);
 assert.equal(x.log.snapshot().uploadFailures,1);
});

test('a full durable receipt drains the batch',async()=>{
 const x=fixture();x.log.event('history_applied',{});
 await x.log.flush();assert.equal(x.log.snapshot().pendingCount,0);
});
test('remote AppHost failures retain their safe cause instead of becoming unknown submit errors',()=>{
 const x=fixture();
 for(const failure of ['RPC_CONTRACT','CONNECTION','WRITER_BUSY','STORAGE','UNAVAILABLE','REPLACED']){
  x.log.reportError('submit_failed',Error('DSH_APP_HOST_'+failure+': safe public text'),{stage:'failed'});
  const row=x.log.snapshot().events.at(-1);assert.equal(row.failureClass,['UNAVAILABLE','REPLACED'].includes(failure)?'connection':failure.toLowerCase());assert(!JSON.stringify(row).includes('safe public text'));
 }
});

test('editor AggregateError keeps bounded safe child causes without leaking their text',()=>{
 const x=fixture();
 const child=Object.assign(new TypeError('private content and credentials must not appear: quota exceeded'),{stack:'TypeError: secret\n at app-initial-2377232f6f33.js:1922:17288'});
 x.log.reportError('js_error',new AggregateError(Array(10).fill(child)));
 const rows=x.log.snapshot().events.filter(e=>e.kind==='js_error');
 assert.equal(rows.length,5);
 assert.equal(rows[0].errorName,'AggregateError');
 assert.equal(rows[1].errorName,'TypeError');
 assert.equal(rows[1].failureClass,'storage');
 assert.equal(rows[1].parentTraceId,rows[0].eventId);
 assert.deepEqual(Array.from(rows[1].errorFrames),['app-initial-2377232f6f33.js:1922:17288']);
 assert(!JSON.stringify(rows).includes('credentials'));
 assert(!JSON.stringify(rows).includes('secret'));
});

test('bounded Web diagnostic storage keeps notification/history milestones through background floods', () => {
  const x = fixture();
  const keyIds = [
    x.log.event('client_health', { stage: 'received', reason: 'notification_open' }),
    x.log.event('history_rejected', { stage: 'failed', reason: 'history_rejected' }),
    x.log.event('client_health', { stage: 'committed', reason: 'history_committed' }),
    x.log.event('client_health', { stage: 'shown', reason: 'periodic' }),
  ];
  assert(keyIds.every(Boolean));

  // Let the incident window expire so the following rows remain background
  // rows rather than inheriting the milestone's incident context.
  x.setClock(1_031_000);
  for (let i = 0; i < 500; i += 1) {
    if (i % 2 === 0) x.log.event('client_health', { stage: 'requested', reason: 'periodic' });
    else x.log.event('rpc', { stage: 'received', reason: 'request_received', method: 'thread/turns/list' });
  }

  const snapshot = x.log.snapshot();
  assert(snapshot.events.length <= 400);
  for (const id of keyIds) assert(snapshot.events.some(row => row.eventId === id), `missing ${id}`);
  assert(snapshot.journalDropped > 0);
});
