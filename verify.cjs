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
assert.equal(normalized.regex.entryTemplate, '⟦ОДЕЖДА:{{name}}⟧ {{outfit}}');
assert.equal(normalized.regex.closingMarker, '⟦/ГАРДЕРОБ⟧');

const roundTrip = vm.runInContext('readExport(makeExport(normalizeSettings(DEFAULT_SETTINGS)))', context);
assert.equal(roundTrip.version, 1);
assert.equal(roundTrip.connection.profileId, 'auto');
assert.equal(roundTrip.website.githubRepo, '');
assert.equal(Object.hasOwn(roundTrip.website, 'token'), false, 'GitHub token is not included in library exports');
assert.equal(roundTrip.prompts.scan.includes('{{world}}'), true);
assert.equal(roundTrip.prompts.scan.includes('{{posts}}'), true);
assert.equal(roundTrip.prompts.outfit.includes('{{scan}}'), true);
assert.match(roundTrip.regex.pattern, /⟦ОДЕЖДА:/);
assert.equal(roundTrip.regex.flags, 'gm');
assert.doesNotMatch(roundTrip.regex.pattern, /\.\*\?/);
const migratedRule = vm.runInContext(`normalizeRegexRule({
    pattern: '⟦ОДЕЖДА:(?<name>[^⟧\\\\r\\\\n]+)⟧[ \\\\t]*(?<outfit>.*?)(?=\\\\r?\\\\n⟦ОДЕЖДА:|\\\\r?\\\\n⟦/ГАРДЕРОБ⟧)',
    flags: 'gms', nameGroup: 'name', outfitGroup: 'outfit'
})`, context);
assert.equal(migratedRule.flags, 'gm');
assert.doesNotMatch(migratedRule.pattern, /\.\*\?/);
assert.equal(vm.runInContext(`parseScanResult('{"summary":"Осень, дорога, холод"}')`, context), 'Осень, дорога, холод');

let workerResult = null;
context.self = { postMessage: value => { workerResult = value; } };
vm.runInContext('wardrobeRegexWorker()', context);
const wardrobeRule = JSON.parse(JSON.stringify(vm.runInContext('WARDROBE_RULE_DEFAULTS', context)));
const olderWardrobe = '⟦ГАРДЕРОБ⟧\n⟦ОДЕЖДА:Ада⟧ older\n⟦/ГАРДЕРОБ⟧';
const newestWardrobe = 'scene\n⟦ГАРДЕРОБ⟧\n⟦ОДЕЖДА:Мира⟧ blue silk\n⟦ОДЕЖДА:Ада⟧ red coat\n⟦/ГАРДЕРОБ⟧';
workerResult = null;
context.self.onmessage({ data: { operation: 'scanMany', texts: [{ key: 14, text: 'plain post' }, { key: 13, text: newestWardrobe }, { key: 12, text: olderWardrobe }], rule: wardrobeRule, closingMarker: wardrobeRule.closingMarker } });
assert.equal(workerResult.key, 13, 'scan chooses the newest wardrobe post inside the configured range');
assert.equal(workerResult.entries.length, 2);
assert.equal(workerResult.entries[1].name, 'Ада');

workerResult = null;
context.self.onmessage({ data: { operation: 'replaceEntry', text: newestWardrobe, rule: wardrobeRule, entryIndex: 1, replacement: 'new linen outfit' } });
assert.match(workerResult.text, /⟦ОДЕЖДА:Ада⟧ new linen outfit/);
assert.match(workerResult.text, /⟦ОДЕЖДА:Мира⟧ blue silk/);

workerResult = null;
context.self.onmessage({ data: { operation: 'deleteEntry', text: newestWardrobe, rule: wardrobeRule, entryIndex: 0 } });
assert.doesNotMatch(workerResult.text, /Мира/);
assert.match(workerResult.text, /Ада/);

workerResult = null;
context.self.onmessage({ data: { operation: 'append', text: newestWardrobe, rule: wardrobeRule, entryText: '⟦ОДЕЖДА:Тоф⟧ green tunic', closingMarker: wardrobeRule.closingMarker } });
assert.match(workerResult.text, /⟦ОДЕЖДА:Тоф⟧ green tunic\n⟦\/ГАРДЕРОБ⟧/);

