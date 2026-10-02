// Keep the official activity group and its manual toggle. Complete a live turn
// by settling the existing collapse state once, without remounting the thread.
export const turnCollapseAsset='local-conversation-turn-5379f3f29ba1.js';
export function patchTurnCompletionCollapse(source){
 const state='I=mt==null?y.status===`in_progress`:mt===`inProgress`,ht;';
 const prevent='preventAutoCollapse:Ot||yr,';
 const diff='Da=!I&&Cr!=null&&!Ar&&!_({endResources:_a,turn:y})?(0,Q.jsx)(Bn,{isInProgress:!1,item:Cr,deferOffscreenRendering:st,conversationId:c,cwd:T,hostId:u}):null';
 if([state,prevent,diff].some(anchor=>source.split(anchor).length!==2))throw Error('Official live-turn collapse contract changed');
 // v is the Native turn: its completed status distinguishes success from
 // failed, which the display projection y also maps to "complete".
 const settle=`I=mt==null?y.status===\`in_progress\`:mt===\`inProgress\`;const dshTurnKey=c+'\\0'+k,dshLiveTurn=(0,Ui.useRef)({key:dshTurnKey,seenActive:I});(0,Ui.useEffect)(()=>{let seen=dshLiveTurn.current;if(seen.key!==dshTurnKey)seen=dshLiveTurn.current={key:dshTurnKey,seenActive:I};if(I){seen.seenActive=true;return;}if(v?.status!=='completed'||!seen.seenActive)return;seen.seenActive=false;if(!ut)ce?.(true);},[dshTurnKey,I,v?.status,ce,ut]);let ht;`;
 // The completed diff used to mount outside the activity disclosure, even
 // when collapsed. Mounting it queries repository origins, parses patches,
 // and then defers code rendering again. Use the original manual disclosure
 // (or explicit full transcript); don't hide mounted children with CSS.
 // A live -> completed transition must not flash the card before the collapse
 // effect above settles. Failed/interrupted turns keep their original UI.
 const lazyDiff=diff.replace('Da=!I&&','Da=!I&&(v?.status!==`completed`||ut||(se===false&&!dshLiveTurn.current.seenActive))&&')
  .replace('deferOffscreenRendering:st','deferOffscreenRendering:v?.status===`completed`?!1:st');
 return source.replace(state,settle).replace(prevent,'preventAutoCollapse:I&&(Ot||yr),')
  .replace(diff,lazyDiff)
  .replaceAll('from"./','from"/official-patched-v8/assets/')
  .replaceAll('import.meta.url',`new URL('/official-patched-v8/assets/${turnCollapseAsset}',location.origin).href`);
}
