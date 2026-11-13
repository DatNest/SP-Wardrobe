import { eventSource, event_types, chat_metadata, saveMetadata } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../popup.js';
import {
    CHAT_META_KEY,
    DEFAULT_GENERATION_PROMPT,
    DEFAULT_SCAN_PROMPT,
    DEFAULT_SETTINGS,
    EXTENSION_KEY,
    clone,
    clampNumber,
    comparableName,
    emptyOutfit,
    escapeHtml,
    fillPrompt,
    makeExport,
    normalizeChatState,
    normalizeColor,
    normalizeName,
    normalizeOutfit,
    normalizeRegexRule,
    normalizeSettings,
    normalizeSubject,
    normalizeTag,
    readExport,
    runWardrobeRegex,
    subjectNames,
    uid,
    validateRegexRule,
} from './core.js';
import { generateOutfit, listConnectionProfiles, testConnectionProfile } from './generation.js';
import { imageFileFromUrl, prepareImage } from './images.js';
import { exportLibraryLookToWebsite, exportOutfitToWebsite, loadWebsiteData, websiteLooks } from './site_bridge.js';
import { getWebsiteToken, setWebsiteToken } from './site_token.js';
import { readNessLibrary, splitWebsiteLooks } from './ness_library_bridge.js';
import {
    DEFAULT_LOOK_TEMPLATE,
    extBlockLookState,
    listExtBlockTargets,
    pickExtBlockTarget,
    removeWebsiteLook,
    sendWebsiteLook,
    toggleWebsiteLook,
} from './extblocks_bridge.js';

const GALLERY_FIRST = 24;
const GALLERY_MORE = 16;
const NS = '.nessWardrobe';
const SETTINGS_TABS = [
    { id: 'subjects', label: 'Персонажи', icon: 'fa-users' },
    { id: 'tags', label: 'Теги', icon: 'fa-tags' },
    { id: 'connection', label: 'Подключение', icon: 'fa-plug' },
    { id: 'website', label: 'Библиотека', icon: 'fa-book-open' },
    { id: 'insertion', label: 'Вставка', icon: 'fa-code' },
    { id: 'scan', label: 'Сканирование', icon: 'fa-magnifying-glass' },
    { id: 'generation', label: 'Генерация', icon: 'fa-wand-magic-sparkles' },
    { id: 'transfer', label: 'Перенос', icon: 'fa-box-archive' },
];

let settings;
let managerPopup = null;
let galleryObserver = null;
let searchTimer = null;
let generationController = null;
let operationRevision = 0;
let imageRevision = 0;
let mainModule = null;
let applyBusy = false;
let connectionProfiles = [];
let profilesLoaded = false;
let profilesLoading = false;
let profileTestController = null;
let imageController = null;
let siteController = null;

const ui = {
    view: 'gallery',
    search: '',
    subjectFilter: '',
    tagFilters: new Set(),
    favoriteOnly: false,
    galleryMode: 'library',
    activeEntries: [],
    activePostKey: null,
    activeSelected: 0,
    activeLoading: false,
    activeNeedsRefresh: true,
    activeStatus: '',
    galleryOffset: 0,
    createMode: 'write',
    settingsTab: 'subjects',
    draft: null,
    subjectCreator: null,
    tagSearch: '',
    generator: { target: '', wishes: '', avoid: '' },
    undo: null,
    status: '',
    connectionStatus: '',
    websiteLooks: [],
    websiteLoaded: false,
    websiteStatus: '',
    websiteLoading: false,
};

function getSettingsContainer() {
    const context = getContext();
    return context.extensionSettings || context.extension_settings;
}

function loadSettings() {
    const container = getSettingsContainer();
    if (!container) throw new Error('SillyTavern не предоставил хранилище настроек.');
    settings = normalizeSettings(container[EXTENSION_KEY] || DEFAULT_SETTINGS);
    container[EXTENSION_KEY] = settings;
    commitSettings();
}

function commitSettings() {
    const container = getSettingsContainer();
    if (!container || !settings) return;
    container[EXTENSION_KEY] = settings;
    const context = getContext();
    if (typeof context.saveSettingsDebounced === 'function') context.saveSettingsDebounced();
    else console.warn('[NESS Wardrobe] saveSettingsDebounced is unavailable');
}

function hasOpenChat(context = getContext()) {
    const present = value => value !== undefined && value !== null && value !== '' && value !== -1;
    let chatId = context.chatId;
    try { if (!present(chatId) && typeof context.getCurrentChatId === 'function') chatId = context.getCurrentChatId(); } catch { /* older builds */ }
    return present(chatId) || present(context.groupId) || present(context.characterId) || (Array.isArray(context.chat) && context.chat.length > 0);
}

function getChatState(create = true) {
    let context = getContext();
    if (!hasOpenChat(context)) return null;
    let metadata = context.chatMetadata ?? chat_metadata;
    if (!metadata && create) {
        const initial = { [CHAT_META_KEY]: { pinnedSubjectIds: [] } };
        if (typeof context.updateChatMetadata === 'function') context.updateChatMetadata(initial, false);
        context = getContext();
        metadata = context.chatMetadata ?? chat_metadata;
    }
    if (!metadata) return null;
    const valid = new Set(settings.subjects.map(subject => subject.id));
    const state = normalizeChatState(metadata[CHAT_META_KEY], valid);
    if (create || metadata[CHAT_META_KEY]) metadata[CHAT_META_KEY] = state;
    return state;
}

function saveChatState() {
    const context = getContext();
    if (typeof context.saveMetadata === 'function') context.saveMetadata();
    else if (typeof context.saveMetadataDebounced === 'function') context.saveMetadataDebounced();
    else if (typeof saveMetadata === 'function') saveMetadata();
    else console.warn('[NESS Wardrobe] chat metadata saving is unavailable');
}

function findSubject(id) {
    return settings.subjects.find(subject => subject.id === id);
}

function findTag(id) {
    return settings.tags.find(tag => tag.id === id);
}

function findOutfit(id) {
    return settings.outfits.find(outfit => outfit.id === id);
}

function floatingDeviceKey() {
    return globalThis.matchMedia?.('(max-width: 600px)')?.matches ? 'mobile' : 'desktop';
}

function currentFloatingSettings() {
    return settings.floating[floatingDeviceKey()];
}

function notify(message, type = 'info') {
    if (typeof toastr !== 'undefined' && typeof toastr[type] === 'function') {
        toastr[type](message, 'NESS Wardrobe', { timeOut: 3200, positionClass: 'toast-top-center' });
    }
}

function subjectIcon(type) {
    return type === 'persona' ? 'fa-user' : 'fa-diamond';
}

function subjectTypeLabel(type) {
    return type === 'persona' ? 'Персона' : 'Персонаж';
}

function selectedConnectionLabel() {
    const selected = settings.connection.profileId;
    if (selected === 'auto') return 'выбранный в SillyTavern';
    if (selected === 'direct') return 'текущее подключение';
    return connectionProfiles.find(profile => profile.id === selected)?.name || selected;
}

function colorStyle(color) {
    return `--nw-tag-color:${normalizeColor(color)}`;
}

function subjectChip(subject, options = {}) {
    const selected = options.selected ? ' active' : '';
    const pinned = options.pinned ? '<i class="fa-solid fa-thumbtack nw-pin-mark" aria-hidden="true"></i>' : '';
    return `<button class="menu_button nw-chip nw-subject-chip nw-${subject.type}${selected}" style="${colorStyle(subject.color)}" data-action="filter-subject" data-subject-id="${escapeHtml(subject.id)}" title="${escapeHtml(subjectTypeLabel(subject.type))}: ${escapeHtml(subject.name)}"><i class="fa-solid ${subjectIcon(subject.type)}" aria-hidden="true"></i><span>${escapeHtml(subject.name)}</span>${pinned}</button>`;
}

function tagChip(tag, selected = false, action = 'filter-tag') {
    return `<button class="menu_button nw-chip nw-tag-pill nw-tag-chip${selected ? ' active' : ''}" style="${colorStyle(tag.color)}" data-action="${action}" data-tag-id="${escapeHtml(tag.id)}"><i class="fa-solid fa-tag" aria-hidden="true"></i><span>${escapeHtml(tag.name)}</span></button>`;
}

function panelHtml() {
    return `<div id="nw-panel" class="nw-panel" aria-label="NESS Wardrobe">
        <header class="nw-header"><h3 class="nw-brand"><span aria-hidden="true">👗</span><span>Гардероб</span></h3><span id="nw-header-status" class="nw-header-status" role="status" aria-live="polite"></span></header>
        <nav class="nw-nav" aria-label="Разделы">
            <button class="menu_button" data-view="gallery"><i class="fa-solid fa-grip"></i><span>Гардероб</span></button>
            <button class="menu_button" data-view="create"><i class="fa-solid fa-plus"></i><span>Создать наряд</span></button>
            <button class="menu_button" data-view="settings"><i class="fa-solid fa-gear"></i><span>Настройки</span></button>
        </nav>
        <main id="nw-content" class="nw-content"></main>
    </div>`;
}

function shellHtml() {
    return '<button id="nw-mini" class="menu_button nw-mini" aria-label="Открыть гардероб" title="Гардероб"><i class="fa-solid fa-shirt" aria-hidden="true"></i></button>';
}

function settingsDrawerHtml() {
    return `<div id="nw-extension-settings" class="nw-extension-settings"><div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>👗 NESS Wardrobe</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content"><div class="nw-drawer-body">
            <label class="checkbox_label"><input id="nw-show-floating" type="checkbox"><span>Показывать плавающую кнопку на этом устройстве</span></label>
            <small>Библиотека хранится в настройках SillyTavern, закрепления — в текущем чате.</small>
            <button class="menu_button menu_button_icon" data-action="open"><i class="fa-solid fa-shirt"></i><span>Открыть гардероб</span></button>
        </div></div>
    </div></div>`;
}

function emptyHtml(title, text) {
    return `<div class="nw-empty"><strong>${escapeHtml(title)}</strong><small>${escapeHtml(text)}</small></div>`;
}

function currentChatName() {
    try {
        const context = getContext();
        if (context.groupId) return context.groups?.find(group => String(group.id) === String(context.groupId))?.name || 'Групповой чат';
        return context.characters?.[context.characterId]?.name || 'Текущий чат';
    } catch { return 'Текущий чат'; }
}

function recentPostTexts(context, depth) {
    const texts = [];
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    for (let index = chat.length - 1, checked = 0; index >= 0 && checked < depth; index--) {
        const message = chat[index];
        if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes.trim()) continue;
        checked++;
        texts.push({ key: index, text: message.mes });
    }
    return texts;
}

function subjectForActiveName(name) {
    const wanted = comparableName(name);
    return settings.subjects.find(subject => subjectNames(subject).some(candidate => comparableName(candidate) === wanted)) || null;
}

async function scanLatestWardrobePost() {
    const context = getContext();
    if (!hasOpenChat(context)) return { entries: [], key: null, hasMarker: false, checked: 0 };
    const rule = await validateRegexRule(settings.regex);
    const texts = recentPostTexts(context, rule.searchDepth);
    const result = await runWardrobeRegex({ operation: 'scanMany', texts, rule, closingMarker: rule.closingMarker });
    return { ...result, source: texts.find(item => item.key === result.key)?.text ?? null, checked: texts.length, rule, chatRef: context.chat, chatId: context.chatId };
}

function galleryModeTabsHtml() {
    return `<nav class="nw-gallery-mode-tabs" role="tablist" aria-label="Содержимое гардероба">
        <button class="menu_button${ui.galleryMode === 'library' ? ' active' : ''}" role="tab" aria-selected="${ui.galleryMode === 'library'}" data-gallery-mode="library"><i class="fa-solid fa-box-archive"></i><span>Сохранённые</span><small>${settings.outfits.length}</small></button>
        <button class="menu_button${ui.galleryMode === 'active' ? ' active' : ''}" role="tab" aria-selected="${ui.galleryMode === 'active'}" data-gallery-mode="active"><i class="fa-solid fa-message"></i><span>В активном посте</span><small>${ui.activeEntries.length}</small></button>
    </nav>`;
}

