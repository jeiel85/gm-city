// 파이프라인 결과를 public/data/*.gmc, history.json 으로 기록한다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodePack } from '../../src/data/pack.ts';
import {
  DATA_FILES,
  FORMAT_VERSION,
  type BuildingsMeta,
  type NetworkMeta,
  type TreesMeta,
  type WorldMeta,
} from '../../src/data/format.ts';
import { ORIGIN } from '../../src/data/geo.ts';
import type { PipelineContext } from './context.ts';

const ATTRIBUTION = [
  '지도 데이터 © OpenStreetMap contributors (ODbL 1.0) — https://www.openstreetmap.org/copyright',
  '고도 데이터: AWS Terrain Tiles (Mapzen Terrarium; SRTM 등) — https://registry.opendata.aws/terrain-tiles/',
];

const clampI16 = (v: number) => Math.max(-32768, Math.min(32767, Math.round(v)));
const clampU16 = (v: number) => Math.max(0, Math.min(65535, Math.round(v)));

export function writeOutputs(ctx: PipelineContext, outDir: string): Record<string, number> {
  mkdirSync(outDir, { recursive: true });
  const sizes: Record<string, number> = {};
  const put = (name: string, bytes: Uint8Array | string) => {
    writeFileSync(join(outDir, name), bytes);
    sizes[name] = typeof bytes === 'string' ? Buffer.byteLength(bytes) : bytes.byteLength;
  };

  // world.gmc
  const g = ctx.grid;
  const n = g.spec.w * g.spec.h;
  const heightDm = new Int16Array(n);
  let minH = Infinity;
  let maxH = -Infinity;
  for (let k = 0; k < n; k++) {
    heightDm[k] = clampI16(g.height[k] * 10);
    if (g.mask[k]) {
      if (g.height[k] < minH) minH = g.height[k];
      if (g.height[k] > maxH) maxH = g.height[k];
    }
  }
  const worldMeta: WorldMeta = {
    version: FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    origin: { lat: ORIGIN.lat, lon: ORIGIN.lon },
    cellSize: g.spec.cell,
    subSize: ctx.cfg.subSize,
    width: g.spec.w,
    height: g.spec.h,
    x0: g.spec.x0,
    z0: g.spec.z0,
    minHeight: minH,
    maxHeight: maxH,
    boundary: ctx.cityRings.map((r) => r.map(([x, z]) => [Math.round(x * 10) / 10, Math.round(z * 10) / 10] as [number, number])),
    districts: g.districts,
    stats: ctx.stats,
    attribution: ATTRIBUTION,
  };
  put(
    DATA_FILES.world,
    encodePack(worldMeta, {
      height: heightDm,
      mask: g.mask,
      lc0: g.lc0,
      lc1: g.lc1,
      lc2: g.lc2,
      y1: g.y1,
      y2: g.y2,
      district: g.district,
    }),
  );

  // buildings.gmc
  const B = ctx.buildings;
  const names: string[] = [];
  const nameIndex = new Map<string, number>();
  let rectTotal = 0;
  for (const b of B) rectTotal += b.rects.length;
  const ba = {
    osmId: new Float64Array(B.length),
    osmType: new Uint8Array(B.length),
    kind: new Uint8Array(B.length),
    floors: new Uint8Array(B.length),
    heightDm: new Uint16Array(B.length),
    baseDm: new Int16Array(B.length),
    built: new Uint16Array(B.length),
    removed: new Uint16Array(B.length),
    constructStart: new Uint16Array(B.length),
    yearSource: new Uint8Array(B.length),
    palette: new Uint8Array(B.length),
    roof: new Uint8Array(B.length),
    flags: new Uint8Array(B.length),
    nameIdx: new Int32Array(B.length),
    cx: new Float32Array(B.length),
    cz: new Float32Array(B.length),
    rectStart: new Uint32Array(B.length),
    rectCount: new Uint16Array(B.length),
    rects: new Uint16Array(rectTotal * 4),
  };
  let r = 0;
  B.forEach((b, i) => {
    if (b.rects.length > 65535) throw new Error(`건물 ${b.osmId}: 사각형이 너무 많습니다 (${b.rects.length})`);
    ba.osmId[i] = b.osmId;
    ba.osmType[i] = b.osmType;
    ba.kind[i] = b.kind;
    ba.floors[i] = Math.max(1, Math.min(255, Math.round(b.floors)));
    ba.heightDm[i] = clampU16(b.heightM * 10);
    ba.baseDm[i] = clampI16(b.baseM * 10);
    ba.built[i] = clampU16(b.built);
    ba.removed[i] = clampU16(b.removed);
    ba.constructStart[i] = clampU16(b.constructStart);
    ba.yearSource[i] = b.yearSource;
    ba.palette[i] = b.palette & 255;
    ba.roof[i] = b.roof;
    ba.flags[i] = b.flags;
    if (b.name) {
      let ni = nameIndex.get(b.name);
      if (ni === undefined) {
        ni = names.length;
        names.push(b.name);
        nameIndex.set(b.name, ni);
      }
      ba.nameIdx[i] = ni;
    } else ba.nameIdx[i] = -1;
    ba.cx[i] = b.cx;
    ba.cz[i] = b.cz;
    ba.rectStart[i] = r;
    ba.rectCount[i] = b.rects.length;
    for (const [a0, b0, a1, b1] of b.rects) {
      ba.rects[r * 4] = a0;
      ba.rects[r * 4 + 1] = b0;
      ba.rects[r * 4 + 2] = a1;
      ba.rects[r * 4 + 3] = b1;
      r++;
    }
  });
  const bMeta: BuildingsMeta = { version: FORMAT_VERSION, count: B.length, rectCount: rectTotal, names };
  put(DATA_FILES.buildings, encodePack(bMeta, ba));

  // trees.gmc
  const T = ctx.trees;
  const ta = {
    x: new Float32Array(T.length),
    z: new Float32Array(T.length),
    y: new Float32Array(T.length),
    kind: new Uint8Array(T.length),
    size: new Uint8Array(T.length),
    planted: new Uint16Array(T.length),
    removed: new Uint16Array(T.length),
  };
  T.forEach((t, i) => {
    ta.x[i] = t.x;
    ta.z[i] = t.z;
    ta.y[i] = t.y;
    ta.kind[i] = t.kind;
    ta.size[i] = t.size;
    ta.planted[i] = clampU16(t.planted);
    ta.removed[i] = clampU16(t.removed);
  });
  const tMeta: TreesMeta = { version: FORMAT_VERSION, count: T.length };
  put(DATA_FILES.trees, encodePack(tMeta, ta));

  // network.gmc
  const net = ctx.network;
  if (!net) throw new Error('network 단계 결과가 없습니다');
  let ptTotal = 0;
  for (const e of net.edges) ptTotal += e.pts.length;
  const na = {
    nodeX: new Float32Array(net.nodes.map((p) => p.x)),
    nodeY: new Float32Array(net.nodes.map((p) => p.y)),
    nodeZ: new Float32Array(net.nodes.map((p) => p.z)),
    edgeA: new Uint32Array(net.edges.length),
    edgeB: new Uint32Array(net.edges.length),
    edgeClass: new Uint8Array(net.edges.length),
    edgeLanes: new Uint8Array(net.edges.length),
    edgeOneway: new Uint8Array(net.edges.length),
    edgeLevel: new Int8Array(net.edges.length),
    edgeWidth: new Float32Array(net.edges.length),
    edgeBuilt: new Uint16Array(net.edges.length),
    edgeName: new Int32Array(net.edges.length),
    edgePtStart: new Uint32Array(net.edges.length),
    edgePtCount: new Uint16Array(net.edges.length),
    pts: new Float32Array(ptTotal * 3),
    pathPts: new Float32Array(net.pathPts),
    pathLevel: new Int8Array(net.pathLevel),
  };
  let p = 0;
  net.edges.forEach((e, i) => {
    if (e.pts.length < 2 || e.pts.length > 65535) throw new Error(`도로 간선 ${i}: 점 개수 ${e.pts.length}`);
    na.edgeA[i] = e.a;
    na.edgeB[i] = e.b;
    na.edgeClass[i] = e.cls;
    na.edgeLanes[i] = Math.max(1, Math.min(255, e.lanes));
    na.edgeOneway[i] = e.oneway;
    na.edgeLevel[i] = e.level;
    na.edgeWidth[i] = e.width;
    na.edgeBuilt[i] = clampU16(e.built);
    na.edgeName[i] = e.name;
    na.edgePtStart[i] = p;
    na.edgePtCount[i] = e.pts.length;
    for (const [x, y, z] of e.pts) {
      na.pts[p * 3] = x;
      na.pts[p * 3 + 1] = y;
      na.pts[p * 3 + 2] = z;
      p++;
    }
  });
  if (na.pathLevel.length * 3 !== na.pathPts.length) throw new Error('pathLevel 과 pathPts 길이가 맞지 않습니다');
  const nMeta: NetworkMeta = {
    version: FORMAT_VERSION,
    nodeCount: net.nodes.length,
    edgeCount: net.edges.length,
    lines: net.lines,
    busRoutes: net.busRoutes,
    roadNames: net.roadNames,
  };
  put(DATA_FILES.network, encodePack(nMeta, na));

  // history.json
  if (!ctx.history) throw new Error('history 단계 결과가 없습니다');
  put(DATA_FILES.history, JSON.stringify(ctx.history));
  return sizes;
}
