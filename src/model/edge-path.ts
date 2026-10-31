import { fmt } from './build-shape.js';
import { quantize } from './quantize-geometry.js';
import type { Point } from './types.js';

export type PathSegment =
    | { cmd: 'L'; to: Point }
    | { cmd: 'C'; c1: Point; c2: Point; to: Point }
    | { cmd: 'A'; rx: number; ry: number; rotation: number; largeArc: 0 | 1; sweep: 0 | 1; to: Point };

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

const ARITY = { L: 2, C: 6, A: 7 } as const;

function isCommand(token: string): token is keyof typeof ARITY {
    return token === 'L' || token === 'C' || token === 'A';
}

function isFlag(n: number): n is 0 | 1 {
    return n === 0 || n === 1;
}

export function parseEdgePath(path: string): PathSegment[] | null {
    const tokens = path.split(/[\s,]+/).filter((t) => t !== '');
    const segments: PathSegment[] = [];
    let i = 0;
    while (i < tokens.length) {
        const cmd = tokens[i++];
        if (!isCommand(cmd)) return null;
        const arity = ARITY[cmd];
        if (i + arity > tokens.length) return null;
        const args: number[] = [];
        for (const token of tokens.slice(i, i + arity)) {
            if (!NUMBER.test(token)) return null;
            args.push(Number(token));
        }
        i += arity;

        if (cmd === 'L') {
            segments.push({ cmd, to: { x: args[0], y: args[1] } });
        } else if (cmd === 'C') {
            segments.push({
                cmd,
                c1: { x: args[0], y: args[1] },
                c2: { x: args[2], y: args[3] },
                to: { x: args[4], y: args[5] },
            });
        } else {
            const [rx, ry, rotation, largeArc, sweep, x, y] = args;
            if (!isFlag(largeArc) || !isFlag(sweep)) return null;
            segments.push({ cmd, rx, ry, rotation, largeArc, sweep, to: { x, y } });
        }
    }
    return segments.length > 0 ? segments : null;
}

function num(n: number): string {
    return fmt(quantize(n));
}

function pt(p: Point): string {
    return `${num(p.x)} ${num(p.y)}`;
}

export function formatEdgePath(segments: PathSegment[]): string {
    return segments
        .map((s) => {
            switch (s.cmd) {
                case 'L':
                    return `L ${pt(s.to)}`;
                case 'C':
                    return `C ${pt(s.c1)}, ${pt(s.c2)}, ${pt(s.to)}`;
                case 'A':
                    return `A ${num(s.rx)} ${num(s.ry)} ${num(s.rotation)} ${s.largeArc},${s.sweep} ${pt(s.to)}`;
            }
        })
        .join(' ');
}

/**
 * Output is persisted by the v14 save format (the mate's path is rebuilt on
 * load), so it must stay deterministic: every coordinate goes through
 * `quantize` after translation, absorbing float noise in the offset sums.
 *
 * `start` is the canonical edge's start; `fromOffset`/`toOffset` are the
 * canonical and mate pieces' `imageOffset`s.
 */
export function deriveMatePath(path: string, start: Point, fromOffset: Point, toOffset: Point): string | null {
    const segments = parseEdgePath(path);
    if (!segments) return null;

    const map = (p: Point): Point => ({
        x: quantize(p.x - fromOffset.x + toOffset.x),
        y: quantize(p.y - fromOffset.y + toOffset.y),
    });

    const points = [start, ...segments.map((s) => s.to)].map(map);
    const reversed: PathSegment[] = [];
    for (let i = segments.length; i >= 1; i--) {
        const s = segments[i - 1];
        const to = points[i - 1];
        switch (s.cmd) {
            case 'L':
                reversed.push({ cmd: 'L', to });
                break;
            case 'C':
                reversed.push({ cmd: 'C', c1: map(s.c2), c2: map(s.c1), to });
                break;
            case 'A':
                reversed.push({ ...s, sweep: s.sweep === 1 ? 0 : 1, to });
                break;
        }
    }
    return formatEdgePath(reversed);
}
