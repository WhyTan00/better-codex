// Pinned official controls: expand the original content pane; keep its renderer.
export function previewNavigation(source){
 const edits=[
  ['function oBi(e){let{', 'function oBi(e){if(e.target==null&&e.line==null&&e.endLine==null&&e.openMode!==`workspace`&&e.persistPreferredTargetPath==null&&window.__DSH_PREVIEW__?.openHtml?.(e.cwd==null?e.path:_x(e.cwd,e.path),e)){e.onOpenTargetResolved?.(null);return}let{'],
  ['function Wxo(e,t,n={}){','function __DSH_FILE_PREVIEW__(e){const tab=e.get(ZM.activeTab$);if(!tab?.props?.path)return;oKi(e,{kind:`content`,tab},{mode:`full`});window.__DSH_PREVIEW__?.open({kind:`file`,close:()=>JG(e,!1),isOpen:()=>e.get(lM)&&!!e.get(ZM.activeTab$)?.props?.path});}function Wxo(e,t,n={}){if(n.line==null&&n.endLine==null&&window.__DSH_PREVIEW__?.openHtml?.(t,n))return{placement:`full`,status:`opened`,viewer:`html`};const result=__DSH_OPEN_FILE__(e,t,n);if(result?.placement===`right`)__DSH_FILE_PREVIEW__(e);return result;}function __DSH_OPEN_FILE__(e,t,n={}){'],
  ['i!=null&&LHi(x).navigateTo(i),g&&yG(e),!0','i!=null&&LHi(x).navigateTo(i),g&&yG(e),r&&S===`right`&&__DSH_FILE_PREVIEW__(e),!0'],
  ['A=r&&S===`right`&&t!=null&&V0n(t)!==`none`&&w?.tabType.kind!==gKi.kind', 'A=r&&S===`right`&&t!=null'],
  ['A&&N!=null&&oKi(e,{kind:`content`,tab:N},{mode:`full`})', 'A&&N!=null&&(oKi(e,{kind:`content`,tab:N},{mode:`full`}),window.__DSH_PREVIEW__?.open({kind:`file`,close:()=>JG(e,!1),isOpen:()=>e.get(lM)&&e.get(ZM.activeTab$)?.tabType.kind===gKi.kind}))'],
  ['zoomControlsPlacement:ee=`bottom`}){', 'zoomControlsPlacement:ee=`bottom`}){window.__DSH_USE_PREVIEW_LAYER__?.(vJ,a,o);'],
 ];
 for(const [before,after]of edits){if(source.split(before).length!==2)throw Error('Official fullscreen preview contract changed: '+before);source=source.replace(before,after);}
 return source;
}

export function previewChrome(source){
 const before='className:`flex min-w-0 items-center gap-2 px-3 py-2`,children:[(0,$.jsx)(`span`,{className:`min-w-0 flex-1 truncate text-sm`,children:c.split(/[\\/]/).pop()}),...F]';
 if(source.split(before).length!==2)throw Error('Compact file header contract changed');
 return source.replace(before,'className:`hidden`,children:[]');
}
