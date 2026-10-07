// A preview is one navigation layer over the still-mounted conversation.
// Official state owns ordinary files/images; HTML uses the browser renderer in
// the same preview layer, without entering the source-code editor.
(()=>{
 if(!window.__DSH_SCOPE__)return;
 const native=!!window.__DSH_ANDROID_HOST__||/\bDSHAndroid\//.test(navigator.userAgent||'');
 let active=null,closing=null,sequence=0;
 function chrome(){const kind=active?[...active.layers.keys()].at(-1):null;if(kind)document.documentElement.dataset.dshPreviewKind=kind;else delete document.documentElement.dataset.dshPreviewKind;}
 const route=()=>location.pathname+location.search;
 function close(){
  if(!active)return !!closing;
  const entry=active;active=null;chrome();
  for(const layer of [...entry.layers.values()].reverse())layer.close();
  if(!native&&history.state?.dshPreview===entry.id){closing=entry;history.back();}
  return true;
 }
 function open(layer){
  if(!/^\/local\/[0-9a-f-]{36}$/i.test(location.pathname)||window.__DSH_NATIVE_SIDEBAR__?.isList)return ()=>{};
  if(!active){
   const id='preview-'+(++sequence);active={id,path:route(),state:history.state,layers:new Map()};
   if(!native)(window.__DSH_NAVIGATION__?.pushPreview||history.pushState.bind(history))({...history.state,dshPreview:id},'',location.href);
  }
  const entry=active;entry.layers.set(layer.kind,layer);chrome();
  return ()=>{if(active===entry&&entry.layers.get(layer.kind)===layer)close();};
 }
 function sync(){if(active&&[...active.layers.values()].some(layer=>layer.isOpen?.()===false))close();}
 let htmlPreview=null;
 const htmlPath=value=>typeof value==='string'&&/\.html(?:[?#]|$)/i.test(value);
 function showHtml(title,resolve){
  if(!/^\/local\/[0-9a-f-]{36}$/i.test(location.pathname)||window.__DSH_NATIVE_SIDEBAR__?.isList)return false;
  htmlPreview?.dispose();
  const root=document.createElement('section'),status=document.createElement('div'),frame=document.createElement('iframe');
  root.className='dsh-html-preview';root.setAttribute('role','dialog');root.setAttribute('aria-label',title);
  status.className='dsh-html-preview-status';status.textContent='正在打开网页…';status.setAttribute('role','status');
  frame.title=title;frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';
  root.append(status);document.body.append(root);
  const entry={live:true,dispose(){this.live=false;root.remove();if(htmlPreview===this)htmlPreview=null;}};
  htmlPreview=entry;
  open({kind:'html',close:()=>entry.dispose(),isOpen:()=>entry.live});
  const load=()=>{if(!entry.live)return;status.hidden=false;status.textContent='正在打开网页…';
   Promise.resolve().then(resolve).then(url=>{
    if(!entry.live)return;
    const target=new URL(url,location.origin),scope=window.__DSH_SCOPE__.id;
    if(target.origin!==location.origin||!target.pathname.startsWith('/w/'+scope+'/api/')&&!target.pathname.startsWith('/__dsh_deliverables/'+scope+'/'))throw Error('文件不属于当前工作区');
    frame.onload=()=>{if(entry.live)status.hidden=true;};
    frame.onerror=()=>{if(entry.live)failure();};frame.src=target.href;if(!frame.isConnected)root.append(frame);
   }).catch(()=>{if(entry.live)failure();});
  };
  const failure=()=>{status.hidden=false;status.textContent='网页暂时未能打开。';const retry=document.createElement('button');retry.type='button';retry.textContent='重试';retry.addEventListener('click',load);status.append(retry);};
  load();return true;
 }
 function openHtml(path,options={}){
  if(!htmlPath(path)||!path.startsWith('/')||options.hostId&&options.hostId!=='local')return false;
  return showHtml(options.title||path.split('/').at(-1),async()=>{
   const local=await window.__DSH_LOCAL_DELIVERABLE__?.({path,hostId:options.hostId});
   if(local?.url)return local.url;
   const scope=window.__DSH_SCOPE__,url=new URL('/w/'+scope.id+'/api/app-fs/@fs/'+path.split('/').map(encodeURIComponent).join('/'),location.origin);
   url.searchParams.set('scopeToken',scope.token);return url.href;
  });
 }
 function openHtmlUrl(payload){
  if(!htmlPath(payload?.url))return false;
  return showHtml('网页预览',()=>payload.url);
 }

 const privateImage=value=>{try{const u=new URL(value,location.href),scope=window.__DSH_SCOPE__?.id;if(u.origin!==location.origin||u.username||u.password||!/\.(?:png|jpe?g|webp|gif|avif)(?:$)/i.test(u.pathname))return false;return u.pathname.startsWith('/w/'+scope+'/api/local-file/')||u.pathname.startsWith('/__dsh_deliverables/'+scope+'/')||scope==='ai'&&u.pathname.startsWith('/android/design-reviews/');}catch{return false;}};
 window.__DSH_PRIVATE_IMAGE__=privateImage;
 // Desktop's app://fs protocol is unavailable in the phone WebView. Reuse the
 // existing scoped file resolver and its versioned grant instead of moving
 // image bodies as base64 through the ordered command/replay lane.
 window.__DSH_LOCAL_IMAGE_URL__=(value,hostId='local')=>{
  const scope=window.__DSH_SCOPE__;
  if(hostId!=='local'||typeof value!=='string'||!scope?.token||!['ai','zyy'].includes(scope.id))return null;
  let target=value;
  try{
   if(target.startsWith('app://fs/@fs/'))target=decodeURIComponent(target.slice('app://fs/@fs'.length));
   else if(target.startsWith('/@fs/'))target=decodeURIComponent(target.slice('/@fs'.length));
   if(!target.startsWith('/')||target.startsWith('//')||target.includes('\0')||target.includes('\\')||!/\.(?:png|jpe?g|webp|gif|avif|svg)$/i.test(target))return null;
   const url=new URL('/w/'+scope.id+'/api/app-fs/@fs/'+target.split('/').map(encodeURIComponent).join('/'),location.origin);
   url.searchParams.set('scopeToken',scope.token);return url.href;
  }catch{return null;}
 };
 function showImage(value){
  if(!/^\/local\/[0-9a-f-]{36}$/i.test(location.pathname)||window.__DSH_NATIVE_SIDEBAR__?.isList)return false;
  const node=document.createElement('section');node.className='dsh-image-preview';node.setAttribute('role','dialog');node.setAttribute('aria-label','图片预览');
  const picture=document.createElement('img');picture.src=value;picture.alt='';const toolbar=document.createElement('div');toolbar.className='dsh-image-preview-toolbar';
  const closeButton=document.createElement('button');closeButton.textContent='关闭';closeButton.onclick=()=>close();const fit=document.createElement('button');fit.textContent='适合屏幕';const zoom=document.createElement('button');zoom.textContent='原始尺寸';
  const viewport=document.createElement('div');viewport.className='dsh-image-preview-viewport';viewport.append(picture);fit.onclick=()=>{node.dataset.zoom='fit';};zoom.onclick=()=>{node.dataset.zoom='original';};picture.ondblclick=()=>{node.dataset.zoom=node.dataset.zoom==='original'?'fit':'original';};
  node.dataset.zoom='fit';toolbar.append(closeButton,fit,zoom);node.append(toolbar,viewport);document.body.append(node);const release=open({kind:'image',node,isOpen:()=>node.isConnected,close:()=>node.remove()});if(!release){node.remove();return false;}return true;
 }
 document.addEventListener('click',event=>{const link=event.target.closest?.('a[href]');if(!link||event.defaultPrevented||event.button>0||event.metaKey||event.ctrlKey||event.shiftKey||event.altKey||link.hasAttribute('download')||!privateImage(link.href))return;if(showImage(link.href)){event.preventDefault();event.stopImmediatePropagation();}},true);
 window.__DSH_PREVIEW__={open,close,sync,openHtml,openHtmlUrl,isOpen:()=>!!active,onPopState(event){
  const entry=active||closing;if(!entry)return false;
  // iframe history may emit a pop without leaving the parent preview entry.
  // Keep ownership until the parent actually leaves that entry.
  if(!native&&history.state?.dshPreview===entry.id){event.stopImmediatePropagation?.();return true;}
  const wasActive=!!active;active=null;closing=null;chrome();
  if(wasActive)for(const layer of [...entry.layers.values()].reverse())layer.close();
  if(native||route()!==entry.path)history.replaceState({...entry.state,dshListPage:false,dshNativeList:false,dshThreadPage:true},'',entry.path);
  window.__DSH_NATIVE_SIDEBAR__?.openWorkbench?.();
  event.stopImmediatePropagation?.();return true;
 }};
 window.__DSH_USE_PREVIEW_LAYER__=(React,opened,onClose)=>{
  const ref=React.useRef({});ref.current.onClose=onClose;
  React.useEffect(()=>{if(!opened)return;const state=ref.current;state.live=true;const release=open({kind:'image',close:()=>state.onClose(false)});return()=>{state.live=false;queueMicrotask(()=>{if(!state.live)release();});};},[opened]);
 };
 // Closing the official file tab or panel is not a route change. Inspect the
 // captured official state after the action, without scanning the transcript.
 for(const type of ['click','keydown'])addEventListener(type,()=>requestAnimationFrame(sync));
 addEventListener('keydown',event=>{if(event.key==='Escape'&&close()){event.preventDefault();event.stopPropagation();}},true);
})();
