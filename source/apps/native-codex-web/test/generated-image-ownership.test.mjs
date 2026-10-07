import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {OfficialFiles} from '../src/official-files.mjs';
import {runtimeProfile} from '../src/runtime-profile.mjs';
const denied=()=>Object.assign(Error('fixture scope denied'),{code:403});
test('Native generated image root checks its exact thread owner and retains original bytes',async t=>{
 const threadId=randomUUID(),root=path.join(runtimeProfile.codexHome,'generated_images',threadId),stateDir=await mkdtemp(path.join(tmpdir(),'dsh-generated-image-'));t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));await mkdir(root,{recursive:true,mode:0o700});const target=path.join(root,'exec-fixture.png'),bytes=Buffer.from([0,255,1,2]);await writeFile(target,bytes,{mode:0o600});const checks=[],files=new OfficialFiles({stateDir,boundary:{async checked(ws,id){checks.push({scope:ws.id,id});if(ws.id!=='ai'||id!==threadId)throw denied();}}});
 assert.deepEqual((await files.bytes('ai',target)).bytes,bytes);assert.deepEqual(checks,[{scope:'ai',id:threadId}]);await assert.rejects(files.bytes('zyy',target),error=>error.code===403);await assert.rejects(files.resolve('ai',path.join(runtimeProfile.codexHome,'auth.json')),error=>error.code===403);await assert.rejects(files.resolve('ai',path.join(runtimeProfile.codexHome,'generated_images','unowned.png')),error=>error.code===403);
});
test('owned generated image directory cannot follow a symlink into another thread or external file',async t=>{
 const threadId=randomUUID(),otherId=randomUUID(),base=path.join(runtimeProfile.codexHome,'generated_images'),root=path.join(base,threadId),other=path.join(base,otherId),stateDir=await mkdtemp(path.join(tmpdir(),'dsh-generated-link-'));t.after(()=>Promise.all([rm(root,{recursive:true,force:true}),rm(other,{recursive:true,force:true}),rm(stateDir,{recursive:true,force:true})]));await mkdir(root,{recursive:true,mode:0o700});await mkdir(other,{recursive:true,mode:0o700});const target=path.join(other,'private.png');await writeFile(target,Buffer.from('fixture'),{mode:0o600});await symlink(target,path.join(root,'linked.png'));const files=new OfficialFiles({stateDir,boundary:{async checked(ws,id){if(ws.id!=='ai'||id!==threadId)throw denied();}}});await assert.rejects(files.resolve('ai',path.join(root,'linked.png')),error=>error.code===403);
});
