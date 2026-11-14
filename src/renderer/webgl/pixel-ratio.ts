/**
 * Moving the window to a display with another pixel ratio changes no CSS size,
 * so a ResizeObserver misses it. Each query matches one ratio only, so it is
 * re-armed for the new ratio after every change.
 */
export function watchDevicePixelRatio(onChange: () => void): () => void {
    let stop = (): void => {};
    const arm = (): void => {
        const query = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        const listener = (): void => {
            query.removeEventListener('change', listener);
            onChange();
            arm();
        };
        query.addEventListener('change', listener);
        stop = () => query.removeEventListener('change', listener);
    };
    arm();
    return () => stop();
}
