const DATA_FILE = 'wardrobe.json';

function cleanText(value, limit = 12_000) {
    return String(value ?? '').replace(/\u0000/g, '').slice(0, limit).trim();
}

function normalizeBaseUrl(value) {
    let raw = String(value || '').trim();
    if (!raw) return '';
    if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
    let url;
    try { url = new URL(raw); }
    catch { throw new Error('Проверь адрес сайта. Пример: https://логин.github.io/wardrobe/'); }
    url.hash = '';
    url.search = '';
    if (/\.json$/i.test(url.pathname)) url.pathname = url.pathname.replace(/[^/]+$/, '');
    else if (/\/index\.html?$/i.test(url.pathname)) url.pathname = url.pathname.replace(/index\.html?$/i, '');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
}

function parseWebsiteJson(value) {
    try { return normalizeWebsiteData(typeof value === 'string' ? JSON.parse(value.replace(/^\uFEFF/, '')) : value); }
    catch { throw new Error('Файл wardrobe.json повреждён или содержит не JSON. Исправь файл на GitHub и попробуй снова.'); }
}

export function websiteUrls(value) {
    const site = normalizeBaseUrl(value);
    return { site, data: site ? new URL(DATA_FILE, site).href : '' };
}

export function normalizeWebsiteData(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        chars: Array.isArray(source.chars) ? source.chars.filter(item => item && item.id) : [],
        cats: Array.isArray(source.cats) ? source.cats.filter(item => item && item.id) : [],
        items: Array.isArray(source.items) ? source.items.filter(item => item && item.id) : [],
        looks: Array.isArray(source.looks) ? source.looks.filter(item => item && item.id) : [],
    };
}

export function websiteLooks(value) {
    return normalizeWebsiteData(value).looks.map(item => ({
        id: String(item.id),
        name: cleanText(item.name, 120) || 'Без имени',
        desc: cleanText(item.desc).replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'),
    }));
}

function apiUrl(user, repo, path) {
    const owner = encodeURIComponent(String(user || '').trim());
    const name = encodeURIComponent(String(repo || '').trim());
    const file = String(path || '').split('/').map(encodeURIComponent).join('/');
    if (!owner || !name || !file) throw new Error('Укажи логин GitHub и название репозитория.');
    return `https://api.github.com/repos/${owner}/${name}/contents/${file}`;
}

function githubHeaders(token) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (String(token || '').trim()) headers.Authorization = `Bearer ${String(token).trim()}`;
    return headers;
}

function decodeBase64Utf8(value) {
    const binary = atob(String(value || '').replace(/\s/g, ''));
    const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(String(value || ''));
    let binary = '';
    const step = 0x8000;
    for (let index = 0; index < bytes.length; index += step) binary += String.fromCharCode(...bytes.subarray(index, index + step));
    return btoa(binary);
}

async function responseError(response, fallback) {
    let detail = '';
    try { detail = cleanText((await response.json())?.message, 500); } catch { /* response is not JSON */ }
    if (response.status === 401) return new Error('GitHub отклонил токен. Проверь его или создай новый.');
    if (response.status === 403) return new Error('У токена нет права Contents: Read and write для этого репозитория.');
    if (response.status === 404) return new Error('GitHub не нашёл репозиторий или файл. Проверь логин, название и доступ токена.');
    return new Error(detail || fallback || `GitHub вернул ошибку ${response.status}.`);
}

async function readGithubFile(config, path, fetchImpl = fetch, optional = false) {
    const response = await fetchImpl(apiUrl(config.githubUser, config.githubRepo, path), { headers: githubHeaders(config.token), signal: config.signal });
    if (optional && response.status === 404) return null;
    if (!response.ok) throw await responseError(response, `Не удалось прочитать ${path}.`);
    const file = await response.json();
    return { sha: file.sha, text: decodeBase64Utf8(file.content), file };
}

