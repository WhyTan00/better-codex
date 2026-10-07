// Checked patches in pinned third-party browser glue; official renderer stays intact.
export function scopeRuntimeAssets(source){
 // The complete runtime includes WCO glue; the standalone bridge does not.
 const chromeWriter='    function applyManagedThemeColor() {';
 if(source.includes(chromeWriter)){
  if(source.split(chromeWriter).length!==2)throw Error('Pinned theme contract changed');
  source=source.replace(chromeWriter,chromeWriter+'\n      if (w.__DSH_THEME_COLOR__) return; // DSH owns the PWA chrome palette.');
 }
 const patches=[
  ['  async function pickFilesInBrowser(payload) {',
   `  const dshPickedImages = new WeakMap(), dshPickedBatches = new WeakMap();
  function dshReleasePickedFiles(files) {
    if (!Array.isArray(files)) return;
    for (const file of files) dshPickedImages.delete(file);
    dshPickedBatches.delete(files);
  }
  w.__DSH_PICKED_IMAGE__ = file => dshPickedImages.get(file) ?? null;
  w.__DSH_FINISH_PICKED_FILES__ = (files, outcome) => {
    const batch = files && dshPickedBatches.get(files), preview = batch?.preview;
    if (batch) w.__DSH_CLIENT_LOG__?.event("client_health", {component:"resource",routeClass:"local_file",stage:outcome,traceId:batch.traceId,itemCount:batch.count});
    try { if (outcome === "accepted") preview?.accepted(); else if (outcome === "cancelled") preview?.cancel(); else preview?.fail(true); }
    finally { dshReleasePickedFiles(files); }
  };
  w.__DSH_PICK_FILES__ = params => pickFilesInBrowser({params});
  async function pickFilesInBrowser(payload) {`],
  ['    modificationEffects?.filePicker?.emit();',
   '    try { modificationEffects?.filePicker?.emit(); } catch {} // Telemetry cannot block a local user gesture.'],
  ['  function connect() {\n    if (!cfg.gatewayWsUrl || !("WebSocket" in w)) return;',
   '  w.addEventListener("dsh:session-ready", () => connect());\n  function connect() {\n    if (w.__DSH_SCOPE__ && (!w.__DSH_SCOPE__.token || w.__DSH_CONNECTION_PAUSED__)) return;\n    if (!cfg.gatewayWsUrl || !("WebSocket" in w)) return;'],
  ['    closeLegacyPreviewPanel();\n    const panelPayload = {', '    closeLegacyPreviewPanel();\n    window.__DSH_PREVIEW__?.open({kind:"file",close:()=>{const value={open:false};dispatch("toggle-browser-panel",value);emitWindowMessage("toggle-browser-panel",value);}});\n    const panelPayload = {'],
  ['  function persistedAtomSnapshotObject() {', `  const dshAtomWrites = new Map();
  function dshApplyAtomUpdate(payload, base = persistedAtomSnapshot.get(payload.key) ?? persistedAtomSnapshot.get(payload.recordUpdate?.legacyStorageKey)) {
    if (!payload.recordUpdate) return payload.value;
    const update = payload.recordUpdate;
    const prior = base;
    const value = {...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {})};
    for (const [key, entry] of Object.entries(update.entries || {})) {
      delete value[key];
      if (entry != null) Object.defineProperty(value, key, {value:entry.value,enumerable:true,configurable:true,writable:true});
    }
    if (Number.isSafeInteger(update.maxEntries) && update.maxEntries >= 0)
      for (const key of Object.keys(value).slice(0,Math.max(0,Object.keys(value).length-update.maxEntries))) delete value[key];
    return value;
  }
  function dshWriteAtom(payload) {
    const previous = dshAtomWrites.get(payload.key);
    const entry = {value:payload.value,deleted:!!payload.deleted,recordUpdate:payload.recordUpdate?{...payload.recordUpdate,entries:{...previous?.recordUpdate?.entries,...payload.recordUpdate.entries}}:null};
    // Preserve recordUpdate on the wire; only our local echo is a full value.
    entry.value = dshApplyAtomUpdate(payload);
    setPersistedAtomSnapshotValue(payload.key, entry.value, entry.deleted);
    dshAtomWrites.set(payload.key, entry);
    if (!payload.recordUpdate && !payload.key.startsWith("composer-")) emitPersistedAtomUpdated(payload.key, entry.value, entry.deleted);
    entry.promise = (previous?.promise.catch(()=>{}) ?? Promise.resolve())
      .then(()=>invoke("codex_desktop:message-from-view", payload))
      .finally(()=>{if(dshAtomWrites.get(payload.key)===entry)dshAtomWrites.delete(payload.key);});
    return entry.promise;
  }
  function dshReconcileAtom(channel, payload) {
    if (channel === "persisted-atom-updated" && payload?.key) {
      const local = dshAtomWrites.get(payload.key);
      if (local) {const value=local.recordUpdate?dshApplyAtomUpdate({key:payload.key,recordUpdate:local.recordUpdate},payload.value):local.value;setPersistedAtomSnapshotValue(payload.key,value,local.deleted);return {...payload,value:local.deleted?null:value,deleted:local.deleted};}
      setPersistedAtomSnapshotValue(payload.key,payload.value,!!payload.deleted);
    } else if (channel === "persisted-atom-sync" && payload) {
      const state = {...(payload.state || payload.atoms || {})};
      for (const [key,entry] of dshAtomWrites) {if(entry.deleted)delete state[key];else state[key]=entry.recordUpdate?dshApplyAtomUpdate({key,recordUpdate:entry.recordUpdate},state[key]):entry.value;}
      for (const [key,value] of Object.entries(state)) setPersistedAtomSnapshotValue(key,value,false);
      return {...payload,state,atoms:state};
    }
    return payload;
  }
  function persistedAtomSnapshotObject() {`],
  ['const value = setPersistedAtomSnapshotValue(payload.key, payload.value, !!payload.deleted);\n          emitPersistedAtomUpdated(payload.key, value, !!payload.deleted);\n          return invoke("codex_desktop:message-from-view", payload);', 'return dshWriteAtom(payload);'],
  ['  function publishGatewayData(channel, payload, direction, transport = "bridge") {', '  function publishGatewayData(channel, payload, direction, transport = "bridge") {\n    if(direction === "server") payload = dshReconcileAtom(channel,payload);'],
  ['  function openPreviewInCodexSidePanel(payload) {', '  function openPreviewInCodexSidePanel(payload) {\n    if(window.__DSH_PREVIEW__?.openHtmlUrl?.(payload)) return true;'],
  ['rejectPendingGatewayIpc(new Error("Gateway WebSocket disconnected"), socket);',
   'if (!socket.__dshNegotiated) rejectPendingGatewayIpc(new Error("Gateway WebSocket disconnected"), socket);'],
  ['  function handleReconnectVisibilityChange() {',
   '  w.__DSH_RESET_BROWSER_PORTS__ = () => { rejectPendingGatewayIpc(new Error("Page connection replaced; check native state before retrying")); for (const state of [...appHostPortRelays.values()]) closeAppHostRelay(state, "page_session_replaced", false); };\n  w.__DSH_RECONNECT_TRANSPORT__ = () => scheduleReconnect();\n  function handleReconnectVisibilityChange() {'],
  ['  function scheduleReconnect() {\n    if (reconnectTimer) return;',
   '  function scheduleReconnect() {\n    if (w.__DSH_CONNECTION_PAUSED__) return;\n    if (reconnectTimer) return;'],
  ['    return invokeGatewayImmediate(channel, ipcArgs, payload);',
   '    try { return await invokeGatewayImmediate(channel, ipcArgs, payload); } catch (error) { window.__DSH_IPC_CACHE_FAILURE__?.(payload,error); window.__DSH_CLIENT_LOG__?.invokeFailed?.(payload,error); throw error; }'],
  ['const payload = payloadFromIpcArgs(ipcArgs);\n    if (isLowPriorityFetchPayload(payload))',
   'const payload = payloadFromIpcArgs(ipcArgs);\n    window.__DSH_CLIENT_LOG__?.ipc(channel,payload); const localRead = await window.__DSH_IPC_CACHE__?.(channel,payload,(type,value)=>deliverLocalRendererMessage(type,value)); if (localRead?.handled) { window.__DSH_CLIENT_LOG__?.handled(payload); if(channel === "open-file" && localRead.value?.url) openPreviewInCodexSidePanel(localRead.value); return localRead.value; }\n    if (channel === \"codex_desktop:message-from-view\" && payload?.type === \"persisted-atom-update\") { const saved = await window.__DSH_NATIVE_CACHE__?.persistAtom(payload); if (!navigator.onLine || window.__DSH_EXECUTION_CONNECTED__ === false) return null; }\n    if (channel === "codex_desktop:message-from-view" && payload?.type === "log-message" && payload.message === "maybe_resume_success") window.__DSH_PERF__?.ready(payload.tags?.safe?.conversationId || payload.safe?.conversationId);\n    // These desktop telemetry messages are already ignored by this private gateway.\n    // Local plugin observers run before invokeGateway; retain their view events.\n    if (channel === "codex_desktop:message-from-view" && ["log-message", "analytics-event", "tray-menu-threads-changed"].includes(payload?.type)) return null;\n    if (isLowPriorityFetchPayload(payload))'],
  ['return new URL(`/api/app-fs/@fs/${encodedPath}`, location.origin).href;',
   'const scope=window.__DSH_SCOPE__;const scoped=new URL(`/w/${scope.id}/api/app-fs/@fs/${encodedPath}`,location.origin);scoped.searchParams.set("scopeToken",scope.token);return scoped.href;'],
  ['const serialized = await Promise.all(files.map((file) => serializePickedFile(file)));\n    return invokeGateway("pick-files", {\n      params: {\n        ...(params && typeof params === "object" ? params : {}),\n        files: serialized,\n      },\n    });',
   `const dshTraceId = w.crypto?.randomUUID?.();
    w.__DSH_CLIENT_LOG__?.event("client_health", {component:"resource",routeClass:"local_file",stage:"captured",traceId:dshTraceId,itemCount:files.length});
    const localPreview = w.__DSH_ANDROID_UPLOAD__?.begin(files, {awaitHandoff:params?.dshComposerAttachment === true});
    try {
      await localPreview?.presented();
      const {dshComposerAttachment, ...gatewayParams} = params && typeof params === "object" ? params : {};
      const uploadStartedAt = Date.now();
      w.__DSH_CLIENT_LOG__?.event("client_health", {component:"resource",routeClass:"local_file",stage:"dispatch",traceId:dshTraceId,itemCount:files.length});
      // Serialization retains the original bytes for the official composer.
      // The independent upload lane transfers the File objects themselves;
      // a dispatched HTTP failure must never replay on the page WebSocket.
      const [serialized, httpReceipt] = await Promise.all([
        Promise.all(files.map((file) => serializePickedFile(file))),
        typeof w.__DSH_UPLOAD_PICKED_FILES__ === "function" ? w.__DSH_UPLOAD_PICKED_FILES__(files, {traceId:dshTraceId}) : null,
      ]);
      const result = httpReceipt ?? await invokeGateway("pick-files", {params: {...gatewayParams, files: serialized}});
      if (!Array.isArray(result?.files) || result.files.length !== serialized.length || result.files.some((file,index) => !file || typeof file.fsPath !== "string" || file.fsPath !== file.path || file.size !== serialized[index].size)) throw new Error("Attachment upload receipt did not match selected files");
      for (let index = 0; index < result.files.length; index++) {
        const file = serialized[index];
        if (/^image\\//.test(file.type)) dshPickedImages.set(result.files[index], {contentsBase64:file.contentsBase64,mimeType:file.type});
      }
      dshPickedBatches.set(result.files, {preview:localPreview,traceId:dshTraceId,count:files.length});
      w.__DSH_CLIENT_LOG__?.event("client_health", {component:"resource",routeClass:"local_file",stage:"received",traceId:dshTraceId,itemCount:files.length,durationMs:Date.now()-uploadStartedAt});
      localPreview?.complete(result, () => dshReleasePickedFiles(result.files));
      return result;
    } catch (error) { localPreview?.fail(); const failure = new Error("文件已选择，但上传未完成，请连接恢复后重新选择", {cause:error}); failure.code="DSH_ATTACHMENT_UPLOAD_FAILED"; w.__DSH_CLIENT_LOG__?.reportError("execution_failed",error,{component:"resource",routeClass:"local_file",stage:"failed",traceId:dshTraceId,reason:"upload_failed"}); throw failure; }`],
  ['disposeFocus = adapterHost.events.observe({ key: {}, target: w, type: "focus", capture: true, callback: handleFocus });',
   '/* Native cancel/change events own picker completion. Window focus is not cancellation. */']
 ];
 for(const [needle,replacement]of patches){if(source.split(needle).length!==2)throw Error('Pinned browser contract changed');source=source.replace(needle,replacement);}return source;
}
