/**
 * URL-scheme guard for values that end up in an anchor `href`. Attribution URLs
 * in a share link are attacker-controlled — a crafted `#p=...` can set a
 * `javascript:`/`data:` scheme that executes on click (rel/target don't stop
 * it). Restricting to absolute http(s) closes it while accepting every
 * legitimate (https Unsplash) link.
 */
export function isSafeHttpUrl(url: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        // Relative or malformed URLs have no scheme we can trust.
        return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

const IMAGE_MIME_PREFIX = 'image/';

/**
 * URL-scheme guard for a share link's image URL (`SharePayload.i`), which
 * reaches `state.imageUrl`. Wider than
 * {@link isSafeHttpUrl} (which requires absolute http(s) for anchor hrefs):
 * accepts the `'blank'` sentinel, `data:image/*` (legacy blank-puzzle PNGs;
 * `image/` subtypes only), and same-origin relative URLs (the bundled image).
 * "Relative" is *tested*, not inferred from a failed parse: a protocol-relative
 * `//evil.example/x.png` also throws in `new URL()` yet resolves cross-origin
 * (a relative ref inherits the base's scheme, not origin) — hence the sentinel
 * base in {@link isSameOriginRelative}.
 *
 * Rejects `javascript:`/`vbscript:`/`file:`/`blob:` and every other scheme
 * (`blob:` deliberately — the only createObjectURL is the save-download anchor,
 * never an image, and a sharer's blob is dead on the recipient's machine).
 * Host is NOT checked: http(s) is accepted for any host, because no scheme
 * check separates Unsplash from `evil.example`. The origin policy that stops a
 * tracking pixel lives in the `img-src` CSP in index.html.
 */
export function isSafeImageUrl(url: string): boolean {
    if (url === 'blank') return true;
    if (url.trim() === '') return false;

    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return isSameOriginRelative(url);
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return true;
    // Read the MIME off `pathname`, not a lowercased whole `href` (allocating a
    // copy of a long URL on the boot path). `protocol` is already lowercased by
    // the parser; `pathname` is not, so `data:IMAGE/png,x` still needs the fold.
    return parsed.protocol === 'data:'
        && parsed.pathname.slice(0, IMAGE_MIME_PREFIX.length).toLowerCase() === IMAGE_MIME_PREFIX;
}

/**
 * Parses rather than prefix-matching, so it accepts every spelling `new URL`
 * does (uppercase, leading/inner whitespace the parser strips). Callers use it
 * to detect the legacy synthesized blank image; a stricter test would let a
 * spelling through that the app then treats as a real image URL.
 */
export function isDataUrl(url: string): boolean {
    try {
        return new URL(url).protocol === 'data:';
    } catch {
        return false;
    }
}

/**
 * Resolve against a sentinel base and require the origin back, rather than
 * treating a `new URL()` throw as proof of relativeness: the throw only means
 * no scheme, and `//evil.example/x.png` clears that bar yet resolves cross-origin.
 */
function isSameOriginRelative(url: string): boolean {
    const base = 'https://relative.invalid';
    try {
        return new URL(url, `${base}/`).origin === base;
    } catch {
        return false;
    }
}
