/**
 * The handler is exercised directly, not through a Workers runtime: it takes
 * `(request, env, fetchFn)` and uses only standard web APIs, so a plain vitest
 * run covers every routing and validation decision.
 */

import { describe, it, expect, vi } from 'vitest';
import {
    ALLOWED_ORIGINS,
    handleRequest,
    resolveUpstream,
    type Env,
} from './image-proxy.js';
import wranglerSrc from '../../wrangler.jsonc?raw';
import deployWorkerSrc from '../../.github/workflows/deploy-worker.yml?raw';

const ENV: Env = { UNSPLASH_ACCESS_KEY: 'test-key' };

/**
 * Spelled out, not read from `ALLOWED_ORIGINS[0]`: taking it from the array
 * would make every CORS assertion self-referential, so dropping the production
 * origin would leave the suite green.
 */
const ALLOWED = 'https://adrianschmidt.github.io';

/** A `download_location` shaped like the ones Unsplash actually returns. */
const DOWNLOAD_LOCATION =
    'https://api.unsplash.com/photos/mEZ3PoFGs_k/download?ixid=abc123';

function get(path: string, origin?: string): Request {
    return new Request(`https://proxy.example${path}`, {
        headers: origin === undefined ? {} : { Origin: origin },
    });
}

/**
 * The upstream URL a resolution routes to, asserting it resolved at all — so a
 * routing regression fails by name, not as `Invalid URL` elsewhere.
 */
function upstreamUrl(result: ReturnType<typeof resolveUpstream>): URL {
    expect(result.ok).toBe(true);

    return new URL((result as { url: string }).url);
}

/**
 * Stub upstream recording the URL it was called with. Clones per call because
 * a `Response` body is single-use — a second read would surface as a silent
 * 502 from the handler's catch.
 */
function stubFetch(
    response: Response = new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
    }),
) {
    return vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(response.clone()));
}

function authHeader(call: Parameters<typeof fetch>): string | null {
    return new Headers(call[1]?.headers).get('authorization');
}

/**
 * Guard: the Worker is an island. It's type-checked against the *app's* lib
 * set, so importing app code (or touching document/localStorage) compiles,
 * lints and passes `wrangler deploy --dry-run`, then throws in workerd. And
 * `deploy-worker.yml` redeploys only on `src/worker/**`, so a shared module
 * gets edited without republishing the Worker. The reverse is the bundle leak:
 * an app module importing from here puts api.unsplash.com back into the bundle.
 */
