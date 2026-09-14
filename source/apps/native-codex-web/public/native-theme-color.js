// Keep browser/PWA chrome in sync with the renderer, including manual themes.
(()=>{
 if(window.__BETTER_CODEX_THEME_COLOR__)return;
 const root=document.documentElement,system=matchMedia('(prefers-color-scheme: dark)'),key='betterCodex-theme-color-v1:'+window.__BETTER_CODEX_SCOPE__?.id;
 let hint=null,write=()=>{},lastVariant=null,mode='system',writeMode=()=>{},nativeTheme=null,nativeReady=false,nativeSyncing=false,nativeSavePending=false;
 const systemDark=()=>typeof nativeTheme?.systemDark==='boolean'?nativeTheme.systemDark:system.matches;
 try{const get=localStorage.getItem.bind(localStorage),set=localStorage.setItem.bind(localStorage);hint=JSON.parse(get(key)||'null');const savedMode=get(key+':mode');if(['system','light','dark'].includes(savedMode))mode=savedMode;writeMode=value=>{set(key+':mode',value);};write=value=>{try{set(key,JSON.stringify(value));}catch{}};}catch{}
 if(hint?.systemDark!==systemDark())hint=null;
 function apply(){
  if(mode){const desired=mode==='system'?(systemDark()?'dark':'light'):mode;root.classList.toggle('electron-dark',desired==='dark');root.classList.toggle('electron-light',desired==='light');}
  const explicit=root.classList.contains('electron-dark')?'dark':root.classList.contains('electron-light')?'light':null;
  const variant=explicit||(hint?.systemDark===systemDark()&&['dark','light'].includes(hint.variant)?hint.variant:systemDark()?'dark':'light');
  const color=variant==='dark'?'#000000':'#ffffff';
  for(const meta of document.querySelectorAll('meta[name="theme-color"]')){if(meta.hasAttribute('media'))meta.removeAttribute('media');if(meta.content!==color)meta.content=color;}
  const manifest=document.querySelector('link[rel="manifest"]');if(manifest){const href='/manifest.webmanifest?workspace='+(window.__BETTER_CODEX_INSTALLATION__?.id||window.__BETTER_CODEX_SCOPE__.id)+'&theme='+variant;if(manifest.getAttribute('href')!==href)manifest.setAttribute('href',href);}
  if(lastVariant!==variant)document.cookie='betterCodex-theme='+variant+'; Path=/; SameSite=Lax; Max-Age=31536000'+(location.protocol==='https:'?'; Secure':'');
  if(root.dataset.betterCodexTheme!==variant)root.dataset.betterCodexTheme=variant;
  if(root.style.colorScheme!==variant)root.style.colorScheme=variant;
  const changed=lastVariant!==variant;lastVariant=variant;
  if(changed)window.__BETTER_CODEX_APPLY_RENDERER_THEME__?.();
  if(explicit&&(hint?.variant!==variant||hint?.systemDark!==systemDark())){hint={variant,systemDark:systemDark()};write(hint);}
 }
 window.__BETTER_CODEX_THEME_COLOR__={apply,getMode:()=>mode||'system',getVariant:()=>mode==='system'?(systemDark()?'dark':'light'):mode,setMode(value){if(!['system','light','dark'].includes(value))throw Error('无效主题');writeMode(value);mode=value;hint=null;apply();syncNative(true);window.dispatchEvent(new Event('betterCodex:theme-changed'));}};
 async function syncNative(save=false){
  nativeSavePending=nativeSavePending||save;
  const bridge=window.__BETTER_CODEX_ANDROID_BRIDGE__;if(!bridge?.getTheme||nativeSyncing)return;
  const saveNow=nativeSavePending;nativeSavePending=false;nativeSyncing=true;
  try{
   const state=saveNow?await bridge.setTheme(mode):await bridge.getTheme();
   nativeTheme=state;
   if(!nativeReady){nativeReady=true;let saved=null;try{saved=localStorage.getItem(key+':mode');}catch{}if(saved&&['system','light','dark'].includes(saved)){mode=saved;nativeTheme=await bridge.setTheme(mode);}else if(['system','light','dark'].includes(state.mode))mode=state.mode;}
   apply();
  }catch{}finally{nativeSyncing=false;if(nativeSavePending)syncNative(true);}
 }
 addEventListener('betterCodex:android-theme',event=>{nativeTheme=event.detail;apply();});
 apply();syncNative();
 window.__BETTER_CODEX_ANDROID_BRIDGE__?.ready?.then(()=>syncNative());
 // Renderer head updates can replace or recolor metadata without changing the theme.
 new MutationObserver(records=>{if(records.some(r=>r.type==='childList'||r.target?.matches?.('meta[name="theme-color"]')))apply();}).observe(document.head,{subtree:true,childList:true,attributes:true,attributeFilter:['content','name','media']});
 new MutationObserver(apply).observe(root,{attributes:true,attributeFilter:['class']});
 system.addEventListener('change',()=>{hint=null;apply();});
 addEventListener('pageshow',()=>{apply();syncNative();});
 document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){apply();syncNative();}});
})();
