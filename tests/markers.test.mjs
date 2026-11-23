// Run: node --test tests/markers.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const coreSource = (await readFile(new URL('../core.js', import.meta.url), 'utf8')).replace(/^export /gm, '');
const self = {
    onmessage: null,
    result: null,
    postMessage(value) { this.result = value; },
};
const core = runInNewContext(coreSource + '\nwardrobeRegexWorker(); ({ normalizeRegexRule, DEFAULT_SETTINGS, WARDROBE_RULE_DEFAULTS });', { self });

function execute(operation, rule, extra = {}) {
    self.result = null;
    self.onmessage({ data: { operation, rule, ...extra } });
    if (self.result?.error) throw new Error(self.result.error);
    return self.result;
}

test('new users get literal markers; old saved rules keep RegExp semantics', () => {
    const fresh = core.normalizeRegexRule(core.DEFAULT_SETTINGS.regex);
    const legacy = core.normalizeRegexRule(core.WARDROBE_RULE_DEFAULTS);
    assert.equal(fresh.mode, 'markers');
    assert.equal(fresh.startMarker, '[LOOK:{{имя}}]');
    assert.equal(legacy.mode, 'regex');
});

test('plain-text markers can scan, replace, delete and append without touching other text', () => {
    const rule = core.normalizeRegexRule(core.DEFAULT_SETTINGS.regex);
    const source = 'Intro\n[WARDROBE]\n[LOOK:Alice]\nBlue shirt\n[/LOOK]\n[LOOK:Bob]\nGreen coat\n[/LOOK]\n[/WARDROBE]';
    const scan = execute('scanMany', rule, { texts: [{ key: 4, text: source }] });
    assert.equal(scan.entries.length, 2);
    assert.equal(scan.entries[0].name, 'Alice');
    assert.equal(scan.entries[1].outfit, 'Green coat');
    const replace = execute('replaceEntry', rule, { text: source, entryIndex: 0, replacement: 'Black jacket' });
    assert.match(replace.text, /\[LOOK:Alice\]\nBlack jacket\n\[\/LOOK\]/);
    assert.match(replace.text, /\[LOOK:Bob\]\nGreen coat\n\[\/LOOK\]/);
    const remove = execute('deleteEntry', rule, { text: source, entryIndex: 0 });
    assert.doesNotMatch(remove.text, /\[LOOK:Alice\]/);
    assert.match(remove.text, /\[LOOK:Bob\]/);
    const append = execute('append', rule, {
        text: '[WARDROBE]\n[/WARDROBE]',
        entryText: '[LOOK:Charlie]\nYellow scarf\n[/LOOK]',
    });
    assert.match(append.text, /\[LOOK:Charlie\]\nYellow scarf\n\[\/LOOK\]\n\[\/WARDROBE\]/);
});

test('literal HTML tags work with nested HTML content', () => {
    const rule = core.normalizeRegexRule({
        ...core.DEFAULT_SETTINGS.regex,
        startMarker: '<look name="{{имя}}">',
        endMarker: '</look>',
        markerClosingMarker: '</section>',
    });
    const text = '<section data-wardrobe="true">\n<look name="Eve"><div>A <em>beautiful</em> coat</div></look>\n</section>';
    const result = execute('scanMany', rule, { texts: [{ key: 1, text }] });
    assert.equal(result.entries[0].name, 'Eve');
    assert.equal(result.entries[0].outfit, '<div>A <em>beautiful</em> coat</div>');
});

test('HTML comments and RegExp-special characters are treated literally', () => {
    const rule = core.normalizeRegexRule({
        ...core.DEFAULT_SETTINGS.regex,
        startMarker: '<!-- [LOOK+*?]: {{имя}} -->',
        endMarker: '<!-- /LOOK -->',
        markerClosingMarker: '<!-- /WARDROBE -->',
    });
    const text = '<!-- [LOOK+*?]: Rémi -->\n<p>(+?*)</p>\n<!-- /LOOK -->\n<!-- /WARDROBE -->';
    assert.equal(execute('scanMany', rule, { texts: [{ key: 1, text }] }).entries[0].outfit, '<p>(+?*)</p>');
});

test('optional closing tag for each entry and configurable plain markers', () => {
    const rule = core.normalizeRegexRule({
        ...core.DEFAULT_SETTINGS.regex,
        startMarker: 'Имя: {{name}} — одежда:',
        endMarker: '',
        markerClosingMarker: 'Конец гардероба',
    });
    const text = 'Имя: Аня — одежда:\nкрасная рубашка\nИмя: Вера — одежда:\nсиний плащ\nКонец гардероба';
    const entries = execute('scanMany', rule, { texts: [{ key: 10, text }] }).entries;
    assert.equal(entries.length, 2);
    assert.equal(entries[1].name, 'Вера');
});

test('preserve independent regex settings when switching formats', () => {
    const old = core.normalizeRegexRule({
        ...core.WARDROBE_RULE_DEFAULTS,
        entryTemplate: '[[{{name}}]]:{{outfit}}',
        closingMarker: 'END_LEGACY',
    });
    const literal = core.normalizeRegexRule({ ...old, mode: 'markers' });
    assert.equal(literal.entryTemplate, '[LOOK:{{name}}]\n{{outfit}}\n[/LOOK]');
    assert.equal(literal.closingMarker, '[/WARDROBE]');
    const back = core.normalizeRegexRule({ ...literal, mode: 'regex' });
    assert.equal(back.entryTemplate, '[[{{name}}]]:{{outfit}}');
    assert.equal(back.closingMarker, 'END_LEGACY');
});

test('legacy regex still recognizes its existing syntax', () => {
    const rule = core.normalizeRegexRule(core.WARDROBE_RULE_DEFAULTS);
    const entries = execute('scanMany', rule, {
        texts: [{ key: 3, text: '⟦ОДЕЖДА:Ada⟧ striped shirt\n⟦/ГАРДЕРОБ⟧' }],
    }).entries;
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'Ada');
});

test('missing name placeholder fails validation', () => {
    assert.throws(() => core.normalizeRegexRule({
        ...core.DEFAULT_SETTINGS.regex,
        startMarker: '[LOOK:Bob]',
    }), /переменная/);
});

test('template files have the block ending needed by configured markers', async () => {
    const text = await readFile(new URL('../templates/wardrobe-post.txt', import.meta.url), 'utf8');
    const html = await readFile(new URL('../templates/wardrobe-post.html', import.meta.url), 'utf8');
    const website = JSON.parse(await readFile(new URL('../templates/wardrobe.json', import.meta.url), 'utf8'));
    assert.match(text, /\[\/WARDROBE\]/);
    assert.match(html, /<\/section>/);
    assert.deepEqual(Object.keys(website).sort(), ['cats', 'chars', 'items', 'looks']);
});
