// Thin product adapter: domain interpretation remains in the owning project.
import {projectCatalog,projectDetails} from '${BETTER_CODEX_WORKSPACE}/agent/runtime/lib/projects.mjs';
export async function projectData(scope,id){
 if(!id)return projectCatalog(scope);
 const project=await projectDetails(scope,id);
 if(scope==='ai'&&id==='invest'){const {execute}=await import('${BETTER_CODEX_WORKSPACE}/Invest/adapters/workbench-portfolio.mjs');project.data=await execute();}
 if(scope==='ai'&&id==='comfyui-video'){const {materialDeskSummary}=await import('${BETTER_CODEX_WORKSPACE}/VideoWorkbench/adapters/workbench-material-desk.mjs');project.data={materialDesk:await materialDeskSummary()};}
 if(scope==='secondary'&&id==='secondary-project'){const {secondarySummary}=await import('${BETTER_CODEX_SECONDARY_WORKSPACE}/SecondaryProject/adapters/workbench.mjs');project.data=await secondarySummary();}
 return project;
}

export async function projectMaterialFeedback(scope,id,payload){
 if(scope!=='ai'||id!=='comfyui-video')throw Object.assign(new Error('此项目没有素材台反馈接口'),{code:404});
 const {submitMaterialFeedback}=await import('${BETTER_CODEX_WORKSPACE}/VideoWorkbench/adapters/workbench-material-desk.mjs');
 return submitMaterialFeedback(payload);
}
