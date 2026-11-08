/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SelectionManager } from '../interaction/selection-manager.js';
import type { GameState } from '../model/types.js';
import type { BackgroundColorControl } from './install-background-color.js';
import type { GameSession } from './game-session.js';
import { installToolbar, type InstallToolbarDeps } from './install-toolbar.js';

function makeBackgroundColor(): BackgroundColorControl {
    return { adopt: vi.fn(() => 'adopted' as const) };
}

/** Only `current`: the narrowed dependency spares a fake from `hasGame`'s stricter meaning. */
function makeSession(state?: GameState): Pick<GameSession, 'current'> {
    return { current: () => state };
}

describe('installToolbar', () => {
    let container: HTMLElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.replaceChildren(container);
    });

    afterEach(() => {
        // A test below spies on `window.confirm`; restore it so later tests
        // (any shuffle order) don't inherit it.
        vi.restoreAllMocks();
    });

    function deps(overrides: Partial<InstallToolbarDeps> = {}): InstallToolbarDeps {
        return {
            container,
            session: makeSession(),
            selectionManager: new SelectionManager(),
            fitView: vi.fn(),
            save: vi.fn(),
            onNewGame: vi.fn(),
            installBackgroundColorControl: vi.fn(makeBackgroundColor),
            solve: vi.fn(),
            onEffectsChanged: vi.fn(),
            onOutlineChanged: vi.fn(),
            ...overrides,
        };
    }

    it('creates all seven toolbar entries in the container', () => {
        installToolbar(deps());
        const selectors = [
            '.new-game-button',
            '.gather-pieces-button',
            '.select-tool-button',
            '.marquee-tool-button',
            '.deselect-button',
            '.help-button',
            '.settings-button',
        ];
        for (const selector of selectors) {
            expect(container.querySelector(selector), selector).not.toBeNull();
        }
    });

    it('stacks the right-hand controls in one toolbar, after the left-hand tools in DOM order', () => {
        // Tab order follows DOM order, so it must match the visual order:
        // the left-hand tools, then the right-hand column top to bottom.
        const installBackgroundColorControl = vi.fn((toolbar: HTMLElement) => {
            const marker = document.createElement('div');
            marker.className = 'background-color-marker';
            toolbar.appendChild(marker);
            return makeBackgroundColor();
        });
        installToolbar(deps({ installBackgroundColorControl }));

        const classNames = (el: Element): string[] => [...el.children].map((child) => child.className);
        expect(classNames(container)).toEqual([
            'select-tool-button',
            'marquee-tool-button',
            'deselect-button',
            'right-toolbar',
        ]);
        expect(classNames(container.querySelector('.right-toolbar')!)).toEqual([
            'new-game-button',
            'gather-pieces-button',
            'background-color-marker',
            'help-button',
            'settings-button',
        ]);
    });

    it('hands back the background-color handle it installed', () => {
        // The root needs the handle for the share path but wants the picker's
        // DOM here, between Gather and Help. Returning it lets the root use a
        // plain `const` — a callback-assigned binding would need a
        // definite-assignment assertion and be silently `undefined` if this
        // call stopped invoking the dependency.
        const control = makeBackgroundColor();
        const returned = installToolbar(
            deps({ installBackgroundColorControl: vi.fn(() => control) }),
        );

        expect(returned).toBe(control);
    });

    it('reads zero counts and not-completed when there is no game', () => {
        // Unguarded reads threw and swallowed the click in the terminal state
        // boot can leave behind (#488) — making the one dialog that can escape
        // the failure unreachable. With no game, `shouldConfirmNewGame(false,
        // 0, 0)` is false, so the click reaches `onNewGame` with no confirm.
        const confirmSpy = vi.spyOn(window, 'confirm');
        const onNewGame = vi.fn();
        installToolbar(deps({ session: makeSession(undefined), onNewGame }));

        container.querySelector<HTMLButtonElement>('.new-game-button')!.click();

        expect(confirmSpy).not.toHaveBeenCalled();
        expect(onNewGame).toHaveBeenCalledTimes(1);
    });

    it('does nothing when Gather is tapped with no game', () => {
        // Like the New Game read above, this session read threw when boot left
        // no game. Nothing to gather in that state, so a no-op is correct.
        const fitView = vi.fn();
        const save = vi.fn();
        installToolbar(deps({ session: makeSession(undefined), fitView, save }));

        container.querySelector<HTMLButtonElement>('.gather-pieces-button')!.click();

        expect(fitView).not.toHaveBeenCalled();
        expect(save).not.toHaveBeenCalled();
    });

    it('gathers and saves when Gather is tapped with a game installed', () => {
        // Positive counterpart to the no-op case: the guard isn't swallowing
        // every click.
        const fitView = vi.fn();
        const save = vi.fn();
        const state = { pieces: [], groups: [] } as unknown as GameState;
        installToolbar(deps({ session: makeSession(state), fitView, save }));

        container.querySelector<HTMLButtonElement>('.gather-pieces-button')!.click();

        expect(fitView).toHaveBeenCalledWith(state, new Set());
        expect(save).toHaveBeenCalledWith(state);
    });

    it('gathers around the current selection and keeps it', () => {
        const fitView = vi.fn();
        const selectionManager = new SelectionManager();
        selectionManager.toolActive = true;
        selectionManager.selectMany([2, 5]);
        const state = { pieces: [], groups: [] } as unknown as GameState;
        installToolbar(deps({ session: makeSession(state), selectionManager, fitView }));

        container.querySelector<HTMLButtonElement>('.gather-pieces-button')!.click();

        expect(fitView).toHaveBeenCalledWith(state, new Set([2, 5]));
        expect(selectionManager.selectedGroupIds).toEqual(new Set([2, 5]));
    });

    it('opens the help modal from the help button', () => {
        installToolbar(deps());

        container.querySelector<HTMLButtonElement>('.help-button')!.click();

        expect(container.querySelector('.info-modal-title')!.textContent).toBe('Help');
    });

    it('wires onEffectsChanged into the settings modal Effects setting', () => {
        const onEffectsChanged = vi.fn();
        installToolbar(deps({ onEffectsChanged }));

        container.querySelector<HTMLButtonElement>('.settings-button')!.click();
        container.querySelector<HTMLButtonElement>('[data-testid="effects-simple"]')!.click();

        expect(onEffectsChanged).toHaveBeenCalledExactlyOnceWith('simple');
    });

    it('wires onOutlineChanged into the settings modal Piece outline setting', () => {
        const onOutlineChanged = vi.fn();
        installToolbar(deps({ onOutlineChanged }));

        container.querySelector<HTMLButtonElement>('.settings-button')!.click();
        container.querySelector<HTMLButtonElement>('[data-testid="piece-outline-shadow"]')!.click();

        expect(onOutlineChanged).toHaveBeenCalledOnce();
    });

    it('wires solve into the settings modal Solve button rather than a window lookup', () => {
        const solve = vi.fn();
        installToolbar(deps({ solve }));

        container.querySelector<HTMLButtonElement>('.settings-button')!.click();
        const solveBtn = container.querySelector<HTMLButtonElement>('.info-modal-solve-btn');
        expect(solveBtn).not.toBeNull();
        solveBtn!.click();

        expect(solve).toHaveBeenCalledTimes(1);
    });
});
