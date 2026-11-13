export const NESS_LIBRARY_KEY = 'sp_ness_master_library_v1';

const BODY_SECTIONS = Object.freeze([
    ['thighMarks', 'THIGH MARKS'],
    ['kneeMarks', 'KNEE MARKS'],
    ['shinMarks', 'SHIN MARKS'],
    ['shoulderMarks', 'SHOULDER MARKS'],
    ['forearmMarks', 'FOREARM MARKS'],
    ['nudeUpper', 'NUDE UPPER'],
    ['nudeLower', 'NUDE LOWER'],
]);

function cleanText(value, limit = 12_000) {
    return String(value ?? '').replace(/\u0000/g, '').slice(0, limit).trim();
}

function commaTags(value) {
    return cleanText(value)
        .split(/[,;\r\n]+/u)
        .map(part => part.replace(/\s+/gu, ' ').trim())
        .filter(Boolean)
        .join(', ');
}

export function formatLibraryAppearance(entry) {
    const blocks = [];
    const base = commaTags(entry?.base);
    if (base) blocks.push(base);
    for (const [key, heading] of BODY_SECTIONS) {
        const tags = commaTags(entry?.[key]);
        if (tags) blocks.push(`${heading}\n${tags}`);
    }
    return blocks.join('\n\n');
}

function parseLibrary(raw) {
    if (!raw) return null;
    try { return typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw; }
    catch { throw new Error('NESS Library сохранена в повреждённом формате. Открой её редактор и сохрани ещё раз.'); }
}

export function readNessLibrary(context) {
    const globalVariables = context?.extensionSettings?.variables?.global || context?.extension_settings?.variables?.global;
    const data = parseLibrary(globalVariables?.[NESS_LIBRARY_KEY]);
    if (!data) return { available: false, records: [] };
    if (data.version !== 1 || !data.personas || !data.characters || Array.isArray(data.personas) || Array.isArray(data.characters)) {
        throw new Error('NESS Library имеет неподдерживаемый формат. Нужна библиотека версии 1.');
    }
    const records = [];
    for (const [group, type] of [['personas', 'persona'], ['characters', 'character']]) {
        for (const [libraryId, entry] of Object.entries(data[group])) {
            if (!entry || typeof entry !== 'object') continue;
            const name = cleanText(entry.name, 120);
            const desc = formatLibraryAppearance(entry);
            if (!name || !desc) continue;
            records.push({
                id: `ness_${libraryId}`,
                libraryId,
                name,
                desc,
                type,
                aliases: Array.isArray(entry.aliases) ? entry.aliases.map(value => cleanText(value, 120)).filter(Boolean) : [],
            });
        }
    }
    records.sort((left, right) => left.name.localeCompare(right.name));
    return { available: true, records, savedAt: data.savedAt || '', revision: Number(data.catalogRevision) || 0 };
}

export function splitWebsiteLooks(libraryRecords, websiteRecords) {
    const ids = new Set(libraryRecords.map(record => record.id));
    const names = new Set(libraryRecords.flatMap(record => [record.name, ...(record.aliases || [])]).map(value => cleanText(value, 120).normalize('NFC').toLocaleLowerCase()));
    return websiteRecords.filter(record => !ids.has(record.id) && !names.has(cleanText(record.name, 120).normalize('NFC').toLocaleLowerCase()));
}
