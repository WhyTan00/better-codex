import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const dir=await mkdtemp(path.join(os.tmpdir(),'comfy-material-desk-'));
const items=path.join(dir,'runtime/material-desk/items'),feedback=path.join(dir,'material-desk/feedback');
await mkdir(items,{recursive:true});await mkdir(feedback,{recursive:true});
const proxy=path.join(dir,'clip.mp4');await writeFile(proxy,'fake-video');
await writeFile(path.join(items,'TAKE-001.json'),JSON.stringify({
 schema:'video-material-desk-item-v1',material_id:'TAKE-001',project_id:'comfyui-video',take_id:'TAKE-001',created_at:'2026-09-12T10:00:00Z',status:'MATERIAL_DESK_PUBLISHED',maturity:'TECH_QUALIFIED',lane:'REMOTION',
 story_context:{scene:'S01',beat:'hook',intention:'show hook',canonical_dialogue:null,intended_action:null},
 media:{review_proxy:proxy,native_audio:null,poster:null,contact_sheet:null},lineage:{},technical_qa:{status:'PASS',duration_seconds:1},review_state:{human_verdict:'UNREVIEWED'}
}));
process.env.COMFYUI_VIDEO_ROOT=dir;
process.env.COMFYUI_VIDEO_MATERIAL_ITEMS=items;
process.env.COMFYUI_VIDEO_MATERIAL_FEEDBACK=feedback;
const mod=await import(pathToFileURL('${BETTER_CODEX_WORKSPACE}/VideoWorkbench/adapters/workbench-material-desk.mjs').href+'?test='+Date.now());

test.after(()=>rm(dir,{recursive:true,force:true}));

test('material desk projects items and persists append-only human feedback',async()=>{
 const before=await mod.materialDeskSummary();
 assert.equal(before.counts.total,1);
 assert.equal(before.items[0].humanVerdict,'UNREVIEWED');
 assert.equal(before.items[0].reviewProxy,proxy);
 const result=await mod.submitMaterialFeedback({materialId:'TAKE-001',verdict:'REPAIR',note:'0.4s 后数字跳变',startSeconds:0.4,endSeconds:0.8});
 assert.equal(result.ok,true);
 const receipt=JSON.parse(await readFile(result.receipt.path,'utf8'));
 assert.equal(receipt.verdict,'REPAIR');
 assert.equal(receipt.material_id,'TAKE-001');
 const after=await mod.materialDeskSummary();
 assert.equal(after.counts.repair,1);
 assert.equal(after.items[0].humanVerdict,'REPAIR');
 assert.match(after.items[0].latestFeedback.note,/数字跳变/);
});

test('non-pass verdicts require concrete notes',async()=>{
 await assert.rejects(mod.submitMaterialFeedback({materialId:'TAKE-001',verdict:'FAIL',note:''}),error=>error.code===400);
});