function activeOutfitsHtml() {
    if (ui.activeLoading) return `${galleryModeTabsHtml()}${emptyHtml('Ищу активный гардероб…', `Проверяю до ${settings.regex.searchDepth} последних постов.`)}`;
    if (!ui.activeEntries.length) {
        const text = ui.activeStatus || `В последних ${settings.regex.searchDepth} постах не найден блок гардероба с нарядами.`;
        return `${galleryModeTabsHtml()}<section class="nw-active-empty">${emptyHtml('Активных нарядов нет', text)}<button class="menu_button menu_button_icon" data-action="refresh-active"><i class="fa-solid fa-rotate"></i><span>Проверить снова</span></button></section>`;
    }
    const selectedIndex = Math.min(ui.activeSelected, ui.activeEntries.length - 1);
    const selected = ui.activeEntries[selectedIndex];
    const tabs = ui.activeEntries.map((entry, index) => `<div class="nw-active-tab${index === selectedIndex ? ' active' : ''}" role="presentation"><button class="menu_button" role="tab" aria-selected="${index === selectedIndex}" data-active-index="${index}"><span>${escapeHtml(entry.name)}</span></button><button class="menu_button" data-action="delete-active-outfit" data-active-index="${index}" aria-label="Удалить наряд ${escapeHtml(entry.name)}" title="Удалить"><i class="fa-solid fa-xmark"></i></button></div>`).join('');
    return `${galleryModeTabsHtml()}<section class="nw-active-workspace">
        <div class="nw-active-context"><div><small>Самый свежий блок среди проверенных постов</small><strong>Пост №${ui.activePostKey}</strong></div><button class="menu_button fa-fw" data-action="refresh-active" title="Обновить" aria-label="Обновить"><i class="fa-solid fa-rotate"></i></button></div>
        <nav class="nw-active-tabs" role="tablist" aria-label="Активные наряды">${tabs}</nav>
        <section class="nw-active-editor" role="tabpanel"><label><span>Для кого</span><input class="text_pole" value="${escapeHtml(selected.name)}" readonly></label><label><span>Описание одежды</span><textarea id="nw-active-outfit-description" class="text_pole" rows="9" maxlength="12000">${escapeHtml(selected.outfit)}</textarea></label><div class="nw-action-row"><button class="menu_button menu_button_icon nw-main-action" data-action="save-active-outfit"><i class="fa-solid fa-floppy-disk"></i><span>Сохранить в посте</span></button><button class="menu_button menu_button_icon" data-action="save-active-to-library"><i class="fa-solid fa-box-archive"></i><span>Сохранить как новый наряд</span></button></div><div class="nw-message" role="status">${escapeHtml(ui.activeStatus)}</div></section>
    </section>`;
}

function galleryViewHtml() {
    if (ui.galleryMode === 'active') return activeOutfitsHtml();
    const state = getChatState(false);
    const pinned = new Set(state?.pinnedSubjectIds || []);
    const orderedSubjects = [...settings.subjects].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || a.name.localeCompare(b.name));
    const subjectFilters = orderedSubjects.map(subject => subjectChip(subject, { selected: ui.subjectFilter === subject.id, pinned: pinned.has(subject.id) })).join('');
    const tags = settings.tags.map(tag => tagChip(tag, ui.tagFilters.has(tag.id))).join('');
    const undo = ui.undo ? `<button class="menu_button menu_button_icon" data-action="undo"><i class="fa-solid fa-rotate-left"></i><span>Отменить «${escapeHtml(ui.undo.outfitName)}»</span></button>` : '';
    return `${galleryModeTabsHtml()}<section class="nw-gallery-tools">
        <div class="nw-chat-line"><div><small>Закреплено в чате</small><strong>${escapeHtml(currentChatName())}</strong></div><button class="menu_button fa-fw" data-action="manage-pins" title="Закрепить персон и персонажей" aria-label="Закрепить персон и персонажей"><i class="fa-solid fa-thumbtack"></i></button></div>
        <div class="nw-search-row"><input id="nw-search" class="text_pole" type="search" placeholder="Найти наряд…" value="${escapeHtml(ui.search)}"><button class="menu_button fa-fw${ui.favoriteOnly ? ' active' : ''}" data-action="favorite-filter" title="Только избранное" aria-label="Только избранное"><i class="fa-solid fa-star"></i></button></div>
        <div class="nw-filter-label"><span>Персоны и персонажи</span><button class="menu_button nw-clear-filter${ui.subjectFilter ? '' : ' active'}" data-action="clear-subject">Все</button></div>
        <div class="nw-filter-strip" aria-label="Фильтр по персонажам">${subjectFilters || '<small>Создай персону или персонажа в настройках.</small>'}</div>
        <div class="nw-filter-label"><span>Теги</span>${ui.tagFilters.size ? '<button class="menu_button nw-clear-filter" data-action="clear-tags">Сбросить</button>' : ''}</div>
        <div class="nw-filter-strip" aria-label="Фильтр по тегам">${tags || '<small>Теги пока не созданы.</small>'}</div>
        <div id="nw-gallery-message" class="nw-message" role="status" aria-live="polite">${escapeHtml(ui.status)}</div>
        ${undo ? `<div class="nw-undo">${undo}</div>` : ''}
    </section>
    <section id="nw-gallery-grid" class="nw-gallery-grid" aria-label="Наряды"></section>`;
}

