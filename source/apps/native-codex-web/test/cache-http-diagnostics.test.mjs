import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';
const source=await readFile(new URL('../public/native-local-cache.js',import.meta.url),'utf8');
test('history failure retains HTTP status and the requested background thread identity',async()=>{
 const line=source.split('\n').find(s=>s.startsWith(' async function api(')),events=[],calls=[],id=randomUUID();assert(line);
 const ctx={crypto:{randomUUID},performance,scope:{id:'ai',token:'TEST'},base:'/sync/v1/w/ai',cloud:true,setTimeout:()=>1,clearTimeout(){},window:{__DSH_CLIENT_LOG__:{event:(_kind,row)=>events.push(row),routeClass:()=> 'native_read'},__DSH_CONNECTION_JSON__:async(url,options)=>{calls.push(options);return {response:{ok:false,status:503}};}}};
 vm.runInNewContext(line+';globalThis.call=api',ctx);
 await assert.rejects(ctx.call('/native-read',{method:'thread/turns/list',params:{threadId:id}}),e=>e.code==='503'&&e.statusCode===503);
 assert.equal(events.at(-1).threadId,id);assert.equal(events.at(-1).statusCode,503);assert.equal(events.at(-1).traceId,calls[0].headers['x-dsh-diagnostic-trace']);assert.equal(events.at(-1).method,'thread/turns/list');
});
