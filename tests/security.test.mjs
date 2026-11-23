// Run: node --test tests/security.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const root = new URL('../', import.meta.url);
const source = async name => readFile(new URL(name, root), 'utf8');

test('legacy GitHub token is deleted, never read or persisted again', async () => {
    const script = (await source('site_token.js')).replaceAll('export function ', 'function ');
    const writes = [];
    const reads = [];
    const removed = [];
    const ctx = {
        globalThis: {
            localStorage: {
                getItem(key) { reads.push(key); return 'old-secret'; },
                setItem(key, value) { writes.push([key, value]); },
                removeItem(key) { removed.push(key); },
            },
        },
    };
    runInNewContext(script + '\nthis.functions = { getWebsiteToken, setWebsiteToken, clearWebsiteToken };', ctx);
    assert.deepEqual(removed, ['ness_wardrobe_github_token_v1']);
    assert.equal(ctx.functions.getWebsiteToken(), '');
    assert.equal(ctx.functions.setWebsiteToken('  secret-for-session  '), true);
    assert.equal(ctx.functions.getWebsiteToken(), 'secret-for-session');
    ctx.functions.clearWebsiteToken();
    assert.equal(ctx.functions.getWebsiteToken(), '');
    assert.deepEqual(writes, []);
    assert.deepEqual(reads, []);
});

test('local save never exports an outfit or uses a GitHub token', async () => {
    const file = await source('index.js');
    const match = file.match(/async function saveOutfit\(\) \{[\s\S]*?(?=\nasync function deleteSavedOutfit\()/);
    assert.ok(match, 'saveOutfit should exist');
    assert.doesNotMatch(match[0], /exportOutfitToWebsite|putGithubFile|websiteRequestConfig|getWebsiteToken/);
    assert.match(match[0], /commitSettings\(\)/);
    assert.match(file, /data-action="export-outfit-site"/);
    assert.match(file, /Опубликовать внешность на GitHub\?/);
    assert.match(file, /Опубликовать персонажа на GitHub\?/);
});

test('secret never reappears as a password input value', async () => {
    const file = await source('index.js');
    assert.doesNotMatch(file, /value="\$\{escapeHtml\(getWebsiteToken\(\)\)\}"/);
    assert.match(file, /autocomplete="new-password"/);
    assert.match(file, /data-action="forget-website-token"/);
});

test('GitHub requests keep authorization on a fixed HTTPS host and reject redirects', async () => {
    const bridge = await source('site_bridge.js');
    assert.match(bridge, /https:\/\/api\.github\.com\/repos\//);
    assert.equal((bridge.match(/redirect: 'error'/g) || []).length, 2);
    assert.match(bridge, /url\.protocol !== 'https:'/);
});

test('remote images use no-referrer policy and block ordinary HTTP URLs', async () => {
    const index = await source('index.js');
    assert.ok((index.match(/referrerpolicy="no-referrer"/g) || []).length >= 2);
    assert.match(index, /url\.protocol === 'https:'/);
});
