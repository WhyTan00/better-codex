// The pinned renderer keeps a full resume promise for history consumers. A
// submission only needs its completed Native/configuration phase. Do not turn a
// successful thread/read into ownership or skip the original Native resume.
export function patchSubmissionReadiness(source) {
 const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Pinned submission readiness contract changed');source=source.replace(from,to);};
 const start=source.indexOf('async function Rln('),end=source.indexOf('function zln(',start);
 if(start<0||end<=start)throw Error('Pinned resume implementation is missing');
 const original=source.slice(start,end);
 const slice=(from,to)=>{const a=original.indexOf(from),b=original.indexOf(to,a);if(a<0||b<=a||original.indexOf(from,a+1)!==-1)throw Error('Pinned resume phase contract changed');return original.slice(a,b);};
 const metadata=slice('let Me=Ee.cwd','let Re=O&&!G?.useCompactHistory');
 const environment=slice('let ze=e.getConversation(s),Be=',',He=yS(')+';';
 const fields=slice('t.sessionId=Ee.thread.sessionId','c||(t.previousTurnModel=null)}),')+'c||(t.previousTurnModel=null)';
 const historyFields='e.canonicalTurnHistory?AS(t,Ue,Ae,je,i.turnMergePolicy):kS(t,Ue,Ae,je,i.turnMergePolicy)';
 replace('async function Rln({manager:e,workspace:t,params:n,product:r,historyPolicy:i,isCurrentResumeAttempt:a,setHydrationCleanup:o})',
  'async function Rln({manager:e,workspace:t,params:n,product:r,historyPolicy:i,isCurrentResumeAttempt:a,setHydrationCleanup:o,onExecutionReady:dshPublishExecutionReady})');
 replace('let V=null,H=!1;try{let o=g==null?[]:CS(g)',
  'let V=null,H=!1,dshExecutionReady=!1,dshResumeResult=null,dshHistoryBaseline=new Map,dshProtectHistory=(current,incoming)=>{const before=dshHistoryBaseline.get(current.turnId),changed=new Map(current.items.filter(item=>before?.get(item.id)!==item).map(item=>[item.id,item]));return changed.size?{...incoming,items:incoming.items.map(item=>changed.get(item.id)??item)}:incoming};try{let o=g==null?[]:CS(g)');
 // Run exactly the renderer's existing metadata commit after Native acceptance
 // and mandatory goal/settings checks, before awaiting any history page. Remote
 // hosts retain their original ordering.
 replace('let Ae=!0,je;if(O){',
  'if(v===`local`){'+metadata+environment+'e.updateConversationState(s,t=>{'+fields+'});if(!a())return{status:`not-ready`,reason:`canceled`};dshResumeResult=Le;dshHistoryBaseline=new Map(CS(e.getConversation(s)).map(turn=>[turn.turnId,new Map(turn.items.map(item=>[item.id,item]))]));dshExecutionReady=!0;O&&e.releaseResumeNotificationBuffer(s);if(!a())return{status:`not-ready`,reason:`canceled`};dshPublishExecutionReady?.({status:`ready`})}let Ae=!0,je;if(O){');
 // The remaining continuation applies history only. An older resume response
 // must not overwrite a new turn's runtime status, model, effort or ownership.
 replace('Le=await le.getResult(Ee,Pe);if(!a())return{status:`not-ready`,reason:`canceled`};let Re=',
  'Le=dshResumeResult??await le.getResult(Ee,Pe);if(!a())return{status:`not-ready`,reason:`canceled`};let Re=');
 replace('Ue=Re.length>0?He:He.map(', 'Ue=Re.length>0||dshExecutionReady?He:He.map(');
 replace('o=yS(d==null?o:CS(d),l,{policy:i.turnMergePolicy,isResumeSnapshot:U})',
  'o=yS(d==null?o:CS(d),l,{policy:i.turnMergePolicy,isResumeSnapshot:U,preserveExistingTerminalState:dshExecutionReady,dshProtectHistory:dshExecutionReady?dshProtectHistory:void 0})');
 replace('He=yS(ze==null?o:CS(ze),Re,{policy:i.turnMergePolicy})',
  'He=yS(ze==null?o:CS(ze),Re,{policy:i.turnMergePolicy,preserveExistingTerminalState:dshExecutionReady,dshProtectHistory:dshExecutionReady?dshProtectHistory:void 0})');
 // Retain a live item's newer immutable object, without preventing unchanged
 // cached items in the very same turn from accepting the Native snapshot.
 replace('function U2t(e,t,{isResumeSnapshot:n=!1,preserveExistingTerminalState:r=!1,policy:i}){',
  'function U2t(e,t,{isResumeSnapshot:n=!1,preserveExistingTerminalState:r=!1,policy:i,dshProtectHistory}){if(dshProtectHistory)t=dshProtectHistory(e,t);');
 replace('e.acceptConversationHistory(s,{replacesExistingHistory:!0,truncatedBefore:!Ae,turns:h})',
  'e.acceptConversationHistory(s,{replacesExistingHistory:!dshExecutionReady,truncatedBefore:!Ae,turns:h})');
 replace(historyFields+','+fields+'}',historyFields+';if(!dshExecutionReady){'+fields+'}}');
 replace('if((G==null||e.getStreamRole(s)?.role!==`follower`)&&e.setConversationStreamRole(s,{role:`owner`}),!a())',
  'if(!dshExecutionReady&&(G==null||e.getStreamRole(s)?.role!==`follower`)&&e.setConversationStreamRole(s,{role:`owner`}),!a())');
 replace('}catch(t){if(!a()||(H&&e.getStreamRole(s)?.role===`owner`&&e.setConversationStreamRole(s,null),!a())',
  '}catch(t){if(!a()||(!dshExecutionReady&&H&&e.getStreamRole(s)?.role===`owner`&&e.setConversationStreamRole(s,null),!a())');
 replace('if(Iln(t)&&V?.thread.historyMode===`paginated`)try{await Mln(',
  'if(!dshExecutionReady&&Iln(t)&&V?.thread.historyMode===`paginated`)try{await Mln(');
 replace('||e.updateConversationState(s,e=>{e.resumeState===`resuming`&&(e.resumeState=`needs_resume`)}),t}}function zln(',
  '||!dshExecutionReady&&e.updateConversationState(s,e=>{e.resumeState===`resuming`&&(e.resumeState=`needs_resume`)}),t}}function zln(');
 // Both promises belong to one original attempt. Its failure before readiness
 // rejects both; a later history failure cannot retract Native readiness.
 replace('let i=this.inFlightConversationResumes.get(e.conversationId);if(i!=null)return i.promise;let a,o=',
  'let i=this.inFlightConversationResumes.get(e.conversationId);if(i!=null)return i.promise;let dshResolve,dshReject,dshReady=new Promise((resolve,reject)=>{dshResolve=resolve;dshReject=reject});dshReady.catch(()=>{});let a,o=');
 replace('params:e,product:n,historyPolicy:this.history,isCurrentResumeAttempt:',
  'params:e,product:n,historyPolicy:this.history,onExecutionReady:dshResolve,isCurrentResumeAttempt:');
 replace('c={promise:s,cancel:o};return this.inFlightConversationResumes.set(e.conversationId,c),s}',
  'c={promise:s,cancel:o,executionReady:dshReady};return s.then(dshResolve,dshReject),this.inFlightConversationResumes.set(e.conversationId,c),s}');
 // Only the submission's compatibility hook may choose the shorter promise.
 // Normal navigation and history callers still await resumeConversation.
 replace('let t=await Rb(e,r.getHostId()).resumeConversation({conversationId:a,model:null,serviceTier:o,reasoningEffort:null,workspaceRoots:p,useAppServerPermissionDefault:s,collaborationMode:m},{readResumeInputs:KO(e,r.getHostId())});',
  'let t=await(r.dshResumeForSubmission?((...args)=>r.dshResumeForSubmission(...args)):((...args)=>Rb(e,r.getHostId()).resumeConversation(...args)))({conversationId:a,model:null,serviceTier:o,reasoningEffort:null,workspaceRoots:p,useAppServerPermissionDefault:s,collaborationMode:m},{readResumeInputs:KO(e,r.getHostId())});');
 return patchPreparationMetadataRefresh(patchParallelResumePreparation(source));
}