const indexSource = read('index.js');
const generationSource = read('generation.js');
const css = read('style.css');
const preview = read('preview.html');
const manifest = JSON.parse(read('manifest.json'));
const siteBridgeSource = read('site_bridge.js');
const siteTokenSource = read('site_token.js');
const nessLibraryBridgeSource = read('ness_library_bridge.js');

assert.equal(manifest.version, '1.6.2');
assert.equal(manifest.auto_update, false);
assert.match(indexSource, /v1\.6\.2 ready/);
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
assert.match(indexSource, /GALLERY_FIRST = 24/);
assert.match(indexSource, /GALLERY_MORE = 16/);
assert.match(indexSource, /IntersectionObserver/);
assert.match(indexSource, /loading="lazy"/);
assert.match(indexSource, /operation: 'scanMany'/);
assert.match(indexSource, /operation: 'replaceEntry'/);
assert.match(indexSource, /operation: 'append'/);
assert.match(indexSource, /Наряд добавлен в регекс/);
assert.match(indexSource, /message\?\.mes !== snapshot\.source/);
assert.match(indexSource, /saveChatConditional/);
assert.match(indexSource, /updateMessageDisplay/);
assert.match(indexSource, /SillyTavern изменил сообщение во время сохранения/);
assert.match(indexSource, /data-gallery-mode="active"/);
assert.match(indexSource, /save-active-to-library/);
assert.match(indexSource, /delete-active-outfit/);
assert.match(indexSource, /nw-regex-entry-template/);
assert.match(indexSource, /nw-regex-closing-marker/);
assert.match(indexSource, /add-image-url/);
assert.match(indexSource, /paste-image/);
assert.match(indexSource, /imageFileFromUrl/);
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
assert.match(indexSource, /data-settings-tab="\$\{item\.id\}"/);
assert.match(indexSource, /export-outfit-site/);
assert.match(indexSource, /load-website-looks/);
assert.match(indexSource, /export-library-look-site/);
assert.match(indexSource, /NESS Library и сайт/);
assert.match(indexSource, /LIBRARY_LOOKS_FIRST = 16/);
assert.match(indexSource, /subjects: \(\) =>/);
assert.match(indexSource, /panes\[tab\]\(\)/);
assert.match(indexSource, /load-more-library-looks/);
assert.match(indexSource, /toggle-website-only/);
assert.match(indexSource, /galleryResultCache/);
assert.match(indexSource, /subjectById = new Map/);
assert.match(indexSource, /tagById = new Map/);
assert.match(indexSource, /siteController\?\.abort/);
assert.match(siteBridgeSource, /wardrobe\.json/);
assert.match(siteBridgeSource, /images\//);
assert.doesNotMatch(indexSource + coreSource, /Context Builder|nw-website-extblock|site-look-send|extBlockRef|lookTemplate/);
assert.match(siteTokenSource, /localStorage/);
for (const heading of ['THIGH MARKS', 'KNEE MARKS', 'SHIN MARKS', 'SHOULDER MARKS', 'FOREARM MARKS', 'NUDE UPPER', 'NUDE LOWER']) assert.match(nessLibraryBridgeSource, new RegExp(heading));
assert.match(nessLibraryBridgeSource, /sp_ness_master_library_v1/);
assert.match(nessLibraryBridgeSource, /cachedLibraryRaw/);
assert.match(coreSource, /dataUrl\.slice\(0, 48\)/);
assert.doesNotMatch(coreSource + indexSource, /github.*token\s*:/i);
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
assert.match(css, /\.nw-gallery-mode-tabs/);
assert.match(css, /\.nw-active-tabs/);
assert.match(css, /overflow-x: auto/);
assert.match(css, /\.nw-settings-tabs::\-webkit-scrollbar/);
assert.match(css, /content-visibility: auto/);
assert.match(css, /white-space: nowrap !important/);
assert.match(css, /\.nw-panel,\s*\n\.nw-extension-settings,\s*\n\.nw-mini,/);
assert.doesNotMatch(css, /nw-section-action|nw-inline-tag-fields|nw-field-title/);
assert.equal((preview.match(/data-preview-tab=/g) || []).length, 3, 'preview exposes all three tabs');
assert.equal((preview.match(/data-preview-settings-tab=/g) || []).length, 8, 'preview exposes all settings tabs');
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
