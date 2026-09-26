// P1 cellHistory: 셀별 토지피복 3단계 이력(lc0 →y1→ lc1 →y2→ lc2)과 도시화 연도(urbanYear).
//
// 도시화 연도 추정: 셀 위·주변 건물의 착공 연도 → 같은 토지이용 면 안의 최소값 → 가까운 값 번짐(최대 150m) → 행정동 기본 연대.
// 도시화 이전 모습: 저지대·하천 근처는 논, 나머지 밭, 옛 농가 자리는 마을.

import { BF, LC, MASK, RC } from '../../src/data/codes.ts';
import { project } from '../../src/data/geo.ts';
import { areaRings, allRings, wayPoints } from '../lib/osm.ts';
import { fillRings, strokePolyline, fillCircle } from '../lib/raster.ts';
import type { Ring } from '../lib/geom.ts';
import { roadClass } from '../lib/roads.ts';
import { constructionStartOf } from '../../src/data/format.ts';
import { normName } from './buildings.ts';
import type { PipelineContext } from './context.ts';

/** 도시화된(사람이 만든) 피복. */
export const URBAN_LC: ReadonlySet<number> = new Set([
  LC.RESIDENTIAL, LC.COMMERCIAL, LC.INDUSTRIAL, LC.ROAD_MOTORWAY, LC.ROAD_MAJOR, LC.ROAD_MINOR, LC.SIDEWALK,
  LC.PARKING, LC.PLAZA, LC.SCHOOLYARD, LC.SPORTS, LC.RAIL, LC.CONSTRUCTION, LC.CYCLEWAY, LC.PARK, LC.MILITARY,
]);

function districtEra(name: string): number {
  if (name.startsWith('광명')) return 1975;
  if (name.startsWith('철산')) return 1984;
  if (name.startsWith('하안')) return 1988;
  if (name.startsWith('소하')) return 2006;
  if (name.startsWith('일직')) return 2008;
  return 1990;
}

/** 이력 불변식 검사. 위반 시 예외. */
export function checkHistory(a: { lc0: Uint8Array; lc1: Uint8Array; lc2: Uint8Array; y1: Uint16Array; y2: Uint16Array }, yearMin: number, yearMax: number): void {
  for (let k = 0; k < a.lc0.length; k++) {
    const { y1, y2 } = { y1: a.y1[k], y2: a.y2[k] };
    if (y1 === 0 && a.lc1[k] !== a.lc0[k]) throw new Error(`셀 ${k}: y1=0 인데 lc1≠lc0`);
    if (y2 === 0 && a.lc2[k] !== a.lc1[k]) throw new Error(`셀 ${k}: y2=0 인데 lc2≠lc1`);
    if (y1 !== 0 && (y1 < yearMin || y1 > yearMax)) throw new Error(`셀 ${k}: y1=${y1} 범위 밖`);
    if (y2 !== 0 && (y2 < yearMin || y2 > yearMax)) throw new Error(`셀 ${k}: y2=${y2} 범위 밖`);
    if (y1 !== 0 && y2 !== 0 && y1 >= y2) throw new Error(`셀 ${k}: y1=${y1} ≥ y2=${y2}`);
  }
}

