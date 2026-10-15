import path from 'node:path';
import {lstat, realpath, stat} from 'node:fs/promises';

// Native can name an output directory before the first turn creates it.
// Check ownership and existing ancestors without creating anything.
export async function ownedVisualizationRootAllowed(root, codexHome, threadId) {
 if(typeof root!=='string'||typeof codexHome!=='string'||!path.isAbsolute(root)||!path.isAbsolute(codexHome)||typeof threadId!=='string')return false;
 const home=path.resolve(codexHome),base=path.join(home,'visualizations');
 if(!root.startsWith(base+path.sep))return false;
 const match=root.slice(base.length+1).match(/^(\d{4}\/\d{2}\/\d{2})\/([0-9a-f-]{36})(?:\/|$)/i);
 if(match?.[2]!==threadId)return false;
 if(root.split(path.sep).some(part=>part==='.'||part==='..'))return false;
 try {
  const homeReal=await realpath(home);
  if(!(await stat(homeReal)).isDirectory())return false;
  let baseReal;
  try {baseReal=await realpath(base);}
  catch(error){
   if(error.code!=='ENOENT')return false;
   // A dangling base symlink is not an absent directory.
   try {await lstat(base);return false;}catch(missing){if(missing.code!=='ENOENT')return false;}
   baseReal=path.join(homeReal,'visualizations');
  }
  const expected=path.join(baseReal,match[1],threadId);
  try {
   const actual=await realpath(root);
   return (actual===expected||actual.startsWith(expected+path.sep))&&(await stat(actual)).isDirectory();
  }catch(error){if(error.code!=='ENOENT')return false;}
  const target=path.resolve(root),owner=path.join(base,match[1],threadId);
  if(target!==owner&&!target.startsWith(owner+path.sep))return false;
  let ancestor=target;
  while(ancestor===home||ancestor.startsWith(home+path.sep)){
   let exists=false;
   try {
    await lstat(ancestor);exists=true;
    const actual=await realpath(ancestor);
    const required=ancestor===home?homeReal:path.join(baseReal,path.relative(base,ancestor));
    return actual===required&&(await stat(actual)).isDirectory();
   }catch(error){
    if(exists||error.code!=='ENOENT')return false;
    if(ancestor===home)return false;
    ancestor=path.dirname(ancestor);
   }
  }
 }catch{}
 return false;
}
