// Entry placement belongs to the reader. The official submit receipt continues
// to place a newly sent turn; a late history/status update has no such receipt.
export function patchViewportPresentation(source){
 const edits=[
  ['followMode:O&&(i??0)<=24?D===`prework`?`prework_follow`:`user_follow`:A?.followMode??`static`',
   'followMode:window.__DSH_READING_POSITION__?`static`:O&&(i??0)<=24?D===`prework`?`prework_follow`:`user_follow`:A?.followMode??`static`'],
  ['W=O&&i==null&&A==null,ee=', 'W=O&&i==null&&A==null&&!window.__DSH_READING_POSITION__,ee='],
  ['pe=()=>{if(R.current)return;let e=B.current;', 'pe=()=>{if(window.__DSH_READING_POSITION__?.hasPresented(n)){R.current=!0;return}if(R.current)return;let e=B.current;'],
  ['onApiChange:c,onVisibleContentReady:l,onLatestTurnHeightChange:Ke,',
   'onApiChange:c,onVisibleContentReady:()=>{window.__DSH_READING_POSITION__?.present(n,{hasRestore:k!=null||a!=null});l?.()},onLatestTurnHeightChange:Ke,']
 ];
 for(const[before,after]of edits){if(source.includes(after))continue;if(source.split(before).length!==2)throw Error('Official viewport presentation contract changed');source=source.replace(before,after);}return source;
}
