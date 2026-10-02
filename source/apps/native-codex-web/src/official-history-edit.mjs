export const historyEditAssetPrefix='/official-patched-v1027/assets/';

// Pinned renderer compatibility: this Native version removed thread/rollback.
// Historical storage format is a backend capability, not permission for the
// renderer to call a retired method. The backend keeps the edit scoped and can
// require a verified one-time migration before accepting a legacy thread.
export function patchHistoryEdit(source){
 const capability='d=c.historyMode===`paginated`&&Bg(e.requestClient.getAppServerVersion(),`threadRevert`);d||ccn(c.historyMode,`Editing messages`);';
 const mutation='if(d){let n=await e.sendRequest(`thread/revert`,{threadId:t,beforeTurnId:o.turnId});g=n.thread,e.applyRevertResponseToConversation({conversationId:t,response:n,revertedTurns:m})}else{let n=await e.sendRequest(`thread/rollback`,{threadId:t,numTurns:m.filter(({turnId:e})=>e!=null).length});g=n.thread,e.applyRollbackResponseToConversation({conversationId:t,conversationState:c,rollbackResponse:n})}';
 for(const needle of [capability,mutation])if(source.split(needle).length!==2)throw Error('Pinned native edit contract changed');
 return patchHistoryEditPresentation(source.replace(capability,'d=Bg(e.requestClient.getAppServerVersion(),`threadRevert`);if(!d)throw Error(`当前原生服务不支持编辑消息`);')
  .replace(mutation,'{let n=await e.sendRequest(`thread/revert`,{threadId:t,beforeTurnId:o.turnId});if(n.thread?.id!==t||n.thread.historyMode!==`paginated`)throw Error(`原生历史兼容升级尚未完成，编辑内容已保留`);g=n.thread,e.updateConversationState(t,e=>{e.historyMode=n.thread.historyMode}),e.applyRevertResponseToConversation({conversationId:t,response:n,revertedTurns:m})}'));
}

// Canonical pagination and the live turn overlay both feed wS(). Removing a
// reverted turn from the canonical islands alone lets the live overlay bring
// the old message back next to its replacement until the page reloads.
export function patchHistoryEditPresentation(source){
 const before='if(t==null)e.turns=e.turns.filter(({turnId:e})=>!c.has(e));else{t.generation+=1;';
 const after='e.turns=e.turns.filter(({turnId:e})=>!c.has(e));if(t!=null){t.generation+=1;';
 if(source.split(before).length!==2)throw Error('Pinned native revert presentation contract changed');
 return source.replace(before,after);
}
