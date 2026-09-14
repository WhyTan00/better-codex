import {fail} from './registry.mjs';

export function secondaryWorkbenchFrame(u,req,res){
  if(u.pathname!=='/secondary-workbench-frame')return false;
  if(req.method!=='GET'||u.searchParams.get('workspace')!=='secondary')throw fail(403,'书架仅属于 SECONDARY 工作区');
  // Empty same-origin frame only. All data requires the scoped API capability.
  // Its own CSP permits the existing authenticated library's inline renderer,
  // without relaxing the official main application's CSP or allowing top exits.
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
   'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'"});
  res.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body data-secondary-frame="ready"><script>window.__BETTER_CODEX_MOUNT_LIBRARY__=function(html,context){document.open();window.__BETTER_CODEX_FICTION_CONTEXT__=context;document.write(html);document.close();};</script></body></html>');return true;
}

export async function secondaryWorkbenchApi(ws, op, req, res) {
  if (!op.startsWith('secondary/')) return false;
  if (ws.id !== 'secondary' || !ws.plugins.includes('secondary')) throw fail(403, '书架仅属于 SECONDARY 工作区');
  const operation = op === 'secondary/bootstrap' && req.method === 'GET' ? 'bootstrap'
    : op === 'secondary/state' && req.method === 'GET' ? 'state'
    : op === 'secondary/state' && req.method === 'POST' ? 'save' : null;
  if (!operation) throw fail(404, '书架接口不存在');
  let payload;
  if (operation === 'save') {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail(415, '需要加密状态');
    let bytes = 0; const parts = [];
    for await (const chunk of req) {bytes += chunk.length; if (bytes > 2 * 1024 * 1024) throw fail(413, '保存内容过大'); parts.push(chunk);}
    try {payload = JSON.parse(Buffer.concat(parts).toString());} catch {throw fail(400, '保存格式无效');}
    if (!Number.isSafeInteger(payload.expected_revision) || payload.expected_revision < 0 ||
        !payload.cipher || typeof payload.cipher.nonce !== 'string' || typeof payload.cipher.ciphertext !== 'string' ||
        Object.keys(payload).some(k => !['expected_revision','cipher'].includes(k)) ||
        Object.keys(payload.cipher).some(k => !['nonce','ciphertext'].includes(k))) throw fail(400, '只接受加密状态');
  }
  const {libraryOperation} = await import('${BETTER_CODEX_SECONDARY_WORKSPACE}/SecondaryProject/adapters/workbench-library.mjs');
  const result = await libraryOperation(operation, payload);
  const status = Number.isInteger(result.status) && result.status >= 200 && result.status <= 599 ? result.status : 503;
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store, private', 'pragma': 'no-cache'});
  res.end(JSON.stringify(result.value || {error: result.error || '书架暂不可用'}));
  return true;
}
