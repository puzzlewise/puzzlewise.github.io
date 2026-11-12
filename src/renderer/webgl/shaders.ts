import { TRANSFORM_COS, TRANSFORM_SIN, TRANSFORM_STRIDE, TRANSFORM_TX, TRANSFORM_TY } from './scene.js';

export const KIND_FILL = 0;
export const KIND_STROKE = 1;
export const KIND_HALO = 2;
export const KIND_FRINGE = 3;

export interface VertexAttribute {
    readonly name: string;
    readonly location: number;
    readonly size: number;
    /** In floats from the start of an interleaved vertex of `MAIN_VERTEX_FLOATS` floats. */
    readonly offset: number;
}

export const MAIN_ATTRIBUTES = {
    position: { name: 'a_position', location: 0, size: 2, offset: 0 },
    normal: { name: 'a_normal', location: 1, size: 2, offset: 2 },
    side: { name: 'a_side', location: 2, size: 1, offset: 4 },
    imagePosition: { name: 'a_imagePosition', location: 3, size: 2, offset: 5 },
    slot: { name: 'a_slot', location: 4, size: 1, offset: 7 },
    kind: { name: 'a_kind', location: 5, size: 1, offset: 8 },
} as const satisfies Record<string, VertexAttribute>;

export const MAIN_VERTEX_FLOATS = 9;

export const MAIN_UNIFORMS = {
    transforms: 'u_transforms',
    photo: 'u_photo',
    scale: 'u_scale',
    offset: 'u_offset',
    viewportSize: 'u_viewportSize',
    pixelRatio: 'u_pixelRatio',
    imageSize: 'u_imageSize',
    uvScale: 'u_uvScale',
    uvOffset: 'u_uvOffset',
    blank: 'u_blank',
    pieceOpacity: 'u_pieceOpacity',
    outlineColor: 'u_outlineColor',
    halfWidth: 'u_halfWidth',
    constantWidth: 'u_constantWidth',
    innerOnly: 'u_innerOnly',
} as const;

export const TRANSFORM_TEXTURE_UNIT = 0;
export const PHOTO_TEXTURE_UNIT = 1;

// RGBA32F isn't filterable in core WebGL2: the texture needs NEAREST filters and no
// mipmaps, or it is incomplete and texelFetch reads zeros.
export const TRANSFORM_TEXTURE_WIDTH = 1024;
export const TRANSFORM_TEXELS_PER_SLOT = TRANSFORM_STRIDE / 4;

const component = (offset: number) => 'xyzw'[offset];
const a = MAIN_ATTRIBUTES;
const u = MAIN_UNIFORMS;

// No `flat` varyings: Safari 17's ANGLE Metal reads past the index buffer for them (WebKit 9b79ea8747, bug 289524).
export const MAIN_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${a.position.location}) in vec2 ${a.position.name};
layout(location = ${a.normal.location}) in vec2 ${a.normal.name};
layout(location = ${a.side.location}) in float ${a.side.name};
layout(location = ${a.imagePosition.location}) in vec2 ${a.imagePosition.name};
layout(location = ${a.slot.location}) in float ${a.slot.name};
layout(location = ${a.kind.location}) in float ${a.kind.name};

uniform highp sampler2D ${u.transforms};
uniform float ${u.scale};
uniform vec2 ${u.offset};
uniform vec2 ${u.viewportSize};
uniform float ${u.pixelRatio};
uniform float ${u.halfWidth};
uniform bool ${u.constantWidth};

out vec2 v_imagePosition;
out float v_distance;
out float v_kind;

void main() {
    int kind = int(${a.kind.name} + 0.5);
    float worldPerPixel = 1.0 / (${u.scale} * ${u.pixelRatio});
    float extent = 0.0;
    if (kind == ${KIND_STROKE}) {
        float halfWidth = ${u.constantWidth} ? ${u.halfWidth} / ${u.scale} : ${u.halfWidth};
        extent = halfWidth + 0.5 * worldPerPixel;
    } else if (kind == ${KIND_FRINGE}) {
        extent = worldPerPixel;
    }
    vec2 offset = ${a.normal.name} * (${a.side.name} * extent);
    vec2 local = ${a.position.name} + offset;

    int texel = int(${a.slot.name} + 0.5) * ${TRANSFORM_TEXELS_PER_SLOT};
    vec4 t = texelFetch(${u.transforms}, ivec2(texel % ${TRANSFORM_TEXTURE_WIDTH}, texel / ${TRANSFORM_TEXTURE_WIDTH}), 0);
    float c = t.${component(TRANSFORM_COS)};
    float s = t.${component(TRANSFORM_SIN)};
    vec2 world = vec2(c * local.x - s * local.y, s * local.x + c * local.y)
        + vec2(t.${component(TRANSFORM_TX)}, t.${component(TRANSFORM_TY)});

    vec2 clip = (world * ${u.scale} + ${u.offset}) / ${u.viewportSize} * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    v_imagePosition = ${a.imagePosition.name} + offset;
    v_distance = ${a.side.name} * extent / worldPerPixel;
    v_kind = float(kind);
}
`;

export const MAIN_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D ${u.photo};
uniform vec2 ${u.imageSize};
uniform vec2 ${u.uvScale};
uniform vec2 ${u.uvOffset};
uniform bool ${u.blank};
uniform float ${u.pieceOpacity};
uniform vec4 ${u.outlineColor};
uniform float ${u.scale};
uniform float ${u.pixelRatio};
uniform float ${u.halfWidth};
uniform bool ${u.constantWidth};
uniform bool ${u.innerOnly};

in vec2 v_imagePosition;
in float v_distance;
in float v_kind;

out vec4 fragColor;

vec4 photo(vec2 imagePosition) {
    if (${u.blank}) return vec4(1.0);
    vec2 uv = imagePosition / ${u.imageSize} * ${u.uvScale} + ${u.uvOffset};
    return texture(${u.photo}, clamp(uv, 0.0, 1.0));
}

vec4 outline() {
    return vec4(${u.outlineColor}.rgb * ${u.outlineColor}.a, ${u.outlineColor}.a);
}

void main() {
    int kind = int(v_kind + 0.5);
    if (kind == ${KIND_FILL}) {
        fragColor = photo(v_imagePosition) * ${u.pieceOpacity};
    } else if (kind == ${KIND_STROKE}) {
        if (${u.innerOnly} && v_distance > 0.0) discard;
        float halfWidth = (${u.constantWidth} ? ${u.halfWidth} : ${u.halfWidth} * ${u.scale}) * ${u.pixelRatio};
        float far = ${u.innerOnly} ? v_distance + 0.5 : min(v_distance + 0.5, halfWidth);
        float coverage = clamp(far - max(v_distance - 0.5, -halfWidth), 0.0, 1.0);
        fragColor = outline() * coverage;
    } else if (kind == ${KIND_FRINGE}) {
        vec4 color = ${u.innerOnly} ? outline() : photo(v_imagePosition) * ${u.pieceOpacity};
        if (v_distance < 0.0) discard;
        fragColor = color * clamp(0.5 - v_distance, 0.0, 1.0);
    } else {
        discard;
    }
}
`;
