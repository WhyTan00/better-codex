import {patchNativeLocalProfileGate,patchNativeLocalReadGate} from './android-local-profile-gate.mjs';
import {patchAndroidStartupDiagnostics} from './android-startup-diagnostics.mjs';
import {patchDraftReceipt} from '../source/apps/native-codex-web/src/official-draft-receipt.mjs';
import {patchRoutePresentation} from '../source/apps/native-codex-web/src/official-route-presentation.mjs';
import {patchSendTargetNavigation,patchSendCompletionOwnership,patchSendPreparationPaint,patchAcceptedCreationNavigation} from '../source/apps/native-codex-web/src/official-send-target.mjs';
// Android-only packaging transform: preserve React ownership and the official
// scroll container. Move its existing navigation element into topContent.
export function androidScrollableNavigation(source) {
 const navigation='(0,M4.jsx)(tTn,{showCustomizeSidebarAction:Pe,sidebarMode:ce,showSearchNavItem:!1})';
 const top='let qe=Fe?null:Be,Je;';
 if(source.split(navigation).length!==2||source.split(top).length!==2)throw Error('Official Android sidebar contract changed');
 const header='(0,Cxn.jsx)(`div`,{className:s,children:n})';
 if(source.split(header).length!==2)throw Error('Official Android header contract changed');
 source=source.replace(header,'(0,Cxn.jsx)(`div`,{className:s,"data-dsh-sidebar-header":"1",children:n})').replace(navigation,'null').replace(top,
  'let qe=Fe?null:(0,M4.jsxs)(M4.Fragment,{children:['+navigation+',Be]}),Je;');
 const chooser='let st=ot,ct;ct=E&&r!==`cloud`&&nt==null?';
 const writeMode='aVe(U,$b.followUpQueueMode,e.currentTarget.value)';
 if(source.split(chooser).length!==2||source.split(writeMode).length!==2)throw Error('Official Android follow-up settings contract changed');
 source=source.replace(chooser,'let st=ot,ct;const dshQueueSettings=zx(qv);ct=E&&r!==`cloud`&&nt==null?')
  .replace(writeMode,'aVe(dshQueueSettings,$b.followUpQueueMode,e.currentTarget.value)');
 return source;
}
// Bind every asynchronous submit to the composer that captured it. The official
// callback can outlive a route transition; reading PC(scope) after a paint or
// invoking a refreshed submit callback must never retarget the saved prompt.
export function androidSendTargetGuard(source) {
 const edits=[
  ['s=Cv(async(a={})=>{', 's=Cv(async(a={})=>{const dshSendOrigin={threadId:PC(r),clientThreadId:r.value.kind===`local`?r.value.clientThreadId:r.value.kind===`new`?r.value.browserTabMentionConversationId:null,path:location.pathname};if(n.type===`local`&&a.navigation!==`background`){const route=location.pathname.match(/^\\/local\\/([a-f0-9-]{36})$/i)?.[1]??null;if(route?route!==dshSendOrigin.threadId&&route!==dshSendOrigin.clientThreadId:dshSendOrigin.threadId!=null)throw Error(`会话正在切换，请返回原会话后发送`);}'],
  ['await dshInstant?.pending.presented();let o=PC(r),', 'await dshInstant?.pending.presented();if(n.type===`local`&&a.navigation!==`background`&&(location.pathname!==dshSendOrigin.path||PC(r)!==dshSendOrigin.threadId||dshInstant&&(dshInstant.finished||!dshInstant.pending.isCurrent()))){dshInstant?.cancel(`会话已切换，消息保留在原会话`);return;}let o=dshSendOrigin.threadId,'],
  ['De={...t,threadReferences:n,', 'De={...t,...K.type===`local`?{dshSendTarget:{threadId:c,clientThreadId:o}}:{},threadReferences:n,'],
  ['z=async(t,n,r,i,a,s,l,d)=>{let f=o==null?', 'z=async(t,n,r,i,a,s,l,d)=>{const dshTarget=t.dshSendTarget;if(dshTarget){const actual=c?.type===`local`?c.localConversationId:null;if(actual!==(dshTarget.threadId??null)||actual==null&&dshTarget.clientThreadId!=null&&dshTarget.clientThreadId!==o)throw Error(`发送目标会话已变化，消息未发送，请返回原会话`);const {dshSendTarget,...context}=t;t=context;}let f=o==null?'],
  ['dshEarly&&!(dshInstant?.edited??dshDraftEdited)&&!s.getText()&&s.setPromptText(de)', 'dshEarly&&(!dshPending||dshPending.isCurrent())&&!(dshInstant?.edited??dshDraftEdited)&&!s.getText()&&s.setPromptText(de)'],
  ['if(dshEarly){const nextDraft=', 'if(dshEarly&&(!dshPending||dshPending.isCurrent())){const nextDraft=']
 ];
 for(const [before,after] of edits){if(source.split(before).length!==2)throw Error('Official send target contract changed: '+before.slice(0,90));source=source.replace(before,after);}
 return patchAcceptedCreationNavigation(patchSendCompletionOwnership(patchSendTargetNavigation(source)));
}
export function androidOptimisticSend(source) {
 const edits=[
  ['let De;try{let[t,n]=await Promise.all([r(Se,', 'let De,dshPending,dshEarly=!1,dshRetain,dshDraftEdited=!1,dshEndDraft=()=>{},dshPlain=s.getPlainText?.()??le,dshMentions=ae==null&&ie==null?s.getComputerUseAppMentions():[];try{if(K.type===`local`&&re!==`background`&&window.__DSH_ANDROID_PENDING__){dshPending=window.__DSH_ANDROID_PENDING__.begin({id:Te,text:le,threadId:c,clientThreadId:o});dshRetain=y();s.setText(``);const dshEditor=s.view.dom,dshEvents=[`beforeinput`,`input`,`paste`,`drop`,`compositionstart`],dshEdited=event=>{if(event.isTrusted)dshDraftEdited=!0};for(const type of dshEvents)dshEditor.addEventListener(type,dshEdited,true);dshEndDraft=()=>{for(const type of dshEvents)dshEditor.removeEventListener(type,dshEdited,true)};dshEarly=!0;B(!0)}let[t,n]=await Promise.all([r(Se,'],
  ['i=ae==null&&ie==null?s.getComputerUseAppMentions():[];De=', 'i=dshMentions;De='],
  ['Te!=null&&Jf.fail(Te,`submit_preparation_failed`),xe(),we(),_(e),ne&&f();return', 'Te!=null&&Jf.fail(Te,`submit_preparation_failed`),xe(),we(),dshPending?.fail(!1),dshRetain?.(!1),dshEarly&&!dshDraftEdited&&!s.getText()&&s.setPromptText(de),dshEndDraft(),B(!1),_(e),ne&&f();return'],
  ['await n?.(),B(K.type', 'B(K.type'],
  ['let Oe=le===s.getText()?s.getPlainText?.()??le:le', 'let Oe=dshEarly?dshPlain:le===s.getText()?s.getPlainText?.()??le:le'],
  ['Ae=!1,je=!1,Me,Ne=()=>{Ae||je||', 'Ae=dshEarly,je=!1,Me=dshRetain,Ne=()=>{dshPending?.added();Ae||je||'],
  // A positive Native receipt settles the retained draft before presentation,
  // analytics or queue-refresh callbacks can fail. The retention handle itself
  // checks draft identity, so text typed during submission is preserved.
  ['try{let t=await Le(),n=t?.messageResult;', 'let dshBeforeAccepted=n;try{if(dshEarly){const nextDraft=dshDraftEdited?s.getPersistedText():null;i();if(nextDraft)s.setPromptText(nextDraft);B(!1)}await dshBeforeAccepted?.();let t=await Le(),n=t?.messageResult;if(K.type===`local`&&(n?.status===`sent`||n?.status===`queued`||t?.creation?.status===`created`&&t.creation.firstTurn?.status===`accepted`)){Me?.(!0);Me=void 0;n?.status===`queued`?dshPending?.queued(n):dshPending?.finish(t);}'],
  ['Me?.(!0),Me=void 0,i(),S&&!C&&n.messageId', 'dshPending?.queued(n),Me?.(!0),Me=void 0,(()=>{if(!dshEarly)i()})(),S&&!C&&n.messageId'],
  ['_(n),Pe();return', 'dshPending?.fail(t.creation.firstTurn?.status===`outcome-unknown`),_(n),Pe();return'],
  ['ye(),vXr(R,he,t),await m()', 'dshPending?.finish(t),ye(),vXr(R,he,t),await m()'],
  ['xe(),we(),Be(),yXr(R,he),Pe(),_(e)', 'globalThis.__DSH_CLIENT_LOG__?.reportError(`submit_failed`,e),xe(),we(),Be(),yXr(R,he),dshPending?.fail(e?.delivery?.stage===`outcome-unknown`),Pe(),_(e)'],
  ['finally{je=!0,Me?.(!1),B(!1),ne&&f()}', 'finally{dshEndDraft(),je=!0,Me?.(!1),B(!1),ne&&f()}']
 ];
 for(const [before,after] of edits){if(source.split(before).length!==2)throw Error('Official Android optimistic send contract changed');source=source.replace(before,after);}
 const instantEdits=[
  [
    "s=Cv(async(a={})=>{if(t.submitDisabled||r.get(Oh)||(o||t.submitBlockReason===`loading-local-config`)&&u({type:`composer`,options:a})||l(a,t.submitBlockReason===`file-uploads`||t.submitBlockReason===`image-uploads`))return;r.set(Oh,!0);let s=()=>void 0;await(async()=>{",
    "s=Cv(async(a={})=>{if(window.__DSH_ANDROID_UPLOAD__?.busy()){window.__DSH_ANDROID_UPLOAD__.showPending();return}let dshInstant=a.dshInstantSend;if(dshInstant&&(dshInstant.finished||!dshInstant.pending.isCurrent())){dshInstant.cancel();return}if(r.get(Oh)||t.submitDisabled&&!(dshInstant&&t.submitBlockReason===`empty-message`))return;const dshApi=window.__DSH_ANDROID_PENDING__;if(!dshInstant&&n.type===`local`&&a.navigation!==`background`&&a.promptRawOverride==null&&a.persistedPromptRawOverride==null&&dshApi?.capture){const text=i.getText();if(!text.trimStart().startsWith(`/`)&&(text.trim()||t.submitBlockReason!==`empty-message`)){dshInstant=dshApi.capture({id:Up(),text,persistedText:i.getPersistedText(),plainText:i.getPlainText?.()??text,apps:i.getMentionedComputerUseApps?.()??[],mentions:i.getComputerUseAppMentions(),browserFamilies:i.getMentionedBrowserFamilies(),threadReferences:Fqr(i),threadId:PC(r),clientThreadId:r.value.kind===`local`?r.value.clientThreadId:r.value.kind===`new`?r.value.browserTabMentionConversationId:null,controller:i,retain:()=>e.retainComposerPrompt()});if(dshInstant)a={...a,dshInstantSend:dshInstant,promptRawOverride:dshInstant.text,persistedPromptRawOverride:dshInstant.persistedText};}}try{if((o||t.submitBlockReason===`loading-local-config`)&&u({type:`composer`,options:a})){dshInstant?.pending.preparing(`准备连接，随后发送…`);return}if(l(a,t.submitBlockReason===`file-uploads`||t.submitBlockReason===`image-uploads`)){dshInstant?.pending.preparing(`附件准备中，随后发送…`);return}}catch(error){dshInstant?.cancel();throw error}r.set(Oh,!0);let s=()=>void 0;await(async()=>{await dshInstant?.pending.presented();"
  ],
  [
    "mentionedThreadReferences:Fqr(i),readThreadToolAvailable:",
    "mentionedThreadReferences:a.dshInstantSend?.threadReferences??Fqr(i),readThreadToolAvailable:"
  ],
  [
    "})().finally(()=>{r.set(Oh,!1),s()})}),{isComposerSubmitting:",
    "})().finally(()=>{r.set(Oh,!1);if(dshInstant&&!dshInstant.claimed)dshInstant.cancel();s()})}),{isComposerSubmitting:"
  ],
  [
    "h=e=>{let t=c.current;if(t!=null&&(c.current=null,f(!1),e))switch(t.submit.type)",
    "h=e=>{let t=c.current;if(t!=null&&!e)t.submit.options?.dshInstantSend?.cancel();if(t!=null&&(c.current=null,f(!1),e))switch(t.submit.type)"
  ],
  [
    "ue=ae==null&&ie==null?s.getMentionedComputerUseApps?.()??[]:[]",
    "ue=P.dshInstantSend?.apps??(ae==null&&ie==null?s.getMentionedComputerUseApps?.()??[]:[])"
  ],
  [
    "_e=ae==null&&ie==null?s.getMentionedBrowserFamilies():[]",
    "_e=P.dshInstantSend?.browserFamilies??(ae==null&&ie==null?s.getMentionedBrowserFamilies():[])"
  ],
  [
    "Te=K.type===`local`&&G===`submit`&&!w?Up():void 0;",
    "Te=P.dshInstantSend?.id??(K.type===`local`&&G===`submit`&&!w?Up():void 0);"
  ],
  [
    "let De,dshPending,dshEarly=!1,dshRetain,dshDraftEdited=!1,dshEndDraft=()=>{},dshPlain=s.getPlainText?.()??le,dshMentions=ae==null&&ie==null?s.getComputerUseAppMentions():[];try{if(K.type===`local`",
    "let De,dshInstant=P.dshInstantSend,dshPending=dshInstant?.pending,dshEarly=!!dshInstant,dshRetain=dshInstant?.release,dshDraftEdited=!1,dshEndDraft=dshInstant?()=>dshInstant.end():()=>{},dshPlain=dshInstant?.plainText??s.getPlainText?.()??le,dshMentions=dshInstant?.mentions??(ae==null&&ie==null?s.getComputerUseAppMentions():[]);try{if(dshInstant){dshInstant.claimed=!0;dshPending.sending()}else if(K.type===`local`"
  ],
  [
    "dshEarly=!0;B(!0)}let[t,n]=await Promise.all([r(Se,",
    "dshEarly=!0;B(!0)}await dshPending?.presented();let[t,n]=await Promise.all([r(Se,"
  ],
  [
    "dshEarly&&!dshDraftEdited&&!s.getText()",
    "dshEarly&&!(dshInstant?.edited??dshDraftEdited)&&!s.getText()"
  ],
  [
    "const nextDraft=dshDraftEdited?s.getPersistedText():null;",
    "const nextDraft=(dshInstant?.edited??dshDraftEdited)?s.getPersistedText():null;"
  ]
];
 for(const [before,after]of instantEdits){if(source.split(before).length!==2)throw Error('Official Android instant submit contract changed: '+before.slice(0,80));source=source.replace(before,after);}
 // Native items can use a server id plus the original client id. Expose both
 // in the existing renderer attribute at commit time; never match message text.
 const itemIds='function fTr(e){return e.flatMap(e=>pTr(e)??[])}';
 const aliasedIds='function fTr(e){return e.flatMap(e=>[...new Set([pTr(e),...([`userMessage`,`steeringUserMessage`].includes(e.type)?[e.clientId,e.clientUserMessageId]:[])].filter(e=>typeof e===`string`&&e.length>0))])}';
 if(source.split(itemIds).length!==2)throw Error('Official message identity contract changed');
 source=source.replace(itemIds,aliasedIds);
 const row='function sTr(e){return uTr(fTr(e.kind===`group`?e.items.map(({item:e})=>e):[e.item.item]))}';
 const finalRow='function sTr(e){const items=e.kind===`group`?e.items.map(({item:e})=>e):[e.item.item];return {...uTr(fTr(items)),"data-dsh-content-identities":items.map(item=>window.__DSH_CONTENT_IDENTITY__?.(item)).filter(Boolean).join(" ")||void 0,"data-dsh-final-answer-identities":items.map(item=>window.__DSH_FINAL_IDENTITY__?.(item)).filter(Boolean).join(" ")||void 0}}';
 if(source.split(row).length!==2)throw Error('Official final answer row contract changed');
 source=source.replace(row,finalRow);
 return patchSendPreparationPaint(androidSendTargetGuard(source));
}
export function androidFreshHistory(source) {
 source=patchDraftReceipt(patchRoutePresentation(source));
 const restoredInput='params:{threadId:e,input:l,toolOutput:';
 if(source.split(restoredInput).length!==2)throw Error('Official restored prompt identity contract changed');
 source=source.replace(restoredInput,'params:{threadId:e,input:l,clientUserMessageId:s?.openingUserMessageClientId??(c?.type===`userMessage`&&(s?.openingUserMessageId==null||s.openingUserMessageId===c.id)?c.clientId:void 0),toolOutput:');
 const finalPresentation='type:`assistant-message`,searchItemId:n.id,content:s,';
 if(source.split(finalPresentation).length!==2)throw Error('Official final answer presentation contract changed');
 source=source.replace(finalPresentation,'type:`assistant-message`,searchItemId:n.id,dshFinalIdentity:window.__DSH_FINAL_IDENTITY__?.(n),content:s,');
 // A retry is transient execution state. Completed/failed/interrupted history
 // can retain the item, but must never present it as a current reconnection.
 const retry='if(n.willRetry){let e=aQn(n.message);oQn(w,';
 if(source.split(retry).length!==2)throw Error('Official retry presentation contract changed');
 source=source.replace(retry,'if(n.willRetry){if(y.status!==`inProgress`)break;let e=aQn(n.message);oQn(w,');
 const promptAlias='searchItemId:n.id,steeringStatus:`accepted`';
 if(source.split(promptAlias).length!==3)throw Error('Native prompt presentation contract changed');
 source=source.replaceAll(promptAlias,'searchItemId:n.id,clientUserMessageId:n.clientId,steeringStatus:`accepted`');
 const edits=[
  ['searchItemId:n.serverUserMessageId??n.id,steeringStatus:n.status','searchItemId:n.serverUserMessageId??n.id,clientUserMessageId:n.clientUserMessageId,steeringStatus:n.status'],
  ['componentDidCatch(e,{componentStack:t}){let n=t??``,r=MBa(e)?e:Error(String(e));', 'componentDidCatch(e,{componentStack:t}){globalThis.__DSH_CLIENT_LOG__?.reportError(`render_error`,e);let n=t??``,r=MBa(e)?e:Error(String(e));'],
  ['if(o!=null&&(o.updatedAt>a.thread.updatedAt||','const firstLocal=rf===`dsh_local_cache`&&rc?.initialLocalPaint&&rg?.()&&(!this.conversations.has(e)||!wS(this.conversations.get(e),XS).some(turn=>turn.items?.length));if(!(firstLocal||rf===`dsh_local_cache`&&(rc?.verifiedNative||rc?.completesVisibleTurn)&&rg?.())&&o!=null&&(o.updatedAt>a.thread.updatedAt||'],
  ['if(this.upsertRecentConversationState(e,a.thread),!r||l)return','if(this.upsertRecentConversationState(e,firstLocal&&o!=null?o:a.thread),!r||l)return'],
  ['c!=null&&(t.turnsPagination=c)})},notifyAnyConversationCallbacks:', 'c!=null&&(t.turnsPagination=c)});if(rf===`dsh_local_cache`&&rc){rc.applied=!0;this.notifyConversationCallbacks(e,{includeAnyCallbacks:!1})}},notifyAnyConversationCallbacks:'],
  ['if(!r){t.queuedSubmit=void 0,e.set(w1,!1);return}','if(!r){t.queuedSubmit?.dshInstantSend?.cancel(`附件准备未完成，未发送`);t.queuedSubmit=void 0,e.set(w1,!1);return}'],
  ['async readHydrationThread(e,{includeTurns:t=!1,maxTurns:n,requestOptions:r}={}){', 'async readHydrationThread(e,{includeTurns:t=!1,maxTurns:n,requestOptions:r}={}){if(r?.source===`dsh_local_cache`){const cached=r.cachedSnapshot??await globalThis.__DSH_READ_COMMITTED_HISTORY__?.(e);if(!cached)throw Error(`Cached history unavailable`);if(globalThis.__DSH_ACCEPT_HISTORY_SNAPSHOT__?.(e,cached)===false)throw Error(`Cached snapshot predates completed reply`);const prior=this.getConversation(e),loaded=prior?wS(prior,XS):[],latest=loaded.filter(t=>t.turnId!=null).at(-1),snapshotIds=new Set(cached.page.data.map(t=>t.id));if(latest&&!snapshotIds.has(latest.turnId)&&(!latest.turnStartedAtMs||!cached.page.data.some(t=>Number(t.startedAt)*1000>latest.turnStartedAtMs))){globalThis.__DSH_CLIENT_LOG__?.event(`history_rejected`,{threadId:e,revision:cached.revision,reason:`newer_visible_turn`});throw Error(`Cached snapshot predates visible history`)}const itemsPaginationByTurnId=Object.fromEntries(cached.page.data.map(turn=>[turn.id,cached.itemsPaginationByTurnId?.[turn.id]??loaded.find(x=>x.turnId===turn.id)?.itemsPagination??{olderCursor:null,isLoadingOlder:!1,hasLoadedOldest:turn.itemsView===`full`,newestSnapshotItemId:turn.items?.at(-1)?.id}]));return {threadStatusAtReadStart:this.threadsById.get(e)?.status,response:{...cached.response,thread:{...cached.response.thread,turns:cached.page.data.slice().reverse()}},itemsPaginationByTurnId,turnsPagination:{olderCursor:cached.page.nextCursor,oldestLoadedTurnId:cached.page.data.at(-1)?.id??null,isLoadingOlder:!1,hasLoadedOldest:cached.page.nextCursor==null}}}'],
  ['function s_a(e,t,n,r,i=!0){','function s_a(e,t,n,r,i=!0){const dshBaseTheme=t,dshBaseVariant=n,dshVariant=globalThis.__DSH_THEME_COLOR__?.getVariant?.()??n;globalThis.__DSH_APPLY_RENDERER_THEME__=()=>s_a(e,dshBaseTheme,dshBaseVariant,r,i);if(dshVariant!==n){t={...mY(null,dshVariant,r),fonts:t.fonts};n=dshVariant;}'],
  ['f=d==null?[]:wS(d,XS);this.updateConversationState(e,t=>{let r=s.get(e)', 'f=d==null?[]:wS(d,XS);if(rf&&d?.turnsPagination&&!d.turnsPagination.isLoadingOlder&&a.thread.turns.length&&f.some(x=>x.turnId===a.thread.turns[0].id))c=d.turnsPagination;this.updateConversationState(e,t=>{let r=s.get(e)'],
  ['_=Math.min(o??5,5)*100','_=Math.min(o??5,20)*Math.min(t,100)'],
  ['async hydrateBackgroundThreads(e,{includeTurns:t=!1,maxTurns:n}={}){await this.hydrateThreads(e,{addToRecentConversations:!1,includeTurns:t,maxTurns:n,notifyAnyCallbacks:!1})}', 'async hydrateBackgroundThreads(e,{includeTurns:t=!1,maxTurns:n,refreshTurns:rf=!1,refreshGuard:rg,cachedSnapshot:rc}={}){await this.hydrateThreads(e,{addToRecentConversations:!1,includeTurns:t,maxTurns:n,refreshTurns:rf,refreshGuard:rg,cachedSnapshot:rc,notifyAnyCallbacks:!1})}'],
  ['async hydrateThreads(e,{addToRecentConversations:t,archivedPreview:n,includeTurns:r=!1,maxTurns:i,notifyAnyCallbacks:a})','async hydrateThreads(e,{addToRecentConversations:t,archivedPreview:n,includeTurns:r=!1,maxTurns:i,notifyAnyCallbacks:a,refreshTurns:rf=!1,refreshGuard:rg,cachedSnapshot:rc})'],
  // A scoped, committed DTO already contains the thread's cwd and history.
  // Adopting it must not wait on unrelated projectless-workspace IPC reads.
  ['let o=this.hydrationGeneration;await this.loadThreadHydrationState();let s=new Map', 'let o=this.hydrationGeneration;if(rf!==`dsh_local_cache`)await this.loadThreadHydrationState();if(rg&&!rg())return;let s=new Map'],
  ['shouldApplyHydratedThread:()=>o===this.hydrationGeneration&&(n?.isCurrent()??!0)', 'shouldApplyHydratedThread:()=>o===this.hydrationGeneration&&(n?.isCurrent()??!0)&&(!rg||rg())'],
  ['l=n==null&&i!=null&&(this.conversations.get(e)?.resumeState===`resumed`||a.thread.turns.length===0)','l=!rf&&n==null&&i!=null&&(this.conversations.get(e)?.resumeState===`resumed`||a.thread.turns.length===0)'],
  ['readThread:(e,t)=>n==null?this.readHydrationThreadMemoized', 'readThread:(e,t)=>rf?this.readHydrationThread(e,{includeTurns:!0,maxTurns:i,requestOptions:{priority:`interactive`,source:typeof rf===`string`?rf:`dsh_foreground`,cachedSnapshot:rc}}):n==null?this.readHydrationThreadMemoized'],
  ['let c=n==null?void 0:t.turnsPagination', 'let c=(rf||i!=null)?t.turnsPagination:n==null?void 0:t.turnsPagination'],
  ['let u=Y8t(a,{fallbackCwd:a.thread.cwd})','let u=Y8t(a,{fallbackCwd:a.thread.cwd,itemsPaginationByTurnId:t.itemsPaginationByTurnId})'],
  ['function Y8t(e,{workspaceRoots:t=[],fallbackCwd:n=null,model:r=``,reasoningEffort:i=null}={})','function Y8t(e,{workspaceRoots:t=[],fallbackCwd:n=null,model:r=``,reasoningEffort:i=null,itemsPaginationByTurnId:ip}={})'],
  ['return X8t({threadId:e.thread.id,turns:e.thread.turns,model:r,reasoningEffort:i,cwd:a,permissions:o})','return X8t({threadId:e.thread.id,turns:e.thread.turns,model:r,reasoningEffort:i,cwd:a,permissions:o,itemsPaginationByTurnId:ip})'],
  ['if(n!=null){let t=c?await n3t(', 'if(n!=null){const page=await Q4t({sendRequest:this.params.requestClient.sendRequest.bind(this.params.requestClient),getConversation:this.getConversation.bind(this)},globalThis.__DSH_HISTORY_POLICY__?.initialTurnItems??20,XS,e,null,null,n,r,`desc`);return{threadStatusAtReadStart:o,response:{...l,thread:{...l.thread,turns:page.response.data.slice().reverse()}},itemsPaginationByTurnId:page.itemsPaginationByTurnId,turnsPagination:{olderCursor:page.response.nextCursor,oldestLoadedTurnId:page.response.data.at(-1)?.id??null,isLoadingOlder:!1,hasLoadedOldest:page.response.nextCursor==null}}}if(n!=null){let t=c?await n3t(']
 ];
 for(const [before,after] of edits){if(source.split(before).length!==2)throw Error('Official Android history refresh contract changed');source=source.replace(before,after);}
 return source;
}
// Metadata-only hooks. Each upstream anchor must match exactly once.
export function androidDiagnostics(source,kind){
 const edits=kind==='primary'?[
 ['let ee=J,te=rw(!1,ee),ne;', 'globalThis.__DSH_CLIENT_LOG__?.control({threadId:J,disabled:!d||A||O,submitting:O,blockReason:P});let ee=J,te=rw(!1,ee),ne;'],
 ['dshInstant.cancel();return}if(r.get(Oh)', 'globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`cancelled`,reason:`not_current`,traceId:dshInstant.id,threadId:PC(r)});dshInstant.cancel();return}if(r.get(Oh)'],
 ['dshInstant?.pending.preparing(`准备连接，随后发送…`);return', 'globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`preparing`,reason:`loading_local_config`,traceId:dshInstant?.id,threadId:PC(r)});dshInstant?.pending.preparing(`准备连接，随后发送…`);return'],
 ['dshInstant?.pending.preparing(`附件准备中，随后发送…`);return', 'globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`preparing`,reason:`upload_busy`,traceId:dshInstant?.id,threadId:PC(r)});dshInstant?.pending.preparing(`附件准备中，随后发送…`);return'],
 ['if(window.__DSH_ANDROID_UPLOAD__?.busy())','globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`attempt`,threadId:PC(r)});if(window.__DSH_ANDROID_UPLOAD__?.busy())'],
 ['window.__DSH_ANDROID_UPLOAD__.showPending();return','globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`blocked`,reason:`upload_busy`,threadId:PC(r)});window.__DSH_ANDROID_UPLOAD__.showPending();return'],
 ['if(r.get(Oh)||t.submitDisabled&&!(dshInstant&&t.submitBlockReason===`empty-message`))return;','if(r.get(Oh)||t.submitDisabled&&!(dshInstant&&t.submitBlockReason===`empty-message`)){globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`blocked`,reason:r.get(Oh)?`submit_busy`:`submit_disabled`,blockReason:t.submitBlockReason,threadId:PC(r)});return;}'],
 ['if(dshInstant)a={...a,dshInstantSend:dshInstant','if(dshInstant)globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`captured`,traceId:dshInstant.id,threadId:PC(r)});if(dshInstant)a={...a,dshInstantSend:dshInstant'],
 ['dshInstant.claimed=!0;dshPending.sending()','dshInstant.claimed=!0;globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`preparing`,threadId:c,traceId:Te});dshPending.sending()'],
 ['let e=await K.submit(De,K.cwd,void 0','globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`dispatch`,threadId:c,traceId:Te});let e=await K.submit(De,K.cwd,void 0'],
 ['Me?.(!0);Me=void 0;n?.status===`queued`?','globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:n?.status===`queued`?`queued`:`accepted`,threadId:t?.threadId??c,turnId:t?.turnId,traceId:Te});Me?.(!0);Me=void 0;n?.status===`queued`?'],
 ['reportError(`submit_failed`,e),','reportError(`submit_failed`,e,{threadId:c,traceId:Te,stage:`failed`}),'],
 ['Te!=null&&Jf.fail(Te,`submit_preparation_failed`),','globalThis.__DSH_CLIENT_LOG__?.reportError(`submit_failed`,e,{threadId:c,traceId:Te,stage:`failed`,reason:`preparation`}),Te!=null&&Jf.fail(Te,`submit_preparation_failed`),'],
 ['finally{dshEndDraft(),je=!0','finally{globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`settled`,threadId:dshAcceptedThread??c,traceId:Te});dshEndDraft(),je=!0'],
 ['O=async()=>{let e=c.get(vy,s),t=c.get(oee,f);','O=async()=>{globalThis.__DSH_CLIENT_LOG__?.question(`attempt`,{threadId:r,questionId:s.itemId});let e=c.get(vy,s),t=c.get(oee,f);'],
 ['||(await xO(c,m.hostId).steerTurn(r,', '||(globalThis.__DSH_CLIENT_LOG__?.question(`dispatch`,{threadId:r,turnId:e.turnId,questionId:s.itemId,traceId:t.steer.clientUserMessageId}),await xO(c,m.hostId).steerTurn(r,'],
 ['$fe(c,m,h,!0),await Bt(','globalThis.__DSH_CLIENT_LOG__?.question(`submitting`,{threadId:r,turnId:e.turnId,questionId:s.itemId,questionCount:h.length,submitting:!0}),$fe(c,m,h,!0),await Bt('],
 ['t.steer.additionalContext,t.steer.toolOutput),tte(c,m,h))','t.steer.additionalContext,t.steer.toolOutput),globalThis.__DSH_CLIENT_LOG__?.question(`accepted`,{threadId:r,turnId:e.turnId,questionId:s.itemId,traceId:t.steer.clientUserMessageId}),tte(c,m,h),globalThis.__DSH_CLIENT_LOG__?.question(`reconciled`,{threadId:r,turnId:e.turnId,questionId:s.itemId,submitting:c.get(vy,s)?.isSubmitting===!0,selected:c.get(oee,f)?.selectedQuestionKey?.itemId===s.itemId}))'],
 ['for(let{questionItemId:e}of h)Zre(c,{...m,itemId:e})})},t[13]=n', 'for(let{questionItemId:e}of h)Zre(c,{...m,itemId:e});globalThis.__DSH_CLIENT_LOG__?.question(`settled`,{threadId:r,turnId:e.turnId,questionId:s.itemId,submitting:c.get(vy,s)?.isSubmitting===!0,selected:c.get(oee,f)?.selectedQuestionKey?.itemId===s.itemId})})},t[13]=n'],
 ['}).catch(t=>{lpe(t)||','}).catch(t=>{globalThis.__DSH_CLIENT_LOG__?.reportError(`submit_failed`,t,{threadId:r,turnId:e.turnId,questionIdHash:globalThis.__DSH_CLIENT_LOG__?.hashId(s.itemId),stage:`failed`});lpe(t)||']
 ]:[
 ['draft:s.draft===s.draftBaseline?l:s.draft})}})}function bor', 'draft:s.draft===s.draftBaseline?l:s.draft});globalThis.__DSH_CLIENT_LOG__?.question(`reconciled`,{threadId:t.threadId,turnId:r,questionId:o.id,answered:c!=null,submitting:e.get(hP,a)?.isSubmitting===!0,selected:e.get(gP,{hostId:t.hostId,threadId:t.threadId})?.selectedQuestionKey?.itemId===o.id})}})}function bor'],
 ['e.set(gP,c,{selectedQuestionKey:s,questionIds:n.map(e=>e.id),openedAutomatically:!0})','e.set(gP,c,{selectedQuestionKey:s,questionIds:n.map(e=>e.id),openedAutomatically:!0});globalThis.__DSH_CLIENT_LOG__?.question(`shown`,{threadId:t.threadId,turnId:r,questionId:s.itemId,questionCount:n.length,selected:!0})'],
 ['Tor(n,a);for(let e of i.questionIds)','Tor(n,a);globalThis.__DSH_CLIENT_LOG__?.question(`closed`,{threadId:r.threadId,turnId:r.turn.id,questionId:a.itemId,selected:!1});for(let e of i.questionIds)']
 ];
 for(const[a,b]of edits){if(source.split(a).length!==2)throw Error('Diagnostic upstream anchor changed: '+a.slice(0,100));source=source.replace(a,b);}return kind==='initial'?patchNativeLocalReadGate(patchNativeLocalProfileGate(patchAndroidStartupDiagnostics(source))):source;
}

