const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = __dirname;
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

let coreSource = read('core.js').replace(/^export\s+/gm, '');
const context = vm.createContext({
    console,
    Date,
    JSON,
    Math,
    Set,
    Map,
    RegExp,
    String,
    Number,
    Object,
    Array,
    Error,
    SyntaxError,
    crypto: { randomUUID: () => 'test-id' },
});
context.globalThis = context;
vm.runInContext(coreSource, context, { filename: 'core.js' });

const normalized = vm.runInContext(`normalizeSettings({
    subjects: [{ id: 'a', name: ' Ада ', type: 'character', color: '#AABBCC', aliases: ['Ada', 'Ada'] }],
    tags: [{ id: 'winter', name: 'Зима', color: '#112233' }],
    outfits: [{ id: 'coat', name: 'Пальто', description: 'шерстяное пальто', subjectId: 'a', tagIds: ['winter', 'missing'], createdAt: '2026-11-12T00:00:00.000Z' }],
    regex: { pattern: '(?<name>[^:]+):(?<outfit>.+)', flags: 'gm', nameGroup: 'name', outfitGroup: 'outfit', searchDepth: 500 }
})`, context);
assert.equal(normalized.subjects[0].name, 'Ада');
assert.equal(normalized.subjects[0].color, '#aabbcc');
assert.deepEqual(JSON.parse(JSON.stringify(normalized.subjects[0].aliases)), ['Ada']);
assert.deepEqual(JSON.parse(JSON.stringify(normalized.outfits[0].tagIds)), ['winter']);
assert.equal(normalized.regex.searchDepth, 100);

const roundTrip = vm.runInContext('readExport(makeExport(normalizeSettings(DEFAULT_SETTINGS)))', context);
assert.equal(roundTrip.version, 1);
assert.equal(roundTrip.prompts.outfit.includes('{{world}}'), true);

let workerResult = null;
context.self = { postMessage: value => { workerResult = value; } };
vm.runInContext('wardrobeRegexWorker()', context);
context.self.onmessage({ data: {
    operation: 'replaceMany',
    texts: [
        { key: 9, text: '[Mia|blue coat]\n[Ada|old dress]' },
        { key: 8, text: '[Ada|older dress]' },
    ],
    rule: { pattern: '\\[(?<name>[^|]+)\\|(?<outfit>[^\\]]+)\\]', flags: 'g', nameGroup: 'name', outfitGroup: 'outfit' },
    targetNames: ['Ada'],
    replacement: 'new linen outfit',
} });
assert.equal(workerResult.count, 1);
assert.equal(workerResult.key, 9);
assert.equal(workerResult.text, '[Mia|blue coat]\n[Ada|new linen outfit]');
assert.deepEqual(JSON.parse(JSON.stringify(workerResult.names)), ['Ada']);

workerResult = null;
context.self.onmessage({ data: {
    operation: 'replace',
    text: '<w><n>Ada</n><o>red</o></w>',
    rule: { pattern: '<w><n>([^<]+)</n><o>([^<]+)</o></w>', flags: '', nameGroup: '1', outfitGroup: '2' },
    targetNames: ['Ada'],
    replacement: 'green',
} });
assert.equal(workerResult.text, '<w><n>Ada</n><o>green</o></w>');

const indexSource = read('index.js');
const generationSource = read('generation.js');
const css = read('style.css');
const preview = read('preview.html');
const manifest = JSON.parse(read('manifest.json'));

assert.equal(manifest.version, '1.0.0');
assert.equal(manifest.auto_update, false);
assert.equal((indexSource.match(/data-view="(?:gallery|create|settings)"/g) || []).length, 3, 'exactly three primary tabs');
assert.match(indexSource, /data-mode="write"/);
assert.match(indexSource, /data-mode="generate"/);
assert.match(indexSource, /GALLERY_FIRST = 48/);
assert.match(indexSource, /IntersectionObserver/);
assert.match(indexSource, /loading="lazy"/);
assert.match(indexSource, /operation: 'replaceMany'/);
assert.match(indexSource, /message\.mes !== before/);
assert.match(indexSource, /generationController\?\.abort/);
assert.match(indexSource, /disposeGalleryObserver/);
assert.match(coreSource, /new Worker\(url\)/);
assert.match(coreSource, /setTimeout\(\(\) => reject/);
assert.doesNotMatch(indexSource + generationSource + coreSource, /localStorage/);
assert.match(generationSource, /getWorldInfoPrompt/);
assert.match(generationSource, /\.slice\(-2\)/);
assert.match(generationSource, /generateRaw/);
assert.doesNotMatch(css, /linear-gradient|radial-gradient/i);
assert.match(css, /--SmartTheme/);
assert.match(css, /env\(safe-area-inset/);
assert.match(css, /100dvh/);
assert.match(css, /repeat\(auto-fit, minmax\(138px, 1fr\)\)/);
assert.match(css, /max-width: 280px/);
assert.equal((preview.match(/data-preview-tab=/g) || []).length, 3, 'preview exposes all three tabs');
assert.match(preview, /data-preview-mode="write"/);
assert.match(preview, /data-preview-mode="generate"/);
assert.match(preview, /addEventListener\('click'/);

console.log('NESS Wardrobe verification: OK');
