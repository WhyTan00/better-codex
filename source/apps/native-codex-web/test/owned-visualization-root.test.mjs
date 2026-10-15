import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,symlink,rm,lstat} from 'node:fs/promises';
import {ownedVisualizationRootAllowed as allowed} from '../src/owned-visualization-root.mjs';

const id='11111111-1111-4111-a111-111111111111',other='22222222-2222-4222-a222-222222222222';
async function fixture(t){const temp=await mkdtemp(path.join(os.tmpdir(),'owned-visualization-'));t.after(()=>rm(temp,{recursive:true,force:true}));const home=path.join(temp,'home');await mkdir(home);const base=path.join(home,'visualizations'),owner=path.join(base,'2026/10/09',id);return {temp,home,base,owner};}

test('first-turn generated root is allowed without mkdir',async t=>{const f=await fixture(t);await mkdir(path.dirname(f.owner),{recursive:true});assert.equal(await allowed(f.owner,f.home,id),true);await assert.rejects(lstat(f.owner),{code:'ENOENT'});});
test('first visualization tree can be absent beneath trusted home',async t=>{const f=await fixture(t);assert.equal(await allowed(f.owner,f.home,id),true);await assert.rejects(lstat(f.base),{code:'ENOENT'});});
test('owned uncreated descendants remain allowed',async t=>{const f=await fixture(t);await mkdir(f.owner,{recursive:true});assert.equal(await allowed(path.join(f.owner,'images/next'),f.home,id),true);});
test('existing owned root and descendants retain acceptance',async t=>{const f=await fixture(t);const child=path.join(f.owner,'images');await mkdir(child,{recursive:true});assert.equal(await allowed(f.owner,f.home,id),true);assert.equal(await allowed(child,f.home,id),true);});
test('existing file is not a runtime directory',async t=>{const f=await fixture(t);await mkdir(f.owner,{recursive:true});const file=path.join(f.owner,'result.txt');await writeFile(file,'artifact');assert.equal(await allowed(file,f.home,id),false);});
test('existing traversal is rejected before realpath normalization',async t=>{const f=await fixture(t);await mkdir(path.join(f.owner,'images'),{recursive:true});assert.equal(await allowed(f.owner+'/images/../',f.home,id),false);assert.equal(await allowed(f.owner+'/./images',f.home,id),false);});
test('other thread and malformed paths remain denied',async t=>{const f=await fixture(t);for(const root of [f.owner.replace(id,other),f.owner.replace('2026/10/09','not-a-date'),path.join(f.temp,'foreign',id),f.base+'-other/2026/10/09/'+id])assert.equal(await allowed(root,f.home,id),false);});
test('uncreated traversal cannot be normalized into another owner',async t=>{const f=await fixture(t);assert.equal(await allowed(f.owner+'/../'+other,f.home,id),false);assert.equal(await allowed(f.owner+'/next/../images',f.home,id),false);});
test('existing ancestor file does not authorize a directory',async t=>{const f=await fixture(t);await mkdir(f.base,{recursive:true});await writeFile(path.join(f.base,'2026'),'file');assert.equal(await allowed(f.owner,f.home,id),false);});
test('dangling ancestor symlink remains denied',async t=>{const f=await fixture(t);await mkdir(f.base);await symlink(path.join(f.temp,'missing'),path.join(f.base,'2026'));assert.equal(await allowed(f.owner,f.home,id),false);});
test('dangling base symlink remains denied',async t=>{const f=await fixture(t);await symlink(path.join(f.temp,'missing'),f.base);assert.equal(await allowed(f.owner,f.home,id),false);});
test('ancestor symlink cannot escape or alias another thread',async t=>{const f=await fixture(t);const outside=path.join(f.temp,'outside');await mkdir(outside);await mkdir(path.dirname(f.owner),{recursive:true});await symlink(outside,f.owner);assert.equal(await allowed(f.owner+'/next',f.home,id),false);assert.equal(await allowed(f.owner,f.home,id),false);});
test('trusted existing base symlink retains existing semantics',async t=>{const f=await fixture(t);const store=path.join(f.temp,'store');await mkdir(store);await symlink(store,f.base);assert.equal(await allowed(f.owner,f.home,id),true);await mkdir(f.owner,{recursive:true});assert.equal(await allowed(f.owner,f.home,id),true);});
test('missing or non-directory trusted home remains denied',async t=>{const f=await fixture(t);await rm(f.home,{recursive:true});assert.equal(await allowed(f.owner,f.home,id),false);await writeFile(f.home,'file');assert.equal(await allowed(f.owner,f.home,id),false);});
