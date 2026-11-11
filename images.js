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
