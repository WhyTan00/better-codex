// Keep the official activity group and its manual toggle. Complete a live turn
// by settling the existing collapse state once, without remounting the thread.
export const turnCollapseAsset='local-conversation-turn-5379f3f29ba1.js';
export function patchTurnCompletionCollapse(source){
 const state='I=mt==null?y.status===`in_progress`:mt===`inProgress`,ht;';
 const prevent='preventAutoCollapse:Ot||yr,';
 if(source.split(state).length!==2||source.split(prevent).length!==2)throw Error('Official live-turn collapse contract changed');
 // v is the Native turn: its completed status distinguishes success from
 // failed, which the display projection y also maps to "complete".
 const settle=`I=mt==null?y.status===\`in_progress\`:mt===\`inProgress\`;const betterCodexTurnKey=c+'\\0'+k,betterCodexLiveTurn=(0,Ui.useRef)({key:betterCodexTurnKey,seenActive:I});(0,Ui.useEffect)(()=>{let seen=betterCodexLiveTurn.current;if(seen.key!==betterCodexTurnKey)seen=betterCodexLiveTurn.current={key:betterCodexTurnKey,seenActive:I};if(I){seen.seenActive=true;return;}if(v?.status!=='completed'||!seen.seenActive)return;seen.seenActive=false;if(!ut)ce?.(true);},[betterCodexTurnKey,I,v?.status,ce,ut]);let ht;`;
 return source.replace(state,settle).replace(prevent,'preventAutoCollapse:I&&(Ot||yr),')
  .replaceAll('from"./','from"/official-patched-v8/assets/')
  .replaceAll('import.meta.url',`new URL('/official-patched-v8/assets/${turnCollapseAsset}',location.origin).href`);
}
