/**
 * Cloudflare Worker: Unsplash API proxy. The app is a static site, so a
 * build-time key is inlined into the bundle and readable by every visitor
 * (#534); this Worker holds the key and forwards the Unsplash calls the app
 * makes. Not a passthrough relay — a `/*` proxy would expose the whole API
 * under our key. Each fixed route forwards only its own parameter allowlist;
 * `/download` forwards the caller's query whole, minus `client_id`.
 *
 * Lives under `src/` (not a top-level `worker/`) so it stays in the one tree
 * `tsconfig.json` includes and lint scopes to (`lint-config.test.ts` asserts
 * the equality). Safe only while it imports nothing and nothing imports it
 * (`image-proxy.test.ts` pins both): it's type-checked against the *app's* lib
 * set, so a `document`/`localStorage` reference would compile and pass
 * `--dry-run`, then fail in production; and `deploy-worker.yml` redeploys only
 * on `src/worker/**`, so a shared module gets edited without republishing.
 *
 * **Routes are additive.** `registerType: 'prompt'` means a returning player
 * keeps their precached bundle until they accept an update, so one Worker
 * serves every client generation. Renaming/removing a route 404s those clients
 * (they degrade to the bundled image) — add the new route, wait, remove the old.
 */

/**
 * Set with `wrangler secret put`, a step separate from the deploy: until it
 * runs the binding is absent, not empty. Optional so the guard in
 * `handleRequest` doesn't read as dead code.
 */
export interface Env {
    UNSPLASH_ACCESS_KEY?: string;
}

const UNSPLASH_API_ORIGIN = 'https://api.unsplash.com';

/** How long to wait on Unsplash before giving the client a 502. */
const UPSTREAM_TIMEOUT_MS = 10_000;

/**
 * Origins allowed to read a response, beyond localhost (see
 * {@link isAllowedOrigin}). Not a security boundary — CORS is browser-enforced,
 * so a non-browser caller ignores it; it only stops the proxy being casually
 * embedded elsewhere and spending our quota. A fork must add its own Pages
 * origin here (api.unsplash.com's `Access-Control-Allow-Origin: *` meant `main`
 * needed no such step), or the picker works on localhost and fails once deployed.
 */
export const ALLOWED_ORIGINS: readonly string[] = [
    'https://adrianschmidt.github.io',
    'https://puzzlewise.github.io',
];

/**
 * Parameters forwarded to `/photos/random` — an allowlist, not a copy:
 * forwarding everything would let a caller add `collections`/`topics`/
 * `username` and reshape the search under our key. Exported so
 * `unsplash.test.ts` can assert the client emits exactly this set (the two
 * lists are otherwise independent).
 */
export const RANDOM_PARAMS: readonly string[] = [
    'query',
    'orientation',
    'count',
];

export const SEARCH_PARAMS: readonly string[] = [
    'query',
    'orientation',
    'page',
    'per_page',
];

export const FEED_PARAMS: readonly string[] = ['page', 'per_page'];

export const TOPIC_LIST_PARAMS: readonly string[] = ['page', 'per_page'];

export const TOPIC_PHOTOS_PARAMS: readonly string[] = ['page', 'per_page', 'orientation'];

/**
 * Format-checked rather than allowlisted: `/search` already forwards any
 * free-text query, so a slug list would add no protection.
 */
const TOPIC_PHOTOS_PATH = /^\/topics\/([a-z0-9-]+)\/photos$/;

const FIXED_ROUTES: ReadonlyMap<string, { upstreamPath: string; params: readonly string[] }> =
    new Map([
        ['/random', { upstreamPath: '/photos/random', params: RANDOM_PARAMS }],
        ['/search', { upstreamPath: '/search/photos', params: SEARCH_PARAMS }],
        ['/photos', { upstreamPath: '/photos', params: FEED_PARAMS }],
        ['/topics', { upstreamPath: '/topics', params: TOPIC_LIST_PARAMS }],
    ]);

/**
 * Shape of a legitimate `download_location` path. Without this check the Worker
 * would fetch any URL a caller named, with our key attached.
 */
const DOWNLOAD_PATH = /^\/photos\/[\w-]+\/download$/;

const FORWARDED_HEADERS: readonly string[] = [
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'link',
    'x-total',
    'x-per-page',
];

/**
 * Statuses the `Response` constructor refuses to pair with a body — and an
 * empty string is still a body, so passing one through here throws.
 */
const NULL_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * Headers common to every response. `no-store` because Unsplash's own
 * directives don't survive the hop. `vary` is unconditional:
 * the response that would poison a shared cache is the one *without* an
 * allow-origin header, so marking only the allowed branch would miss it.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    vary: 'Origin',
};

/**
 * Hosts a dev server can be reached on: loopback plus the RFC 1918 ranges, so
 * `npm run dev -- --host` on a phone still gets a working picker (which
 * api.unsplash.com allowed before this Worker, via `Access-Control-Allow-Origin: *`).
 */
const DEV_HOSTNAME =
    /^(?:localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * Whether an origin may read a response. Any port counts, because none is
 * knowable: `vite`/`vite preview` don't set `strictPort`, so a taken 5173/4173
 * (routine with sibling worktrees) silently binds the next. Widening this costs
 * nothing — CORS isn't the boundary (the upstream call and quota spend happen
 * first, so `curl` with no Origin is already more capable); the list only stops
 * casual embedding elsewhere, and no such site is served from a private network.
 */
function isAllowedOrigin(origin: string): boolean {
    if (ALLOWED_ORIGINS.includes(origin)) {
        return true;
    }

    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }

    return parsed.protocol === 'http:' && DEV_HOSTNAME.test(parsed.hostname);
}

