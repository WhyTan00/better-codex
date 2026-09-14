import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {OfficialFiles} from '../src/official-files.mjs';
import {Journal} from '../src/journal.mjs';
test('queued images outlive composer cleanup and a front reopen',async t=>{
 const dir=await mkdtemp(tmpdir()+'/betterCodex-queue-files-');let journal=new Journal(dir),files=new OfficialFiles({stateDir:dir,boundary:{journal}});t.after(async()=>{journal.close();await rm(dir,{recursive:true,force:true});});
 const kept=(await files.createTemporary('ai',{bytes:[1,2,3],fileName:'queued.png'})).path,unused=(await files.createTemporary('ai',{bytes:[4],fileName:'unused.png'})).path;
 await files.retainQueuedInput('ai',[{type:'localImage',path:kept}]);await files.releaseTemporary('ai',kept);await files.releaseTemporary('ai',unused);assert.equal((await stat(kept)).size,3);await assert.rejects(stat(unused),e=>e.code==='ENOENT');
 journal.close();journal=new Journal(dir);files=new OfficialFiles({stateDir:dir,boundary:{journal}});files.temporary.set(kept,'ai');await files.releaseTemporary('ai',kept);assert.equal((await stat(kept)).size,3);
 await assert.rejects(files.retainQueuedInput('secondary',[{type:'localImage',path:kept}]),e=>e.code===403);
});
