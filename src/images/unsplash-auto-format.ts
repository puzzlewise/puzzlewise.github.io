/**
 * `auto=format` makes the CDN pick AVIF or WebP from the request's `Accept`
 * header. The URL's own `fm=jpg` stays as the fallback, which is what a plain
 * `fetch()` gets, so the offline stash stores JPEG.
 */
export function withAutoFormat(url: string): string {
    return `${url}${url.includes('?') ? '&' : '?'}auto=format`;
}
