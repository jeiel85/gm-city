// P1 terrain: 마스크(광명시/여백), 지면 높이, 행정동.

import { MASK } from '../../src/data/codes.ts';
import { areaRings, allRings } from '../lib/osm.ts';
import { fillRings, cellCenterX, cellCenterZ } from '../lib/raster.ts';
import { ringCentroid, pointInRings, ringArea } from '../lib/geom.ts';
import type { PipelineContext } from './context.ts';

/** 3×3 중앙값 필터(도시부 SRTM 잡음 완화). */
function median3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(src.length);
  const buf = new Float32Array(9);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let n = 0;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const x = Math.min(w - 1, Math.max(0, i + di));
          const y = Math.min(h - 1, Math.max(0, j + dj));
          buf[n++] = src[y * w + x];
        }
      buf.sort();
      out[j * w + i] = buf[4];
    }
  return out;
}

export function buildTerrain(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;

  // 1) 마스크: 광명시 안 = CITY, 경계에서 marginMeters 이내 = MARGIN (8방향 BFS, 체스판 거리)
  fillRings(g.spec, ctx.cityRings, (i, j) => (g.mask[j * w + i] = MASK.CITY));
  const steps = Math.round(ctx.cfg.marginMeters / g.spec.cell);
  const dist = new Int16Array(w * h).fill(-1);
  let frontier: number[] = [];
  for (let k = 0; k < w * h; k++)
    if (g.mask[k] === MASK.CITY) {
      dist[k] = 0;
      frontier.push(k);
    }
  for (let s = 1; s <= steps && frontier.length; s++) {
    const next: number[] = [];
    for (const k of frontier) {
      const i = k % w;
      const j = (k - i) / w;
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const x = i + di;
          const y = j + dj;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const q = y * w + x;
          if (dist[q] >= 0) continue;
          dist[q] = s;
          g.mask[q] = MASK.MARGIN;
          next.push(q);
        }
    }
    frontier = next;
  }

  // 2) 높이: 셀 중심 고도 → 중앙값 필터. 음수(고도 타일 수면 잡음)는 주변 값으로 막는다.
  const raw = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const z = cellCenterZ(g.spec, j);
    for (let i = 0; i < w; i++) raw[j * w + i] = Math.max(0, ctx.elev.sample(cellCenterX(g.spec, i), z));
  }
  g.height.set(median3(raw, w, h));

  // 3) 행정동: 광명시 안에 중심이 있는 admin_level 8 만.
  const dists = ctx.osm.districts
    .map((el) => ({ el, rings: areaRings(el) }))
    .filter((d): d is { el: typeof d.el; rings: NonNullable<typeof d.rings> } => !!d.rings)
    .map((d) => {
      const biggest = d.rings.outer.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
      return { name: d.el.tags?.name ?? '', rings: allRings(d.rings), center: ringCentroid(biggest) };
    })
    .filter((d) => d.name && pointInRings(d.center[0], d.center[1], ctx.cityRings))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  if (dists.length < 10) throw new Error(`광명시 행정동이 ${dists.length}개뿐입니다 — districts.json 을 확인하세요`);
  if (dists.length > 254) throw new Error('행정동이 너무 많습니다');
  dists.forEach((d, idx) => {
    g.districts.push({ name: d.name, center: [Math.round(d.center[0]), Math.round(d.center[1])] });
    fillRings(g.spec, d.rings, (i, j) => {
      const k = j * w + i;
      if (g.mask[k] === MASK.CITY) g.district[k] = idx;
    });
  });
  // 경계선 근처에서 어느 동에도 안 걸린 도시 셀은 가장 가까운 동 중심으로
  for (let k = 0; k < w * h; k++) {
    if (g.mask[k] !== MASK.CITY || g.district[k] !== 255) continue;
    const x = cellCenterX(g.spec, k % w);
    const z = cellCenterZ(g.spec, Math.floor(k / w));
    let best = 0;
    let bd = Infinity;
    g.districts.forEach((d, idx) => {
      const dd = (d.center[0] - x) ** 2 + (d.center[1] - z) ** 2;
      if (dd < bd) {
        bd = dd;
        best = idx;
      }
    });
    g.district[k] = best;
  }

  let city = 0;
  let margin = 0;
  for (let k = 0; k < w * h; k++) {
    if (g.mask[k] === MASK.CITY) city++;
    else if (g.mask[k] === MASK.MARGIN) margin++;
  }
  ctx.stats.cityCells = city;
  ctx.stats.marginCells = margin;
  ctx.stats.districts = g.districts.length;
  ctx.log(`도시 셀 ${city} (${((city * g.spec.cell ** 2) / 1e6).toFixed(1)} km²), 여백 ${margin}, 행정동 ${g.districts.length}`);
}