function filteredOutfits() {
    const query = comparableName(ui.search);
    return settings.outfits.filter(outfit => {
        if (ui.subjectFilter && outfit.subjectId !== ui.subjectFilter) return false;
        if (ui.favoriteOnly && !outfit.favorite) return false;
        if (ui.tagFilters.size && ![...ui.tagFilters].every(id => outfit.tagIds.includes(id))) return false;
        if (!query) return true;
        const subject = findSubject(outfit.subjectId);
        const haystack = comparableName([outfit.name, outfit.description, subject?.name, ...outfit.tagIds.map(id => findTag(id)?.name || '')].join(' '));
        return haystack.includes(query);
    }).sort((a, b) => Number(b.favorite) - Number(a.favorite) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function outfitCardHtml(outfit) {
    const subject = findSubject(outfit.subjectId);
    const image = outfit.images[0]?.dataUrl;
    const tags = outfit.tagIds.slice(0, 3).map(id => findTag(id)).filter(Boolean);
    const imageHtml = image ? `<img src="${image}" alt="" loading="lazy" decoding="async">` : '<span class="nw-placeholder" aria-hidden="true">👗</span>';
    return `<article class="nw-outfit-card" data-outfit-id="${escapeHtml(outfit.id)}">
        <button class="nw-outfit-apply" data-action="apply-outfit" data-outfit-id="${escapeHtml(outfit.id)}" ${outfit.description ? '' : 'disabled'} aria-label="Применить наряд ${escapeHtml(outfit.name)}">
            <span class="nw-outfit-image">${imageHtml}</span>
            <span class="nw-outfit-copy"><strong>${escapeHtml(outfit.name)}</strong>${subject ? `<small><i class="fa-solid ${subjectIcon(subject.type)}"></i> ${escapeHtml(subject.name)}</small>` : '<small>Без привязки</small>'}</span>
        </button>
        <div class="nw-card-tags">${tags.map(tag => `<span class="nw-card-tag nw-tag-pill" style="${colorStyle(tag.color)}"><i class="fa-solid fa-tag" aria-hidden="true"></i><span>${escapeHtml(tag.name)}</span></span>`).join('')}</div>
        <div class="nw-card-actions"><button class="menu_button fa-fw${outfit.favorite ? ' active' : ''}" data-action="toggle-favorite" data-outfit-id="${escapeHtml(outfit.id)}" aria-label="Избранное" title="Избранное"><i class="fa-solid fa-star"></i></button><button class="menu_button fa-fw" data-action="export-outfit-site" data-outfit-id="${escapeHtml(outfit.id)}" aria-label="Отправить на сайт" title="Отправить на сайт"><i class="fa-solid fa-cloud-arrow-up"></i></button><button class="menu_button fa-fw" data-action="edit-outfit" data-outfit-id="${escapeHtml(outfit.id)}" aria-label="Редактировать" title="Редактировать"><i class="fa-solid fa-pen"></i></button></div>
    </article>`;
}

function disposeGalleryObserver() {
    galleryObserver?.disconnect();
    galleryObserver = null;
}

function renderGalleryGrid(reset = true) {
    const grid = document.getElementById('nw-gallery-grid');
    if (!grid) return;
    const outfits = filteredOutfits();
    disposeGalleryObserver();
    if (reset) {
        ui.galleryOffset = 0;
        grid.replaceChildren();
    }
    if (!outfits.length) {
        grid.innerHTML = emptyHtml(settings.outfits.length ? 'Ничего не найдено' : 'Гардероб пуст', settings.outfits.length ? 'Сбрось часть фильтров или измени поиск.' : 'Создай первый наряд во второй вкладке.');
        return;
    }
    const amount = ui.galleryOffset ? GALLERY_MORE : GALLERY_FIRST;
    const end = Math.min(outfits.length, ui.galleryOffset + amount);
    grid.insertAdjacentHTML('beforeend', outfits.slice(ui.galleryOffset, end).map(outfitCardHtml).join(''));
    ui.galleryOffset = end;
    if (end >= outfits.length) return;
    const sentinel = document.createElement('div');
    sentinel.className = 'nw-gallery-sentinel';
    sentinel.setAttribute('aria-hidden', 'true');
    grid.appendChild(sentinel);
    if (typeof IntersectionObserver === 'function') {
        galleryObserver = new IntersectionObserver(entries => {
            if (!entries.some(entry => entry.isIntersecting)) return;
            sentinel.remove();
            renderGalleryGrid(false);
        }, { root: document.getElementById('nw-content'), rootMargin: '240px' });
        galleryObserver.observe(sentinel);
    } else {
        const button = document.createElement('button');
        button.className = 'menu_button nw-load-more';
        button.dataset.action = 'load-more';
        button.textContent = 'Показать ещё';
        sentinel.replaceWith(button);
    }
}

function ensureDraft() {
    if (!ui.draft) {
        const state = getChatState(false);
        ui.draft = emptyOutfit(state?.pinnedSubjectIds?.[0] || settings.subjects[0]?.id || '');
    }
    return ui.draft;
}

function captureSubjectCreator() {
    if (ui.subjectCreator) {
        const name = document.getElementById('nw-inline-subject-name');
        const type = document.getElementById('nw-inline-subject-type');
        const color = document.getElementById('nw-inline-subject-color');
        if (name) ui.subjectCreator.name = name.value;
        if (type) ui.subjectCreator.type = type.value === 'persona' ? 'persona' : 'character';
        if (color) ui.subjectCreator.color = color.value;
    }
}

function inlineSubjectCreatorHtml() {
    const editor = ui.subjectCreator;
    if (!editor) return '';
    return `<section class="settingsSectionWrap nw-inline-creator" aria-label="Создание персоны или персонажа">
        <div class="nw-inline-creator-head"><div><small>${editor.assignToDraft ? 'Новая привязка для наряда' : 'Новая запись библиотеки'}</small><strong>Добавить персону или персонажа</strong></div><button class="menu_button fa-fw" data-action="cancel-inline-subject" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="nw-settings-grid"><label><span>Имя</span><input id="nw-inline-subject-name" class="text_pole" maxlength="120" placeholder="Например: Зуко" value="${escapeHtml(editor.name)}"></label><label><span>Кто это</span><select id="nw-inline-subject-type" class="text_pole"><option value="character" ${editor.type === 'character' ? 'selected' : ''}>Персонаж или NPC ◆</option><option value="persona" ${editor.type === 'persona' ? 'selected' : ''}>Персона пользователя ●</option></select></label><label class="nw-color-field"><span>Цвет метки</span><input id="nw-inline-subject-color" type="color" value="${escapeHtml(editor.color)}"></label></div>
        <div class="nw-aliases"><small>Другие имена <span>необязательно</span></small><div class="nw-alias-chips">${editor.aliases.map(alias => `<button class="menu_button nw-alias-chip nw-tag-pill" style="${colorStyle(editor.color)}" data-action="remove-inline-alias" data-alias="${escapeHtml(alias)}" title="Удалить имя ${escapeHtml(alias)}"><i class="fa-solid fa-user" aria-hidden="true"></i><span>${escapeHtml(alias)}</span><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`).join('')}<input id="nw-inline-alias-input" class="text_pole nw-alias-input" placeholder="Введи имя и нажми Enter"></div></div>
        <div class="nw-action-row"><button class="menu_button menu_button_icon" data-action="create-inline-subject"><i class="fa-solid fa-plus"></i><span>${editor.assignToDraft ? 'Добавить и выбрать' : 'Создать'}</span></button><button class="menu_button" data-action="cancel-inline-subject">Отмена</button></div>
        <div class="nw-message" role="status">${escapeHtml(editor.error || '')}</div>
    </section>`;
}

function captureDraft() {
    captureSubjectCreator();
    if (ui.view !== 'create' || !ui.draft) return;
    const name = document.getElementById('nw-outfit-name');
    const description = document.getElementById('nw-outfit-description');
    const subject = document.getElementById('nw-outfit-subject');
    if (name) ui.draft.name = name.value;
    if (description) ui.draft.description = description.value;
    if (subject) ui.draft.subjectId = subject.value;
    const target = document.getElementById('nw-generate-target');
    const wishes = document.getElementById('nw-generate-wishes');
    const avoid = document.getElementById('nw-generate-avoid');
    if (target) ui.generator.target = target.value;
    if (wishes) ui.generator.wishes = wishes.value;
    if (avoid) ui.generator.avoid = avoid.value;
}

function draftTagResultsHtml(query = ui.tagSearch) {
    const needle = comparableName(query);
    const matches = settings.tags.filter(tag => !needle || comparableName(tag.name).includes(needle));
    if (matches.length) return matches.map(tag => tagChip(tag, ui.draft?.tagIds.includes(tag.id), 'draft-tag')).join('');
    if (needle) return `<small>Тег «${escapeHtml(normalizeName(query))}» не найден. Нажми Enter, чтобы создать его.</small>`;
    return '<small>Начни вводить название — первый тег можно создать клавишей Enter.</small>';
}

function updateDraftTagResults(value) {
    ui.tagSearch = value;
    const results = document.getElementById('nw-draft-tag-results');
    if (results) results.innerHTML = draftTagResultsHtml(value);
}

function createViewHtml() {
    const draft = ensureDraft();
    const subjects = settings.subjects.map(subject => `<option value="${escapeHtml(subject.id)}" ${draft.subjectId === subject.id ? 'selected' : ''}>${subject.type === 'persona' ? '●' : '◆'} ${escapeHtml(subject.name)} — ${subjectTypeLabel(subject.type)}</option>`).join('');
    const images = draft.images.map((image, index) => `<article class="nw-image-preview" data-image-id="${escapeHtml(image.id)}"><img src="${image.dataUrl}" alt="${escapeHtml(index === 0 ? 'Обложка наряда' : 'Изображение шоукейса')}"><div><small>${index === 0 ? 'Обложка' : `Шоукейс ${index}`}</small>${index > 0 ? `<button class="menu_button" data-action="make-cover" data-image-id="${escapeHtml(image.id)}">Сделать обложкой</button>` : ''}<button class="menu_button fa-fw" data-action="remove-image" data-image-id="${escapeHtml(image.id)}" aria-label="Удалить изображение"><i class="fa-solid fa-trash"></i></button></div></article>`).join('');
    const generate = ui.createMode === 'generate' ? `<section class="settingsSectionWrap nw-generator">
        <label><span>Для кого создать наряд</span><input id="nw-generate-target" class="text_pole" list="nw-subject-names" maxlength="120" placeholder="Имя персонажа или NPC" value="${escapeHtml(ui.generator.target || findSubject(draft.subjectId)?.name || '')}"></label>
        <datalist id="nw-subject-names">${settings.subjects.map(subject => `<option value="${escapeHtml(subject.name)}"></option>`).join('')}</datalist>
        <label><span>Пожелания</span><textarea id="nw-generate-wishes" class="text_pole" rows="3" placeholder="Например: дорожный наряд для дождливой осени">${escapeHtml(ui.generator.wishes)}</textarea></label>
        <label><span>Чего избегать <small>необязательно</small></span><textarea id="nw-generate-avoid" class="text_pole" rows="2" placeholder="Например: яркие цвета, современная синтетика">${escapeHtml(ui.generator.avoid)}</textarea></label>
        <small>Профиль «${escapeHtml(selectedConnectionLabel())}» сначала проанализирует лорбук и последние два поста, затем создаст наряд. Результат останется черновиком.</small>
        <button class="menu_button menu_button_icon nw-main-action" data-action="generate-outfit"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Сгенерировать описание</span></button>
        <div id="nw-generation-status" class="nw-message" role="status" aria-live="polite"></div>
    </section>` : '<p class="nw-help nw-mode-hint">Заполни описание вручную. Оно будет вставляться в найденную группу одежды без дополнительных изменений.</p>';
    return `<section class="nw-create-head"><div class="nw-create-method"><small>Как подготовить описание</small><div class="nw-mode-switch" role="group" aria-label="Способ создания"><button class="menu_button${ui.createMode === 'write' ? ' active' : ''}" data-action="create-mode" data-mode="write" aria-pressed="${ui.createMode === 'write'}"><i class="fa-solid fa-pen"></i><span>Написать</span></button><button class="menu_button${ui.createMode === 'generate' ? ' active' : ''}" data-action="create-mode" data-mode="generate" aria-pressed="${ui.createMode === 'generate'}"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Сгенерировать</span></button></div></div><button class="menu_button menu_button_icon nw-new-draft" data-action="reset-draft"><i class="fa-solid fa-file-circle-plus"></i><span>Новый черновик</span></button></section>
        ${generate}
        <section class="nw-outfit-form">
            <section class="nw-form-card" aria-labelledby="nw-details-heading"><div class="nw-form-card-head"><div><strong id="nw-details-heading">Детали наряда</strong><small>Название, привязка и текст для поста</small></div></div><label><span>Название</span><input id="nw-outfit-name" class="text_pole" maxlength="120" value="${escapeHtml(draft.name)}"></label><label><span>Для кого этот наряд</span><div class="nw-field-row"><select id="nw-outfit-subject" class="text_pole"><option value="">Выбрать персону или персонажа…</option>${subjects}</select><button class="menu_button menu_button_icon" data-action="quick-subject"><i class="fa-solid fa-user-plus"></i><span>Добавить</span></button></div></label>${inlineSubjectCreatorHtml()}<label><span>Описание одежды</span><textarea id="nw-outfit-description" class="text_pole" rows="5" maxlength="12000" placeholder="Текст, который будет вставлен в пост">${escapeHtml(draft.description)}</textarea></label></section>
            <section class="nw-form-card nw-tag-picker" aria-labelledby="nw-tags-heading"><div class="nw-form-card-head"><div><strong id="nw-tags-heading">Теги</strong><small>Ищи существующий или введи новое название</small></div><small>Enter — выбрать или создать</small></div><label class="nw-tag-search"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i><input id="nw-tag-search" class="text_pole" type="search" maxlength="120" autocomplete="off" placeholder="Найти тег по названию…" value="${escapeHtml(ui.tagSearch)}"></label><div id="nw-draft-tag-results" class="nw-filter-strip nw-draft-tags" aria-live="polite">${draftTagResultsHtml()}</div></section>
            <section class="nw-form-card" aria-labelledby="nw-images-heading"><div class="nw-form-card-head"><div><strong id="nw-images-heading">Обложка и шоукейс</strong><small>До трёх изображений; первое станет обложкой</small></div><span class="nw-counter">${draft.images.length}/3</span></div><div class="nw-image-list">${images || '<small class="nw-media-empty">Изображения пока не добавлены.</small>'}</div><div class="nw-image-source-actions"><label class="menu_button nw-file-button${draft.images.length >= 3 ? ' disabled' : ''}"><i class="fa-solid fa-folder-open"></i><span>С устройства</span><input id="nw-image-files" type="file" accept="image/*" multiple hidden ${draft.images.length >= 3 ? 'disabled' : ''}></label><button class="menu_button menu_button_icon" data-action="add-image-url" ${draft.images.length >= 3 ? 'disabled' : ''}><i class="fa-solid fa-link"></i><span>По ссылке</span></button><button class="menu_button menu_button_icon" data-action="paste-image" ${draft.images.length >= 3 ? 'disabled' : ''}><i class="fa-solid fa-clipboard"></i><span>Из буфера</span></button></div><div id="nw-image-status" class="nw-message" role="status" aria-live="polite"></div></section>
            <div class="nw-form-actions nw-form-footer"><button class="menu_button menu_button_icon nw-main-action" data-action="save-outfit"><i class="fa-solid fa-floppy-disk"></i><span>Сохранить наряд</span></button>${settings.outfits.some(outfit => outfit.id === draft.id) ? `<button class="menu_button menu_button_icon" data-action="export-outfit-site" data-outfit-id="${escapeHtml(draft.id)}"><i class="fa-solid fa-cloud-arrow-up"></i><span>На сайт</span></button><button class="menu_button menu_button_icon" data-action="delete-outfit"><i class="fa-solid fa-trash"></i><span>Удалить</span></button>` : ''}</div>
        </section>`;
}

function subjectSettingsRow(subject) {
    return `<article class="nw-settings-row" data-subject-id="${escapeHtml(subject.id)}">
        <div class="nw-settings-row-head"><span class="nw-type-badge nw-${subject.type}" style="${colorStyle(subject.color)}"><i class="fa-solid ${subjectIcon(subject.type)}"></i>${subjectTypeLabel(subject.type)}</span><button class="menu_button fa-fw" data-action="delete-subject" aria-label="Удалить" title="Удалить"><i class="fa-solid fa-trash"></i></button></div>
        <div class="nw-settings-grid"><label><span>Имя</span><input class="text_pole" data-subject-field="name" maxlength="120" value="${escapeHtml(subject.name)}"></label><label><span>Тип</span><select class="text_pole" data-subject-field="type"><option value="character" ${subject.type === 'character' ? 'selected' : ''}>Персонаж</option><option value="persona" ${subject.type === 'persona' ? 'selected' : ''}>Персона</option></select></label><label class="nw-color-field"><span>Цвет</span><input type="color" data-subject-field="color" value="${escapeHtml(subject.color)}"></label></div>
        <div class="nw-aliases"><small>Другие имена для поиска в посте</small><div class="nw-alias-chips">${subject.aliases.map(alias => `<button class="menu_button nw-alias-chip nw-tag-pill" style="${colorStyle(subject.color)}" data-action="remove-alias" data-alias="${escapeHtml(alias)}" title="Удалить имя ${escapeHtml(alias)}"><i class="fa-solid fa-user" aria-hidden="true"></i><span>${escapeHtml(alias)}</span><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>`).join('')}<input class="text_pole nw-alias-input" placeholder="Введи имя и нажми Enter"></div></div>
    </article>`;
}

function tagSettingsRow(tag) {
    return `<article class="nw-settings-row nw-tag-settings-row" data-tag-id="${escapeHtml(tag.id)}"><span class="nw-color-dot" style="${colorStyle(tag.color)}"></span><input class="text_pole" data-tag-field="name" maxlength="120" value="${escapeHtml(tag.name)}"><input type="color" data-tag-field="color" value="${escapeHtml(tag.color)}"><button class="menu_button fa-fw" data-action="delete-tag" aria-label="Удалить тег" title="Удалить тег"><i class="fa-solid fa-trash"></i></button></article>`;
}

function connectionOptionsHtml() {
    const selected = settings.connection.profileId;
    const known = new Set(connectionProfiles.map(profile => profile.id));
    const missing = !['auto', 'direct'].includes(selected) && !known.has(selected)
        ? `<option value="${escapeHtml(selected)}" selected>Недоступный профиль: ${escapeHtml(selected)}</option>`
        : '';
    return `<option value="auto" ${selected === 'auto' ? 'selected' : ''}>Автоматически — выбранный профиль SillyTavern</option>
        <option value="direct" ${selected === 'direct' ? 'selected' : ''}>Текущее подключение без профиля</option>
        ${missing}${connectionProfiles.map(profile => `<option value="${escapeHtml(profile.id)}" ${selected === profile.id ? 'selected' : ''}>${escapeHtml(profile.name)}</option>`).join('')}`;
}

function selectedExtBlockTarget() {
    return pickExtBlockTarget(getContext(), settings.website.extBlockRef, settings.website.extBlockName);
}

function extBlockOptionsHtml() {
    const targets = listExtBlockTargets(getContext());
    const selected = selectedExtBlockTarget();
    if (!targets.length) return '<option value="">ExtBlocks не найден или в нём нет подходящих блоков</option>';
    return targets.map(target => `<option value="${escapeHtml(target.ref)}" ${selected?.ref === target.ref ? 'selected' : ''}>${escapeHtml(target.label)}</option>`).join('');
}

function currentNessLibrary() {
    try { return { ...readNessLibrary(getContext()), error: '' }; }
    catch (error) { return { available: false, records: [], error: String(error.message || error) }; }
}

function libraryLookIsOnWebsite(look) {
    const names = new Set([look.name, ...(look.aliases || [])].map(comparableName));
    return ui.websiteLooks.some(item => item.id === look.id || names.has(comparableName(item.name)));
}

function availableAppearance(id) {
    return currentNessLibrary().records.find(look => look.id === id) || ui.websiteLooks.find(look => look.id === id);
}

function websiteLookCardHtml(look, { library = false, onWebsite = false } = {}) {
    const target = selectedExtBlockTarget();
    const state = target ? extBlockLookState(target.block, look) : { present: false, disabled: false };
    const contextState = state.present ? `<span class="nw-site-look-state"><i class="fa-solid ${state.disabled ? 'fa-eye-slash' : 'fa-circle-check'}"></i>${state.disabled ? 'выключена' : 'в блоке'}</span>` : '';
    const siteState = library && ui.websiteLoaded ? `<span class="nw-site-look-state"><i class="fa-solid ${onWebsite ? 'fa-cloud' : 'fa-cloud-arrow-up'}"></i>${onWebsite ? 'на сайте' : 'ещё не на сайте'}</span>` : '';
    return `<article class="nw-site-look${state.disabled ? ' disabled' : ''}" data-look-id="${escapeHtml(look.id)}"><div class="nw-site-look-head"><div><strong>${escapeHtml(look.name)}</strong>${library ? `<small>${look.type === 'persona' ? 'Персона' : 'Персонаж'} · NESS Library</small>` : '<small>Только на сайте</small>'}</div><div class="nw-site-look-states">${siteState}${contextState}</div></div><div class="nw-site-look-desc">${look.desc ? escapeHtml(look.desc) : '<i>Описания пока нет</i>'}</div><div class="nw-action-row"><button class="menu_button menu_button_icon" data-action="site-look-send" data-look-id="${escapeHtml(look.id)}" ${look.desc && target ? '' : 'disabled'}><i class="fa-solid fa-paper-plane"></i><span>${state.present ? 'Обновить в блоке' : 'В Context Builder'}</span></button>${library ? `<button class="menu_button menu_button_icon" data-action="export-library-look-site" data-look-id="${escapeHtml(look.id)}"><i class="fa-solid fa-cloud-arrow-up"></i><span>${onWebsite ? 'Обновить сайт' : 'На сайт'}</span></button>` : ''}${state.present ? `<button class="menu_button fa-fw" data-action="site-look-toggle" data-look-id="${escapeHtml(look.id)}" title="${state.disabled ? 'Включить' : 'Выключить'}"><i class="fa-solid ${state.disabled ? 'fa-eye' : 'fa-eye-slash'}"></i></button><button class="menu_button fa-fw" data-action="site-look-remove" data-look-id="${escapeHtml(look.id)}" title="Убрать из блока"><i class="fa-solid fa-trash"></i></button>` : ''}</div></article>`;
}

function websiteSettingsPaneHtml() {
    const website = settings.website;
    const library = currentNessLibrary();
    const libraryLooks = library.records.map(look => websiteLookCardHtml(look, { library: true, onWebsite: libraryLookIsOnWebsite(look) })).join('');
    const websiteOnly = splitWebsiteLooks(library.records, ui.websiteLooks);
    const websiteOnlyLooks = websiteOnly.map(look => websiteLookCardHtml(look)).join('');
    const libraryEmpty = library.error
        ? emptyHtml('Библиотека не прочитана', library.error)
        : emptyHtml('В NESS Library пока нет внешностей', library.available ? 'Заполни постоянную внешность в профиле «📚 Ness Library» и сохрани библиотеку.' : 'Сначала открой профиль «📚 Ness Library» и сохрани библиотеку.');
    const websiteEmpty = ui.websiteLoaded
        ? emptyHtml('Отдельных внешностей на сайте нет', 'Все внешности сайта уже совпадают с NESS Library.')
        : emptyHtml('Сайт ещё не загружен', 'Сохрани адрес и нажми «Обновить данные сайта».');
    return `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>NESS Library и сайт</strong><small>Основной источник внешности — ваша общая библиотека. Сайт хранит опубликованные копии и отдельные записи.</small></div>${ui.websiteLoading ? '<span>загрузка…</span>' : ''}</div>
        <label><span>Адрес сайта</span><input id="nw-website-url" class="text_pole" type="url" inputmode="url" placeholder="https://логин.github.io/wardrobe/" value="${escapeHtml(website.siteUrl)}"><small>Для чтения внешностей достаточно этого адреса.</small></label>
        <div class="nw-settings-grid"><label><span>Логин GitHub</span><input id="nw-website-user" class="text_pole" autocomplete="off" value="${escapeHtml(website.githubUser)}"></label><label><span>Репозиторий</span><input id="nw-website-repo" class="text_pole" autocomplete="off" placeholder="wardrobe" value="${escapeHtml(website.githubRepo)}"></label></div>
        <label><span>Токен GitHub</span><input id="nw-website-token" class="text_pole" type="password" autocomplete="off" placeholder="Нужен только для отправки нарядов" value="${escapeHtml(getWebsiteToken())}"><small>Хранится только в этом браузере и не попадает в резервную копию NESS Wardrobe.</small></label>
        <label><span>Context Builder блока ExtBlocks</span><select id="nw-website-extblock" class="text_pole">${extBlockOptionsHtml()}</select></label>
        <details class="nw-site-template"><summary>Шаблон записи внешности</summary><textarea id="nw-website-look-template" class="text_pole nw-code-field" rows="5" maxlength="20000">${escapeHtml(website.lookTemplate || DEFAULT_LOOK_TEMPLATE)}</textarea><small>{{name}} — имя, {{desc}} — описание внешности целиком.</small><button class="menu_button" data-action="reset-look-template">Вернуть стандартный текст</button></details>
        <div class="nw-action-row"><button class="menu_button nw-main-action" data-action="save-settings"><i class="fa-solid fa-floppy-disk"></i><span>Сохранить подключение</span></button><button class="menu_button menu_button_icon" data-action="load-website-looks"><i class="fa-solid fa-rotate"></i><span>Обновить данные сайта</span></button></div>
        <div id="nw-settings-status" class="nw-message" role="status" aria-live="polite">${escapeHtml(ui.websiteStatus)}</div>
        <section class="nw-site-looks nw-library-primary"><div class="nw-settings-pane-head"><div><strong>Из NESS Library</strong><small>Эти записи главные. Теги собраны через запятую; области тела идут отдельными абзацами с английскими заголовками.</small></div><span class="nw-counter">${library.records.length}</span></div>${libraryLooks || libraryEmpty}</section>
        <details class="nw-site-only"><summary>Внешности только на сайте <span class="nw-counter">${websiteOnly.length}</span></summary><div class="nw-site-looks">${websiteOnlyLooks || websiteEmpty}</div></details>
    </section>`;
}

function settingsViewHtml() {
    const rule = settings.regex;
    const tab = SETTINGS_TABS.some(item => item.id === ui.settingsTab) ? ui.settingsTab : 'subjects';
    const tabs = SETTINGS_TABS.map(item => `<button class="menu_button nw-settings-tab${tab === item.id ? ' active' : ''}" role="tab" aria-selected="${tab === item.id}" data-settings-tab="${item.id}"><i class="fa-solid ${item.icon}" aria-hidden="true"></i><span>${item.label}</span></button>`).join('');
    const panes = {
        subjects: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Персоны и персонажи</strong><small>Персонаж ◆ — герой или NPC. Персона ● — образ пользователя.</small></div><span class="nw-counter">${settings.subjects.length}</span></div><div class="nw-action-row"><button class="menu_button" data-action="new-subject" data-type="character">+ Персонаж</button><button class="menu_button" data-action="new-subject" data-type="persona">+ Персона</button></div>${inlineSubjectCreatorHtml()}<div class="nw-settings-list">${settings.subjects.map(subjectSettingsRow).join('') || emptyHtml('Пока никого', 'Создай персонажа или персону, чтобы привязывать к ним наряды.')}</div></section>`,
        tags: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Обычные теги</strong><small>Цветные метки для фильтрации. Цвет не попадает в описание одежды.</small></div><span class="nw-counter">${settings.tags.length}</span></div><div class="nw-action-row"><button class="menu_button menu_button_icon nw-main-action" data-action="new-tag"><i class="fa-solid fa-tag"></i><span>Создать тег</span></button></div><div class="nw-settings-list">${settings.tags.map(tagSettingsRow).join('') || emptyHtml('Тегов нет', 'Создай цветные метки для фильтрации галереи.')}</div></section>`,
        connection: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Подключение к модели</strong><small>Профиль анализирует лорбук и последние два поста, затем создаёт наряд.</small></div><span>${profilesLoading ? 'обновляется…' : `${connectionProfiles.length} проф.`}</span></div><label><span>Профиль подключения</span><select id="nw-connection-profile" class="text_pole">${connectionOptionsHtml()}</select></label><div class="nw-action-row"><button class="menu_button" data-action="refresh-profiles">Обновить список</button><button class="menu_button" data-action="test-profile">Проверить подключение</button><button class="menu_button nw-main-action" data-action="save-settings">Сохранить</button></div><div id="nw-settings-status" class="nw-message" role="status" aria-live="polite">${escapeHtml(ui.connectionStatus)}</div></section>`,
        website: websiteSettingsPaneHtml(),
        insertion: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Вставка в пост</strong><small>Проверяется указанное число последних постов, но меняется только самый свежий найденный блок гардероба.</small></div></div><label><span>Регулярное выражение</span><textarea id="nw-regex-pattern" class="text_pole nw-code-field" rows="5" placeholder="Например: ...(?&lt;name&gt;...)(?&lt;outfit&gt;...)">${escapeHtml(rule.pattern)}</textarea></label><div class="nw-settings-grid"><label><span>Флаги</span><input id="nw-regex-flags" class="text_pole" value="${escapeHtml(rule.flags)}" maxlength="8"></label><label><span>Группа имени</span><input id="nw-regex-name-group" class="text_pole" value="${escapeHtml(rule.nameGroup)}" maxlength="40"></label><label><span>Группа одежды</span><input id="nw-regex-outfit-group" class="text_pole" value="${escapeHtml(rule.outfitGroup)}" maxlength="40"></label><label><span>Сколько последних постов проверить</span><input id="nw-regex-depth" class="text_pole" type="number" min="1" max="100" value="${rule.searchDepth}"></label></div><label><span>Шаблон новой строки</span><textarea id="nw-regex-entry-template" class="text_pole nw-code-field" rows="2" maxlength="2000">${escapeHtml(rule.entryTemplate)}</textarea><small>Оставь переменные {{name}} и {{outfit}} — вместо них подставятся имя и описание.</small></label><label><span>Маркер конца гардероба</span><input id="nw-regex-closing-marker" class="text_pole nw-code-field" maxlength="500" value="${escapeHtml(rule.closingMarker)}"></label><div class="nw-action-row"><button class="menu_button" data-action="test-regex">Проверить правило</button><button class="menu_button nw-main-action" data-action="save-settings">Сохранить</button></div><div id="nw-settings-status" class="nw-message" role="status" aria-live="polite"></div></section>`,
        scan: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Промпт сканирования</strong><small>Доступны {{target}}, {{wishes}}, {{avoid}}, {{world}}, {{posts}}, {{current_date}}.</small></div></div><textarea id="nw-scan-prompt" class="text_pole nw-code-field" rows="16" maxlength="20000">${escapeHtml(settings.prompts.scan)}</textarea><div class="nw-action-row"><button class="menu_button" data-action="reset-scan-prompt">Вернуть стандартный текст</button><button class="menu_button nw-main-action" data-action="save-settings">Сохранить</button></div><div id="nw-settings-status" class="nw-message" role="status" aria-live="polite"></div></section>`,
        generation: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Промпт генерации</strong><small>Доступны {{target}}, {{wishes}}, {{avoid}}, {{scan}}, {{world}}, {{posts}}, {{current_date}}.</small></div></div><textarea id="nw-generation-prompt" class="text_pole nw-code-field" rows="16" maxlength="20000">${escapeHtml(settings.prompts.outfit)}</textarea><div class="nw-action-row"><button class="menu_button" data-action="reset-generation-prompt">Вернуть стандартный текст</button><button class="menu_button nw-main-action" data-action="save-settings">Сохранить</button></div><div id="nw-settings-status" class="nw-message" role="status" aria-live="polite"></div></section>`,
        transfer: `<section class="nw-settings-pane" role="tabpanel"><div class="nw-settings-pane-head"><div><strong>Перенос и резервная копия</strong><small>Файл содержит наряды, изображения, теги, персонажей, правило и промпты.</small></div></div><p class="nw-help">Закрепления отдельных чатов не экспортируются, потому что хранятся внутри самих чатов.</p><div class="nw-action-row"><button class="menu_button menu_button_icon nw-main-action" data-action="export"><i class="fa-solid fa-file-export"></i><span>Экспортировать</span></button><label class="menu_button menu_button_icon nw-file-button"><i class="fa-solid fa-file-import"></i><span>Импортировать</span><input id="nw-import-file" type="file" accept="application/json,.json" hidden></label></div></section>`,
    };
    return `<div class="nw-settings-shell"><nav class="nw-settings-tabs" role="tablist" aria-label="Разделы настроек">${tabs}</nav><div class="nw-settings-content">${panes[tab]}</div></div>`;
}

function render() {
    if (!settings) return;
    disposeGalleryObserver();
    const floating = currentFloatingSettings();
    $('#nw-mini').toggle(floating.visible);
    $('#nw-show-floating').prop('checked', floating.visible);
    $('.nw-nav [data-view]').removeClass('active').filter(`[data-view="${ui.view}"]`).addClass('active');
    $('#nw-header-status').text(applyBusy ? 'Применяю…' : generationController ? 'Генерирую…' : '');
    const content = document.getElementById('nw-content');
    if (content) {
        content.classList.toggle('nw-content-settings', ui.view === 'settings');
        content.innerHTML = ui.view === 'create' ? createViewHtml() : ui.view === 'settings' ? settingsViewHtml() : galleryViewHtml();
        if (ui.view === 'gallery' && ui.galleryMode === 'library') requestAnimationFrame(() => renderGalleryGrid(true));
        if (ui.view === 'gallery' && ui.galleryMode === 'active' && ui.activeNeedsRefresh && !ui.activeLoading) void refreshActiveOutfits();
        if (ui.view === 'settings' && ui.settingsTab === 'connection' && !profilesLoaded && !profilesLoading) void refreshConnectionProfiles(false);
    }
    if (floating.visible) requestAnimationFrame(applyFloatingButtonPosition);
}

function showPanel() {
    if (managerPopup) return;
    managerPopup = new Popup(panelHtml(), POPUP_TYPE.DISPLAY, '', {
        leftAlign: true,
        wide: true,
        allowVerticalScrolling: false,
        onOpen: () => render(),
        onClose: () => {
            captureDraft();
            managerPopup = null;
            operationRevision++;
            cancelImageOperation();
            generationController?.abort();
            generationController = null;
            profileTestController?.abort();
            profileTestController = null;
            siteController?.abort();
            siteController = null;
            ui.websiteLoading = false;
            disposeGalleryObserver();
            clearTimeout(searchTimer);
        },
    });
    void managerPopup.show();
}

function readRegexForm() {
    return normalizeRegexRule({
        pattern: document.getElementById('nw-regex-pattern')?.value ?? settings.regex.pattern,
        flags: document.getElementById('nw-regex-flags')?.value ?? settings.regex.flags,
        nameGroup: document.getElementById('nw-regex-name-group')?.value ?? settings.regex.nameGroup,
        outfitGroup: document.getElementById('nw-regex-outfit-group')?.value ?? settings.regex.outfitGroup,
        searchDepth: document.getElementById('nw-regex-depth')?.value ?? settings.regex.searchDepth,
        entryTemplate: document.getElementById('nw-regex-entry-template')?.value ?? settings.regex.entryTemplate,
        closingMarker: document.getElementById('nw-regex-closing-marker')?.value ?? settings.regex.closingMarker,
    });
}

function setMessage(id, value) {
    const node = document.getElementById(id);
    if (node) node.textContent = String(value || '');
}

async function refreshConnectionProfiles(showStatus = true) {
    if (profilesLoading) return;
    profilesLoading = true;
    if (showStatus) ui.connectionStatus = 'Обновляю список профилей…';
    if (managerPopup && ui.view === 'settings') render();
    try {
        connectionProfiles = await listConnectionProfiles(getContext());
        profilesLoaded = true;
        ui.connectionStatus = connectionProfiles.length
            ? `Доступно профилей: ${connectionProfiles.length}.`
            : 'Профили Connection Manager не найдены. Можно использовать текущее подключение.';
    } catch (error) {
        ui.connectionStatus = `Не удалось получить профили: ${error.message || error}`;
    } finally {
        profilesLoading = false;
        if (managerPopup && ui.view === 'settings') render();
    }
}

async function testSelectedProfile() {
    if (profileTestController) return;
    const selected = document.getElementById('nw-connection-profile')?.value || settings.connection.profileId;
    profileTestController = new AbortController();
    ui.connectionStatus = 'Проверяю подключение…';
    setMessage('nw-settings-status', ui.connectionStatus);
    $('[data-action="test-profile"]').prop('disabled', true);
    try {
        await testConnectionProfile(getContext(), selected, profileTestController.signal);
        ui.connectionStatus = 'Подключение отвечает.';
    } catch (error) {
        ui.connectionStatus = `Подключение не отвечает: ${error.message || error}`;
    } finally {
        profileTestController = null;
        setMessage('nw-settings-status', ui.connectionStatus);
        $('[data-action="test-profile"]').prop('disabled', false);
    }
}

async function saveSettingsForm({ silent = false } = {}) {
    const status = document.getElementById('nw-settings-status');
    try {
        let changed = false;
        if (ui.settingsTab === 'insertion') {
            const rule = readRegexForm();
            if (!silent && rule.pattern) await validateRegexRule(rule);
            changed = JSON.stringify(settings.regex) !== JSON.stringify(rule);
            settings.regex = rule;
        } else if (ui.settingsTab === 'connection') {
            const profile = document.getElementById('nw-connection-profile');
            if (profile) {
                const profileId = profile.value || 'auto';
                changed = settings.connection.profileId !== profileId;
                settings.connection.profileId = profileId;
            }
        } else if (ui.settingsTab === 'website') {
            const extBlockRef = document.getElementById('nw-website-extblock')?.value || '';
            const extBlock = listExtBlockTargets(getContext()).find(target => target.ref === extBlockRef);
            const next = {
                siteUrl: document.getElementById('nw-website-url')?.value.trim() || '',
                githubUser: document.getElementById('nw-website-user')?.value.trim() || '',
                githubRepo: document.getElementById('nw-website-repo')?.value.trim() || '',
                extBlockRef,
                extBlockName: extBlock?.block?.name || settings.website.extBlockName || 'nai_imagen',
                lookTemplate: document.getElementById('nw-website-look-template')?.value || '',
            };
            changed = JSON.stringify(settings.website) !== JSON.stringify(next);
            settings.website = next;
            const tokenField = document.getElementById('nw-website-token');
            if (tokenField) setWebsiteToken(tokenField.value);
        } else if (ui.settingsTab === 'scan') {
            const field = document.getElementById('nw-scan-prompt');
            if (field) {
                const prompt = field.value.trim() || DEFAULT_SCAN_PROMPT;
                changed = settings.prompts.scan !== prompt;
                settings.prompts.scan = prompt;
            }
        } else if (ui.settingsTab === 'generation') {
            const field = document.getElementById('nw-generation-prompt');
            if (field) {
                const prompt = field.value.trim() || DEFAULT_GENERATION_PROMPT;
                changed = settings.prompts.outfit !== prompt;
                settings.prompts.outfit = prompt;
            }
        }
        if (changed) commitSettings();
        if (ui.settingsTab === 'connection') ui.connectionStatus = 'Настройки сохранены.';
        if (ui.settingsTab === 'website') ui.websiteStatus = 'Подключение сохранено.';
        if (!silent && status) status.textContent = 'Настройки сохранены.';
        return true;
    } catch (error) {
        if (status) status.textContent = `Не сохранено: ${error.message || error}`;
        return false;
    }
}

function websiteRequestConfig(signal = undefined) {
    return { ...settings.website, token: getWebsiteToken(), signal };
}

async function loadWebsiteLooks() {
    if (ui.websiteLoading) return;
    if (ui.settingsTab === 'website' && !await saveSettingsForm({ silent: true })) return;
    siteController?.abort();
    const controller = new AbortController();
    const ownRevision = operationRevision;
    siteController = controller;
    ui.websiteLoading = true;
    ui.websiteStatus = 'Загружаю wardrobe.json…';
    render();
    try {
        const data = await loadWebsiteData(websiteRequestConfig(controller.signal));
        if (controller.signal.aborted || ownRevision !== operationRevision) return;
        ui.websiteLooks = websiteLooks(data);
        ui.websiteLoaded = true;
        ui.websiteStatus = ui.websiteLooks.length ? `Загружено внешностей: ${ui.websiteLooks.length}.` : 'На сайте пока нет внешностей.';
    } catch (error) {
        if (!controller.signal.aborted && ownRevision === operationRevision) ui.websiteStatus = `Не удалось загрузить: ${error.message || error}`;
    } finally {
        if (siteController === controller) siteController = null;
        if (ownRevision === operationRevision) {
            ui.websiteLoading = false;
            if (managerPopup && ui.view === 'settings' && ui.settingsTab === 'website') render();
        }
    }
}

async function sendLookFromWebsite(id) {
    const look = availableAppearance(id);
    const target = selectedExtBlockTarget();
    if (!look || !target) return notify('Не выбрана внешность или блок ExtBlocks.', 'warning');
    try {
        const result = await sendWebsiteLook(getContext(), target, look, settings.website.lookTemplate || DEFAULT_LOOK_TEMPLATE);
        settings.website.extBlockRef = target.ref;
        settings.website.extBlockName = target.block.name;
        commitSettings();
        ui.websiteStatus = result === 'added' ? `«${look.name}» добавлена в Context Builder.` : `«${look.name}» обновлена в Context Builder.`;
        render();
    } catch (error) {
        ui.websiteStatus = `Не удалось добавить внешность: ${error.message || error}`;
        render();
    }
}

async function toggleLookFromWebsite(id) {
    const look = availableAppearance(id);
    const target = selectedExtBlockTarget();
    if (!look || !target) return;
    await toggleWebsiteLook(getContext(), target, look);
    render();
}

async function removeLookFromWebsite(id) {
    const look = availableAppearance(id);
    const target = selectedExtBlockTarget();
    if (!look || !target) return;
    await removeWebsiteLook(getContext(), target, look);
    ui.websiteStatus = `«${look.name}» убрана из Context Builder.`;
    render();
}

async function exportLibraryAppearanceToWebsite(id) {
    const look = currentNessLibrary().records.find(record => record.id === id);
    if (!look) return notify('Запись больше не найдена в NESS Library. Обнови окно.', 'warning');
    if (!settings.website.githubUser || !settings.website.githubRepo || !getWebsiteToken()) {
        notify('Сначала заполни GitHub в Настройки → Библиотека.', 'warning');
        return;
    }
    siteController?.abort();
    const controller = new AbortController();
    const revision = operationRevision;
    siteController = controller;
    ui.websiteStatus = `Отправляю внешность «${look.name}» на сайт…`;
    setMessage('nw-settings-status', ui.websiteStatus);
    $('[data-action="export-library-look-site"]').prop('disabled', true);
    try {
        const result = await exportLibraryLookToWebsite(websiteRequestConfig(controller.signal), look);
        if (controller.signal.aborted || revision !== operationRevision) return;
        ui.websiteLooks = websiteLooks(result.data);
        ui.websiteLoaded = true;
        ui.websiteStatus = result.updated ? `Внешность «${look.name}» обновлена на сайте.` : `Внешность «${look.name}» добавлена на сайт.`;
        notify(ui.websiteStatus, 'success');
        render();
    } catch (error) {
        if (!controller.signal.aborted) {
            ui.websiteStatus = `Не удалось отправить внешность: ${error.message || error}`;
            setMessage('nw-settings-status', ui.websiteStatus);
        }
    } finally {
        if (siteController === controller) siteController = null;
        $('[data-action="export-library-look-site"]').prop('disabled', false);
    }
}

async function exportSavedOutfitToWebsite(outfitId) {
    const outfit = findOutfit(outfitId);
    const subject = findSubject(outfit?.subjectId);
    if (!outfit || !subject) return notify('Сначала сохрани наряд и выбери, для кого он.', 'warning');
    if (!outfit.images[0]) return notify('Добавь наряду обложку перед отправкой на сайт.', 'warning');
    if (!settings.website.githubUser || !settings.website.githubRepo || !getWebsiteToken()) {
        notify('Сначала заполни GitHub в Настройки → Библиотека.', 'warning');
        return;
    }
    const suggestedShelf = outfit.tagIds.map(id => findTag(id)?.name).find(Boolean) || 'Образы';
    const revision = operationRevision;
    const popup = new Popup(`<div class="nw-site-export-dialog"><h3><i class="fa-solid fa-cloud-arrow-up"></i> Отправить «${escapeHtml(outfit.name)}» на сайт</h3><small>Укажи полку. Если такого персонажа или полки ещё нет, они будут созданы автоматически. На сайт уйдут описание и первая картинка.</small></div>`, POPUP_TYPE.INPUT, suggestedShelf, { wide: false, okButton: 'Отправить', cancelButton: 'Отмена' });
    const value = await popup.show();
    if (typeof value !== 'string' || revision !== operationRevision) return;
    const shelfName = normalizeName(value);
    if (!shelfName) return notify('Введи название полки на сайте.', 'warning');
    siteController?.abort();
    const controller = new AbortController();
    siteController = controller;
    $('#nw-header-status').text('Отправляю на сайт…');
    $('[data-action="export-outfit-site"]').prop('disabled', true);
    try {
        await exportOutfitToWebsite(websiteRequestConfig(controller.signal), { outfit, subject, shelfName });
        if (controller.signal.aborted || revision !== operationRevision) return;
        ui.status = `«${outfit.name}» отправлен на сайт. GitHub Pages может обновляться несколько минут.`;
        notify(ui.status, 'success');
        if (managerPopup) render();
    } catch (error) {
        if (!controller.signal.aborted) notify(`Не удалось отправить на сайт: ${error.message || error}`, 'error');
    } finally {
        if (siteController === controller) siteController = null;
        $('#nw-header-status').text('');
        $('[data-action="export-outfit-site"]').prop('disabled', false);
    }
}

async function testRegex() {
    const status = document.getElementById('nw-settings-status');
    if (status) status.textContent = 'Проверяю правило…';
    try {
        const rule = await validateRegexRule(readRegexForm());
        const texts = recentPostTexts(getContext(), rule.searchDepth);
        const result = await runWardrobeRegex({ operation: 'scanMany', texts, rule, closingMarker: rule.closingMarker });
        if (status) status.textContent = result.key === null
            ? `Правило корректно, но среди ${texts.length} проверенных постов блок гардероба не найден.`
            : result.entries.length
                ? `Правило работает: в самом свежем блоке, пост №${result.key}, найдено записей: ${result.entries.length}. Пост не изменён.`
                : `В посте №${result.key} найден маркер гардероба, но правило не распознало ни одной записи одежды.`;
    } catch (error) {
        if (status) status.textContent = `Проверка не пройдена: ${error.message || error}`;
    }
}

async function refreshActiveOutfits() {
    if (ui.activeLoading) return;
    ui.activeLoading = true;
    ui.activeNeedsRefresh = false;
    if (managerPopup && ui.view === 'gallery' && ui.galleryMode === 'active') render();
    try {
        const result = await scanLatestWardrobePost();
        ui.activeEntries = result.entries || [];
        ui.activePostKey = result.key;
        ui.activeSelected = Math.min(ui.activeSelected, Math.max(0, ui.activeEntries.length - 1));
        if (result.key === null) ui.activeStatus = `Среди ${result.checked} проверенных постов блок гардероба не найден.`;
        else if (!ui.activeEntries.length) ui.activeStatus = `В посте №${result.key} найден блок гардероба, но правило не распознало в нём наряды.`;
        else ui.activeStatus = `Найдено нарядов: ${ui.activeEntries.length}.`;
    } catch (error) {
        ui.activeEntries = [];
        ui.activePostKey = null;
        ui.activeStatus = `Не удалось прочитать гардероб: ${error.message || error}`;
    } finally {
        ui.activeLoading = false;
        if (managerPopup && ui.view === 'gallery' && ui.galleryMode === 'active') render();
    }
}

async function changeActiveEntry(operation, selected, replacement = '') {
    const snapshot = await scanLatestWardrobePost();
    if (snapshot.key === null || snapshot.source === null) throw new Error('Активный блок гардероба больше не найден.');
    const liveEntry = snapshot.entries?.[selected.index];
    if (!liveEntry || comparableName(liveEntry.name) !== comparableName(selected.name) || liveEntry.outfit !== selected.outfit) {
        ui.activeNeedsRefresh = true;
        throw new Error('Наряд уже изменился. Обнови список и повтори действие.');
    }
    const result = await runWardrobeRegex({ operation, text: snapshot.source, rule: snapshot.rule, entryIndex: liveEntry.index, replacement });
    const message = snapshot.chatRef?.[snapshot.key];
    const live = getContext();
    if (live.chat !== snapshot.chatRef || live.chatId !== snapshot.chatId || live.chat[snapshot.key] !== message || message?.mes !== snapshot.source) throw new Error('Чат или выбранный пост изменился. Обнови список и повтори действие.');
    replaceMessageText(message, result.text);
    try {
        await persistMessageChange(live, snapshot.key, message);
    } catch (error) {
        replaceMessageText(message, snapshot.source);
        try { updateMessageDisplay(live, snapshot.key, message); } catch { /* best effort */ }
        throw new Error(`Пост не сохранён: ${error.message || error}`);
    }
    ui.activeNeedsRefresh = true;
    ui.undo = null;
    return snapshot.key;
}

async function saveActiveOutfit() {
    if (applyBusy) return;
    const selected = ui.activeEntries[ui.activeSelected];
    const description = document.getElementById('nw-active-outfit-description')?.value.trim() || '';
    if (!selected || !description) return notify('Описание одежды не может быть пустым.', 'warning');
    applyBusy = true;
    try {
        const key = await changeActiveEntry('replaceEntry', selected, description);
        ui.activeStatus = `Наряд «${selected.name}» сохранён в посте №${key}.`;
        notify(ui.activeStatus, 'success');
    } catch (error) {
        ui.activeStatus = error.message || String(error);
        notify(ui.activeStatus, 'error');
    } finally {
        applyBusy = false;
        await refreshActiveOutfits();
    }
}

async function deleteActiveOutfit(index) {
    if (applyBusy) return;
    const selected = ui.activeEntries[index];
    if (!selected) return;
    const confirmed = await Popup.show.confirm('Удалить наряд из поста?', `Наряд «${escapeHtml(selected.name)}» будет удалён только из активного блока гардероба.`, { okButton: 'Удалить', cancelButton: 'Отмена' });
    if (!confirmed) return;
    applyBusy = true;
    try {
        const key = await changeActiveEntry('deleteEntry', selected);
        ui.activeSelected = Math.max(0, Math.min(index, ui.activeEntries.length - 2));
        ui.activeStatus = `Наряд «${selected.name}» удалён из поста №${key}.`;
        notify(ui.activeStatus, 'success');
    } catch (error) {
        ui.activeStatus = error.message || String(error);
        notify(ui.activeStatus, 'error');
    } finally {
        applyBusy = false;
        await refreshActiveOutfits();
    }
}

function saveActiveToLibrary() {
    const selected = ui.activeEntries[ui.activeSelected];
    if (!selected) return;
    const subject = subjectForActiveName(selected.name);
    ui.draft = emptyOutfit(subject?.id || '');
    ui.draft.name = `Наряд — ${selected.name}`;
    ui.draft.description = document.getElementById('nw-active-outfit-description')?.value.trim() || selected.outfit;
    ui.createMode = 'write';
    ui.subjectCreator = null;
    ui.tagSearch = '';
    ui.view = 'create';
    render();
}

function openInlineSubjectCreator(type = 'character', assignToDraft = false) {
    captureDraft();
    ui.subjectCreator = {
        name: '',
        type: type === 'persona' ? 'persona' : 'character',
        color: type === 'persona' ? '#7899a8' : '#9a765f',
        aliases: [],
        assignToDraft,
        error: '',
    };
    render();
    requestAnimationFrame(() => document.getElementById('nw-inline-subject-name')?.focus());
}

function createInlineSubject() {
    captureDraft();
    const editor = ui.subjectCreator;
    if (!editor) return;
    const name = normalizeName(editor.name);
    if (!name) {
        editor.error = 'Заполни имя персоны или персонажа.';
        render();
        return;
    }
    if (settings.subjects.some(subject => comparableName(subject.name) === comparableName(name))) {
        editor.error = 'Такое имя уже есть. Выбери существующую запись или добавь уточнение к имени.';
        render();
        return;
    }
    const subject = normalizeSubject({ id: uid('subject'), name, type: editor.type, color: editor.color, aliases: editor.aliases });
    settings.subjects.push(subject);
    if (editor.assignToDraft && ui.draft) ui.draft.subjectId = subject.id;
    ui.subjectCreator = null;
    commitSettings();
    render();
    notify(`${subjectTypeLabel(subject.type)} «${subject.name}» создан${subject.type === 'persona' ? 'а' : ''}.`, 'success');
}

async function openTagCreatorPopup(prefill = '', assignToDraft = false) {
    captureDraft();
    const suggestedName = normalizeName(prefill);
    const existing = settings.tags.find(tag => comparableName(tag.name) === comparableName(suggestedName));
    if (existing && assignToDraft && ui.draft) {
        if (!ui.draft.tagIds.includes(existing.id)) ui.draft.tagIds.push(existing.id);
        ui.tagSearch = '';
        render();
        return;
    }
    const colorFieldId = `nw-tag-popup-color-${uid('field').replace(/[^a-zA-Z0-9_-]/g, '')}`;
    const revision = operationRevision;
    const popup = new Popup(
        '<div class="nw-tag-popup-copy"><h3><i class="fa-solid fa-tag"></i> Новый тег</h3><strong>Название тега</strong><small>Название уже заполнено из поиска. Выбери цвет и подтверди создание.</small></div>',
        POPUP_TYPE.INPUT,
        suggestedName,
        {
            wide: false,
            okButton: assignToDraft ? 'Создать и выбрать' : 'Создать',
            cancelButton: 'Отмена',
            customInputs: [{ id: colorFieldId, label: 'Цвет тега', type: 'color', defaultState: '#8a7aa5' }],
        },
    );
    const result = await popup.show();
    if (typeof result !== 'string' || revision !== operationRevision) return;
    const name = normalizeName(result);
    if (!name) {
        notify('Тег не создан: введи название.', 'warning');
        return;
    }
    const duplicate = settings.tags.find(tag => comparableName(tag.name) === comparableName(name));
    if (duplicate) {
        if (assignToDraft && ui.draft && !ui.draft.tagIds.includes(duplicate.id)) ui.draft.tagIds.push(duplicate.id);
        ui.tagSearch = '';
        render();
        notify(`Тег «${duplicate.name}» уже существует и выбран.`, 'success');
        return;
    }
    const color = normalizeColor(popup.inputResults?.get(colorFieldId), '#8a7aa5');
    const tag = normalizeTag({ id: uid('tag'), name, color });
    settings.tags.push(tag);
    if (assignToDraft && ui.draft && !ui.draft.tagIds.includes(tag.id)) ui.draft.tagIds.push(tag.id);
    ui.tagSearch = '';
    commitSettings();
    render();
    notify(`Тег «${tag.name}» создан${assignToDraft ? ' и выбран' : ''}.`, 'success');
}

async function managePins() {
    const state = getChatState(true);
    if (!state) {
        notify('Сначала открой чат.', 'warning');
        return;
    }
    const pinned = new Set(state.pinnedSubjectIds);
    const rows = settings.subjects.map(subject => `<label class="checkbox_label nw-pin-row" style="${colorStyle(subject.color)}"><input type="checkbox" data-pin-subject="${escapeHtml(subject.id)}" ${pinned.has(subject.id) ? 'checked' : ''}><span><i class="fa-solid ${subjectIcon(subject.type)}"></i><b>${escapeHtml(subject.name)}</b><small>${subjectTypeLabel(subject.type)}</small></span></label>`).join('');
    const popup = new Popup(`<div class="nw-pin-dialog"><h3>Закрепить к этому чату</h3><small>Закрепление влияет на быстрый выбор и хранится только в текущем чате.</small><div class="nw-pin-list">${rows || emptyHtml('Список пуст', 'Сначала создай персону или персонажа в настройках.')}</div></div>`, POPUP_TYPE.DISPLAY, '', { wide: false, leftAlign: true });
    await popup.show();
    if (managerPopup && ui.view === 'gallery') render();
}

function cancelImageOperation() {
    imageRevision++;
    imageController?.abort();
    imageController = null;
}

async function addImageSources(loadSources, progressText) {
    captureDraft();
    if (!ui.draft || ui.view !== 'create') return;
    const available = Math.max(0, 3 - ui.draft.images.length);
    if (!available) return setMessage('nw-image-status', 'У наряда уже есть три изображения.');
    cancelImageOperation();
    const ownRevision = imageRevision;
    const controller = new AbortController();
    imageController = controller;
    setMessage('nw-image-status', progressText);
    try {
        const sources = [...(await loadSources(controller.signal) || [])].slice(0, available);
        if (!sources.length) throw new Error('В источнике не найдено изображение.');
        for (const source of sources) {
            const image = await prepareImage(source, ui.draft.images.length ? 1280 : 640);
            if (controller.signal.aborted || ownRevision !== imageRevision || ui.view !== 'create') return;
            ui.draft.images.push(image);
        }
        render();
        setMessage('nw-image-status', 'Изображения добавлены в черновик.');
    } catch (error) {
        if (!controller.signal.aborted && ownRevision === imageRevision) setMessage('nw-image-status', error.message || error);
    } finally {
        if (imageController === controller) imageController = null;
    }
}

function handleImageFiles(files) {
    const sources = [...(files || [])];
    return addImageSources(async () => sources, 'Подготавливаю изображения…');
}

async function openImageUrlPopup() {
    captureDraft();
    const revision = imageRevision;
    const popup = new Popup('<div class="nw-image-url-popup"><h3><i class="fa-solid fa-link"></i> Изображение по ссылке</h3><small>Вставь прямую ссылку на файл изображения. Ссылка не сохраняется — в гардероб попадёт уменьшенная копия.</small></div>', POPUP_TYPE.INPUT, '', { wide: false, okButton: 'Добавить', cancelButton: 'Отмена' });
    const value = await popup.show();
    if (typeof value !== 'string' || revision !== imageRevision || ui.view !== 'create') return;
    const url = value.trim();
    if (!url) return;
    await addImageSources(async signal => [await imageFileFromUrl(url, signal)], 'Загружаю изображение по ссылке…');
}

async function clipboardImageSources(signal) {
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error('Этот браузер не разрешает чтение буфера. Используй файл или ссылку.');
    if (typeof clipboard.read === 'function') {
        const items = await clipboard.read();
        const images = [];
        let text = '';
        for (const item of items) {
            const imageType = item.types.find(type => type.startsWith('image/'));
            if (imageType) images.push(await item.getType(imageType));
            if (!text && item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
        }
        if (images.length) return images;
        if (text.trim()) return [await imageFileFromUrl(text.trim(), signal)];
    }
    if (typeof clipboard.readText === 'function') {
        const text = (await clipboard.readText()).trim();
        if (text) return [await imageFileFromUrl(text, signal)];
    }
    throw new Error('В буфере нет изображения или прямой ссылки на него.');
}

function pasteImageFromClipboard() {
    return addImageSources(clipboardImageSources, 'Читаю изображение из буфера…');
}

function saveOutfit() {
    captureDraft();
    const draft = ui.draft;
    const name = normalizeName(draft.name);
    if (!name) return setMessage('nw-image-status', 'Заполни название наряда.');
    if (!findSubject(draft.subjectId)) return setMessage('nw-image-status', 'Выбери персону или персонажа.');
    if (!String(draft.description || '').trim()) return setMessage('nw-image-status', 'Заполни описание одежды.');
    const normalized = normalizeOutfit({ ...draft, name, updatedAt: new Date().toISOString() }, new Set(settings.subjects.map(item => item.id)), new Set(settings.tags.map(item => item.id)));
    const index = settings.outfits.findIndex(outfit => outfit.id === normalized.id);
    if (index >= 0) settings.outfits[index] = normalized;
    else settings.outfits.push(normalized);
    settings = normalizeSettings(settings);
    commitSettings();
    ui.draft = clone(normalized);
    notify(`Наряд «${normalized.name}» сохранён.`, 'success');
    ui.view = 'gallery';
    ui.status = '';
    render();
}

async function deleteOutfit() {
    const outfit = findOutfit(ui.draft?.id);
    if (!outfit) return;
    const confirmed = await Popup.show.confirm('Удалить наряд?', `«${escapeHtml(outfit.name)}» и его изображения будут удалены из библиотеки.`, { okButton: 'Удалить', cancelButton: 'Отмена' });
    if (!confirmed) return;
    settings.outfits = settings.outfits.filter(item => item.id !== outfit.id);
    commitSettings();
    ui.draft = null;
    ui.view = 'gallery';
    render();
}

async function generateFromForm() {
    if (generationController) return;
    captureDraft();
    const target = ui.generator.target.trim() || findSubject(ui.draft.subjectId)?.name || '';
    const ownRevision = ++operationRevision;
    generationController = new AbortController();
    setMessage('nw-generation-status', 'Читаю лорбук и последние два поста…');
    $('#nw-header-status').text('Генерирую…');
    $('[data-action="generate-outfit"]').prop('disabled', true);
    try {
        const result = await generateOutfit(getContext(), {
            target,
            wishes: ui.generator.wishes,
            avoid: ui.generator.avoid,
            profileId: settings.connection.profileId,
            scanTemplate: settings.prompts.scan,
            outfitTemplate: settings.prompts.outfit,
        }, generationController.signal, message => setMessage('nw-generation-status', message));
        if (ownRevision !== operationRevision || ui.view !== 'create' || ui.createMode !== 'generate') return;
        ui.draft.name = result.name;
        ui.draft.description = result.description;
        const name = document.getElementById('nw-outfit-name');
        const description = document.getElementById('nw-outfit-description');
        if (name) name.value = result.name;
        if (description) description.value = result.description;
        setMessage('nw-generation-status', 'Описание готово. Проверь его и нажми «Сохранить наряд».');
    } catch (error) {
        if (ownRevision === operationRevision) setMessage('nw-generation-status', `Не удалось сгенерировать: ${error.message || error}`);
    } finally {
        if (ownRevision === operationRevision) {
            generationController = null;
            $('#nw-header-status').text('');
            $('[data-action="generate-outfit"]').prop('disabled', false);
        }
    }
}

function updateMessageDisplay(context, index, message) {
    if (typeof context?.updateMessageBlock === 'function') context.updateMessageBlock(index, message);
    else if (typeof mainModule?.updateMessageBlock === 'function') mainModule.updateMessageBlock(index, message);
}

async function persistMessageChange(context, index, message) {
    const expected = message?.mes;
    updateMessageDisplay(context, index, message);
    if (typeof context.saveChat === 'function') await context.saveChat();
    else if (typeof mainModule?.saveChatConditional === 'function') await mainModule.saveChatConditional();
    else if (typeof mainModule?.saveChat === 'function') await mainModule.saveChat();
    else throw new Error('SillyTavern не предоставил надёжное сохранение чата.');
    if (context.chat?.[index] !== message || message?.mes !== expected) throw new Error('SillyTavern изменил сообщение во время сохранения. Повтори действие.');
}

function replaceMessageText(message, next) {
    message.mes = next;
    if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id) && typeof message.swipes[message.swipe_id] === 'string') message.swipes[message.swipe_id] = next;
}

async function applyOutfit(outfitId) {
    if (applyBusy) return;
    const startRevision = operationRevision;
    const outfit = findOutfit(outfitId);
    const subject = findSubject(outfit?.subjectId);
    if (!outfit || !subject || !outfit.description.trim()) return notify('У наряда нет готового описания или привязки.', 'warning');
    const context = getContext();
    if (!hasOpenChat(context) || !Array.isArray(context.chat)) return notify('Сначала открой чат.', 'warning');
    applyBusy = true;
    ui.status = `Проверяю последние посты и ищу самый свежий блок гардероба…`;
    render();
    try {
        const snapshot = await scanLatestWardrobePost();
        if (startRevision !== operationRevision) return;
        if (snapshot.key === null || snapshot.source === null) throw new Error(`Среди ${snapshot.checked} проверенных постов не найден блок гардероба.`);
        const wanted = new Set(subjectNames(subject).map(comparableName));
        const existing = snapshot.entries.find(entry => wanted.has(comparableName(entry.name)));
        let result;
        let added = false;
        if (existing) {
            const confirmed = await Popup.show.confirm('Заменить активный наряд?', `В посте №${snapshot.key} уже есть наряд для «${escapeHtml(existing.name)}». Заменить его на «${escapeHtml(outfit.name)}»?`, { okButton: 'Заменить', cancelButton: 'Отмена' });
            if (!confirmed || startRevision !== operationRevision) return;
            result = await runWardrobeRegex({ operation: 'replaceEntry', text: snapshot.source, rule: snapshot.rule, entryIndex: existing.index, replacement: outfit.description });
        } else {
            if (!snapshot.hasMarker) throw new Error(`В посте №${snapshot.key} найдено правило одежды, но нет маркера конца гардероба «${snapshot.rule.closingMarker}».`);
            const entryText = fillPrompt(snapshot.rule.entryTemplate, { name: subject.name, outfit: outfit.description });
            result = await runWardrobeRegex({ operation: 'append', text: snapshot.source, rule: snapshot.rule, entryText, closingMarker: snapshot.rule.closingMarker });
            added = true;
        }
        const index = Number(snapshot.key);
        const message = snapshot.chatRef[index];
        const live = getContext();
        if (live.chat !== snapshot.chatRef || live.chatId !== snapshot.chatId || live.chat[index] !== message || message?.mes !== snapshot.source) throw new Error('Чат или выбранный пост изменился. Нажми на наряд ещё раз.');
        replaceMessageText(message, result.text);
        try {
            await persistMessageChange(live, index, message);
        } catch (error) {
            replaceMessageText(message, snapshot.source);
            try { updateMessageDisplay(live, index, message); } catch { /* best effort */ }
            throw new Error(`Пост не сохранён: ${error.message || error}`);
        }
        ui.undo = { chatRef: snapshot.chatRef, chatId: snapshot.chatId, index, message, before: snapshot.source, after: result.text, outfitName: outfit.name };
        ui.activeNeedsRefresh = true;
        ui.status = added ? 'Наряд добавлен в регекс' : `«${outfit.name}» заменил активный наряд ${subject.name} в посте №${index}.`;
        notify(ui.status, 'success');
    } catch (error) {
        ui.status = error.message || String(error);
        notify(ui.status, 'error');
    } finally {
        applyBusy = false;
        render();
    }
}

async function undoApply() {
    const undo = ui.undo;
    if (!undo || applyBusy) return;
    const context = getContext();
    if (context.chat !== undo.chatRef || context.chatId !== undo.chatId || context.chat[undo.index] !== undo.message || undo.message.mes !== undo.after) {
        ui.undo = null;
        ui.status = 'Отмена недоступна: чат или пост уже изменился.';
        render();
        return;
    }
    applyBusy = true;
    replaceMessageText(undo.message, undo.before);
    try {
        await persistMessageChange(context, undo.index, undo.message);
        ui.status = `Применение «${undo.outfitName}» отменено.`;
        ui.undo = null;
        ui.activeNeedsRefresh = true;
    } catch (error) {
        replaceMessageText(undo.message, undo.after);
        ui.status = `Не удалось отменить: ${error.message || error}`;
    } finally {
        applyBusy = false;
        render();
    }
}

function downloadJson(filename, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportSettings() {
    downloadJson(`NESS_WARDROBE_${new Date().toISOString().slice(0, 10)}.json`, makeExport(settings));
}

async function importSettings(file) {
    if (!file) return;
    try {
        if (file.size > 25 * 1024 * 1024) throw new Error('Файл больше 25 МБ. Выбери резервную копию гардероба.');
        const imported = readExport(await file.text());
        const confirmed = await Popup.show.confirm('Заменить библиотеку?', `Будет загружено: ${imported.outfits.length} нарядов, ${imported.subjects.length} персон и персонажей, ${imported.tags.length} тегов. Текущая библиотека будет заменена.`, { okButton: 'Импортировать', cancelButton: 'Отмена' });
        if (!confirmed) return;
        settings = imported;
        commitSettings();
        const state = getChatState(false);
        if (state) saveChatState();
        ui.draft = null;
        ui.subjectFilter = '';
        ui.tagFilters.clear();
        render();
        notify('Библиотека импортирована.', 'success');
    } catch (error) {
        notify(`Импорт не выполнен: ${error.message || error}`, 'error');
    }
}

function removeSubject(subjectId) {
    const subject = findSubject(subjectId);
    if (!subject) return;
    const used = settings.outfits.filter(outfit => outfit.subjectId === subjectId).length;
    Popup.show.confirm('Удалить?', used ? `«${escapeHtml(subject.name)}» привязан(а) к ${used} нарядам. Наряды останутся без привязки.` : `Удалить «${escapeHtml(subject.name)}»?`, { okButton: 'Удалить', cancelButton: 'Отмена' }).then(confirmed => {
        if (!confirmed) return;
        settings.subjects = settings.subjects.filter(item => item.id !== subjectId);
        for (const outfit of settings.outfits) if (outfit.subjectId === subjectId) outfit.subjectId = '';
        const state = getChatState(false);
        if (state) { state.pinnedSubjectIds = state.pinnedSubjectIds.filter(id => id !== subjectId); saveChatState(); }
        commitSettings();
        render();
    });
}

function removeTag(tagId) {
    const tag = findTag(tagId);
    if (!tag) return;
    Popup.show.confirm('Удалить тег?', `Тег «${escapeHtml(tag.name)}» будет снят со всех нарядов.`, { okButton: 'Удалить', cancelButton: 'Отмена' }).then(confirmed => {
        if (!confirmed) return;
        settings.tags = settings.tags.filter(item => item.id !== tagId);
        for (const outfit of settings.outfits) outfit.tagIds = outfit.tagIds.filter(id => id !== tagId);
        ui.tagFilters.delete(tagId);
        commitSettings();
        render();
    });
}

function bindFloatingButton() {
    const button = document.getElementById('nw-mini');
    if (!button) return;
    let drag = null;
    let suppressClickUntil = 0;
    button.addEventListener('pointerdown', event => {
        if (event.button !== undefined && event.button !== 0) return;
        const rect = button.getBoundingClientRect();
        drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, left: rect.left, top: rect.top, moved: false };
        button.setPointerCapture?.(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        const dx = event.clientX - drag.startX;
        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) < 6) return;
        drag.moved = true;
        const bounds = floatingBounds(button);
        button.style.left = `${clampNumber(drag.left + dx, bounds.left, bounds.left + bounds.width, bounds.left)}px`;
        button.style.top = `${clampNumber(drag.top + dy, bounds.top, bounds.top + bounds.height, bounds.top)}px`;
        button.style.right = 'auto';
        button.style.bottom = 'auto';
        event.preventDefault();
    });
    button.addEventListener('pointerup', event => {
        if (!drag || event.pointerId !== drag.pointerId) return;
        button.releasePointerCapture?.(event.pointerId);
        if (drag.moved) { saveFloatingButtonPosition(button); suppressClickUntil = Date.now() + 500; }
        drag = null;
    });
    button.addEventListener('pointercancel', () => { drag = null; applyFloatingButtonPosition(); });
    button.addEventListener('click', event => {
        if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopPropagation(); return; }
        showPanel();
    });
    globalThis.addEventListener('resize', applyFloatingButtonPosition);
    globalThis.visualViewport?.addEventListener('resize', applyFloatingButtonPosition);
    globalThis.visualViewport?.addEventListener('scroll', applyFloatingButtonPosition);
}

