import test from 'node:test';
import assert from 'node:assert/strict';
import {env} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';

test('an exact durable ACK survives incident enrichment while upload is in flight',async()=>{
 let delayed=false,release,uploaded;
 const f=env({online:true,fetchImpl:(_u,o)=>{
  const ids=JSON.parse(o.body).events.map(e=>e.eventId);
  const receipt={ok:true,json:async()=>({received:true,acknowledgedEventIds:ids})};
  if(!delayed)return receipt;uploaded=ids;return new Promise(r=>{release=()=>r(receipt);});
 }});
 await f.log.flush();f.c.Date={now:()=>Date.now()+60000};
 const id=f.log.event('history_read',{threadId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});
 delayed=true;const inFlight=f.log.flush();for(let i=0;i<8&&!release;i++)await Promise.resolve();
 assert(uploaded.includes(id));
 const fault=f.log.event('js_error',{failureClass:'connection'});
 release();await inFlight;delayed=false;await f.log.flush();
 assert.equal(f.uploads.flatMap(e=>e.events).filter(e=>e.eventId===id).length,1);
 assert(f.uploads.flatMap(e=>e.events).some(e=>e.eventId===fault));
 assert.equal(f.log.snapshot().pendingCount,0);
 const reopened=env({storage:f.storage});assert.equal(reopened.log.snapshot().events.filter(e=>e.eventId===id).length,0);
});

test('resource fingerprints distinguish paths and ignore query credentials',()=>{
 const f=env();f.c.URL=URL;f.c.location.href='https://example.test/';
 for(const src of ['https://example.test/a.png?token=SECRET','https://example.test/a.png?token=OTHER','https://example.test/b.png?token=SECRET','data:image/png;base64,PRIVATE'])
  f.listeners.error({target:{tagName:'IMG',src}});
 const rows=f.log.snapshot().events.filter(e=>e.kind==='resource_error');
 assert.equal(rows.filter(e=>e.contentHash).length,2);
 assert.notEqual(rows[0].contentHash,rows[1].contentHash);
 assert(!/SECRET|OTHER|PRIVATE|a\.png|b\.png/.test(JSON.stringify(rows)));
});
