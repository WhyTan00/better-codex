// The list shell and renderer share an origin and a fixed workspace. Messages
// cannot select another workspace or invoke arbitrary native/browser actions.
(()=>{const scope=window.__BETTER_CODEX_SCOPE__;
 if(!scope||window.parent===window||new URL(location.href).searchParams.get('betterCodexEmbedded')!=='1')return;
 const origin=location.origin,send=(type,values={})=>parent.postMessage({type,scope:scope.id,...values},origin);
 window.__BETTER_CODEX_EMBEDDED__=true;
 addEventListener('betterCodex:native-route',e=>send('betterCodex-shell-route',{path:e.detail.path}));
 addEventListener('betterCodex:conversation-ready',()=>send('betterCodex-shell-ready'));
 addEventListener('message',e=>{if(e.source!==parent||e.origin!==origin||e.data?.scope!==scope.id)return;const m=e.data;
  if(m.type==='betterCodex-shell-hidden'){document.activeElement?.blur();window.__BETTER_CODEX_FOCUS_POLICY__?.reset('list');return;}
  if(m.type!=='betterCodex-shell-open'||!(m.path==='/'||/^\/local\/[0-9a-f-]{36}$/i.test(m.path)))return;
  window.__BETTER_CODEX_FOCUS_POLICY__?.reset(m.path);window.__BETTER_CODEX_PERF__?.navigation(m.at);
  window.postMessage({type:'navigate-to-route',path:m.path},origin);
 });
 document.addEventListener('click',e=>{const a=e.target?.closest?.('a[href]');if(!a||e.defaultPrevented||e.button>0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;
  const u=new URL(a.href,location.href);if(u.origin===origin&&u.pathname==='/'&&u.searchParams.get('workspace')===scope.id&&u.searchParams.get('view')!=='chat'){e.preventDefault();send('betterCodex-shell-list');}
  else if(u.origin===origin&&u.pathname==='/workbench')a.target='_top';
 },true);
})();
