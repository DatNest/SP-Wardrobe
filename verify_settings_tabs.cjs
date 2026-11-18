const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
let core = fs.readFileSync(__dirname + '/core.js', 'utf8').replace(/^export\s+/gm, '');
let index = fs.readFileSync(__dirname + '/index.js', 'utf8');
index = index.slice(0, index.indexOf('jQuery(async () => {'));
index = index.replace(/^import\s+[\s\S]*?\s+from\s+['"][^'"]+['"];[ \t]*$/gm, '');
const ctx = {
  console, URL, Date, JSON, Math, Set, Map, String, Number, Object, Array, Error, RegExp,
  crypto: { randomUUID: () => 'regression-test-id' },
  getContext: () => ({chatId:'test-chat', characterId:1, chat:[], extensionSettings:{}}),
  getWebsiteToken: () => '',
  readNessLibrary: () => ({available: false, records: []}),
  splitWebsiteLooks: () => [],
};
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(core, ctx, { filename: 'core.js' });
vm.runInContext(index, ctx, { filename: 'index.js' });
vm.runInContext(`settings = normalizeSettings({subjects:[{id:'zuko',name:'Зуко',type:'character',aliases:['Зузу'],color:'#986a5d'}],tags:[{id:'f',name:'Фэнтези'}]});`,ctx);
for(const tab of ['subjects','tags','connection','website','insertion','scan','generation','transfer']) {
  ctx.selectedTab = tab;
  const markup = vm.runInContext(`ui.settingsTab = selectedTab; settingsViewHtml()`,ctx);
  assert.ok(markup.includes('nw-settings-shell'), `tab ${tab} should produce markup`);
  assert.ok(markup.includes('nw-settings-tab'), `tab ${tab} should have nav`);
}
const subjectMarkup = vm.runInContext(`ui.settingsTab = 'subjects'; settingsViewHtml()`,ctx);
assert.match(subjectMarkup, /Зуко/);
assert.doesNotMatch(subjectMarkup, /nw-inline-site-description/, 'creator-only UI must not be in settings rows');
const creatorMarkup = vm.runInContext(`ui.subjectCreator = { assignToDraft:true, name:'Новый', aliases:[], color:'#986a5d', type:'character', imageDataUrl:'', description:'test'}; inlineSubjectCreatorHtml()`,ctx);
assert.match(creatorMarkup, /nw-inline-site-description/, 'site description remains in creator');
assert.match(creatorMarkup, /nw-site-character-image/, 'character avatar upload remains in creator');
console.log('All eight settings panes, existing subjects and site creator: OK');
