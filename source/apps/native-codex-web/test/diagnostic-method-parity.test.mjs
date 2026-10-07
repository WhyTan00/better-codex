import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {env} from '../../../../scripts/lib/client-diagnostics-fixture.mjs';
import {safeClientDiagnostic} from '../src/performance-events.mjs';
import {safeConnectionEvent,rpcDiagnosticContext,errorDiagnosticFields} from '../src/connection-diagnostics.mjs';
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
test('Mac fallback retains the same bounded recovery evidence as the browser',async()=>{
 const source=await read('../public/client-diagnostics.js');
 const contract=JSON.parse(source.match(/const contract=(\{.*?\}),TTL=/)[1]);
 for(const [key,values]of Object.entries(contract.enums))for(const value of values)assert.equal(safeClientDiagnostic({[key]:value})[key],value,`${key} ${value}`);
 for(const key of contract.hex)assert.equal(safeClientDiagnostic({[key]:'0123456789abcdef'})[key],'0123456789abcdef',key);
 for(const key of contract.numeric)assert.equal(safeClientDiagnostic({[key]:7})[key],7,key);
 for(const key of contract.boolean)assert.equal(safeClientDiagnostic({[key]:true})[key],true,key);
});
test('all bridge and scoped RPC names survive every diagnostic collector, without accepting arbitrary strings',async()=>{
 const adapter=await read('../public/android-native-adapter.js'),boundary=await read('../src/official-boundary.mjs'),go=await read('../../sync-gateway/performance.go'),native=await read('../../android-client/app/src/main/java/top/whytan/dsh/NativeDiagnostics.java');
 const strings=s=>[...s.matchAll(/'([^']+)'/g)].map(m=>m[1]);
 // Diagnostic delivery deliberately does not diagnose itself: doing so would
 // create a new pending log for every successful log delivery.
 const bridge=strings(adapter.match(/SAFE_METHODS=new Set\(\[([^\]]+)\]/)[1]).filter(method=>method!=='recordDiagnostics');
 const methods=new Set([...bridge,...[...boundary.matchAll(/const (?:READS|WRITES|GLOBAL)=new Set\(\[([^\]]+)\]/g)].flatMap(m=>strings(m[1])),...['plugin/list','plugin/installed','thread/metadata/update','thread/unsubscribe','externalAgentConfig/import/readHistories','account/rateLimits/read','mcpServerStatus/list','app/list']]);
 const gateway=new Set([...go.match(/"method":\s*\{([^}]+)\}/)[1].matchAll(/"([^"]+)"/g)].map(m=>m[1]));
 const nativeMethods=new Set(native.match(/METHODS = set\("([^"]+)"\)/)[1].split(' '));
 const f=env();
 for(const method of methods){
  f.log.event('client_health',{method,stage:'received'});assert.equal(f.log.snapshot().events.at(-1).method,method,`browser ${method}`);
  assert.equal(safeClientDiagnostic({method}).method,method,`front performance ${method}`);
  assert.equal(safeConnectionEvent(rpcDiagnosticContext({method})).method,method,`front RPC ${method}`);
  assert(gateway.has(method),`gateway ${method}`);
 }
 for(const method of bridge)assert(nativeMethods.has(method),`native bridge ${method}`);
 assert.equal(safeClientDiagnostic({method:'PRIVATE_SECRET'}).method,undefined);
 assert.equal(safeConnectionEvent(rpcDiagnosticContext({method:'PRIVATE_SECRET'})).method,undefined);
 assert.equal(errorDiagnosticFields({code:403}).errorCode,'403');
});
