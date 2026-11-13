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

/**
 * Halo quads (kind 2) reuse the layout: `position` is a corner in the
 * reference piece's local frame, `slot` that piece's slot, `imagePosition`
 * the atlas UV and `normal.x` the atlas layer; `side` is 0.
 */
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
    halo: 'u_halo',
} as const;

export const TRANSFORM_TEXTURE_UNIT = 0;
export const PHOTO_TEXTURE_UNIT = 1;
export const HALO_TEXTURE_UNIT = 2;
export const SILHOUETTE_TEXTURE_UNIT = 3;
export const HALO_IMAGE_TEXTURE_UNIT = 4;
export const BLUR_TEXTURE_UNIT = 5;

// RGBA32F isn't filterable in core WebGL2: the texture needs NEAREST filters and no
// mipmaps, or it is incomplete and texelFetch reads zeros.
export const TRANSFORM_TEXTURE_WIDTH = 1024;
export const TRANSFORM_TEXELS_PER_SLOT = TRANSFORM_STRIDE / 4;

const component = (offset: number) => 'xyzw'[offset];
const a = MAIN_ATTRIBUTES;
const u = MAIN_UNIFORMS;

const transformAt = (sampler: string): string => `
vec4 transformAt(int slot) {
    int texel = slot * ${TRANSFORM_TEXELS_PER_SLOT};
    return texelFetch(${sampler}, ivec2(texel % ${TRANSFORM_TEXTURE_WIDTH}, texel / ${TRANSFORM_TEXTURE_WIDTH}), 0);
}
vec2 rotation(vec4 t) { return vec2(t.${component(TRANSFORM_COS)}, t.${component(TRANSFORM_SIN)}); }
vec2 translation(vec4 t) { return vec2(t.${component(TRANSFORM_TX)}, t.${component(TRANSFORM_TY)}); }
`;

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
out float v_layer;
${transformAt(u.transforms)}
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

    vec4 t = transformAt(int(${a.slot.name} + 0.5));
    vec2 cs = rotation(t);
    vec2 world = vec2(cs.x * local.x - cs.y * local.y, cs.y * local.x + cs.x * local.y) + translation(t);

    vec2 clip = (world * ${u.scale} + ${u.offset}) / ${u.viewportSize} * 2.0 - 1.0;
    gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
    v_imagePosition = ${a.imagePosition.name} + offset;
    v_distance = ${a.side.name} * extent / worldPerPixel;
    v_kind = float(kind);
    v_layer = ${a.normal.name}.x;
}
`;

export const MAIN_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D ${u.photo};
uniform highp sampler2DArray ${u.halo};
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
in float v_layer;

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
    } else if (kind == ${KIND_HALO}) {
        fragColor = texture(${u.halo}, vec3(v_imagePosition, v_layer));
    } else {
        discard;
    }
}
`;

export const SILHOUETTE_UNIFORMS = {
    transforms: 'u_transforms',
    refSlot: 'u_refSlot',
    origin: 'u_origin',
    texelsPerUnit: 'u_texelsPerUnit',
    size: 'u_size',
    halfWidth: 'u_halfWidth',
    gutter: 'u_gutter',
} as const;

const su = SILHOUETTE_UNIFORMS;

export const SILHOUETTE_VS = `#version 300 es
precision highp float;
precision highp int;

layout(location = ${a.position.location}) in vec2 ${a.position.name};
layout(location = ${a.normal.location}) in vec2 ${a.normal.name};
layout(location = ${a.side.location}) in float ${a.side.name};
layout(location = ${a.slot.location}) in float ${a.slot.name};
layout(location = ${a.kind.location}) in float ${a.kind.name};

uniform highp sampler2D ${su.transforms};
uniform int ${su.refSlot};
uniform vec2 ${su.origin};
uniform float ${su.texelsPerUnit};
uniform vec2 ${su.size};
uniform float ${su.halfWidth};
uniform float ${su.gutter};

out float v_distance;
out float v_kind;
${transformAt(su.transforms)}
void main() {
    int kind = int(${a.kind.name} + 0.5);
    float texel = 1.0 / ${su.texelsPerUnit};
    float extent = kind == ${KIND_STROKE} ? ${su.halfWidth} + 0.5 * texel : kind == ${KIND_FRINGE} ? texel : 0.0;
    vec2 local = ${a.position.name} + ${a.normal.name} * (${a.side.name} * extent);
    vec4 t = transformAt(int(${a.slot.name} + 0.5));
    vec4 r = transformAt(${su.refSlot});
    vec2 cs = rotation(t);
    vec2 world = vec2(cs.x * local.x - cs.y * local.y, cs.y * local.x + cs.x * local.y) + translation(t);
    vec2 d = world - translation(r);
    vec2 rc = rotation(r);
    vec2 refLocal = vec2(rc.x * d.x + rc.y * d.y, -rc.y * d.x + rc.x * d.y);
    vec2 pixel = (refLocal - ${su.origin}) * ${su.texelsPerUnit} + ${su.gutter};
    gl_Position = vec4(pixel / ${su.size} * 2.0 - 1.0, 0.0, 1.0);
    v_distance = ${a.side.name} * extent * ${su.texelsPerUnit};
    v_kind = float(kind);
}
`;

