import test from 'node:test';import assert from 'node:assert/strict';
import {displayDetailPage,displayItem,displayTurn,applyDisplayEvent,mergeFetchedSnapshot,publicSnapshot} from '../src/sync-projection.mjs';
test('cloud projection excludes raw tool payloads, credentials and hidden reasoning',()=>{
 const tool=displayItem({id:'tool',type:'commandExecution',status:'completed',command:'PRIVATE_CREDENTIAL',aggregatedOutput:'PRIVATE_OUTPUT'},'turn');assert.equal(tool.detailAvailable,true);assert(!JSON.stringify(tool).includes('PRIVATE_'));
 assert.equal(displayItem({id:'reasoning',type:'reasoning',text:'PRIVATE_REASONING'},'turn'),null);
 assert.equal(displayItem({id:'system',type:'systemMessage',text:'PRIVATE_SYSTEM'},'turn'),null);
 const user=displayItem({id:'user',type:'userMessage',content:[{type:'text',text:'Visible'},{type:'image',url:'PRIVATE_IMAGE_BYTES'}]},'turn');assert.equal(user.text,'Visible');assert(!JSON.stringify(user).includes('PRIVATE_IMAGE'));
});
test('a fetched snapshot cannot overwrite an item updated while its read was in flight',()=>{
 const fetched={thread:{id:'thread'},turns:[{id:'turn',status:'inProgress',items:[{id:'message',type:'agentMessage',text:'old'}]}]};let live=structuredClone(fetched);
 live=applyDisplayEvent(live,{type:'delta',threadId:'thread',turnId:'turn',itemId:'message',delta:' new'},11);
 const merged=mergeFetchedSnapshot(fetched,live,10);assert.equal(merged.turns[0].items[0].text,'old new');assert(!JSON.stringify(publicSnapshot(merged)).includes('_revision'));
});
test('turn start preserves user input and completed item replaces provisional text',()=>{
 let s=applyDisplayEvent(null,{type:'turn',threadId:'thread',turn:displayTurn({id:'turn',status:'inProgress',items:[{id:'user',type:'userMessage',content:[{type:'text',text:'hello'}]}]})},1);
 assert.equal(s.turns[0].items[0].text,'hello');s=applyDisplayEvent(s,{type:'delta',turnId:'turn',itemId:'reply',delta:'partial'},2);s=applyDisplayEvent(s,{type:'item',turnId:'turn',item:{id:'reply',type:'agentMessage',text:'final'}},3);assert.equal(s.turns[0].items[1].text,'final');
});

test('explicit tool detail response filters private reasoning before cloud transport',()=>{const r=displayDetailPage({data:[{id:'private',type:'reasoning',text:'PRIVATE_REASONING'},{id:'tool',type:'commandExecution',command:'safe detail'}],nextCursor:'next'});assert.equal(r.data.length,1);assert.equal(r.data[0].command,'safe detail');assert(!JSON.stringify(r).includes('PRIVATE_REASONING'));assert.equal(r.nextCursor,'next');});
