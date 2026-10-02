// Preserve the captured conversation across asynchronous official callbacks.
// The web bundle has no Android optimistic-paint phase, but its late-bound
// submit callback still needs the same conversation identity checks.
export const sendTargetAssetPrefix='/official-patched-v1026/assets/';
export function patchWebSendTarget(source){
 const edits=[
  ['s=Cv(async(a={})=>{','s=Cv(async(a={})=>{const dshSendOrigin={threadId:PC(r),clientThreadId:r.value.kind===`local`?r.value.clientThreadId:r.value.kind===`new`?r.value.browserTabMentionConversationId:null,path:location.pathname};if(n.type===`local`&&a.navigation!==`background`){const route=location.pathname.match(/^\\/local\\/([a-f0-9-]{36})$/i)?.[1]??null;if(route?route!==dshSendOrigin.threadId&&route!==dshSendOrigin.clientThreadId:dshSendOrigin.threadId!=null)throw Error(`会话正在切换，请返回原会话后发送`);}'],
  ['await(async()=>{let o=PC(r),','await(async()=>{let o=dshSendOrigin.threadId,'],
  ['De={...t,threadReferences:n,','De={...t,...K.type===`local`?{dshSendTarget:{threadId:c,clientThreadId:o}}:{},threadReferences:n,'],
  ['z=async(t,n,r,i,a,s,l,d)=>{let f=o==null?','z=async(t,n,r,i,a,s,l,d)=>{const dshTarget=t.dshSendTarget;if(dshTarget){const actual=c?.type===`local`?c.localConversationId:null;if(actual!==(dshTarget.threadId??null)||actual==null&&dshTarget.clientThreadId!=null&&dshTarget.clientThreadId!==o)throw Error(`发送目标会话已变化，消息未发送，请返回原会话`);const {dshSendTarget,...context}=t;t=context;}let f=o==null?']
 ];
 for(const [before,after]of edits){if(source.split(before).length!==2)throw Error('Official web send contract changed: '+before.slice(0,70));source=source.replace(before,after);}return patchSendTargetNavigation(source);
}

// The official MemoryRouter commits independently of the address-bar mirror.
// Reconcile only when the explicit navigation intent and mounted composer agree.
// A real mismatch preserves the draft and uses the renderer's visible error UI.
export function patchSendTargetNavigation(source){
 const before='if(route?route!==dshSendOrigin.threadId&&route!==dshSendOrigin.clientThreadId:dshSendOrigin.threadId!=null)throw Error(`会话正在切换，请返回原会话后发送`);';
 const after='const dshMatches=window.__DSH_NAVIGATION__?.confirmSendTarget?.(dshSendOrigin)??(route?route===dshSendOrigin.threadId||route===dshSendOrigin.clientThreadId:dshSendOrigin.threadId==null);if(!dshMatches){const error=Error(`会话正在切换，消息尚未发送，请稍后重试`);globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`blocked`,reason:`not_current`,threadId:dshSendOrigin.threadId});e.handleSubmitError?.(error);return;}dshSendOrigin.path=location.pathname;';
 if(source.includes(after))return source;if(source.split(before).length!==2)throw Error('Send navigation guard contract changed');return source.replace(before,after);
}
