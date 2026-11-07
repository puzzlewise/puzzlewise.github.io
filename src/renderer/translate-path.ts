import { fmt } from '../model/build-shape.js';

export class PathDataError extends Error {
    override name = 'PathDataError';
}

const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const SEPARATOR = /[\s,]*/y;

function isTranslatedX(command: string, argIndex: number): boolean {
    if (command === 'H') return true;
    if (command === 'V') return false;
    if (command === 'A') return argIndex === 5;
    return argIndex % 2 === 0;
}

function isTranslatedY(command: string, argIndex: number): boolean {
    if (command === 'H') return false;
    if (command === 'V') return true;
    if (command === 'A') return argIndex === 6;
    return argIndex % 2 === 1;
}

export function translatePath(d: string, dx: number, dy: number): string {
    const out: string[] = [];
    let pos = 0;
    let letter = '';
    let command = '';
    let absolute = false;
    let argIndex = 0;
    let first = true;

    const skipSeparators = (): void => {
        SEPARATOR.lastIndex = pos;
        SEPARATOR.exec(d);
        pos = SEPARATOR.lastIndex;
    };

    for (skipSeparators(); pos < d.length; skipSeparators()) {
        const ch = d[pos];
        if (/[a-zA-Z]/.test(ch)) {
            const upper = ch.toUpperCase();
            if (!(upper in ARITY)) throw new PathDataError(`Unsupported path command "${ch}"`);
            letter = ch;
            command = upper;
            absolute = ch === upper || (first && upper === 'M');
            argIndex = 0;
            first = false;
            out.push(ch);
            pos++;
            continue;
        }
        const arity = ARITY[command];
        if (!arity) throw new PathDataError(`Unexpected path data at ${pos}`);
        const index = argIndex % arity;
        if (command === 'A' && (index === 3 || index === 4)) {
            if (ch !== '0' && ch !== '1') throw new PathDataError(`Unexpected path data at ${pos}`);
            out.push(ch);
            pos++;
        } else {
            NUMBER.lastIndex = pos;
            const match = NUMBER.exec(d);
            let value = Number(match?.[0]);
            if (!Number.isFinite(value)) throw new PathDataError(`Unexpected path data at ${pos}`);
            pos = NUMBER.lastIndex;
            if (absolute && isTranslatedX(command, index)) value += dx;
            else if (absolute && isTranslatedY(command, index)) value += dy;
            out.push(fmt(value));
        }
        argIndex++;
        if (command === 'M' && argIndex === 2) {
            command = 'L';
            absolute = letter === 'M';
            argIndex = 0;
        }
    }
    return out.join(' ');
}
