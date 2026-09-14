import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';

// Test browser interaction logic without starting a browser/profile or a real job.
test('grouped catalog, chronological version navigation, output switching and prompt comparison share one reviewer',async()=>{
 const html=await readFile(new URL('../public/video-workbench.html',import.meta.url),'utf8');
 const source=await readFile(new URL('../public/video-workbench.js',import.meta.url),'utf8');
 class Element{
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.attrs={};this.value='';this.hidden=false;this.open=false;this.isConnected=true;this.classList={toggle(){}};}
  append(...els){this.children.push(...els);}prepend(x){this.children.unshift(x);}replaceChildren(...els){this.children=[...els];}
  add(x){this.append(x);if(!this.value)this.value=x.value;}setAttribute(k,v){this.attrs[k]=v;}getAttribute(k){return this.attrs[k];}removeAttribute(k){delete this.attrs[k];}
  addEventListener(){}pause(){}load(){}showModal(){this.open=true;}close(){this.open=false;}querySelector(){return null;}remove(){this.isConnected=false;}
 }
 class Option extends Element{constructor(text,value){super('option');this.textContent=text;this.value=value;}}
 const nodes=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],new Element()]));
 for(const [id,value]of [['view-mode','groups'],['sort-order','newest'],['version-order','oldest']])nodes.get(id).value=value;
 const el=id=>nodes.get(id),requests=[],id1='1'.repeat(24),id2='2'.repeat(24),id3='3'.repeat(24),groupId='a'.repeat(24);
 const f=(id,ordinal)=>({id,revision:id,groupId,versionId:'v'+ordinal,versionOrdinal:ordinal,title:'镜头 S02',productionTitle:'作品',category:'material',lane:'H3',fileName:id+'.mp4',updatedAt:'2026-09-01T10:00:00Z',generatedAt:'2026-09-0'+ordinal+'T10:00:00Z',humanVerdict:'UNREVIEWED',status:'GENERATED',bytes:2048});
 const a=f(id1,1),b=f(id2,2),c=f(id3,2),files=[a,b,c];
 const comparison={beforeAssetId:id1,afterAssetId:id2,parameters:[{key:'seed',before:1,after:2}],prompt:{changed:true,prefix:'同一人物',removed:'微笑',added:'迟疑',suffix:''},summary:'Prompt 内容有变化'};
 const group={id:groupId,title:'S02',groupingConfidence:'inferred',versionCount:2,fileCount:3,versions:[{id:'v1',ordinal:1,label:'take-v1',generatedAt:a.generatedAt,timeSource:'result#finished_at',files:[a],representativeId:a.id},{id:'v2',ordinal:2,label:'take-v2',generatedAt:b.generatedAt,timeSource:'result#finished_at',files:[b,c],representativeId:b.id}]};
 group.visualGrouping=true;group.storyUsageCount=2;group.versions[0].dialogues=['开场台词'];group.versions[0].storyUsages=[{shot_id:'opening',title:'开场'}];group.versions[1].dialogues=['结尾台词'];group.versions[1].storyUsages=[{shot_id:'ending',title:'结尾'}];
 const data={items:[{...b,title:'S02',versionCount:2,fileCount:3}],counts:{material:3,workprint:0,export:0},groupCounts:{material:1,films:0},productions:[],total:1,matchedFiles:3,view:'groups',nextOffset:null,jobs:[]};
 const location={href:'http://localhost:3080/video-workbench?workspace=ai',origin:'http://localhost:3080'};
 const context={URL,URLSearchParams,Option,console,crypto:{randomUUID:()=> '0'.repeat(36)},navigator:{onLine:true},location,
  history:{state:{},length:1,replaceState(s,_,url){this.state=s;location.href=String(url);},pushState(s,_,url){this.state=s;location.href=String(url);},back(){}},
  document:{referrer:'',visibilityState:'visible',getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag),createTextNode:text=>text,querySelectorAll:()=>[],addEventListener(){}},
  setInterval(){},setTimeout(){return 1;},clearTimeout(){},addEventListener(){},confirm:()=>true,
  fetch:async(url,opts={})=>{requests.push(url);let value;
   if(url==='/api/context')value={token:'TEST'};
   else if(url.includes('/catalog?'))value=data;
   else if(url.endsWith('/telemetry'))value={status:'unavailable',queues:[],history:[]};
   else if(url.includes('/groups/'))value=group;
   else if(url.includes('/compare?'))value=comparison;
   else if(url.endsWith('/ticket')){const id=url.split('/').at(-2);value={revision:id,videoUrl:'/media/'+id,downloadUrl:'/download/'+id,expiresAt:Date.now()+3600000};}
   else{const id=url.split('/').at(-1),item=files.find(f=>f.id===id);assert(item);value={...item,mediaSha256:'f'.repeat(64),durationSeconds:2,lineage:{prompts:[{name:'Prompt',text:'真实快照 '+id,source:'prepared/01-conditioning.json'}],parameters:{}},comparison:item.versionOrdinal===2?comparison:null};}
   return {ok:true,status:200,json:async()=>value};
  },IntersectionObserver:class{observe(){}unobserve(){}disconnect(){}}};context.window=context;
 vm.runInNewContext(source,context);
 const drain=async()=>{for(let i=0;i<15;i++)await new Promise(r=>setImmediate(r));};await drain();
 assert(requests.some(r=>r.includes('view=groups')));assert.equal(el('grid').children.length,1);assert.match(el('list-status').textContent,/1 个片段组/);
 el('grid').children[0].onclick();await drain();assert.equal(el('version-list').children.length,2);assert.match(el('version-note').textContent,/同一视觉分镜/);assert(el('version-list').children[0].children.some(c=>c.textContent==='台词：开场台词'));assert(el('version-list').children[1].children.some(c=>c.textContent==='用途：结尾'));assert.equal(el('rendition-select').children.length,2);
 assert.equal(el('player').src,'/media/'+id2);assert.equal(el('compare-version').value,id1);assert(el('prompt-evidence').children.length>0);
 el('version-list').children[0].onclick();await drain();assert.equal(el('player').src,'/media/'+id1);assert.equal(el('rendition-select').children.length,1);assert.equal(el('version-list').children[0].attrs['aria-current'],'true');
 el('version-order').value='newest';el('version-order').onchange();assert.equal(el('version-list').children[0].children[0].textContent,'版本 2');
 el('version-list').children[0].onclick();await drain();el('rendition-select').value=id3;el('rendition-select').onchange();await drain();assert.equal(el('player').src,'/media/'+id3);
 el('compare-version').value=id1;await el('compare-version').onchange();await drain();assert(requests.some(r=>r.includes('/assets/'+id3+'/compare?with='+id1)));assert.equal(el('comparison').children[0].textContent,'Prompt 内容有变化');
 assert.equal(requests.filter(r=>r.includes('/feedback')||r.includes('/submit')).length,0);
});
