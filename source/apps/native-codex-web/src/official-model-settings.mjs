// Read-only history is visible before the official execution resume completes.
// Its model label must not become a next-turn override captured before resume.
export const threadModelAssetPrefix='/official-patched-v1034/assets/';
// Older presentation preferences may omit a newly advertised Native effort.
// Keep the requested max option through the renderer's catalog filter; each
// model still supplies its own supported levels and Ultra keeps its gate.
export function patchNativeReasoningEfforts(source){
 const before='v$a=qy(Q,({get:e})=>new Set([...aO(e,Vv.enabledReasoningEfforts),`persistent`]))';
 const after='v$a=qy(Q,({get:e})=>new Set([...aO(e,Vv.enabledReasoningEfforts),`max`,`persistent`]))';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Pinned reasoning catalog preference contract changed');
 return source.replace(before,after);
}
// Explicit New Chat resets the restored draft's model preference. Text and
// other draft fields stay in the official draft store; later manual choices
// and existing conversations are not reset by mounting another consumer.
export function patchNewChatDraftModelReset(source){
 const marker='/*dshNewChatDraftModelReset*/';
 if(source.includes(marker))return source;
 const before='updateDraftSettings:u}=l$a(),d=s1a(r,l,o),';
 const after='updateDraftSettings:u}=l$a(),dshDraftModelReset=(0,u1a.useEffect)(()=>{'+marker+'if(r!=null||!l)return;const reset=()=>{const generation=globalThis.__DSH_NEW_CHAT_MODEL_RESET_GENERATION__??0;if(generation<1||generation<=(globalThis.__DSH_NEW_CHAT_MODEL_RESET_APPLIED__??0))return;u(l1a);globalThis.__DSH_NEW_CHAT_MODEL_RESET_APPLIED__=generation;};globalThis.addEventListener(`dsh:new-chat-model-reset`,reset);reset();return()=>globalThis.removeEventListener(`dsh:new-chat-model-reset`,reset);},[r,l,u]),d=s1a(r,l,o),';
 if(source.split(before).length!==2)throw Error('Pinned new-chat draft model contract changed');
 return source.replace(before,after);
}
export function patchThreadModelSettings(source){
 const patches=[
  ['I=Eb(jI,e),L=I?.settings.model??null,R;',
   'I=Eb(jI,e),dshReadModel=globalThis.__DSH_USE_READ_MODEL__?.(u1a,e),L=I?.settings.model?.trim()?I.settings.model:dshReadModel?.model??null,R;'],
  ['u.reasoningEffort:I?.settings.reasoning_effort??null,B;',
   'u.reasoningEffort:I?.settings.model?.trim()?I.settings.reasoning_effort??null:dshReadModel?.reasoningEffort??null,B;'],
  ['let _=i.collaborationMode??f,v=n.getConversation(a),y=DMs(v),',
   'let _=i.collaborationMode??f,v=n.getConversation(a),dshInheritTaskModel=r===`local`&&v!=null&&v.resumeState!==`resumed`,y=DMs(v),'],
  ['context:{localTurnMetadata:{fileAttachmentCount:E},commentAttachments:i.commentAttachments,useAppServerPermissionDefault:!D||void 0',
   'context:{dshInheritTaskModel,localTurnMetadata:{fileAttachmentCount:E},commentAttachments:i.commentAttachments,useAppServerPermissionDefault:!D||void 0'],
  ['resume:t=>e.resumeConversation(t),getActiveTurnId:',
   'resume:async t=>{if(e.getHostId()===`local`)await e.waitForPendingThreadSettingsUpdate(t.conversationId);return e.resumeConversation(t)},getActiveTurnId:'],
  ['O=s.collaborationMode??D,k=o.getRequestCollaborationMode(O),',
   'O=n.context?.dshInheritTaskModel?(()=>{if(!D?.settings?.model?.trim())throw Error(`任务模型设置尚未恢复，输入已保留`);return{...(s.collaborationMode??D),settings:{...(s.collaborationMode??D).settings,model:D.settings.model,reasoning_effort:D.settings.reasoning_effort}}})():s.collaborationMode??D,k=o.getRequestCollaborationMode(O),'],
 ];
 for(const [needle,replacement] of patches){if(source.split(needle).length!==2)throw Error('Pinned task model restoration contract changed');source=source.replace(needle,replacement);}
 return source;
}
