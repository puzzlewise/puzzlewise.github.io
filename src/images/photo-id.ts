const DOWNLOAD_PATH = /^\/photos\/([\w-]+)\/download$/;

/**
 * Every photo source the app uses (page draws, backup pool, offline stash)
 * carries a `download_location`, so the Unsplash id is read from it rather
 * than stored separately.
 */
export function photoIdFromDownloadLocation(url: string | undefined): string | undefined {
    if (url === undefined) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return undefined;
    }
    if (parsed.origin !== 'https://api.unsplash.com' || parsed.username !== '' || parsed.password !== '') {
        return undefined;
    }
    return DOWNLOAD_PATH.exec(parsed.pathname)?.[1];
}
