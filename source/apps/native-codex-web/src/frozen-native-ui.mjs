import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Both the cloud assets and the front entry use this exact accepted package.
// A release must never regenerate its entry from an older source tree.
export async function frozenNativeUI(directory=new URL('../public/accepted-native-ui/',import.meta.url)){
 const root=typeof directory==='string'?path.resolve(directory):fileURLToPath(directory);
 let raw;try{raw=await readFile(path.join(root,'package.json'),'utf8');}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const pkg=JSON.parse(raw),content=new Map();
 if(!/^[a-f0-9]{16}$/.test(pkg.version))throw Error('Invalid frozen UI version');
 for(const [name,expected] of Object.entries(pkg.files)){
  const file=path.resolve(root,name);if(!file.startsWith(root.replace(/\/$/,'')+path.sep))throw Error('Invalid frozen UI path');
  const bytes=await readFile(file);if(createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Frozen UI bytes changed: '+name);
  content.set(name,bytes.toString('utf8'));
 }
 const manifest=JSON.parse(content.get('native-ui/manifest.json'));
 if(manifest.version!==pkg.version||manifest.base!=='/dsh-native-assets/'+pkg.version+'/')throw Error('Frozen UI manifest mismatch');
 const files=new Map();
 for(const [name,text] of content){
  if(name.startsWith('native-ui/'+pkg.version+'/'))files.set(manifest.base+name.split('/').at(-1),text);
  const asset=name.match(/^native-assets\/(v\d+)\/([^/]+)$/);if(asset)files.set('/official-patched-'+asset[1]+'/assets/'+asset[2],text);
 }
 for(const key of ['scope','runtime','pwa','css','loader','shell','initial'])if(!files.has(manifest[key]))throw Error('Frozen UI missing '+key);
 return {manifest,files,worker:content.get('native-ui/worker.js')};
}
