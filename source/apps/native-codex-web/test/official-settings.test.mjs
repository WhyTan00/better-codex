import test from 'node:test';import assert from 'node:assert/strict';
import {createOfficialSettings} from '../src/official-settings.mjs';
test('native follow-up mode persists, notifies its scope and rejects runtime policy changes',async()=>{
 const states={ai:{settings:{}},secondary:{settings:{}}},saved=[];
 const settings=createOfficialSettings({RpcTarget:class{},state:async s=>states[s],persist:async s=>saved.push(s)}),ai=settings.forScope('ai'),secondary=settings.forScope('secondary'),a=[],z=[];
 const subscription=await ai.subscribe('followUpQueueMode',v=>a.push(v.effective));await secondary.subscribe('followUpQueueMode',v=>z.push(v.effective));
 assert.equal((await ai.read('followUpQueueMode')).effective,'steer');
 await ai.write('followUpQueueMode','queue');await Promise.resolve();assert.equal(states.ai.settings.followUpQueueMode,'queue');assert.deepEqual(saved,['ai']);assert.deepEqual(a,['steer','queue']);assert.deepEqual(z,['steer']);
 await assert.rejects(ai.write('followUpQueueMode','interrupt'),e=>e.code===400);await assert.rejects(ai.write('model','different'),e=>e.code===403);
 subscription.dispose();await ai.write('followUpQueueMode','steer');await Promise.resolve();assert.deepEqual(a,['steer','queue']);ai.close();secondary.close();
});
test('failed persistence restores previous preference and does not broadcast success',async()=>{
 const state={settings:{followUpQueueMode:'queue'}};const settings=createOfficialSettings({RpcTarget:class{},state:async()=>state,persist:async()=>{throw Error('disk unavailable');}}),client=settings.forScope('ai'),seen=[];
 await client.subscribe('followUpQueueMode',v=>seen.push(v.effective));await assert.rejects(client.write('followUpQueueMode','steer'),/disk unavailable/);assert.equal(state.settings.followUpQueueMode,'queue');assert.deepEqual(seen,['queue']);client.close();
});
