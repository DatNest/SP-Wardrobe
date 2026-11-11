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
import { prepareImage } from './images.js';

const GALLERY_FIRST = 48;
const GALLERY_MORE = 32;
const NS = '.nessWardrobe';

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

const ui = {
    view: 'gallery',
    search: '',
    subjectFilter: '',
    tagFilters: new Set(),
    favoriteOnly: false,
    galleryOffset: 0,
    createMode: 'write',
    draft: null,
    subjectCreator: null,
    tagCreator: null,
    generator: { target: '', wishes: '', avoid: '' },
    undo: null,
    status: '',
    connectionStatus: '',
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
    return `<button class="menu_button nw-chip nw-tag-chip${selected ? ' active' : ''}" style="${colorStyle(tag.color)}" data-action="${action}" data-tag-id="${escapeHtml(tag.id)}"><span class="nw-color-dot" aria-hidden="true"></span><span>${escapeHtml(tag.name)}</span></button>`;
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
    return '<button id="nw-mini" class="menu_button nw-mini" aria-label="Открыть гардероб" title="Гардероб"><span aria-hidden="true">👗</span><small></small></button>';
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

function galleryViewHtml() {
    const state = getChatState(false);
    const pinned = new Set(state?.pinnedSubjectIds || []);
    const orderedSubjects = [...settings.subjects].sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)) || a.name.localeCompare(b.name));
    const subjectFilters = orderedSubjects.map(subject => subjectChip(subject, { selected: ui.subjectFilter === subject.id, pinned: pinned.has(subject.id) })).join('');
    const tags = settings.tags.map(tag => tagChip(tag, ui.tagFilters.has(tag.id))).join('');
    const undo = ui.undo ? `<button class="menu_button menu_button_icon" data-action="undo"><i class="fa-solid fa-rotate-left"></i><span>Отменить «${escapeHtml(ui.undo.outfitName)}»</span></button>` : '';
    return `<section class="nw-gallery-tools">
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
        <div class="nw-card-tags">${tags.map(tag => `<span class="nw-card-tag" style="${colorStyle(tag.color)}"><span class="nw-color-dot"></span>${escapeHtml(tag.name)}</span>`).join('')}</div>
        <div class="nw-card-actions"><button class="menu_button fa-fw${outfit.favorite ? ' active' : ''}" data-action="toggle-favorite" data-outfit-id="${escapeHtml(outfit.id)}" aria-label="Избранное" title="Избранное"><i class="fa-solid fa-star"></i></button><button class="menu_button fa-fw" data-action="edit-outfit" data-outfit-id="${escapeHtml(outfit.id)}" aria-label="Редактировать" title="Редактировать"><i class="fa-solid fa-pen"></i></button></div>
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

function captureInlineCreators() {
    if (ui.subjectCreator) {
        const name = document.getElementById('nw-inline-subject-name');
        const type = document.getElementById('nw-inline-subject-type');
        const color = document.getElementById('nw-inline-subject-color');
        if (name) ui.subjectCreator.name = name.value;
        if (type) ui.subjectCreator.type = type.value === 'persona' ? 'persona' : 'character';
        if (color) ui.subjectCreator.color = color.value;
    }
    if (ui.tagCreator) {
        const name = document.getElementById('nw-inline-tag-name');
        const color = document.getElementById('nw-inline-tag-color');
        if (name) ui.tagCreator.name = name.value;
        if (color) ui.tagCreator.color = color.value;
    }
}

function inlineSubjectCreatorHtml() {
    const editor = ui.subjectCreator;
    if (!editor) return '';
    return `<section class="settingsSectionWrap nw-inline-creator" aria-label="Создание персоны или персонажа">
        <div class="nw-inline-creator-head"><div><small>${editor.assignToDraft ? 'Новая привязка для наряда' : 'Новая запись библиотеки'}</small><strong>Добавить персону или персонажа</strong></div><button class="menu_button fa-fw" data-action="cancel-inline-subject" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="nw-settings-grid"><label><span>Имя</span><input id="nw-inline-subject-name" class="text_pole" maxlength="120" placeholder="Например: Зуко" value="${escapeHtml(editor.name)}"></label><label><span>Кто это</span><select id="nw-inline-subject-type" class="text_pole"><option value="character" ${editor.type === 'character' ? 'selected' : ''}>Персонаж или NPC ◆</option><option value="persona" ${editor.type === 'persona' ? 'selected' : ''}>Персона пользователя ●</option></select></label><label class="nw-color-field"><span>Цвет метки</span><input id="nw-inline-subject-color" type="color" value="${escapeHtml(editor.color)}"></label></div>
        <div class="nw-aliases"><small>Другие имена <span>необязательно</span></small><div class="nw-alias-chips">${editor.aliases.map(alias => `<button class="menu_button nw-alias-chip" data-action="remove-inline-alias" data-alias="${escapeHtml(alias)}">${escapeHtml(alias)} <i class="fa-solid fa-xmark"></i></button>`).join('')}<input id="nw-inline-alias-input" class="text_pole nw-alias-input" placeholder="Введи имя и нажми Enter"></div></div>
        <div class="nw-action-row"><button class="menu_button menu_button_icon" data-action="create-inline-subject"><i class="fa-solid fa-plus"></i><span>${editor.assignToDraft ? 'Добавить и выбрать' : 'Создать'}</span></button><button class="menu_button" data-action="cancel-inline-subject">Отмена</button></div>
        <div class="nw-message" role="status">${escapeHtml(editor.error || '')}</div>
    </section>`;
}

function inlineTagCreatorHtml() {
    const editor = ui.tagCreator;
    if (!editor) return '';
    return `<section class="settingsSectionWrap nw-inline-creator nw-inline-tag-creator" aria-label="Создание тега">
        <div class="nw-inline-creator-head"><div><small>Новая метка</small><strong>Создать тег</strong></div><button class="menu_button fa-fw" data-action="cancel-inline-tag" aria-label="Закрыть"><i class="fa-solid fa-xmark"></i></button></div>
        <div class="nw-inline-tag-fields"><label><span>Название</span><input id="nw-inline-tag-name" class="text_pole" maxlength="120" placeholder="Например: Дорожное" value="${escapeHtml(editor.name)}"></label><label class="nw-color-field"><span>Цвет</span><input id="nw-inline-tag-color" type="color" value="${escapeHtml(editor.color)}"></label></div>
        <div class="nw-action-row"><button class="menu_button menu_button_icon" data-action="create-inline-tag"><i class="fa-solid fa-plus"></i><span>${editor.assignToDraft ? 'Создать и выбрать' : 'Создать'}</span></button><button class="menu_button" data-action="cancel-inline-tag">Отмена</button></div>
        <div class="nw-message" role="status">${escapeHtml(editor.error || '')}</div>
    </section>`;
}

function captureDraft() {
    captureInlineCreators();
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

function createViewHtml() {
    const draft = ensureDraft();
    const subjects = settings.subjects.map(subject => `<option value="${escapeHtml(subject.id)}" ${draft.subjectId === subject.id ? 'selected' : ''}>${subject.type === 'persona' ? '●' : '◆'} ${escapeHtml(subject.name)} — ${subjectTypeLabel(subject.type)}</option>`).join('');
    const tags = settings.tags.map(tag => tagChip(tag, draft.tagIds.includes(tag.id), 'draft-tag')).join('');
    const images = draft.images.map((image, index) => `<article class="nw-image-preview" data-image-id="${escapeHtml(image.id)}"><img src="${image.dataUrl}" alt="${escapeHtml(index === 0 ? 'Обложка наряда' : 'Изображение шоукейса')}"><div><small>${index === 0 ? 'Обложка' : `Шоукейс ${index}`}</small>${index > 0 ? `<button class="menu_button" data-action="make-cover" data-image-id="${escapeHtml(image.id)}">Сделать обложкой</button>` : ''}<button class="menu_button fa-fw" data-action="remove-image" data-image-id="${escapeHtml(image.id)}" aria-label="Удалить изображение"><i class="fa-solid fa-trash"></i></button></div></article>`).join('');
    const generate = ui.createMode === 'generate' ? `<section class="settingsSectionWrap nw-generator">
        <label><span>Для кого создать наряд</span><input id="nw-generate-target" class="text_pole" list="nw-subject-names" maxlength="120" placeholder="Имя персонажа или NPC" value="${escapeHtml(ui.generator.target || findSubject(draft.subjectId)?.name || '')}"></label>
        <datalist id="nw-subject-names">${settings.subjects.map(subject => `<option value="${escapeHtml(subject.name)}"></option>`).join('')}</datalist>
        <label><span>Пожелания</span><textarea id="nw-generate-wishes" class="text_pole" rows="3" placeholder="Например: дорожный наряд для дождливой осени">${escapeHtml(ui.generator.wishes)}</textarea></label>
        <label><span>Чего избегать <small>необязательно</small></span><textarea id="nw-generate-avoid" class="text_pole" rows="2" placeholder="Например: яркие цвета, современная синтетика">${escapeHtml(ui.generator.avoid)}</textarea></label>
        <small>Профиль «${escapeHtml(selectedConnectionLabel())}» сначала проанализирует лорбук и последние два поста, затем создаст наряд. Результат останется черновиком.</small>
        <button class="menu_button menu_button_icon" data-action="generate-outfit"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Сгенерировать описание</span></button>
        <div id="nw-generation-status" class="nw-message" role="status" aria-live="polite"></div>
    </section>` : '<p class="nw-help">Заполни описание вручную. Оно будет вставляться в найденную группу одежды без дополнительных изменений.</p>';
    return `<section class="nw-create-head"><div class="nw-create-method"><small>Как подготовить описание</small><div class="nw-mode-switch" role="group" aria-label="Способ создания"><button class="menu_button${ui.createMode === 'write' ? ' active' : ''}" data-action="create-mode" data-mode="write" aria-pressed="${ui.createMode === 'write'}"><i class="fa-solid fa-pen"></i><span>Написать</span></button><button class="menu_button${ui.createMode === 'generate' ? ' active' : ''}" data-action="create-mode" data-mode="generate" aria-pressed="${ui.createMode === 'generate'}"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Сгенерировать</span></button></div></div><button class="menu_button menu_button_icon nw-new-draft" data-action="reset-draft"><i class="fa-solid fa-file-circle-plus"></i><span>Новый черновик</span></button></section>
        ${generate}
        <section class="nw-outfit-form">
            <label><span>Название</span><input id="nw-outfit-name" class="text_pole" maxlength="120" value="${escapeHtml(draft.name)}"></label>
            <label><span>Для кого этот наряд</span><div class="nw-field-row"><select id="nw-outfit-subject" class="text_pole"><option value="">Выбрать персону или персонажа…</option>${subjects}</select><button class="menu_button menu_button_icon" data-action="quick-subject"><i class="fa-solid fa-user-plus"></i><span>Добавить</span></button></div></label>
            ${inlineSubjectCreatorHtml()}
            <label><span>Описание одежды</span><textarea id="nw-outfit-description" class="text_pole" rows="7" maxlength="12000" placeholder="Текст, который будет вставлен в пост">${escapeHtml(draft.description)}</textarea></label>
            <div><div class="nw-field-title"><span>Теги</span><button class="menu_button" data-action="new-tag">+ Создать тег</button></div>${inlineTagCreatorHtml()}<div class="nw-filter-strip nw-draft-tags">${tags || '<small>Создай первый тег кнопкой выше.</small>'}</div></div>
            <div><div class="nw-field-title"><span>Обложка и шоукейс</span><small>${draft.images.length}/3</small></div><div class="nw-image-list">${images || '<small>Первое изображение станет обложкой карточки.</small>'}</div><label class="menu_button nw-file-button${draft.images.length >= 3 ? ' disabled' : ''}"><i class="fa-solid fa-image"></i><span>Добавить изображения</span><input id="nw-image-files" type="file" accept="image/*" multiple hidden ${draft.images.length >= 3 ? 'disabled' : ''}></label><div id="nw-image-status" class="nw-message" role="status" aria-live="polite"></div></div>
            <div class="nw-form-actions"><button class="menu_button menu_button_icon" data-action="save-outfit"><i class="fa-solid fa-floppy-disk"></i><span>Сохранить наряд</span></button>${settings.outfits.some(outfit => outfit.id === draft.id) ? '<button class="menu_button menu_button_icon" data-action="delete-outfit"><i class="fa-solid fa-trash"></i><span>Удалить</span></button>' : ''}</div>
        </section>`;
}

function subjectSettingsRow(subject) {
    return `<article class="nw-settings-row" data-subject-id="${escapeHtml(subject.id)}">
        <div class="nw-settings-row-head"><span class="nw-type-badge nw-${subject.type}" style="${colorStyle(subject.color)}"><i class="fa-solid ${subjectIcon(subject.type)}"></i>${subjectTypeLabel(subject.type)}</span><button class="menu_button fa-fw" data-action="delete-subject" aria-label="Удалить" title="Удалить"><i class="fa-solid fa-trash"></i></button></div>
        <div class="nw-settings-grid"><label><span>Имя</span><input class="text_pole" data-subject-field="name" maxlength="120" value="${escapeHtml(subject.name)}"></label><label><span>Тип</span><select class="text_pole" data-subject-field="type"><option value="character" ${subject.type === 'character' ? 'selected' : ''}>Персонаж</option><option value="persona" ${subject.type === 'persona' ? 'selected' : ''}>Персона</option></select></label><label class="nw-color-field"><span>Цвет</span><input type="color" data-subject-field="color" value="${escapeHtml(subject.color)}"></label></div>
        <div class="nw-aliases"><small>Другие имена для поиска в посте</small><div class="nw-alias-chips">${subject.aliases.map(alias => `<button class="menu_button nw-alias-chip" data-action="remove-alias" data-alias="${escapeHtml(alias)}">${escapeHtml(alias)} <i class="fa-solid fa-xmark"></i></button>`).join('')}<input class="text_pole nw-alias-input" placeholder="Введи имя и нажми Enter"></div></div>
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

