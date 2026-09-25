// Overpass JSON(out body geom) 읽기와 멀티폴리곤 링 조립.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from '../../src/data/geo.ts';
import { signedArea, type Pt, type Ring } from './geom.ts';

export type Tags = Record<string, string>;
export interface LatLon {
  lat: number;
  lon: number;
}
export interface OsmNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Tags;
}
export interface OsmWay {
  type: 'way';
  id: number;
  nodes?: number[];
  geometry?: (LatLon | null)[];
  tags?: Tags;
}
export interface OsmMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  lat?: number;
  lon?: number;
  geometry?: (LatLon | null)[];
}
export interface OsmRelation {
  type: 'relation';
  id: number;
  members: OsmMember[];
  tags?: Tags;
}
export type OsmElement = OsmNode | OsmWay | OsmRelation;

export const LAYER_NAMES = ['boundary', 'districts', 'buildings', 'highways', 'railways', 'routes', 'water', 'landcover', 'pois'] as const;
export type LayerName = (typeof LAYER_NAMES)[number];

export function loadLayer(rawDir: string, name: LayerName): OsmElement[] {
  const file = join(rawDir, `${name}.json`);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new Error(`${file} 없음 — 먼저 npm run data:fetch 를 실행하세요`);
  }
  const json = JSON.parse(text) as { elements?: OsmElement[] };
  if (!Array.isArray(json.elements)) throw new Error(`${file}: elements 배열 없음`);
  return json.elements;
}

/** geometry(경위도 목록)를 로컬 좌표로. null(누락 노드)은 건너뛴다. */
export function projectGeometry(geom: readonly (LatLon | null)[] | undefined): Pt[] {
  const out: Pt[] = [];
  if (!geom) return out;
  for (const g of geom) if (g) out.push(project(g.lat, g.lon));
  return out;
}

export function wayPoints(w: OsmWay): Pt[] {
  return projectGeometry(w.geometry);
}

const same = (a: Pt, b: Pt, tol: number) => Math.abs(a[0] - b[0]) <= tol && Math.abs(a[1] - b[1]) <= tol;

/** 열린 선분 조각들을 끝점을 이어 닫힌 링으로 조립한다. 닫히지 않는 조각은 버린다. */
export function assembleRings(parts: readonly Pt[][], tol = 0.05): Ring[] {
  const pool = parts.filter((p) => p.length >= 2).map((p) => p.slice());
  const rings: Ring[] = [];
  while (pool.length) {
    let cur = pool.pop()!;
    let guard = 0;
    while (!same(cur[0], cur[cur.length - 1], tol) && guard++ < 10000) {
      const end = cur[cur.length - 1];
      let found = -1;
      let reverse = false;
      for (let i = 0; i < pool.length; i++) {
        if (same(pool[i][0], end, tol)) {
          found = i;
          break;
        }
        if (same(pool[i][pool[i].length - 1], end, tol)) {
          found = i;
          reverse = true;
          break;
        }
      }
      if (found < 0) break;
      const next = pool.splice(found, 1)[0];
      if (reverse) next.reverse();
      cur = cur.concat(next.slice(1));
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1], tol)) {
      cur.pop(); // 닫는 점 중복 제거
      rings.push(cur);
    }
  }
  return rings;
}

export interface AreaRings {
  outer: Ring[];
  inner: Ring[];
}

/** 닫힌 way 또는 multipolygon/boundary relation 을 바깥·안쪽 링으로. 면이 아니면 null. */
export function areaRings(el: OsmElement): AreaRings | null {
  if (el.type === 'way') {
    const pts = wayPoints(el);
    if (pts.length < 4 || !same(pts[0], pts[pts.length - 1], 0.01)) return null;
    pts.pop();
    return { outer: [pts], inner: [] };
  }
  if (el.type === 'relation') {
    const t = el.tags?.type;
    if (t !== 'multipolygon' && t !== 'boundary') return null;
    const outerParts: Pt[][] = [];
    const innerParts: Pt[][] = [];
    for (const m of el.members) {
      if (m.type !== 'way' || !m.geometry) continue;
      const pts = projectGeometry(m.geometry);
      if (m.role === 'inner') innerParts.push(pts);
      else if (m.role === 'outer' || m.role === '') outerParts.push(pts);
    }
    const outer = assembleRings(outerParts);
    if (!outer.length) return null;
    return { outer, inner: assembleRings(innerParts) };
  }
  return null;
}

/** 링들을 [바깥, 구멍...] 짝홀 규칙용 한 배열로. */
export function allRings(a: AreaRings): Ring[] {
  return [...a.outer, ...a.inner];
}

/** 링 방향을 시계 방향(양의 signedArea)으로 맞춘 복사본. */
export function clockwise(ring: Ring): Ring {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring.slice();
}

export function tag(el: OsmElement, key: string): string | undefined {
  return el.tags?.[key];
}

/** "15", "15;20", "약 12" 같은 값에서 첫 숫자. 없으면 NaN. */
export function numTag(el: OsmElement, key: string): number {
  const v = el.tags?.[key];
  if (!v) return NaN;
  const m = /-?\d+(\.\d+)?/.exec(v);
  return m ? Number(m[0]) : NaN;
}

/** start_date 류("1994", "1994-05", "~1990", "1990s")에서 연도. 없으면 0. */
export function yearTag(el: OsmElement, ...keys: string[]): number {
  for (const k of keys) {
    const v = el.tags?.[k];
    if (!v) continue;
    const m = /(1[89]\d\d|20\d\d)/.exec(v);
    if (m) return Number(m[1]);
  }
  return 0;
}
