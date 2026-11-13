const TOKEN_KEY = 'ness_wardrobe_github_token_v1';

export function getWebsiteToken() {
    try { return globalThis.localStorage?.getItem(TOKEN_KEY) || ''; }
    catch { return ''; }
}

export function setWebsiteToken(value) {
    const token = String(value || '').trim();
    try {
        if (token) globalThis.localStorage?.setItem(TOKEN_KEY, token);
        else globalThis.localStorage?.removeItem(TOKEN_KEY);
    } catch { /* unavailable in private or restricted browser mode */ }
    return token;
}
