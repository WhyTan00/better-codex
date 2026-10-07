import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
const source=await readFile(process.env.DSH_TEST_CACHE_SOURCE||new URL('../public/native-local-cache.js',import.meta.url),'utf8');
if(process.env.DSH_STOP_SCOPE)assert((await readFile(process.env.DSH_STOP_SCOPE,'utf8')).includes(source.trim()));
const a=source.indexOf('  const settingListeners='),b=source.indexOf('\n  services.requestUserInputAutoResolution=',a);
test('settings cache failure reads authoritative settings and cannot undo an acknowledged write',async()=>{
 const calls=[],notifications=[];
 const context={services:{},hostGeneration:1,appHostGeneration:1,window:{},meta:async()=>{throw Error('CACHE_TIMEOUT');},remote:async(service,method,args)=>{calls.push({method,args});return method==='readAll'?{values:{theme:'dark'},configuredValues:{theme:'dark'}}:undefined;},refreshOnce:()=>Promise.resolve(),saveMeta:async()=>{throw Error('CACHE_TIMEOUT');},structuredClone,invalidateReadChecks(){},notifySetting:(...args)=>notifications.push(args)};
 vm.runInNewContext(source.slice(a,b),context);
 assert.equal((await context.services.settings.readAll()).values.theme,'dark');
 await context.services.settings.subscribe('theme',value=>notifications.push(['theme',value]));
 await context.services.settings.write('theme','light');
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.filter(c=>c.method==='write').length,1);
 assert.equal(notifications.at(-1)[1].effective,'light');
});

const settle=()=>new Promise(resolve=>setImmediate(resolve));
function settingsFixture(){
 let stored={values:{theme:'old',locale:'zh-CN',unrelated:'preserved'},configuredValues:{theme:'old',locale:'zh-CN'}},release=null,hold=true,refresh=null,subscription=null,disposed=0;
 const writes=[],calls=[],context={services:{},hostGeneration:1,appHostGeneration:1,window:{},diagnostics:{settingsRefreshes:0},structuredClone,invalidateReadChecks(){},meta:async()=>structuredClone(stored),saveMeta:async(key,value)=>{writes.push(structuredClone(value));if(hold){hold=false;await new Promise(resolve=>release=resolve);}stored=structuredClone(value);},remote:async(service,method,args)=>{calls.push({method,args});if(method==='subscribe'){subscription=args[1];return {dispose(){disposed++;}};}if(method==='readAll')return structuredClone(stored);},refreshOnce:(key,interval,read,apply)=>{refresh={read,apply};return Promise.resolve();}};
 vm.runInNewContext(source.slice(a,b),context);
 return {services:context.services,context,writes,calls,release:()=>release(),notify:value=>subscription(value),disposed:()=>disposed,refresh:()=>refresh,stored:()=>structuredClone(stored)};
}
test('confirmed setting bursts coalesce disk projections and preserve unrelated keys',async()=>{
 const f=settingsFixture();await f.services.settings.write('theme','first');while(!f.writes.length)await settle();
 for(let i=0;i<20;i++)await f.services.settings.write('theme','theme-'+i);
 await f.services.settings.write('locale','en-US');
 assert.equal(f.writes.length,1);assert.equal((await f.services.settings.read('theme')).effective,'theme-19');
 f.release();for(let i=0;i<10;i++)await settle();
 assert.equal(f.writes.length,2);assert.equal(f.stored().values.theme,'theme-19');assert.equal(f.stored().values.locale,'en-US');assert.equal(f.stored().values.unrelated,'preserved');assert.equal(f.calls.filter(c=>c.method==='write').length,22);
});
test('disposed setting subscriptions stay closed and current Native refresh replaces the confirmed view',async()=>{
 const f=settingsFixture(),seen=[];const sub=await f.services.settings.subscribe('enabled-reasoning-efforts',v=>seen.push(v));await settle();
 await f.notify({effective:['low','ultra'],configured:['low','ultra']});
 assert.deepEqual(Array.from(seen.at(-1).effective),['low','max','ultra']);assert.deepEqual(Array.from(seen.at(-1).configured),['low','ultra']);
 sub.dispose();const count=seen.length;await f.notify({effective:['high'],configured:['high']});assert.equal(seen.length,count);assert.equal(f.disposed(),1);
 await f.services.settings.write('theme','local-confirmed');await f.services.settings.readAll();const refresh=f.refresh();
 await refresh.apply({epoch:3,value:{values:{theme:'stale-native'},configuredValues:{theme:'stale-native'}}});
 assert.equal((await f.services.settings.read('theme')).effective,'local-confirmed');
 const persisted=refresh.apply({epoch:4,value:{values:{theme:'current-native'},configuredValues:{theme:'current-native'}}});
 // Both notifications and the acknowledged write advance the epoch: a stale
 // read cannot override them, whereas a current Native snapshot must do so.
 assert.equal((await f.services.settings.read('theme')).effective,'current-native');
 f.release();await persisted;for(let i=0;i<10;i++)await settle();
});
