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
 return patchParallelSubmissionReads(patchResumeMetadataLane(patchPreparationMetadataRefresh(patchParallelResumePreparation(source))));
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

export function patchResumeMetadataLane(source){
 const from='j=e.readThread(s,{includeTurns:!1,requestOptions:A}).catch(',to='j=(e.getHostId()===`local`&&e.dshReadResumeMetadata?e.dshReadResumeMetadata(s,A):e.readThread(s,{includeTurns:!1,requestOptions:A})).catch(';
 if(source.includes(to))return source;
 if(source.split(from).length!==2)throw Error('Pinned resume metadata read contract changed');
 return source.replace(from,to);
}

// These reads have no data dependency: retained roots, projectless membership
// and its two display path maps are joined before any workspace is created or
// permissions are computed. Keep fresh host reads; do not turn an old cache
// snapshot into execution settings. Proxy/config reads retain error precedence.
export function patchParallelSubmissionReads(source) {
 const replace=(before,after)=>{if(source.includes(after))return;if(source.split(before).length!==2)throw Error('Pinned parallel submission contract changed: '+before.slice(0,100));source=source.replace(before,after);};
 replace('let t=await this.loadConversationIds();if(t==null)return!1;this.conversationIds=e?t:new Set([...t,...this.conversationIds]);let[n,r]=await Promise.all([this.loadThreadPathHints(`thread-projectless-output-directories`),this.loadThreadPathHints(`thread-workspace-root-hints`)]);',
 'let[t,n,r]=await Promise.all([this.loadConversationIds(),this.loadThreadPathHints(`thread-projectless-output-directories`),this.loadThreadPathHints(`thread-workspace-root-hints`)]);if(t==null)return!1;this.conversationIds=e?t:new Set([...t,...this.conversationIds]);');
 replace('g=e.getThreadWorkspaceState(t),_=p?m??[d.cwd]:await Zsn(e,t),{applied:v,pendingRevision:y,workspace:b}=Vsn(',
 'g=e.getThreadWorkspaceState(t),{applied:v,pendingRevision:y,workspace:b}=Vsn(');
 replace('S=Wsn(v,h),C=o.canUseProjectlessWorkspace&&await Gsn({environmentCwd:f,hasPendingWorkspace:x!=null,state:g,isProjectlessConversation:()=>$sn(e,t),workspaceKind:a.workspaceKind})?await ecn(',
 'S=Wsn(v,h),[_,dshProjectless]=await Promise.all([p?m??[d.cwd]:Zsn(e,t),o.canUseProjectlessWorkspace?Gsn({environmentCwd:f,hasPendingWorkspace:x!=null,state:g,isProjectlessConversation:()=>$sn(e,t),workspaceKind:a.workspaceKind}):!1]),C=dshProjectless?await ecn(');
 replace('let l={},u=await n(),d;if(u!=null)',
 'const dshProxy=Promise.resolve().then(()=>n()).then(value=>({value}),error=>({error})),dshConfig=a==null?null:Promise.resolve().then(()=>a()).then(value=>({value}),error=>({error}));let l={},dshProxyResult=await dshProxy;if(`error`in dshProxyResult)throw dshProxyResult.error;let u=dshProxyResult.value,d;if(u!=null)');
 replace('if(a){let e=await a();if(e)for(let[t,n]of Object.entries(e))l[t]=n}',
 'if(dshConfig){let dshConfigResult=await dshConfig;if(`error`in dshConfigResult)throw dshConfigResult.error;let e=dshConfigResult.value;if(e)for(let[t,n]of Object.entries(e))l[t]=n}');
 return source;
}

// Once the request cwd and inherited settings have been resolved, personality,
// Fast requirements and codex-home filesystem preparation are independent.
// Start fresh reads together and join at the original checkpoints, preserving
// the existing error precedence, permission calculation and task Fast choice.
export function patchParallelTurnMetadata(source){
 const replace=(from,to)=>{if(source.includes(to))return;if(source.split(from).length!==2)throw Error('Pinned turn metadata contract changed');source=source.replace(from,to);};
 const personality='s.personality===void 0?E?.personality===void 0?L?.personality??await e.readDefaultPersonality(ae):E.personality:s.personality';
 const inherited=source.includes('jan(n.context?.dshInheritTaskModel?Ee:');
 const tier='await jan('+(inherited?'n.context?.dshInheritTaskModel?Ee:':'')+'s.serviceTier===void 0?Ee:s.serviceTier,e.logger,()=>e.sendRequest(`configRequirements/read`,void 0,{priority:`critical`,timeoutMs:Zx}))';
 replace('se=a.environments?.[0]?.environmentId,W=o.canMaterializeCodexHomeRoots',
 'se=a.environments?.[0]?.environmentId,dshTurnRead=fn=>Promise.resolve().then(fn).then(value=>({value}),error=>({error})),dshTurnValue=result=>{if(`error`in result)throw result.error;return result.value},dshPersonality=dshTurnRead(async()=>'+personality+'),dshTier=dshTurnRead(async()=>{let Ee=E?.serviceTier===void 0?L?.serviceTier===void 0?null:L.serviceTier:E.serviceTier;return '+tier+'}),W=o.canMaterializeCodexHomeRoots');
 replace('we='+personality,'we=dshTurnValue(await dshPersonality)');
 replace('De='+tier,'De=dshTurnValue(await dshTier)');
 return source;
}

