import { isOnPuzzleTable } from '../renderer/puzzle-table.js';
import { track, whenAnalyticsReady, type FirstInteractionData } from './umami.js';

type ListenerTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

const EVENT_TYPES = ['pointerdown', 'keydown'] as const;
const LISTENER_OPTIONS = { capture: true, passive: true };

function inputOf(e: Event): FirstInteractionData['input'] {
    if (e.type === 'keydown') return 'key';
    switch ((e as PointerEvent).pointerType) {
        case 'mouse': return 'mouse';
        case 'touch': return 'touch';
        case 'pen': return 'pen';
        default: return 'unknown';
    }
}

export function installFirstInteractionTracking(
    source: ListenerTarget = window,
    now: () => number = () => performance.now(),
): void {
    const onInteraction = (e: Event): void => {
        if (!e.isTrusted) return;
        for (const type of EVENT_TYPES) {
            source.removeEventListener(type, onInteraction, LISTENER_OPTIONS);
        }
        const data: FirstInteractionData = {
            input: inputOf(e),
            target: isOnPuzzleTable(e.target) ? 'table' : 'ui',
            msSinceLoad: Math.round(now()),
        };
        whenAnalyticsReady(() => track('first-interaction', data));
    };
    for (const type of EVENT_TYPES) {
        source.addEventListener(type, onInteraction, LISTENER_OPTIONS);
    }
}
