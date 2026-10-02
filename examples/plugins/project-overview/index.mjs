import {readdir} from 'node:fs/promises';
export async function read({workspace}) {
  // The project owns its files; this plugin returns only a bounded read view.
  const entries=await readdir(workspace.root,{withFileTypes:true});
  return {summary:workspace.label,updatedAt:new Date().toISOString(),sections:[{title:'Projects',items:entries.filter(entry=>entry.isDirectory()&&!entry.name.startsWith('.')).slice(0,100).map(entry=>entry.name)}]};
}
