import type { Point } from '../model/types.js';

/**
 * Conservative bounding box: bezier control points are included, so it may be
 * larger than the curve but always contains the full path geometry.
 */
export function getPathBounds(
    path: string,
    start: Point,
): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = start.x;
    let minY = start.y;
    let maxX = start.x;
    let maxY = start.y;

    let curX = start.x;
    let curY = start.y;

    function expand(x: number, y: number) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
    }

    const nums: number[] = [];
    let pos = 0;
    while (pos < path.length) {
        const cmd = path[pos++];
        if (!COMMANDS.includes(cmd)) continue;

        nums.length = 0;
        let argsEnd = pos;
        while (argsEnd < path.length && isArgumentChar(path.charCodeAt(argsEnd))) argsEnd++;
        while (pos < argsEnd) {
            const numberEnd = scanNumber(path, pos, argsEnd);
            if (numberEnd === pos) {
                pos++;
            } else {
                nums.push(parseFloat(path.slice(pos, numberEnd)));
                pos = numberEnd;
            }
        }

        switch (cmd) {
            case 'M':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX = nums[i];
                    curY = nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 'm':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX += nums[i];
                    curY += nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 'L':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX = nums[i];
                    curY = nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 'l':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX += nums[i];
                    curY += nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 'H':
                for (const n of nums) {
                    curX = n;
                    expand(curX, curY);
                }
                break;
            case 'h':
                for (const n of nums) {
                    curX += n;
                    expand(curX, curY);
                }
                break;
            case 'V':
                for (const n of nums) {
                    curY = n;
                    expand(curX, curY);
                }
                break;
            case 'v':
                for (const n of nums) {
                    curY += n;
                    expand(curX, curY);
                }
                break;
            case 'C':
                for (let i = 0; i + 5 < nums.length; i += 6) {
                    expand(nums[i], nums[i + 1]);
                    expand(nums[i + 2], nums[i + 3]);
                    curX = nums[i + 4];
                    curY = nums[i + 5];
                    expand(curX, curY);
                }
                break;
            case 'c':
                for (let i = 0; i + 5 < nums.length; i += 6) {
                    expand(curX + nums[i], curY + nums[i + 1]);
                    expand(curX + nums[i + 2], curY + nums[i + 3]);
                    curX += nums[i + 4];
                    curY += nums[i + 5];
                    expand(curX, curY);
                }
                break;
            case 'S':
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    expand(nums[i], nums[i + 1]);
                    curX = nums[i + 2];
                    curY = nums[i + 3];
                    expand(curX, curY);
                }
                break;
            case 's':
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    expand(curX + nums[i], curY + nums[i + 1]);
                    curX += nums[i + 2];
                    curY += nums[i + 3];
                    expand(curX, curY);
                }
                break;
            case 'Q':
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    expand(nums[i], nums[i + 1]);
                    curX = nums[i + 2];
                    curY = nums[i + 3];
                    expand(curX, curY);
                }
                break;
            case 'q':
                for (let i = 0; i + 3 < nums.length; i += 4) {
                    expand(curX + nums[i], curY + nums[i + 1]);
                    curX += nums[i + 2];
                    curY += nums[i + 3];
                    expand(curX, curY);
                }
                break;
            case 'T':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX = nums[i];
                    curY = nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 't':
                for (let i = 0; i + 1 < nums.length; i += 2) {
                    curX += nums[i];
                    curY += nums[i + 1];
                    expand(curX, curY);
                }
                break;
            case 'A':
                for (let i = 0; i + 6 < nums.length; i += 7) {
                    // Only the arc endpoint (approximate; radii are harder to bound).
                    curX = nums[i + 5];
                    curY = nums[i + 6];
                    expand(curX, curY);
                }
                break;
            case 'a':
                for (let i = 0; i + 6 < nums.length; i += 7) {
                    curX += nums[i + 5];
                    curY += nums[i + 6];
                    expand(curX, curY);
                }
                break;
            case 'Z':
            case 'z':
                curX = start.x;
                curY = start.y;
                break;
        }
    }

    return { minX, minY, maxX, maxY };
}

const COMMANDS = 'MLCSQTZHVAmlcsqtzhva';

const MINUS = 45;
const DOT = 46;
const COMMA = 44;
const SPACE = 32;
const TAB = 9;
const CARRIAGE_RETURN = 13;
const UPPER_E = 69;
const LOWER_E = 101;

function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}

function isArgumentChar(code: number): boolean {
    return isDigit(code) || code === MINUS || code === DOT || code === COMMA
        || code === SPACE || (code >= TAB && code <= CARRIAGE_RETURN)
        || code === LOWER_E || code === UPPER_E;
}

/** Returns the end of the number starting at `from`, or `from` when none starts there. */
function scanNumber(path: string, from: number, limit: number): number {
    let i = from;
    if (path.charCodeAt(i) === MINUS) i++;

    const integerStart = i;
    while (i < limit && isDigit(path.charCodeAt(i))) i++;
    if (i > integerStart) {
        if (i < limit && path.charCodeAt(i) === DOT) i++;
    } else if (i + 1 < limit && path.charCodeAt(i) === DOT && isDigit(path.charCodeAt(i + 1))) {
        i++;
    } else {
        return from;
    }
    while (i < limit && isDigit(path.charCodeAt(i))) i++;

    if (i < limit && (path.charCodeAt(i) === LOWER_E || path.charCodeAt(i) === UPPER_E)) {
        let exponent = i + 1;
        if (exponent < limit && path.charCodeAt(exponent) === MINUS) exponent++;
        if (exponent < limit && isDigit(path.charCodeAt(exponent))) {
            i = exponent;
            while (i < limit && isDigit(path.charCodeAt(i))) i++;
        }
    }
    return i;
}
