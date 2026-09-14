// Checked patches in pinned third-party browser glue; official renderer stays intact.
export function scopeRuntimeAssets(source){
 // The complete runtime includes WCO glue; the standalone bridge does not.
 const chromeWriter='    function applyManagedThemeColor() {';
 if(source.includes(chromeWriter)){
  if(source.split(chromeWriter).length!==2)throw Error('Pinned theme contract changed');
  source=source.replace(chromeWriter,chromeWriter+'\n      if (w.__BETTER_CODEX_THEME_COLOR__) return; // BETTER_CODEX owns the PWA chrome palette.');
 }
 const patches=[
  ['rejectPendingGatewayIpc(new Error("Gateway WebSocket disconnected"), socket);',
   'if (!socket.__betterCodexNegotiated) rejectPendingGatewayIpc(new Error("Gateway WebSocket disconnected"), socket);'],
  ['  function handleReconnectVisibilityChange() {',
   '  w.__BETTER_CODEX_RESET_BROWSER_PORTS__ = () => { rejectPendingGatewayIpc(new Error("Page connection replaced; check native state before retrying")); for (const state of [...appHostPortRelays.values()]) closeAppHostRelay(state, "page_session_replaced", false); };\n  w.__BETTER_CODEX_RECONNECT_TRANSPORT__ = () => scheduleReconnect();\n  function handleReconnectVisibilityChange() {'],
  ['  function scheduleReconnect() {\n    if (reconnectTimer) return;',
   '  function scheduleReconnect() {\n    if (w.__BETTER_CODEX_CONNECTION_PAUSED__) return;\n    if (reconnectTimer) return;'],
  ['const payload = payloadFromIpcArgs(ipcArgs);\n    if (isLowPriorityFetchPayload(payload))',
   'const payload = payloadFromIpcArgs(ipcArgs);\n    const localRead = await window.__BETTER_CODEX_IPC_CACHE__?.(channel,payload,(type,value)=>deliverLocalRendererMessage(type,value)); if (localRead?.handled) return localRead.value;\n    if (channel === \"codex_desktop:message-from-view\" && payload?.type === \"persisted-atom-update\") { const saved = await window.__BETTER_CODEX_NATIVE_CACHE__?.persistAtom(payload); if (!navigator.onLine || window.__BETTER_CODEX_EXECUTION_CONNECTED__ === false) return null; }\n    if (channel === "codex_desktop:message-from-view" && payload?.type === "log-message" && payload.message === "maybe_resume_success") window.__BETTER_CODEX_PERF__?.ready(payload.tags?.safe?.conversationId || payload.safe?.conversationId);\n    // These desktop telemetry messages are already ignored by this private gateway.\n    // Local plugin observers run before invokeGateway; retain their view events.\n    if (channel === "codex_desktop:message-from-view" && ["log-message", "analytics-event", "tray-menu-threads-changed"].includes(payload?.type)) return null;\n    if (isLowPriorityFetchPayload(payload))'],
  ['return new URL(`/api/app-fs/@fs/${encodedPath}`, location.origin).href;',
   'const scope=window.__BETTER_CODEX_SCOPE__;const scoped=new URL(`/w/${scope.id}/api/app-fs/@fs/${encodedPath}`,location.origin);scoped.searchParams.set("scopeToken",scope.token);return scoped.href;'],
  ['const serialized = await Promise.all(files.map((file) => serializePickedFile(file)));\n    return invokeGateway("pick-files", {\n      params: {\n        ...(params && typeof params === "object" ? params : {}),\n        files: serialized,\n      },\n    });',
   'const localPreview = w.__BETTER_CODEX_ANDROID_UPLOAD__?.begin(files);\n    try {\n      await localPreview?.presented();\n      const serialized = await Promise.all(files.map((file) => serializePickedFile(file)));\n      const result = await invokeGateway("pick-files", {params: {...(params && typeof params === "object" ? params : {}), files: serialized}});\n      localPreview?.complete(result);\n      return result;\n    } catch (error) { localPreview?.fail(); throw error; }'],
  ['disposeFocus = adapterHost.events.observe({ key: {}, target: w, type: "focus", capture: true, callback: handleFocus });',
   '/* Native cancel/change events own picker completion. Window focus is not cancellation. */']
 ];
 for(const [needle,replacement]of patches){if(source.split(needle).length!==2)throw Error('Pinned browser contract changed');source=source.replace(needle,replacement);}return source;
}
