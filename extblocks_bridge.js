export const DEFAULT_LOOK_TEMPLATE = 'Как рисовать {{name}}:\n{{desc}}\n\nДУБЛИРУЙ ПОЛНОСТЬЮ ВСЕ ТЕГИ ВНЕШНОСТИ ЦЕЛИКОМ.';

export function renderLookTemplate(template, look) {
    const source = String(template || '').trim() || DEFAULT_LOOK_TEMPLATE;
    const name = String(look?.name || '').trim();
    const desc = String(look?.desc || '').trim();
    let text = source.replace(/\{\{\s*name\s*\}\}/gi, () => name).replace(/\{\{\s*desc\s*\}\}/gi, () => desc);
    if (!/\{\{\s*desc\s*\}\}/i.test(source) && desc) text += `\n\n${desc}`;
    return text.trim();
}

function scopedBlocks(context) {
    if (context?.characterId === undefined) return null;
    const blocks = context.characters?.[context.characterId]?.data?.extensions?.ExtBlocks;
    return Array.isArray(blocks) ? blocks : null;
}

function validBlock(block) {
    return block && block.name && block.block_type !== 'accumulation' && block.block_type !== 'script'
        && (Array.isArray(block.context) || block.block_type === undefined || block.block_type === 'generated' || block.block_type === 'rewrite');
}

export function listExtBlockTargets(context) {
    const store = context?.extensionSettings?.ExtBlocks || context?.extension_settings?.ExtBlocks;
    if (!Array.isArray(store?.sets)) return [];
    const targets = [];
    const scoped = scopedBlocks(context);
    if (scoped) for (const block of scoped) if (validBlock(block)) targets.push({ ref: `s:${block.id}`, label: `${block.name} (персонаж)`, block, scoped: true });
    store.sets.forEach((set, setIndex) => {
        for (const block of Array.isArray(set.global_blocks) ? set.global_blocks : []) {
            if (validBlock(block)) targets.push({ ref: `g:${setIndex}:${block.id}`, label: store.sets.length > 1 ? `${block.name} · ${set.name}` : block.name, block, scoped: false });
        }
    });
    return targets;
}

export function pickExtBlockTarget(context, savedRef, savedName = 'nai_imagen') {
    const targets = listExtBlockTargets(context);
    return targets.find(item => item.ref === savedRef) || targets.find(item => item.block.name === savedName) || targets[0] || null;
}

function findLookIndex(block, look) {
    const legacyName = `APPEARANCE: ${look.name}`;
    return (Array.isArray(block?.context) ? block.context : []).findIndex(item => item && (
        item.wcat_look === look.id || item.ness_wardrobe_look === look.id || (item.type === 'text' && item.name === legacyName)
    ));
}

export function extBlockLookState(block, look) {
    const index = findLookIndex(block, look);
    return { present: index >= 0, disabled: index >= 0 && block.context[index].disabled === true };
}

async function persistTarget(context, target) {
    if (target.scoped) {
        const blocks = scopedBlocks(context);
        if (blocks && typeof context.writeExtensionField === 'function') await context.writeExtensionField(context.characterId, 'ExtBlocks', blocks);
    }
    context.saveSettingsDebounced?.();
}

function contextId(context) {
    return context?.uuidv4?.() || `ness_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function sendWebsiteLook(context, target, look, template) {
    if (!target) throw new Error('Выбери блок ExtBlocks.');
    const block = target.block;
    if (!Array.isArray(block.context)) block.context = [];
    const index = findLookIndex(block, look);
    const item = {
        id: index >= 0 ? block.context[index].id : contextId(context),
        name: look.name,
        role: 'system',
        type: 'text',
        disabled: false,
        text: renderLookTemplate(template, look),
        wcat_look: look.id,
        ness_wardrobe_look: look.id,
    };
    if (index >= 0) block.context[index] = { ...block.context[index], ...item };
    else block.context.push(item);
    await persistTarget(context, target);
    return index >= 0 ? 'updated' : 'added';
}

export async function toggleWebsiteLook(context, target, look) {
    const index = target ? findLookIndex(target.block, look) : -1;
    if (index < 0) return null;
    target.block.context[index].disabled = !target.block.context[index].disabled;
    await persistTarget(context, target);
    return !target.block.context[index].disabled;
}

export async function removeWebsiteLook(context, target, look) {
    const index = target ? findLookIndex(target.block, look) : -1;
    if (index < 0) return false;
    target.block.context.splice(index, 1);
    await persistTarget(context, target);
    return true;
}
