import { createNewGameIcon } from './tool-icons.js';

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

    const button = document.createElement('button');
    button.className = 'new-game-button';
    button.type = 'button';
    button.title = 'New Game';
    button.setAttribute('aria-label', 'New Game');
    button.appendChild(createNewGameIcon());

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

    button.addEventListener('click', handleClick);
    container.appendChild(button);

    return () => {
        button.removeEventListener('click', handleClick);
        button.remove();
    };
}
