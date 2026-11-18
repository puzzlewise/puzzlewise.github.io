import { type SharePayload, shareCfToComposableConfig } from '../sharing/index.js';
import type { InitOptions } from '../game/init.js';

export function shareInitOptions(payload: SharePayload): InitOptions {
    return {
        cutStyle: payload.c,
        seed: payload.s,
        rotationMode: payload.r,
        fractalConfig: payload.ff ? { borderless: payload.ff.bl } : undefined,
        wavyConfig: payload.wf
            ? { borderless: payload.wf.bl, traceSetVersion: payload.wf.tv }
            : undefined,
        trianglesConfig: payload.tf
            ? { traceSetVersion: payload.tf.tv }
            : undefined,
        classicConfig: payload.clf
            ? { traceSetVersion: payload.clf.tv }
            : undefined,
        composableConfig: payload.cf
            ? shareCfToComposableConfig(payload.cf)
            : undefined,
    };
}
