import test from 'node:test';
import assert from 'node:assert/strict';
import {ViewState} from '../public/state.mjs';

test('a new host generation resets the old sequence watermark before accepting events', () => {
  const state=new ViewState();
  state.switchWorkspace('ai');
  state.select({id:'thread-a',writable:true});
  state.generation='old-generation';state.seq=100;
  state.snapshot({thread:{id:'thread-a',writable:true},generation:'new-generation',seq:1,turns:[],approvals:[],hostState:'ready'});
  const accepted=state.event({workspace:'ai',generation:'new-generation',seq:2,method:'item/agentMessage/delta',params:{threadId:'thread-a',turnId:'turn-a',itemId:'message-a',delta:'after restart'}});
  assert.equal(accepted,true,'A restarted host must not wait to exceed the previous process sequence counter.');
  assert.equal(state.items.get('message-a')?.text,'after restart');
});

test('authoritative ready snapshot clears a previously interrupted host indicator', () => {
  const state=new ViewState();state.switchWorkspace('ai');state.select({id:'thread-a',writable:true,hostInterrupted:true});
  state.snapshot({thread:{id:'thread-a',writable:true},generation:'restarted',seq:0,turns:[],approvals:[],hostState:'ready'});
  assert.notEqual(state.thread.hostInterrupted,true,'Recovered ready host must not leave the composer permanently disabled.');
});

test('a completed native item cannot be overwritten by an older in-flight snapshot', () => {
  const state=new ViewState();state.switchWorkspace('ai');state.select({id:'thread-a',writable:true});state.generation='g';state.seq=1;
  state.event({workspace:'ai',generation:'g',seq:3,method:'turn/completed',params:{threadId:'thread-a',turn:{id:'turn-a',status:'completed',items:[{id:'message-a',type:'agentMessage',text:'complete answer'}]}}});
  state.snapshot({thread:{id:'thread-a'},generation:'g',seq:3,hostState:'ready',turns:[{id:'turn-a',status:'inProgress',items:[{id:'message-a',type:'agentMessage',text:'old partial'}]}],approvals:[]},{startedSeq:1});
  assert.equal(state.items.get('message-a').text,'complete answer','A snapshot initiated before turn completion must not replace the final item with an old partial value.');
});
