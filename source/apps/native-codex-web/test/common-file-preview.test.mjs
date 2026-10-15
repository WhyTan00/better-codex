import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile,mkdtemp,rm}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';
import {OfficialFiles,fileMime,fileContentKind}from'../src/official-files.mjs';
import {pdfOptions}from'../vendor/pdfjs-5.4.296/support.js';
import{patchPdfPreview,pdfSupportAsset}from'../src/official-pdf-preview.mjs';
test('uploaded common formats preserve binary bytes and provide preview metadata without crossing workspace',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'dsh-preview-'));t.after(()=>rm(root,{recursive:true,force:true}));const files=new OfficialFiles({stateDir:root,boundary:{serial:(_key,fn)=>fn()}});
 for(const [name,kind]of [['a.PDF','pdf'],['a.PNG','image'],['a.avif','image'],['a.MP4','video'],['a.webm','video'],['a.mov','video'],['a.MP3','audio'],['a.m4a','audio'],['a.ogg','audio'],['a.wav','audio'],['a.md','text'],['a.csv','text'],['a.tsv','text'],['a.yaml','text'],['a.json','text'],['a.xml','text'],['a.tsx','text'],['a.docx','binary']]){
 const bytes=Buffer.from([0,255,1,2]),result=await files.uploadBytes('ai',[{name,size:bytes.length}],bytes),p=result.files[0].path;
 assert.equal((await files.metadata('ai',{path:p})).contentKind,kind,name);assert.deepEqual((await files.bytes('ai',p)).bytes,bytes);await assert.rejects(files.metadata('zyy',{path:p}),e=>e.code===403);
 }
});
test('PDF map and font factories supply the pinned reader contract and reject unknown resources',async()=>{
 const o=pdfOptions(),maps=new o.CMapReaderFactory(),fonts=new o.StandardFontDataFactory();const m=await maps.fetch({name:'UniGB-UCS2-H'});
 assert.equal(o.useWorkerFetch,false);assert.equal(m.isCompressed,true);assert(m.cMapData instanceof Uint8Array);assert(m.cMapData.length>100);assert((await fonts.fetch({filename:'FoxitSerif.pfb'})).length>100);
 await assert.rejects(maps.fetch({name:'../../private'}));await assert.rejects(fonts.fetch({filename:'__proto__'}));
});
test('actual pinned PDF getDocument call uses support on demand, parser remains official',async()=>{
 const {name}=await pdfSupportAsset(),source='async function open(r,a){return r.getDocument({data:a})}',patched=patchPdfPreview(source,name);assert(patched.includes('await import("./'+name+'")'));assert.throws(()=>patchPdfPreview('getDocument({url:a})',name));assert.throws(()=>patchPdfPreview(source,'../../escape.js'));
});
const initial=process.env.DSH_PREVIEW_INITIAL;
if(initial)test('official renderer accepts real metadata for common image/audio/video/PDF/text formats',async()=>{
 const source=await readFile(initial,'utf8');const extract=name=>{const start=source.indexOf('function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('}',start)+1);};
 const ctx={f2n:new Set(["aac","flac","m4a","mp3","mp4a","oga","ogg","opus","wav"])};vm.createContext(ctx);vm.runInContext(['a2n','l2n','u2n','mM','U0n'].map(extract).join('\n')+';G0n=new Set(["md","mdx"]);',ctx);
 for(const [file,expected]of [['a.pdf','pdf'],['a.png','image'],['a.mp4','video'],['a.mp3','audio'],['a.md','markdown']])assert.equal(ctx.a2n(file,fileContentKind(fileMime(file))),expected,file);
});
