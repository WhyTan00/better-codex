// Keep the official workspace calculation. Supply only the same thread's
// host-issued inputs; the host checks them again with the actual write.
export function patchSubmissionWorkspaceContext(source){
 source=patchPreparedPermissionHostPath(patchPreparedHostPaths(source));
 const marker='function dshPreparedWorkspace(manager,id){';
 if(source.includes(marker))return source;
 const roots='async function Zsn(e,t){try{return await e.getThreadWritableRoots(t)}';
 const membership='async function $sn(e,t){try{return await e.isProjectlessConversation(t)}';
 if(source.split(roots).length!==2||source.split(membership).length!==2)throw Error('Pinned submission workspace contract changed');
 const helper=marker+'const head=manager.dshSubmissionHead?.(id),value=head?.submissionContext;return head?.threadId===id&&head.isCurrent()&&value?.token&&value.workspace?.isProjectless===!1&&Array.isArray(value.workspace.roots)?value.workspace:null;}';
 return source.replace(roots,helper+'async function Zsn(e,t){const prepared=dshPreparedWorkspace(e,t);if(prepared)return [...prepared.roots];try{return await e.getThreadWritableRoots(t)}')
  .replace(membership,'async function $sn(e,t){const prepared=dshPreparedWorkspace(e,t);if(prepared)return prepared.isProjectless;try{return await e.isProjectlessConversation(t)}');
}

// The foreground receipt already contains this immutable host descriptor.
// Reuse it for the original worktree decision; never cache filesystem state.
export function patchPreparedHostPaths(source){
 const edits=[
  ['function dshWarmCodexHomeQuery(scope,manager,request){','function dshWarmCodexHomeQuery(scope,manager,request,submissionContext){'],
  ['entry.work=Promise.resolve().then(()=>globalThis.__DSH_READ_CODEX_HOME__?',
   'const preparedPaths=submissionContext?.token&&typeof submissionContext.hostPaths?.codexHome===`string`&&submissionContext.hostPaths.codexHome.startsWith(`/`)?structuredClone(submissionContext.hostPaths):null;entry.work=Promise.resolve().then(()=>preparedPaths??(globalThis.__DSH_READ_CODEX_HOME__?'],
  ['scope.query.getOrFetch(ED,{hostId:`local`})).then(value=>({value}),error=>({error}));',
   'scope.query.getOrFetch(ED,{hostId:`local`}))).then(value=>({value}),error=>({error}));'],
  ['value:request=>dshWarmCodexHomeQuery(e,t,request)',
   'value:(request,submissionContext)=>dshWarmCodexHomeQuery(e,t,request,submissionContext)']
 ];
 if(source.includes(edits[0][1])){if(edits.some(([,after])=>source.split(after).length!==2))throw Error('Partial prepared host paths patch');return source;}
 for(const [before,after]of edits){if(source.split(before).length!==2)throw Error('Pinned prepared host paths contract changed');source=source.replace(before,after);}
 return source;
}

// Jsn has a separate home lookup for permission-root materialization. It must
// consume the same current receipt as the earlier worktree preparation does.
export function patchPreparedPermissionHostPath(source){
 const before='?await e.getCodexHome():null,ce=W==null?[]:o.getAdditionalWritableRoots(W)';
 const after='?(await(async()=>{const head=e.dshSubmissionHead?.(t),home=head?.submissionContext?.hostPaths?.codexHome;return head?.threadId===t&&head.isCurrent()&&head.submissionContext?.token&&typeof home===`string`&&home.startsWith(`/`)?home:e.getCodexHome()})()):null,ce=W==null?[]:o.getAdditionalWritableRoots(W)';
 if(source.split(after).length===2)return source;
 if(source.split(before).length!==2)throw Error('Pinned permission host descriptor contract changed');
 return source.replace(before,after);
}
