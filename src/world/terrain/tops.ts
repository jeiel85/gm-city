// world 배열 → 렌더링할 기둥 윗면 높이(정수 m). 지형 메셔·지면 질의·수면이 같은 규칙을 쓴다.

import { LC } from '../../data/codes.ts';
import type { WorldArrays, WorldMeta } from '../../data/format.ts';

/** 수면은 수면 높이보다 이만큼 낮게(하상). */
export const WATER_BED_DEPTH = 1.5;
/** 수면을 그리는 높이 = 셀 높이 − 이 값. */
export const WATER_SURFACE_DROP = 0.3;

/** 물 셀인지(물은 연도에 따라 바뀌지 않는다: lc0 기준). */
export const isWater = (a: Pick<WorldArrays, 'lc0'>, k: number) => a.lc0[k] === LC.WATER;

export function terrainTops(a: Pick<WorldArrays, 'height' | 'mask' | 'lc0'>, m: Pick<WorldMeta, 'width' | 'height'>): { top: Int16Array; mask: Uint8Array } {
  const n = m.width * m.height;
  const top = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const hm = a.height[k] / 10;
    top[k] = isWater(a, k) ? Math.floor(hm - WATER_BED_DEPTH) : Math.round(hm);
  }
  return { top, mask: a.mask };
}
