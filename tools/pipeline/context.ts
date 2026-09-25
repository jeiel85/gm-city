// 파이프라인 단계들이 주고받는 공유 상태. 각 단계는 필요한 필드를 읽고 자기 출력 필드를 채운다.
// 단계 순서(tools/build-world.ts): terrain → landcover → buildings → cellHistory → network → trees → historyJson → write

import type { OsmElement, LayerName } from '../lib/osm.ts';
import type { GridSpec } from '../lib/raster.ts';
import type { Ring } from '../lib/geom.ts';
import type { Curated } from './curated.ts';
import type { BusRoute, HistoryFile, RailLine } from '../../src/data/format.ts';

export interface PipelineConfig {
  cellSize: number; // 셀 한 변(m)
  subSize: number; // 건물 세부 격자(m)
  marginMeters: number; // 시 경계 밖으로 그릴 여백 폭(m)
  yearMin: number;
  yearMax: number;
  yearNow: number;
  seed: number; // 절차 생성 난수 시드(결정적 출력)
}

/** 고도 샘플러. 로컬 좌표(m) → 해발 높이(m), 쌍선형 보간. */
export interface Elevation {
  sample(x: number, z: number): number;
}

export interface Grid {
  spec: GridSpec; // cell = cfg.cellSize
  /** 지면 높이(m). terrain 단계가 채우고, landcover 단계가 도로·하천을 반영해 다듬을 수 있다. */
  height: Float32Array;
  /** MASK 값. */
  mask: Uint8Array;
  /** 행정동 인덱스(255 = 없음). */
  district: Uint8Array;
  districts: { name: string; center: [number, number] }[];
  /** 현재(OSM 기준) 토지피복. */
  lcNow: Uint8Array;
  /** 셀 위 도로 등급+1 (0 = 도로 아님). 가장 높은 등급이 이긴다. 건물·나무 배치 회피용. */
  road: Uint8Array;
  /** 셀이 도시화된 추정 연도(0 = 모름). cellHistory 단계가 채운다. */
  urbanYear: Uint16Array;
  /** 3단계 토지피복 이력(format.ts WorldArrays 참고). cellHistory 단계가 채운다. */
  lc0: Uint8Array;
  lc1: Uint8Array;
  lc2: Uint8Array;
  y1: Uint16Array;
  y2: Uint16Array;
}

export interface BuildingRec {
  osmId: number;
  osmType: 0 | 1 | 2;
  kind: number; // BK
  floors: number;
  heightM: number;
  baseM: number;
  built: number;
  removed: number;
  constructStart: number;
  yearSource: number; // YEAR_SRC
  palette: number;
  roof: number; // ROOF
  flags: number; // BF
  name: string | null;
  cx: number;
  cz: number;
  /** 세부 격자 사각형 [sx0, sz0, sx1, sz1] (끝 배타적). */
  rects: [number, number, number, number][];
}

export interface TreeRec {
  x: number;
  z: number;
  y: number;
  kind: number; // TREE
  size: number; // 0~255
  planted: number;
  removed: number;
}

export interface RoadNode {
  x: number;
  y: number;
  z: number;
}

export interface RoadEdge {
  a: number;
  b: number;
  cls: number; // RC
  lanes: number;
  oneway: 0 | 1;
  level: number; // LEVEL
  width: number;
  built: number;
  name: number; // roadNames 인덱스(-1)
  /** 양 끝 노드를 포함한 폴리라인 (x, y, z). */
  pts: [number, number, number][];
}

export interface NetworkOut {
  nodes: RoadNode[];
  edges: RoadEdge[];
  roadNames: string[];
  lines: RailLine[];
  busRoutes: BusRoute[];
  /** 철도·버스 경로 점 (x, y, z) 평탄 배열과 점별 LEVEL. RailPath.start 는 점 번호(=pathPts 인덱스/3). */
  pathPts: number[];
  pathLevel: number[];
}

export interface PipelineContext {
  cfg: PipelineConfig;
  root: string;
  osm: Record<LayerName, OsmElement[]>;
  elev: Elevation;
  curated: Curated;
  /** 광명시 경계(로컬) 바깥 링과 구멍. */
  cityRings: Ring[];
  grid: Grid;
  buildings: BuildingRec[];
  trees: TreeRec[];
  network: NetworkOut | null;
  history: HistoryFile | null;
  stats: Record<string, number>;
  /** 결정적 난수(0 이상 1 미만). 단계마다 fork 해서 쓰면 단계 간 순서 의존이 줄어든다. */
  rng: () => number;
  log: (msg: string) => void;
}

/** mulberry32: 작고 결정적인 PRNG. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 좌표 기반 결정적 해시 난수(0~1). 순서와 무관하게 같은 위치는 같은 값. */
export function hash2(x: number, z: number, salt = 0): number {
  let h = Math.imul((x * 73856093) ^ (z * 19349663) ^ (salt * 83492791), 0x27d4eb2d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}
