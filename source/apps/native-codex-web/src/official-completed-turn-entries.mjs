// Completed entries render their captured turn rather than subscribing to its
// live entity. Reuse by item IDs alone is therefore safe only while streaming.
export function patchCompletedTurnEntryReuse(source) {
 const before='e.turn===t.turn||t.historyEntityKey!=null&&e.turnState==null&&t.turnState==null&&e.turn?.items.length===t.turn?.items.length';
 const after='e.turn===t.turn||e.turn?.status===`inProgress`&&t.turn?.status===`inProgress`&&t.historyEntityKey!=null&&e.turnState==null&&t.turnState==null&&e.turn?.items.length===t.turn?.items.length';
 const oldCount=source.split(before).length-1,newCount=source.split(after).length-1;
 if(newCount===1&&oldCount===0)return source;
 if(oldCount!==1||newCount!==0)throw Error('Pinned completed turn-entry contract changed');
 return source.replace(before,after);
}
