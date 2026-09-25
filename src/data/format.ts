// public/data/ 에 들어가는 데이터 파일들의 계약(contract).
// 파이프라인(tools/build-world.ts)이 이 타입대로 쓰고, 클라이언트(src/data/loader.ts)가 이 타입대로 읽는다.
// 필드를 바꾸면 양쪽을 함께 고치고 FORMAT_VERSION 을 올린다.
//
// 좌표: 모두 로컬 미터(src/data/geo.ts). X 동쪽, Z 남쪽, Y 위.
// 연도: 서기 연도 정수. 0 은 "해당 없음"(변화 없음/철거 안 됨)을 뜻한다.

export const FORMAT_VERSION = 1;

export const DATA_FILES = {
  world: 'world.gmc',
  buildings: 'buildings.gmc',
  trees: 'trees.gmc',
  network: 'network.gmc',
  history: 'history.json',
} as const;

// ───────────────────────── world.gmc ─────────────────────────
// 셀 격자. 셀 (i, j) 는 i = 열(동쪽으로 증가), j = 행(남쪽으로 증가), 인덱스 = j * width + i.
// 셀 (i, j) 가 덮는 범위: x ∈ [x0 + i*cellSize, x0 + (i+1)*cellSize), z ∈ [z0 + j*cellSize, z0 + (j+1)*cellSize).

export interface WorldMeta {
  version: number;
  generatedAt: string;
  origin: { lat: number; lon: number };
  cellSize: number; // 셀 한 변(m)
  subSize: number; // 건물 세부 격자 한 변(m). cellSize 의 약수.
  width: number; // 셀 열 수
  height: number; // 셀 행 수
  x0: number; // 격자 서쪽 끝 x(m)
  z0: number; // 격자 북쪽 끝 z(m)
  minHeight: number; // 지면 최저 높이(m)
  maxHeight: number; // 지면 최고 높이(m)
  /** 광명시 경계 외곽 링들(로컬 [x, z]). */
  boundary: [number, number][][];
  /** 행정동 목록. district 배열 값이 이 인덱스(255 = 없음). */
  districts: { name: string; center: [number, number] }[];
  stats: Record<string, number>;
  attribution: string[];
}

export interface WorldArrays {
  /** 지면 높이(데시미터). 수면 셀은 수면 높이. */
  height: Int16Array;
  /** MASK 값. */
  mask: Uint8Array;
  /** 토지피복 3단계 이력: lc0 --(y1)--> lc1 --(y2)--> lc2. y1/y2 가 0 이면 그 전환이 없다. */
  lc0: Uint8Array;
  lc1: Uint8Array;
  lc2: Uint8Array;
  y1: Uint16Array;
  y2: Uint16Array;
  /** 행정동 인덱스(255 = 없음). */
  district: Uint8Array;
}

/** 연도 year 에서의 셀 토지피복. y1/y2 가 0 이면 그 전환은 없다. */
export function landCoverAt(a: Pick<WorldArrays, 'lc0' | 'lc1' | 'lc2' | 'y1' | 'y2'>, idx: number, year: number): number {
  const y2 = a.y2[idx];
  if (y2 !== 0 && year >= y2) return a.lc2[idx];
  const y1 = a.y1[idx];
  if (y1 !== 0 && year >= y1) return a.lc1[idx];
  return a.lc0[idx];
}

// ───────────────────────── buildings.gmc ─────────────────────────
// 건물 하나 = 세부 격자(subSize) 위 직사각형들의 합집합을 floors/heightDm 만큼 올린 것.
// rects 는 [sx0, sz0, sx1, sz1] 4개씩(끝 배타적), 세부 격자 좌표 = floor((x - x0) / subSize).

export interface BuildingsMeta {
  version: number;
  count: number;
  rectCount: number;
  /** nameIdx 가 가리키는 이름 표. */
  names: string[];
}

export interface BuildingsArrays {
  osmId: Float64Array; // OSM id (절차 생성이면 0)
  osmType: Uint8Array; // 0 없음, 1 way, 2 relation
  kind: Uint8Array; // BK
  floors: Uint8Array; // 층수(1 이상)
  heightDm: Uint16Array; // 건물 높이(데시미터)
  baseDm: Int16Array; // 바닥 높이(데시미터) = 발자국 아래 지면 최저값
  built: Uint16Array; // 준공 연도(0 = 1960 이전부터 존재)
  removed: Uint16Array; // 철거 연도(0 = 현존)
  constructStart: Uint16Array; // 착공 연도(0 = built - 2 로 간주)
  yearSource: Uint8Array; // YEAR_SRC
  palette: Uint8Array; // 색 변형 인덱스(0~255, 렌더러가 해석)
  roof: Uint8Array; // ROOF
  flags: Uint8Array; // BF 비트
  nameIdx: Int32Array; // names 인덱스(-1 = 없음)
  cx: Float32Array; // 중심 x(m)
  cz: Float32Array; // 중심 z(m)
  rectStart: Uint32Array; // rects 에서의 시작 사각형 번호
  rectCount: Uint16Array; // 사각형 개수
  rects: Uint16Array; // 4 * rectCount 전체
}

/** 착공 연도 기본값 규칙. */
export function constructionStartOf(a: Pick<BuildingsArrays, 'built' | 'constructStart'>, i: number): number {
  const s = a.constructStart[i];
  if (s !== 0) return s;
  const b = a.built[i];
  return b === 0 ? 0 : b - 2;
}

