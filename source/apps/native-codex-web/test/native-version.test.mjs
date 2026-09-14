import test from 'node:test';import assert from 'node:assert/strict';import {nativeVersion} from '../src/native-version.mjs';
test('maintenance originator retains real paging capability instead of falling back to legacy hydration',()=>{
 assert.equal(nativeVersion({userAgent:'betterCodex_desktop_runtime_maintenance/0.153.4 (Mac OS 27.0.0; arm64) unknown (pwa_version_probe; 1.0.0)'}),'0.153.4');assert.equal(nativeVersion({userAgent:'Codex Desktop/0.153.4 (Mac OS)'}),'0.153.4');assert.equal(nativeVersion({userAgent:'codex-cli/0.145.0-alpha.15 (Mac OS)'}),'0.145.0-alpha.15');assert.equal(nativeVersion({userAgent:'unknown (client/1.0.0)'}),null);
});