function visibleViewport() {
    const viewport = globalThis.visualViewport;
    return { left: Number(viewport?.offsetLeft || 0), top: Number(viewport?.offsetTop || 0), width: Number(viewport?.width || globalThis.innerWidth || 0), height: Number(viewport?.height || globalThis.innerHeight || 0) };
}

function floatingBounds(button) {
    const viewport = visibleViewport();
    const margin = 8;
    const width = button.offsetWidth || 48;
    const height = button.offsetHeight || 48;
    return { left: viewport.left + margin, top: viewport.top + margin, width: Math.max(0, viewport.width - width - margin * 2), height: Math.max(0, viewport.height - height - margin * 2) };
}

function applyFloatingButtonPosition() {
    const button = document.getElementById('nw-mini');
    if (!button || !settings) return;
    const position = currentFloatingSettings().position;
    if (!position) { button.style.removeProperty('left'); button.style.removeProperty('top'); button.style.removeProperty('right'); button.style.removeProperty('bottom'); return; }
    const bounds = floatingBounds(button);
    button.style.left = `${Math.round(bounds.left + bounds.width * position.x)}px`;
    button.style.top = `${Math.round(bounds.top + bounds.height * position.y)}px`;
    button.style.right = 'auto';
    button.style.bottom = 'auto';
}

