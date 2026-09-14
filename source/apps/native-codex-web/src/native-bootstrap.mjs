// The cloud may serve this read-only startup snapshot. Credentials and drafts
// stay out of it; real execution still requires a fresh scoped Mac connection.
export function cacheableBootstrap(config,{initialization,defaults={},settings={}}={}){
 const copy=structuredClone(config);
 for(const key of ['gatewayBaseUrl','gatewayWsUrl'])if(copy[key]){const u=new URL(copy[key]);u.search='';copy[key]=u.href;}
 copy.persistedAtomSnapshot=Object.fromEntries(Object.entries(copy.persistedAtomSnapshot||{}).filter(([key])=>/^(sidebar-|flat-project-sidebar-|app-shell:|home-composer-mode-|agent-mode-by-host-id$|config-derived-agent-mode-by-host-id$|locale|theme|font)/.test(key)));
 const safe=new Set(['pending_worktrees','local-projects','selected-project','project-order']);
 if(copy.initialSidebarBootstrap)copy.initialSidebarBootstrap.globalStateEntries=(copy.initialSidebarBootstrap.globalStateEntries||[]).filter(e=>safe.has(e.key));
 const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:authToken|accessToken|refreshToken|apiKey|api_key|scopeToken|authorization)$/i.test(key)).map(([key,v])=>[key,strip(v)])):value;
 copy.betterCodexReadDefaults=strip(defaults);copy.betterCodexNativeInitialization=initialization;copy.betterCodexSettings=strip(settings);
 return copy;
}
