// 개발용: world.gmc 전체를 지형 메셔로 돌려 삼각형 수·시간을 잰다.
import { readFileSync } from 'node:fs';
import { decodePack } from '../../src/data/pack.ts';
import type { WorldMeta } from '../../src/data/format.ts';
import { meshChunk, downsample, type HeightGrid } from '../../src/world/terrain/mesher.ts';
import { terrainTops } from '../../src/world/terrain/tops.ts';

const w = decodePack<WorldMeta>(readFileSync('public/data/world.gmc'));
const m = w.meta;
const g: HeightGrid = { w: m.width, h: m.height, cell: m.cellSize, x0: m.x0, z0: m.z0, ...terrainTops(w.arrays as never, m), base: Math.floor(m.minHeight) - 25 };
for (const [name, grid] of [['LOD0', g], ['LOD1', downsample(g)]] as const) {
  const t0 = performance.now();
  let tris = 0;
  const C = 64;
  for (let j = 0; j < grid.h; j += C) for (let i = 0; i < grid.w; i += C) tris += meshChunk(grid, i, j, Math.min(grid.w, i + C), Math.min(grid.h, j + C)).indices.length / 3;
  console.log(name, `${(tris / 1e6).toFixed(2)}M 삼각형, ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}
