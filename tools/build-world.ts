// 데이터 파이프라인 진입점: data-raw(OSM·고도) + data-src(조사 자료) → public/data/*.gmc, history.json
// 사용법: node tools/build-world.ts  (npm run data:build)

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLayer, LAYER_NAMES, areaRings, type OsmElement, type LayerName } from './lib/osm.ts';
import { loadElevation } from './lib/elevation.ts';
import { bboxOf } from './lib/geom.ts';
import { loadCurated } from './pipeline/curated.ts';
import { makeRng, type Grid, type PipelineConfig, type PipelineContext } from './pipeline/context.ts';
import { YEAR_MAX, YEAR_MIN, YEAR_NOW } from '../src/data/codes.ts';
import { buildTerrain } from './pipeline/terrain.ts';
import { buildLandcover } from './pipeline/landcover.ts';
import { buildBuildings } from './pipeline/buildings.ts';
import { buildCellHistory } from './pipeline/cell-history.ts';
import { buildNetwork } from './pipeline/network.ts';
import { buildTrees } from './pipeline/trees.ts';
import { buildHistoryJson } from './pipeline/history-json.ts';
import { writeOutputs } from './pipeline/write.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const CITY_RELATION_ID = 2409171;

const CONFIG: PipelineConfig = {
  cellSize: 5,
  subSize: 2.5,
  marginMeters: 250,
  yearMin: YEAR_MIN,
  yearMax: YEAR_MAX,
  yearNow: YEAR_NOW,
  seed: 20260926,
};

function allocGrid(cityRings: [number, number][][], cfg: PipelineConfig): Grid {
  const bb = bboxOf(cityRings.flat());
  const c = cfg.cellSize;
  const x0 = Math.floor((bb.minX - cfg.marginMeters) / c) * c;
  const z0 = Math.floor((bb.minZ - cfg.marginMeters) / c) * c;
  const w = Math.ceil((bb.maxX + cfg.marginMeters - x0) / c);
  const h = Math.ceil((bb.maxZ + cfg.marginMeters - z0) / c);
  const n = w * h;
  return {
    spec: { w, h, x0, z0, cell: c },
    height: new Float32Array(n),
    mask: new Uint8Array(n),
    district: new Uint8Array(n).fill(255),
    districts: [],
    lcNow: new Uint8Array(n),
    road: new Uint8Array(n),
    urbanYear: new Uint16Array(n),
    lc0: new Uint8Array(n),
    lc1: new Uint8Array(n),
    lc2: new Uint8Array(n),
    y1: new Uint16Array(n),
    y2: new Uint16Array(n),
  };
}

async function main() {
  const t0 = performance.now();
  const rawDir = join(ROOT, 'data-raw', 'osm');
  const osm = {} as Record<LayerName, OsmElement[]>;
  for (const name of LAYER_NAMES) osm[name] = loadLayer(rawDir, name);

  const cityRel = osm.boundary.find((e) => e.type === 'relation' && e.id === CITY_RELATION_ID);
  if (!cityRel) throw new Error(`boundary.json 에 광명시 relation ${CITY_RELATION_ID} 이 없습니다`);
  const rings = areaRings(cityRel);
  if (!rings || !rings.outer.length) throw new Error('광명시 경계 링을 조립하지 못했습니다');
  const cityRings = [...rings.outer, ...rings.inner];

  const grid = allocGrid(cityRings, CONFIG);
  const ctx: PipelineContext = {
    cfg: CONFIG,
    root: ROOT,
    osm,
    elev: loadElevation(join(ROOT, 'data-raw')),
    curated: loadCurated(join(ROOT, 'data-src')),
    cityRings,
    grid,
    buildings: [],
    trees: [],
    network: null,
    history: null,
    stats: {},
    rng: makeRng(CONFIG.seed),
    log: (msg) => console.log(`  ${msg}`),
  };
  console.log(`격자 ${grid.spec.w}×${grid.spec.h} (셀 ${CONFIG.cellSize}m), 경계 링 ${rings.outer.length}+${rings.inner.length}`);

  const stages: [string, (c: PipelineContext) => void][] = [
    ['terrain', buildTerrain],
    ['landcover', buildLandcover],
    ['buildings', buildBuildings],
    ['cellHistory', buildCellHistory],
    ['network', buildNetwork],
    ['trees', buildTrees],
    ['historyJson', buildHistoryJson],
  ];
  for (const [name, fn] of stages) {
    const s = performance.now();
    console.log(`▶ ${name}`);
    fn(ctx);
    console.log(`  (${((performance.now() - s) / 1000).toFixed(1)}s)`);
  }

  const sizes = writeOutputs(ctx, join(ROOT, 'public', 'data'));
  for (const [f, b] of Object.entries(sizes)) console.log(`  ${f}: ${(b / 1024).toFixed(0)} KB`);
  console.log('통계', ctx.stats);
  console.log(`완료 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