// ───────────────────────── trees.gmc ─────────────────────────

export interface TreesMeta {
  version: number;
  count: number;
}

export interface TreesArrays {
  x: Float32Array;
  z: Float32Array;
  y: Float32Array; // 지면 높이(m)
  kind: Uint8Array; // TREE
  size: Uint8Array; // 0~255 → 크기 배율 0.6~1.6
  planted: Uint16Array; // 0 = 처음부터
  removed: Uint16Array; // 0 = 현존
}

// ───────────────────────── network.gmc ─────────────────────────
// 도로 그래프 + 철도/버스 경로. 모든 점은 (x, y, z) 3개씩.

export interface NetworkMeta {
  version: number;
  nodeCount: number;
  edgeCount: number;
  lines: RailLine[];
  busRoutes: BusRoute[];
  /** 도로 이름 표(edgeName 인덱스). */
  roadNames: string[];
}

export interface NetworkArrays {
  nodeX: Float32Array;
  nodeY: Float32Array;
  nodeZ: Float32Array;
  edgeA: Uint32Array; // 시작 노드
  edgeB: Uint32Array; // 끝 노드
  edgeClass: Uint8Array; // RC
  edgeLanes: Uint8Array; // 전체 차로 수(양방향 합)
  edgeOneway: Uint8Array; // 0 양방향, 1 A→B 일방
  edgeLevel: Int8Array; // LEVEL (-1 터널, 0 지상, 1+ 교량)
  edgeWidth: Float32Array; // 차도 폭(m)
  edgeBuilt: Uint16Array; // 개통 연도(0 = 처음부터)
  edgeName: Int32Array; // roadNames 인덱스(-1 없음)
  edgePtStart: Uint32Array; // pts 에서의 시작 점 번호
  edgePtCount: Uint16Array; // 점 개수(양 끝 노드 포함, 2 이상)
  pts: Float32Array; // 도로 폴리라인 점 (x, y, z)*
  pathPts: Float32Array; // 철도·버스 경로 점 (x, y, z)*
  pathLevel: Int8Array; // 경로 점별 LEVEL
}

export type RailKind = 'subway' | 'high_speed' | 'commuter' | 'freight' | 'planned';

export interface RailPath {
  start: number; // pathPts 에서의 시작 점 번호
  count: number; // 점 개수
  length: number; // 총 길이(m)
}

export interface RailStation {
  name: string;
  x: number;
  y: number;
  z: number;
  level: number; // LEVEL
  opened: number; // 개업 연도
  /** 이 역이 놓인 경로 인덱스와 그 경로 시작점부터의 거리(m). */
  path: number;
  distance: number;
  inCity: boolean;
}

export interface RailLine {
  id: string; // 'line7', 'ktx', 'line1-shuttle', 'sinansan' 등
  name: string; // '서울 지하철 7호선'
  kind: RailKind;
  color: string; // 노선색 #rrggbb
  bodyColor: string; // 차체색
  stripeColor: string; // 띠색
  cars: number; // 편성 량수
  carLength: number; // 량당 길이(m)
  opened: number; // 광명 구간 개통 연도(계획이면 목표 연도)
  status: 'completed' | 'under_construction' | 'planned';
  headwayPeak: number; // 분
  headwayOffpeak: number; // 분
  speedKmh: number; // 도시 구간 평균 속도
  /** 방향별 경로(보통 상·하행 2개). */
  paths: RailPath[];
  stations: RailStation[];
}

export interface BusRoute {
  ref: string; // 노선 번호
  name: string;
  category: string; // '서울 간선', '경기 일반' 등
  color: string; // 차체색
  path: RailPath; // pathPts 구간
  /** 경로 시작점부터 정류장까지 거리(m). */
  stops: { name: string; distance: number }[];
  headwayMin: number;
}

// ───────────────────────── history.json ─────────────────────────

export interface HistoryEvent {
  year: number;
  month?: number;
  title: string;
  description: string;
  category: 'admin' | 'rail' | 'road' | 'housing' | 'landmark' | 'industry' | 'nature' | 'disaster' | 'future';
  status: 'completed' | 'under_construction' | 'planned' | 'demolished' | 'cancelled';
  x?: number;
  z?: number;
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

export interface HistoryEra {
  from: number;
  to: number;
  summary: string;
  population?: number;
}

export interface Landmark {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  y: number; // 라벨 기준 높이(지면 또는 산 정상)
  opened: number; // 0 = 처음부터
  closed: number; // 0 = 현존
  description: string;
  /** 줌 우선순위: 0 = 항상, 1 = 중간 줌부터, 2 = 가까이서만. */
  priority: 0 | 1 | 2;
  sources: string[];
}

export interface HistoryZone {
  id: string;
  name: string;
  kind: string;
  ring: [number, number][]; // 로컬 [x, z]
  beforeKind: string;
  since: number;
  demolition: number;
  constructionStart: number;
  completion: number;
  status: 'completed' | 'under_construction' | 'planned' | 'demolished' | 'cancelled';
  summary: string;
  sources: string[];
}

export interface HistoryFile {
  version: number;
  events: HistoryEvent[];
  eras: HistoryEra[];
  landmarks: Landmark[];
  zones: HistoryZone[];
  /** [연도, 인구] (알려진 값만). */
  population: [number, number][];
  /** 화면 하단 고지에 쓰는 데이터 한계 설명. */
  notes: string[];
}