// Extra codex-home roots are sandbox bookkeeping, not a turn-start directory
// dependency under full access. Preserve the roots and all restricted-sandbox
// preparation; avoid creating directories on the ordinary full-access send.
export function patchFullAccessTurnDirectories(source){
 const before='await Promise.all(ce.map(t=>e.ensureDirectory(t,se)));';
 const after='if(oe.type!==`dangerFullAccess`)await Promise.all(ce.map(t=>e.ensureDirectory(t,se)));';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Pinned turn directory contract changed');
 return source.replace(before,after);
}

// A configuration read made by this prepared start can also resolve its final
// personality default. The opaque, one-use context token is deliberately not
// a persistent cache, transferable DTO, or an execution/permission witness.
export function patchSameAttemptSubmissionConfig(source){
 const marker='const dshAttemptConfigs=new WeakMap();';
 const capture='D=u||d&&y,O=D?await KPi(n.requestClient,o,';
 const captured='D=u||d&&y,dshConfigHead=n.dshSubmissionHead?.(a),O=D?await KPi(n.requestClient,o,';
 const finish='return M.request.additionalContext=iK(a,v,M.request.additionalContext),';
 const finished='dshBindAttemptConfig(M.context,n,dshConfigHead,o,a,M.request.clientUserMessageId,O);'+finish;
 const read='L?.personality??await e.readDefaultPersonality(ae)';
 const reused='L?.personality??await dshAttemptDefaultPersonality(e,n.context,t,r,ae)';
 for(const value of ['async function KPi(e,t,n){let r={includeLayers:!1,cwd:t??null};','function Qjt(e){return e===`friendly`||e===`pragmatic`}','function Sv(e){return Qjt(e)?e:null}','return Sv(r?.personality)??Sv(r?.model_personality)??t.readExperimentPersonality().catch(()=>null)'])if(source.split(value).length!==2)throw Error('Pinned attempt configuration decoder contract changed');
 if(source.includes(marker)){
  if([captured,finished,reused].some(value=>source.split(value).length!==2))throw Error('Pinned attempt configuration patch is incomplete');
  return source;
 }
 for(const value of [capture,finish,read,'async function TMs('])if(source.split(value).length!==2)throw Error('Pinned attempt configuration contract changed');
 const helpers=`${marker}
function dshCanonicalAttemptCwd(value){return typeof value===\`string\`&&value.startsWith(\`/\`)&&!value.includes(\`//\`)&&!value.split(\`/\`).some(part=>part===\`.\`||part===\`..\`)&&(value===\`/\`||!value.endsWith(\`/\`))?value:null}
function dshBindAttemptConfig(context,manager,head,cwd,threadId,messageId,config){
 try{const path=dshCanonicalAttemptCwd(cwd);if(!context||!config||path==null||manager.getHostId()!==\`local\`||manager.disposed||manager.requestClient?.hostId!==\`local\`||typeof messageId!==\`string\`||!messageId||head?.threadId!==threadId||typeof head.isCurrent!==\`function\`||!head.isCurrent()||manager.dshSubmissionHead?.(threadId)!==head)return;
 const token=Object.freeze({});context.dshAttemptConfig=token;dshAttemptConfigs.set(token,{context,manager,requests:manager.requestClient,head,cwd:path,threadId,messageId,includeLayers:!1,config:Object.freeze({personality:config.personality,model_personality:config.model_personality})});}catch{}
}
async function dshAttemptDefaultPersonality(manager,context,threadId,messageId,cwd){
 const token=context?.dshAttemptConfig,saved=token&&dshAttemptConfigs.get(token);if(token)dshAttemptConfigs.delete(token);
 let valid=!1;try{valid=!!saved&&saved.context===context&&saved.manager===manager&&saved.requests===manager.requestClient&&saved.includeLayers===!1&&manager.getHostId()===\`local\`&&manager.requestClient?.hostId===\`local\`&&!manager.disposed&&saved.threadId===threadId&&saved.messageId===messageId&&saved.cwd===dshCanonicalAttemptCwd(cwd)&&manager.dshSubmissionHead?.(threadId)===saved.head&&saved.head.isCurrent()&&typeof manager.settings?.readExperimentPersonality===\`function\`;}catch{}
 if(!valid)return manager.readDefaultPersonality(cwd);
 return Sv(saved.config.personality)??Sv(saved.config.model_personality)??manager.settings.readExperimentPersonality().catch(()=>null);
}
`;
 return source.replace('async function TMs(',helpers+'async function TMs(').replace(capture,captured).replace(finish,finished).replace(read,reused);
}
