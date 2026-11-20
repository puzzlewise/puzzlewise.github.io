import { createNewGameIcon } from './tool-icons.js';
import { createToolbarButton } from './toolbar-button.js';

export function shouldConfirmNewGame(
    completed: boolean,
    groupCount: number,
    pieceCount: number,
): boolean {
    if (completed) {
        return false;
    }

    return groupCount < pieceCount;
}

export interface NewGameButtonOptions {
    container: HTMLElement;
    isCompleted: () => boolean;
    getGroupCount: () => number;
    getPieceCount: () => number;
    onNewGame: () => void;
    /** Injectable for tests; defaults to window.confirm. */
    confirm?: (message: string) => boolean;
}

export function createNewGameButton(options: NewGameButtonOptions): () => void {
    const {
        container,
        isCompleted,
        getGroupCount,
        getPieceCount,
        onNewGame,
        confirm: confirmFn = (msg: string) => window.confirm(msg),
    } = options;

    function handleClick(): void {
        const needsConfirm = shouldConfirmNewGame(
            isCompleted(),
            getGroupCount(),
            getPieceCount(),
        );

        if (needsConfirm) {
            const confirmed = confirmFn(
                'Start a new game? Your current progress will be lost.',
            );

            if (!confirmed) {
                return;
            }
        }

        onNewGame();
    }

    return createToolbarButton({
        container,
        className: 'new-game-button',
        label: 'New Game',
        icon: createNewGameIcon(),
        onClick: handleClick,
    });
}