function corsHeaders(origin: string | null): Record<string, string> {
    if (origin === null || !isAllowedOrigin(origin)) {
        return { ...BASE_HEADERS };
    }

    return {
        ...BASE_HEADERS,
        'access-control-allow-origin': origin,
        'access-control-expose-headers': FORWARDED_HEADERS.join(', '),
    };
}

function errorResponse(
    status: number,
    message: string,
    origin: string | null,
): Response {
    return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
    });
}

type Resolution =
    | { ok: true; url: string }
    | { ok: false; status: number; message: string };

/**
 * The key is deliberately *not* added here — it travels as an `Authorization`
 * header, so no URL this returns is secret. That lets a caller log a failing
 * upstream URL, and keeps the key out of Cloudflare's subrequest cache key and
 * out of any upstream error page that echoes the request. Exported (and pure):
 * every routing and validation decision lives here.
 */
function forwardParams(source: URL, target: URL, names: readonly string[]): void {
    for (const name of names) {
        const value = source.searchParams.get(name);
        if (value !== null) {
            target.searchParams.set(name, value);
        }
    }
}

export function resolveUpstream(url: URL): Resolution {
    const route = FIXED_ROUTES.get(url.pathname);

    if (route !== undefined) {
        const target = new URL(`${UNSPLASH_API_ORIGIN}${route.upstreamPath}`);
        forwardParams(url, target, route.params);

        return { ok: true, url: target.toString() };
    }

    const topic = TOPIC_PHOTOS_PATH.exec(url.pathname);

    if (topic !== null) {
        const target = new URL(`${UNSPLASH_API_ORIGIN}/topics/${topic[1]}/photos`);
        forwardParams(url, target, TOPIC_PHOTOS_PARAMS);

        return { ok: true, url: target.toString() };
    }

    if (url.pathname === '/download') {
        const raw = url.searchParams.get('url');

        if (raw === null) {
            return { ok: false, status: 400, message: 'Missing url parameter' };
        }

        let parsed: URL;
        try {
            parsed = new URL(raw);
        } catch {
            return { ok: false, status: 400, message: 'Malformed url parameter' };
        }

        // `origin` compares scheme/host/port exactly — a suffix match would
        // readmit `evil-unsplash.com` as an open relay. It ignores userinfo,
        // so reject `u:p@api.unsplash.com` here to keep the accepted set exact.
        if (
            parsed.origin !== UNSPLASH_API_ORIGIN
            || parsed.username !== ''
            || parsed.password !== ''
            || !DOWNLOAD_PATH.test(parsed.pathname)
        ) {
            return {
                ok: false,
                status: 400,
                message: 'url is not an Unsplash download location',
            };
        }

        // Unlike /random this forwards the query whole (so a param Unsplash
        // later adds to download_location keeps working). `client_id` must not
        // survive: it would let a caller nominate which key Unsplash bills.
        parsed.searchParams.delete('client_id');

        return { ok: true, url: parsed.toString() };
    }

    return { ok: false, status: 404, message: 'Not found' };
}

/**
 * Upstream status codes pass through unchanged — a 403 reaches the client as a
 * 403, which makes the #533 rate-limit telemetry work without touching this
 * Worker again.
 */
export async function handleRequest(
    request: Request,
    env: Env,
    fetchFn: typeof fetch = fetch,
): Promise<Response> {
    const origin = request.headers.get('Origin');

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                ...corsHeaders(origin),
                'access-control-allow-methods': 'GET, OPTIONS',
                'access-control-max-age': '86400',
            },
        });
    }

    if (request.method !== 'GET') {
        return errorResponse(405, 'Method not allowed', origin);
    }

    // The secret is set separately from the deploy, so a Worker can be live
    // without a key. Without this the call goes upstream unauthorized and
    // returns Unsplash's opaque 401 — reads as a bad key, not missing setup.
    const accessKey = env.UNSPLASH_ACCESS_KEY;
    if (!accessKey) {
        return errorResponse(500, 'Proxy not configured', origin);
    }

    const resolved = resolveUpstream(new URL(request.url));

    if (!resolved.ok) {
        return errorResponse(resolved.status, resolved.message, origin);
    }

    let upstream: Response;
    let body: string;

    try {
        upstream = await fetchFn(resolved.url, {
            headers: {
                Authorization: `Client-ID ${accessKey}`,
                // The client can't send this (an extra header would make its
                // GET preflighted), so this is the only place — without it a v2
                // response shape fails isUnsplashPhoto and falls back to bundled.
                'Accept-Version': 'v1',
            },
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        body = await upstream.text();
    } catch {
        // Keep every failure on errorResponse's shape (JSON + CORS) instead of
        // letting the exception escape to the runtime's headerless HTML page,
        // which the browser can't read across origins.
        return errorResponse(502, 'Upstream request failed', origin);
    }

    const headers: Record<string, string> = {
        // Stated, not copied: reflecting upstream's content-type is the one
        // place an upstream-controlled string reaches the browser from our
        // origin — enough to re-serve an Unsplash HTML error page as HTML on a
        // workers.dev subdomain. nosniff doesn't stop a *wrong* declared type.
        'content-type': 'application/json',
        ...corsHeaders(origin),
    };

    for (const name of FORWARDED_HEADERS) {
        const value = upstream.headers.get(name);
        if (value !== null) {
            headers[name] = value;
        }
    }

    return new Response(
        NULL_BODY_STATUSES.has(upstream.status) ? null : body,
        { status: upstream.status, headers },
    );
}

export default {
    fetch(request: Request, env: Env): Promise<Response> {
        return handleRequest(request, env);
    },
};
