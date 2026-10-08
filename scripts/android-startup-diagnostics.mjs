// Metadata-only startup gates. Never include account details, content or URLs.
export function patchAndroidStartupDiagnostics(source){
 const anchor='{overlay:n,fillParent:r,showLogo:i,debugName:a}=e,o=n!==void 0&&n';
 const replacement='{overlay:n,fillParent:r,showLogo:i,debugName:a}=e;(0,tEa.useEffect)(()=>{const log=window.__DSH_CLIENT_LOG__,stamp=(window.__DSH_LOADING_DIAGNOSTIC_SEQ__=(window.__DSH_LOADING_DIAGNOSTIC_SEQ__||0)+1),at=performance.now(),key=log?.hashId(a??"$Ta.unspecified");log?.event("client_health",{component:"android-webview",stage:"pending",reason:"loading_local_config",contentHash:key,count:stamp});return()=>log?.event("client_health",{component:"android-webview",stage:"closed",reason:"loading_local_config",contentHash:key,count:stamp,durationMs:Math.round(performance.now()-at)});},[a]);let o=n!==void 0&&n';
 const context='f=i?.systemVersion??o?.osVersion;if(r.isLoading||a||s||c)';
 const contextReplacement='f=i?.systemVersion??o?.osVersion;(0,f6.useEffect)(()=>{window.__DSH_CLIENT_LOG__?.event("client_health",{component:"android-webview",stage:r.isLoading||a||s||c?"pending":"shown",reason:"loading_local_config",contentHash:window.__DSH_CLIENT_LOG__?.hashId("CodexStatsigProvider.context"),count:(r.isLoading?1:0)|(a?2:0)|(s?4:0)|(c?8:0)});},[r.isLoading,a,s,c]);if(r.isLoading||a||s||c)';
 for(const[before,after]of[[anchor,replacement],[context,contextReplacement]]){if(source.split(before).length!==2)throw Error('Startup diagnostic ABI changed');source=source.replace(before,after);}
 return source;
}
