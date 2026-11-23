// GitHub credentials are deliberately kept only in this module's memory.
// Never copy them to SillyTavern settings, the DOM or browser storage.
// Updating from pre-1.7.4 also removes the old persistent token.
const LEGACY_STORAGE_KEY = 'ness_wardrobe_github_token_v1';
let sessionToken = '';

try { globalThis.localStorage?.removeItem(LEGACY_STORAGE_KEY); }
catch { /* Browser storage may be disabled. */ }

export function getWebsiteToken() {
    return sessionToken;
}

export function setWebsiteToken(value) {
    sessionToken = String(value ?? '').trim();
    return Boolean(sessionToken);
}

export function clearWebsiteToken() {
    sessionToken = '';
}
