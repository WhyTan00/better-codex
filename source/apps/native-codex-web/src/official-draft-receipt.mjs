// A retained composer may mount again while its submission is in flight.
// Re-emitting the identical persisted document must not retire that receipt's
// ownership; actual text/attachment edits keep the original replacement path.
export function patchDraftReceipt(source) {
 const before='if(!r&&!i&&uto(e))return;let a=mK(e.value)';
 const after='if(!r&&uto(e)&&(!i||lto(t,e.get(k0))))return;let a=mK(e.value)';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Pinned draft receipt contract changed');
 return source.replace(before,after);
}
