/**
 * Test-only: shared by the proxy's tests and the client's photo-id agreement
 * test, so a sample added for a new Unsplash format reaches both checks. Must
 * import nothing (the Worker island tests pin that).
 */

export const DOWNLOAD_LOCATION =
    'https://api.unsplash.com/photos/mEZ3PoFGs_k/download?ixid=abc123';

export const VALID_DOWNLOAD_LOCATIONS: readonly string[] = [
    DOWNLOAD_LOCATION,
    'https://api.unsplash.com/photos/_p-nqrlCcyE/download',
];

export const HOSTILE_DOWNLOAD_LOCATIONS: ReadonlyArray<readonly [label: string, url: string]> = [
    ['hostname ending in unsplash.com', 'https://evil-unsplash.com/photos/x/download'],
    ['different unsplash.com subdomain', 'https://cdn.unsplash.com/photos/x/download'],
    ['userinfo before the host', 'https://api.unsplash.com@evil.example/photos/x/download'],
    ['userinfo on the real host', 'https://user:pass@api.unsplash.com/photos/x/download'],
    ['hostname suffix', 'https://api.unsplash.com.evil.example/photos/x/download'],
    ['different TLD', 'https://api.unsplash.com.co/photos/x/download'],
    ['scheme downgrade', 'http://api.unsplash.com/photos/x/download'],
    ['encoded traversal', 'https://api.unsplash.com/photos/x%2f..%2f..%2fusers%2fme/download'],
    ['not a download location', 'https://api.unsplash.com/photos/abc123'],
    ['extra path segment', 'https://api.unsplash.com/photos/abc/download/extra'],
];
