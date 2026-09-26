// P1 landcover: 현재(OSM 기준) 토지피복, 도로·철도·수계 래스터, 도로·수면·도시부 높이 다듬기.
//
// OSM 에 토지피복이 비어 있는 비도시부(시 남부 산지·농경지)는 고도·경사·도시 밀도로 숲/논/밭/비닐하우스를 추정한다.
// 이 추정은 history.json notes 에 밝힌다.

import { LC, MASK, RC } from '../../src/data/codes.ts';
import { areaRings, allRings, wayPoints, type OsmElement } from '../lib/osm.ts';
import { fillRings, strokePolyline, fillCircle } from '../lib/raster.ts';
import { ringArea, type Pt } from '../lib/geom.ts';
import { paintsGround, roadClass, roadWidth } from '../lib/roads.ts';
import { project } from '../../src/data/geo.ts';
import type { PipelineContext } from './context.ts';

/** 면 태그 → 토지피복. 해당 없으면 null. */
export function areaLandCover(tags: Record<string, string> | undefined): number | null {
  if (!tags) return null;
  const lu = tags.landuse;
  const nat = tags.natural;
  const lei = tags.leisure;
  const am = tags.amenity;
  if (nat === 'water' || lu === 'reservoir' || lu === 'basin' || tags.waterway === 'riverbank') return LC.WATER;
  if (nat === 'wood' || lu === 'forest') return LC.FOREST;
  if (nat === 'scrub' || nat === 'heath') return LC.FOREST;
  if (nat === 'grassland' || lu === 'grass' || lu === 'meadow' || lu === 'village_green') return LC.GRASS;
  if (nat === 'wetland') return LC.RIVERBANK;
  if (nat === 'bare_rock' || nat === 'sand') return LC.BARE;
  if (lu === 'farmland') return tags.crop === 'rice' || tags.crop === 'paddy' ? LC.PADDY : LC.FIELD;
  if (lu === 'paddy') return LC.PADDY;
  if (lu === 'greenhouse_horticulture' || lu === 'plant_nursery') return LC.GREENHOUSE;
  if (lu === 'orchard' || lu === 'vineyard') return LC.ORCHARD;
  if (lu === 'residential') return LC.RESIDENTIAL;
  if (lu === 'commercial' || lu === 'retail') return LC.COMMERCIAL;
  if (lu === 'industrial' || lu === 'depot' || lu === 'garages') return LC.INDUSTRIAL;
  if (lu === 'railway') return LC.RAIL;
  if (lu === 'construction' || lu === 'brownfield' || lu === 'greenfield') return LC.CONSTRUCTION;
  if (lu === 'cemetery' || am === 'grave_yard') return LC.CEMETERY;
  if (lu === 'military') return LC.MILITARY;
  if (lu === 'recreation_ground') return LC.PARK;
  if (lu === 'religious') return LC.COMMERCIAL;
  if (lei === 'park' || lei === 'garden' || lei === 'golf_course' || lei === 'nature_reserve' || lei === 'dog_park') return LC.PARK;
  if (lei === 'pitch' || lei === 'track' || lei === 'stadium' || lei === 'sports_centre') return LC.SPORTS;
  if (lei === 'playground') return LC.PLAZA;
  if (am === 'school' || am === 'kindergarten' || am === 'university' || am === 'college') return LC.SCHOOLYARD;
  if (am === 'parking') return LC.PARKING;
  if (am === 'marketplace' || am === 'townhall' || am === 'place_of_worship' || am === 'hospital' || am === 'library' || am === 'community_centre') return LC.COMMERCIAL;
  return null;
}

/** 도로 등급 → 지면 토지피복. */
export function roadLandCover(cls: number): number {
  switch (cls) {
    case RC.MOTORWAY:
      return LC.ROAD_MOTORWAY;
    case RC.TRUNK:
    case RC.PRIMARY:
    case RC.SECONDARY:
      return LC.ROAD_MAJOR;
    case RC.CYCLEWAY:
      return LC.CYCLEWAY;
    case RC.PEDESTRIAN:
      return LC.PLAZA;
    case RC.FOOTWAY:
    case RC.PATH:
    case RC.STEPS:
      return LC.PATH;
    default:
      return LC.ROAD_MINOR;
  }
}

const URBAN: ReadonlySet<number> = new Set([
  LC.RESIDENTIAL, LC.COMMERCIAL, LC.INDUSTRIAL, LC.ROAD_MOTORWAY, LC.ROAD_MAJOR, LC.ROAD_MINOR, LC.SIDEWALK,
  LC.PARKING, LC.PLAZA, LC.SCHOOLYARD, LC.SPORTS, LC.RAIL, LC.CONSTRUCTION,
]);
const ROAD_LC: ReadonlySet<number> = new Set([LC.ROAD_MOTORWAY, LC.ROAD_MAJOR, LC.ROAD_MINOR]);

