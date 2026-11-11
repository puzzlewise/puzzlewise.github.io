/** Components 0–1, straight (non-premultiplied) alpha. */
export type Rgba = readonly [number, number, number, number];

export interface RendererAppearance {
    outline: 'outline' | 'shadow' | 'none';
    outlineColor: Rgba;
    constantWidth: boolean;
    innerOutline: boolean;
    selectionGlowColor: Rgba;
    backgroundColor: Rgba;
    pieceOpacity: number;
    debugPieces: boolean;
    matelessEdges: boolean;
}
