#!/usr/bin/env python3
"""Copy an allow-listed workbench snapshot into a public tree.

The source tree is intentionally allow-listed. This script is a reproducible
scrub step, not a claim that an arbitrary private checkout is safe to publish.
"""

from __future__ import annotations

import argparse
import hashlib
import re
import shutil
from pathlib import Path


COPY_PLAN = (
    ("apps/native-codex-web", "apps/native-codex-web"),
    ("apps/sync-gateway", "apps/sync-gateway"),
    ("apps/official-ui-bridge", "apps/official-ui-bridge"),
    ("apps/android-client", "apps/android-client"),
    ("plugins/dsh-workbench-shell", "plugins/workbench-shell"),
    ("plugins/dsh-native-codex", "plugins/native-harness"),
    ("plugins/shared", "plugins/shared"),
)

EXCLUDED_NAMES = {".gradle", "build", "node_modules", "__pycache__", ".DS_Store"}

UUID = re.compile(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b")
PRIVATE_HOST = re.compile(r"https?://(?:[A-Za-z0-9-]+\.)+(?:internal|private|lan)(?::\d+)?")
PRIVATE_PATH = re.compile("/" + "Users" + r"/[^/\"'`\s)](?:[^\"'`\s)]*)?")

# Keep the public scrubber free of any workspace-specific names. When the
# source comes from a private checkout, pass its markers explicitly with one
# or more --replacement OLD=NEW arguments. This makes the script reusable
# without publishing the original owner's domains, paths, or project names.
PUBLIC_OVERRIDES = {
    "apps/android-client/README.md": """# Android client contract\n\nThe Android client keeps the native renderer in a WebView and uses a versioned, credential-free UI cache for startup and offline rendering.\n\nThe release manifest must contain an immutable version, a shell path, exact byte counts, lowercase SHA-256 values, and safe MIME types. The client activates a staged release only after every file verifies successfully; the previous release remains available as `lastgood`.\n\nThe WebView bridge is same-origin and top-frame-only. It exposes status, read-only cache reads, and explicit user-controlled sync start/stop. It does not carry cookies, provider tokens, account credentials, message bodies, or execution requests.\n\nReplace the placeholder origin, package signing, notification policy, and foreground-service policy with values appropriate to your deployment.\n""",
    "plugins/native-harness/README.md": """# Native Harness adapter\n\nThis directory is a reference adapter for a single native execution owner. It exposes a small HTTP and event surface to the workbench shell while keeping provider authentication and transport behind the adapter boundary.\n\nIt is not a provider connector and does not include credentials. Wire it to a host that you control, keep thread ownership checks in the adapter, and do not start a second executor for the same conversation.\n""",
    "plugins/workbench-shell/README.md": """# Workbench shell\n\nThe shell adds workspace navigation, project-scoped plugin entries, cache status, and offline-safe metadata around a native conversation renderer. It does not replace the renderer, copy credentials, or create a competing conversation store.\n\nHost-specific client packages are intentionally not bundled in this source snapshot. Provide them from the native host integration you choose, then review the route, service-worker, and authentication boundaries before deployment.\n""",
    "apps/native-codex-web/src/registry.mjs": """import path from 'node:path';
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
""",
    "apps/native-codex-web/src/plugins.mjs": """import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {fail,registeredSite} from './registry.mjs';

// Adapt a host's existing native plugins. The public shell does not recreate
// domain calculations or start another model/runtime.
const legacyWorkbench={name:'native-existing-workbench-adapter',inject:['nativeWorkbench'],apply(ctx,config){
 ctx.effect(()=>ctx.nativeWorkbench.register({id:'video',workspace:'ai',label:'Video workbench',description:'Project media and review status',readOnly:false,async load(){return {kind:'link',label:'Video workbench',description:'Project-owned media and review data',url:new URL('/video-workbench?workspace=ai',registeredSite().url).href};}}));
 const definitions=[['portfolio','Portfolio','Project-owned portfolio summary','/modules/portfolio'],['quant','Research','Research and simulation summary','/modules/quant'],['agenda','Agenda','Project tasks and reminders','/modules/agenda'],['cockpit','Overview','Workspace overview and signals','/cockpit']];
 for(const [id,label,description,route]of definitions)ctx.effect(()=>ctx.nativeWorkbench.register({id,workspace:'ai',label,description,readOnly:true,async load(){const response=await fetch(config.origin+'/api/better-codex-workbench'+route,{signal:AbortSignal.timeout(10000)});if(!response.ok)throw fail(503,label+' is unavailable');return {kind:id,snapshot:await response.json()};}}));
}};

export class Plugins {
 constructor({legacyOrigin='http://127.0.0.1:3081'}={}){this.legacyOrigin=legacyOrigin;this.instances=new Map();this.contexts=[];}
 async start(){const packagePath=process.env.BETTER_CODEX_NATIVE_PACKAGE || '${BETTER_CODEX_HOME}/.better-codex/native-runtime/package.json';const req=createRequire(realpathSync(packagePath));const {Context}=await import(req.resolve('@native-ai/cordis'));
  const ws='ai',ctx=new Context();ctx.provide('nativeWorkbench',{register:entry=>{if(entry.workspace!==ws)throw fail(403,'plugin workspace mismatch');const key=ws+':'+entry.id;this.instances.set(key,entry);return()=>this.instances.delete(key);}});ctx.plugin(legacyWorkbench,{origin:this.legacyOrigin});this.contexts.push(ctx);await new Promise(resolve=>setImmediate(resolve));
 }
 list(ws){return[...this.instances.values()].filter(p=>p.workspace===ws.id&&ws.plugins.includes(p.id)).map(({load,...p})=>p);}
 async load(ws,id){if(!ws.plugins.includes(id))throw fail(404,'plugin is not enabled in this workspace');const p=this.instances.get(ws.id+':'+id);if(!p)throw fail(503,'plugin is not ready');return p.load();}
 async close(){await Promise.all(this.contexts.map(c=>c.fiber.dispose()));}
}
""",
    "plugins/shared/workbench-snapshot.mjs": """function combineStatuses(parts) {
 const statuses=parts.map(part=>part?.status);if(statuses.every(status=>status==='unavailable'))return 'unavailable';if(statuses.includes('unavailable'))return 'partial';if(statuses.includes('stale'))return 'stale';return 'ok';
}
function unavailable(schema,reason='adapter_not_configured'){return {schema,status:'unavailable',generatedAt:new Date().toISOString(),reason};}
export async function execute(modules={}){
 const entries=[['activeInvesting','portfolio','better-codex-workbench.invest-portfolio.v2'],['quant','quant','better-codex-workbench.invest-quant.v2'],['agenda','agenda','better-codex-workbench.mentor-agenda.v1']];
 const values=await Promise.all(entries.map(async([,key,schema])=>{const loader=modules[key];if(typeof loader!=='function')return unavailable(schema);try{return await loader();}catch(error){return {...unavailable(schema,'module_read_failed'),message:String(error?.message||error).slice(0,240)};}}));
 const [portfolio,quant,agenda]=values;return {schema:'better-codex-workbench.snapshot.v2',status:combineStatuses(values),generatedAt:new Date().toISOString(),modules:{activeInvesting:portfolio,quant,agenda},boundaries:{readOnly:true,credentialsIncluded:false,commandsIncluded:false,tradeActionsIncluded:false,liveTradingEnabled:false}};
}
""",
}


def ignore(_directory: str, names: list[str]) -> set[str]:
    return {name for name in names if name in EXCLUDED_NAMES}


def parse_replacements(values: list[str]) -> tuple[tuple[str, str], ...]:
    replacements: list[tuple[str, str]] = []
    for value in values:
        if "=" not in value:
            raise SystemExit(f"replacement must be OLD=NEW: {value!r}")
        old, new = value.split("=", 1)
        if not old:
            raise SystemExit("replacement OLD must not be empty")
        replacements.append((old, new))
    return tuple(replacements)


def parse_regex_replacements(values: list[str]) -> tuple[tuple[re.Pattern[str], str], ...]:
    replacements: list[tuple[re.Pattern[str], str]] = []
    for value in values:
        if "=" not in value:
            raise SystemExit(f"regex replacement must be PATTERN=NEW: {value!r}")
        pattern, new = value.rsplit("=", 1)
        if not pattern:
            raise SystemExit("regex replacement PATTERN must not be empty")
        replacements.append((re.compile(pattern), new))
    return tuple(replacements)


def scrub(text: str, replacements: tuple[tuple[str, str], ...], regex_replacements: tuple[tuple[re.Pattern[str], str], ...] = ()) -> str:
    for old, new in replacements:
        text = text.replace(old, new)
    for pattern, new in regex_replacements:
        text = pattern.sub(new, text)
    text = PRIVATE_HOST.sub("http://localhost:3080", text)
    text = PRIVATE_PATH.sub("${BETTER_CODEX_HOME}", text)
    text = UUID.sub(lambda match: "00000000-0000-4000-8000-" + hashlib.sha256(match.group(0).encode()).hexdigest()[:12], text)
    users_prefix = "/" + "Users" + "/"
    text = text.replace("'" + users_prefix + "'", "'/'+'Users'+'/'")
    text = text.replace('"' + users_prefix + '"', "'/'+'Users'+'/'")
    return text


def is_text_file(path: Path) -> bool:
    if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".apk", ".aab"}:
        return False
    try:
        path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return False
    return True


