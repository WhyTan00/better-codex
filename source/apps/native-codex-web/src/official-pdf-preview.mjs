// Supply the pinned PDF.js renderer's CJK maps and standard fonts locally.
// Loaded only when opening a PDF; no document bytes leave the private origin.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
export const pdfPreviewAssets=['pdf-preview-panel-fac8083e0747.js'];
export async function pdfSupportAsset(){
 const body=await readFile(new URL('../vendor/pdfjs-5.4.296/support.js',import.meta.url),'utf8');
 return {name:'dsh-pdf-support-'+createHash('sha256').update(body).digest('hex').slice(0,12)+'.js',body};
}
export function patchPdfPreview(source,supportName){
 if(!/^dsh-pdf-support-[a-f0-9]{12}\.js$/.test(supportName))throw Error('Invalid PDF support asset');
 const pattern=/\.getDocument\(\{data:([a-zA-Z_$][\w$]*)\}\)/g;
 const matches=[...source.matchAll(pattern)];
 if(matches.length!==1)throw Error('Pinned PDF preview contract changed');
 return source.replaceAll('new URL(`pdf.worker.min-2ac0aeeaff32.mjs`,import.meta.url)','new URL(`/official-patched-v8/assets/pdf.worker.min-2ac0aeeaff32.mjs`,import.meta.url)').replace(pattern,(_,data)=>'.getDocument({data:'+data+',...await import("./'+supportName+'").then(m=>m.pdfOptions())})');
}
