import assert from 'node:assert/strict';
import {
    addLibraryLookToWebsiteData,
    addOutfitToWebsiteData,
    exportOutfitToWebsite,
    imagePayload,
    websiteLooks,
    websiteUrls,
} from './site_bridge.js';
import {
    extBlockLookState,
    listExtBlockTargets,
    removeWebsiteLook,
    sendWebsiteLook,
    toggleWebsiteLook,
} from './extblocks_bridge.js';

assert.deepEqual(websiteUrls('example.github.io/wardrobe'), {
    site: 'https://example.github.io/wardrobe/',
    data: 'https://example.github.io/wardrobe/wardrobe.json',
});
assert.deepEqual(websiteLooks({ looks: [{ id: 'l1', name: '  Ада  ', desc: 'red hair\r\n\r\n\r\nblue eyes' }] }), [
    { id: 'l1', name: 'Ада', desc: 'red hair\n\nblue eyes' },
]);
assert.equal(imagePayload('data:image/webp;base64,YQ==').extension, 'webp');

const base = { chars: [], cats: [], items: [], looks: [{ id: 'l1', name: 'Ада', desc: 'red hair' }] };
const payload = {
    outfit: { id: 'coat', name: 'Пальто', description: 'Точное описание', favorite: true },
    subject: { id: 'ada', name: 'Ада' },
    shelfName: 'Зима',
    imagePath: 'images/coat.webp',
};
const first = addOutfitToWebsiteData(base, payload);
assert.equal(first.data.chars.length, 1);
assert.equal(first.data.cats.length, 1);
assert.equal(first.data.items.length, 1);
assert.equal(first.data.items[0].desc, 'Точное описание');
assert.deepEqual(first.data.looks, base.looks);
const second = addOutfitToWebsiteData(first.data, { ...payload, imagePath: 'images/coat-new.webp' });
assert.equal(second.data.items.length, 1, 'repeat export updates the same outfit');
assert.equal(second.data.items[0].img, 'images/coat-new.webp');
const withLook = addLibraryLookToWebsiteData(base, { id: 'ness_ada', name: 'Ада', aliases: ['Ada'], desc: 'blue eyes' });
assert.equal(withLook.data.looks.length, 1);
assert.equal(withLook.data.looks[0].id, 'ness_ada');
assert.equal(withLook.data.looks[0].desc, 'blue eyes');
assert.equal(withLook.updated, true);
const deduplicatedLook = addLibraryLookToWebsiteData({ ...base, looks: [...base.looks, { id: 'duplicate', name: 'Ada', desc: 'duplicate' }] }, { id: 'ness_ada', name: 'Ада', aliases: ['Ada'], desc: 'green eyes' });
assert.equal(deduplicatedLook.data.looks.length, 1);
assert.equal(deduplicatedLook.data.looks[0].desc, 'green eyes');

let saved = 0;
const block = { id: 'b1', name: 'nai_imagen', block_type: 'generated', context: [] };
const context = {
    extensionSettings: { ExtBlocks: { sets: [{ name: 'Main', global_blocks: [block] }] } },
    saveSettingsDebounced: () => { saved++; },
    uuidv4: () => 'ctx-1',
};
const target = listExtBlockTargets(context)[0];
const look = { id: 'l1', name: 'Ада', desc: 'red hair' };
assert.equal(await sendWebsiteLook(context, target, look, ''), 'added');
assert.equal(await sendWebsiteLook(context, target, { ...look, desc: 'blue hair' }, ''), 'updated');
assert.equal(block.context.length, 1);
assert.match(block.context[0].text, /blue hair/);
assert.deepEqual(extBlockLookState(block, look), { present: true, disabled: false });
assert.equal(await toggleWebsiteLook(context, target, look), false);
assert.equal(extBlockLookState(block, look).disabled, true);
assert.equal(await removeWebsiteLook(context, target, look), true);
assert.equal(block.context.length, 0);
assert.equal(saved, 4);

const initialJson = JSON.stringify(base);
const calls = [];
const mockFetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    if (!options.method) return new Response(JSON.stringify({ sha: 'sha-1', content: btoa(unescape(encodeURIComponent(initialJson))) }), { status: 200 });
    return new Response(JSON.stringify({ content: { sha: 'sha-next' } }), { status: 200 });
};
await exportOutfitToWebsite(
    { githubUser: 'user', githubRepo: 'wardrobe', token: 'secret' },
    {
        outfit: { ...payload.outfit, images: [{ dataUrl: 'data:image/png;base64,YQ==' }] },
        subject: payload.subject,
        shelfName: payload.shelfName,
    },
    mockFetch,
);
assert.equal(calls.length, 3);
assert.match(calls[1].url, /\/contents\/images\//);
assert.match(calls[2].url, /\/contents\/wardrobe\.json$/);
assert.equal(JSON.parse(calls[2].options.body).sha, 'sha-1');

console.log('NESS Wardrobe site bridge verification: OK');
