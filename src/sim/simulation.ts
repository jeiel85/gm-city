// 교통 시뮬레이션: 자동차·버스·열차·보행자. 이동은 실제 시간 기준(×AGENT_SPEED), 하루 시각·연도는 밀도에만 쓴다.

import {
  Color,
  DynamicDrawUsage,
  GreaterDepth,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Quaternion,
  Vector3,
  type BufferGeometry,
  type Raycaster,
} from 'three';
import type { AppContext, FollowTarget, FrameInfo, PickResult, System } from '../core/types.ts';
import { DRIVABLE, LC, LC_INFO, LEVEL, RC, WALKABLE } from '../data/codes.ts';
import type { BusRoute, RailLine } from '../data/format.ts';
import { BUS, KTX_CAR, KTX_HEAD, METRO_CAR, PERSON, SEDAN, SUV, TAXI, TRUCK, buildModel } from './models.ts';
import { Polyline, RoadGraph, eraFactor, hourFactor, personName, personThought, signalGreen, type GraphEdge } from './paths.ts';

const AGENT_SPEED = 1.5; // 보기 좋게 실제보다 1.5배 빠르게
const HEADWAY_COMPRESS = 5; // 배차 간격 압축
const PERSON_SCALE = 1.6;
const VEHICLE_SCALE = 1.2;
const CAR_BASE = 1400;
const PED_BASE = 2600;

const SPEED: Record<number, number> = { [RC.MOTORWAY]: 25, [RC.TRUNK]: 18, [RC.PRIMARY]: 14, [RC.SECONDARY]: 12, [RC.TERTIARY]: 10, [RC.BUSWAY]: 12 };
const speedOf = (cls: number) => SPEED[cls] ?? 7;
const CLASS_W: Record<number, number> = { [RC.MOTORWAY]: 3, [RC.TRUNK]: 3, [RC.PRIMARY]: 3, [RC.SECONDARY]: 2.5, [RC.TERTIARY]: 2, [RC.RESIDENTIAL]: 0.7, [RC.SERVICE]: 0.25, [RC.LIVING]: 0.4, [RC.BUSWAY]: 1 };
const SHIRTS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c', '#34495e', '#ff8fab', '#ffffff', '#95a5a6'];
const CAR_COLORS = ['#f2f2f2', '#1c1c1e', '#9aa0a6', '#c7ccd1', '#2d4b7a', '#8b1e2d', '#e8e2d4', '#3a3d42', '#4f6d4a', '#f2f2f2'];

interface Car {
  model: number;
  edge: number;
  fwd: boolean;
  d: number;
  v: number;
  lane: number;
  y: number;
  wait: number;
  color: Color;
  pos: Float64Array;
  hidden: boolean;
  id: number;
}
interface Ped {
  edge: number;
  fwd: boolean;
  d: number;
  side: number;
  v: number;
  color: Color;
  pos: Float64Array;
  id: number;
  y: number;
}
interface Bus {
  route: number;
  d: number;
  v: number;
  stop: number;
  dwell: number;
  pos: Float64Array;
  id: number;
  hidden: boolean;
}
interface Train {
  line: number;
  path: number;
  d: number;
  v: number;
  station: number;
  dwell: number;
  id: number;
  head: Float64Array;
}

let nextId = 1;

function makeMaterial(app: AppContext, ghost = false) {
  const U = app.uniforms;
  const mat = ghost
    ? new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, depthFunc: GreaterDepth })
    : new MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uTime: U.uTime, uNight: U.uNight, uXray: U.uXray });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSlot;\nattribute float aSwing;\nattribute float aLamp;\nuniform float uTime;\nvarying float vLamp;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  if (aSwing != 0.0) {
    float ph = uTime * 9.0 + float(gl_InstanceID) * 1.37;
    float a = sin(ph) * 0.55 * aSwing;
    float pivot = transformed.y < 0.85 ? 0.8 : 1.35;
    float dy = transformed.y - pivot;
    transformed.x += dy * sin(a) * (transformed.y < 0.85 ? -1.0 : 1.0);
  }
  vLamp = aLamp;`,
      )
      .replace(
        '#include <color_vertex>',
        `vColor = vec4(1.0);
  vColor.rgb = color;
  #ifdef USE_INSTANCING_COLOR
    vColor.rgb *= mix(vec3(1.0), instanceColor.rgb, aSlot);
  #endif`,
      );
    if (ghost) {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uXray;\nvarying float vLamp;')
        .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4(diffuse, 0.7 * uXray);');
    } else {
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uNight;\nvarying float vLamp;')
        .replace(
          'vec3 totalEmissiveRadiance = emissive;',
          `vec3 totalEmissiveRadiance = emissive;
  if (vLamp > 0.5 && vLamp < 1.5) totalEmissiveRadiance += vec3(1.0, 0.95, 0.75) * uNight * 2.5;
  else if (vLamp > 1.5 && vLamp < 2.5) totalEmissiveRadiance += vec3(1.0, 0.1, 0.08) * (0.3 + uNight * 1.5);
  else if (vLamp > 2.5) totalEmissiveRadiance += vec3(1.0, 0.85, 0.55) * uNight * 0.6;`,
        );
    }
  };
  return mat;
}

