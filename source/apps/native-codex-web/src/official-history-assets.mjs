// Only the official client's initial history budget changes. All native UI,
// item types and older-page cursors remain intact.
export const historyAssetPrefix='/official-patched-v1013/assets/';
export const gestureHistoryAssetPrefix='/official-patched-v1012/assets/';
export const filePreviewClientAsset='review-file-source-item-78465d2172ff.js';
export const menuHistoryAssetPrefix='/official-patched-v1011/assets/';
export const composerHistoryAssetPrefix='/official-patched-v1009/assets/';
export const lastHistoryAssetPrefix='/official-patched-v1007/assets/';
export const previousHistoryAssetPrefix='/official-patched-v1004/assets/';
export const followUpAssetPrefix='/official-patched-v1014/assets/';
export const retainedFollowUpAssetPrefix='/official-patched-v1010/assets/';
export const draftFollowUpAssetPrefix='/official-patched-v1008/assets/';
export const lastFollowUpAssetPrefix='/official-patched-v1006/assets/';
export const previousFollowUpAssetPrefix='/official-patched-v1005/assets/';
export const upstreamAssetPrefix='/official-patched-v8/assets/';
export const historyClientAsset='app-initial-cadb12d4a15e.js';
export const followUpClientAsset='app-primary-6cd7b8b3f5e3.js';
export function patchFollowUpControls(source,{legacy=false,previous=false,cacheDrafts=true,retainedDrafts=true,modeSwitch=true}={}){
 const needle='let st=ot,ct;t[101]!==nt||t[102]!==w?(ct=null,t[101]=nt,t[102]=w,t[103]=ct):ct=t[103];let lt=ct';
 if(source.split(needle).length!==2)throw Error('Pinned native follow-up control contract changed');
 // Retain old immutable versions below. The current version uses the official
 // footer's existing follow-up slot, so permissions, model and queue share a row.
 let replacement='let st=ot,ct;ct=E&&r!==`cloud`&&nt==null?(0,D7.jsxs)(`label`,{className:`dsh-follow-up-choice`,children:[(0,D7.jsx)(`span`,{children:`发送方式`}),(0,D7.jsxs)(`select`,{"aria-label":`运行中消息的发送方式`,value:D?`queue`:`steer`,disabled:!d||O||j,onChange:e=>{aVe(U,$b.followUpQueueMode,e.currentTarget.value)},children:[(0,D7.jsx)(`option`,{value:`steer`,children:`引导当前任务`}),(0,D7.jsx)(`option`,{value:`queue`,children:`排队下一轮`})]})]}):null;let lt=null';
 if(modeSwitch&&!legacy&&!previous&&cacheDrafts&&retainedDrafts)replacement=replacement.replace('disabled:!d||O||j','disabled:!d').replace('aVe(U,$b.followUpQueueMode,e.currentTarget.value)','aVe(U,$b.followUpQueueMode,e.currentTarget.value).catch(e=>window.dispatchEvent(new CustomEvent(`dsh:queue-error`,{detail:{message:e?.message||`发送方式未保存，请恢复连接后重试`}})))');
 if(legacy)return source.replaceAll('import.meta.url',`new URL('${upstreamAssetPrefix}${followUpClientAsset}',location.origin).href`).replace(needle,replacement.replace('let lt=null','rt=ct?(0,D7.jsxs)(D7.Fragment,{children:[ct,rt]}):rt;let lt=null'));
 if(!previous){let value=source.replaceAll('import.meta.url',`new URL('${upstreamAssetPrefix}${followUpClientAsset}',location.origin).href`).replace(needle,replacement.replace('let lt=null','let lt=ct'));if(cacheDrafts){const draft='initialDocument:It,onDocumentDispose:Lt,children:';if(value.split(draft).length!==2)throw Error('Native rich draft contract changed');value=value.replace(draft,retainedDrafts?'initialDocument:It,onDocumentChange:(e,t)=>{zfe(_e,e,t);sle(_e,_e.get(xS).length>0?{document:e,plainTextMode:t}:undefined)},onDocumentDispose:Lt,children:':'initialDocument:It,onDocumentChange:(e,t)=>zfe(_e,e,t),onDocumentDispose:Lt,children:');}return value;}
 const footer='let Ut;return t[219]!==Ht||t[220]!==Mt?(Ut=(0,D7.jsxs)(`div`,{className:`contents`,children:[Ht,Mt]}),t[219]=Ht,t[220]=Mt,t[221]=Ut):Ut=t[221],Ut';
 if(source.split(footer).length!==2)throw Error('Pinned native composer footer contract changed');
 const row='return (0,D7.jsxs)(`div`,{className:`contents`,children:[Ht,Mt,ct?(0,D7.jsx)(`div`,{className:`dsh-follow-up-row`,children:ct}):null]})';
 return source.replaceAll('import.meta.url',`new URL('${upstreamAssetPrefix}${followUpClientAsset}',location.origin).href`).replace(needle,replacement).replace(footer,row);
}
export function patchInitialHistoryBudget(source,{legacy=false,cacheView=true,menuLifecycle=true,scrollableMenus=true,compactFilePreview=false}={}){
 const needle='getConversationTurnItemLimit(e){return this.getConversation(e),1/0}';
 if(source.split(needle).length!==2)throw Error('Pinned official history contract changed');
 const hook='getHostId(){return this.hostId}canUsePermissionSelection';if(source.includes(hook)){if(source.split(hook).length!==2)throw Error('Native client registration contract changed');source=source.replace(hook,'getHostId(){globalThis.__DSH_REGISTER_NATIVE_CLIENT__?.(this);return this.hostId}canUsePermissionSelection');}
 const appHost='async function fCa(){pCa=uCa(cCa),CX=await pCa.services';
 if(source.includes(appHost)){if(source.split(appHost).length!==2)throw Error('Native AppHost recovery contract changed');source=source.replace(appHost,'globalThis.__DSH_RECREATE_APP_HOST__=async()=>{await fCa();};'+appHost);}
 if(!legacy){const bootstrap='CX=await pCa.services';if(source.split(bootstrap).length!==2)throw Error('Native local AppHost contract changed');source=source.replace(bootstrap,'CX=globalThis.__DSH_LOCAL_APP_HOST__?await globalThis.__DSH_LOCAL_APP_HOST__(pCa.services):await pCa.services');}
 if(!legacy&&cacheView){const view='r.imageAttachments!==n.imageAttachments&&e.set(Mto,r.imageAttachments),e.set(Nto,r))';if(source.split(view).length!==2)throw Error('Native composer view contract changed');source=source.replace(view,'r.imageAttachments!==n.imageAttachments&&e.set(Mto,r.imageAttachments),e.set(Nto,r),globalThis.__DSH_CACHE_COMPOSER_VIEW__?.(mK(e.value),r,restore=>E0(e,state=>Object.assign(state,restore))))');}
 if(!legacy&&cacheView&&menuLifecycle){
  const patches=[
   ['awaitBeforeOpen:m,onBeforeOpen:h}=e,g=a===void 0?`contextmenu`:a','awaitBeforeOpen:m,onBeforeOpen:h}=e,dshMenu=globalThis.__DSH_USE_NATIVE_MENU__?.(vq,l),g=a===void 0?`contextmenu`:a'],
   ['(0,yq.jsx)(lq,{open:u,onCloseAutoFocus:V,triggerButton:ne,align:s,contentWidth:c??`menu`,onOpenChange:r,children:','(0,yq.jsx)(lq,{key:dshMenu?.key,open:u,onCloseAutoFocus:V,triggerButton:ne,align:s,contentWidth:c??`menu`,onOpenChange:dshMenu?dshMenu.change(r):r,children:'],
   [':be=t[83],be}function t8i',':be=t[83],dshMenu?vq.cloneElement(be,{key:dshMenu.key,onOpenChange:dshMenu.change(de)}):be}function t8i']
  ];
  for(const [from,to]of patches){if(source.split(from).length!==2)throw Error('Pinned native menu lifecycle contract changed');source=source.replace(from,scrollableMenus?to.replace('key:dshMenu?.key,open:u','key:dshMenu?.key,modal:dshMenu?.modal,open:u').replace('key:dshMenu.key,onOpenChange','key:dshMenu.key,modal:dshMenu.modal,onOpenChange'):to);}
 }
 if(compactFilePreview){
  const patches=[
   ['function m0n(){return PT(b0n,void 0)!==void 0}', 'function m0n(){return!0}'],
   ['function g0n(){return PT(b0n,!1)}', 'function g0n(){return!1}'],
   ['t!=null&&gBi(e,{cwd:T,hostId:b,path:t});', 't!=null&&r&&p0n(e,!1,{animate:!1,persist:!1}),t!=null&&gBi(e,{cwd:T,hostId:b,path:t});']
  ];
  for(const [from,to]of patches){if(source.split(from).length!==2)throw Error('Pinned file preview default contract changed');source=source.replace(from,to);}
 }
 return source.replaceAll('import.meta.url',`new URL('${upstreamAssetPrefix}${historyClientAsset}',location.origin).href`).replace(needle,'getConversationTurnItemLimit(e){return this.getConversation(e),globalThis.__DSH_HISTORY_POLICY__?.initialTurnItems??48}');
}

