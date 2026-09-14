// Keep the existing SecondaryProject bookshelf inside the native plugin panel. The
// original encrypted site's renderer runs in a scoped frame, never a new tab.
(()=>{
 'use strict';
 const decode=value=>Uint8Array.from(atob(value),v=>v.charCodeAt(0));
 const prelude=String.raw`
 (()=>{
  'use strict';
  const transport=window.__BETTER_CODEX_FICTION_CONTEXT__;
  if(!transport)throw Error('书架连接尚未就绪');
  delete window.__BETTER_CODEX_FICTION_CONTEXT__;
  window.fetch=async(input,options={})=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href);
   if(url.origin!==location.origin)throw Error('书架只使用当前工作台连接');
   if(url.pathname==='/__auth/unlock'&&url.searchParams.get('app')==='secondary-library'&&(!options.method||options.method==='GET'))return new Response(JSON.stringify(await transport.unlock()),{headers:{'content-type':'application/json'}});
   if(url.pathname!=='/__secondary/state')throw Error('书架接口未开放');
   const method=(options.method||'GET').toUpperCase();if(!['GET','POST'].includes(method))throw Error('书架操作未开放');
   try{const value=await transport.state(method,options.body);return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json'}});}
   catch(error){return new Response(JSON.stringify({error:error.message||'书架连接暂不可用'}),{status:error.code>=400&&error.code<=599?error.code:503,headers:{'content-type':'application/json'}});}
  };
  const storage=window.localStorage,prefix='betterCodex:secondary:embedded-secondary:';
  Object.defineProperty(window,'localStorage',{value:{getItem:key=>storage.getItem(prefix+key),setItem:(key,value)=>storage.setItem(prefix+key,String(value)),removeItem:key=>storage.removeItem(prefix+key)}});
  addEventListener('error',()=>transport.message('书架加载异常，请点击刷新重试',true));
  addEventListener('unhandledrejection',()=>transport.message('书架连接暂不可用，修改仍留在当前页面',true));
  document.addEventListener('focusin',()=>transport.inputChanged?.(),true);
  document.addEventListener('focusout',()=>transport.inputChanged?.(),true);
  document.addEventListener('input',event=>{if(event.target.closest('#editor-screen'))transport.dirty(true);},true);
  document.addEventListener('click',event=>{if(event.target.closest('#edit-cancel,#edit-cancel-top'))transport.dirty(false);},true);
  window.__BETTER_CODEX_FICTION_TRANSPORT__=transport;
 })();`;
 const afterlude=String.raw`
 (()=>{
  const transport=window.__BETTER_CODEX_FICTION_TRANSPORT__;delete window.__BETTER_CODEX_FICTION_TRANSPORT__;
  window.__BETTER_CODEX_FICTION_FRAME__={
   refresh(){if(!document.querySelector('#editor-screen')?.hidden){transport.message('正在编辑，刷新不会替换未保存的稿件');return;}return loadState();},
   get editing(){return !document.querySelector('#editor-screen')?.hidden;}
  };
  const exportButton=document.querySelector('#export-word');
  if(exportButton)exportButton.onclick=async()=>{
   try{const book=effectiveBook(currentBookId);if(!book)return;const blob=makeDocx(book),name=safeFile(book.title)+'_平台上传稿.docx';
    if(await transport.exportDocument(blob,name))return;
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
   }catch{transport.message('Word 导出失败，请重试',true);}
  };
  transport.ready();
 })();`;

 // Only ciphertext survives page reload; decrypted renderer and keys stay in RAM.
 const cipherCacheName='betterCodex:secondary:secondary-cipher:v1';
 let prepared=null,preparing=null,prepareEpoch=0,renderer=null;
 async function prepare(request,{force=false}={}){
  if(window.__BETTER_CODEX_SCOPE__?.id!=='secondary')throw Error('书架仅属于 SECONDARY 工作区');
  if(preparing)return preparing;
  if(!force&&prepared&&Date.now()-prepared.at<60000)return prepared;
  const epoch=prepareEpoch;
  const task=(async()=>{
   const bundle=await request('secondary/bootstrap');
   if(bundle.payloadUrl!=='/secondary-library/portal.enc.json'||!/^[a-f0-9]{64}$/.test(bundle.payloadSha256))throw Error('书架入口配置无效');
   const keyMaterial=bundle.keyMaterial;
   if(typeof keyMaterial!=='string')throw Error('书架内容暂不可读');
   let html=renderer?.hash===bundle.payloadSha256&&renderer.keyMaterial===keyMaterial?renderer.html:null;
   if(!html){
    const cacheKey=location.origin+bundle.payloadUrl+'?sha256='+bundle.payloadSha256;
    let cache=null,response=null;try{cache=await caches.open(cipherCacheName);response=await cache.match(cacheKey);}catch{}
    let encrypted=response?await response.arrayBuffer():null;
    const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
    if(encrypted&&await digest(encrypted)!==bundle.payloadSha256)encrypted=null;
    if(!encrypted){
     response=await fetch(bundle.payloadUrl,{cache:'no-store',redirect:'manual'});
     if(!response.ok)throw Error('书架内容暂不可读');
     encrypted=await response.arrayBuffer();
     if(await digest(encrypted)!==bundle.payloadSha256)throw Error('书架版本刚刚更新，请点击刷新重新打开');
     if(epoch!==prepareEpoch)throw Error('登录状态已改变');
     try{if(cache){await cache.put(cacheKey,new Response(encrypted,{headers:{'content-type':'application/json'}}));for(const old of await cache.keys())if(old.url!==cacheKey)await cache.delete(old);}}catch{}
    }
    const p=JSON.parse(new TextDecoder().decode(encrypted));
    if(!p?.kdf||!p?.cipher)throw Error('书架内容暂不可读');
    const seed=await crypto.subtle.importKey('raw',new TextEncoder().encode(keyMaterial),'PBKDF2',false,['deriveKey']);
    const key=await crypto.subtle.deriveKey({name:'PBKDF2',salt:decode(p.kdf.salt),iterations:p.kdf.iterations,hash:'SHA-256'},seed,{name:'AES-GCM',length:256},false,['decrypt']);
    html=new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(p.cipher.nonce)},key,decode(p.cipher.ciphertext)));
    if(!html.includes('id="library-data"')||!html.includes('function effectiveBook(')||!html.includes('function loadState('))throw Error('现有书架界面版本需要适配');
   }
   if(epoch!==prepareEpoch)throw Error('登录状态已改变');
   renderer={hash:bundle.payloadSha256,keyMaterial,html};
   prepared={bundle,html,at:Date.now()};return prepared;
  })();
  preparing=task;try{return await task;}finally{if(preparing===task)preparing=null;}
 }
 function clearPrepared(){prepareEpoch++;prepared=null;renderer=null;preparing=null;}
 addEventListener('betterCodex:authentication-required',clearPrepared);
 addEventListener('pagehide',clearPrepared);
 function mount(container,{request,body,status}){
  let alive=true,frame=null,loading=null,keyMaterial=null,initialState=null,dirty=false,saving=false,uncertain=null,ready=false;
  const panel=container.closest('.betterCodex-native-plugin');if(panel)panel.dataset.secondaryFrame='1';
  const message=(text,error=false)=>{if(!alive)return;status.textContent=text;status.dataset.state=error?'error':'ready';};
  const guarded=()=>{if(!alive)throw Error('书架已关闭');};
  async function state(method,raw){
   guarded();
   if(method==='GET'){
    if(initialState){const value=initialState;initialState=null;return value;}
    const value=await request('secondary/state');guarded();return value;
   }
   if(saving)throw Error('上一项修改仍在保存');
   if(uncertain)throw Error('上次保存结果尚未确认，请先点击顶部刷新');
   let payload;try{payload=JSON.parse(raw);}catch{throw Error('保存格式无效');}
   saving=true;message('正在保存…');
   try{
    const result=await request('secondary/state',{method:'POST',headers:{'content-type':'application/json'},body:raw});guarded();dirty=false;message('修改已保存');return result;
   }catch(error){
    if(error.code&&error.code<500){message(error.code===409?'出现新的已保存版本，请先核对再保存':'保存失败，修改仍留在当前页面',true);throw error;}
    // Verify this exact cipher after a lost response; do not replay the write.
    uncertain=payload;
    try{const latest=await request('secondary/state');guarded();
     if(JSON.stringify(latest.cipher)===JSON.stringify(payload.cipher)){uncertain=null;dirty=false;message('已确认修改保存成功');return {ok:true,revision:latest.revision,updated_at:latest.updated_at};}
     if(latest.revision===payload.expected_revision){uncertain=null;message('修改未保存，请重试',true);}
     else{uncertain=null;message('保存期间出现新版本，当前修改已保留，请核对后再保存',true);}
    }catch{}
    if(uncertain)message('保存结果尚未确认，请点击顶部刷新核对；不要重复保存',true);
    throw error;
   }finally{saving=false;}
  }
  async function exportDocument(blob,name){
   guarded();const bridge=window.__BETTER_CODEX_ANDROID_BRIDGE__;
   if(!bridge)return false;
   if(typeof bridge.saveDocument!=='function'){message('App 需要更新后才能直接保存 Word；书架和编辑可继续使用',true);return true;}
   try{const result=await bridge.saveDocument(blob,name);guarded();message(result.cancelled?'已取消保存':'Word 文件已保存');}
   catch(error){message(error.code==='APP_UPDATE_REQUIRED'?'请先更新 App，再保存 Word 文件':'Word 文件未保存，请重试',true);}return true;
  }
  async function load(){
   message('正在打开书架…');const openedAt=Date.now(),page=await prepare(request);guarded();
   keyMaterial=page.bundle.keyMaterial;
   // A prewarmed renderer must never replay an older manual save revision.
   initialState=page.at>=openedAt?page.bundle.state:await request('secondary/state');guarded();
   let html=page.html;
   frame=document.createElement('iframe');frame.className='betterCodex-secondary-frame';frame.title='SecondaryProject 私密书架';frame.setAttribute('sandbox','allow-scripts allow-same-origin allow-downloads');frame.src='/secondary-workbench-frame?workspace=secondary';
   const loaded=new Promise((resolve,reject)=>{frame.onload=()=>{if(frame.contentDocument?.body?.dataset.secondaryFrame==='ready')resolve();else reject(Error('书架页面连接暂不可用'));};frame.onerror=()=>reject(Error('书架页面连接暂不可用'));});
   container.replaceChildren(frame);await loaded;guarded();frame.onload=null;frame.onerror=null;
   const win=frame.contentWindow,context={inputChanged:()=>window.__BETTER_CODEX_ANDROID_INPUT__?.refresh(),unlock:async()=>{guarded();return {keyMaterial};},state,message,dirty:value=>{dirty=value;},exportDocument,ready:()=>{ready=true;message('');}};
   html=html.replace(/<head([^>]*)>/i,'<head$1><script>'+prelude+'</script>');
   html=html.replace(/<\/body>/i,'<script>'+afterlude+'</script></body>');
   win.__BETTER_CODEX_MOUNT_LIBRARY__(html,context);
  }
  async function refresh(){
   if(!alive)return;if(loading)return loading;if(saving){message('正在保存，请稍候');return;}
   if(uncertain){const saved=await request('secondary/state');guarded();
    if(JSON.stringify(saved.cipher)===JSON.stringify(uncertain.cipher)){dirty=false;uncertain=null;message('已确认上次修改保存成功，请返回阅读后刷新');}
    else if(saved.revision===uncertain.expected_revision){uncertain=null;message('上次修改未保存，当前修改仍在，可以重试',true);}
    else{uncertain=null;message('出现新的保存版本，当前修改仍在，请先核对',true);}return;
   }
   if(ready&&frame){if(dirty||frame.contentWindow.__BETTER_CODEX_FICTION_FRAME__?.editing){message('正在编辑，刷新不会替换未保存的稿件');return;}await frame.contentWindow.__BETTER_CODEX_FICTION_FRAME__?.refresh();message('');return;}
   loading=load().finally(()=>{loading=null;});return loading;
  }
  return {refresh,back:()=>false,canReload:()=>!dirty&&!saving&&!uncertain&&!frame?.contentWindow?.__BETTER_CODEX_FICTION_FRAME__?.editing,canLeave(){if(saving||uncertain){message('请先确认保存结果，再离开书架',true);return false;}if(dirty){message('还有未保存的修改，请先保存，或使用书架中的“取消”放弃修改',true);return false;}return true;},destroy(){window.__BETTER_CODEX_ANDROID_INPUT__?.refresh();alive=false;keyMaterial=null;initialState=null;frame?.remove();frame=null;container.replaceChildren();if(panel)delete panel.dataset.secondaryFrame;}};
 }
 async function localCacheState(){
  if(window.__BETTER_CODEX_SCOPE__?.id!=='secondary')return null;
  let cached=false;try{if((await caches.keys()).includes(cipherCacheName)){const existing=await caches.open(cipherCacheName);cached=(await existing.keys()).some(entry=>new URL(entry.url).pathname==='/secondary-library/portal.enc.json');}}catch{}
  return {cached,prepared:!!prepared,loading:!!preparing,preparedAt:prepared?.at||0};
 }
 window.__BETTER_CODEX_FICTION__={localCacheState,mount,preload:request=>prepared?Promise.resolve():prepare(request)};
})();
