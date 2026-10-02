#!/usr/bin/env python3
"""Export only the portable core dependency closure; never copy private state."""
import argparse,hashlib,json,re,shutil
from pathlib import Path
ROOTS=['portable-host.mjs','official-front.mjs','sync-adapter.mjs']
PRIVATE={'private-deployment.mjs','private-project-data.mjs'}
PUBLIC=['client-diagnostics.js','native-theme-color.js','native-android-ui.js','native-startup-preview.js','page-navigation-diagnostics.js','native-navigation.js','native-preview-navigation.js','native-status-recovery.js','native-local-cache.js','native-reading-position.js','native-queue-client.js','native-sidebar-page.js','portable-workbench-plugins.js','native-pwa-preferences.js','mobile-focus.js','client-performance.js','embedded-conversation.js','official-scope-bootstrap.js','official-pwa.js','official-pwa.css','native-loader.js','official-service-worker.js','official-offline.html','projects.html','portable-projects.js','portable-icon.svg','projects.css']

def main():
 p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--destination',type=Path,required=True);p.add_argument('--replacement',action='append',default=[]);args=p.parse_args()
 src=args.source.resolve();dst=args.destination.resolve()
 if dst==src or dst==src/'apps':raise SystemExit('Export must use a separate destination')
 if dst.exists():raise SystemExit('Destination exists; export to a new staging directory')
 replacements=[]
 for item in args.replacement:
  before,after=item.split('=',1)
  if not before:raise SystemExit('Empty replacement')
  replacements.append((before,after))
 selected=set();todo=list(ROOTS);modules=src/'apps/native-codex-web/src'
 while todo:
  name=todo.pop()
  if name in selected or name in PRIVATE:continue
  if '/' in name or not (modules/name).is_file():raise SystemExit('Unresolved portable dependency: '+name)
  selected.add(name);text=(modules/name).read_text()
  todo.extend(re.findall(r"['\"]\./([^'\"]+\.mjs)['\"]",text))
 files=[('apps/native-codex-web/src/'+name) for name in sorted(selected)]+['apps/native-codex-web/public/'+name for name in PUBLIC]
 files += ['apps/native-codex-web/public/shell/'+name for name in ['home.html','home.mjs','home.css','read-cache.mjs','conversation-shell.mjs']]
 files += ['apps/native-codex-web/test/fixtures/'+name for name in ['source-page-producer.mjs','source-metadata-producer.mjs','portable-test-environment.mjs']]
 files += ['apps/sync-gateway/public/'+file.name for file in (src/'apps/sync-gateway/public').iterdir() if file.is_file()]
 files += ['apps/sync-gateway/'+file.name for file in (src/'apps/sync-gateway').iterdir() if file.is_file() and (file.suffix=='.go' or file.name in ['go.mod','go.sum'])]
 manifest={}
 for name in sorted(files):
  data=(src/name).read_text()
  for before,after in replacements:data=data.replace(before,after)
  # Public scope labels are never personal identities. Configured labels win.
  data=data.replace('<option value="ai">AI 工作区</option><option value="zyy">ZYY 工作区</option>','<option value="ai">Workspace</option>').replace('<option value="ai">AI</option><option value="zyy">ZYY</option>','<option value="ai">Workspace</option>')
  data=data.replace("['ai','AI 工作区'],['zyy','ZYY 工作区']","['ai','Workspace']")
  data=re.sub(r"\['ai','[^']+'\],\['zyy','[^']+'\]", "['ai','Workspace']", data)
  data=re.sub(r"id==='ai'\?'[^']+':'[^']+'", "'Workspace'", data)
  data=data.replace('/'+'Users'+'/PRIVATE_PATH/','/workspace/redacted/').replace('/'+'Users'+'/private/','/workspace/redacted/')
  data=data.replace("'/"+'Users'+"/'","'/'+'Users'+'/'")
  target=dst/name;target.parent.mkdir(parents=True,exist_ok=True);target.write_text(data)
  manifest[name]=hashlib.sha256(data.encode()).hexdigest()
 (dst/'export-manifest.json').write_text(json.dumps({'schema':1,'entrypoints':ROOTS,'files':manifest},indent=2)+'\n')
 print(json.dumps({'modules':len(selected),'files':len(files),'privateDeploymentIncluded':False}))
if __name__=='__main__':main()
