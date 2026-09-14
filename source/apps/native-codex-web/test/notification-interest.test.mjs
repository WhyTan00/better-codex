import test from 'node:test';import assert from 'node:assert/strict';import {wantsNativeNotification as wants} from '../src/notification-interest.mjs';
test('large unrelated streams do not consume the current page connection; statuses and approvals survive',()=>{
 const c={presentedThreadId:'shown',ownedThreads:new Set(['owned']),readThreads:new Map([['read',Date.now()+1000],['expired',1]])},threads=new Map([['child',{parentThreadId:'shown'}]]),event=id=>({method:'item/agentMessage/delta',params:{threadId:id,delta:'large'}});
 for(const id of ['shown','owned','read','child'])assert(wants(c,event(id),threads));for(const id of ['other','expired'])assert(!wants(c,event(id),threads));
 assert(wants(c,{method:'thread/status/changed',params:{threadId:'other'}},threads));assert(wants(c,{id:3,method:'item/tool/requestUserInput',params:{threadId:'other'}},threads));assert(!wants({},event('other'),threads));
});
