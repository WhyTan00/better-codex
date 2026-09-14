import test from 'node:test';
import assert from 'node:assert/strict';
import {cacheableBootstrap} from '../src/native-bootstrap.mjs';
test('cloud startup snapshot keeps scoped UI defaults but excludes credentials and drafts',()=>{
 const c={gatewayBaseUrl:'http://localhost:3080/w/ai',gatewayWsUrl:'wss://localhost:3080/w/ai/ws?scopeToken=not-for-cache',workspaceRoots:['${BETTER_CODEX_WORKSPACE}'],persistedAtomSnapshot:{'composer-prompt-drafts-v2':{private:'draft'},'prompt-history':['private'],'sidebar-width':240,'agent-mode-by-host-id':{local:'full-access'}},initialSidebarBootstrap:{globalStateEntries:[{key:'selected-project',value:{projectId:'betterCodex-ai'}},{key:'queued-follow-ups',value:{private:'queued'}}]}};
 const value=cacheableBootstrap(c,{initialization:{appServerVersion:'0.153.4'},defaults:{getAuthStatus:{authToken:'not-for-cache',authMethod:'chatgpt'},'config/read':{config:{model:'provider-default'}}},settings:{followUpQueueMode:'queue'}});
 assert(!JSON.stringify(value).includes('not-for-cache'));assert(!JSON.stringify(value).includes('private'));assert.equal(value.persistedAtomSnapshot['sidebar-width'],240);assert.equal(value.betterCodexReadDefaults['config/read'].config.model,'provider-default');assert.equal(value.betterCodexSettings.followUpQueueMode,'queue');assert(c.gatewayWsUrl.includes('scopeToken='));
});
