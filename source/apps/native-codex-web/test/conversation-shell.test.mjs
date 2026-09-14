import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {conversationPath} from '../public/shell/conversation-shell.mjs';
const id='01a080ae-9794-79a0-98de-d78a766f2457',origin='https://private.example';
test('shell only admits same-origin, explicit same-workspace conversation routes',()=>{
 assert.equal(conversationPath('/local/'+id+'?workspace=ai',origin,'ai'),'/local/'+id);
 assert.equal(conversationPath('/?workspace=ai&view=chat',origin,'ai'),'/');
 for(const value of ['https://other.example/local/'+id+'?workspace=ai','/local/'+id+'?workspace=secondary','/local/'+id,'/workbench?workspace=ai','javascript:alert(1)'])assert.equal(conversationPath(value,origin,'ai'),null);
});
test('embedded renderer rejects foreign windows, origins, scopes and arbitrary routes',async()=>{
 const handlers={},sent=[],navigated=[],reset=[];const parent={postMessage:m=>sent.push(m)},window={parent,__BETTER_CODEX_SCOPE__:{id:'ai'},__BETTER_CODEX_FOCUS_POLICY__:{reset:x=>reset.push(x)},postMessage:m=>navigated.push(m)},document={addEventListener(){},activeElement:{blur(){}}};
 vm.runInNewContext(await readFile(new URL('../public/embedded-conversation.js',import.meta.url),'utf8'),{window,parent,document,URL,location:{origin,href:origin+'/local/'+id+'?workspace=ai&betterCodexEmbedded=1'},addEventListener:(k,fn)=>handlers[k]=fn});
 const good={source:parent,origin,data:{type:'betterCodex-shell-open',scope:'ai',path:'/local/'+id}};
 for(const bad of [{...good,source:{}},{...good,origin:'https://other.example'},{...good,data:{...good.data,scope:'secondary'}},{...good,data:{...good.data,path:'/settings'}},{...good,data:{...good.data,type:'turn/start'}}])handlers.message(bad);
 assert.equal(navigated.length,0);handlers.message(good);assert.deepEqual(JSON.parse(JSON.stringify(navigated)),[{type:'navigate-to-route',path:'/local/'+id}]);
 handlers.message({...good,data:{type:'betterCodex-shell-hidden',scope:'ai'}});assert.equal(reset.at(-1),'list');
 handlers['betterCodex:conversation-ready']();assert.equal(sent.at(-1).type,'betterCodex-shell-ready');
});