function saveFloatingButtonPosition(button) {
    const bounds = floatingBounds(button);
    const rect = button.getBoundingClientRect();
    currentFloatingSettings().position = {
        x: bounds.width ? clampNumber((rect.left - bounds.left) / bounds.width, 0, 1, 1) : 0,
        y: bounds.height ? clampNumber((rect.top - bounds.top) / bounds.height, 0, 1, 0.78) : 0,
    };
    commitSettings();
}

function bindEvents() {
    bindFloatingButton();
    $(document).off(NS);
    $(document).on(`click${NS}`, '[data-view]', async function () {
        const nextView = this.dataset.view;
        if (nextView === ui.view) return;
        if (ui.view === 'settings' && nextView !== 'settings' && !await saveSettingsForm({ silent: true })) return;
        captureDraft();
        operationRevision++;
        cancelImageOperation();
        generationController?.abort();
        generationController = null;
        profileTestController?.abort();
        profileTestController = null;
        siteController?.abort();
        siteController = null;
        ui.websiteLoading = false;
        ui.subjectCreator = null;
        ui.tagSearch = '';
        ui.view = nextView;
        render();
    });
    $(document).on(`click${NS}`, '[data-action="open"]', showPanel);
    $(document).on(`change${NS}`, '#nw-show-floating', function () { currentFloatingSettings().visible = this.checked; commitSettings(); render(); });
    $(document).on(`input${NS}`, '#nw-search', function () { ui.search = this.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => renderGalleryGrid(true), 120); });
    $(document).on(`click${NS}`, '[data-gallery-mode]', function () {
        const nextMode = this.dataset.galleryMode === 'active' ? 'active' : 'library';
        if (nextMode === ui.galleryMode) return;
        ui.galleryMode = nextMode;
        if (nextMode === 'active') ui.activeNeedsRefresh = true;
        render();
    });
    $(document).on(`click${NS}`, '[data-action="refresh-active"]', () => { ui.activeNeedsRefresh = true; void refreshActiveOutfits(); });
    $(document).on(`click${NS}`, '[data-active-index]', function () { ui.activeSelected = Math.max(0, Number(this.dataset.activeIndex) || 0); ui.activeStatus = ''; render(); });
    $(document).on(`click${NS}`, '[data-action="save-active-outfit"]', () => void saveActiveOutfit());
    $(document).on(`click${NS}`, '[data-action="delete-active-outfit"]', function () { void deleteActiveOutfit(Math.max(0, Number(this.dataset.activeIndex) || 0)); });
    $(document).on(`click${NS}`, '[data-action="save-active-to-library"]', saveActiveToLibrary);
    $(document).on(`click${NS}`, '[data-action="filter-subject"]', function () { ui.subjectFilter = ui.subjectFilter === this.dataset.subjectId ? '' : this.dataset.subjectId; render(); });
    $(document).on(`click${NS}`, '[data-action="clear-subject"]', () => { ui.subjectFilter = ''; render(); });
    $(document).on(`click${NS}`, '[data-action="filter-tag"]', function () { const id = this.dataset.tagId; ui.tagFilters.has(id) ? ui.tagFilters.delete(id) : ui.tagFilters.add(id); render(); });
    $(document).on(`click${NS}`, '[data-action="clear-tags"]', () => { ui.tagFilters.clear(); render(); });
    $(document).on(`click${NS}`, '[data-action="favorite-filter"]', () => { ui.favoriteOnly = !ui.favoriteOnly; render(); });
    $(document).on(`click${NS}`, '[data-action="load-more"]', () => renderGalleryGrid(false));
    $(document).on(`click${NS}`, '[data-action="manage-pins"]', managePins);
    $(document).on(`change${NS}`, '[data-pin-subject]', function () {
        const state = getChatState(true);
        if (!state) return;
        const ids = new Set(state.pinnedSubjectIds);
        this.checked ? ids.add(this.dataset.pinSubject) : ids.delete(this.dataset.pinSubject);
        state.pinnedSubjectIds = [...ids];
        saveChatState();
    });
    $(document).on(`click${NS}`, '[data-action="apply-outfit"]', function () { void applyOutfit(this.dataset.outfitId); });
    $(document).on(`click${NS}`, '[data-action="undo"]', () => void undoApply());
    $(document).on(`click${NS}`, '[data-action="toggle-favorite"]', function () { const outfit = findOutfit(this.dataset.outfitId); if (!outfit) return; outfit.favorite = !outfit.favorite; outfit.updatedAt = new Date().toISOString(); commitSettings(); render(); });
    $(document).on(`click${NS}`, '[data-action="edit-outfit"]', function () { const outfit = findOutfit(this.dataset.outfitId); if (!outfit) return; ui.draft = clone(outfit); ui.subjectCreator = null; ui.tagSearch = ''; ui.createMode = 'write'; ui.view = 'create'; render(); });
    $(document).on(`click${NS}`, '[data-action="create-mode"]', function () { captureDraft(); operationRevision++; generationController?.abort(); generationController = null; ui.createMode = this.dataset.mode === 'generate' ? 'generate' : 'write'; render(); });
    $(document).on(`click${NS}`, '[data-action="reset-draft"]', () => { captureDraft(); cancelImageOperation(); ui.draft = null; ui.subjectCreator = null; ui.tagSearch = ''; ui.generator = { target: '', wishes: '', avoid: '' }; render(); });
    $(document).on(`click${NS}`, '[data-settings-tab]', async function () {
        const nextTab = this.dataset.settingsTab;
        if (!SETTINGS_TABS.some(tab => tab.id === nextTab) || nextTab === ui.settingsTab) return;
        if (!await saveSettingsForm({ silent: true })) return;
        siteController?.abort();
        siteController = null;
        ui.websiteLoading = false;
        ui.settingsTab = nextTab;
        render();
        requestAnimationFrame(() => document.querySelector(`[data-settings-tab="${nextTab}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' }));
    });
    $(document).on(`wheel${NS}`, '.nw-settings-tabs', function (event) {
        const wheel = event.originalEvent;
        if (!wheel || this.scrollWidth <= this.clientWidth || Math.abs(wheel.deltaY) <= Math.abs(wheel.deltaX)) return;
        const before = this.scrollLeft;
        this.scrollLeft += wheel.deltaY;
        if (this.scrollLeft !== before) event.preventDefault();
    });
    $(document).on(`click${NS}`, '[data-action="quick-subject"]', () => openInlineSubjectCreator('character', true));
    $(document).on(`click${NS}`, '[data-action="new-subject"]', function () { openInlineSubjectCreator(this.dataset.type, ui.view === 'create'); });
    $(document).on(`click${NS}`, '[data-action="new-tag"]', () => void openTagCreatorPopup('', false));
    $(document).on(`click${NS}`, '[data-action="cancel-inline-subject"]', () => { captureDraft(); ui.subjectCreator = null; render(); });
    $(document).on(`click${NS}`, '[data-action="create-inline-subject"]', createInlineSubject);
    $(document).on(`keydown${NS}`, '#nw-inline-alias-input', function (event) { if (event.key !== 'Enter') return; event.preventDefault(); captureDraft(); const alias = normalizeName(this.value); const editor = ui.subjectCreator; if (!editor || !alias || editor.aliases.some(item => comparableName(item) === comparableName(alias))) return; editor.aliases.push(alias); render(); });
    $(document).on(`click${NS}`, '[data-action="remove-inline-alias"]', function () { captureDraft(); if (!ui.subjectCreator) return; ui.subjectCreator.aliases = ui.subjectCreator.aliases.filter(alias => alias !== this.dataset.alias); render(); });
    $(document).on(`input${NS}`, '#nw-tag-search', function () { updateDraftTagResults(this.value); });
    $(document).on(`keydown${NS}`, '#nw-tag-search', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const name = normalizeName(this.value);
        if (!name) return;
        captureDraft();
        const existing = settings.tags.find(tag => comparableName(tag.name) === comparableName(name));
        if (existing) {
            if (!ui.draft.tagIds.includes(existing.id)) ui.draft.tagIds.push(existing.id);
            ui.tagSearch = '';
            render();
            requestAnimationFrame(() => document.getElementById('nw-tag-search')?.focus());
            return;
        }
        void openTagCreatorPopup(name, true);
    });
    $(document).on(`click${NS}`, '[data-action="draft-tag"]', function () { captureDraft(); const id = this.dataset.tagId; ui.draft.tagIds.includes(id) ? ui.draft.tagIds = ui.draft.tagIds.filter(item => item !== id) : ui.draft.tagIds.push(id); ui.tagSearch = ''; render(); requestAnimationFrame(() => document.getElementById('nw-tag-search')?.focus()); });
    $(document).on(`change${NS}`, '#nw-image-files', function () { const files = [...(this.files || [])]; this.value = ''; void handleImageFiles(files); });
    $(document).on(`click${NS}`, '[data-action="add-image-url"]', () => void openImageUrlPopup());
    $(document).on(`click${NS}`, '[data-action="paste-image"]', () => void pasteImageFromClipboard());
    $(document).on(`click${NS}`, '[data-action="remove-image"]', function () { captureDraft(); ui.draft.images = ui.draft.images.filter(image => image.id !== this.dataset.imageId); render(); });
    $(document).on(`click${NS}`, '[data-action="make-cover"]', function () { captureDraft(); const index = ui.draft.images.findIndex(image => image.id === this.dataset.imageId); if (index > 0) ui.draft.images.unshift(ui.draft.images.splice(index, 1)[0]); render(); });
    $(document).on(`click${NS}`, '[data-action="save-outfit"]', saveOutfit);
    $(document).on(`click${NS}`, '[data-action="export-outfit-site"]', function () { void exportSavedOutfitToWebsite(this.dataset.outfitId); });
    $(document).on(`click${NS}`, '[data-action="delete-outfit"]', () => void deleteOutfit());
    $(document).on(`click${NS}`, '[data-action="generate-outfit"]', () => void generateFromForm());
    $(document).on(`click${NS}`, '[data-action="save-settings"]', () => void saveSettingsForm());
    $(document).on(`click${NS}`, '[data-action="test-regex"]', () => void testRegex());
    $(document).on(`click${NS}`, '[data-action="refresh-profiles"]', async () => { if (await saveSettingsForm({ silent: true })) await refreshConnectionProfiles(true); });
    $(document).on(`click${NS}`, '[data-action="test-profile"]', () => void testSelectedProfile());
    $(document).on(`click${NS}`, '[data-action="reset-scan-prompt"]', () => { const field = document.getElementById('nw-scan-prompt'); if (field) field.value = DEFAULT_SCAN_PROMPT; });
    $(document).on(`click${NS}`, '[data-action="reset-generation-prompt"]', () => { const field = document.getElementById('nw-generation-prompt'); if (field) field.value = DEFAULT_GENERATION_PROMPT; });
    $(document).on(`click${NS}`, '[data-action="reset-look-template"]', () => { const field = document.getElementById('nw-website-look-template'); if (field) field.value = DEFAULT_LOOK_TEMPLATE; });
    $(document).on(`click${NS}`, '[data-action="load-website-looks"]', () => void loadWebsiteLooks());
    $(document).on(`change${NS}`, '#nw-website-extblock', function () { settings.website.extBlockRef = this.value; settings.website.extBlockName = listExtBlockTargets(getContext()).find(target => target.ref === this.value)?.block?.name || settings.website.extBlockName; commitSettings(); render(); });
    $(document).on(`click${NS}`, '[data-action="site-look-send"]', function () { void sendLookFromWebsite(this.dataset.lookId); });
    $(document).on(`click${NS}`, '[data-action="export-library-look-site"]', function () { void exportLibraryAppearanceToWebsite(this.dataset.lookId); });
    $(document).on(`click${NS}`, '[data-action="site-look-toggle"]', function () { void toggleLookFromWebsite(this.dataset.lookId); });
    $(document).on(`click${NS}`, '[data-action="site-look-remove"]', function () { void removeLookFromWebsite(this.dataset.lookId); });
    $(document).on(`change${NS}`, '[data-subject-field]', function () { const row = this.closest('[data-subject-id]'); const subject = findSubject(row?.dataset.subjectId); if (!subject) return; const field = this.dataset.subjectField; if (field === 'name') { subject.name = normalizeName(this.value) || subject.name; this.value = subject.name; } if (field === 'type') subject.type = this.value === 'persona' ? 'persona' : 'character'; if (field === 'color') subject.color = normalizeColor(this.value, subject.color); commitSettings(); });
    $(document).on(`keydown${NS}`, '.nw-alias-input', function (event) { if (event.key !== 'Enter') return; event.preventDefault(); const subject = findSubject(this.closest('[data-subject-id]')?.dataset.subjectId); const alias = normalizeName(this.value); if (!subject || !alias || comparableName(alias) === comparableName(subject.name) || subject.aliases.some(item => comparableName(item) === comparableName(alias))) return; subject.aliases.push(alias); commitSettings(); render(); });
    $(document).on(`click${NS}`, '[data-action="remove-alias"]', function () { const subject = findSubject(this.closest('[data-subject-id]')?.dataset.subjectId); if (!subject) return; subject.aliases = subject.aliases.filter(alias => alias !== this.dataset.alias); commitSettings(); render(); });
    $(document).on(`click${NS}`, '[data-action="delete-subject"]', function () { removeSubject(this.closest('[data-subject-id]')?.dataset.subjectId); });
    $(document).on(`change${NS}`, '[data-tag-field]', function () { const tag = findTag(this.closest('[data-tag-id]')?.dataset.tagId); if (!tag) return; if (this.dataset.tagField === 'name') { tag.name = normalizeName(this.value) || tag.name; this.value = tag.name; } else tag.color = normalizeColor(this.value, tag.color); commitSettings(); });
    $(document).on(`click${NS}`, '[data-action="delete-tag"]', function () { removeTag(this.closest('[data-tag-id]')?.dataset.tagId); });
    $(document).on(`click${NS}`, '[data-action="export"]', exportSettings);
    $(document).on(`change${NS}`, '#nw-import-file', function () { const file = this.files?.[0]; this.value = ''; void importSettings(file); });
}

function onChatChanged() {
    operationRevision++;
    cancelImageOperation();
    generationController?.abort();
    generationController = null;
    profileTestController?.abort();
    profileTestController = null;
    siteController?.abort();
    siteController = null;
    ui.websiteLoading = false;
    ui.view = 'gallery';
    ui.subjectFilter = '';
    ui.tagFilters.clear();
    ui.undo = null;
    ui.status = '';
    ui.galleryMode = 'library';
    ui.activeEntries = [];
    ui.activePostKey = null;
    ui.activeSelected = 0;
    ui.activeLoading = false;
    ui.activeNeedsRefresh = true;
    ui.activeStatus = '';
    ui.draft = null;
    ui.subjectCreator = null;
    ui.tagSearch = '';
    render();
}

jQuery(async () => {
    try {
        mainModule = await import('../../../../script.js').catch(() => null);
        loadSettings();
        if (!document.getElementById('nw-mini')) $('body').append(shellHtml());
        if (!document.getElementById('nw-extension-settings')) $('#extensions_settings2').append(settingsDrawerHtml());
        bindEvents();
        render();
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        console.log('[NESS Wardrobe] v1.6.0 ready');
    } catch (error) {
        console.error('[NESS Wardrobe] Failed to initialize:', error);
        notify('Гардероб не загрузился. Подробности — в консоли.', 'error');
    }
});