function settingsViewHtml() {
    const rule = settings.regex;
    return `<div class="nw-settings-stack">
        <details class="settingsSectionWrap" open><summary><strong>Персоны и персонажи</strong><small>${settings.subjects.length}</small></summary><div class="nw-details-body"><p class="nw-help"><b>Персонаж ◆</b> — герой или NPC. <b>Персона ●</b> — образ пользователя. Цвет помогает узнать их в фильтрах.</p><div class="nw-action-row"><button class="menu_button" data-action="new-subject" data-type="character">+ Персонаж</button><button class="menu_button" data-action="new-subject" data-type="persona">+ Персона</button></div>${inlineSubjectCreatorHtml()}<div class="nw-settings-list">${settings.subjects.map(subjectSettingsRow).join('') || emptyHtml('Пока никого', 'Создай персонажа или персону, чтобы привязывать к ним наряды.')}</div></div></details>
        <details class="settingsSectionWrap" ${ui.tagCreator ? 'open' : ''}><summary><strong>Обычные теги</strong><small>${settings.tags.length}</small></summary><div class="nw-details-body"><p class="nw-help">Например: зима, формальное, дорожное. Их цвет не попадает в описание одежды.</p><button class="menu_button" data-action="new-tag">+ Создать тег</button>${inlineTagCreatorHtml()}<div class="nw-settings-list">${settings.tags.map(tagSettingsRow).join('') || emptyHtml('Тегов нет', 'Создай цветные метки для фильтрации галереи.')}</div></div></details>
        <details class="settingsSectionWrap" open><summary><strong>Подключение к модели</strong><small>${profilesLoading ? 'обновляется…' : `${connectionProfiles.length} проф.`}</small></summary><div class="nw-details-body"><p class="nw-help">Один профиль сначала анализирует лорбук и два последних поста, затем создаёт наряд. Пресет основного чата не используется.</p><label><span>Профиль подключения</span><select id="nw-connection-profile" class="text_pole">${connectionOptionsHtml()}</select></label><div class="nw-action-row"><button class="menu_button" data-action="refresh-profiles">Обновить список</button><button class="menu_button" data-action="test-profile">Проверить подключение</button><button class="menu_button" data-action="save-settings">Сохранить</button></div><div id="nw-connection-status" class="nw-message" role="status" aria-live="polite">${escapeHtml(ui.connectionStatus)}</div></div></details>
        <details class="settingsSectionWrap" open><summary><strong>Вставка в пост</strong></summary><div class="nw-details-body"><p class="nw-help">Правило должно содержать отдельную группу имени и отдельную группу одежды. Проверка читает последние посты, но ничего в них не меняет.</p><label><span>Регулярное выражение</span><textarea id="nw-regex-pattern" class="text_pole nw-code-field" rows="4" placeholder="Например: ...(?&lt;name&gt;...)(?&lt;outfit&gt;...)">${escapeHtml(rule.pattern)}</textarea></label><div class="nw-settings-grid"><label><span>Флаги</span><input id="nw-regex-flags" class="text_pole" value="${escapeHtml(rule.flags)}" maxlength="8"></label><label><span>Группа имени</span><input id="nw-regex-name-group" class="text_pole" value="${escapeHtml(rule.nameGroup)}" maxlength="40"></label><label><span>Группа одежды</span><input id="nw-regex-outfit-group" class="text_pole" value="${escapeHtml(rule.outfitGroup)}" maxlength="40"></label><label><span>Сколько последних постов искать</span><input id="nw-regex-depth" class="text_pole" type="number" min="1" max="100" value="${rule.searchDepth}"></label></div><div class="nw-action-row"><button class="menu_button" data-action="test-regex">Проверить правило</button><button class="menu_button" data-action="save-settings">Сохранить</button></div><div id="nw-settings-status" class="nw-message" role="status" aria-live="polite"></div></div></details>
        <details class="settingsSectionWrap"><summary><strong>Промпт сканирования</strong></summary><div class="nw-details-body"><p class="nw-help">Первый запрос извлекает факты из лорбука и двух постов. Доступны: {{target}}, {{wishes}}, {{avoid}}, {{world}}, {{posts}}, {{current_date}}.</p><textarea id="nw-scan-prompt" class="text_pole nw-code-field" rows="14" maxlength="20000">${escapeHtml(settings.prompts.scan)}</textarea><div class="nw-action-row"><button class="menu_button" data-action="reset-scan-prompt">Вернуть стандартный текст</button><button class="menu_button" data-action="save-settings">Сохранить</button></div></div></details>
        <details class="settingsSectionWrap"><summary><strong>Промпт генерации</strong></summary><div class="nw-details-body"><p class="nw-help">Второй запрос получает готовый разбор. Доступны: {{target}}, {{wishes}}, {{avoid}}, {{scan}}, {{world}}, {{posts}}, {{current_date}}.</p><textarea id="nw-generation-prompt" class="text_pole nw-code-field" rows="14" maxlength="20000">${escapeHtml(settings.prompts.outfit)}</textarea><div class="nw-action-row"><button class="menu_button" data-action="reset-generation-prompt">Вернуть стандартный текст</button><button class="menu_button" data-action="save-settings">Сохранить</button></div></div></details>
        <details class="settingsSectionWrap"><summary><strong>Перенос и резервная копия</strong></summary><div class="nw-details-body"><p class="nw-help">Файл содержит наряды, изображения, теги, персонажей, правило и промпт. Закрепления отдельных чатов в него не входят.</p><div class="nw-action-row"><button class="menu_button menu_button_icon" data-action="export"><i class="fa-solid fa-file-export"></i><span>Экспорт</span></button><label class="menu_button menu_button_icon nw-file-button"><i class="fa-solid fa-file-import"></i><span>Импорт</span><input id="nw-import-file" type="file" accept="application/json,.json" hidden></label></div></div></details>
    </div>`;
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
        content.innerHTML = ui.view === 'create' ? createViewHtml() : ui.view === 'settings' ? settingsViewHtml() : galleryViewHtml();
        if (ui.view === 'gallery') requestAnimationFrame(() => renderGalleryGrid(true));
        if (ui.view === 'settings' && !profilesLoaded && !profilesLoading) void refreshConnectionProfiles(false);
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
            imageRevision++;
            generationController?.abort();
            generationController = null;
            profileTestController?.abort();
            profileTestController = null;
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
    setMessage('nw-connection-status', ui.connectionStatus);
    $('[data-action="test-profile"]').prop('disabled', true);
    try {
        await testConnectionProfile(getContext(), selected, profileTestController.signal);
        ui.connectionStatus = 'Подключение отвечает.';
    } catch (error) {
        ui.connectionStatus = `Подключение не отвечает: ${error.message || error}`;
    } finally {
        profileTestController = null;
        setMessage('nw-connection-status', ui.connectionStatus);
        $('[data-action="test-profile"]').prop('disabled', false);
    }
}

