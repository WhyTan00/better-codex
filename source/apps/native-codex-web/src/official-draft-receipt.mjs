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

// Cold-start drafts come from the editor serializer, even when they have no
// visible formatting. A rich document retained in memory previously hid the
// plain-text fallback, which displayed its escaped underscores verbatim.
export function patchPersistedDraftKind(source) {
 const before='let Ft=hb(Fe)?`prompt`:`plain`,It=Ne?.plainTextMode===Oe?Ne.document:void 0';
 const after='let Ft=hb(Fe)||U==null&&Ne==null&&!Oe&&_e.get(xS).length>0?`prompt`:`plain`,It=Ne?.plainTextMode===Oe?Ne.document:void 0';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Pinned persisted draft kind contract changed');
 return source.replace(before,after);
}
