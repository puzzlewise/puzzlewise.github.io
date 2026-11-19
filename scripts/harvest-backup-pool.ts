/**
 * Offline harvest for src/images/backup-pool.json — the insurance images served
 * when Unsplash rate-limits the app (spec:
 * docs/superpowers/specs/2026-08-17-backup-image-pool-design.md). Metadata only;
 * the pixels stay hotlinked from the CDN. Goes through the image-proxy Worker,
 * so no Unsplash key is needed here — the Worker holds the current prod key.
 *
 * The photo->record mapping is reimplemented rather than imported from
 * src/images/unsplash.ts: that module's graph pulls src/diagnostics.ts, whose
 * module-scope `import.meta.env.DEV` throws under tsx.
 *
 * Run: npx tsx scripts/harvest-backup-pool.ts
 * Needs: VITE_IMAGE_PROXY_URL (env, or read from .env.local).
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { IMAGE_CATEGORY_OPTIONS, buildImageQuery } from '../src/game/image-categories.js';
import { isBlockedPhotographerUrl } from '../src/images/blocked-photographers.js';
import { withAutoFormat } from '../src/images/unsplash-auto-format.js';

const PER_BUCKET = 12;
const ORIENTATIONS = ['landscape', 'portrait'] as const;
const OUTPUT = new URL('../src/images/backup-pool.json', import.meta.url);
const UTM = '?utm_source=puzzle&utm_medium=referral';
// Courtesy pause between requests so a full 36-bucket harvest doesn't spike quota.
const REQUEST_DELAY_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function readProxyUrl(): string {
    const fromEnv = process.env.VITE_IMAGE_PROXY_URL?.trim();
    const fromFile = fromEnv && fromEnv.length > 0
        ? fromEnv
        : (readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
            .match(/^VITE_IMAGE_PROXY_URL=(.*)$/m)?.[1] ?? '');
    const url = fromFile.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
    if (!url) throw new Error('VITE_IMAGE_PROXY_URL not set (env or .env.local)');
    return url;
}

function toRecord(item: any, category: string, vibrant: boolean, orientation: string) {
    const description = item.alt_description;
    return {
        id: String(item.id),
        category,
        vibrant,
        orientation,
        imageUrl: withAutoFormat(String(item.urls.regular)),
        width: Number(item.width),
        height: Number(item.height),
        photographerName: String(item.user.name),
        photographerUrl: `${item.user.links.html}${UTM}`,
        photoUrl: `${item.links.html}${UTM}`,
        thumbUrl: withAutoFormat(String(item.urls.small)),
        downloadLocation: String(item.links.download_location),
        ...(typeof description === 'string' && description.length > 0
            ? { description }
            : {}),
    };
}

async function fetchBucket(proxy: string, query: string, orientation: string): Promise<any[]> {
    const url = `${proxy}/random?query=${encodeURIComponent(query)}`
        + `&orientation=${orientation}&count=${PER_BUCKET}`;
    const res = await fetch(url);
    if (!res.ok) {
        console.warn(`  ! ${res.status} ${res.statusText} for "${query}" / ${orientation}`);
        return [];
    }
    const body = await res.json();
    return Array.isArray(body) ? body : [body];
}

async function main(): Promise<void> {
    const proxy = readProxyUrl();
    const categories = IMAGE_CATEGORY_OPTIONS.filter((c) => c.id !== 'any');
    const seen = new Set<string>();
    const records: ReturnType<typeof toRecord>[] = [];

    for (const category of categories) {
        for (const vibrant of [false, true]) {
            for (const orientation of ORIENTATIONS) {
                const query = buildImageQuery(category.query, vibrant);
                if (!query) continue; // non-'any' categories always have a query
                const raw = await fetchBucket(proxy, query, orientation);
                let kept = 0;
                for (const item of raw) {
                    try {
                        const id = String(item.id);
                        if (seen.has(id)) continue;
                        if (isBlockedPhotographerUrl(String(item.user.links.html))) continue;
                        const record = toRecord(item, category.id, vibrant, orientation);
                        seen.add(id);
                        records.push(record);
                        kept++;
                    } catch {
                        // Skip a malformed photo rather than abort the whole run.
                    }
                }
                console.log(`  ${category.id} vibrant=${vibrant} ${orientation}: ${kept}`);
                await sleep(REQUEST_DELAY_MS);
            }
        }
    }

    records.sort((a, b) =>
        a.category.localeCompare(b.category)
        || Number(a.vibrant) - Number(b.vibrant)
        || a.orientation.localeCompare(b.orientation)
        || a.id.localeCompare(b.id));

    writeFileSync(OUTPUT, `${JSON.stringify(records, null, 2)}\n`);
    console.log(`\nWrote ${records.length} records to ${OUTPUT.pathname}`);
}

await main();
