import test from 'node:test';
import assert from 'node:assert/strict';
import {assertClientDiagnosticClosure} from '../src/official-diagnostic-closure.mjs';
const entry=value=>`(()=>{\n const KEY='client-diagnostics-v2';\n ${value}\n})();`;
test('frozen entry rejects a stale early logger even when every file hash is valid',()=>{
 assert.throws(()=>assertClientDiagnosticClosure(entry('old();'),entry('new();')),/implementations differ/);
 assert.throws(()=>assertClientDiagnosticClosure('themeOnly();',entry('new();')),/implementations differ/);
});
test('matching diagnostic copies and small non-diagnostic fixtures remain valid',()=>{
 assert.doesNotThrow(()=>assertClientDiagnosticClosure(entry('new();'),entry('new();')));
 assert.doesNotThrow(()=>assertClientDiagnosticClosure('loader();','scope();'));
});
