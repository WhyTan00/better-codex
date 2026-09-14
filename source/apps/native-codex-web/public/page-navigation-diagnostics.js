// Distinguish a new document from same-page resize without changing navigation.
// Only bounded technical labels leave the device; never URLs, drafts or errors.
(()=>{
 const scope=window.__BETTER_CODEX_SCOPE__;if(!scope)return;
 const mobile=matchMedia('(pointer:coarse)').matches||(navigator.maxTouchPoints||0)>1;if(!mobile)return;
 const send=window.fetch.bind(window),pageId=crypto.randomUUID().slice(0,8),key='betterCodex-page-lifecycle-v1:'+scope.id;
 const get=sessionStorage.getItem.bind(sessionStorage),set=sessionStorage.setItem.bind(sessionStorage);
 const ua=navigator.userAgent||'',browser=/EdgA\//.test(ua)?'edge':/VivoBrowser\//i.test(ua)?'vivo':/SamsungBrowser\//.test(ua)?'samsung':/Firefox\//.test(ua)?'firefox':/Chrome\//.test(ua)?'chrome':'other';
 const browserMajor=Number(ua.match(/(?:EdgA|VivoBrowser|SamsungBrowser|Firefox|Chrome)\/(\d+)/i)?.[1]||0);
 const navigationType=performance.getEntriesByType('navigation')[0]?.type||'unknown';
 const standalone=matchMedia('(display-mode:standalone)').matches;
 let width=innerWidth,height=innerHeight,lastWidthChange=0,previous=null;
 try{previous=JSON.parse(get(key)||'null');}catch{}
 const base=()=>({phase:'navigation',mobile:true,pageId,width:innerWidth,height:innerHeight,devicePixelRatio:devicePixelRatio||1,browser,browserMajor,standalone,elapsedMs:Math.round(performance.now())});
 const pending=[];function emit(reason,values={}){if(!scope.token){if(pending.length<10)pending.push([reason,values]);return;}send('/w/'+scope.id+'/api/performance',{method:'POST',keepalive:true,headers:{'content-type':'application/json','x-betterCodex-scope':scope.token},body:JSON.stringify({events:[{...base(),reason,...values}]})}).catch(()=>{});}
 addEventListener('betterCodex:session-ready',()=>{for(const [reason,values]of pending.splice(0))emit(reason,values);});
 window.__BETTER_CODEX_PAGE_NAVIGATION_DIAGNOSTICS__={authRequired(){emit('document_auth_required');}};
 function snapshot(){try{set(key,JSON.stringify({pageId,width,height,at:Date.now(),lastWidthChange}));}catch{}}
 emit('document_start',{navigationType,wasDiscarded:document.wasDiscarded===true,...(previous&&Date.now()-previous.at>=0&&Date.now()-previous.at<60000?{previousPageId:previous.pageId,previousWidth:previous.width,previousHeight:previous.height,previousWidthChangeAgeMs:previous.lastWidthChange?Math.max(0,Date.now()-previous.lastWidthChange):undefined}:{})});
 snapshot();
 addEventListener('resize',()=>{const changed=innerWidth!==width;if(changed){lastWidthChange=Date.now();width=innerWidth;}height=innerHeight;if(changed)snapshot();},{passive:true});
 addEventListener('pagehide',e=>{snapshot();emit('document_hide',{persisted:e.persisted===true,widthChangeAgeMs:lastWidthChange?Math.max(0,Date.now()-lastWidthChange):undefined});});
 window.navigation?.addEventListener('navigate',e=>{if(e.hashChange||e.navigationType!=='reload'&&e.destination?.sameDocument)return;emit('document_navigate',{navigationType:e.navigationType,userInitiated:e.userInitiated===true,widthChangeAgeMs:lastWidthChange?Math.max(0,Date.now()-lastWidthChange):undefined});});
 // Deliberately do not register beforeunload or intercept/cancel a navigation.
})();