describe('the image-proxy Worker island', () => {
    /**
     * Every `.ts` under `src/`, read as text. `import.meta.glob`, not
     * `node:fs`, because `@types/node` isn't a dependency here.
     */
    const SOURCES = import.meta.glob('/src/**/*.ts', {
        query: '?raw',
        import: 'default',
        eager: true,
    }) as Record<string, string>;

    /**
     * Every non-test module wrangler could pull into the Worker — the whole
     * directory, since the outbound guard permits siblings and must inspect
     * them too (a `src/worker/helpers.ts` importing app code would slip past).
     */
    const WORKER_SOURCES = Object.entries(SOURCES).filter(
        ([path]) => path.startsWith('/src/worker/') && !path.endsWith('.test.ts'),
    );

    /** Module specifiers a source names, in any form that creates an edge. */
    function specifiersIn(source: string): string[] {
        return [
            ...source.matchAll(
                /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g,
            ),
        ].map((match) => match[1]);
    }

    it('lives where deploy-worker.yml watches', () => {
        // Two independent strings: wrangler.jsonc's `main` decides what
        // deploys, deploy-worker.yml's path filter decides when. A coordinated
        // move keeps CI green while every subsequent Worker edit stops
        // triggering a deploy — the divergence begins one commit later.
        const main = (JSON.parse(
            wranglerSrc.replace(/^\s*\/\/.*$/gm, ''),
        ) as { main: string }).main;

        const watched = [
            ...deployWorkerSrc.matchAll(/^\s*-\s*'([^']+)'/gm),
        ].map((m) => m[1]);

        expect(watched).toContain('src/worker/**');
        expect(main.startsWith('src/worker/')).toBe(true);
    });

    it('has sources to scan', () => {
        // Both scans below are "no match found" assertions, so a glob that
        // silently matched nothing would leave them vacuously green forever.
        expect(WORKER_SOURCES.length).toBeGreaterThan(0);
        expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
        expect(SOURCES).toHaveProperty('/src/images/unsplash.ts');
    });

    it('imports nothing from outside its own directory', () => {
        // The property the whole src/worker/ placement rests on. Matches every
        // edge form (static/dynamic/side-effect import, re-export), scoped to
        // specifiers that *leave* src/worker/ — a sibling breaks neither
        // property (wrangler bundles from main; editing it still trips the
        // path filter).
        const escaping = WORKER_SOURCES.flatMap(([path, source]) =>
            specifiersIn(source)
                .filter((s) => !s.startsWith('./') || s.includes('../'))
                .map((s) => `${path} -> ${s}`),
        );

        expect(escaping).toEqual([]);
    });

    it('reaches for no browser-only global', () => {
        // The more dangerous hazard: `document` type-checks here (compiled
        // against the app's DOM lib) and passes --dry-run, then throws in
        // workerd. Matches the property-access form, not the bare identifier,
        // so the module header can name these globals in prose; stripping
        // comments instead would eat `https://` and false-negative.
        const hits = WORKER_SOURCES.flatMap(([path, source]) =>
            (
                source.match(
                    /\b(?:document|window|localStorage|sessionStorage|navigator)\s*[.[]/g,
                ) ?? []
            ).map((hit) => `${path} -> ${hit}`),
        );

        expect(hits).toEqual([]);
    });

    it('is imported by no shipped module', () => {
        // Matches the same edge forms as the outbound guard — dynamic import()
        // is how this repo code-splits, so a from-only pattern would miss the
        // likeliest offender.
        const offenders = Object.entries(SOURCES)
            .filter(
                ([path]) =>
                    !path.startsWith('/src/worker/')
                    && !path.endsWith('.test.ts'),
            )
            .filter(([, source]) =>
                specifiersIn(source).some((s) => /(^|\/)worker\//.test(s)),
            )
            .map(([path]) => path);

        expect(offenders).toEqual([]);
    });
});

describe('ALLOWED_ORIGINS', () => {
    it('includes the production origin', () => {
        // The live picker fails CORS the moment this drops out, and no other
        // test in this file would notice.
        expect(ALLOWED_ORIGINS).toContain(ALLOWED);
    });

    it('includes the puzzlewise origin', () => {
        expect(ALLOWED_ORIGINS).toContain('https://puzzlewise.github.io');
    });
});

describe('resolveUpstream', () => {
    it('routes /random to the Unsplash random endpoint', () => {
        const url = upstreamUrl(
            resolveUpstream(new URL('https://proxy.example/random')),
        );

        expect(url.origin).toBe('https://api.unsplash.com');
        expect(url.pathname).toBe('/photos/random');
    });

    it('forwards query, orientation and count', () => {
        const url = upstreamUrl(
            resolveUpstream(
                new URL(
                    'https://proxy.example/random?query=face&orientation=portrait&count=4',
                ),
            ),
        );

        expect(url.searchParams.get('query')).toBe('face');
        expect(url.searchParams.get('orientation')).toBe('portrait');
        expect(url.searchParams.get('count')).toBe('4');
    });

    it('drops parameters outside the allowlist', () => {
        // The allowlist's point: collections/topics would reshape the search
        // under our key, username would mine one photographer via our quota.
        const url = upstreamUrl(
            resolveUpstream(
                new URL(
                    'https://proxy.example/random?collections=123&topics=nature&username=someone',
                ),
            ),
        );

        expect(url.searchParams.get('collections')).toBeNull();
        expect(url.searchParams.get('topics')).toBeNull();
        expect(url.searchParams.get('username')).toBeNull();
    });

    it('does not let a caller nominate the key /random is billed to', () => {
        const url = upstreamUrl(
            resolveUpstream(
                new URL('https://proxy.example/random?client_id=attacker-key'),
            ),
        );

        expect(url.searchParams.get('client_id')).toBeNull();
    });

    it.each([
        ['/search', '/search/photos'],
        ['/photos', '/photos'],
        ['/topics', '/topics'],
    ])('routes %s to Unsplash %s', (path, upstreamPath) => {
        const url = upstreamUrl(resolveUpstream(new URL(`https://proxy.example${path}`)));

        expect(url.origin).toBe('https://api.unsplash.com');
        expect(url.pathname).toBe(upstreamPath);
    });

    it('forwards query, orientation, page and per_page on /search', () => {
        const url = upstreamUrl(resolveUpstream(new URL(
            'https://proxy.example/search?query=nature&orientation=portrait&page=7&per_page=30',
        )));

        expect(Object.fromEntries(url.searchParams)).toEqual({
            query: 'nature', orientation: 'portrait', page: '7', per_page: '30',
        });
    });

    it.each(['/photos', '/topics'])('forwards only page and per_page on %s', (path) => {
        const url = upstreamUrl(resolveUpstream(new URL(
            `https://proxy.example${path}?page=3&per_page=30&order_by=popular&query=x&orientation=portrait`,
        )));

        expect(Object.fromEntries(url.searchParams)).toEqual({ page: '3', per_page: '30' });
    });

    it.each(['/search', '/photos', '/topics'])('drops client_id and unlisted parameters on %s', (path) => {
        const url = upstreamUrl(resolveUpstream(new URL(
            `https://proxy.example${path}?client_id=attacker-key&collections=1&content_filter=high&username=x`,
        )));

        expect([...url.searchParams.keys()]).toEqual([]);
    });

    it('routes /topics/:slug/photos to the topic photo list', () => {
        const url = upstreamUrl(resolveUpstream(new URL(
            'https://proxy.example/topics/architecture-interior/photos?page=2&per_page=30&orientation=landscape&order_by=popular&client_id=k',
        )));

        expect(url.origin).toBe('https://api.unsplash.com');
        expect(url.pathname).toBe('/topics/architecture-interior/photos');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            page: '2', per_page: '30', orientation: 'landscape',
        });
    });

    it.each([
        '/topics/Nature/photos',
        '/topics//photos',
        '/topics/a%2Fb/photos',
        '/topics/na_ture/photos',
        '/topics/nature',
        '/topics/nature/photos/extra',
        '/topics/nature/photos/',
    ])('404s %s', (path) => {
        expect(resolveUpstream(new URL(`https://proxy.example${path}`))).toEqual({
            ok: false, status: 404, message: 'Not found',
        });
    });

    it('lets no dot-segment slug reach a topic URL', () => {
        // WHATWG URL parsing treats %2e%2e as `..`, so this arrives as /photos.
        const url = upstreamUrl(resolveUpstream(new URL('https://proxy.example/topics/%2e%2e/photos')));

        expect(url.pathname).toBe('/photos');
    });

    it('404s a trailing-slash variant of a route', () => {
        expect(resolveUpstream(new URL('https://proxy.example/search/'))).toEqual({
            ok: false, status: 404, message: 'Not found',
        });
    });

    it('routes a valid /download URL', () => {
        const url = upstreamUrl(
            resolveUpstream(
                new URL(
                    `https://proxy.example/download?url=${encodeURIComponent(DOWNLOAD_LOCATION)}`,
                ),
            ),
        );

        expect(url.origin).toBe('https://api.unsplash.com');
        expect(url.pathname).toBe('/photos/mEZ3PoFGs_k/download');
        expect(url.searchParams.get('ixid')).toBe('abc123');
    });

    it('does not let a caller nominate the key /download is billed to', () => {
        // This route forwards the caller's query whole, so unlike /random the
        // allowlist is not doing the work — the parameter is stripped by name.
        const url = upstreamUrl(
            resolveUpstream(
                new URL(
                    `https://proxy.example/download?url=${encodeURIComponent(
                        `${DOWNLOAD_LOCATION}&client_id=attacker-key`,
                    )}`,
                ),
            ),
        );

        expect(url.searchParams.get('client_id')).toBeNull();
    });

    it('rejects a /download URL on another origin', () => {
        // Without this the Worker is an open relay that attaches our key to
        // any URL a caller names.
        const result = resolveUpstream(
            new URL(
                `https://proxy.example/download?url=${encodeURIComponent('https://evil.example/photos/x/download')}`,
            ),
        );

        expect(result).toEqual({
            ok: false,
            status: 400,
            message: 'url is not an Unsplash download location',
        });
    });

    // All look like api.unsplash.com to a careless check. The first two matter
    // most: a suffix match (`endsWith('unsplash.com')`) would wave them
    // through, the likeliest way this guard becomes an open relay.
    it.each([
        ['hostname ending in unsplash.com', 'https://evil-unsplash.com/photos/x/download'],
        ['different unsplash.com subdomain', 'https://cdn.unsplash.com/photos/x/download'],
        ['userinfo before the host', 'https://api.unsplash.com@evil.example/photos/x/download'],
        ['userinfo on the real host', 'https://user:pass@api.unsplash.com/photos/x/download'],
        ['hostname suffix', 'https://api.unsplash.com.evil.example/photos/x/download'],
        ['different TLD', 'https://api.unsplash.com.co/photos/x/download'],
        ['scheme downgrade', 'http://api.unsplash.com/photos/x/download'],
        ['encoded traversal', 'https://api.unsplash.com/photos/x%2f..%2f..%2fusers%2fme/download'],
    ])('rejects a /download URL that only looks like Unsplash (%s)', (_label, hostile) => {
        const result = resolveUpstream(
            new URL(
                `https://proxy.example/download?url=${encodeURIComponent(hostile)}`,
            ),
        );

        expect(result.ok).toBe(false);
    });

    it('rejects an Unsplash URL that is not a download location', () => {
        const result = resolveUpstream(
            new URL(
                `https://proxy.example/download?url=${encodeURIComponent('https://api.unsplash.com/users/someone')}`,
            ),
        );

        expect(result.ok).toBe(false);
    });

    it('rejects a missing url parameter', () => {
        const result = resolveUpstream(
            new URL('https://proxy.example/download'),
        );

        expect(result).toEqual({
            ok: false,
            status: 400,
            message: 'Missing url parameter',
        });
    });

    it('rejects a malformed url parameter', () => {
        const result = resolveUpstream(
            new URL('https://proxy.example/download?url=not-a-url'),
        );

        expect(result).toEqual({
            ok: false,
            status: 400,
            message: 'Malformed url parameter',
        });
    });

    it('404s an unknown path', () => {
        const result = resolveUpstream(
            new URL('https://proxy.example/photos/random'),
        );

        expect(result).toEqual({
            ok: false,
            status: 404,
            message: 'Not found',
        });
    });
});