// Preload URLs are fetched directly, before module import-map resolution.
// Point them at the executed modules and remove identical preload hints.
export function patchNativeModulePreloads(html){
 const seen=new Set(),urls=new Map([[upstreamAssetPrefix+historyClientAsset,historyAssetPrefix+historyClientAsset],[upstreamAssetPrefix+followUpClientAsset,followUpAssetPrefix+followUpClientAsset]]);
 return html.replace(/<link\b[^>]*>/gi,tag=>{if(!/\brel\s*=\s*(['"])modulepreload\1/i.test(tag))return tag;const match=tag.match(/\bhref\s*=\s*(['"])([^'"]+)\1/i);if(!match)return tag;const href=urls.get(match[2])||match[2];if(seen.has(href))return '';seen.add(href);return tag.replace(match[0],'href='+match[1]+href+match[1]);});
}

// Keep the official file renderer and manual folder toggle; hide path chrome
// together with the directory pane until that toggle is explicitly opened.
export function patchFilePreviewChrome(source){
 const patches=[
  ['T=q(K),E=c==null?null:', 'T=q(K),E=c==null||!T?null:'],
  ['children:(0,$.jsx)(Zn,{cwd:C,hostId:o,onSelectFile:s,path:c,pathActions:E,trailingContent:F,workspaceRoot:I})', 'children:T||c==null?(0,$.jsx)(Zn,{cwd:C,hostId:o,onSelectFile:s,path:c,pathActions:E,trailingContent:F,workspaceRoot:I}):(0,$.jsxs)(`div`,{className:`flex min-w-0 items-center gap-2 px-3 py-2`,children:[(0,$.jsx)(`span`,{className:`min-w-0 flex-1 truncate text-sm`,children:c.split(/[\\/]/).pop()}),...F]})']
 ];
 for(const [from,to]of patches){if(source.split(from).length!==2)throw Error('Pinned file preview chrome contract changed');source=source.replace(from,to);}
 return source.replaceAll('import.meta.url',`new URL('${upstreamAssetPrefix}${filePreviewClientAsset}',location.origin).href`);
}
