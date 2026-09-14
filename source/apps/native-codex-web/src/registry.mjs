import path from 'node:path';
import {realpath} from 'node:fs/promises';

const primaryRoot = path.resolve(process.env.BETTER_CODEX_WORKSPACE || process.cwd());
const secondaryRoot = path.resolve(process.env.BETTER_CODEX_SECONDARY_WORKSPACE || path.join(primaryRoot, 'secondary'));

// Public defaults only. A deployment can replace this module with its own
// workspace registry after reviewing roots, plugins, and authentication.
export const WORKSPACES = Object.freeze({
  ai: Object.freeze({id:'ai',label:'AI workspace',root:primaryRoot,plugins:['video','portfolio','quant','agenda','cockpit']}),
  secondary: Object.freeze({id:'secondary',label:'Secondary workspace',root:secondaryRoot,plugins:[]})
});

export function fail(code, message) { return Object.assign(new Error(message), {code}); }
export function workspace(id) {
  if (!Object.hasOwn(WORKSPACES, id)) throw fail(403, 'workspace is not available');
  return WORKSPACES[id];
}
export async function belongs(candidate, ws) {
  if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) return false;
  try {
    const [actual, root] = await Promise.all([realpath(candidate), realpath(ws.root)]);
    return actual === root || actual.startsWith(root + path.sep);
  } catch { return false; }
}
export function validateId(id) {
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) throw fail(404, 'thread is not available');
  return id;
}
export function publicThread(thread) {
  const {path: _path, turns: _turns, ...publicValue} = thread;
  return publicValue;
}
export function registeredSite(id = 'better-codex') {
  return {id, label:'Better Codex', url:process.env.BETTER_CODEX_PUBLIC_ORIGIN || 'http://localhost:3080', status:'local', accessModel:'local'};
}