export function buildCellHistory(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const N = w * h;
  const cfg = ctx.cfg;
  const ratio = Math.round(g.spec.cell / cfg.subSize);
  const known = new Uint16Array(N); // 도시화 연도(0 = 모름)
  const predYear = new Uint16Array(N); // 옛 건물이 들어선 연도
  const predRemoved = new Uint16Array(N); // 옛 건물 철거 연도
  const village = new Uint8Array(N);
  const setMin = (arr: Uint16Array, k: number, y: number) => {
    if (y > 0 && (arr[k] === 0 || y < arr[k])) arr[k] = y;
  };

  // 1) 건물: 현존 건물은 착공 연도를 발자국과 주변 1칸에, 옛 건물은 별도 층에
  const bArr = { built: new Uint16Array(1), constructStart: new Uint16Array(1) };
  for (const b of ctx.buildings) {
    if (b.flags & BF.OUTSIDE) continue;
    bArr.built[0] = b.built;
    bArr.constructStart[0] = b.constructStart;
    const start = b.built === 0 ? 0 : constructionStartOf(bArr, 0);
    for (const [a0, b0, a1, b1] of b.rects) {
      const i0 = Math.floor(a0 / ratio) - (b.flags & BF.PREDECESSOR ? 0 : 1);
      const j0 = Math.floor(b0 / ratio) - (b.flags & BF.PREDECESSOR ? 0 : 1);
      const i1 = Math.ceil(a1 / ratio) + (b.flags & BF.PREDECESSOR ? 0 : 1);
      const j1 = Math.ceil(b1 / ratio) + (b.flags & BF.PREDECESSOR ? 0 : 1);
      for (let j = Math.max(0, j0); j < Math.min(h, j1); j++)
        for (let i = Math.max(0, i0); i < Math.min(w, i1); i++) {
          const k = j * w + i;
          if (b.flags & BF.PREDECESSOR) {
            if (b.kind === 13 /* FARMHOUSE */) village[k] = 1;
            else {
              setMin(predYear, k, b.built || cfg.yearMin);
              if (b.removed) predRemoved[k] = Math.max(predRemoved[k], b.removed);
            }
          } else if (start) setMin(known, k, Math.max(cfg.yearMin, start));
        }
    }
  }
  // 옛 농가 주변 마당(반경 25m)
  for (const b of ctx.buildings) if (b.flags & BF.PREDECESSOR && b.kind === 13) fillCircle(g.spec, b.cx, b.cz, 25, (i, j) => (village[j * w + i] = 1));

  // 2) 토지이용 면: 면 안의 최소 연도를 면 전체에
  for (const el of ctx.osm.landcover) {
    const lu = el.tags?.landuse ?? el.tags?.amenity ?? el.tags?.leisure;
    if (!lu || ['forest', 'farmland', 'meadow', 'grass', 'orchard', 'greenhouse_horticulture'].includes(lu)) continue;
    const r = areaRings(el);
    if (!r) continue;
    const rings = allRings(r);
    let m = 0;
    const cells: number[] = [];
    fillRings(g.spec, rings, (i, j) => {
      const k = j * w + i;
      cells.push(k);
      const y = known[k];
      if (y && (m === 0 || y < m)) m = y;
    });
    if (m) for (const k of cells) if (!known[k]) known[k] = m;
  }

  // 3) 고속도로: 조사 자료의 개통 연도(이름 매칭)
  const roadYears = ctx.curated.transit.roads.filter((r) => r.opened_year_in_gwangmyeong);
  for (const el of ctx.osm.highways) {
    if (el.type !== 'way') continue;
    const cls = roadClass(el.tags);
    if (cls === null || cls > RC.PRIMARY) continue;
    const nm = normName(`${el.tags?.name ?? ''}${el.tags?.ref ?? ''}${el.tags?.['name:ko'] ?? ''}`);
    if (!nm) continue;
    const hit = roadYears.find((r) => {
      const key = normName(r.name_ko.replace(/\(.*$/, ''));
      return key.length >= 3 && (nm.includes(key) || key.includes(nm));
    });
    if (!hit) continue;
    const y = Math.max(cfg.yearMin, Math.min(cfg.yearMax, hit.opened_year_in_gwangmyeong));
    strokePolyline(g.spec, wayPoints(el), 8, (i, j) => {
      const k = j * w + i;
      if (g.road[k]) known[k] = y;
    });
  }

  // 4) 미래 개발지구(착공 전·공사 중): 비도시 셀이 착공 연도에 공사장이 된다
  const futureZone = new Uint16Array(N);
  for (const z of ctx.curated.zones.zones) {
    if (z.status !== 'planned' && z.status !== 'under_construction') continue;
    if (z.before_kind === 'old_apartments' || z.before_kind === 'lowrise_housing') continue;
    const cs = z.construction_start_year;
    if (!cs || cs > cfg.yearMax) continue;
    const [cx, cz] = project(z.center_lat, z.center_lon);
    const ring: Ring[] = z.polygon && z.polygon.length >= 3 ? [z.polygon.map(([la, lo]) => project(la, lo))] : [];
    const apply = (i: number, j: number) => {
      const k = j * w + i;
      if (g.mask[k] === MASK.CITY) setMin(futureZone, k, Math.max(cfg.yearMin + 1, cs));
    };
    if (ring.length) fillRings(g.spec, ring, apply);
    else fillCircle(g.spec, cx, cz, z.approx_radius_m ?? 300, apply);
  }

  // 5) 번짐: 도시 셀 중 연도를 모르는 셀은 가까운 값으로(최대 30셀 = 150m)
  let frontier: number[] = [];
  for (let k = 0; k < N; k++) if (known[k]) frontier.push(k);
  for (let step = 0; step < 30 && frontier.length; step++) {
    const next: number[] = [];
    for (const k of frontier) {
      const i = k % w;
      const y = known[k];
      const nb = [i > 0 ? k - 1 : -1, i < w - 1 ? k + 1 : -1, k - w, k + w];
      for (const q of nb) {
        if (q < 0 || q >= N || known[q] || g.mask[q] === MASK.VOID || !URBAN_LC.has(g.lcNow[q])) continue;
        known[q] = y;
        next.push(q);
      }
    }
    frontier = next;
  }

  // 6) 단계 결정
  const nearWater = new Uint8Array(N);
  for (let k = 0; k < N; k++) if (g.lcNow[k] === LC.WATER) nearWater[k] = 1;
  const stats = { urban: 0, farmToUrban: 0, redevelop: 0, future: 0, eraDefault: 0, unchanged: 0, greenhouse: 0 };
  for (let k = 0; k < N; k++) {
    const now = g.lcNow[k];
    g.lc0[k] = g.lc1[k] = g.lc2[k] = now;
    g.y1[k] = g.y2[k] = 0;
    if (g.mask[k] === MASK.VOID) continue;
    const pre = village[k] ? LC.VILLAGE : g.height[k] < 25 ? LC.PADDY : LC.FIELD;

    // 산지 공원(도덕산·구름산 등)과 연도를 모르는 공원은 원래부터 녹지로 본다
    const hillPark = now === LC.PARK && (g.height[k] > 40 || !known[k]);
    if (URBAN_LC.has(now) && g.mask[k] === MASK.CITY && !hillPark) {
      stats.urban++;
      let y = known[k];
      if (!y) {
        y = districtEra(g.district[k] !== 255 ? g.districts[g.district[k]].name : '');
        stats.eraDefault++;
      }
      const pY = predYear[k];
      const pR = predRemoved[k];
      if (pY && pR && pR > pY) {
        // 논밭 → (옛 건물) 주거지 → (철거) 현재
        const firstY = Math.max(cfg.yearMin, pY - 1);
        if (firstY > cfg.yearMin) {
          g.lc0[k] = pre;
          g.y1[k] = firstY;
          g.lc1[k] = LC.RESIDENTIAL;
        } else g.lc0[k] = g.lc1[k] = LC.RESIDENTIAL;
        const rY = Math.min(cfg.yearMax, pR);
        if (now !== g.lc1[k] && rY > (g.y1[k] || 0)) {
          g.y2[k] = rY;
          g.lc2[k] = now;
        } else g.lc2[k] = g.lc1[k] = now === LC.CONSTRUCTION ? LC.RESIDENTIAL : g.lc1[k];
        if (g.y1[k] === 0) g.lc1[k] = g.lc0[k];
        if (g.y2[k] === 0) g.lc2[k] = g.lc1[k];
        stats.redevelop++;
      } else if (y > cfg.yearMin) {
        g.lc0[k] = pre;
        g.y1[k] = Math.min(cfg.yearMax, y);
        g.lc1[k] = g.lc2[k] = now;
        stats.farmToUrban++;
      }
      continue;
    }
    // 비도시 셀
    const fz = futureZone[k];
    if (now === LC.GREENHOUSE) {
      g.lc0[k] = LC.FIELD;
      g.y1[k] = 1978 + (k % 13);
      g.lc1[k] = g.lc2[k] = LC.GREENHOUSE;
      stats.greenhouse++;
    }
    if (fz && fz > (g.y1[k] || 0) && (now === LC.GREENHOUSE || now === LC.FIELD || now === LC.PADDY || now === LC.GRASS || now === LC.VILLAGE || now === LC.ORCHARD || now === LC.BARE)) {
      if (g.y1[k] === 0) {
        g.y1[k] = fz;
        g.lc1[k] = g.lc2[k] = LC.CONSTRUCTION;
      } else {
        g.y2[k] = fz;
        g.lc2[k] = LC.CONSTRUCTION;
      }
      stats.future++;
    } else if (g.y1[k] === 0) stats.unchanged++;
    if (village[k] && g.y1[k] === 0 && (now === LC.FIELD || now === LC.PADDY || now === LC.GRASS)) {
      g.lc0[k] = g.lc1[k] = g.lc2[k] = LC.VILLAGE;
    }
  }
  // 여백(시 밖)은 이력 없이 현재 모습만
  for (let k = 0; k < N; k++) if (g.mask[k] === MASK.MARGIN) {
    g.lc0[k] = g.lc1[k] = g.lc2[k] = g.lcNow[k];
    g.y1[k] = g.y2[k] = 0;
  }
  for (let k = 0; k < N; k++) g.urbanYear[k] = g.y2[k] && g.lc1[k] !== LC.RESIDENTIAL ? g.y2[k] : g.y1[k];

  checkHistory(g, cfg.yearMin, cfg.yearMax);
  Object.assign(ctx.stats, {
    hUrban: stats.urban,
    hFarmToUrban: stats.farmToUrban,
    hRedevelop: stats.redevelop,
    hFuture: stats.future,
    hEraDefault: stats.eraDefault,
    hGreenhouse: stats.greenhouse,
  });
  ctx.log(`도시 셀 ${stats.urban}: 논밭→도시 ${stats.farmToUrban}, 재개발 ${stats.redevelop}, 연대 기본값 ${stats.eraDefault}; 미래 공사 ${stats.future}`);
}
