// 토지피복 팔레트와 셀 데이터 텍스처. 지형·수면 셰이더가 셀 색을 연도별로 고를 때 쓴다.

import { Color, DataTexture, NearestFilter, RGBAFormat, UnsignedByteType, Vector3 } from 'three';
import { LC_COUNT, LC_INFO } from '../data/codes.ts';
import type { WorldArrays, WorldMeta } from '../data/format.ts';

/** LC 코드 → 선형 색(셰이더 uniform vec3[32]). */
export function paletteUniform(): Vector3[] {
  const out: Vector3[] = [];
  const c = new Color();
  for (let i = 0; i < LC_COUNT; i++) {
    c.set(LC_INFO[i]?.color ?? '#ff00ff'); // sRGB 16진 → 작업 색공간(선형)
    out.push(new Vector3(c.r, c.g, c.b));
  }
  return out;
}

export interface CellTextures {
  /** R = lc0, G = lc1, B = lc2, A = mask */
  cell: DataTexture;
  /** R = y1 − 1900, G = y2 − 1900 (0 = 없음), B = 행정동 */
  year: DataTexture;
}

export function makeCellTextures(a: WorldArrays, m: WorldMeta, maxSize: number): CellTextures {
  if (m.width > maxSize || m.height > maxSize) throw new Error(`격자(${m.width}×${m.height})가 GPU 최대 텍스처 크기 ${maxSize} 를 넘습니다`);
  const n = m.width * m.height;
  const cell = new Uint8Array(n * 4);
  const year = new Uint8Array(n * 4);
  for (let k = 0; k < n; k++) {
    cell[k * 4] = a.lc0[k];
    cell[k * 4 + 1] = a.lc1[k];
    cell[k * 4 + 2] = a.lc2[k];
    cell[k * 4 + 3] = a.mask[k];
    year[k * 4] = a.y1[k] ? a.y1[k] - 1900 : 0;
    year[k * 4 + 1] = a.y2[k] ? a.y2[k] - 1900 : 0;
    year[k * 4 + 2] = a.district[k];
  }
  const mk = (d: Uint8Array) => {
    const t = new DataTexture(d, m.width, m.height, RGBAFormat, UnsignedByteType);
    t.magFilter = NearestFilter;
    t.minFilter = NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    t.needsUpdate = true;
    return t;
  };
  return { cell: mk(cell), year: mk(year) };
}

/** 셰이더 공용: 셀 조회로 연도별 토지피복 코드를 구하는 GLSL. */
export const GLSL_CELL = /* glsl */ `
uniform sampler2D uCellTex;
uniform sampler2D uYearTex;
uniform vec3 uPalette[${LC_COUNT}];
uniform vec2 uGridOrigin;
uniform vec2 uGridSize;
uniform float uCellSize;
ivec2 gmCellOf(vec2 xz) {
  vec2 c = floor((xz - uGridOrigin) / uCellSize);
  return ivec2(clamp(c, vec2(0.0), uGridSize - 1.0));
}
float gmLcAt(ivec2 c, float year, out float mask) {
  c = clamp(c, ivec2(0), ivec2(uGridSize) - 1);
  vec4 cd = texelFetch(uCellTex, c, 0) * 255.0;
  vec4 yd = texelFetch(uYearTex, c, 0) * 255.0;
  mask = cd.a;
  float lc = cd.r;
  if (yd.r > 0.5 && year >= yd.r + 1900.0) lc = cd.g;
  if (yd.g > 0.5 && year >= yd.g + 1900.0) lc = cd.b;
  return floor(lc + 0.5);
}
float gmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
`;