async function saveSettingsForm() {
    const statuses = [document.getElementById('nw-settings-status'), document.getElementById('nw-connection-status')].filter(Boolean);
    try {
        const rule = readRegexForm();
        if (rule.pattern) await validateRegexRule(rule);
        settings.regex = rule;
        const profile = document.getElementById('nw-connection-profile');
        if (profile) settings.connection.profileId = profile.value || 'auto';
        const scanPrompt = document.getElementById('nw-scan-prompt');
        const generationPrompt = document.getElementById('nw-generation-prompt');
        if (scanPrompt) settings.prompts.scan = scanPrompt.value.trim() || DEFAULT_SCAN_PROMPT;
        if (generationPrompt) settings.prompts.outfit = generationPrompt.value.trim() || DEFAULT_GENERATION_PROMPT;
        commitSettings();
        ui.connectionStatus = 'Настройки сохранены.';
        for (const status of statuses) status.textContent = 'Настройки сохранены.';
    } catch (error) {
        for (const status of statuses) status.textContent = `Не сохранено: ${error.message || error}`;
    }
}

async function testRegex() {
    const status = document.getElementById('nw-settings-status');
    if (status) status.textContent = 'Проверяю правило…';
    try {
        const rule = await validateRegexRule(readRegexForm());
        const names = settings.subjects.flatMap(subjectNames);
        if (!names.length) throw new Error('Сначала создай хотя бы одну персону или персонажа.');
        const chat = getContext().chat || [];
        const texts = [];
        for (let index = chat.length - 1, checked = 0; index >= 0 && checked < rule.searchDepth; index--) {
            const message = chat[index];
            if (!message || message.is_system || typeof message.mes !== 'string') continue;
            checked++;
            texts.push({ key: index, text: message.mes });
        }
        const result = await runWardrobeRegex({ operation: 'replaceMany', texts, rule, targetNames: names, replacement: '[ПРОВЕРКА НОВОГО НАРЯДА]' });
        if (status) status.textContent = result.count ? `Правило работает: найдено ${result.count} поле(я) одежды в посте №${result.key}. Пост не изменён.` : `Правило корректно, но имена созданных персон и персонажей не найдены в последних ${rule.searchDepth} постах.`;
    } catch (error) {
        if (status) status.textContent = `Проверка не пройдена: ${error.message || error}`;
    }
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

function openInlineTagCreator(assignToDraft = false) {
    captureDraft();
    ui.tagCreator = { name: '', color: '#8a7aa5', assignToDraft, error: '' };
    render();
    requestAnimationFrame(() => document.getElementById('nw-inline-tag-name')?.focus());
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

function createInlineTag() {
    captureDraft();
    const editor = ui.tagCreator;
    if (!editor) return;
    const name = normalizeName(editor.name);
    if (!name) {
        editor.error = 'Заполни название тега.';
        render();
        return;
    }
    if (settings.tags.some(tag => comparableName(tag.name) === comparableName(name))) {
        editor.error = 'Такой тег уже существует. Выбери его в полосе тегов.';
        render();
        return;
    }
    const tag = normalizeTag({ id: uid('tag'), name, color: editor.color });
    settings.tags.push(tag);
    if (editor.assignToDraft && ui.draft && !ui.draft.tagIds.includes(tag.id)) ui.draft.tagIds.push(tag.id);
    ui.tagCreator = null;
    commitSettings();
    render();
    notify(`Тег «${tag.name}» создан.`, 'success');
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

async function handleImageFiles(files) {
    captureDraft();
    const available = Math.max(0, 3 - ui.draft.images.length);
    const chosen = [...(files || [])].slice(0, available);
    if (!chosen.length) return;
    setMessage('nw-image-status', 'Подготавливаю изображения…');
    const ownRevision = ++imageRevision;
    try {
        for (const file of chosen) {
            const image = await prepareImage(file, ui.draft.images.length ? 1280 : 640);
            if (ownRevision !== imageRevision || ui.view !== 'create') return;
            ui.draft.images.push(image);
        }
        render();
        setMessage('nw-image-status', 'Изображения добавлены в черновик.');
    } catch (error) {
        setMessage('nw-image-status', error.message || error);
    }
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

async function persistMessageChange(context, index, message) {
    if (typeof context.saveChat === 'function') await context.saveChat();
    else if (typeof mainModule?.saveChat === 'function') await mainModule.saveChat();
    else if (typeof mainModule?.saveChatDebounced === 'function') mainModule.saveChatDebounced();
    else throw new Error('SillyTavern не предоставил сохранение чата.');
    try { mainModule?.updateMessageBlock?.(index, message); } catch (error) { console.warn('[NESS Wardrobe] Message rerender failed:', error); }
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
    let rule;
    try { rule = await validateRegexRule(settings.regex); }
    catch (error) { notify(`Настрой вставку: ${error.message || error}`, 'warning'); return; }
    if (startRevision !== operationRevision) return;
    const context = getContext();
    if (!hasOpenChat(context) || !Array.isArray(context.chat)) return notify('Сначала открой чат.', 'warning');
    const chatRef = context.chat;
    const chatId = context.chatId;
    const ownRevision = startRevision;
    applyBusy = true;
    ui.status = `Ищу одежду ${subject.name}…`;
    render();
    try {
        const texts = [];
        for (let index = chatRef.length - 1, checked = 0; index >= 0 && checked < rule.searchDepth; index--) {
            const message = chatRef[index];
            if (!message || message.is_system || typeof message.mes !== 'string' || !message.mes.trim()) continue;
            checked++;
            texts.push({ key: index, text: message.mes });
        }
        const result = await runWardrobeRegex({ operation: 'replaceMany', texts, rule, targetNames: subjectNames(subject), replacement: outfit.description });
        if (ownRevision !== operationRevision) return;
        if (result.count) {
            const index = Number(result.key);
            const message = chatRef[index];
            const before = texts.find(item => item.key === index)?.text;
            const live = getContext();
            if (live.chat !== chatRef || live.chatId !== chatId || live.chat[index] !== message || message.mes !== before) throw new Error('Чат или выбранный пост изменился. Нажми на наряд ещё раз.');
            replaceMessageText(message, result.text);
            try {
                await persistMessageChange(live, index, message);
            } catch (error) {
                replaceMessageText(message, before);
                try { mainModule?.updateMessageBlock?.(index, message); } catch { /* best effort */ }
                throw new Error(`Пост не сохранён: ${error.message || error}`);
            }
            ui.undo = { chatRef, chatId, index, message, before, after: result.text, outfitName: outfit.name };
            ui.status = `«${outfit.name}» применён к ${subject.name} в посте №${index}.`;
            notify(ui.status, 'success');
            return;
        }
        ui.status = `В последних ${rule.searchDepth} постах не найдено поле одежды для «${subject.name}». Проверь имя, псевдонимы и правило.`;
        notify(ui.status, 'warning');
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
    const width = button.offsetWidth || 44;
    const height = button.offsetHeight || 44;
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
    $(document).on(`click${NS}`, '[data-view]', function () {
        captureDraft();
        operationRevision++;
        imageRevision++;
        generationController?.abort();
        generationController = null;
        profileTestController?.abort();
        profileTestController = null;
        ui.subjectCreator = null;
        ui.tagCreator = null;
        ui.view = this.dataset.view;
        render();
    });
    $(document).on(`click${NS}`, '[data-action="open"]', showPanel);
    $(document).on(`change${NS}`, '#nw-show-floating', function () { currentFloatingSettings().visible = this.checked; commitSettings(); render(); });
    $(document).on(`input${NS}`, '#nw-search', function () { ui.search = this.value; clearTimeout(searchTimer); searchTimer = setTimeout(() => renderGalleryGrid(true), 120); });
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
    $(document).on(`click${NS}`, '[data-action="edit-outfit"]', function () { const outfit = findOutfit(this.dataset.outfitId); if (!outfit) return; ui.draft = clone(outfit); ui.subjectCreator = null; ui.tagCreator = null; ui.createMode = 'write'; ui.view = 'create'; render(); });
    $(document).on(`click${NS}`, '[data-action="create-mode"]', function () { captureDraft(); operationRevision++; generationController?.abort(); generationController = null; ui.createMode = this.dataset.mode === 'generate' ? 'generate' : 'write'; render(); });
    $(document).on(`click${NS}`, '[data-action="reset-draft"]', () => { captureDraft(); imageRevision++; ui.draft = null; ui.subjectCreator = null; ui.tagCreator = null; ui.generator = { target: '', wishes: '', avoid: '' }; render(); });
    $(document).on(`click${NS}`, '[data-action="quick-subject"]', () => openInlineSubjectCreator('character', true));
    $(document).on(`click${NS}`, '[data-action="new-subject"]', function () { openInlineSubjectCreator(this.dataset.type, ui.view === 'create'); });
    $(document).on(`click${NS}`, '[data-action="new-tag"]', () => openInlineTagCreator(ui.view === 'create'));
    $(document).on(`click${NS}`, '[data-action="cancel-inline-subject"]', () => { captureDraft(); ui.subjectCreator = null; render(); });
    $(document).on(`click${NS}`, '[data-action="cancel-inline-tag"]', () => { captureDraft(); ui.tagCreator = null; render(); });
    $(document).on(`click${NS}`, '[data-action="create-inline-subject"]', createInlineSubject);
    $(document).on(`click${NS}`, '[data-action="create-inline-tag"]', createInlineTag);
    $(document).on(`keydown${NS}`, '#nw-inline-alias-input', function (event) { if (event.key !== 'Enter') return; event.preventDefault(); captureDraft(); const alias = normalizeName(this.value); const editor = ui.subjectCreator; if (!editor || !alias || editor.aliases.some(item => comparableName(item) === comparableName(alias))) return; editor.aliases.push(alias); render(); });
    $(document).on(`click${NS}`, '[data-action="remove-inline-alias"]', function () { captureDraft(); if (!ui.subjectCreator) return; ui.subjectCreator.aliases = ui.subjectCreator.aliases.filter(alias => alias !== this.dataset.alias); render(); });
    $(document).on(`click${NS}`, '[data-action="draft-tag"]', function () { captureDraft(); const id = this.dataset.tagId; ui.draft.tagIds.includes(id) ? ui.draft.tagIds = ui.draft.tagIds.filter(item => item !== id) : ui.draft.tagIds.push(id); render(); });
    $(document).on(`change${NS}`, '#nw-image-files', function () { const files = this.files; this.value = ''; void handleImageFiles(files); });
    $(document).on(`click${NS}`, '[data-action="remove-image"]', function () { captureDraft(); ui.draft.images = ui.draft.images.filter(image => image.id !== this.dataset.imageId); render(); });
    $(document).on(`click${NS}`, '[data-action="make-cover"]', function () { captureDraft(); const index = ui.draft.images.findIndex(image => image.id === this.dataset.imageId); if (index > 0) ui.draft.images.unshift(ui.draft.images.splice(index, 1)[0]); render(); });
    $(document).on(`click${NS}`, '[data-action="save-outfit"]', saveOutfit);
    $(document).on(`click${NS}`, '[data-action="delete-outfit"]', () => void deleteOutfit());
    $(document).on(`click${NS}`, '[data-action="generate-outfit"]', () => void generateFromForm());
    $(document).on(`click${NS}`, '[data-action="save-settings"]', () => void saveSettingsForm());
    $(document).on(`click${NS}`, '[data-action="test-regex"]', () => void testRegex());
    $(document).on(`click${NS}`, '[data-action="refresh-profiles"]', () => void refreshConnectionProfiles(true));
    $(document).on(`click${NS}`, '[data-action="test-profile"]', () => void testSelectedProfile());
    $(document).on(`click${NS}`, '[data-action="reset-scan-prompt"]', () => { const field = document.getElementById('nw-scan-prompt'); if (field) field.value = DEFAULT_SCAN_PROMPT; });
    $(document).on(`click${NS}`, '[data-action="reset-generation-prompt"]', () => { const field = document.getElementById('nw-generation-prompt'); if (field) field.value = DEFAULT_GENERATION_PROMPT; });
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
    imageRevision++;
    generationController?.abort();
    generationController = null;
    profileTestController?.abort();
    profileTestController = null;
    ui.view = 'gallery';
    ui.subjectFilter = '';
    ui.tagFilters.clear();
    ui.undo = null;
    ui.status = '';
    ui.draft = null;
    ui.subjectCreator = null;
    ui.tagCreator = null;
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
        console.log('[NESS Wardrobe] v1.2.0 ready');
    } catch (error) {
        console.error('[NESS Wardrobe] Failed to initialize:', error);
        notify('Гардероб не загрузился. Подробности — в консоли.', 'error');
    }
});
