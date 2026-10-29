export const RECEIVE_MOVE_PARAM = 'receive-move';

const DEFAULT_SOURCE_ORIGIN = 'https://adrianschmidt.github.io';

export function moveSourceOrigin(): string {
    const raw = import.meta.env.VITE_MOVED_FROM as string | undefined;
    return new URL(raw || DEFAULT_SOURCE_ORIGIN).origin;
}
