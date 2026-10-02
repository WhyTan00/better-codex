// An explicit conversation prop can also mount a retained/sidebar conversation.
// Only the conversation selected by the official MemoryRouter may mirror its
// route into the browser address and start foreground history recovery.
export function patchRoutePresentation(source){
 const before='n.setActiveConversation(c,!0),CX.requestUserInputAutoResolution.setConversationPresented?.';
 const after='n.setActiveConversation(c,!0),s===c&&CX.requestUserInputAutoResolution.setConversationPresented?.';
 if(source.includes(after))return source;
 if(source.split(before).length!==2)throw Error('Official route presentation contract changed');
 return source.replace(before,after);
}
