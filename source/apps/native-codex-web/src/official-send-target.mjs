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
 for(const [before,after]of edits){if(source.split(before).length!==2)throw Error('Official web send contract changed: '+before.slice(0,70));source=source.replace(before,after);}return patchSendCompletionOwnership(patchSendTargetNavigation(source));
}

// Cv callbacks keep their identity while their React implementation changes.
// A committed request retains its original destination, but its late callbacks
// must not restore, clear, focus or update the next mounted composer.
export function patchSendCompletionOwnership(source){
 if(source.includes('const dshCompletionOrigin='))return source;
 const anchor='submitTarget:K}){let q=performance.timeOrigin+performance.now(),';
 const replacement='submitTarget:K}){const dshCompletionOrigin={threadId:c,clientThreadId:o,path:location.pathname};let dshAcceptedThread=null;const dshOwnsComposer=()=>{if(K.type!==`local`)return true;if(window.__DSH_NATIVE_SIDEBAR__?.isList)return false;const route=location.pathname.match(/^\\/local\\/([a-f0-9-]{36})$/i)?.[1]??null,actual=PC(e),ids=[dshCompletionOrigin.threadId,dshCompletionOrigin.clientThreadId,dshAcceptedThread].filter(Boolean);return route!=null?ids.includes(route)&&(actual==null||ids.includes(actual)):dshCompletionOrigin.threadId==null&&actual==null&&(dshCompletionOrigin.clientThreadId==null||(e.value.kind===`new`?e.value.browserTabMentionConversationId:e.value.clientThreadId)===dshCompletionOrigin.clientThreadId)&&location.pathname===dshCompletionOrigin.path;},dshOwnedCallback=fn=>typeof fn===`function`?(...args)=>dshOwnsComposer()?fn(...args):void 0:fn;i=dshOwnedCallback(i);v=dshOwnedCallback(v);f=dshOwnedCallback(f);m=dshOwnedCallback(m);M=dshOwnedCallback(M);j=dshOwnedCallback(j);B=dshOwnedCallback(B);_=dshOwnedCallback(_);n=dshOwnedCallback(n);let q=performance.timeOrigin+performance.now(),';
 if(source.split(anchor).length!==2)throw Error('Send completion ownership contract changed');
 source=source.replace(anchor,replacement);
 const accepted='let t=await Le(),n=t?.messageResult;';
 if(source.split(accepted).length!==2)throw Error('Send completion receipt contract changed');
 source=source.replace(accepted,'let t=await Le(),n=t?.messageResult;dshAcceptedThread=t?.threadId??null;');
 // Creating a Native thread includes presentation callbacks inside submit(),
 // before its receipt returns to gXr. Keep metadata registration unconditional,
 // but do not navigate or reset the composer after the user has left.
 const creation='syncChatGptProjectForLocalTask:O}){let k=';
 const creationGuard='syncChatGptProjectForLocalTask:O}){const dshSubmitOrigin={threadId:c?.type===`local`?c.localConversationId:null,clientThreadId:o,path:location.pathname};let dshSubmittedThread=null;const dshSubmitOwns=(accepted=null)=>{if(c?.type===`cloud`)return true;if(window.__DSH_NATIVE_SIDEBAR__?.isList)return false;const route=location.pathname.match(/^\\/local\\/([a-f0-9-]{36})$/i)?.[1]??null,ids=[dshSubmitOrigin.threadId,dshSubmitOrigin.clientThreadId,dshSubmittedThread,accepted].filter(Boolean);return route!=null?ids.includes(route):dshSubmitOrigin.threadId==null&&location.pathname===dshSubmitOrigin.path;},dshSubmitCallback=fn=>typeof fn===`function`?(...args)=>dshSubmitOwns()?fn(...args):void 0:fn;_=dshSubmitCallback(_);y=dshSubmitCallback(y);b=dshSubmitCallback(b);E=dshSubmitCallback(E);m=dshSubmitCallback(m);if(g){const original=g;g=(id,...args)=>dshSubmitOwns(id)?original(id,...args):void 0;}let k=';
 if(source.split(creation).length!==2)throw Error('Created thread presentation contract changed');
 source=source.replace(creation,creationGuard);
 const result='return m.messageResult?.status===`queued`?p&&y?.():_?.(),m';
 if(source.split(result).length!==2)throw Error('Submit presentation receipt contract changed');
 return source.replace(result,'dshSubmittedThread=m.threadId??null;return m.messageResult?.status===`queued`?p&&y?.():_?.(),m');
}

// The official MemoryRouter commits independently of the address-bar mirror.
// Reconcile only when the explicit navigation intent and mounted composer agree.
// A real mismatch preserves the draft and uses the renderer's visible error UI.
export function patchSendTargetNavigation(source){
 const before='if(route?route!==dshSendOrigin.threadId&&route!==dshSendOrigin.clientThreadId:dshSendOrigin.threadId!=null)throw Error(`会话正在切换，请返回原会话后发送`);';
 const after='const dshMatches=window.__DSH_NAVIGATION__?.confirmSendTarget?.(dshSendOrigin)??(route?route===dshSendOrigin.threadId||route===dshSendOrigin.clientThreadId:dshSendOrigin.threadId==null);if(!dshMatches){const error=Error(`会话正在切换，消息尚未发送，请稍后重试`);globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`blocked`,reason:`not_current`,threadId:dshSendOrigin.threadId});e.handleSubmitError?.(error);return;}dshSendOrigin.path=location.pathname;';
 if(source.includes(after))return source;if(source.split(before).length!==2)throw Error('Send navigation guard contract changed');return source.replace(before,after);
}
