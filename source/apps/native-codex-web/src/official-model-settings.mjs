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

// Existing tasks keep their own speed. A new-task choice also saves the
// official default so the next new task remembers it.
export function patchThreadServiceTier(source){
 const marker='/*dshThreadServiceTier*/';
 const oldMarked=marker+'i&&o.hostId!==`local`&&await b(t)',newMarked=marker+'i&&(e==null||o.hostId!==`local`)&&await b(t)';
 const saveBefore='let a=Pvr(n);Rb(r,e).sendRequest(`config/batchWrite`,',saveAfter='let a=Pvr(n);await Rb(r,e).sendRequest(`config/batchWrite`,';
 if(source.includes(marker)){
  if(source.split(oldMarked).length===2)source=source.replace(oldMarked,newMarked);
  if(source.split(newMarked).length!==2)throw Error('Pinned service-tier picker contract changed');
  if(source.split(saveBefore).length===2)source=source.replace(saveBefore,saveAfter);
  if(source.split(saveAfter).length!==2)throw Error('Pinned service-tier save contract changed');
  return source;
 }
 const before='s&&await Rb(a,o.hostId).updateThreadSettingsForNextTurn(e,{serviceTier:t}),i&&await b(t)';
 const after='s&&await Rb(a,o.hostId).updateThreadSettingsForNextTurn(e,{serviceTier:t}),'+marker+'i&&(e==null||o.hostId!==`local`)&&await b(t)';
 if(source.split(before).length!==2)throw Error('Pinned service-tier picker contract changed');
 source=source.replace(before,after);
 const draftBefore='l=n==null&&a&&c.hasManagedNewThreadSettings,u;';
 const draftAfter='l=n==null&&a&&(c.hostId===`local`||c.hasManagedNewThreadSettings),u;';
 if(source.split(draftBefore).length!==2)throw Error('Pinned service-tier draft contract changed');
 source=source.replace(draftBefore,draftAfter);
 if(source.split(saveBefore).length!==2)throw Error('Pinned service-tier save contract changed');
 return source.replace(saveBefore,saveAfter);
}

// Opening an existing local thread is not a speed-change intent. Native's
// resume response contains the effective tier; Thread DTO/history pages do not.
export function patchThreadServiceTierRestore(source){
 const marker='/*dshThreadServiceTierRestore*/';
 const legacy='dshReadTier=globalThis.__DSH_USE_READ_MODEL__?.(sro,e)';
 const restored='dshReadTier=globalThis.__DSH_USE_READ_MODEL__?.(u1a,e)';
 // sro is the compiler memo-cache runtime. The read-model hook needs React.
 if(source.includes(marker)){
  if(!source.includes(legacy))return source;
  if(source.split(legacy).length!==2||!source.includes('u1a=n(c(),1)'))throw Error('Pinned service-tier React binding changed');
  return source.replace(legacy,restored);
 }
 if(!source.includes('u1a=n(c(),1)'))throw Error('Pinned service-tier React binding is missing');
 const patches=[
  ['...ce===void 0?{}:{serviceTier:ue.serviceTier}',
   '...v===`local`||ce===void 0?{}:{serviceTier:ue.serviceTier}'+marker],
  ['let Ee=E?.serviceTier===void 0?L?.serviceTier===void 0?null:L.serviceTier:E.serviceTier,De=await jan(s.serviceTier===void 0?Ee:s.serviceTier,',
   'let Ee=E?.serviceTier===void 0?L?.serviceTier===void 0?null:L.serviceTier:E.serviceTier,De=await jan(n.context?.dshInheritTaskModel?Ee:s.serviceTier===void 0?Ee:s.serviceTier,'],
  ['p=Eb(MI,e),m=Eb(cro,e),',
   'p=Eb(MI,e),dshReadTier=globalThis.__DSH_USE_READ_MODEL__?.(u1a,e),dshTierProjection=o.hostId===`local`&&e!=null&&p?.serviceTier===void 0&&dshReadTier&&Object.hasOwn(dshReadTier,`serviceTier`),dshTierSettings=dshTierProjection?{...p,serviceTier:dshReadTier.serviceTier}:p,m=Eb(cro,e),'],
 ];
 for(const [before,after] of patches){if(source.split(before).length!==2)throw Error('Pinned service-tier restoration contract changed');source=source.replace(before,after);}
 // Use the projection only for the picker. It is never a submission setting.
 const start=source.indexOf('function aro('),end=source.indexOf('function oro(',start);
 if(start<0||end<=start)throw Error('Pinned service-tier picker is missing');
 let picker=source.slice(start,end);
 picker=picker.replace('let s=Y$a(d?.models,t.model),','p=dshTierSettings;let s=Y$a(d?.models,t.model),');
 // React compiler dependency tracking must include the restored projection.
 picker=picker.replace('i[18]!==p||','i[18]!==dshTierSettings||');
 source=source.slice(0,start)+picker+source.slice(end);
 // A failed requirements lookup must not silently convert Fast to Standard.
 const before='return t.warning(`Failed to load config requirements for service tier`,{safe:{},sensitive:{error:e}}),null';
 const after='t.warning(`Failed to load config requirements for service tier`,{safe:{},sensitive:{error:e}});throw e';
 if(source.split(before).length!==2)throw Error('Pinned service-tier requirements contract changed');
 return source.replace(before,after);
}
