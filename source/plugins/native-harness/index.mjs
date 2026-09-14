import { NativeRpc } from './rpc.mjs';
import { Gateway } from './gateway.mjs';
import { handler,routes } from './http.mjs';
export const name='betterCodex-native-codex';
export const inject=['webServer'];
export function apply(ctx){ctx.effect(()=>{const rpc=new NativeRpc();const gateway=new Gateway(rpc);const handle=handler(gateway);const disposers=routes.map(path=>ctx.webServer.register({kind:'exact',path,handler:handle}));
  // Early navigation retires the old chat entry without deleting BETTER_CODEX history.
  disposers.push(ctx.on('webserver/index-inject',table=>table.push({kind:'script',placement:'head',text:'if(location.pathname==="/")location.replace("/native/?workspace="+(new URLSearchParams(location.search).get("workspace")==="secondary"?"secondary":"ai"))'})));
  return ()=>{for(const dispose of disposers)if(typeof dispose==='function')dispose();rpc.close()};
},'native Codex single execution host')}
