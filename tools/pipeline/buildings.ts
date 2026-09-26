// P2 buildings: OSM 건물 → 종류·층수·연도·배색, 철거된 옛 건물(개발지구 자료), OSM 공백 절차 생성.
//
// 연도 우선순위: OSM start_date → 조사 자료 단지명 매칭 → 개발지구 연도 → 주변 준공 연도 중앙값 → 행정동 기본 연대.
// 절차 생성·옛 건물은 flags 로 표시해 화면에서 "추정"임을 밝힌다.

import { BF, BK, LANDMARK_PALETTE, LC, MASK, ROOF, YEAR_SRC } from '../../src/data/codes.ts';
import { project } from '../../src/data/geo.ts';
import { areaRings, allRings, numTag, yearTag, type OsmElement } from '../lib/osm.ts';
import { fillRings, greedyRects, type GridSpec } from '../lib/raster.ts';
import { pointInRings, ringArea, ringCentroid, type Ring } from '../lib/geom.ts';
import { hash2, type BuildingRec, type PipelineContext } from './context.ts';
import type { CuratedZone } from './curated.ts';

const FLOOR_H = 3;

/** 이름 비교용 정규화: 공백·괄호·특수문자 제거. */
export const normName = (s: string) => s.replace(/\(.*?\)/g, '').replace(/[\s·.,&\-_'"]/g, '').toLowerCase();

/** OSM building 태그 등으로 종류를 정한다. landLc 는 건물 중심의 현재 토지피복. */
export function classifyBuilding(tags: Record<string, string>, levels: number, footprintM2: number, landLc: number): number {
  const b = tags.building;
  const name = tags.name ?? '';
  if (/이케아|ikea|코스트코|costco|아울렛|outlet|롯데몰/i.test(name)) return BK.BIGBOX;
  switch (b) {
    case 'apartments':
      return levels > 0 && levels <= 5 && footprintM2 < 400 ? BK.VILLA : BK.APARTMENT;
    case 'house':
    case 'detached':
    case 'bungalow':
      return BK.HOUSE;
    case 'semidetached_house':
    case 'terrace':
    case 'dormitory':
      return BK.VILLA;
    case 'residential':
      if (levels >= 7) return BK.APARTMENT;
      return levels >= 3 || footprintM2 > 150 ? BK.VILLA : BK.HOUSE;
    case 'commercial':
    case 'retail':
    case 'hotel':
    case 'kiosk':
    case 'supermarket':
      return footprintM2 > 6000 ? BK.BIGBOX : BK.COMMERCIAL;
    case 'office':
      return BK.OFFICE;
    case 'industrial':
    case 'warehouse':
    case 'factory':
    case 'manufacture':
    case 'hangar':
      return BK.INDUSTRIAL;
    case 'school':
    case 'kindergarten':
    case 'university':
    case 'college':
      return BK.SCHOOL;
    case 'public':
    case 'government':
    case 'civic':
    case 'fire_station':
    case 'police':
      return BK.PUBLIC;
    case 'church':
    case 'chapel':
    case 'cathedral':
    case 'temple':
    case 'mosque':
    case 'shrine':
    case 'religious':
      return BK.RELIGIOUS;
    case 'train_station':
    case 'transportation':
      return BK.STATION;
    case 'hospital':
      return BK.HOSPITAL;
    case 'greenhouse':
      return BK.GREENHOUSE;
    case 'farm':
    case 'barn':
    case 'farm_auxiliary':
    case 'shed':
      return BK.FARMHOUSE;
    case 'parking':
      return BK.PARKING;
  }
  if (tags.amenity === 'place_of_worship') return BK.RELIGIOUS;
  if (tags.amenity === 'school' || tags.amenity === 'kindergarten') return BK.SCHOOL;
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic') return BK.HOSPITAL;
  if (tags.shop) return BK.COMMERCIAL;
  // building=yes 등: 주변 토지피복으로
  switch (landLc) {
    case LC.RESIDENTIAL:
      return levels >= 7 ? BK.APARTMENT : levels >= 3 || footprintM2 > 150 ? BK.VILLA : BK.HOUSE;
    case LC.COMMERCIAL:
    case LC.PLAZA:
    case LC.PARKING:
      return BK.COMMERCIAL;
    case LC.INDUSTRIAL:
      return BK.INDUSTRIAL;
    case LC.SCHOOLYARD:
      return BK.SCHOOL;
    case LC.GREENHOUSE:
      return BK.GREENHOUSE;
    case LC.FIELD:
    case LC.PADDY:
    case LC.ORCHARD:
    case LC.FOREST:
      return footprintM2 > 400 ? BK.INDUSTRIAL : BK.FARMHOUSE;
  }
  return levels >= 7 ? BK.APARTMENT : footprintM2 > 1500 ? BK.INDUSTRIAL : BK.COMMERCIAL;
}

export const DEFAULT_FLOORS: Record<number, number> = {
  [BK.APARTMENT]: 15, [BK.VILLA]: 4, [BK.HOUSE]: 2, [BK.COMMERCIAL]: 4, [BK.OFFICE]: 8, [BK.INDUSTRIAL]: 2,
  [BK.SCHOOL]: 4, [BK.PUBLIC]: 4, [BK.RELIGIOUS]: 3, [BK.STATION]: 3, [BK.HOSPITAL]: 7, [BK.BIGBOX]: 4,
  [BK.GREENHOUSE]: 1, [BK.FARMHOUSE]: 1, [BK.PARKING]: 4, [BK.OTHER]: 2,
};

export function roofFor(kind: number, h: number): number {
  switch (kind) {
    case BK.VILLA:
      return h < 0.75 ? ROOF.GREEN_TOP : ROOF.FLAT;
    case BK.HOUSE:
    case BK.FARMHOUSE:
    case BK.RELIGIOUS:
      return ROOF.GABLE;
    case BK.APARTMENT:
      return ROOF.TANK_TOP;
    case BK.INDUSTRIAL:
      return h < 0.35 ? ROOF.SAWTOOTH : ROOF.FLAT;
    case BK.GREENHOUSE:
      return ROOF.DOME;
    default:
      return ROOF.FLAT;
  }
}

/** 행정동별 기본 연대(추정). 주변에 준공 연도가 있는 건물이 없을 때만 쓴다. */
function districtEra(name: string): number {
  if (name.startsWith('광명')) return 1980;
  if (name.startsWith('철산')) return 1986;
  if (name.startsWith('하안')) return 1990;
  if (name.startsWith('소하')) return 2008;
  if (name.startsWith('일직')) return 2015;
  return 1985;
}

interface Shape {
  rings: Ring[];
  outer: Ring[];
  cx: number;
  cz: number;
  area: number;
}

export function buildBuildings(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const cfg = ctx.cfg;
  const ratio = Math.round(g.spec.cell / cfg.subSize);
  const sub: GridSpec = { w: w * ratio, h: h * ratio, x0: g.spec.x0, z0: g.spec.z0, cell: cfg.subSize };
  const occ = new Uint8Array(sub.w * sub.h); // 세부 격자 점유(OSM 건물, 필지 채우기 회피용)
  const occYear = new Uint16Array(sub.w * sub.h); // 점유한 OSM 건물의 준공 연도(1 = 1960 이전부터)
  const out: BuildingRec[] = [];
  const cellAt = (x: number, z: number) => {
    const i = Math.floor((x - g.spec.x0) / g.spec.cell);
    const j = Math.floor((z - g.spec.z0) / g.spec.cell);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };

  /** 링을 세부 격자에 래스터화해 사각형과 바닥 높이를 구한다. */
  const rasterize = (rings: Ring[], cx: number, cz: number) => {
    let minI = Infinity;
    let minJ = Infinity;
    let maxI = -Infinity;
    let maxJ = -Infinity;
    const cells: number[] = [];
    fillRings(sub, rings, (i, j) => {
      cells.push(i, j);
      if (i < minI) minI = i;
      if (j < minJ) minJ = j;
      if (i > maxI) maxI = i;
      if (j > maxJ) maxJ = j;
    });
    if (!cells.length) {
      const i = Math.floor((cx - sub.x0) / sub.cell);
      const j = Math.floor((cz - sub.z0) / sub.cell);
      if (i < 0 || j < 0 || i >= sub.w || j >= sub.h) return null;
      cells.push(i, j);
      minI = maxI = i;
      minJ = maxJ = j;
    }
    const bw = maxI - minI + 1;
    const bh = maxJ - minJ + 1;
    const m = new Uint8Array(bw * bh);
    for (let q = 0; q < cells.length; q += 2) m[(cells[q + 1] - minJ) * bw + (cells[q] - minI)] = 1;
    const rects = greedyRects(m, bw, bh).map(([a, b, c, d]) => [a + minI, b + minJ, c + minI, d + minJ] as [number, number, number, number]);
    return { rects, cells };
  };
  const baseOf = (cells: number[]) => {
    let lo = Infinity;
    for (let q = 0; q < cells.length; q += 2) {
      const k = Math.floor(cells[q + 1] / ratio) * w + Math.floor(cells[q] / ratio);
      if (k >= 0 && k < w * h) lo = Math.min(lo, g.height[k]);
    }
    return Number.isFinite(lo) ? lo : 0;
  };
  const markOcc = (rects: [number, number, number, number][], pad: number) => {
    for (const [a, b, c, d] of rects)
      for (let j = Math.max(0, b - pad); j < Math.min(sub.h, d + pad); j++)
        for (let i = Math.max(0, a - pad); i < Math.min(sub.w, c + pad); i++) occ[j * sub.w + i] = 1;
  };
  const districtName = (k: number) => (k >= 0 && g.district[k] !== 255 ? g.districts[g.district[k]].name : '');

  // ── 개발지구 모양: 후속 단지 이름과 같은 OSM 주거지 면이 있으면 그 면, 없으면 원 ──
  const namedResidential: { name: string; rings: Ring[]; outer: Ring[] }[] = [];
  for (const el of ctx.osm.landcover) {
    if (el.tags?.landuse !== 'residential' || !el.tags?.name) continue;
    const r = areaRings(el);
    if (r) namedResidential.push({ name: el.tags.name, rings: allRings(r), outer: r.outer });
  }
  const zoneShape = (z: CuratedZone): Ring[] => {
    const wanted = (z.successor_names ?? []).map(normName).filter((s) => s.length >= 3);
    const hits = namedResidential.filter((r) => wanted.some((s) => normName(r.name).includes(s) || s.includes(normName(r.name))));
    if (hits.length) return hits.flatMap((r) => r.rings);
    if (z.polygon && z.polygon.length >= 3) return [z.polygon.map(([lat, lon]) => project(lat, lon))];
    const [cx, cz] = project(z.center_lat, z.center_lon);
    const r = z.approx_radius_m ?? 200;
    const ring: Ring = [];
    for (let a = 0; a < 24; a++) ring.push([cx + Math.cos((a / 24) * Math.PI * 2) * r, cz + Math.sin((a / 24) * Math.PI * 2) * r]);
    return [ring];
  };
  const zones = ctx.curated.zones.zones.map((z) => ({ z, rings: zoneShape(z) }));

  // ── 1) OSM 건물 ──
  const complexOf = (x: number, z: number) => namedResidential.find((r) => pointInRings(x, z, r.rings))?.name ?? null;
  const shapes: { el: OsmElement; s: Shape }[] = [];
  for (const el of ctx.osm.buildings) {
    const t = el.tags ?? {};
    if (t.building === 'roof' || t.building === 'ruins' || t['building:part']) continue;
    const r = areaRings(el);
    if (!r) continue;
    const biggest = r.outer.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
    const [cx, cz] = ringCentroid(biggest);
    const k = cellAt(cx, cz);
    if (k < 0 || g.mask[k] === MASK.VOID) continue;
    shapes.push({ el, s: { rings: allRings(r), outer: r.outer, cx, cz, area: r.outer.reduce((s, o) => s + ringArea(o), 0) } });
  }
  // 준공 연도가 있는 건물 목록(주변 추정용)
  const dated: { x: number; z: number; y: number; tall: boolean }[] = [];
  for (const { el, s } of shapes) {
    const y = yearTag(el, 'start_date', 'construction_date', 'opening_date');
    if (y >= 1900 && y <= cfg.yearMax) dated.push({ x: s.cx, z: s.cz, y, tall: numTag(el, 'building:levels') >= 7 });
  }
  const bucket = new Map<string, typeof dated>();
  const bkey = (x: number, z: number) => `${Math.floor(x / 250)},${Math.floor(z / 250)}`;
  for (const d of dated) {
    const key = bkey(d.x, d.z);
    if (!bucket.has(key)) bucket.set(key, []);
    bucket.get(key)!.push(d);
  }
  const nearbyYear = (x: number, z: number, tall: boolean): number => {
    const ys: number[] = [];
    const bx = Math.floor(x / 250);
    const bz = Math.floor(z / 250);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const d of bucket.get(`${bx + dx},${bz + dz}`) ?? []) if (d.tall === tall && (d.x - x) ** 2 + (d.z - z) ** 2 < 300 ** 2) ys.push(d.y);
    if (ys.length < 3) return 0;
    ys.sort((a, b) => a - b);
    return ys[Math.floor(ys.length / 2)];
  };
  const zoneAt = (x: number, z: number, pred: (zz: CuratedZone) => boolean) => zones.find(({ z: zz, rings }) => pred(zz) && pointInRings(x, z, rings))?.z;
  const zoneByName = (name: string) => {
    const n = normName(name);
    if (n.length < 3) return undefined;
    return ctx.curated.zones.zones.find((z) => (z.successor_names ?? []).some((s) => normName(s).length >= 3 && (n.includes(normName(s)) || normName(s).includes(n))));
  };

  const stat = { osm: 0, outside: 0, byOsmYear: 0, byCurated: 0, byZone: 0, byInferred: 0, predecessor: 0, procedural: 0, greenhouse: 0, farmhouse: 0 };
  for (const { el, s } of shapes) {
    const t = el.tags ?? {};
    const k = cellAt(s.cx, s.cz);
    const outside = g.mask[k] === MASK.MARGIN;
    let levels = numTag(el, 'building:levels');
    const hTag = numTag(el, 'height');
    const kind = classifyBuilding(t, Number.isFinite(levels) ? levels : 0, s.area, g.lcNow[k]);
    if (!Number.isFinite(levels) || levels <= 0) levels = Number.isFinite(hTag) ? Math.max(1, Math.round(hTag / FLOOR_H)) : DEFAULT_FLOORS[kind];
    levels = Math.min(80, Math.max(1, Math.round(levels)));
    const heightM = Number.isFinite(hTag) && hTag > 2 ? hTag : kind === BK.GREENHOUSE ? 3.5 : kind === BK.BIGBOX || kind === BK.INDUSTRIAL ? levels * 5 : levels * FLOOR_H + (kind === BK.HOUSE || kind === BK.FARMHOUSE ? 1.5 : 0.5);
    const complex = complexOf(s.cx, s.cz);
    let name = t.name ?? null;
    if (complex && (!name || /^\d+\s*동?$/.test(name))) name = name ? `${complex} ${name.replace(/동?$/, '동')}` : complex;

    // 연도
    let built = yearTag(el, 'start_date', 'construction_date', 'opening_date');
    let src: number = YEAR_SRC.OSM;
    let constructStart = 0;
    let flags = outside ? BF.OUTSIDE : 0;
    if (!built) {
      const z1 = (name && zoneByName(name)) || (complex && zoneByName(complex)) || undefined;
      if (z1?.completion_year) {
        built = z1.completion_year;
        constructStart = z1.construction_start_year ?? 0;
        src = YEAR_SRC.CURATED;
      }
    }
    if (!built && (kind === BK.APARTMENT || t.building === 'construction')) {
      const z2 = zoneAt(s.cx, s.cz, (zz) => !!zz.completion_year && zz.status !== 'cancelled' && zz.kind !== 'other');
      if (z2?.completion_year) {
        built = z2.completion_year;
        constructStart = z2.construction_start_year ?? 0;
        src = YEAR_SRC.ZONE;
      }
    }
    if (!built) {
      const ny = nearbyYear(s.cx, s.cz, kind === BK.APARTMENT);
      const spread = Math.floor(hash2(Math.round(s.cx), Math.round(s.cz), 7) * 9) - 4;
      built = ny ? ny + (kind === BK.APARTMENT ? 0 : spread) : districtEra(districtName(k)) + spread;
      if (kind === BK.FARMHOUSE) built = 0; // 농가는 타임라인 시작 전부터 있던 것으로 본다
      src = YEAR_SRC.INFERRED;
    }
    if (t.building === 'construction' && built <= cfg.yearNow) built = cfg.yearNow + 1;
    if (built > cfg.yearNow) flags |= BF.PLANNED;
    built = Math.min(built, cfg.yearMax);

    const ras = rasterize(s.rings, s.cx, s.cz);
    if (!ras) continue;
    markOcc(ras.rects, 1);
    for (const [a, b, c, d] of ras.rects)
      for (let j = b; j < d; j++) for (let i = a; i < c; i++) occYear[j * sub.w + i] = built === 0 ? 1 : built;
    const hsh = hash2(Math.round(s.cx), Math.round(s.cz), 3);
    out.push({
      osmId: el.id,
      osmType: el.type === 'way' ? 1 : 2,
      kind,
      floors: levels,
      heightM,
      baseM: baseOf(ras.cells),
      built,
      removed: 0,
      constructStart,
      yearSource: src,
      palette: Math.floor(hsh * 256),
      roof: roofFor(kind, hash2(Math.round(s.cx), Math.round(s.cz), 11)),
      flags,
      name,
      cx: s.cx,
      cz: s.cz,
      rects: ras.rects,
    });
    stat.osm++;
    if (outside) stat.outside++;
    if (src === YEAR_SRC.OSM) stat.byOsmYear++;
    else if (src === YEAR_SRC.CURATED) stat.byCurated++;
    else if (src === YEAR_SRC.ZONE) stat.byZone++;
    else stat.byInferred++;
  }

  // ── 2) 랜드마크 배색: 조사 자료 좌표를 포함하거나 가장 가까운 큰 건물 ──
  const LM: [RegExp, number][] = [
    [/이케아/, LANDMARK_PALETTE.IKEA],
    [/코스트코/, LANDMARK_PALETTE.COSTCO],
    [/롯데.*아울렛/, LANDMARK_PALETTE.LOTTE_OUTLET],
    [/^광명역$|KTX 광명역/, LANDMARK_PALETTE.KTX_STATION],
    [/광명시청/, LANDMARK_PALETTE.CITY_HALL],
    [/스피돔/, LANDMARK_PALETTE.SPEEDOME],
    [/기아/, LANDMARK_PALETTE.KIA_PLANT],
  ];
  let landmarkCount = 0;
  for (const lm of ctx.curated.landmarks.landmarks) {
    const hit = LM.find(([re]) => re.test(lm.name_ko));
    if (!hit) continue;
    const [lx, lz] = project(lm.lat, lm.lon);
    const radius = hit[1] === LANDMARK_PALETTE.KIA_PLANT ? 500 : 200;
    const cands = out.filter((b) => !(b.flags & BF.OUTSIDE) && (b.cx - lx) ** 2 + (b.cz - lz) ** 2 < radius ** 2);
    const size = (b: BuildingRec) => b.rects.reduce((s, [a, c, d, e]) => s + (d - a) * (e - c), 0);
    // 기아 공장은 반경 안 큰 공장 건물 모두, 나머지는 가장 큰 건물 하나(이름이 맞으면 우선)
    const picked =
      hit[1] === LANDMARK_PALETTE.KIA_PLANT
        ? cands.filter((b) => b.kind === BK.INDUSTRIAL && size(b) > 200)
        : [cands.find((b) => b.name && hit[0].test(b.name)) ?? cands.sort((a, b) => size(b) - size(a))[0]].filter(Boolean);
    for (const b of picked as BuildingRec[]) {
      b.flags |= BF.LANDMARK;
      b.palette = hit[1];
      if (!b.name || /^\d/.test(b.name)) b.name = lm.name_ko;
      if (lm.opened_year && b.yearSource !== YEAR_SRC.OSM) {
        b.built = lm.opened_year;
        b.yearSource = YEAR_SRC.CURATED;
      }
      landmarkCount++;
    }
  }

  // ── 3) 철거된 옛 건물(개발지구 자료) ──
  /** 세부 격자 사각형이 비어 있는지. untilYear 를 주면 그 해 이전에 준공된(같이 서 있던) OSM 건물과 겹치면 거부. */
  const subFree = (i0: number, j0: number, i1: number, j1: number, rings: Ring[], allowRoad = false, untilYear = 0) => {
    if (i0 < 0 || j0 < 0 || i1 > sub.w || j1 > sub.h) return false;
    for (let j = j0; j < j1; j++)
      for (let i = i0; i < i1; i++) {
        const oy = occYear[j * sub.w + i];
        if (untilYear && oy !== 0 && oy < untilYear) return false;
        const k = Math.floor(j / ratio) * w + Math.floor(i / ratio);
        if (g.mask[k] !== MASK.CITY) return false;
        const v = g.lcNow[k];
        if (v === LC.WATER || v === LC.RAIL || v === LC.ROAD_MOTORWAY || v === LC.ROAD_MAJOR) return false;
        if (!allowRoad && (g.road[k] !== 0 || v === LC.SIDEWALK)) return false;
        const x = sub.x0 + (i + 0.5) * sub.cell;
        const z = sub.z0 + (j + 0.5) * sub.cell;
        if (!pointInRings(x, z, rings)) return false;
      }
    return true;
  };
  const addProc = (rect: [number, number, number, number], b: Omit<BuildingRec, 'rects' | 'cx' | 'cz' | 'baseM' | 'osmId' | 'osmType' | 'palette' | 'roof'> & { roof?: number }) => {
    const [a, c, d, e] = rect;
    const cells: number[] = [];
    for (let j = c; j < e; j++) for (let i = a; i < d; i++) cells.push(i, j);
    const cx = sub.x0 + ((a + d) / 2) * sub.cell;
    const cz = sub.z0 + ((c + e) / 2) * sub.cell;
    out.push({
      ...b,
      osmId: 0,
      osmType: 0,
      palette: Math.floor(hash2(a, c, 5) * 256),
      roof: b.roof ?? roofFor(b.kind, hash2(a, c, 13)),
      baseM: baseOf(cells),
      cx,
      cz,
      rects: [rect],
    });
  };

  const zoneStats: Record<string, number> = {};
  for (const { z, rings } of zones) {
    // 철거 연도는 조사 자료에 명시된 것만 쓴다(상위 구역·해제 구역에 임의 철거를 만들지 않기 위해).
    const demolished = z.demolition_year ?? 0;
    let n = 0;
    // (a) 옛 아파트(5층 판상형) — 철산주공 등
    if (z.before_kind === 'old_apartments' && demolished && z.status !== 'planned') {
      const pc = z.predecessor_complexes ?? [];
      const builtY = pc.reduce((m, p) => (p.completion_year ? Math.min(m, p.completion_year) : m), z.before_since_year ?? 9999);
      const floors = pc.find((p) => p.floors)?.floors ?? 5;
      const names = pc.map((p) => p.name_ko).join('·') || z.name_ko.replace(/\s*재건축.*$/, '');
      if (builtY < 9999) {
        let [minX, minZ, maxX, maxZ] = [Infinity, Infinity, -Infinity, -Infinity];
        for (const r of rings)
          for (const [x, zz] of r) {
            minX = Math.min(minX, x);
            minZ = Math.min(minZ, zz);
            maxX = Math.max(maxX, x);
            maxZ = Math.max(maxZ, zz);
          }
        const I0 = Math.floor((minX - sub.x0) / sub.cell);
        const J0 = Math.floor((minZ - sub.z0) / sub.cell);
        const I1 = Math.ceil((maxX - sub.x0) / sub.cell);
        const J1 = Math.ceil((maxZ - sub.z0) / sub.cell);
        // 동서로 긴 50m×12m 판상동, 남북 간격 32m, 동서 간격 60m
        for (let j = J0 + 2; j + 5 <= J1; j += 13)
          for (let i = I0 + 2 + ((j / 13) % 2 ? 4 : 0); i + 20 <= I1; i += 24) {
            if (!subFree(i, j, i + 20, j + 5, rings, true, demolished)) continue;
            addProc([i, j, i + 20, j + 5], {
              kind: BK.APARTMENT, floors, heightM: floors * FLOOR_H + 0.5, built: builtY, removed: demolished, constructStart: builtY - 2,
              yearSource: YEAR_SRC.ZONE, flags: BF.PREDECESSOR | BF.PROCEDURAL, name: `${names} (철거)`, roof: ROOF.FLAT,
            });
            n++;
          }
      }
    }
    // (b) 옛 저층 주택가 — 광명뉴타운 등
    if (z.before_kind === 'lowrise_housing' && demolished && z.status !== 'planned' && z.status !== 'cancelled') {
      const since = z.before_since_year ?? 1972;
      const [cx, cz] = project(z.center_lat, z.center_lon);
      const r = (z.approx_radius_m ?? 200) + 20;
      const I0 = Math.floor((cx - r - sub.x0) / sub.cell);
      const J0 = Math.floor((cz - r - sub.z0) / sub.cell);
      for (let j = J0; j < J0 + (2 * r) / sub.cell; j += 4)
        for (let i = I0; i < I0 + (2 * r) / sub.cell; i += 4) {
          const hs = hash2(i, j, 21);
          if (hs < 0.12) continue; // 빈 필지·공터
          const wI = hs > 0.6 ? 3 : 2 + (hs > 0.35 ? 1 : 0);
          if (!subFree(i, j, i + wI, j + 3, rings, false, demolished)) continue;
          const villa = hs > 0.45;
          const fl = villa ? 2 + Math.floor(hash2(i, j, 22) * 3) : 1 + Math.floor(hash2(i, j, 23) * 2);
          addProc([i, j, i + wI, j + 3], {
            kind: villa ? BK.VILLA : BK.HOUSE, floors: fl, heightM: fl * FLOOR_H + (villa ? 0.5 : 1.5),
            built: since + Math.floor(hash2(i, j, 24) * 18), removed: demolished, constructStart: 0,
            yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PREDECESSOR | BF.PROCEDURAL, name: `${z.name_ko.replace(/구역.*$/, '')} 옛 주택 (철거)`,
          });
          n++;
        }
    }
    // (c) 택지개발 전 농가 마을 — 논밭이던 지구
    if ((z.before_kind === 'farmland' || z.before_kind === 'greenhouse') && z.construction_start_year && z.construction_start_year >= cfg.yearMin) {
      const [cx, cz] = project(z.center_lat, z.center_lon);
      const r = z.approx_radius_m ?? 300;
      const villages = Math.max(1, Math.min(6, Math.round((Math.PI * r * r) / 350000)));
      for (let v = 0; v < villages; v++) {
        const a = hash2(v, Math.round(cx), 31) * Math.PI * 2;
        const d = Math.sqrt(hash2(v, Math.round(cz), 32)) * r * 0.7;
        const vx = cx + Math.cos(a) * d;
        const vz = cz + Math.sin(a) * d;
        for (let q = 0; q < 10; q++) {
          const aa = hash2(v, q, 33) * Math.PI * 2;
          const dd = 8 + hash2(v, q, 34) * 45;
          const i = Math.floor((vx + Math.cos(aa) * dd - sub.x0) / sub.cell);
          const j = Math.floor((vz + Math.sin(aa) * dd - sub.z0) / sub.cell);
          if (!subFree(i, j, i + 4, j + 3, [[[-1e9, -1e9], [1e9, -1e9], [1e9, 1e9], [-1e9, 1e9]]], true, z.construction_start_year)) continue;
          addProc([i, j, i + 4, j + 3], {
            kind: BK.FARMHOUSE, floors: 1, heightM: 4.5, built: 0, removed: z.construction_start_year, constructStart: 0,
            yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PREDECESSOR | BF.PROCEDURAL, name: '옛 농가 (추정)', roof: ROOF.GABLE,
          });
          n++;
          stat.farmhouse++;
        }
      }
    }
    if (n) zoneStats[z.id] = n;
    stat.predecessor += n;
  }

  // ── 4) 절차 생성: OSM 건물이 없는 주거·상업·공업 셀, 비닐하우스 ──
  // 아파트 단지(OSM 아파트가 있는 주거지 면) 안의 빈터는 의도된 조경·주차장이므로 채우지 않는다.
  const complexCell = new Uint8Array(w * h);
  for (const el of ctx.osm.landcover) {
    if (el.tags?.landuse !== 'residential') continue;
    const r = areaRings(el);
    if (!r) continue;
    const rings = allRings(r);
    const hasApt = out.some((b) => b.kind === BK.APARTMENT && !(b.flags & BF.PROCEDURAL) && pointInRings(b.cx, b.cz, rings));
    if (hasApt) fillRings(g.spec, rings, (i, j) => (complexCell[j * w + i] = 1));
  }
  const ghZone = zones.find(({ z }) => z.id === 'gmsh-newtown');
  const futureRemoval = (x: number, z: number) => {
    if (ghZone && pointInRings(x, z, ghZone.rings)) return ghZone.z.construction_start_year ?? 0;
    const zz = zoneAt(x, z, (q) => (q.status === 'under_construction' || q.status === 'planned') && !!q.construction_start_year && q.before_kind !== 'old_apartments');
    return zz?.construction_start_year ?? 0;
  };
  const LOT = 4; // 10m 필지
  for (let J = 0; J + LOT <= sub.h; J += LOT)
    for (let I = 0; I + LOT <= sub.w; I += LOT) {
      const k = Math.floor((J + 2) / ratio) * w + Math.floor((I + 2) / ratio);
      if (g.mask[k] !== MASK.CITY || complexCell[k]) continue;
      const v = g.lcNow[k];
      if (v !== LC.RESIDENTIAL && v !== LC.COMMERCIAL && v !== LC.INDUSTRIAL && v !== LC.GREENHOUSE) continue;
      // 필지 전체가 비어 있고 같은 피복이어야 한다
      let ok = true;
      for (let j = J; j < J + LOT && ok; j++)
        for (let i = I; i < I + LOT; i++) {
          if (occ[j * sub.w + i]) {
            ok = false;
            break;
          }
          const kk = Math.floor(j / ratio) * w + Math.floor(i / ratio);
          if (g.lcNow[kk] !== v || g.road[kk] !== 0) {
            ok = false;
            break;
          }
        }
      if (!ok) continue;
      const hs = hash2(I, J, 41);
      const x = sub.x0 + (I + 2) * sub.cell;
      const z = sub.z0 + (J + 2) * sub.cell;
      const district = districtName(k);
      if (v === LC.GREENHOUSE) {
        // 동서로 긴 비닐하우스(약 7.5m × 10m 조각을 이어 붙인 효과: 필지마다 한 동)
        if (hs < 0.15) continue;
        const removed = futureRemoval(x, z);
        addProc([I, J, I + LOT, J + 3], {
          kind: BK.GREENHOUSE, floors: 1, heightM: 3.5, built: 1978 + Math.floor(hash2(I, J, 42) * 25), removed,
          constructStart: 0, yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PROCEDURAL | (removed ? BF.PREDECESSOR : 0), name: '비닐하우스', roof: ROOF.DOME,
        });
        stat.greenhouse++;
        continue;
      }
      if (hs < 0.18) continue; // 빈 필지·주차 공간
      const ny = nearbyYear(x, z, false);
      const built = (ny || districtEra(district)) + Math.floor(hash2(I, J, 43) * 11) - 5;
      const removed = futureRemoval(x, z);
      if (v === LC.RESIDENTIAL) {
        const villa = hs > 0.4;
        const fl = villa ? 3 + Math.floor(hash2(I, J, 44) * 3) : 1 + Math.floor(hash2(I, J, 45) * 2);
        addProc([I, J, I + 3, J + 3], {
          kind: villa ? BK.VILLA : BK.HOUSE, floors: fl, heightM: fl * FLOOR_H + (villa ? 0.5 : 1.5), built, removed, constructStart: 0,
          yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PROCEDURAL | (removed ? BF.PREDECESSOR : 0), name: null,
        });
      } else if (v === LC.COMMERCIAL) {
        const fl = 2 + Math.floor(hash2(I, J, 46) * 5);
        addProc([I, J, I + 3, J + 3], {
          kind: BK.COMMERCIAL, floors: fl, heightM: fl * 3.5, built, removed, constructStart: 0,
          yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PROCEDURAL, name: null,
        });
      } else {
        addProc([I, J, I + 4, J + 3], {
          kind: BK.INDUSTRIAL, floors: 1 + (hs > 0.8 ? 1 : 0), heightM: hs > 0.8 ? 9 : 6, built, removed, constructStart: 0,
          yearSource: YEAR_SRC.PROCEDURAL, flags: BF.PROCEDURAL, name: null,
        });
      }
      stat.procedural++;
    }

  // 연도 정리: 타임라인 범위 밖 값 보정, 불변식 확인
  for (const b of out) {
    if (b.built !== 0) b.built = Math.max(cfg.yearMin - 5, Math.min(cfg.yearMax, b.built));
    if (b.built !== 0 && b.built < cfg.yearMin) b.built = 0;
    if (b.removed !== 0 && b.built !== 0 && b.removed <= b.built) b.removed = b.built + 1;
    if (b.constructStart !== 0 && b.built !== 0 && b.constructStart >= b.built) b.constructStart = b.built - 1;
    if (!b.rects.length) throw new Error(`사각형 없는 건물 ${b.osmId}`);
  }
  ctx.buildings = out;
  Object.assign(ctx.stats, {
    buildings: out.length,
    bOsm: stat.osm,
    bOutside: stat.outside,
    bYearOsm: stat.byOsmYear,
    bYearCurated: stat.byCurated,
    bYearZone: stat.byZone,
    bYearInferred: stat.byInferred,
    bPredecessor: stat.predecessor,
    bProcedural: stat.procedural,
    bGreenhouse: stat.greenhouse,
    bFarmhouse: stat.farmhouse,
    bLandmark: landmarkCount,
  });
  ctx.log(`건물 ${out.length}동 (OSM ${stat.osm}, 옛 건물 ${stat.predecessor}, 절차 ${stat.procedural}, 비닐하우스 ${stat.greenhouse}, 랜드마크 ${landmarkCount})`);
  ctx.log(`지구별 옛 건물: ${JSON.stringify(zoneStats)}`);
}