/** 적분 영상으로 (2r+1)² 상자 평균. */
function boxMean(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const I = new Float64Array((w + 1) * (h + 1));
  for (let j = 0; j < h; j++) {
    let row = 0;
    for (let i = 0; i < w; i++) {
      row += src[j * w + i];
      I[(j + 1) * (w + 1) + i + 1] = I[j * (w + 1) + i + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    const y0 = Math.max(0, j - r);
    const y1 = Math.min(h, j + r + 1);
    for (let i = 0; i < w; i++) {
      const x0 = Math.max(0, i - r);
      const x1 = Math.min(w, i + r + 1);
      const s = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
      out[j * w + i] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

export function buildLandcover(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const N = w * h;
  const lc = g.lcNow;
  for (let k = 0; k < N; k++) lc[k] = g.mask[k] === MASK.VOID ? LC.VOID : LC.GRASS;
  const set = (i: number, j: number, v: number) => {
    const k = j * w + i;
    if (g.mask[k] !== MASK.VOID) lc[k] = v;
  };

  // 1) 면: 큰 것부터 칠해 작은 것이 위에 오게
  const areas: { rings: Pt[][]; lc: number; area: number }[] = [];
  const addArea = (el: OsmElement) => {
    const v = areaLandCover(el.tags);
    if (v === null) return;
    const r = areaRings(el);
    if (!r) return;
    areas.push({ rings: allRings(r), lc: v, area: r.outer.reduce((s, o) => s + ringArea(o), 0) });
  };
  for (const el of ctx.osm.landcover) addArea(el);
  for (const el of ctx.osm.water) if (el.tags?.natural === 'water' || el.tags?.landuse === 'reservoir') addArea(el);
  areas.sort((a, b) => b.area - a.area);
  const mapped = new Uint8Array(N); // OSM 면이 덮은 셀
  for (const a of areas)
    fillRings(g.spec, a.rings, (i, j) => {
      set(i, j, a.lc);
      mapped[j * w + i] = 1;
    });
  ctx.stats.landcoverAreas = areas.length;
  // 수동 보정: 건물로 잘못 그려진 도형을 땅(잔디·광장)으로
  for (const o of ctx.curated.overrides.buildingsToGround) {
    const el = ctx.osm.buildings.find((b) => b.type === 'way' && b.id === o.osmWayId);
    if (!el) throw new Error(`overrides.json: OSM way ${o.osmWayId} 가 buildings 자료에 없습니다`);
    const r = areaRings(el);
    if (!r) throw new Error(`overrides.json: way ${o.osmWayId} 가 닫힌 면이 아닙니다`);
    const v = LC[o.landcover];
    fillRings(g.spec, allRings(r), (i, j) => {
      set(i, j, v);
      mapped[j * w + i] = 1;
    });
  }

  // 2) 하천 선: 면으로 안 그려진 물길을 폭대로
  const isWaterway = new Uint8Array(N);
  for (const el of ctx.osm.water) {
    if (el.type !== 'way') continue;
    const ww = el.tags?.waterway;
    if (!ww || el.tags?.tunnel === 'culvert' || el.tags?.tunnel === 'yes') continue;
    const width = ww === 'river' ? 40 : ww === 'stream' ? 7 : ww === 'canal' ? 8 : ww === 'ditch' || ww === 'drain' ? 3 : 0;
    if (!width) continue;
    strokePolyline(g.spec, wayPoints(el), width / 2, (i, j) => {
      set(i, j, LC.WATER);
      isWaterway[j * w + i] = 1;
    });
  }

  // 3) 비어 있는 비도시부 추정: 도시 밀도(반경 약 75m 안 도시 셀 비율), 고도, 경사
  const urbanF = new Float32Array(N);
  for (let k = 0; k < N; k++) urbanF[k] = URBAN.has(lc[k]) ? 1 : 0;
  // 건물이 있는 곳도 도시로 본다(주거지 면이 없는 저층 주택가 대비)
  for (const el of ctx.osm.buildings) {
    const r = areaRings(el);
    if (r) fillRings(g.spec, allRings(r), (i, j) => (urbanF[j * w + i] = 1));
  }
  const density = boxMean(urbanF, w, h, 15);
  const hs = boxMean(g.height, w, h, 2);
  const greenhouseZones = ctx.curated.zones.zones.filter((z) => z.before_kind === 'greenhouse' || z.id === 'gb-greenhouse-belt');
  const inGreenhouseZone = new Uint8Array(N);
  for (const z of greenhouseZones) {
    const [cx, cz] = project(z.center_lat, z.center_lon);
    fillCircle(g.spec, cx, cz, z.approx_radius_m ?? 500, (i, j) => (inGreenhouseZone[j * w + i] = 1));
  }
  // 하천 가까움(논 판단용): 물 셀에서 150m 이내
  const nearWater = boxMean(new Float32Array(Array.from(lc, (v) => (v === LC.WATER ? 1 : 0))), w, h, 30);
  let guessed = 0;
  for (let j = 1; j < h - 1; j++)
    for (let i = 1; i < w - 1; i++) {
      const k = j * w + i;
      if (lc[k] !== LC.GRASS || mapped[k] || g.mask[k] === MASK.VOID) continue;
      if (density[k] > 0.25) continue; // 도시 속 빈터는 풀밭으로 둔다
      const slope = Math.hypot(hs[k + 1] - hs[k - 1], hs[k + w] - hs[k - w]) / (2 * g.spec.cell);
      const hgt = g.height[k];
      let v: number;
      if (hgt > 70 || slope > 0.12 || (hgt > 45 && slope > 0.06)) v = LC.FOREST;
      else if (inGreenhouseZone[k] && slope < 0.05) v = j % 4 < 2 && (Math.floor(i / 12) + Math.floor(j / 8)) % 5 !== 0 ? LC.GREENHOUSE : LC.FIELD; // 동서로 긴 하우스 줄
      else if (nearWater[k] > 0.002 && hgt < 30 && slope < 0.03) v = LC.PADDY;
      else v = LC.FIELD;
      lc[k] = v;
      guessed++;
    }
  ctx.stats.landcoverGuessedCells = guessed;

  // 4) 철도(지상): 선로 way 마다 약 5m 띠
  for (const el of ctx.osm.railways) {
    if (el.type !== 'way') continue;
    const rw = el.tags?.railway;
    if (rw !== 'rail' && rw !== 'subway' && rw !== 'light_rail') continue;
    if (!paintsGround(el.tags)) continue;
    strokePolyline(g.spec, wayPoints(el), 2.5, (i, j) => set(i, j, LC.RAIL));
  }

  // 5) 도로(지상만). 등급이 높은(숫자가 작은) 도로가 이긴다. 셀별로 도로를 따라 다듬은 높이를 모은다.
  const roadH = new Float32Array(N).fill(NaN);
  const roadDist = new Float32Array(N).fill(Infinity);
  const walks: { pts: Pt[]; hw: number }[] = [];
  const roads = ctx.osm.highways
    .filter((el) => el.type === 'way')
    .map((el) => ({ el, cls: roadClass(el.tags) }))
    .filter((r): r is { el: typeof r.el; cls: number } => r.cls !== null && paintsGround(r.el.tags) && r.el.tags?.service !== 'parking_aisle')
    .sort((a, b) => b.cls - a.cls); // 낮은 등급 먼저 칠하고 높은 등급이 덮는다
  for (const { el, cls } of roads) {
    const pts = wayPoints(el);
    if (pts.length < 2) continue;
    const hw = roadWidth(el.tags, cls) / 2;
    const v = roadLandCover(cls);
    const isFoot = v === LC.PATH;
    // 도로 중심선 높이를 5m 간격으로 뽑아 ±20m 이동 평균
    const cum: number[] = [0];
    for (let s = 1; s < pts.length; s++) cum.push(cum[s - 1] + Math.hypot(pts[s][0] - pts[s - 1][0], pts[s][1] - pts[s - 1][1]));
    const total = cum[cum.length - 1];
    const nS = Math.max(2, Math.ceil(total / 5) + 1);
    const samp = new Float32Array(nS);
    for (let q = 0; q < nS; q++) {
      const d = (q / (nS - 1)) * total;
      let s = 1;
      while (s < cum.length - 1 && cum[s] < d) s++;
      const t = cum[s] === cum[s - 1] ? 0 : (d - cum[s - 1]) / (cum[s] - cum[s - 1]);
      const x = pts[s - 1][0] + (pts[s][0] - pts[s - 1][0]) * t;
      const z = pts[s - 1][1] + (pts[s][1] - pts[s - 1][1]) * t;
      const ci = Math.min(w - 1, Math.max(0, Math.floor((x - g.spec.x0) / g.spec.cell)));
      const cj = Math.min(h - 1, Math.max(0, Math.floor((z - g.spec.z0) / g.spec.cell)));
      samp[q] = g.height[cj * w + ci];
    }
    const smooth = new Float32Array(nS);
    for (let q = 0; q < nS; q++) {
      let s = 0;
      let c = 0;
      for (let r = Math.max(0, q - 4); r <= Math.min(nS - 1, q + 4); r++) {
        s += samp[r];
        c++;
      }
      smooth[q] = s / c;
    }
    strokePolyline(g.spec, pts, hw, (i, j, dist, seg, t) => {
      const k = j * w + i;
      if (g.mask[k] === MASK.VOID) return;
      if (isFoot) {
        // 보행로는 공원·숲·풀밭에서만 보이게 칠한다(도시 포장면 위에는 이미 보도·광장이 있다)
        if (lc[k] === LC.FOREST || lc[k] === LC.PARK || lc[k] === LC.GRASS || lc[k] === LC.RIVERBANK || lc[k] === LC.FIELD) lc[k] = LC.PATH;
        return;
      }
      const prev = g.road[k];
      if (prev !== 0 && prev - 1 < cls && ROAD_LC.has(lc[k])) return;
      lc[k] = v;
      if (v !== LC.CYCLEWAY && v !== LC.PLAZA) g.road[k] = cls + 1;
      if (dist < roadDist[k]) {
        roadDist[k] = dist;
        const d = cum[seg] + t * (cum[seg + 1] - cum[seg]);
        roadH[k] = smooth[Math.min(nS - 1, Math.round((d / (total || 1)) * (nS - 1)))];
      }
    });
    if (cls >= RC.PRIMARY && cls <= RC.RESIDENTIAL) walks.push({ pts, hw });
  }

  // 6) 보도: 도시부 간선·이면도로 양옆 3m
  for (const { pts, hw } of walks)
    strokePolyline(
      g.spec,
      pts,
      hw + 3,
      (i, j, dist) => {
        const k = j * w + i;
        if (dist <= hw || g.road[k] !== 0) return;
        const v = lc[k];
        if ((v === LC.RESIDENTIAL || v === LC.COMMERCIAL || v === LC.INDUSTRIAL || v === LC.GRASS || v === LC.PARKING) && density[k] > 0.25) lc[k] = LC.SIDEWALK;
      },
      false,
    );

  // 7) 둔치: 큰 하천(안양천·목감천) 수면 옆 40m 의 풀밭·밭 → 둔치
  const riverWater = new Float32Array(N);
  for (let k = 0; k < N; k++) riverWater[k] = lc[k] === LC.WATER ? 1 : 0;
  const nearRiver = boxMean(riverWater, w, h, 8);
  for (let k = 0; k < N; k++) {
    const v = lc[k];
    if ((v === LC.GRASS || v === LC.FIELD || v === LC.PADDY) && nearRiver[k] > 0.12) lc[k] = LC.RIVERBANK;
  }

  // 8) 높이 다듬기: 도시부는 넓게 평균(레이더 고도의 건물 영향 제거), 도로는 도로를 따라 다듬은 값, 수면은 주변 최저로 평탄
  const urbanNow = new Float32Array(N);
  for (let k = 0; k < N; k++) urbanNow[k] = URBAN.has(lc[k]) ? 1 : 0;
  const dens = boxMean(urbanNow, w, h, 10);
  const wide = boxMean(g.height, w, h, 6);
  for (let k = 0; k < N; k++) {
    const t = Math.min(1, Math.max(0, (dens[k] - 0.2) / 0.4));
    g.height[k] = g.height[k] * (1 - t) + wide[k] * t;
  }
  for (let k = 0; k < N; k++) if (!Number.isNaN(roadH[k])) g.height[k] = roadH[k] * 0.7 + g.height[k] * 0.3;
  // 수면: 7×7 창의 최저 높이 − 1m (강둑보다 낮게)
  const water = new Uint8Array(N);
  for (let k = 0; k < N; k++) water[k] = lc[k] === LC.WATER ? 1 : 0;
  const hNew = g.height.slice();
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      if (!water[k]) continue;
      let m = Infinity;
      for (let dj = -3; dj <= 3; dj++)
        for (let di = -3; di <= 3; di++) {
          const x = i + di;
          const y = j + dj;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          m = Math.min(m, g.height[y * w + x]);
        }
      hNew[k] = Math.max(0, m - 1);
    }
  g.height.set(hNew);

  const counts: Record<number, number> = {};
  for (let k = 0; k < N; k++) if (g.mask[k] === MASK.CITY) counts[lc[k]] = (counts[lc[k]] ?? 0) + 1;
  for (const [code, n] of Object.entries(counts)) ctx.stats[`lc_${code}`] = n;
  ctx.log(`면 ${areas.length}개, 추정 셀 ${guessed}, 도로 way ${roads.length}`);
}