// Older persisted catalog metadata can already be present in the official store.
export function androidSubagentSummary(source){
 const before='e.thread?.turns.at(-1)?.status';
 if(source.split(before).length!==2)throw Error('Official subagent summary contract changed');
 return source.replace(before,'e.thread?.turns?.at(-1)?.status');
}

// Prompt bubbles use the turn renderer, not the activity-item renderer's fTr.
export const androidPromptRendererAsset='local-conversation-turn-5379f3f29ba1.js';
export function androidPromptHandoff(source){
 const edits=[
  ['function _i(e){let t=(0,Vi.c)(207),','function _i(e){let t=(0,Vi.c)(210),'],
  ['Ma;t[173]!==xr||t[174]!==k?', 'Ma;t[173]!==xr||t[174]!==k||t[207]!==g||t[208]!==c||t[209]!==m?'],
  ['return r==null&&!i?n:(0,Q.jsx)(`div`,{className:i?', 'return r==null&&t.type!==`user-message`?n:(0,Q.jsx)(`div`,{className:i?'],
  ['"data-local-conversation-user-anchor":i?!0:void 0,children:n', '"data-local-conversation-user-anchor":i?!0:void 0,"data-local-conversation-item-target-ids":t.type===`user-message`?[t.searchItemId,t.bookmarkItemId,t.clientUserMessageId,i?g:null].filter(e=>typeof e===`string`&&e.length>0).map(encodeURIComponent).join(` `)||void 0:void 0,children:n'],
  ['t[173]=xr,t[174]=k,t[175]=Ma','t[173]=xr,t[174]=k,t[207]=g,t[208]=c,t[209]=m,t[175]=Ma']
 ];
 for(const [before,after] of edits){if(source.split(before).length!==2)throw Error('Official prompt render contract changed: '+before);source=source.replace(before,after);}
 const finalWrapper='return r==null&&t.type!==`user-message`?n:';
 if(source.split(finalWrapper).length!==2)throw Error('Official final wrapper contract changed');
 source=source.replace(finalWrapper,'return r==null&&t.type!==`user-message`&&!window.__DSH_CONTENT_IDENTITY__?.(t)&&!window.__DSH_FINAL_IDENTITY__?.(t)?n:');
 source=source.replace('"data-local-conversation-user-anchor":i?!0:void 0,','"data-dsh-content-identities":window.__DSH_CONTENT_IDENTITY__?.(t)||void 0,"data-dsh-final-answer-identities":window.__DSH_FINAL_IDENTITY__?.(t)||void 0,"data-dsh-final-thread-id":window.__DSH_FINAL_IDENTITY__?.(t)?c:void 0,"data-dsh-final-turn-id":window.__DSH_FINAL_IDENTITY__?.(t)?(m??k):void 0,"data-local-conversation-user-anchor":i?!0:void 0,');
 return source;
}