async function putGithubFile(config, path, content, message, sha = undefined, fetchImpl = fetch) {
    const body = { message, content };
    if (sha) body.sha = sha;
    const response = await fetchImpl(apiUrl(config.githubUser, config.githubRepo, path), {
        method: 'PUT',
        headers: { ...githubHeaders(config.token), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: config.signal,
    });
    if (!response.ok) throw await responseError(response, `Не удалось записать ${path}.`);
    return response.json();
}

export async function loadWebsiteData(config, fetchImpl = fetch) {
    const token = String(config?.token || '').trim();
    const user = String(config?.githubUser || '').trim();
    const repo = String(config?.githubRepo || '').trim();
    if (token && user && repo) {
        const file = await readGithubFile(config, DATA_FILE, fetchImpl);
        return parseWebsiteJson(file.text);
    }
    const { data } = websiteUrls(config?.siteUrl);
    if (!data) throw new Error('Укажи адрес сайта-гардероба.');
    const separator = data.includes('?') ? '&' : '?';
    const response = await fetchImpl(`${data}${separator}t=${Date.now()}`, { cache: 'no-store', signal: config?.signal });
    if (!response.ok) throw new Error(`Не удалось загрузить wardrobe.json: ${response.status}.`);
    let body;
    try { body = await response.json(); }
    catch { throw new Error('Сайт вернул повреждённый wardrobe.json.'); }
    return parseWebsiteJson(body);
}

function comparable(value) {
    return cleanText(value, 120).normalize('NFC').toLocaleLowerCase().replace(/[’']/gu, "'");
}

function safeId(prefix, value) {
    const tail = String(value || '').replace(/[^a-z\d_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(-72);
    return `${prefix}${tail || Date.now()}`;
}

export function imagePayload(dataUrl) {
    const match = String(dataUrl || '').match(/^data:image\/(png|jpe?g|webp|gif);base64,([a-z\d+/=]+)$/i);
    if (!match) throw new Error('У наряда нет подходящей обложки. Добавь PNG, JPEG, WebP или GIF.');
    const type = match[1].toLowerCase().replace('jpeg', 'jpg');
    return { extension: type, content: match[2] };
}

export function addOutfitToWebsiteData(data, { outfit, subject, shelfName, imagePath }) {
    const next = normalizeWebsiteData(data);
    const subjectName = cleanText(subject?.name, 120);
    const shelf = cleanText(shelfName, 120);
    if (!subjectName) throw new Error('У наряда не выбран персонаж или персона.');
    if (!shelf) throw new Error('Введи название полки на сайте.');
    const now = Date.now();
    let character = next.chars.find(item => comparable(item.name) === comparable(subjectName));
    if (!character) {
        character = { id: safeId('ch', subject?.id || now), name: subjectName, desc: '', img: '' };
        next.chars.push(character);
    }
    let category = next.cats.find(item => String(item.char) === String(character.id) && comparable(item.name) === comparable(shelf));
    if (!category) {
        category = { id: safeId('c', `${outfit?.id || now}-${now}`), name: shelf, char: character.id };
        next.cats.push(category);
    }
    const id = safeId('iness-', outfit?.id || now);
    const item = {
        id,
        cat: category.id,
        desc: cleanText(outfit?.description),
        img: imagePath,
        fav: outfit?.favorite === true,
    };
    const existingIndex = next.items.findIndex(entry => String(entry.id) === id);
    if (existingIndex >= 0) next.items[existingIndex] = item;
    else next.items.unshift(item);
    return { data: next, itemId: id, characterId: character.id, categoryId: category.id };
}

export function addLibraryLookToWebsiteData(data, look) {
    const next = normalizeWebsiteData(data);
    const id = cleanText(look?.id, 160);
    const name = cleanText(look?.name, 120);
    const desc = cleanText(look?.desc);
    if (!id || !name || !desc) throw new Error('У записи библиотеки должны быть имя и заполненная внешность.');
    const names = new Set([name, ...(Array.isArray(look.aliases) ? look.aliases : [])].map(comparable).filter(Boolean));
    const matches = next.looks.map((item, index) => ({ item, index })).filter(({ item }) => String(item.id) === id || names.has(comparable(item.name)));
    const record = { ...(matches[0]?.item || {}), id, name, desc };
    if (matches.length) {
        const matched = new Set(matches.map(({ index }) => index));
        next.looks = next.looks.filter((_, index) => !matched.has(index));
        next.looks.unshift(record);
    } else next.looks.unshift(record);
    return { data: next, lookId: id, updated: matches.length > 0 };
}

export async function exportOutfitToWebsite(config, payload, fetchImpl = fetch) {
    if (!String(config?.token || '').trim()) throw new Error('Введи токен GitHub в разделе «Сайт».');
    const image = imagePayload(payload?.outfit?.images?.[0]?.dataUrl);
    const current = await readGithubFile(config, DATA_FILE, fetchImpl, true);
    const data = current ? parseWebsiteJson(current.text) : normalizeWebsiteData({});
    const stamp = Date.now();
    const imagePath = `images/${safeId('ness-', payload.outfit.id)}-${stamp}.${image.extension}`;
    await putGithubFile(config, imagePath, image.content, `Add outfit image ${payload.outfit.id || stamp}`, undefined, fetchImpl);
    const merged = addOutfitToWebsiteData(data, { ...payload, imagePath });
    await putGithubFile(config, DATA_FILE, encodeBase64Utf8(`${JSON.stringify(merged.data, null, 1)}\n`), `Add outfit ${payload.outfit.name || payload.outfit.id || stamp}`, current?.sha, fetchImpl);
    return { ...merged, imagePath };
}

export async function exportLibraryLookToWebsite(config, look, fetchImpl = fetch) {
    if (!String(config?.token || '').trim()) throw new Error('Введи токен GitHub в разделе «Библиотека».');
    const current = await readGithubFile(config, DATA_FILE, fetchImpl, true);
    const data = current ? parseWebsiteJson(current.text) : normalizeWebsiteData({});
    const merged = addLibraryLookToWebsiteData(data, look);
    await putGithubFile(config, DATA_FILE, encodeBase64Utf8(`${JSON.stringify(merged.data, null, 1)}\n`), `${merged.updated ? 'Update' : 'Add'} appearance ${look.name}`, current?.sha, fetchImpl);
    return merged;
}