// The renderer tool catalogue depends only on the settings already captured by
// Han.prepare. It does not depend on Nan's independent configuration or shell
// reads. Start it alongside those reads, but join at its original boundary so
// mandatory configuration failures retain precedence and no send skips tools.
export function patchParallelResumePreparation(source) {
 const start=source.indexOf('async function Nan('),end=source.indexOf('function Pan(',start);
 if(start<0||end<=start)throw Error('Pinned resume preparation implementation is missing');
 let prepare=source.slice(start,end);
 const replace=(from,to)=>{if(prepare.split(from).length!==2)throw Error('Pinned parallel resume preparation contract changed');prepare=prepare.replace(from,to);};
 replace('async function Nan(e,t){let{requestClient:n,logger:r}=t,',
  'async function Nan(e,t){const dshReadDynamicTools=t.readDynamicTools,dshDynamicTools=dshReadDynamicTools==null?null:Promise.resolve().then(()=>dshReadDynamicTools.call(t)).then(value=>({ok:!0,value}),error=>({ok:!1,error}));let{requestClient:n,logger:r}=t,');
 replace('t.readDynamicTools!=null){let n=await t.readDynamicTools();',
  'dshDynamicTools!=null){let dshToolsResult=await dshDynamicTools;if(!dshToolsResult.ok)throw dshToolsResult.error;let n=dshToolsResult.value;');
 return source.slice(0,start)+prepare+source.slice(end);
}

// Reconnect refresh must not cancel a metadata read already awaited by send.
// This is the same-host codex-home query only; roots and filesystem inspection
// keep their original invalidation and all execution checks remain mandatory.
export function patchPreparationMetadataRefresh(source) {
 const before='async function Uls(e,t){await Promise.all([e.query.invalidate(ED,{hostId:t},{exact:!0}),e.query.invalidate(jD,{hostId:t},{exact:!0})])}';
 const after='async function Uls(e,t){await Promise.all([e.query.invalidate(ED,{hostId:t},{exact:!0},{cancelRefetch:!1}),e.query.invalidate(jD,{hostId:t},{exact:!0})])}';
 if(source.split(before).length!==2)throw Error('Pinned metadata refresh cancellation contract changed');
 return source.replace(before,after);
}
