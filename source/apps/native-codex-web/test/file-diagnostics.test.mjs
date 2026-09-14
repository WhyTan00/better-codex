import test from 'node:test';import assert from 'node:assert/strict';
import {FileDiagnostics} from '../src/file-diagnostics.mjs';
test('file evidence distinguishes waiting, completion and rejection without keeping paths or contents',async()=>{
 let release;const block=new Promise(r=>release=r),events=[],d=new FileDiagnostics({limit:3,emit:e=>events.push(e)});
 const f=d.observe({bytes:async()=>{await block;return {bytes:Buffer.from('private contents')}},read:async()=>{throw Object.assign(Error('secret filename'),{code:413})},metadata:async()=>({contentKind:'text'}),entries:async()=>({entries:[]})});
 const pending=f.bytes('ai','/private/secret.txt');assert.equal(d.snapshot('ai')[0].state,'pending');release();await pending;
 await assert.rejects(f.read('ai',{path:'/private/secret.txt'}),e=>e.code===413);await f.metadata('secondary',{path:'/other/secret.txt'});
 assert.equal(d.snapshot('ai')[0].state,'completed');assert.equal(d.snapshot('ai')[1].state,'failed');assert.equal(d.snapshot('ai')[1].code,413);assert.equal(d.snapshot('secondary').length,1);
 assert.equal(d.snapshot('ai')[0].fileRef,d.snapshot('ai')[1].fileRef);assert(!JSON.stringify(events).includes('secret'));assert(!JSON.stringify(events).includes('private'));
 await f.entries('ai',{});assert.equal(d.entries.length,3);
});
