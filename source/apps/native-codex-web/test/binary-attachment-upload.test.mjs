import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {OfficialFiles} from '../src/official-files.mjs';

async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'dsh-binary-upload-'));t.after(()=>rm(root,{recursive:true,force:true}));return new OfficialFiles({stateDir:root,boundary:{serial:(_key,fn)=>fn()}});}
test('binary batch writes original bytes and returns the existing mixed-image/file receipt contract',async t=>{
 const files=await fixture(t),one=Buffer.from([0,255,1,2,3]),two=Buffer.from('文件 original');
 const input=[{name:'one.png',type:'image/png',size:one.length,lastModified:17},{name:'../../note.txt',type:'text/plain',size:two.length,lastModified:23}],result=await files.uploadBytes('ai',input,Buffer.concat([one,two]));
 assert.equal(result.files.length,2);
 for(let index=0;index<2;index++){const receipt=result.files[index];assert.equal(receipt.path,receipt.fsPath);assert.equal(receipt.path,receipt.filePath);assert.equal(receipt.size,input[index].size);assert.equal(receipt.lastModified,input[index].lastModified);assert.deepEqual((await files.bytes('ai',receipt.path)).bytes,index===0?one:two);await assert.rejects(files.resolve('zyy',receipt.path),error=>error.code===403);}
 assert.equal(result.files[1].label,'note.txt');
});
test('malformed, partial and oversized batch metadata is rejected before creating any attachment',async t=>{
 const files=await fixture(t),valid=[{name:'a.png',size:1}];
 for(const [metadata,bytes,code] of [[valid,Buffer.alloc(0),400],[valid,Buffer.alloc(2),400],[[{name:'a.png',size:-1}],Buffer.alloc(0),400],[[{name:'a.png',size:1.1}],Buffer.alloc(0),400],[[{name:'a.png',size:20*1024*1024+1}],Buffer.alloc(0),413],[Array.from({length:21},()=>({name:'a.png',size:0})),Buffer.alloc(0),413]])await assert.rejects(files.uploadBytes('ai',metadata,bytes),error=>error.code===code);
 assert.deepEqual(await readdir(files.root).catch(error=>{if(error.code==='ENOENT')return[];throw error;}),[]);
});
test('zero-byte files and exact subarray boundaries retain the established local receipt semantics',async t=>{
 const files=await fixture(t),body=Uint8Array.from([9,1,2,9]).subarray(1,3),result=await files.uploadBytes('ai',[{name:'.',size:0},{name:'x.txt',size:2}],body);
 assert.equal(result.files[0].label,'attachment');assert.equal(result.files[0].size,0);assert.deepEqual((await files.bytes('ai',result.files[1].path)).bytes,Buffer.from([1,2]));
});
test('temporary upload uses the same binary storage and retain/release ownership boundary',async t=>{
 const files=await fixture(t),input=Buffer.from('temporary original'),result=await files.createTemporary('ai',{bytes:input,fileName:'temporary.txt'});
 assert.deepEqual((await files.bytes('ai',result.path)).bytes,input);await files.releaseTemporary('zyy',result.path);assert.deepEqual((await files.bytes('ai',result.path)).bytes,input);await files.releaseTemporary('ai',result.path);await assert.rejects(files.bytes('ai',result.path));
});
