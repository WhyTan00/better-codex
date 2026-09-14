import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {SyncFeed} from '../src/sync-feed.mjs';
const id='00000000-0000-4000-8000-4ba7215b54d2';
function fixture(loaded){const native=new EventEmitter(),calls=[];native.rpc=async(method,params)=>{calls.push({method,params});return {};};const boundary={unmaterialized:new Set(),approvals:new Map(),observe(){},checked:async()=>({id,cwd:'${BETTER_CODEX_WORKSPACE}'}),loadedIds:async()=>new Set(loaded?[id]:[])};const feed=new SyncFeed({native,boundary});feed.scopes.set(id,'ai');feed.snapshot=async()=>({thread:{id},turns:[]});return {feed,calls};}
test('a Desktop turn is subscribed without requiring a browser to remain open',async()=>{const {feed,calls}=fixture(true);await feed.observe({method:'thread/status/changed',params:{threadId:id,status:{type:'active'}}});await feed.eventChain;await new Promise(r=>setImmediate(r));assert.equal(feed.interests.get(id),'ai');assert.deepEqual(calls,[{method:'thread/resume',params:{threadId:id,excludeTurns:true}}]);feed.close();});
test('reading an unloaded historical thread never acquires its writer',async()=>{const {feed,calls}=fixture(false);await feed.watch('ai',id);assert.equal(calls.length,0);feed.close();});

test('completion is published even after a thread leaves the browser interest set',async()=>{const {feed,calls}=fixture(false),events=[];feed.on('publish',e=>events.push(e));await feed.observe({method:'turn/completed',params:{threadId:id,turn:{id:'00000000-0000-4000-8000-f82fe242e2a8',status:'completed',items:[]}}});assert.equal(events.length,1);assert.equal(events[0].scope,'ai');assert.equal(events[0].event.type,'turn');assert.equal(events[0].event.turn.status,'completed');assert.equal(calls.length,0);feed.close();});
