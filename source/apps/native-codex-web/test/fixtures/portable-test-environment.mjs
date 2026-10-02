// Test-only environment; no real account, process or Native connection is opened.
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const testPackage=fileURLToPath(new URL('../../../../../packages/host-cli/package.json',import.meta.url));
if(!process.env.WORKBENCH_CONFIG&&existsSync(testPackage)){
 const dir=mkdtempSync(path.join(tmpdir(),'better-codex-fixture-'));
 for(const name of ['primary','secondary'])mkdirSync(path.join(dir,name));
 const dependencyPackage=fileURLToPath(new URL('../../../../../packages/host-cli/package.json',import.meta.url));
 const file=path.join(dir,'deployment.json');writeFileSync(file,JSON.stringify({schema:'workbench.deployment.v1',stateDir:path.join(dir,'state'),relayBinary:path.join(dir,'unused-relay'),dependencyPackage,native:{rpcUrl:'ws://127.0.0.1:4175',webOrigin:'http://127.0.0.1:4174',hostPackage:dependencyPackage,codexHome:path.join(dir,'unused-account')},workspaces:{ai:{label:'Primary',root:path.join(dir,'primary')},zyy:{label:'Secondary',root:path.join(dir,'secondary')}}}));
 process.env.WORKBENCH_CONFIG=file;process.once('exit',()=>rmSync(dir,{recursive:true,force:true}));
}
