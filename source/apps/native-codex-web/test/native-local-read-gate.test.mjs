import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile}from'node:fs/promises';import {patchNativeLocalReadGate}from'../../../../scripts/android-local-profile-gate.mjs';
const sdkPath=process.env.DSH_INITIAL_SDK,source=sdkPath?patchNativeLocalReadGate(await readFile(sdkPath,'utf8')):'';
const sdkTest=(name,fn)=>test(name,{skip:!sdkPath&&'Requires adopter-owned instrumented SDK'},fn);
const cut=(from,to)=>{const a=source.indexOf(from),b=source.indexOf(to,a);assert(a>=0&&b>a,from);return source.slice(a,b);};
const gate=sdkPath?cut('function UCo(','var WCo='):'',proposal=gate,homeProposal=gate;
sdkTest('actual account producer and access atoms permit Native local reads while keeping authentication and settled feature gates',()=>{
const symbol=()=>({});
const Q=symbol(),DO=symbol(),SR=symbol(),pNr=symbol(),lk=symbol(),b3=symbol(),DE=symbol(),Jjn=symbol(),Yjn=symbol(),Xjn=symbol();
const state=new Map();
const context={Q,DO,SR,pNr,lk,b3,DE,Jjn,Yjn,Xjn,
  gPo:{c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))},eMn(){},Db:()=>({set:(key,value)=>state.set(key,value)}),
  I2i:()=>({data:undefined,isLoading:false}),_Po:{useLayoutEffect:fn=>fn()},
  qy:(_scope,reader)=>({reader}),Gjn:()=>null,
  lMn:'free',uMn:['plus','pro'],mMn:'fixture-voice-permission',dMn:'fixture-work-gate'};
vm.createContext(context);
vm.runInContext(cut('function mPo(','var gPo,')+';globalThis.publishAccount=mPo;',context);
const auth={isLoading:false,authMethod:'chatgpt',requiresAuth:true,hasChatGptToken:undefined,accountId:null,userId:null,email:null,planAtLogin:'pro'};
// Actual mPo receives a cold pending Desktop metadata snapshot. No account or permissions are fabricated.
context.publishAccount({accountInfo:undefined,accountInfoError:false,accountInfoLoading:true,auth});
const published=state.get(DO);assert.equal(published.accountInfoLoading,true);assert.equal(published.accountId,null);
assert.equal(published.authLoading,false);assert.equal(published.authMethod,'chatgpt');
vm.runInContext(cut('function tMn(','var lMn,')+';',context);
const atoms=cut('OO=qy(','PO=qy(').replace(/,$/,'');
context.EO={query:true};
vm.runInContext('var OO,kO,AO,jO,_Mn,MO,vMn,NO;'+atoms+';globalThis.accessAtom=NO;',context);
const get=(atom)=>{if(atom===DO)return state.get(DO);if(atom===DE)return false;if([Jjn,Yjn,Xjn].includes(atom))return null;if(atom?.query)return {isLoading:false,isError:false};return atom?.reader?atom.reader({get}):atom;};
const access=get(context.accessAtom);assert.equal(access.status,'loading');
function run(code,{native=false,path='/local/11111111-1111-4111-a111-111111111111',authValue=auth,feature=access}={}){
 const sandbox={location:{pathname:path}};if(native)sandbox.__DSH_LOCAL_APP_HOST__=()=>{};
 vm.createContext(sandbox);vm.runInContext(code+';globalThis.gate=UCo;',sandbox);
 return sandbox.gate({auth:authValue,codexFeatureAccess:feature,isFinalStepLoading:false,shouldShowFinalStep:false,
  isOnboardingContextFetched:false,isOnboardingContextLoading:true,projectlessOnboardingCompleted:false,workspaceRootsIsLoading:false});
}
assert.equal(run(gate,{native:true}),'app');
assert.equal(run(proposal,{native:true}),'app');
assert.equal(run(proposal),null);
assert.equal(run(proposal,{native:true,path:'/remote/fixture-task'}),null);
assert.equal(run(proposal,{native:true,path:'/'}),'app');
assert.equal(run(gate,{native:true,path:'/'}),'app');
assert.equal(run(homeProposal,{native:true,path:'/'}),'app');
assert.equal(run(homeProposal,{native:true}),'app');
assert.equal(run(homeProposal,{native:true,path:'/remote/fixture-task'}),null);
assert.equal(run(homeProposal,{path:'/'}),null);
assert.equal(run(homeProposal,{native:true,path:'/',authValue:{...auth,isLoading:true}}),null);
assert.equal(run(homeProposal,{native:true,path:'/',authValue:{...auth,authMethod:null}}),'login');
assert.equal(run(homeProposal,{native:true,path:'/',authValue:{...auth,hasChatGptToken:false}}),'login');
assert.equal(run(proposal,{native:true,authValue:{...auth,isLoading:true}}),null);
assert.equal(run(proposal,{native:true,authValue:{...auth,authMethod:null}}),'login');
assert.equal(run(proposal,{native:true,authValue:{...auth,hasChatGptToken:false}}),'login');
for(const feature of [{status:'denied',reason:'missing-account'},{status:'error',source:'account-info'},{status:'allowed',accountId:'fixture-only'}])
 {
  assert.equal(run(proposal,{native:true,feature}),run(gate,{native:true,feature}));
  assert.equal(run(homeProposal,{native:true,path:'/',feature}),run(gate,{native:true,path:'/',feature}));
 }
// Actual upper currentAuth gate remains independently blocking.
const upperContext={d6:{c:n=>Array(n).fill(Symbol.for('react.memo_cache_sentinel'))},WR:()=>({...auth,isLoading:true}),
 YF:{},dA:{},Cb:()=>({isLoading:false}),LD:()=>({isLoading:false}),f6:{useEffect(){}},window:{},t6:'native-auth-loading',p6:{jsx:(type,props)=>({type,props})}};
vm.createContext(upperContext);vm.runInContext(cut('function MUo(','function NUo(')+';globalThis.upper=MUo;',upperContext);
assert.equal(upperContext.upper({children:{kind:'local-page'}}).type,'native-auth-loading');

});
test('Native local reading gate fails closed on SDK ABI drift',()=>{assert.throws(()=>patchNativeLocalReadGate('other ABI'),/ABI changed/);if(sdkPath)assert.equal(patchNativeLocalReadGate(source),source);});
