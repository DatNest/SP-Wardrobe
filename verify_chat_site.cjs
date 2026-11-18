const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let source = fs.readFileSync(__dirname + '/index.js', 'utf8');
source = source.slice(0, source.indexOf('jQuery(async () => {'));
source = source.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];[ \t]*$/gm, '');
const ctx = { chatId:'thread-A',characterId:42 };
const env = {
    getContext: () => ctx,
    escapeHtml: s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;'),
    comparableName: s => String(s||'').trim().toLowerCase(),
    normalizeName: s => String(s||'').trim(),
};
vm.createContext(env);
vm.runInContext(source, env, { filename: 'index.js' });
vm.runInContext(`settings = {subjects:[],tags:[],outfits:[
  { id:'a',name:'A',chatKey:'char:42/chat:thread-A',subjectId:'',tagIds:[],updatedAt:'2026-01-01'},
  { id:'b',name:'B',chatKey:'char:42/chat:thread-B',subjectId:'',tagIds:[],updatedAt:'2026-01-01'}
]}; settingsRevision = 10;`, env);
assert.equal(vm.runInContext('chatOutfits().map(x=>x.id).join(",")',env),'a');
assert.equal(vm.runInContext('filteredOutfits().outfits.map(x=>x.id).join(",")',env),'a');
ctx.chatId='thread-B';
assert.equal(vm.runInContext('chatOutfits().map(x=>x.id).join(",")',env),'b');
assert.equal(vm.runInContext('filteredOutfits().outfits.map(x=>x.id).join(",")',env),'b', 'cached gallery must not leak outfits when chat changes');
vm.runInContext(`ui.siteCharacters=[{id:'c1',name:'Джи',shelves:[]},{id:'c2',name:'Аанг',shelves:[]},{id:'c3',name:'Джимми',shelves:[]}];`,env);
assert.equal((vm.runInContext('characterOptionsHtml("дж")',env).match(/data-action="choose-site-character"/g)||[]).length,2);
assert.equal((vm.runInContext('characterOptionsHtml("")',env).match(/data-action="choose-site-character"/g)||[]).length,3);
console.log('Chat isolation and searchable dropdown: OK');