describe('handleRequest', () => {
    it('forwards to Unsplash and returns the body', async () => {
        const fetchFn = stubFetch(
            new Response('{"id":"abc"}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );

        const response = await handleRequest(get('/random'), ENV, fetchFn);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe('{"id":"abc"}');
        expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('authenticates with a header rather than a query parameter', async () => {
        const fetchFn = stubFetch();

        await handleRequest(get('/random'), ENV, fetchFn);

        expect(authHeader(fetchFn.mock.calls[0])).toBe('Client-ID test-key');
        expect(fetchFn.mock.calls[0][0]).not.toContain('test-key');
    });

    it('pins the Unsplash API version', async () => {
        // The client can't send this (an extra header would make its GET
        // preflighted), so the Worker is the only place for it — without it a
        // v2 response shape fails isUnsplashPhoto and degrades to bundled images.
        const fetchFn = stubFetch();

        await handleRequest(get('/random'), ENV, fetchFn);

        expect(
            new Headers(fetchFn.mock.calls[0][1]?.headers).get(
                'accept-version',
            ),
        ).toBe('v1');
    });

    it('bounds how long it will wait on Unsplash', async () => {
        // The client can't cancel this (#536), so this signal is all that
        // stands between a stalled upstream and a browser-length wait — the
        // duration is the point, not just presence. The literal is spelled out
        // so raising UPSTREAM_TIMEOUT_MS is a deliberate edit here too.
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const fetchFn = stubFetch();

        await handleRequest(get('/random'), ENV, fetchFn);

        expect(fetchFn.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
        expect(timeout).toHaveBeenCalledWith(10_000);

        timeout.mockRestore();
    });

    it('passes an upstream rate-limit status through unchanged', async () => {
        // #533 depends on this: a 403 must not be flattened to 200/500, or the
        // client can't tell a rate limit from any other failure.
        const fetchFn = stubFetch(
            new Response('{"errors":["Rate Limit Exceeded"]}', { status: 403 }),
        );

        const response = await handleRequest(get('/random'), ENV, fetchFn);

        expect(response.status).toBe(403);
    });

    it('forwards the rate-limit headers and exposes them to the browser', async () => {
        const fetchFn = stubFetch(
            new Response('{}', {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'x-ratelimit-limit': '50',
                    'x-ratelimit-remaining': '11',
                },
            }),
        );

        const response = await handleRequest(
            get('/random', ALLOWED),
            ENV,
            fetchFn,
        );

        expect(response.headers.get('x-ratelimit-remaining')).toBe('11');
        expect(response.headers.get('access-control-expose-headers')).toContain(
            'x-ratelimit-remaining',
        );
    });

    it('forwards the pagination headers and exposes them to the browser', async () => {
        const link = '<https://api.unsplash.com/photos?page=346>; rel="last"';
        const fetchFn = stubFetch(
            new Response('[]', {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    link,
                    'x-total': '10380',
                    'x-per-page': '30',
                },
            }),
        );

        const response = await handleRequest(
            get('/photos?per_page=30', ALLOWED),
            ENV,
            fetchFn,
        );

        expect(response.headers.get('link')).toBe(link);
        expect(response.headers.get('x-total')).toBe('10380');
        expect(response.headers.get('x-per-page')).toBe('30');
        const exposed = response.headers.get('access-control-expose-headers') ?? '';
        expect(exposed.split(', ')).toEqual(expect.arrayContaining(['link', 'x-total', 'x-per-page']));
    });

    it('allows a known origin to read the response', async () => {
        const response = await handleRequest(
            get('/random', ALLOWED),
            ENV,
            stubFetch(),
        );

        expect(response.headers.get('access-control-allow-origin')).toBe(
            ALLOWED,
        );
        expect(response.headers.get('vary')).toBe('Origin');
    });

    it.each([
        'http://localhost:5173',
        'http://localhost:4173',
        'http://localhost:5174',
        'http://127.0.0.1:8080',
        'http://192.168.1.42:5173',
        'http://10.0.0.7:5173',
        'http://172.16.0.3:5173',
    ])('allows any port on the developer machine (%s)', async (origin) => {
        // `vite`/`vite preview` fall back to the next free port, so pinning
        // literal ones broke the picker with sibling worktrees running. The
        // private ranges are `dev --host` on a phone, which worked on main
        // because api.unsplash.com answers `Access-Control-Allow-Origin: *`.
        const response = await handleRequest(
            get('/random', origin),
            ENV,
            stubFetch(),
        );

        expect(response.headers.get('access-control-allow-origin')).toBe(
            origin,
        );
    });

    it.each([
        ['a hostname merely containing localhost', 'http://localhost.evil.example'],
        ['https on localhost, which is not what vite serves', 'https://localhost:5173'],
        ['a public IP that is not in a private range', 'http://8.8.8.8:5173'],
        ['a hostname merely starting like a private range', 'http://192.168.1.1.evil.example'],
        ['an unrelated origin', 'https://evil.example'],
        ['a non-URL Origin header', 'null'],
    ])('omits the CORS header for %s', async (_label, origin) => {
        const response = await handleRequest(
            get('/random', origin),
            ENV,
            stubFetch(),
        );

        expect(response.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('varies on Origin even when the origin is not allowed', async () => {
        // The response that would poison a shared cache is this one — the one
        // with no allow-origin header — so it is the one that most needs the
        // marking.
        const response = await handleRequest(
            get('/random', 'https://evil.example'),
            ENV,
            stubFetch(),
        );

        expect(response.headers.get('vary')).toBe('Origin');
    });

    it('states its own content type rather than reflecting upstream', async () => {
        // Reflecting upstream's content-type is the one place an
        // upstream-controlled string reaches the browser from our origin —
        // enough to re-serve an Unsplash HTML error page as renderable HTML on
        // a workers.dev subdomain; nosniff doesn't stop a *wrong* declared type.
        const fetchFn = stubFetch(
            new Response('<html>Bad Gateway</html>', {
                status: 502,
                headers: { 'content-type': 'text/html; charset=utf-8' },
            }),
        );

        const response = await handleRequest(get('/random'), ENV, fetchFn);

        expect(response.headers.get('content-type')).toBe('application/json');
    });

    it('tells caches not to store a photo response', async () => {
        // /random must return different photos each time; Unsplash's own
        // directives don't survive the hop, so without this there's no cache
        // policy at all.
        const response = await handleRequest(
            get('/random', ALLOWED),
            ENV,
            stubFetch(),
        );

        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });

    it('answers a preflight without calling upstream', async () => {
        const fetchFn = stubFetch();
        const request = new Request('https://proxy.example/random', {
            method: 'OPTIONS',
            headers: { Origin: ALLOWED },
        });

        const response = await handleRequest(request, ENV, fetchFn);

        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-methods')).toBe(
            'GET, OPTIONS',
        );
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('rejects a non-GET method without calling upstream', async () => {
        const fetchFn = stubFetch();
        const request = new Request('https://proxy.example/random', {
            method: 'POST',
        });

        const response = await handleRequest(request, ENV, fetchFn);

        expect(response.status).toBe(405);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('does not call upstream when validation fails', async () => {
        // A rejected request must cost nothing against the Unsplash quota.
        const fetchFn = stubFetch();

        const response = await handleRequest(
            get('/download?url=https%3A%2F%2Fevil.example%2Fx'),
            ENV,
            fetchFn,
        );

        expect(response.status).toBe(400);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('reports an unreachable upstream as a readable 502', async () => {
        // Letting the exception escape hands the browser Cloudflare's HTML
        // error page — no CORS header, so an opaque TypeError, not a status.
        const fetchFn = vi
            .fn<typeof fetch>()
            .mockRejectedValue(new Error('connection reset'));

        const response = await handleRequest(
            get('/random', ALLOWED),
            ENV,
            fetchFn,
        );

        expect(response.status).toBe(502);
        expect(response.headers.get('access-control-allow-origin')).toBe(
            ALLOWED,
        );
    });

    it('does not report the upstream failure back to the caller', async () => {
        // The cause is dropped deliberately: a `String(error)` in the catch
        // would hand an anonymous caller what the runtime knows about our
        // network. This pins the fixed message against that mutation.
        const fetchFn = vi
            .fn<typeof fetch>()
            .mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.1:443'));

        const response = await handleRequest(get('/random'), ENV, fetchFn);

        expect(await response.text()).toBe(
            '{"error":"Upstream request failed"}',
        );
    });

    it('passes a null-body upstream status through without throwing', async () => {
        // `new Response('', { status: 204 })` throws — an empty string is still
        // a body. Flattening 204 to 502 breaks the pass-through-status #533
        // relies on.
        const fetchFn = stubFetch(new Response(null, { status: 204 }));

        const response = await handleRequest(get('/random'), ENV, fetchFn);

        expect(response.status).toBe(204);
    });

    // deploy.yml and deploy-preview.yml probe `GET {base}/download` with no
    // url, reading 400 as "live and keyed" and 500 as "secret unset". That
    // holds only while the config guard runs BEFORE routing — swap them and an
    // unkeyed Worker answers 400, so both deploys look healthy while every real
    // request 500s. Pinned on the exact request CI issues.
    it('answers the deploy probe with 500 when no key is set', async () => {
        const fetchFn = stubFetch();

        const response = await handleRequest(get('/download'), {}, fetchFn);

        expect(response.status).toBe(500);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('answers the deploy probe with 400 once configured', async () => {
        const fetchFn = stubFetch();

        const response = await handleRequest(get('/download'), ENV, fetchFn);

        expect(response.status).toBe(400);
        // Still free: a rejected probe must never cost Unsplash quota, which
        // is why this route was chosen over /random.
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('reports an unrouted path as 404 once configured', async () => {
        const response = await handleRequest(get('/nope'), ENV, stubFetch());

        expect(response.status).toBe(404);
    });

    it('names missing configuration rather than forwarding an unauthorized request', async () => {
        // `{}` is the real never-set shape (the secret is a separate deploy
        // step, so the binding is absent, not empty). An unauthorized upstream
        // call returns an opaque 401 that sends the operator the wrong way.
        const fetchFn = stubFetch();

        const response = await handleRequest(get('/random'), {}, fetchFn);

        expect(response.status).toBe(500);
        expect(fetchFn).not.toHaveBeenCalled();
    });
});
