import { realpath } from 'node:fs/promises';
import { relative,isAbsolute } from 'node:path';
export const WORKSPACES=Object.freeze({
  ai:{id:'ai',label:'AI 工作区',root:'${BETTER_CODEX_WORKSPACE}',plugins:[{id:'project',title:'Project OS',url:'http://localhost:3080/',description:'项目与行动 · 只读摘要'},{id:'mentor',title:'Mentor',url:'http://localhost:3080/'},{id:'portfolio',title:'主动投资',url:'http://localhost:3080/'},{id:'quant',title:'量化研究',url:'http://localhost:3080/'}]},
  secondary:{id:'secondary',label:'SECONDARY 创作工作区',root:'${BETTER_CODEX_SECONDARY_WORKSPACE}',plugins:[{id:'secondary',title:'SecondaryProject 私密书架',url:'http://localhost:3080/',description:'沿用书架原认证与内容密钥'}]}
});
export function fail(code,status=400){throw Object.assign(new Error(code),{code,status})}
export function workspace(id){return WORKSPACES[id]||fail('workspace_not_found',404)}
export async function belongs(root,path){try{const [r,p]=await Promise.all([realpath(root),realpath(path)]);const d=relative(r,p);return d===''||(!d.startsWith('..'+ '/')&&d!=='..'&&!isAbsolute(d))}catch{return false}}
export async function workspaceFor(path){for(const w of Object.values(WORKSPACES))if(await belongs(w.root,path))return w.id;return null}
