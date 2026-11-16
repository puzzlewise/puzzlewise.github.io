import { expect, test } from 'vitest';
import { describeFillMargins, OWN_FILE_CASES, SHARED_FILE_CASES } from '../test-helpers/generated-fill-cases.js';

const sources = import.meta.glob<string>('./generated-fills.*.test.ts', { query: '?raw', import: 'default', eager: true });

describeFillMargins(SHARED_FILE_CASES);

test('every case with a file of its own is run by that file', () => {
    for (const [name, file] of Object.entries(OWN_FILE_CASES)) {
        expect(sources[`./${file}`], file).toContain(`describeFillMargins(['${name}'])`);
    }
});
