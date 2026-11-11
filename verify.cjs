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
assert.equal(roundTrip.connection.profileId, 'auto');
assert.equal(roundTrip.prompts.scan.includes('{{world}}'), true);
assert.equal(roundTrip.prompts.scan.includes('{{posts}}'), true);
assert.equal(roundTrip.prompts.outfit.includes('{{scan}}'), true);
assert.equal(vm.runInContext(`parseScanResult('{"summary":"Осень, дорога, холод"}')`, context), 'Осень, дорога, холод');

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

assert.equal(manifest.version, '1.3.0');
assert.equal(manifest.auto_update, false);
assert.match(indexSource, /v1\.3\.0 ready/);
assert.equal((indexSource.match(/data-view="(?:gallery|create|settings)"/g) || []).length, 3, 'exactly three primary tabs');
assert.match(indexSource, /data-mode="write"/);
assert.match(indexSource, /data-mode="generate"/);
assert.match(indexSource, /create-inline-subject/);
assert.match(indexSource, /openTagCreatorPopup/);
assert.match(indexSource, /id="nw-tag-search"/);
assert.match(indexSource, /POPUP_TYPE\.INPUT/);
assert.match(indexSource, /type: 'color'/);
assert.match(indexSource, /Добавить и выбрать/);
assert.match(indexSource, /Новый черновик/);
assert.match(indexSource, /Как подготовить описание/);
assert.match(indexSource, /class="nw-form-card"/);
assert.match(indexSource, /rows="5"/);
assert.match(indexSource, /fa-solid fa-shirt/);
assert.doesNotMatch(indexSource, /openNameColorEditor/);
assert.doesNotMatch(indexSource, /tagCreator|createInlineTag|openInlineTag|inlineTagCreatorHtml/);
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
assert.match(generationSource, /ConnectionManagerRequestService/);
assert.match(generationSource, /sendRequest/);
assert.match(generationSource, /scanTemplate/);
assert.match(generationSource, /outfitTemplate/);
assert.match(indexSource, /nw-connection-profile/);
assert.match(indexSource, /Промпт сканирования/);
assert.doesNotMatch(indexSource, />Проверить на последних постах</);
assert.doesNotMatch(css, /linear-gradient|radial-gradient/i);
assert.match(css, /--SmartTheme/);
assert.match(css, /env\(safe-area-inset/);
assert.match(css, /100dvh/);
assert.match(css, /repeat\(auto-fit, minmax\(138px, 1fr\)\)/);
assert.match(css, /max-width: 280px/);
assert.match(css, /\.nw-mode-switch \.menu_button\.active/);
assert.match(css, /\.nw-inline-creator/);
assert.match(css, /\.nw-tag-pill/);
assert.match(css, /border-radius: 999px/);
assert.match(css, /\.nw-tag-search/);
assert.match(css, /white-space: nowrap !important/);
assert.match(css, /\.nw-panel,\s*\n\.nw-extension-settings,\s*\n\.nw-mini,/);
assert.doesNotMatch(css, /nw-section-action|nw-inline-tag-fields|nw-field-title/);
assert.equal((preview.match(/data-preview-tab=/g) || []).length, 3, 'preview exposes all three tabs');
assert.match(preview, /data-preview-mode="write"/);
assert.match(preview, /data-preview-mode="generate"/);
assert.match(preview, /Подключение к модели/);
assert.match(preview, /data-preview-create-subject/);
assert.match(preview, /data-preview-create-tag/);
assert.match(preview, /addEventListener\('click'/);

(async () => {
    const generationVmSource = generationSource.replace(/^import .*;\r?\n/gm, '').replace(/^export\s+/gm, '');
    const calls = [];
    const generationContext = vm.createContext({
        console,
        Date,
        Promise,
        String,
        Array,
        Error,
        setTimeout,
        clearTimeout,
        AbortController,
        fillPrompt: vm.runInContext('fillPrompt', context),
        parseGeneratedOutfit: vm.runInContext('parseGeneratedOutfit', context),
        parseScanResult: vm.runInContext('parseScanResult', context),
    });
    generationContext.mockContext = {
        chat: [
            { name: 'Old', mes: 'OLDEST_POST', is_system: false },
            { name: 'User', mes: 'RECENT_ONE', is_system: false, is_user: true },
            { name: 'Ada', mes: 'RECENT_TWO', is_system: false },
        ],
        extensionSettings: { connectionManager: { selectedProfile: 'profile-1' } },
        getWorldInfoPrompt: async () => ({ worldInfoString: 'WORLD_FACTS' }),
        ConnectionManagerRequestService: {
            getSupportedProfiles: () => [{ id: 'profile-1', name: 'Main profile' }],
            sendRequest: async (id, messages) => {
                calls.push({ id, text: messages.map(item => item.content).join('\n') });
                return calls.length === 1
                    ? { content: '{"summary":"cold autumn road"}' }
                    : { content: '{"name":"Road coat","description":"warm wool coat"}' };
            },
        },
    };
    vm.runInContext(generationVmSource, generationContext, { filename: 'generation.js' });
    const profiles = await vm.runInContext('listConnectionProfiles(mockContext)', generationContext);
    assert.deepEqual(JSON.parse(JSON.stringify(profiles)), [{ id: 'profile-1', name: 'Main profile' }]);
    const result = await vm.runInContext(`generateOutfit(mockContext, {
        target: 'Ada', wishes: 'warm', avoid: '', profileId: 'auto',
        scanTemplate: DEFAULT_SCAN, outfitTemplate: DEFAULT_OUTFIT
    }, new AbortController().signal)`, Object.assign(generationContext, {
        DEFAULT_SCAN: vm.runInContext('DEFAULT_SCAN_PROMPT', context),
        DEFAULT_OUTFIT: vm.runInContext('DEFAULT_GENERATION_PROMPT', context),
    }));
    assert.equal(result.name, 'Road coat');
    assert.equal(result.description, 'warm wool coat');
    assert.equal(calls.length, 2, 'scan and generation must be separate requests');
    assert.equal(calls[0].id, 'profile-1');
    assert.equal(calls[1].id, 'profile-1');
    assert.match(calls[0].text, /WORLD_FACTS/);
    assert.match(calls[0].text, /RECENT_ONE/);
    assert.match(calls[0].text, /RECENT_TWO/);
    assert.doesNotMatch(calls[0].text, /OLDEST_POST/);
    assert.match(calls[1].text, /cold autumn road/);
    console.log('NESS Wardrobe verification: OK');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
