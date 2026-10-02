// The bridge has already uploaded the selected bytes. Keep the renderer's
// attachment identity and consume those exact bytes instead of downloading the
// same image again before it can enter the composer.
export const imageAttachmentAssetPrefix='/official-patched-v1031/assets/';
export function patchImageAttachments(source){
 const patches=[
  ['function pOr(e){return kOr.get(e)??null}',
   'function pOr(e){return kOr.get(e)??globalThis.__DSH_PICKED_IMAGE__?.(e)??null}'],
  ['let{accept:n,allowMultiple:r,imagesOnly:i,pickerTitle:a}=e===void 0?{}:e,',
   'let{accept:n,allowMultiple:r,imagesOnly:i,pickerTitle:a,dshComposerAttachment:dshHandoff}=e===void 0?{}:e,'],
  ['...i?{imagesOnly:!0}:{},pickerTitle:a??t.formatMessage(',
   '...i?{imagesOnly:!0}:{},...dshHandoff?{dshComposerAttachment:!0}:{},pickerTitle:a??t.formatMessage('],
  ['let{imagesOnly:t}=e;if(m!=null)return m({imagesOnly:t});',
   'let{imagesOnly:t,dshComposerAttachment:dshHandoff}=e;if(m!=null)return m({imagesOnly:t});'],
  ['return b({imagesOnly:t,pickerTitle:n})',
   'return b({imagesOnly:t,pickerTitle:n,dshComposerAttachment:dshHandoff})'],
  ['async function kZr(e,t){try{let n=e.getAttachmentGeneration(),{images:r,otherFiles:i}=AZr(await e.pickFiles({imagesOnly:t})),a=r.length===0?[]:await e.loadImageDataUrls(r);if(e.getAttachmentGeneration()!==n||(a.length>0&&e.addImageDataUrls(a),t||i.length===0))return;if(e.executionTargetHostId!==`local`&&e.uploadLocalFileAttachments!=null){await e.uploadLocalFileAttachments(i);return}e.addFileAttachments(i)}catch(t){e.onFilePickerError(t)}}',
   'async function kZr(e,t){let dshFiles;const dshPath=globalThis.location?.pathname;try{let n=e.getAttachmentGeneration();dshFiles=await e.pickFiles({imagesOnly:t,dshComposerAttachment:!0});const dshCurrent=()=>e.getAttachmentGeneration()===n&&globalThis.location?.pathname===dshPath;if(!dshCurrent()){globalThis.__DSH_FINISH_PICKED_FILES__?.(dshFiles,`cancelled`);return}let{images:r,otherFiles:i}=AZr(dshFiles),a=r.length===0?[]:await e.loadImageDataUrls(r);if(!dshCurrent()){globalThis.__DSH_FINISH_PICKED_FILES__?.(dshFiles,`cancelled`);return}if(a.length!==r.length){const error=new Error(`图片已上传，但未能加入消息，请重新选择图片；文字草稿已保留。`);error.code=`DSH_ATTACHMENT_HANDOFF_FAILED`;throw error}if(a.length>0&&e.addImageDataUrls(a)===!1){const error=new Error(`图片未能加入消息，请检查附件大小后重新选择；文字草稿已保留。`);error.code=`DSH_ATTACHMENT_HANDOFF_FAILED`;throw error}if(!t&&i.length>0){if(e.executionTargetHostId!==`local`&&e.uploadLocalFileAttachments!=null)await e.uploadLocalFileAttachments(i);else e.addFileAttachments(i)}globalThis.__DSH_FINISH_PICKED_FILES__?.(dshFiles,`accepted`)}catch(t){globalThis.__DSH_FINISH_PICKED_FILES__?.(dshFiles,`failed`);e.onFilePickerError(t)}}'],
  ['async function FZr(e){return(await Promise.all(e.map(async e=>{try{let t=pOr(e);if(t!=null){let n=IZr({contentsBase64:t.contentsBase64,fsPath:e.fsPath,mimeType:t.mimeType});if(n!=null)return{dataUrl:n,filename:e.label,localPath:e.fsPath}}let n=IZr({contentsBase64:(await SE(`read-file-binary`,{params:{path:e.fsPath,hostId:z_}})).contentsBase64,fsPath:e.fsPath});return n==null?null:{dataUrl:n,filename:e.label,localPath:e.fsPath}}catch{return null}}))).filter(e=>e!=null)}',
   'async function FZr(e){return Promise.all(e.map(async e=>{try{let t=pOr(e);if(t!=null){let n=IZr({contentsBase64:t.contentsBase64,fsPath:e.fsPath,mimeType:t.mimeType});if(n!=null)return{dataUrl:n,filename:e.label,localPath:e.fsPath}}const dshRead=await SE(`read-file-binary`,{params:{path:e.fsPath,hostId:z_}});let n=IZr({contentsBase64:dshRead.contentsBase64,fsPath:e.fsPath,mimeType:dshRead.mimeType});if(n==null)throw Error(`Image bytes unavailable`);return{dataUrl:n,filename:e.label,localPath:e.fsPath}}catch(cause){const error=new Error(`图片已上传，但未能加入消息，请重新选择图片；文字草稿已保留。`,{cause});error.code=`DSH_ATTACHMENT_HANDOFF_FAILED`;globalThis.__DSH_CLIENT_LOG__?.reportError(`execution_failed`,cause,{component:`resource`,routeClass:`local_file`,resourceKind:`image`,stage:`failed`,reason:`body_unavailable`});throw error}}))}'],
  ['j=()=>{v.get(ug).danger(y.formatMessage({id:`composer.addContext.openFilePickerError`,',
   'j=e=>{if([`DSH_ATTACHMENT_HANDOFF_FAILED`,`DSH_ATTACHMENT_UPLOAD_FAILED`].includes(e?.code)){v.get(ug).danger(e.message);return}v.get(ug).danger(y.formatMessage({id:`composer.addContext.openFilePickerError`,'],
 ];
 for(const [before,after]of patches){if(source.split(before).length!==2)throw Error('Official image attachment contract changed: '+before.slice(0,100));source=source.replace(before,after);}
 // Android already places this guard before optimistic draft capture. The web
 // composer needs the same guard now that attachment handoff is shared.
 if(!source.includes('if(window.__DSH_ANDROID_UPLOAD__?.busy())')){
  const submit='s=Cv(async(a={})=>{';if(source.split(submit).length!==2)throw Error('Official image submit contract changed');
  source=source.replace(submit,submit+'if(window.__DSH_ANDROID_UPLOAD__?.busy()){globalThis.__DSH_CLIENT_LOG__?.event(`send_flow`,{stage:`blocked`,reason:`upload_busy`,threadId:PC(r)});window.__DSH_ANDROID_UPLOAD__.showPending();return}');
 }
 return source;
}
