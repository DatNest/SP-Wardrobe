import { uid } from './core.js';

function readBlob(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Не удалось прочитать подготовленное изображение.'));
        reader.readAsDataURL(blob);
    });
}

function loadImage(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const image = new Image();
        image.onload = () => resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) });
        image.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Не удалось открыть изображение «${file.name}».`)); };
        image.src = url;
    });
}

async function decode(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
            return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
        } catch {
            // Older mobile browsers use the Image fallback below.
        }
    }
    return loadImage(file);
}

function canvasBlob(canvas, type, quality) {
    return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file, maxSide = 1280) {
    if (!(file instanceof Blob) || !String(file.type || '').startsWith('image/')) throw new Error('Выбери файл изображения.');
    if (file.size > 12 * 1024 * 1024) throw new Error(`«${file.name || 'Изображение'}» больше 12 МБ.`);
    const decoded = await decode(file);
    try {
        if (!decoded.width || !decoded.height) throw new Error('У изображения нет доступного размера.');
        const scale = Math.min(1, maxSide / Math.max(decoded.width, decoded.height));
        const width = Math.max(1, Math.round(decoded.width * scale));
        const height = Math.max(1, Math.round(decoded.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d', { alpha: true });
        if (!context) throw new Error('Браузер не смог подготовить изображение.');
        context.drawImage(decoded.source, 0, 0, width, height);
        let blob = await canvasBlob(canvas, 'image/webp', 0.82);
        if (!blob || blob.type !== 'image/webp') blob = await canvasBlob(canvas, 'image/jpeg', 0.84);
        if (!blob) throw new Error('Браузер не смог сжать изображение.');
        const dataUrl = await readBlob(blob);
        if (dataUrl.length > 2_500_000) throw new Error('Подготовленное изображение всё ещё слишком большое. Выбери файл меньшего размера.');
        return { id: uid('image'), name: String(file.name || 'image').slice(0, 120), dataUrl };
    } finally {
        decoded.release();
    }
}

export async function imageFileFromUrl(value, signal) {
    let url;
    try { url = new URL(String(value || '').trim()); }
    catch { throw new Error('Вставь полную ссылку на изображение, начинающуюся с http:// или https://.'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Поддерживаются только ссылки http:// и https://.');

    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) cancel();
    else signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
        let response;
        try {
            response = await fetch(url.href, {
                signal: controller.signal,
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                cache: 'no-store',
            });
        } catch (error) {
            if (controller.signal.aborted) throw new Error('Загрузка изображения отменена или заняла больше 20 секунд.');
            throw new Error('Сайт не разрешил загрузить изображение. Попробуй прямую ссылку на файл или сохрани его на устройство.');
        }
        if (!response.ok) throw new Error(`Ссылка вернула ошибку HTTP ${response.status}.`);
        const declaredSize = Number(response.headers.get('content-length') || 0);
        if (declaredSize > 12 * 1024 * 1024) throw new Error('Изображение по ссылке больше 12 МБ.');
        const blob = await response.blob();
        if (!String(blob.type || '').startsWith('image/')) throw new Error('По ссылке получен не файл изображения.');
        if (blob.size > 12 * 1024 * 1024) throw new Error('Изображение по ссылке больше 12 МБ.');
        const pathName = decodeURIComponent(url.pathname.split('/').pop() || 'image').slice(0, 100);
        const fileName = /\.[a-z\d]{2,5}$/i.test(pathName) ? pathName : `${pathName || 'image'}.${blob.type.split('/')[1] || 'img'}`;
        return typeof File === 'function' ? new File([blob], fileName, { type: blob.type }) : Object.assign(blob, { name: fileName });
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}
