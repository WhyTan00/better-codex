// Private domains remain adapters; portable navigation comes from the selected
// installation's project bindings, without a second project database.
import path from 'node:path';
import {portableConfig} from './runtime-profile.mjs';
import {workspace,belongs,fail} from './registry.mjs';
const privateAdapter=portableConfig?null:await import('./private-project-data.mjs');
export async function projectData(scope,id){
 if(privateAdapter)return privateAdapter.projectData(scope,id);
 const ws=workspace(scope),projects=[];
 for(const binding of ws.projectBindings){const root=path.resolve(ws.root,binding.root);if(await belongs(root,ws))projects.push({id:binding.id,name:binding.name,root,lifecycle:'active',surfaces:[]});}
 if(!id)return {schema:'agent-project-catalog.v1',scope,generatedAt:new Date().toISOString(),status:'ok',sources:[],projects};
 const project=projects.find(project=>project.id===id);if(!project)throw fail(404,'Project is not available in this workspace');
 return {...project,scope,navigation:[],actions:[],stateCounts:{},sources:[],boundaries:{readOnly:true,projectOwnsFacts:true}};
}
export async function projectMaterialFeedback(scope,id,payload){
 if(privateAdapter)return privateAdapter.projectMaterialFeedback(scope,id,payload);
 throw fail(404,'Project action is not configured');
}
