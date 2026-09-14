// Status and approvals remain global within a workspace; large item streams
// follow only the conversations this page presents, owns or just requested.
export function wantsNativeNotification(client,message,threads,now=Date.now()){
 if(message.id!==undefined)return true;
 const method=message.method||'';if(!/^(?:item\/|turn\/|rawResponseItem\/|thread\/tokenUsage\/)/.test(method))return true;
 const id=message.params?.threadId||message.params?.thread?.id;if(!id)return true;
 const interested=value=>value&&(client.presentedThreadId===value||client.ownedThreads?.has(value)||(client.readThreads?.get(value)||0)>now);
 if(interested(id))return true;const parent=threads.get(id)?.parentThreadId;return !!interested(parent);
}
