// P3 network: 도로 그래프(교차로에서 분할), 철도 노선 경로·역, 버스 노선 경로·정류장.

import { LC, LEVEL, MASK, RC } from '../../src/data/codes.ts';
import { project } from '../../src/data/geo.ts';
import type { BusRoute, RailLine, RailPath, RailStation } from '../../src/data/format.ts';
import { projectGeometry, type OsmElement, type OsmRelation, type Tags } from '../lib/osm.ts';
import { roadClass, roadLanes, roadLevel, roadOneway, roadWidth } from '../lib/roads.ts';
import type { Pt } from '../lib/geom.ts';
import type { NetworkOut, PipelineContext, RoadEdge, RoadNode } from './context.ts';
import type { CuratedLine } from './curated.ts';
import { normName } from './buildings.ts';

const ROAD_LCS: ReadonlySet<number> = new Set([LC.ROAD_MOTORWAY, LC.ROAD_MAJOR, LC.ROAD_MINOR]);

/** 경로 점들의 누적 길이. */
function cumulative(pts: readonly Pt[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return c;
}

/** way 조각들을 끝점을 맞춰 한 줄로 잇는다(relation 멤버 순서 기준). 조각별 태그 인덱스도 함께. */
export function chainWays(parts: { pts: Pt[]; tag: number }[]): { pts: Pt[]; tags: number[] } {
  const pts: Pt[] = [];
  const tags: number[] = [];
  const d2 = (a: Pt, b: Pt) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  for (let p = 0; p < parts.length; p++) {
    let seg = parts[p].pts;
    if (seg.length < 2) continue;
    if (pts.length === 0) {
      // 첫 조각 방향: 다음 조각과 이어지는 쪽이 끝이 되게
      const nxt = parts.slice(p + 1).find((q) => q.pts.length >= 2);
      if (nxt) {
        const e0 = Math.min(d2(seg[0], nxt.pts[0]), d2(seg[0], nxt.pts[nxt.pts.length - 1]));
        const e1 = Math.min(d2(seg[seg.length - 1], nxt.pts[0]), d2(seg[seg.length - 1], nxt.pts[nxt.pts.length - 1]));
        if (e0 < e1) seg = seg.slice().reverse();
      }
      for (const q of seg) {
        pts.push(q);
        tags.push(parts[p].tag);
      }
      continue;
    }
    const end = pts[pts.length - 1];
    if (d2(seg[seg.length - 1], end) < d2(seg[0], end)) seg = seg.slice().reverse();
    const gap = d2(seg[0], end);
    for (let i = gap < 1 ? 1 : 0; i < seg.length; i++) {
      pts.push(seg[i]);
      tags.push(parts[p].tag);
    }
  }
  return { pts, tags };
}

export function buildNetwork(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const cfg = ctx.cfg;
  const cellK = (x: number, z: number) => {
    const i = Math.floor((x - g.spec.x0) / g.spec.cell);
    const j = Math.floor((z - g.spec.z0) / g.spec.cell);
    return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
  };
  const ground = (x: number, z: number) => {
    const k = cellK(x, z);
    return k < 0 ? 0 : g.height[k];
  };
  const inside = (x: number, z: number) => {
    const k = cellK(x, z);
    return k >= 0 && g.mask[k] !== MASK.VOID;
  };
  /** 점별 LEVEL 에 따라 y 를 정한다: 지상 = 지면, 터널 = 지면 − depth, 교량 = 앞뒤 지상 높이 보간 + 여유. */
  const heights = (pts: Pt[], lv: number[], depth: number, lift: number): number[] => {
    const y = pts.map(([x, z]) => ground(x, z));
    const cum = cumulative(pts);
    for (let i = 0; i < pts.length; ) {
      if (lv[i] === LEVEL.GROUND) {
        i++;
        continue;
      }
      let j = i;
      while (j < pts.length && lv[j] === lv[i]) j++;
      if (lv[i] < 0) {
        for (let q = i; q < j; q++) y[q] -= depth;
      } else {
        const a = i > 0 ? y[i - 1] : y[i];
        const b = j < pts.length ? y[j] : y[j - 1];
        const d0 = i > 0 ? cum[i - 1] : cum[i];
        const d1 = j < pts.length ? cum[j] : cum[j - 1];
        for (let q = i; q < j; q++) {
          const t = d1 > d0 ? (cum[q] - d0) / (d1 - d0) : 0;
          const arch = Math.sin(Math.PI * t) * Math.min(4, (d1 - d0) * 0.02);
          y[q] = Math.max(y[q] + lift, a + (b - a) * t + lift + arch);
        }
      }
      i = j;
    }
    return y;
  };
  /** 셀이 도로가 된 연도(처음부터 도로면 0). */
  const roadYearAt = (k: number): number => {
    if (k < 0) return -1;
    if (ROAD_LCS.has(g.lc0[k])) return 0;
    if (g.y1[k] && ROAD_LCS.has(g.lc1[k])) return g.y1[k];
    if (g.y2[k] && ROAD_LCS.has(g.lc2[k])) return g.y2[k];
    return -1;
  };

  // ── 1) 도로 그래프 ──
  interface W {
    el: OsmElement & { nodes: number[] };
    cls: number;
    pts: Pt[];
  }
  const ways: W[] = [];
  for (const el of ctx.osm.highways) {
    if (el.type !== 'way' || !el.nodes || !el.geometry || el.nodes.length !== el.geometry.length) continue;
    const cls = roadClass(el.tags);
    if (cls === null) continue;
    const pts = projectGeometry(el.geometry);
    if (pts.length < 2 || !pts.some(([x, z]) => inside(x, z))) continue;
    ways.push({ el: el as W['el'], cls, pts });
  }
  const use = new Map<number, number>();
  for (const wy of ways) for (const id of wy.el.nodes) use.set(id, (use.get(id) ?? 0) + 1);
  const nodes: RoadNode[] = [];
  const nodeIdx = new Map<number, number>();
  const nodeOf = (id: number, p: Pt) => {
    let n = nodeIdx.get(id);
    if (n === undefined) {
      n = nodes.length;
      nodes.push({ x: p[0], y: 0, z: p[1] });
      nodeIdx.set(id, n);
    }
    return n;
  };
  const roadNames: string[] = [];
  const nameIdx = new Map<string, number>();
  const edges: RoadEdge[] = [];
  for (const wy of ways) {
    const t: Tags = wy.el.tags ?? {};
    const level = roadLevel(t);
    const lanes = roadLanes(t, wy.cls);
    const width = roadWidth(t, wy.cls);
    const ow = roadOneway(t, wy.cls);
    let name = -1;
    if (t.name) {
      name = nameIdx.get(t.name) ?? -1;
      if (name < 0) {
        name = roadNames.length;
        roadNames.push(t.name);
        nameIdx.set(t.name, name);
      }
    }
    let start = 0;
    for (let i = 1; i < wy.pts.length; i++) {
      const last = i === wy.pts.length - 1;
      if (!last && (use.get(wy.el.nodes[i]) ?? 0) < 2) continue;
      let pts = wy.pts.slice(start, i + 1);
      let a = nodeOf(wy.el.nodes[start], wy.pts[start]);
      let b = nodeOf(wy.el.nodes[i], wy.pts[i]);
      start = i;
      if (!pts.some(([x, z]) => inside(x, z))) continue;
      if (ow === -1) {
        pts = pts.slice().reverse();
        [a, b] = [b, a];
      }
      const lv = pts.map(() => level);
      const ys = heights(pts, lv, 10, 0.3);
      // 개통 연도: 지상 도로 셀들이 도로가 된 연도의 중앙값(처음부터 도로면 0)
      const yrs: number[] = [];
      for (const [x, z] of pts) {
        const y = roadYearAt(cellK(x, z));
        if (y >= 0) yrs.push(y);
      }
      yrs.sort((m, n) => m - n);
      const built = yrs.length ? yrs[Math.floor(yrs.length / 2)] : 0;
      edges.push({
        a,
        b,
        cls: wy.cls,
        lanes,
        oneway: ow === 0 ? 0 : 1,
        level,
        width,
        built,
        name,
        pts: pts.map(([x, z], q) => [x, ys[q], z] as [number, number, number]),
      });
    }
  }
  // 노드 높이 = 붙은 간선 끝점 높이 중 지상 우선
  for (const e of edges) {
    const pa = e.pts[0];
    const pb = e.pts[e.pts.length - 1];
    if (e.level === LEVEL.GROUND || nodes[e.a].y === 0) nodes[e.a].y = pa[1];
    if (e.level === LEVEL.GROUND || nodes[e.b].y === 0) nodes[e.b].y = pb[1];
  }
  // 교량·터널 간선의 연도는 이어진 지상 간선 연도를 따른다
  const nodeYear = new Map<number, number>();
  for (const e of edges)
    if (e.level === LEVEL.GROUND) {
      nodeYear.set(e.a, Math.max(nodeYear.get(e.a) ?? 0, e.built));
      nodeYear.set(e.b, Math.max(nodeYear.get(e.b) ?? 0, e.built));
    }
  for (const e of edges) if (e.level !== LEVEL.GROUND) e.built = Math.min(nodeYear.get(e.a) ?? 0, nodeYear.get(e.b) ?? 0);
  // 조사 자료의 고속도로 개통 연도 적용(이름 매칭)
  for (const e of edges) {
    if (e.cls > RC.TRUNK || e.name < 0) continue;
    const nm = normName(roadNames[e.name]);
    const hit = ctx.curated.transit.roads.find((r) => {
      const key = normName(r.name_ko.replace(/\(.*$/, ''));
      return key.length >= 3 && (nm.includes(key) || key.includes(nm));
    });
    if (hit?.opened_year_in_gwangmyeong) e.built = Math.max(cfg.yearMin, Math.min(cfg.yearMax, hit.opened_year_in_gwangmyeong));
  }

  // ── 2) 철도 ──
  const railTags = new Map<number, Tags>();
  for (const el of ctx.osm.railways) if (el.type === 'way') railTags.set(el.id, el.tags ?? {});
  const hwTags = new Map<number, Tags>();
  for (const el of ctx.osm.highways) if (el.type === 'way') hwTags.set(el.id, el.tags ?? {});
  const relations = ctx.osm.routes.filter((e): e is OsmRelation => e.type === 'relation');

  const pathPts: number[] = [];
  const pathLevel: number[] = [];
  /** 격자 안 가장 긴 연속 구간만 남겨 pathPts 에 넣는다. */
  const pushPath = (pts: Pt[], lv: number[], depth: number, lift: number, minLen: number): RailPath | null => {
    let best: [number, number] | null = null;
    let s = -1;
    for (let i = 0; i <= pts.length; i++) {
      const ok = i < pts.length && inside(pts[i][0], pts[i][1]);
      if (ok && s < 0) s = i;
      if (!ok && s >= 0) {
        if (!best || i - s > best[1] - best[0]) best = [s, i];
        s = -1;
      }
    }
    if (!best || best[1] - best[0] < 2) return null;
    const p = pts.slice(best[0], best[1]);
    const l = lv.slice(best[0], best[1]);
    const cum = cumulative(p);
    const length = cum[cum.length - 1];
    if (length < minLen) return null;
    const ys = heights(p, l, depth, lift);
    const start = pathPts.length / 3;
    p.forEach(([x, z], q) => {
      pathPts.push(x, ys[q], z);
      pathLevel.push(l[q]);
    });
    return { start, count: p.length, length };
  };
  const relPath = (rel: OsmRelation, tagsOf: Map<number, Tags>, levelOf: (t: Tags | undefined) => number) => {
    const parts = rel.members
      .filter((m) => m.type === 'way' && m.geometry && !/platform|stop/.test(m.role))
      .map((m) => ({ pts: projectGeometry(m.geometry), tag: m.ref }));
    const { pts, tags } = chainWays(parts);
    return { pts, lv: tags.map((id) => levelOf(tagsOf.get(id))) };
  };
  const railLevel = (t: Tags | undefined) => {
    if (!t) return LEVEL.GROUND;
    const layer = t.layer ? parseInt(t.layer, 10) : 0;
    if ((t.tunnel && t.tunnel !== 'no') || layer < 0) return LEVEL.TUNNEL;
    if (t.bridge && t.bridge !== 'no') return LEVEL.BRIDGE;
    return LEVEL.GROUND;
  };
  /** 한 방향 경로를 반대 방향으로 뒤집고 옆으로 offset 만큼(진행 방향 오른쪽 +) 밀어 복선처럼 만든다. */
  const reverseOffset = (pts: Pt[], lv: number[], offset: number) => {
    const r = pts.slice().reverse();
    const l = lv.slice().reverse();
    const out: Pt[] = r.map((p, i) => {
      const a = r[Math.max(0, i - 1)];
      const b = r[Math.min(r.length - 1, i + 1)];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz) || 1;
      return [p[0] - (dz / len) * offset, p[1] + (dx / len) * offset];
    });
    return { pts: out, lv: l };
  };

  const stationNodes = ctx.osm.railways.filter((e) => e.type === 'node' && (e.tags?.railway === 'station' || e.tags?.railway === 'halt'));
  const stationsFor = (cl: CuratedLine, paths: RailPath[], opened: number): RailStation[] => {
    const res: RailStation[] = [];
    for (const st of cl.stations) {
      const base = st.name_ko.replace(/\s*\(.*$/, '').replace(/역$/, '');
      const node = stationNodes.find((n) => n.type === 'node' && (n.tags?.name === base || n.tags?.name === `${base}역`));
      const [sx, sz] = node && node.type === 'node' ? project(node.lat, node.lon) : project(st.lat, st.lon);
      paths.forEach((p, pi) => {
        let bestD = Infinity;
        let bestAt = 0;
        let bestQ = p.start;
        let acc = 0;
        for (let q = p.start; q < p.start + p.count; q++) {
          if (q > p.start) acc += Math.hypot(pathPts[q * 3] - pathPts[(q - 1) * 3], pathPts[q * 3 + 2] - pathPts[(q - 1) * 3 + 2]);
          const d = Math.hypot(pathPts[q * 3] - sx, pathPts[q * 3 + 2] - sz);
          if (d < bestD) {
            bestD = d;
            bestAt = acc;
            bestQ = q;
          }
        }
        if (bestD > 250) return;
        res.push({
          name: `${base}역`,
          x: pathPts[bestQ * 3],
          y: pathPts[bestQ * 3 + 1],
          z: pathPts[bestQ * 3 + 2],
          level: pathLevel[bestQ],
          opened: Math.max(st.opened_year ?? opened, opened),
          path: pi,
          distance: bestAt,
          inCity: st.in_gwangmyeong,
        });
      });
    }
    return res;
  };

  interface LineSpec {
    id: string;
    curatedId: string;
    kind: RailLine['kind'];
    relMatch?: (name: string, route: string) => boolean;
    constructionName?: RegExp;
    depth: number;
    /** 한쪽 방향 relation 만 있을 때 반대 방향 오프셋(m). 한국철도는 좌측통행이므로 반대 선로는 진행 방향 왼쪽(음수)이 아니라 뒤집은 경로의 오른쪽이 된다. */
    pairOffset: number;
    speedKmh: number;
    carLength: number;
    fallback: { body: string; stripe: string; cars: number; peak: number; off: number };
  }
  const SPECS: LineSpec[] = [
    { id: 'line7', curatedId: 'seoul_line7', kind: 'subway', relMatch: (n, r) => r === 'subway' && n.includes('7호선') && /온수|장암|도봉산|석남/.test(n), depth: 20, pairOffset: 3.6, speedKmh: 35, carLength: 20, fallback: { body: '#c4c8cc', stripe: '#747f00', cars: 8, peak: 3, off: 6 } },
    { id: 'ktx', curatedId: 'gyeongbu_hsr_ktx', kind: 'high_speed', relMatch: (n, r) => r === 'train' && n.includes('KTX') && n.includes('경부선'), depth: 15, pairOffset: 4.8, speedKmh: 90, carLength: 22, fallback: { body: '#ffffff', stripe: '#204080', cars: 10, peak: 8, off: 15 } },
    { id: 'line1-shuttle', curatedId: 'line1_gwangmyeong_shuttle', kind: 'commuter', relMatch: (n) => n.includes('광명셔틀'), depth: 15, pairOffset: 3.6, speedKmh: 45, carLength: 20, fallback: { body: '#c8ccd0', stripe: '#0052a4', cars: 4, peak: 30, off: 60 } },
    { id: 'sinansan', curatedId: 'sinansan_line', kind: 'commuter', constructionName: /신안산/, depth: 40, pairOffset: 3.6, speedKmh: 60, carLength: 20, fallback: { body: '#e6e6e6', stripe: '#f04938', cars: 6, peak: 8, off: 12 } },
    { id: 'wolpan', curatedId: 'wolgot_pangyo_line', kind: 'commuter', constructionName: /경강선|월곶|월판/, depth: 30, pairOffset: 3.6, speedKmh: 60, carLength: 20, fallback: { body: '#e6e6e6', stripe: '#0054a6', cars: 4, peak: 10, off: 15 } },
  ];
  const lines: RailLine[] = [];
  for (const spec of SPECS) {
    const cl = ctx.curated.transit.lines.find((l) => l.id === spec.curatedId);
    if (!cl) {
      ctx.log(`조사 자료에 노선 ${spec.curatedId} 없음 — 건너뜀`);
      continue;
    }
    const opened = Math.max(cfg.yearMin, cl.opened_year_in_gwangmyeong);
    if (opened > cfg.yearMax) continue;
    const paths: RailPath[] = [];
    if (spec.relMatch) {
      const cands = relations
        .filter((r) => spec.relMatch!(r.tags?.name ?? '', r.tags?.route ?? ''))
        .map((r) => ({ r, ...relPath(r, railTags, railLevel) }))
        .filter((c) => c.pts.length >= 2)
        .map((c) => ({ ...c, inLen: c.pts.filter(([x, z]) => inside(x, z)).length }))
        .sort((a, b) => b.inLen - a.inLen);
      if (!cands.length) throw new Error(`노선 ${spec.id}: OSM route relation 을 찾지 못했습니다`);
      const first = cands[0];
      const fp = pushPath(first.pts, first.lv, spec.depth, 0.6, 300);
      if (fp) paths.push(fp);
      // 반대 방향: 시작점이 첫 경로의 끝 쪽에 가까운 relation
      const end = first.pts[first.pts.length - 1];
      const opp = cands.slice(1).find((c) => Math.hypot(c.pts[0][0] - end[0], c.pts[0][1] - end[1]) < Math.hypot(c.pts[0][0] - first.pts[0][0], c.pts[0][1] - first.pts[0][1]));
      const src = opp ?? { ...reverseOffset(first.pts, first.lv, spec.pairOffset) };
      const sp = pushPath(src.pts, src.lv, spec.depth, 0.6, 300);
      if (sp) paths.push(sp);
    } else if (spec.constructionName) {
      const parts = ctx.osm.railways
        .filter((e) => e.type === 'way' && (e.tags?.railway === 'construction' || e.tags?.construction) && spec.constructionName!.test(e.tags?.name ?? ''))
        .map((e) => ({ pts: e.type === 'way' ? projectGeometry(e.geometry) : [], tag: e.id }));
      // 조각이 순서 없이 있으므로 가장 가까운 끝점부터 탐욕적으로 잇는다
      const pool = parts.filter((p) => p.pts.length >= 2);
      if (pool.length) {
        const ordered = [pool.shift()!];
        while (pool.length) {
          const tail = ordered[ordered.length - 1].pts;
          const endP = tail[tail.length - 1];
          let bi = 0;
          let bd = Infinity;
          pool.forEach((p, i) => {
            const d = Math.min(Math.hypot(p.pts[0][0] - endP[0], p.pts[0][1] - endP[1]), Math.hypot(p.pts[p.pts.length - 1][0] - endP[0], p.pts[p.pts.length - 1][1] - endP[1]));
            if (d < bd) {
              bd = d;
              bi = i;
            }
          });
          if (bd > 800) break;
          ordered.push(pool.splice(bi, 1)[0]);
        }
        const { pts } = chainWays(ordered);
        const lv = pts.map(() => LEVEL.TUNNEL);
        const fp = pushPath(pts, lv, spec.depth, 0, 200);
        if (fp) {
          paths.push(fp);
          const rv = reverseOffset(pts, lv, spec.pairOffset);
          const sp = pushPath(rv.pts, rv.lv, spec.depth, 0, 200);
          if (sp) paths.push(sp);
        }
      }
    }
    if (!paths.length) {
      ctx.log(`노선 ${spec.id}: 격자 안 경로 없음 — 건너뜀`);
      continue;
    }
    const status: RailLine['status'] = cl.status === 'completed' ? 'completed' : cl.status === 'under_construction' ? 'under_construction' : 'planned';
    lines.push({
      id: spec.id,
      name: cl.name_ko,
      kind: spec.kind,
      color: cl.line_color_hex.toLowerCase(),
      bodyColor: (cl.train_body_color_hex ?? spec.fallback.body).toLowerCase(),
      stripeColor: (cl.train_stripe_color_hex ?? spec.fallback.stripe).toLowerCase(),
      cars: cl.cars_per_train ?? spec.fallback.cars,
      carLength: cl.car_length_m ?? spec.carLength,
      opened,
      status,
      headwayPeak: cl.headway_peak_min ?? spec.fallback.peak,
      headwayOffpeak: cl.headway_offpeak_min ?? spec.fallback.off,
      speedKmh: spec.speedKmh,
      paths,
      stations: stationsFor(cl, paths, opened),
    });
  }
  if (!lines.some((l) => l.id === 'line7') || !lines.some((l) => l.id === 'ktx')) throw new Error('7호선·KTX 경로 조립 실패');

  // ── 3) 버스 ──
  const stopName = new Map<number, string>();
  for (const e of ctx.osm.pois) if (e.type === 'node' && e.tags?.highway === 'bus_stop' && e.tags.name) stopName.set(e.id, e.tags.name);
  const categoryOf = (name: string, ref: string, colour: string | undefined): { category: string; color: string; headway: number } => {
    const col = colour && /^#[0-9a-f]{6}$/i.test(colour) ? colour.toLowerCase() : null;
    const r = ref.trim();
    if (/^N/i.test(r)) return { category: '심야버스', color: col ?? '#0068b7', headway: 30 };
    if (/^M/i.test(r)) return { category: '광역급행(M버스)', color: col ?? '#f5f5f5', headway: 20 };
    if (/^G/i.test(r) || /직행/.test(name)) return { category: '경기 직행좌석', color: col ?? '#ee2737', headway: 20 };
    if (name.startsWith('서울')) {
      if (/^9\d{3}$/.test(r)) return { category: '서울 광역', color: col ?? '#e60012', headway: 15 };
      if (/^\d{4}$/.test(r)) return { category: '서울 지선', color: col ?? '#53b332', headway: 12 };
      if (/^\d{3}$/.test(r)) return { category: '서울 간선', color: col ?? '#0068b7', headway: 10 };
      if (/^\d{2}$/.test(r)) return { category: '서울 순환', color: col ?? '#f2b70a', headway: 12 };
    }
    if (/마을/.test(name)) return { category: '마을버스', color: col ?? '#fed70f', headway: 15 };
    if (/좌석/.test(name)) return { category: '경기 좌석', color: col ?? '#3c96d5', headway: 20 };
    return { category: '경기 일반', color: col ?? '#18bf74', headway: 15 };
  };
  const busRoutes: BusRoute[] = [];
  const seen = new Set<string>();
  for (const rel of relations) {
    if (rel.tags?.route !== 'bus') continue;
    const ref = rel.tags.ref ?? '';
    const name = rel.tags.name ?? `버스 ${ref}`;
    const { pts, lv } = relPath(rel, hwTags, (t) => roadLevel(t));
    if (pts.length < 2) continue;
    const p = pushPath(pts, lv, 8, 0.3, 800);
    if (!p) continue;
    const s0 = [pathPts[p.start * 3], pathPts[p.start * 3 + 2]];
    const e0 = [pathPts[(p.start + p.count - 1) * 3], pathPts[(p.start + p.count - 1) * 3 + 2]];
    const key = `${ref}|${Math.round(s0[0] / 100)},${Math.round(s0[1] / 100)}|${Math.round(e0[0] / 100)},${Math.round(e0[1] / 100)}`;
    if (seen.has(key)) {
      // 중복 경로는 되돌린다(pathPts 끝에 막 추가된 것)
      pathPts.length = p.start * 3;
      pathLevel.length = p.start;
      continue;
    }
    seen.add(key);
    // 정류장: 경로에서 40m 이내
    const stops: { name: string; distance: number }[] = [];
    const cum: number[] = [0];
    for (let q = p.start + 1; q < p.start + p.count; q++) cum.push(cum[cum.length - 1] + Math.hypot(pathPts[q * 3] - pathPts[(q - 1) * 3], pathPts[q * 3 + 2] - pathPts[(q - 1) * 3 + 2]));
    for (const m of rel.members) {
      if (m.type !== 'node' || !/stop|platform/.test(m.role) || m.lat === undefined || m.lon === undefined) continue;
      const [sx, sz] = project(m.lat, m.lon);
      let bd = Infinity;
      let at = 0;
      for (let q = 0; q < p.count; q++) {
        const d = Math.hypot(pathPts[(p.start + q) * 3] - sx, pathPts[(p.start + q) * 3 + 2] - sz);
        if (d < bd) {
          bd = d;
          at = cum[q];
        }
      }
      if (bd < 40 && !stops.some((s) => Math.abs(s.distance - at) < 30)) stops.push({ name: stopName.get(m.ref) ?? '정류장', distance: at });
    }
    stops.sort((a, b) => a.distance - b.distance);
    const cat = categoryOf(name, ref, rel.tags.colour);
    const notable = ctx.curated.transit.bus.notable_routes.find((n) => n.number === ref);
    busRoutes.push({ ref, name, category: cat.category, color: cat.color, path: p, stops, headwayMin: notable?.headway_min ?? cat.headway });
  }

  const net: NetworkOut = { nodes, edges, roadNames, lines, busRoutes, pathPts, pathLevel };
  ctx.network = net;
  Object.assign(ctx.stats, {
    roadNodes: nodes.length,
    roadEdges: edges.length,
    railLines: lines.length,
    busRoutes: busRoutes.length,
    pathPoints: pathLevel.length,
  });
  ctx.log(`도로 노드 ${nodes.length}, 간선 ${edges.length}; 철도 ${lines.map((l) => `${l.id}(${l.paths.length}경로, 역 ${l.stations.length})`).join(', ')}; 버스 ${busRoutes.length}노선`);
}