def scrub_tree(root: Path, replacements: tuple[tuple[str, str], ...], regex_replacements: tuple[tuple[re.Pattern[str], str], ...]) -> None:
    for path in root.rglob("*"):
        if path.is_file() and is_text_file(path):
            path.write_text(scrub(path.read_text(encoding="utf-8"), replacements, regex_replacements), encoding="utf-8")


def write_public_overrides(destination: Path, replacements: tuple[tuple[str, str], ...], regex_replacements: tuple[tuple[re.Pattern[str], str], ...]) -> None:
    for relative, content in PUBLIC_OVERRIDES.items():
        target = destination / relative
        if target.exists():
            target.write_text(scrub(content, replacements, regex_replacements), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument(
        "--replacement",
        action="append",
        default=[],
        metavar="OLD=NEW",
        help="replace a private marker before generic path/UUID scrubbing; repeatable",
    )
    parser.add_argument(
        "--regex-replacement",
        action="append",
        default=[],
        metavar="PATTERN=NEW",
        help="regex replacement for names that must not match inside ordinary words; repeatable",
    )
    args = parser.parse_args()

    source = args.source.expanduser().resolve()
    destination = args.destination.expanduser().resolve()
    if not source.is_dir():
        raise SystemExit(f"source directory does not exist: {source}")
    destination.mkdir(parents=True, exist_ok=True)

    for source_rel, destination_rel in COPY_PLAN:
        from_path = source / source_rel
        to_path = destination / destination_rel
        if not from_path.exists():
            raise SystemExit(f"allow-listed source is missing: {from_path}")
        if to_path.exists():
            shutil.rmtree(to_path)
        shutil.copytree(from_path, to_path, ignore=ignore)

    replacements = parse_replacements(args.replacement)
    regex_replacements = parse_regex_replacements(args.regex_replacement)
    scrub_tree(destination, replacements, regex_replacements)
    write_public_overrides(destination, replacements, regex_replacements)
    print(f"prepared {len(COPY_PLAN)} allow-listed source trees at {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
