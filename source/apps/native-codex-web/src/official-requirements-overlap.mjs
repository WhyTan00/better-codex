// Start the original critical read once the authenticated submission head is
// available, alongside queue policy / message preparation, not after them.
export function patchSubmissionRequirementsOverlap(source){
 const before='Object.defineProperty(dshPreparation.prepare,`dshWarmCodexHomeQuery`,{value:request=>dshWarmCodexHomeQuery(e,t,request)});return dshPreparation';
 const after='Object.defineProperty(dshPreparation.prepare,`dshWarmCodexHomeQuery`,{value:request=>dshWarmCodexHomeQuery(e,t,request)});Object.defineProperty(dshPreparation.prepare,`dshWarmSubmissionRequirements`,{value:request=>{const id=request?.conversationId,head=t.dshSubmissionHead?.(id),snapshot=head?.configReadSnapshot,conversation=t.getConversation?.(id);if(t.getHostId()!==`local`||t.disposed||!conversation||conversation.resumeState!==`resumed`||t.getStreamRole?.(id)?.role!==`owner`||request.editPosition!=null||[`queue`,`queue-only`].includes(request.queueModeOverride)||request.options?.executionHostId&&request.options.executionHostId!==`local`||!head?.loaded||head.threadId!==id||!head.isCurrent()||head.activeTurnId||head.activeFlags?.length||!snapshot?.isCurrent()||conversation.unconfirmedTurnSubmissions?.length||t.pendingThreadSettingsUpdates?.has(id)||t.getThreadWorkspaceState?.(id)?.pendingRevision!=null||typeof t.requestClient?.dshReadSubmissionRequirements!==`function`)return;const work=t.requestClient.dshReadSubmissionRequirements(id,{priority:`critical`,timeoutMs:Zx},!0);work.catch(()=>{});}});return dshPreparation';
 if(source.includes(after)){if(source.split(after).length!==2)throw Error('Duplicate requirements overlap');return source;}
 if(!source.includes(before)){
  const open='function IMs(e,t){return{',close='getQueueMode:async e=>(t.getConversation(e.conversationId),await sO(Bv.followUpQueueMode)===`queue`?`queue`:`send-now`)}}var LMs';
  const hook=after.slice(after.indexOf('Object.defineProperty(dshPreparation.prepare,`dshWarmSubmissionRequirements`'));
  if(source.includes(hook))return source;
  if(source.split(open).length!==2||source.split(close).length!==2)throw Error('Pinned requirements overlap contract changed');
  return source.replace(open,'function IMs(e,t){const dshPreparation={').replace(close,close.replace(')}}var LMs',')};'+hook+'}var LMs'));
 }
 if(source.split(before).length!==2)throw Error('Pinned requirements overlap contract changed');
 return source.replace(before,after);
}
