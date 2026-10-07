// Native WebView owns its resource cache. Migrate only this app's old DSH worker.
(()=>{
 if(location.origin!=='__BETTER_CODEX_ORIGIN__'||window.top!==window)return;
 window.__DSH_ANDROID_HOST__=true;
 window.__DSH_ANDROID_STARTUP__=(async()=>{
  if(!('serviceWorker'in navigator))return {reload:false};
  try{
   const controller=navigator.serviceWorker.controller;
   const ours=worker=>{try{const u=new URL(worker?.scriptURL);return u.origin===location.origin&&u.pathname==='/workbench-sw.js';}catch{return false;}};
   const registrations=await navigator.serviceWorker.getRegistrations();
   let removed=false;
   for(const registration of registrations){
    if(ours(registration.active)||ours(registration.waiting)||ours(registration.installing))removed=(await registration.unregister())||removed;
   }
   // Unregister does not release the current document's controller. Reload once
   // after successful migration; no browsing cookies, databases or user data removed.
   return {reload:removed&&ours(controller)};
  }catch{return {reload:false};}
 })();
})();
