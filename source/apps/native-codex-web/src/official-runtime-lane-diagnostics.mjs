// Observe the actual invoke lane; keep all dispatch, retry and queue behavior.
const edits=[
  {
    "component": "client-diagnostics",
    "from": " function response(p){",
    "to": " // method/rpcIdHash use the same privacy descriptor as requested/received;\n // this records the actual outer invoke lane, not the descriptor's RPC kind.\n function ipcLane(p,lane,values={},clock){try{if(!['native_ws','other'].includes(lane))return;const request=trackedRequest(p);if(!request)return;event('transport',{...request.context,...values,component:lane==='native_ws'?'page-ws':'native-http',routeClass:lane,stage:lane==='native_ws'?'dispatch':'requested',reason:'preparation'},clock);}catch{}}\n function response(p){"
  },
  {
    "component": "client-diagnostics",
    "from": "ipc,handled,wire,response,invokeFailed",
    "to": "ipc,handled,wire,ipcLane,response,invokeFailed"
  },
  {
    "component": "runtime",
    "from": "function invokeGatewayOverWs(body) {",
    "to": "function invokeGatewayOverWs(body, dshPayload) {"
  },
  {
    "component": "runtime",
    "from": "const wsResponse = invokeGatewayOverWs(body);",
    "to": "const wsResponse = invokeGatewayOverWs(body, payload);"
  },
  {
    "component": "runtime",
    "from": "      );\n      return promise;\n    } catch (error) {\n      pendingGatewayIpc.delete(requestId);",
    "to": "      );\n      try { w.__DSH_CLIENT_LOG__?.ipcLane?.(dshPayload, \"native_ws\", { handshakeComplete: wsReady, socketState: requestSocket.readyState, connectionId: requestSocket.__dshDiagnosticId, enabled: w.__DSH_EXECUTION_METADATA_CONTROL_READY__?.() === true, generation: requestSocket.__dshFrontEpoch, revision: requestSocket.__dshNativeGeneration, nativeOnline: requestSocket.__dshNativeConnected === true }); } catch {}\n      return promise;\n    } catch (error) {\n      pendingGatewayIpc.delete(requestId);"
  },
  {
    "component": "runtime",
    "from": "            res = await w.fetch(\"/api/ipc/invoke\", {",
    "to": "            try { w.__DSH_CLIENT_LOG__?.ipcLane?.(payload, \"other\", { handshakeComplete: wsReady, socketState: ws?.readyState, enabled: w.__DSH_EXECUTION_METADATA_CONTROL_READY__?.() === true, count: pendingGatewayIpc.size, attempt: attempt + 1 }); } catch {}\n            res = await w.fetch(\"/api/ipc/invoke\", {"
  },
  {
    "component": "runtime",
    "from": "          markGatewayWsReady();\n          clientDiagnostic(\"ws-hello-ack\", {",
    "to": "          markGatewayWsReady();\n          try { w.__DSH_CLIENT_LOG__?.event?.(\"transport\", { method: \"initialize\", component: \"page-ws\", routeClass: \"native_ws\", stage: \"connected\", reason: \"native_ready\", handshakeComplete: wsReady, selected: msg.dshReplyProtocol === \"dsh-reply-stream-v1\", enabled: w.__DSH_EXECUTION_METADATA_CONTROL_READY__?.() === true, generation: msg.dshEpoch, revision: msg.dshNativeGeneration, nativeOnline: msg.dshNativeConnected === true, connectionId: socket.__dshDiagnosticId }); } catch {}\n          clientDiagnostic(\"ws-hello-ack\", {"
  }
];
function patch(source,component){for(const{from,to}of edits.filter(e=>e.component===component)){if(source.includes(to)){if(source.split(to).length!==2)throw Error('Duplicate IPC lane anchor');continue;}if(source.split(from).length!==2)throw Error('Pinned IPC lane ABI changed');source=source.replace(from,to);}return source;}
export const patchIpcLaneRuntime=source=>patch(source,'runtime');
export const patchIpcLaneDiagnostics=source=>patch(source,'client-diagnostics');
