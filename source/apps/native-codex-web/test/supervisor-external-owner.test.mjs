import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Hub} from '../src/hub.mjs';
import {WORKSPACES} from '../src/registry.mjs';

// Real read-only probe on 2026-09-08: a second App Server returned
// {status:{type:'notLoaded'}} for the actively running implementation CLI.
// Evidence: runtime/native-codex-web-20260908/supervisor-owner-probe.json.
// A thread's cwd proves workspace membership, not execution ownership/idleness.
test('an unowned notLoaded thread cannot be implicitly resumed or written', async () => {
  const id=randomUUID();
  const calls=[];
  class FakeNative extends EventEmitter {
    state='ready';
    async start(){ return this; }
    async close(){}
    async rpc(method){
      calls.push(method);
      if(method==='thread/read')return {thread:{id,cwd:WORKSPACES.ai.root,status:{type:'notLoaded'}}};
      if(method==='thread/resume')return {thread:{id,cwd:WORKSPACES.ai.root,status:{type:'idle'}}};
      if(method==='turn/start')return {turn:{id:randomUUID(),status:'inProgress'}};
      throw new Error(`Unexpected method ${method}`);
    }
  }
  const journal={
    async run(ws,requestId,payload,fn){return {requestId,state:'accepted',result:await fn()};},
    ownsThread(){return false;},
    getManagedThread(){return null;}
  };
  const hub=new Hub({journal,nativeFactory:()=>new FakeNative()});
  try {
    try { await hub.mutate(WORKSPACES.ai,{op:'send',threadId:id,requestId:randomUUID(),text:'test only'}, {resolve:async()=>[]}); }
    catch(error){ assert.ok([403,409,423].includes(error.code),`Unexpected ownership error: ${error.code}`); }
    assert.equal(calls.includes('thread/resume'),false,
      'notLoaded is NOT idle: require a durable gateway ownership record or a verified explicit takeover before thread/resume. Read supervisor-owner-probe.json.');
    assert.equal(calls.includes('turn/start'),false,
      'A second App Server must not start a turn in a potentially active external CLI/Desktop thread.');
  } finally {await hub.close();}
});
