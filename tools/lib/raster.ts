// 격자 래스터화. 셀 중심 샘플링으로 면을 채우고, 폭이 있는 폴리라인을 칠한다.

import type { Pt, Ring } from './geom.ts';
import { distToSegmentSq } from './geom.ts';

/** 격자 정의. 셀 (i, j) 는 x ∈ [x0 + i*cell, …), z ∈ [z0 + j*cell, …). */
export interface GridSpec {
  w: number;
  h: number;
  x0: number;
  z0: number;
  cell: number;
}

export const cellCenterX = (g: GridSpec, i: number) => g.x0 + (i + 0.5) * g.cell;
export const cellCenterZ = (g: GridSpec, j: number) => g.z0 + (j + 0.5) * g.cell;
export const inGrid = (g: GridSpec, i: number, j: number) => i >= 0 && j >= 0 && i < g.w && j < g.h;
export const cellOf = (g: GridSpec, x: number, z: number): [number, number] => [Math.floor((x - g.x0) / g.cell), Math.floor((z - g.z0) / g.cell)];

/**
 * 링들(짝홀 규칙: 바깥 + 구멍)을 셀 중심 기준으로 채운다. 중심이 안에 있는 셀마다 cb(i, j).
 * 행마다 교차점을 구해 스캔라인으로 채우므로 큰 다각형도 빠르다.
 */
export function fillRings(g: GridSpec, rings: readonly Ring[], cb: (i: number, j: number) => void): void {
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const r of rings)
    for (const p of r) {
      if (p[1] < minZ) minZ = p[1];
      if (p[1] > maxZ) maxZ = p[1];
    }
  if (!isFinite(minZ)) return;
  const j0 = Math.max(0, Math.floor((minZ - g.z0) / g.cell - 0.5));
  const j1 = Math.min(g.h - 1, Math.ceil((maxZ - g.z0) / g.cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const z = cellCenterZ(g, j);
    xs.length = 0;
    for (const r of rings) {
      for (let a = 0, b = r.length - 1; a < r.length; b = a++) {
        const za = r[a][1];
        const zb = r[b][1];
        if (za > z !== zb > z) xs.push(r[a][0] + ((z - za) * (r[b][0] - r[a][0])) / (zb - za));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      // 셀 중심 x 가 [xs[k], xs[k+1]) 안에 있는 셀
      const i0 = Math.max(0, Math.ceil((xs[k] - g.x0) / g.cell - 0.5));
      const i1 = Math.min(g.w - 1, Math.ceil((xs[k + 1] - g.x0) / g.cell - 0.5) - 1);
      for (let i = i0; i <= i1; i++) cb(i, j);
    }
  }
}

/**
 * 폴리라인에서 halfWidth 이내에 중심이 있는 셀마다 cb(i, j, dist, segIndex, t).
 * 한 셀이 여러 선분에 걸리면 여러 번 호출될 수 있다(가장 가까운 것만 원하면 호출자가 거리로 거른다).
 * minCover 가 true 면 반폭을 최소 셀 대각선 절반으로 보정해, 가는 선도 4방향으로 끊김 없이 이어지게 한다.
 */
export function strokePolyline(
  g: GridSpec,
  pts: readonly Pt[],
  halfWidth: number,
  cb: (i: number, j: number, dist: number, seg: number, t: number) => void,
  minCover = true,
): void {
  // 셀 대각선 절반(√2/2·cell)보다 조금 크게 잡아야 대각선 선도 4방향으로 이어진다.
  const hw = minCover ? Math.max(halfWidth, g.cell * 0.72) : halfWidth;
  const hw2 = hw * hw;
  for (let s = 0; s + 1 < pts.length; s++) {
    const [ax, az] = pts[s];
    const [bx, bz] = pts[s + 1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - g.x0) / g.cell));
    const i1 = Math.min(g.w - 1, Math.floor((Math.max(ax, bx) + hw - g.x0) / g.cell));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - g.z0) / g.cell));
    const j1 = Math.min(g.h - 1, Math.floor((Math.max(az, bz) + hw - g.z0) / g.cell));
    for (let j = j0; j <= j1; j++) {
      const cz = cellCenterZ(g, j);
      for (let i = i0; i <= i1; i++) {
        const { d2, t } = distToSegmentSq(cellCenterX(g, i), cz, ax, az, bx, bz);
        if (d2 <= hw2) cb(i, j, Math.sqrt(d2), s, t);
      }
    }
  }
}

/** 원형 영역(중심 반경) 안에 중심이 있는 셀마다 cb. */
export function fillCircle(g: GridSpec, cx: number, cz: number, r: number, cb: (i: number, j: number, dist: number) => void): void {
  const i0 = Math.max(0, Math.floor((cx - r - g.x0) / g.cell));
  const i1 = Math.min(g.w - 1, Math.floor((cx + r - g.x0) / g.cell));
  const j0 = Math.max(0, Math.floor((cz - r - g.z0) / g.cell));
  const j1 = Math.min(g.h - 1, Math.floor((cz + r - g.z0) / g.cell));
  for (let j = j0; j <= j1; j++)
    for (let i = i0; i <= i1; i++) {
      const d = Math.hypot(cellCenterX(g, i) - cx, cellCenterZ(g, j) - cz);
      if (d <= r) cb(i, j, d);
    }
}

/**
 * 이진 마스크(w×h)를 겹치지 않는 직사각형들로 분해한다(탐욕적: 행 방향으로 최대 폭, 이어서 아래로 확장).
 * 반환: [i0, j0, i1, j1] (끝 배타적) 목록. 결과의 합집합은 마스크와 정확히 같다.
 */
export function greedyRects(mask: Uint8Array, w: number, h: number): [number, number, number, number][] {
  const used = new Uint8Array(w * h);
  const out: [number, number, number, number][] = [];
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!mask[k] || used[k]) continue;
      let i1 = i + 1;
      while (i1 < w && mask[j * w + i1] && !used[j * w + i1]) i1++;
      let j1 = j + 1;
      outer: while (j1 < h) {
        for (let x = i; x < i1; x++) {
          const q = j1 * w + x;
          if (!mask[q] || used[q]) break outer;
        }
        j1++;
      }
      for (let y = j; y < j1; y++) for (let x = i; x < i1; x++) used[y * w + x] = 1;
      out.push([i, j, i1, j1]);
    }
  }
  return out;
}
