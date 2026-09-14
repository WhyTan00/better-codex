import test from 'node:test';
import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import {TextResponses} from '../src/official-http-text.mjs';
const response=()=>({writeHead(status,headers){this.status=status;this.headers=headers;},end(bytes){this.bytes=bytes;}});
test('startup text roundtrips compressed; opt-out and HEAD follow HTTP semantics',async()=>{
 const sender=new TextResponses(),text='中文配置'.repeat(1000);
 const res=response();await sender.send({method:'GET',headers:{'accept-encoding':'br, gzip'}},res,text,{'cache-control':'no-store'});
 assert.equal(gunzipSync(res.bytes).toString(),text);assert(res.bytes.length<Buffer.byteLength(text)/5);assert.equal(res.headers['cache-control'],'no-store');assert.equal(sender.adapter,null);
 const raw=response();await sender.send({method:'GET',headers:{'accept-encoding':'gzip;q=0, *;q=1'}},raw,text,{});assert.equal(raw.headers['content-encoding'],undefined);assert.equal(raw.bytes.toString(),text);
 const head=response();await sender.send({method:'HEAD',headers:{'accept-encoding':'gzip'}},head,text,{});assert.equal(head.bytes,undefined);assert(head.headers['content-length']>0);
});
test('public adapter conditional requests return 304, changed source changes validator',async()=>{
 const sender=new TextResponses(),first=response();await sender.send({method:'GET',headers:{}},first,'adapter'.repeat(1000),{},{adapter:true});
 const same=response();await sender.send({method:'GET',headers:{'if-none-match':first.headers.etag}},same,'adapter'.repeat(1000),{},{adapter:true});assert.equal(same.status,304);assert.equal(same.bytes,undefined);
 const changed=response();await sender.send({method:'GET',headers:{'if-none-match':first.headers.etag}},changed,'new adapter'.repeat(1000),{},{adapter:true});assert.equal(changed.status,200);assert.notEqual(first.headers.etag,changed.headers.etag);
});