export const SILHOUETTE_FS = `#version 300 es
precision highp float;

uniform float ${su.texelsPerUnit};
uniform float ${su.halfWidth};

in float v_distance;
in float v_kind;

out vec4 fragColor;

void main() {
    int kind = int(v_kind + 0.5);
    float coverage = 1.0;
    if (kind == ${KIND_STROKE}) {
        float halfWidth = ${su.halfWidth} * ${su.texelsPerUnit};
        coverage = clamp(min(v_distance + 0.5, halfWidth) - max(v_distance - 0.5, -halfWidth), 0.0, 1.0);
    } else if (kind == ${KIND_FRINGE}) {
        if (v_distance < 0.0) discard;
        coverage = clamp(0.5 - v_distance, 0.0, 1.0);
    }
    fragColor = vec4(coverage);
}
`;

export const MAX_BLUR_TAPS = 64;

export const PASS_UNIFORMS = {
    silhouette: 'u_silhouette',
    halo: 'u_halo',
    source: 'u_source',
    size: 'u_size',
    weights: 'u_weights',
    radius: 'u_radius',
    color: 'u_color',
    factor: 'u_factor',
    regionOrigin: 'u_regionOrigin',
} as const;

const pu = PASS_UNIFORMS;

export const PASS_VS = `#version 300 es
void main() {
    vec2 corner = vec2(float((gl_VertexID & 1) << 2), float((gl_VertexID & 2) << 1)) - 1.0;
    gl_Position = vec4(corner, 0.0, 1.0);
}
`;

const blurLoop = (fetch: string) => `
    float sum = 0.0;
    for (int i = 0; i < ${MAX_BLUR_TAPS}; i++) {
        if (i > 2 * ${pu.radius}) break;
        ${fetch}
    }`;

/**
 * Horizontal pass on the composite's alpha: the silhouette over the halo so
 * far, as each CSS drop-shadow blurs the result of the previous ones.
 */
export const BLUR_X_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D ${pu.silhouette};
uniform sampler2D ${pu.halo};
uniform ivec2 ${pu.size};
uniform float ${pu.weights}[${MAX_BLUR_TAPS}];
uniform int ${pu.radius};

out vec4 fragColor;

float alphaAt(ivec2 p) {
    if (p.x < 0 || p.x >= ${pu.size}.x) return 0.0;
    float s = texelFetch(${pu.silhouette}, p, 0).r;
    return s + texelFetch(${pu.halo}, p, 0).a * (1.0 - s);
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ${blurLoop(`sum += ${pu.weights}[i] * alphaAt(p + ivec2(i - ${pu.radius}, 0));`)}
    fragColor = vec4(sum);
}
`;

/** Vertical pass, tinted; it is blended under the halo so far (destination-over). */
export const BLUR_Y_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D ${pu.source};
uniform ivec2 ${pu.size};
uniform float ${pu.weights}[${MAX_BLUR_TAPS}];
uniform int ${pu.radius};
uniform vec4 ${pu.color};

out vec4 fragColor;

float alphaAt(ivec2 p) {
    if (p.y < 0 || p.y >= ${pu.size}.y) return 0.0;
    return texelFetch(${pu.source}, p, 0).r;
}

void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    ${blurLoop(`sum += ${pu.weights}[i] * alphaAt(p + ivec2(0, i - ${pu.radius}));`)}
    fragColor = ${pu.color} * sum;
}
`;

export const MIP_FS = `#version 300 es
precision highp float;
precision highp int;

uniform sampler2D ${pu.source};
uniform int ${pu.factor};
uniform ivec2 ${pu.regionOrigin};

out vec4 fragColor;

void main() {
    ivec2 base = (ivec2(gl_FragCoord.xy) - ${pu.regionOrigin}) * ${pu.factor};
    vec4 sum = vec4(0.0);
    for (int y = 0; y < ${pu.factor}; y++) {
        for (int x = 0; x < ${pu.factor}; x++) sum += texelFetch(${pu.source}, base + ivec2(x, y), 0);
    }
    fragColor = sum / float(${pu.factor} * ${pu.factor});
}
`;
