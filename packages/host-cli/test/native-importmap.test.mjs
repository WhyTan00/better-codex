import test from 'node:test';import assert from 'node:assert/strict';
import {normalizeOfficialImportMap,assertOfficialModuleIdentity} from '../../../source/apps/native-codex-web/src/official-import-map.mjs';
const primary='app-primary-fixture.js',initial='app-initial-fixture.js',thread='local-conversation-thread-fixture.js',old='/official-patched-v1066/assets/',current='/official-patched-v1072/assets/',base='/official-patched-v8/assets/';
function resolve(map,url){if(Object.hasOwn(map.imports,url))return map.imports[url];const prefix=Object.keys(map.imports).filter(k=>k.endsWith('/')&&url.startsWith(k)).sort((a,b)=>b.length-a.length)[0];return prefix?map.imports[prefix]+url.slice(prefix.length):url;}
test('old module imports and direct new imports share one module identity without recursive remapping',()=>{
 const map={imports:{[base+primary]:current+primary,[base+initial]:current+initial,[old]:base,[current]:base,[current+primary]:current+primary,[current+initial]:current+initial,[old+thread]:old+thread}};
 assert.notEqual(resolve(map,old+primary),resolve(map,current+primary));
 assert.throws(()=>assertOfficialModuleIdentity(map),/identity splits/);
 const fixed=normalizeOfficialImportMap(map);assert.equal(assertOfficialModuleIdentity(fixed),true);
 for(const prefix of [old,current,base]){assert.equal(resolve(fixed,prefix+primary),current+primary);assert.equal(resolve(fixed,prefix+initial),current+initial);assert.equal(resolve(fixed,prefix+thread),old+thread);}
 assert.equal(resolve(fixed,current+'unmodified.js'),base+'unmodified.js');
 assert.deepEqual(normalizeOfficialImportMap(structuredClone(fixed)),fixed);
});
test('native turn override remains canonical across all module directories',()=>{
 const target='/dsh-native-assets/aaaaaaaaaaaaaaaa/turn.js',map=normalizeOfficialImportMap({imports:{[base+'turn.js']:target,[old]:base,[current+primary]:current+primary}});
 assert.equal(resolve(map,old+'turn.js'),target);assert.equal(resolve(map,current+'turn.js'),target);
});
