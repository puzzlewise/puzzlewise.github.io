export type { Renderer } from './types.js';
export { VIEWPORT_TRANSITION_MS, SETTLE_GRACE_MS } from './types.js';
export type { RendererAppearance, Rgba } from './appearance.js';
export {
    WebGlRenderer,
    type FillsOmitted,
    type HalosUnavailableKind,
    type IdleScheduler,
    type WebGlRendererOptions,
} from './webgl/webgl-renderer.js';
export type { ContextEvent } from './webgl/context-loss.js';
export { ShaderBuildError, WebGLUnsupportedError } from './webgl/gl-context.js';
