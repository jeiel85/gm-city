// P3 trees: 숲·공원·가로수(은행나무, 하천변 벚나무)·아파트 단지 조경·과수원·마을 정자나무.
// 심은 연도 = 그 셀이 지금 모습이 된 연도, 제거 연도 = 숲이 개발된 연도.

import { BF, LC, MASK, RC, TREE } from '../../src/data/codes.ts';
import { wayPoints } from '../lib/osm.ts';
import { offsetPolyline } from '../lib/geom.ts';
import { paintsGround, roadClass, roadWidth } from '../lib/roads.ts';
import { hash2, type PipelineContext, type TreeRec } from './context.ts';

const MAX_TREES = 150_000;

export function buildTrees(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const N = w * h;
  const ratio = Math.round(g.spec.cell / ctx.cfg.subSize);
  const out: TreeRec[] = [];

  // 건물 점유(셀 단위, 현존 건물만)
  const built = new Uint8Array(N);
  for (const b of ctx.buildings) {
    if (b.flags & BF.PREDECESSOR) continue;
    for (const [a0, b0, a1, b1] of b.rects)
      for (let j = Math.floor(b0 / ratio); j < Math.ceil(b1 / ratio); j++)
        for (let i = Math.floor(a0 / ratio); i < Math.ceil(a1 / ratio); i++) if (i >= 0 && j >= 0 && i < w && j < h) built[j * w + i] = 1;
  }
  /** 셀이 lc 가 된 연도와 그만두는 연도. */
  const span = (k: number, lc: number): [number, number] | null => {
    const st = [
      [g.lc0[k], 0],
      [g.lc1[k], g.y1[k]],
      [g.lc2[k], g.y2[k]],
    ] as const;
    let from = -1;
    let to = 0;
    for (let s = 0; s < 3; s++) {
      if (s > 0 && st[s][1] === 0) continue;
      if (st[s][0] === lc && from < 0) from = st[s][1];
      else if (st[s][0] !== lc && from >= 0 && !to) to = st[s][1];
    }
    return from < 0 ? null : [from, to];
  };
  let forestCells = 0;
  for (let k = 0; k < N; k++) if (g.mask[k] !== MASK.VOID && (g.lc0[k] === LC.FOREST || g.lcNow[k] === LC.FOREST)) forestCells++;
  const forestP = Math.min(0.3, (MAX_TREES * 0.72) / Math.max(1, forestCells));

  const place = (k: number, kind: number, planted: number, removed: number, salt: number) => {
    const i = k % w;
    const j = (k - i) / w;
    const x = g.spec.x0 + (i + 0.2 + hash2(i, j, salt) * 0.6) * g.spec.cell;
    const z = g.spec.z0 + (j + 0.2 + hash2(i, j, salt + 1) * 0.6) * g.spec.cell;
    out.push({ x, z, y: g.height[k], kind, size: Math.floor(hash2(i, j, salt + 2) * 255), planted, removed });
  };

  for (let k = 0; k < N; k++) {
    if (g.mask[k] === MASK.VOID || built[k]) continue;
    const i = k % w;
    const j = (k - i) / w;
    const r = hash2(i, j, 91);
    const margin = g.mask[k] === MASK.MARGIN;
    const f = span(k, LC.FOREST);
    if (f) {
      if (r < forestP * (margin ? 0.5 : 1)) place(k, hash2(i, j, 92) < 0.35 ? TREE.PINE : TREE.DECIDUOUS, f[0], f[1], 93);
      continue;
    }
    if (margin) continue;
    const p = span(k, LC.PARK);
    if (p) {
      if (r < 0.07) place(k, hash2(i, j, 94) < 0.25 ? TREE.CHERRY : TREE.DECIDUOUS, p[0] ? p[0] + 2 : 0, p[1], 95);
      continue;
    }
    const o = span(k, LC.ORCHARD);
    if (o) {
      if (i % 2 === 0 && j % 2 === 0) place(k, TREE.FRUIT, o[0], o[1], 96);
      continue;
    }
    const res = span(k, LC.RESIDENTIAL);
    if (res && g.lcNow[k] === LC.RESIDENTIAL && r < 0.035) {
      place(k, hash2(i, j, 97) < 0.3 ? TREE.PINE : TREE.DECIDUOUS, res[0] ? res[0] + 3 : 0, res[1], 98);
      continue;
    }
    const v = span(k, LC.VILLAGE);
    if (v && r < 0.004) place(k, TREE.DECIDUOUS, 0, v[1], 99);
  }

  // 가로수: 도시부 간선·이면도로 양쪽 보도 12m 간격
  let street = 0;
  for (const el of ctx.osm.highways) {
    if (el.type !== 'way' || !paintsGround(el.tags)) continue;
    const cls = roadClass(el.tags);
    if (cls === null || cls < RC.PRIMARY || cls > RC.TERTIARY) continue;
    const pts = wayPoints(el);
    if (pts.length < 2) continue;
    const hw = roadWidth(el.tags, cls) / 2 + 1.5;
    for (const side of [-1, 1]) {
      const line = offsetPolyline(pts, side * hw);
      let carry = 0;
      for (let s = 1; s < line.length; s++) {
        const [ax, az] = line[s - 1];
        const [bx, bz] = line[s];
        const len = Math.hypot(bx - ax, bz - az);
        for (let d = carry; d < len; d += 12) {
          const x = ax + ((bx - ax) * d) / len;
          const z = az + ((bz - az) * d) / len;
          const i = Math.floor((x - g.spec.x0) / g.spec.cell);
          const j = Math.floor((z - g.spec.z0) / g.spec.cell);
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const k = j * w + i;
          if (g.mask[k] !== MASK.CITY || g.lcNow[k] !== LC.SIDEWALK || built[k]) continue;
          const sw = span(k, LC.SIDEWALK);
          // 하천 가까운 길은 벚나무(안양천·목감천 벚꽃길)
          let nearWater = false;
          for (let q = -8; q <= 8 && !nearWater; q += 4)
            for (let r2 = -8; r2 <= 8; r2 += 4) {
              const kk = (j + q) * w + (i + r2);
              if (kk >= 0 && kk < N && g.lcNow[kk] === LC.WATER) {
                nearWater = true;
                break;
              }
            }
          out.push({ x, z, y: g.height[k], kind: nearWater ? TREE.CHERRY : hash2(i, j, 100) < 0.7 ? TREE.GINKGO : TREE.DECIDUOUS, size: 60 + Math.floor(hash2(i, j, 101) * 120), planted: sw && sw[0] ? sw[0] + 2 : 0, removed: 0 });
          street++;
        }
        carry = Math.max(0, carry - len) || (12 - (len % 12)) % 12;
      }
    }
  }
  if (out.length > MAX_TREES) {
    // 결정적으로 솎아 상한을 맞춘다(숲 나무부터)
    const keep = MAX_TREES / out.length;
    ctx.trees = out.filter((t) => t.kind === TREE.GINKGO || t.kind === TREE.CHERRY || hash2(Math.round(t.x), Math.round(t.z), 102) < keep);
  } else ctx.trees = out;
  ctx.stats.trees = ctx.trees.length;
  ctx.stats.streetTrees = street;
  ctx.log(`나무 ${ctx.trees.length}그루 (가로수 ${street}, 숲 셀 ${forestCells}, 숲 밀도 ${forestP.toFixed(3)})`);
}
