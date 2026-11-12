import type { Point, Size } from '../../model/types.js';

/**
 * UV of a piece-local point `p` is `((p - imageOffset) / imageSize) * scale + offset`,
 * matching an SVG `<image preserveAspectRatio="xMidYMid slice">` of `imageSize`
 * placed at `imageOffset` and showing a photo of `photoSize`.
 */
export function sliceUv(imageSize: Size, photoSize: Size): { scale: Point; offset: Point } {
    const cover = Math.max(imageSize.width / photoSize.width, imageSize.height / photoSize.height);
    const scale = {
        x: imageSize.width / (photoSize.width * cover),
        y: imageSize.height / (photoSize.height * cover),
    };
    return { scale, offset: { x: (1 - scale.x) / 2, y: (1 - scale.y) / 2 } };
}

export function textureSizeFor(photoSize: Size, maxTextureSize: number): Size {
    const { width, height } = photoSize;
    if (Math.max(width, height) <= maxTextureSize) return { width, height };
    // Pin the long side to the limit exactly; flooring width * factor can land 1 px short.
    if (width >= height) {
        return { width: maxTextureSize, height: Math.max(1, Math.floor((height * maxTextureSize) / width)) };
    }
    return { width: Math.max(1, Math.floor((width * maxTextureSize) / height)), height: maxTextureSize };
}
