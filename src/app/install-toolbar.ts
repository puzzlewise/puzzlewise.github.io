/**
 * DOM order matters: Tab follows append order, which must match the visual
 * order — the left-hand tools, then the right-hand column top to bottom.
 *
 * The settings modal's Solve button receives `solve` as a dependency instead of a
 * `window.__solvePuzzle` lookup at click time (the one sanctioned behavior
 * change in this refactor). `bootstrap` binds `dev-hooks.ts`'s `solvePuzzle`
 * once and passes it here and to `installDevHooks`, so the button and console
 * hook are the same function, not two call sites that agree.
 */

import type { GameState } from '../model/types.js';
import {
    createNewGameButton,
    createGatherPiecesButton,
    createSelectToolButton,
    createMarqueeToolButton,
    createDeselectButton,
    createHelpButton,
    createHelpModal,
    createSettingsButton,
    createSettingsModal,
} from '../ui/index.js';
import type { SelectionManager } from '../interaction/selection-manager.js';
import type { BackgroundColorControl } from './install-background-color.js';
import type { GameSession } from './game-session.js';

export interface InstallToolbarDeps {
    container: HTMLElement;
    /**
     * Read-only slice of {@link GameSession}: the toolbar reports on the
     * installed game and hands the settings modal a getter, but never installs one
     * — starting a game is `onNewGame`'s business.
     */
    session: Pick<GameSession, 'current'>;
    selectionManager: SelectionManager;
    fitView: (state: GameState, selectedGroupIds: ReadonlySet<number>) => void;
    /** Debounced progress save. */
    save: (state: GameState) => void;
    onNewGame: () => void;
    /**
     * Install the 🎨 background-color control into `toolbar` (bound by the
     * caller — this module owns *where and when* the picker's DOM lands, not
     * the picker). Invoked between Gather and Help, its on-screen position.
     *
     * Its handle is returned from {@link installToolbar} rather than captured
     * from the callback: the composition root needs it for the share path, and
     * a captured binding could only be typed with a definite-assignment
     * assertion where a return value is checked.
     */
    installBackgroundColorControl: (toolbar: HTMLElement) => BackgroundColorControl;
    /** Solve the puzzle — the same reference `installDevHooks` assigns to `window.__solvePuzzle` (see the module doc). */
    solve: () => void;
    onEffectsChanged: (preference: string) => void;
}

export function installToolbar(deps: InstallToolbarDeps): BackgroundColorControl {
    const {
        container,
        session,
        selectionManager,
        fitView,
        save,
        onNewGame,
        installBackgroundColorControl,
        solve,
        onEffectsChanged,
    } = deps;

    createSelectToolButton({ container, selectionManager });

    createMarqueeToolButton({ container, selectionManager });

    createDeselectButton({ container, selectionManager });

    const toolbar = document.createElement('div');
    toolbar.className = 'right-toolbar';
    container.appendChild(toolbar);

    createNewGameButton({
        container: toolbar,
        // Guarded reads: these run synchronously on click, so an unguarded
        // read threw and swallowed it whenever boot left no game behind (#488)
        // — making the New Game dialog, a player's one escape from an
        // input-rooted failure, unreachable. Zero counts read as "no progress
        // to lose", so the dialog opens without a confirm, correct with
        // nothing on screen.
        isCompleted: () => session.current()?.completed ?? false,
        getGroupCount: () => session.current()?.groups.length ?? 0,
        getPieceCount: () => session.current()?.pieces.length ?? 0,
        onNewGame,
    });

    createGatherPiecesButton({
        container: toolbar,
        onGatherPieces: () => {
            // Same synchronous session read as New Game above (#488). Nothing
            // to gather with no game, so a no-op is the correct behavior.
            const state = session.current();
            if (!state) return;
            fitView(state, selectionManager.selectedGroupIds);
            save(state);
        },
    });

    const backgroundColor = installBackgroundColorControl(toolbar);

    createHelpButton({
        container: toolbar,
        onShowHelp: () => {
            createHelpModal({ container, state: session.current() });
        },
    });

    createSettingsButton({
        container: toolbar,
        onShowSettings: () => {
            createSettingsModal({
                container,
                getState: () => session.current(),
                onSolve: solve,
                onEffectsChanged,
            });
        },
    });

    return backgroundColor;
}