class Batch {
  mesh: InstancedMesh;
  n = 0;
  private m = new Matrix4();
  private q = new Quaternion();
  private s = new Vector3();
  private p = new Vector3();
  private up = new Vector3(0, 1, 0);
  /** 인덱스 → 에이전트 참조(피킹). */
  refs: unknown[] = [];
  constructor(geo: BufferGeometry, mat: MeshLambertMaterial | MeshBasicMaterial, cap: number, scale: number, shadow: boolean) {
    this.mesh = new InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = shadow;
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    this.s.setScalar(scale);
    this.mesh.setColorAt(0, new Color('#ffffff'));
  }
  begin() {
    this.n = 0;
  }
  push(x: number, y: number, z: number, heading: number, color: Color | null, ref: unknown) {
    if (this.n >= this.mesh.instanceMatrix.count) return;
    this.q.setFromAxisAngle(this.up, -heading);
    this.p.set(x, y, z);
    this.m.compose(this.p, this.q, this.s);
    this.mesh.setMatrixAt(this.n, this.m);
    if (color) this.mesh.setColorAt(this.n, color);
    this.refs[this.n] = ref;
    this.n++;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

export function createSimulation(app: AppContext): System {
  const { meta: nm, a: N } = app.data.network;
  const ground = app.ground;
  const store = app.store;
  const rnd = Math.random;

  // ── 그래프 ──
  const edges: GraphEdge[] = [];
  for (let e = 0; e < nm.edgeCount; e++)
    edges.push({
      a: N.edgeA[e],
      b: N.edgeB[e],
      cls: N.edgeClass[e],
      lanes: N.edgeLanes[e],
      oneway: N.edgeOneway[e] === 1,
      level: N.edgeLevel[e],
      width: N.edgeWidth[e],
      built: N.edgeBuilt[e],
      line: new Polyline(N.pts, N.edgePtStart[e], N.edgePtCount[e]),
    });
  const driveIdx = edges.map((_, i) => i).filter((i) => DRIVABLE.has(edges[i].cls));
  // 다음 간선 선택 시 allow 에서 차도만 거르므로 그래프에는 모든 간선을 넣는다
  const graph = new RoadGraph(edges, nm.nodeCount);
  // 보행 인접(양방향)
  const walkOut: { edge: number; forward: boolean }[][] = Array.from({ length: nm.nodeCount }, () => []);
  const walkIdx: number[] = [];
  edges.forEach((e, i) => {
    if (!WALKABLE.has(e.cls) || e.level < 0) return;
    walkIdx.push(i);
    walkOut[e.a].push({ edge: i, forward: true });
    walkOut[e.b].push({ edge: i, forward: false });
  });
  // 신호 교차로: 차도 간선 3개 이상
  const deg = new Uint8Array(nm.nodeCount);
  for (const i of driveIdx) {
    const e = edges[i];
    if (e.cls <= RC.TERTIARY) {
      deg[e.a]++;
      deg[e.b]++;
    }
  }

  // 스폰 가중치
  const cumW = (idx: number[], w: (i: number) => number) => {
    const c = new Float64Array(idx.length);
    let s = 0;
    idx.forEach((i, k) => {
      s += w(i);
      c[k] = s;
    });
    return c;
  };
  const pickW = (idx: number[], c: Float64Array) => {
    const r = rnd() * c[c.length - 1];
    let lo = 0;
    let hi = c.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return idx[lo];
  };
  const stationPts: [number, number][] = [];
  for (const l of nm.lines) for (const s of l.stations) if (s.inCity) stationPts.push([s.x, s.z]);
  const inWorld = (e: GraphEdge) => {
    const o = [0, 0, 0, 0];
    e.line.sample(e.line.length / 2, 0, o);
    return ground.inCity(o[0], o[2]) ? 1 : ground.landCoverAt(o[0], o[2], 2026) !== LC.VOID ? 0.3 : 0;
  };
  const carCum = cumW(driveIdx, (i) => edges[i].line.length * (CLASS_W[edges[i].cls] ?? 0.5) * inWorld(edges[i]));
  const pedCum = cumW(walkIdx, (i) => {
    const e = edges[i];
    const o = [0, 0, 0, 0];
    e.line.sample(e.line.length / 2, e.width / 2 + 2, o);
    const lc = ground.landCoverAt(o[0], o[2], 2026);
    let w = lc === LC.COMMERCIAL || lc === LC.PLAZA ? 4 : lc === LC.PARK || lc === LC.RIVERBANK ? 1.5 : lc === LC.RESIDENTIAL || lc === LC.SIDEWALK ? 1 : 0.4;
    for (const [sx, sz] of stationPts) if ((o[0] - sx) ** 2 + (o[2] - sz) ** 2 < 350 ** 2) w *= 4;
    if (e.cls === RC.PATH || e.cls === RC.FOOTWAY) w *= 0.6;
    return e.line.length * w * (ground.inCity(o[0], o[2]) ? 1 : 0);
  });

  // ── 렌더 배치 ──
  const mat = makeMaterial(app);
  const ghostMat = makeMaterial(app, true);
  const q = app.quality.agentDensity;
  const batches = {
    person: new Batch(buildModel(PERSON), mat, Math.ceil(PED_BASE * 1.3), PERSON_SCALE, false),
    sedan: new Batch(buildModel(SEDAN), mat, 1200, VEHICLE_SCALE, true),
    suv: new Batch(buildModel(SUV), mat, 600, VEHICLE_SCALE, true),
    taxi: new Batch(buildModel(TAXI), mat, 400, VEHICLE_SCALE, true),
    truck: new Batch(buildModel(TRUCK), mat, 300, VEHICLE_SCALE, true),
    bus: new Batch(buildModel(BUS), mat, 300, VEHICLE_SCALE, true),
    metro: new Batch(buildModel(METRO_CAR), mat, 200, 1, true),
    ktxHead: new Batch(buildModel(KTX_HEAD), mat, 60, 1, true),
    ktxCar: new Batch(buildModel(KTX_CAR), mat, 200, 1, true),
    metroGhost: new Batch(buildModel(METRO_CAR), ghostMat, 200, 1, false),
    ktxHeadGhost: new Batch(buildModel(KTX_HEAD), ghostMat, 60, 1, false),
    ktxCarGhost: new Batch(buildModel(KTX_CAR), ghostMat, 200, 1, false),
  };
  for (const b of Object.values(batches)) app.scene.add(b.mesh);
  for (const g of [batches.metroGhost, batches.ktxHeadGhost, batches.ktxCarGhost]) g.mesh.renderOrder = 11;
  const carModels = [batches.sedan, batches.suv, batches.taxi, batches.truck];

  // 선택 표시(머리 위 화살표)
  const marker = new Mesh(buildModel([[-0.6, 0, -0.6, 0.6, 0.6, 0.6, '#ffcc00'], [-0.3, -0.6, -0.3, 0.3, 0, 0.3, '#ffcc00']]), new MeshBasicMaterial({ vertexColors: true }));
  marker.visible = false;
  app.scene.add(marker);

  // ── 에이전트 ──
  const cars: Car[] = [];
  const peds: Ped[] = [];
  const buses: Bus[] = [];
  const trains: Train[] = [];
  const routes = nm.busRoutes.map((r) => ({ r, line: new Polyline(N.pathPts, r.path.start, r.path.count), timer: rnd() * 30 }));
  const trainPaths = nm.lines.map((l) => l.paths.map((p) => ({ line: new Polyline(N.pathPts, p.start, p.count), timer: rnd() * 20, stations: [] as { d: number; name: string }[] })));
  nm.lines.forEach((l, li) => {
    for (const s of l.stations) trainPaths[li][s.path]?.stations.push({ d: s.distance, name: s.name });
    for (const tp of trainPaths[li]) tp.stations.sort((a, b) => a.d - b.d);
  });

  // 카메라가 보는 지점(화면 중앙 광선과 지면의 교점)과 반경: 이 안에 에이전트를 우선 배치한다
  const focus = { x: 0, z: 0, r: 3000 };
  const camDir = new Vector3();
  const updateFocus = () => {
    const cp = app.camera.position;
    app.camera.getWorldDirection(camDir);
    const t = camDir.y < -0.05 ? cp.y / -camDir.y : 3000;
    focus.x = cp.x + camDir.x * t;
    focus.z = cp.z + camDir.z * t;
    focus.r = Math.min(14000, Math.max(700, t * 2.2));
  };
  const nearFocus = (e: GraphEdge, slack = 1) => {
    const o = [0, 0, 0, 0];
    e.line.sample(e.line.length / 2, 0, o);
    return (o[0] - focus.x) ** 2 + (o[2] - focus.z) ** 2 < (focus.r * slack) ** 2;
  };
  const lanesPerDir = (e: GraphEdge) => Math.max(1, e.oneway ? e.lanes : Math.floor(e.lanes / 2));
  const laneOffset = (e: GraphEdge, lane: number) => (e.oneway ? (lane - (e.lanes - 1) / 2) * 3.2 : (lane + 0.5) * 3.2);
  const edgeOk = (i: number, year: number) => edges[i].built === 0 || edges[i].built <= year;

  const spawnCar = (year: number) => {
    for (let t = 0; t < 24; t++) {
      const ei = pickW(driveIdx, carCum);
      if (!edgeOk(ei, year) || !nearFocus(edges[ei])) continue;
      const e = edges[ei];
      const fwd = e.oneway ? true : rnd() < 0.5;
      const r = rnd();
      const model = r < 0.55 ? 0 : r < 0.8 ? 1 : r < 0.92 ? 2 : 3;
      cars.push({ model, edge: ei, fwd, d: rnd() * e.line.length, v: speedOf(e.cls) * 0.6, lane: Math.floor(rnd() * lanesPerDir(e)), y: NaN, wait: 0, color: new Color(CAR_COLORS[Math.floor(rnd() * CAR_COLORS.length)]), pos: new Float64Array(4), hidden: false, id: nextId++ });
      return;
    }
  };
  const spawnPed = (year: number) => {
    for (let t = 0; t < 24; t++) {
      const ei = pickW(walkIdx, pedCum);
      if (!edgeOk(ei, year) || !nearFocus(edges[ei])) continue;
      const e = edges[ei];
      peds.push({ edge: ei, fwd: rnd() < 0.5, d: rnd() * e.line.length, side: rnd() < 0.5 ? -1 : 1, v: 1.1 + rnd() * 0.5, color: new Color(SHIRTS[Math.floor(rnd() * SHIRTS.length)]), pos: new Float64Array(4), id: nextId++, y: NaN });
      return;
    }
  };

  // 에이전트 초기 배치(버스·열차는 경로 위에 미리 흩뿌린다)
  let initialized = false;
  const initTransit = (year: number) => {
    routes.forEach((ro, ri) => {
      const n = Math.floor(ro.line.length / (9 * AGENT_SPEED * ((ro.r.headwayMin * 60) / HEADWAY_COMPRESS)));
      for (let k = 0; k < n; k++) if (year >= 1970) buses.push({ route: ri, d: rnd() * ro.line.length, v: 8, stop: 0, dwell: 0, pos: new Float64Array(4), id: nextId++, hidden: false });
    });
    for (const b of buses) b.stop = routes[b.route].r.stops.findIndex((s) => s.distance > b.d);
  };

  // ── 갱신 ──
  const byLane = new Map<number, Car[]>();
  const tmp = [0, 0, 0, 0];
  // 반경이 작을수록(확대할수록) 같은 수를 좁은 곳에 모아 거리가 붐벼 보이게 한다. 멀리서는 도시 전체에 퍼진다.
  const pedTarget = () => PED_BASE * q * eraFactor(app.uniforms.uYear.value) * hourFactor(store.get().timeOfDay);
  const carTarget = () => CAR_BASE * q * eraFactor(app.uniforms.uYear.value) * hourFactor(store.get().timeOfDay);
  let recycleIdx = 0;

  const updateCars = (dt: number, year: number, time: number) => {
    byLane.clear();
    for (const c of cars) {
      const k = (c.edge * 2 + (c.fwd ? 1 : 0)) * 8 + c.lane;
      let l = byLane.get(k);
      if (!l) byLane.set(k, (l = []));
      l.push(c);
    }
    for (const l of byLane.values()) l.sort((a, b) => a.d - b.d);
    for (let i = cars.length - 1; i >= 0; i--) {
      const c = cars[i];
      const e = edges[c.edge];
      const L = e.line.length;
      let vmax = speedOf(e.cls);
      // 앞차
      const lane = byLane.get((c.edge * 2 + (c.fwd ? 1 : 0)) * 8 + c.lane)!;
      const idx = lane.indexOf(c);
      const ahead = lane[idx + 1];
      if (ahead) {
        const gap = ahead.d - c.d - 6;
        vmax = Math.min(vmax, Math.max(0, gap / 1.4));
      }
      // 교차로 신호
      const endNode = c.fwd ? e.b : e.a;
      const toEnd = L - c.d;
      if (deg[endNode] >= 3 && toEnd < 25) {
        const h = graph.heading(c.edge, c.fwd, true);
        if (!signalGreen(h, time, (endNode % 7) * 4.1)) vmax = Math.min(vmax, Math.max(0, (toEnd - 4) / 2));
      }
      c.v += Math.max(-6 * dt, Math.min(2.5 * dt, vmax - c.v));
      c.d += c.v * dt * AGENT_SPEED;
      if (c.d >= L) {
        const nx = graph.next(endNode, c.edge, graph.heading(c.edge, c.fwd, true), (x) => DRIVABLE.has(edges[x].cls) && edgeOk(x, year), rnd());
        if (nx) {
          c.d -= L;
          c.edge = nx.edge;
          c.fwd = nx.forward;
          c.lane = Math.min(c.lane, lanesPerDir(edges[nx.edge]) - 1);
        } else if (!e.oneway) {
          c.fwd = !c.fwd;
          c.d = 0;
        } else {
          cars.splice(i, 1);
          continue;
        }
      }
      const ce = edges[c.edge];
      ce.line.sample(c.d, laneOffset(ce, c.lane), c.pos, !c.fwd);
      c.hidden = ce.level < 0;
      const gy = ce.level >= 1 ? c.pos[1] : ground.heightAt(c.pos[0], c.pos[2]);
      c.y = Number.isNaN(c.y) ? gy : c.y + (gy - c.y) * Math.min(1, dt * 8);
    }
  };

  const updatePeds = (dt: number, year: number) => {
    for (let i = peds.length - 1; i >= 0; i--) {
      const p = peds[i];
      const e = edges[p.edge];
      p.d += p.v * dt * AGENT_SPEED;
      if (p.d >= e.line.length) {
        const node = p.fwd ? e.b : e.a;
        const cands = walkOut[node].filter((c) => c.edge !== p.edge && edgeOk(c.edge, year));
        if (cands.length) {
          const nx = cands[Math.floor(rnd() * cands.length)];
          p.d -= e.line.length;
          p.edge = nx.edge;
          p.fwd = nx.forward;
        } else {
          p.fwd = !p.fwd;
          p.d = 0;
        }
      }
      const pe = edges[p.edge];
      const road = pe.cls <= RC.LIVING && pe.cls !== RC.SERVICE;
      pe.line.sample(p.d, p.side * (road ? pe.width / 2 + 1.6 : 0.6), p.pos, !p.fwd);
      const gy = ground.heightAt(p.pos[0], p.pos[2]);
      p.y = Number.isNaN(p.y) ? gy : p.y + (gy - p.y) * Math.min(1, dt * 10);
    }
  };

  const updateBuses = (dt: number, year: number) => {
    if (year >= 1970)
      routes.forEach((ro, ri) => {
        ro.timer -= dt;
        if (ro.timer <= 0) {
          ro.timer = ((ro.r.headwayMin * 60) / HEADWAY_COMPRESS) * (0.8 + rnd() * 0.4) * (year < 1990 ? 2 : 1);
          if (store.get().layers.buses) buses.push({ route: ri, d: 0, v: 0, stop: 0, dwell: 0, pos: new Float64Array(4), id: nextId++, hidden: false });
        }
      });
    for (let i = buses.length - 1; i >= 0; i--) {
      const b = buses[i];
      const ro = routes[b.route];
      const stops = ro.r.stops;
      if (b.dwell > 0) b.dwell -= dt;
      else {
        const next = stops[b.stop];
        let vmax = 10;
        if (next) {
          const to = next.distance - b.d;
          vmax = Math.min(vmax, Math.max(1.2, to / 2));
          if (to < 1) {
            b.dwell = 4 + rnd() * 3;
            b.stop++;
            b.v = 0;
          }
        }
        b.v += Math.max(-4 * dt, Math.min(1.5 * dt, vmax - b.v));
        b.d += b.v * dt * AGENT_SPEED;
      }
      if (b.d >= ro.line.length) {
        buses.splice(i, 1);
        continue;
      }
      const s = ro.line.sample(b.d, 1.8, b.pos);
      const lv = N.pathLevel[ro.r.path.start + s];
      b.hidden = lv < 0;
      if (lv === LEVEL.GROUND) b.pos[1] = ground.heightAt(b.pos[0], b.pos[2]);
    }
  };

  const lineActive = (l: RailLine, year: number) => l.status === 'completed' && year >= l.opened;
  const updateTrains = (dt: number, year: number) => {
    nm.lines.forEach((l, li) => {
      if (!lineActive(l, year)) return;
      const tod = store.get().timeOfDay;
      if (tod > 1 && tod < 5) return; // 심야 운행 없음
      const peak = (tod > 7 && tod < 9.5) || (tod > 17.5 && tod < 20);
      trainPaths[li].forEach((tp, pi) => {
        tp.timer -= dt;
        if (tp.timer <= 0) {
          tp.timer = (((peak ? l.headwayPeak : l.headwayOffpeak) * 60) / HEADWAY_COMPRESS) * (0.9 + rnd() * 0.2);
          if (store.get().layers.trains) trains.push({ line: li, path: pi, d: 0, v: l.speedKmh / 3.6 * 0.6, station: 0, dwell: 0, id: nextId++, head: new Float64Array(4) });
        }
      });
    });
    for (let i = trains.length - 1; i >= 0; i--) {
      const t = trains[i];
      const l = nm.lines[t.line];
      const tp = trainPaths[t.line][t.path];
      if (!lineActive(l, year)) {
        trains.splice(i, 1);
        continue;
      }
      if (t.dwell > 0) t.dwell -= dt;
      else {
        const vTop = l.speedKmh / 3.6;
        let vmax = vTop;
        const st = tp.stations[t.station];
        if (st) {
          const to = st.d - t.d;
          if (to < -5) t.station++;
          else {
            vmax = Math.min(vmax, Math.max(1.5, Math.sqrt(Math.max(0, 2 * 0.9 * to))));
            if (to < 2) {
              t.dwell = l.kind === 'high_speed' ? 6 : 9;
              t.station++;
              t.v = 0;
            }
          }
        }
        t.v += Math.max(-3 * dt, Math.min(1.2 * dt, vmax - t.v));
        t.d += t.v * dt * AGENT_SPEED;
      }
      const cars = Math.min(8, l.cars);
      if (t.d - cars * (l.carLength + 1) > tp.line.length) trains.splice(i, 1);
    }
  };

  // ── 그리기 ──
  const draw = (year: number) => {
    const layers = store.get().layers;
    for (const b of Object.values(batches)) b.begin();
    if (layers.cars) for (const c of cars) if (!c.hidden) carModels[c.model].push(c.pos[0], c.y, c.pos[2], c.pos[3], c.model === 2 ? null : c.color, c);
    const farAway = app.camera.position.y > 2600; // 너무 멀면 사람은 점보다 작다
    if (layers.people && !farAway) for (const p of peds) batches.person.push(p.pos[0], p.y, p.pos[2], p.pos[3], p.color, p);
    if (layers.buses)
      for (const b of buses) {
        if (b.hidden) continue;
        const col = routeColor[b.route];
        batches.bus.push(b.pos[0], b.pos[1], b.pos[2], b.pos[3], col, b);
      }
    if (layers.trains)
      for (const t of trains) {
        const l = nm.lines[t.line];
        const tp = trainPaths[t.line][t.path];
        const cars = Math.min(8, l.cars);
        const col = lineColor[t.line];
        for (let k = 0; k < cars; k++) {
          const d = t.d - k * (l.carLength + 1) - l.carLength / 2;
          if (d < 0 || d > tp.line.length) continue;
          const s = tp.line.sample(d, 0, tmp);
          const under = N.pathLevel[l.paths[t.path].start + s] < 0;
          const ktx = l.kind === 'high_speed';
          const head = ktx && (k === 0 || k === cars - 1);
          const heading = k === cars - 1 && ktx ? tmp[3] + Math.PI : tmp[3];
          const b = ktx ? (head ? (under ? batches.ktxHeadGhost : batches.ktxHead) : under ? batches.ktxCarGhost : batches.ktxCar) : under ? batches.metroGhost : batches.metro;
          b.push(tmp[0], tmp[1] + 0.3, tmp[2], heading, col, t);
          if (k === 0) t.head.set(tmp);
        }
      }
    for (const b of Object.values(batches)) b.end();
    void year;
  };
  const routeColor = nm.busRoutes.map((r: BusRoute) => new Color(r.color));
  const lineColor = nm.lines.map((l) => new Color(l.stripeColor || l.color));

  // ── 피킹·따라가기 ──
  const posOf = (ref: unknown, out: Vector3): boolean => {
    if (cars.includes(ref as Car)) {
      const c = ref as Car;
      out.set(c.pos[0], c.y, c.pos[2]);
      return true;
    }
    if (peds.includes(ref as Ped)) {
      const p = ref as Ped;
      out.set(p.pos[0], p.y, p.pos[2]);
      return true;
    }
    if (buses.includes(ref as Bus)) {
      const b = ref as Bus;
      out.set(b.pos[0], b.pos[1], b.pos[2]);
      return true;
    }
    if (trains.includes(ref as Train)) {
      const t = ref as Train;
      out.set(t.head[0], t.head[1], t.head[2]);
      return true;
    }
    return false;
  };
  const headingOf = (ref: unknown): number | null => {
    const r = ref as { pos?: Float64Array; head?: Float64Array };
    return r.pos ? r.pos[3] : r.head ? r.head[3] : null;
  };
  let selectedRef: unknown = null;
  const follow = (ref: unknown, label: string): FollowTarget => ({ label, getPosition: (o) => posOf(ref, o), getHeading: () => headingOf(ref) });
  const describe = (ref: unknown, year: number): PickResult['info'] | null => {
    if (cars.includes(ref as Car)) {
      const c = ref as Car;
      const e = edges[c.edge];
      const name = N.edgeName[c.edge] >= 0 ? nm.roadNames[N.edgeName[c.edge]] : '이름 없는 길';
      return { icon: c.model === 2 ? '🚕' : c.model === 3 ? '🚚' : '🚗', title: ['승용차', 'SUV', '택시', '트럭'][c.model], subtitle: name, fields: [{ label: '속도', value: `${Math.round(c.v * 3.6)} km/h` }, { label: '차로', value: `${c.lane + 1} / ${lanesPerDir(e)}` }], note: '실제 교통량이 아닌 시뮬레이션입니다.' };
    }
    if (peds.includes(ref as Ped)) {
      const p = ref as Ped;
      const e = edges[p.edge];
      const where = N.edgeName[p.edge] >= 0 ? nm.roadNames[N.edgeName[p.edge]] : e.cls >= RC.FOOTWAY ? '산책로' : '골목길';
      const lc = ground.landCoverAt(p.pos[0], p.pos[2], year);
      return { icon: '🧍', title: personName(p.id), subtitle: '광명 시민 (가상 인물)', fields: [{ label: '생각', value: personThought(p.id, year, '') }, { label: '걷는 곳', value: `${where} · ${LC_INFO[lc]?.name ?? ''}` }] };
    }
    if (buses.includes(ref as Bus)) {
      const b = ref as Bus;
      const r = routes[b.route].r;
      const next = r.stops[b.stop];
      return { icon: '🚌', title: `${r.ref}번 버스`, subtitle: r.name, fields: [{ label: '분류', value: r.category }, { label: '다음 정류장', value: next?.name ?? '종점 방향' }, { label: '속도', value: `${Math.round(b.v * 3.6)} km/h` }], note: '노선 경로는 OSM 기준, 운행 간격은 시뮬레이션입니다.' };
    }
    if (trains.includes(ref as Train)) {
      const t = ref as Train;
      const l = nm.lines[t.line];
      const tp = trainPaths[t.line][t.path];
      const next = tp.stations[t.station];
      return { icon: l.kind === 'high_speed' ? '🚄' : '🚇', title: l.name, subtitle: t.path === 0 ? '하행' : '상행', fields: [{ label: '다음 역', value: next?.name ?? '광명시 밖으로' }, { label: '속도', value: `${Math.round(t.v * 3.6)} km/h` }, { label: '편성', value: `${l.cars}량` }], note: '운행은 시뮬레이션이며 실제 시간표와 다릅니다.' };
    }
    return null;
  };

  let clock = 0;
  return {
    name: 'simulation',
    update(f: FrameInfo) {
      const year = f.year;
      clock += f.dt;
      if (!initialized) {
        initTransit(year);
        initialized = true;
      }
      // 목표 수에 맞춰 스폰/정리(한 프레임에 조금씩)
      const layers = store.get().layers;
      const ct = layers.cars ? carTarget() : 0;
      for (let k = 0; k < 80 && cars.length < ct; k++) spawnCar(year);
      if (cars.length > ct * 1.1) cars.splice(0, Math.min(40, cars.length - Math.floor(ct)));
      const pt = layers.people ? pedTarget() : 0;
      for (let k = 0; k < 120 && peds.length < pt; k++) spawnPed(year);
      if (peds.length > pt * 1.1) peds.splice(0, Math.min(60, peds.length - Math.floor(pt)));
      // 시야 반경 밖으로 멀리 벗어난 차·사람은 조금씩 정리해 가까운 곳에 다시 태어나게 한다
      updateFocus();
      for (let k = 0; k < 30 && cars.length; k++) {
        recycleIdx = (recycleIdx + 1) % cars.length;
        if (!nearFocus(edges[cars[recycleIdx].edge], 1.4)) cars.splice(recycleIdx, 1);
      }
      for (let k = 0; k < 40 && peds.length; k++) {
        const i = (recycleIdx * 7 + k) % peds.length;
        if (!nearFocus(edges[peds[i].edge], 1.4)) peds.splice(i, 1);
      }
      // 개통 전 도로 위 차량 정리(연도를 되돌렸을 때)
      for (let i = cars.length - 1; i >= 0; i--) if (!edgeOk(cars[i].edge, year)) cars.splice(i, 1);
      for (let i = peds.length - 1; i >= 0; i--) if (!edgeOk(peds[i].edge, year)) peds.splice(i, 1);
      if (!layers.buses) buses.length = 0;
      if (!layers.trains) trains.length = 0;

      updateCars(f.dt, year, clock);
      updatePeds(f.dt, year);
      updateBuses(f.dt, year);
      updateTrains(f.dt, year);
      draw(year);

      // 선택 표시
      const sel = store.get().selected;
      const tgt = new Vector3();
      if (sel && selectedRef && sel.follow && posOf(selectedRef, tgt)) {
        marker.visible = true;
        marker.position.set(tgt.x, tgt.y + 7 + Math.sin(clock * 4) * 0.6, tgt.z);
        const dist = app.camera.position.distanceTo(tgt);
        marker.scale.setScalar(Math.max(1, dist / 120));
      } else marker.visible = false;
    },
    pick(r: Raycaster): PickResult | null {
      let best: { dist: number; ref: unknown; point: Vector3 } | null = null;
      for (const b of Object.values(batches)) {
        if (!b.mesh.visible || b.mesh.count === 0 || b.mesh.material === ghostMat) continue;
        const hits = r.intersectObject(b.mesh, false);
        const h = hits[0];
        if (h && h.instanceId !== undefined && (!best || h.distance < best.dist)) best = { dist: h.distance, ref: b.refs[h.instanceId], point: h.point };
      }
      if (!best) return null;
      const info = describe(best.ref, app.uniforms.uYear.value);
      if (!info) return null;
      selectedRef = best.ref;
      return { distance: best.dist, point: [best.point.x, best.point.y, best.point.z], info, follow: follow(best.ref, info.title) };
    },
  };
}
