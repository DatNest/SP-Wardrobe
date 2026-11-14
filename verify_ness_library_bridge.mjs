import assert from 'node:assert/strict';
import { formatLibraryAppearance, readNessLibrary, splitWebsiteLooks } from './ness_library_bridge.js';

const entry = {
    name: 'Ада',
    base: '1girl; long black hair, blue eyes; ',
    thighMarks: 'floral tattoo; small scar',
    kneeMarks: '',
    shinMarks: 'gold markings',
    shoulderMarks: 'sun pattern, freckles',
    forearmMarks: '',
    nudeUpper: 'upper detail one; upper detail two',
    nudeLower: 'lower detail',
};

assert.equal(formatLibraryAppearance(entry), `1girl, long black hair, blue eyes

THIGH MARKS
floral tattoo, small scar

SHIN MARKS
gold markings

SHOULDER MARKS
sun pattern, freckles

NUDE UPPER
upper detail one, upper detail two

NUDE LOWER
lower detail`);

const library = {
    version: 1,
    savedAt: '2026-11-14T00:00:00.000Z',
    catalogRevision: 4,
    personas: { ada: { ...entry, aliases: ['Ada'] } },
    characters: { bob: { name: 'Боб', base: '1boy, blond hair', aliases: [] } },
};
const context = { extensionSettings: { variables: { global: { sp_ness_master_library_v1: JSON.stringify(library) } } } };
const result = readNessLibrary(context);
assert.strictEqual(readNessLibrary(context), result, 'unchanged serialized library uses the parsed cache');
assert.equal(result.available, true);
assert.equal(result.records.length, 2);
assert.equal(result.records.find(record => record.libraryId === 'ada').id, 'ness_ada');
assert.match(result.records.find(record => record.libraryId === 'ada').desc, /NUDE UPPER/);
assert.deepEqual(splitWebsiteLooks(result.records, [
    { id: 'old', name: 'Ada', desc: 'old copy' },
    { id: 'site-only', name: 'Сайт', desc: 'only here' },
]).map(record => record.id), ['site-only']);

console.log('NESS Library bridge verification: OK');
