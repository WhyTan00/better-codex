export class WorkspaceState {
  constructor(storage){this.storage=storage;this.workspace='ai';this.epoch=0;this.thread=null;this.items=new Map();this.generation=null}
  switch(w){this.workspace=w;this.epoch++;this.thread=null;this.items.clear();this.generation=null;return this.epoch}
  current(w,e){return this.workspace===w&&this.epoch===e}
  key(name){return `native-codex:${this.workspace}:${name}`}
  draft(){return this.storage.getItem(this.key('draft'))||''}
  saveDraft(s){this.storage.setItem(this.key('draft'),s)}
  accept(e){if(e.workspace!==this.workspace)return false;if(this.generation&&e.generation!==this.generation){this.items.clear();this.generation=e.generation;return false}this.generation=e.generation;return true}
}
