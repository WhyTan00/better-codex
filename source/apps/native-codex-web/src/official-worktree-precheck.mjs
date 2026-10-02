// Keep the pinned renderer's managed-worktree decision. Only immutable host
// metadata may survive a socket reconnect; filesystem inspection never does.
export const worktreeInitialAssetPrefix='/official-patched-v1024/assets/';
export function patchWorktreePrecheck(source){
 const patches=[
  ['async function vD(...e){let[t,n]=e,',
   'async function vD(...e){let[t,n]=e;if(t===`pick-files`&&globalThis.__DSH_PICK_FILES__){n?.signal?.throwIfAborted();const result=await globalThis.__DSH_PICK_FILES__(n?.params);return n?.select?n.select(result):result}let '],
  ['let i=await e.query.getOrFetch(ED,{hostId:r});Nv(n,i.codexHome,i.worktreesSegment)&&await e.query.getOrFetch(jD,{hostId:r}).catch(()=>void 0);let a=',
   'let i=await(globalThis.__DSH_READ_CODEX_HOME__?globalThis.__DSH_READ_CODEX_HOME__(r,()=>e.query.getOrFetch(ED,{hostId:r})):e.query.getOrFetch(ED,{hostId:r}));if(!Nv(n,i.codexHome,i.worktreesSegment))return Gls;await e.query.getOrFetch(jD,{hostId:r}).catch(()=>void 0);let a='],
  ['try{i=await Hls(e,{conversationId:t,cwd:n,hostId:r})}catch{throw Error(Yls)}switch(i.kind)',
   'try{i=await Hls(e,{conversationId:t,cwd:n,hostId:r})}catch(error){globalThis.__DSH_CLIENT_LOG__?.reportError(`execution_failed`,error,{threadId:t,stage:`failed`,reason:`preparation`});throw error}switch(i.kind)'],
 ];
 for(const [needle,replacement]of patches){if(source.split(needle).length!==2)throw Error('Pinned worktree precheck contract changed');source=source.replace(needle,replacement);}
 return source;
}
