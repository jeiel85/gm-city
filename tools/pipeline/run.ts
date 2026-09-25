// 파이프라인 컨텍스트 생성과 단계 실행. build-world.ts(전체 실행)와 개발용 스크립트(일부 단계만 실행)가 함께 쓴다.

import { join } from 'node:path';
import { loadLayer, LAYER_NAMES, areaRings, type OsmElement, type LayerName } from '../lib/osm.ts';
import { loadElevation } from '../lib/elevation.ts';
import { bboxOf } from '../lib/geom.ts';
import { loadCurated } from './curated.ts';
import { makeRng, type Grid, type PipelineConfig, type PipelineContext } from './context.ts';
import { YEAR_MAX, YEAR_MIN, YEAR_NOW } from '../../src/data/codes.ts';
import { buildTerrain } from './terrain.ts';
import { buildLandcover } from './landcover.ts';
import { buildBuildings } from './buildings.ts';
import { buildCellHistory } from './cell-history.ts';
import { buildNetwork } from './network.ts';
import { buildTrees } from './trees.ts';
import { buildHistoryJson } from './history-json.ts';

export const CITY_RELATION_ID = 2409171;

export const DEFAULT_CONFIG: PipelineConfig = {
  cellSize: 5,
  subSize: 2.5,
  marginMeters: 250,
  yearMin: YEAR_MIN,
  yearMax: YEAR_MAX,
  yearNow: YEAR_NOW,
  seed: 20260926,
};

export const STAGES = [
  ['terrain', buildTerrain],
  ['landcover', buildLandcover],
  ['buildings', buildBuildings],
  ['cellHistory', buildCellHistory],
  ['network', buildNetwork],
  ['trees', buildTrees],
  ['historyJson', buildHistoryJson],
] as const satisfies readonly (readonly [string, (c: PipelineContext) => void])[];

export type StageName = (typeof STAGES)[number][0];

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

/** 원천 자료를 읽고 빈 격자를 할당한 컨텍스트. */
export function createContext(root: string, cfg: PipelineConfig = DEFAULT_CONFIG, quiet = false): PipelineContext {
  const rawDir = join(root, 'data-raw', 'osm');
  const osm = {} as Record<LayerName, OsmElement[]>;
  for (const name of LAYER_NAMES) osm[name] = loadLayer(rawDir, name);

  const cityRel = osm.boundary.find((e) => e.type === 'relation' && e.id === CITY_RELATION_ID);
  if (!cityRel) throw new Error(`boundary.json 에 광명시 relation ${CITY_RELATION_ID} 이 없습니다`);
  const rings = areaRings(cityRel);
  if (!rings || !rings.outer.length) throw new Error('광명시 경계 링을 조립하지 못했습니다');
  const cityRings = [...rings.outer, ...rings.inner];

  return {
    cfg,
    root,
    osm,
    elev: loadElevation(join(root, 'data-raw')),
    curated: loadCurated(join(root, 'data-src')),
    cityRings,
    grid: allocGrid(cityRings, cfg),
    buildings: [],
    trees: [],
    network: null,
    history: null,
    stats: {},
    rng: makeRng(cfg.seed),
    log: quiet ? () => {} : (msg) => console.log(`  ${msg}`),
  };
}

/** 단계를 순서대로 실행한다. until 을 주면 그 단계까지만. */
export function runStages(ctx: PipelineContext, until?: StageName, verbose = true): void {
  for (const [name, fn] of STAGES) {
    const s = performance.now();
    if (verbose) console.log(`▶ ${name}`);
    fn(ctx);
    if (verbose) console.log(`  (${((performance.now() - s) / 1000).toFixed(1)}s)`);
    if (name === until) return;
  }
}
