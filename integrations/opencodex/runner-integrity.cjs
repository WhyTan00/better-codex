// SPDX-License-Identifier: AGPL-3.0-only
// 只更新本地生成宿主的完整性摘要；不关闭校验，不修改已安装的官方应用。
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const sentinel=Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A');
function refreshRunnerIntegrity(runnerAppPath){
 const app=fs.realpathSync(runnerAppPath),contents=path.join(app,'Contents');
 const info=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(contents,'Info.plist')],{encoding:'utf8'}));
 const hash=crypto.createHash('sha256');
 for(const key of Object.keys(info.ElectronAsarIntegrity||{}).sort()){
  const item=info.ElectronAsarIntegrity[key];if(item.algorithm!=='SHA256'||!/^[0-9a-f]{64}$/.test(item.hash))throw Error('Invalid runner ASAR integrity');
  hash.update(key).update(item.algorithm).update(item.hash);
 }
 const digest=hash.digest(),frameworks=path.join(contents,'Frameworks');let changed=0;
 for(const name of fs.readdirSync(frameworks).filter(name=>name.endsWith('.framework'))){
  const framework=path.join(frameworks,name),binary=path.join(framework,name.slice(0,-10));
  if(!fs.existsSync(binary))continue;const file=fs.realpathSync(binary);if(!file.startsWith(contents+path.sep))throw Error('Runner framework escaped its own bundle');
  const bytes=fs.readFileSync(file);let start=0,found=false;
  while(true){const index=bytes.indexOf(sentinel,start);if(index<0)break;start=index+sentinel.length;
   if(index+66>bytes.length||bytes[index+33]!==1&&bytes[index+32]!==0)throw Error('Unsupported Electron integrity digest');
   // 未启用摘要的旧框架保持原状；已启用的摘要更新为本次生成的plist，并保持启用。
   if(bytes[index+32]===1){digest.copy(bytes,index+34);found=true;}
  }
  if(found){fs.writeFileSync(file,bytes);
   // 本地开发副本采用 ad-hoc 签名且保留 entitlements；无发行者 Team ID 的副本不能沿用发行版 hardened-runtime 标志。
   const helpers=path.join(path.dirname(file),'Helpers');
   if(fs.existsSync(helpers))for(const helper of fs.readdirSync(helpers).filter(name=>name.endsWith('.app'))){
    const target=fs.realpathSync(path.join(helpers,helper));if(!target.startsWith(contents+path.sep))throw Error('Runner helper escaped its own bundle');
    execFileSync('/usr/bin/codesign',['--force','--sign','-','--options','0','--preserve-metadata=entitlements,requirements',target],{stdio:['ignore','ignore','pipe']});
   }
   execFileSync('/usr/bin/codesign',['--force','--sign','-','--options','0','--preserve-metadata=entitlements,requirements',framework],{stdio:['ignore','ignore','pipe']});changed++;}
 }
 return changed;
}
module.exports={refreshRunnerIntegrity};
