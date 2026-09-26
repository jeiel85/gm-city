// 도로 표시(노란 겹 중앙선·흰 점선 차선·횡단보도), 교량(도로·철도), 지상 철길, 지하 투시용 터널 튜브.
// 모두 정점 속성 aBuilt(개통 연도)로 셰이더에서 연도 가시성을 정한다.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  GreaterDepth,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
} from 'three';
import type { AppContext, GroundQuery } from '../../core/types.ts';
import { LEVEL, RC } from '../../data/codes.ts';

class Geo {
  p: number[] = [];
  n: number[] = [];
  c: number[] = [];
  y: number[] = [];
  i: number[] = [];
  private col = new Color();
  /** 네 점(반시계, 위에서 볼 때 또는 바깥에서 볼 때)으로 사각형. */
  quad(v: number[], nrm: [number, number, number], color: string | Color, built: number) {
    const b = this.p.length / 3;
    const c = typeof color === 'string' ? this.col.set(color) : color;
    for (let k = 0; k < 12; k += 3) {
      this.p.push(v[k], v[k + 1], v[k + 2]);
      this.n.push(...nrm);
      this.c.push(c.r, c.g, c.b);
      this.y.push(built);
    }
    this.i.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  /** 선분 방향으로 놓인 납작한 띠(윗면만). */
  strip(ax: number, az: number, bx: number, bz: number, off: number, w: number, y: number, color: string | Color, built: number) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len;
    const nz = dx / len;
    const o0 = off - w / 2;
    const o1 = off + w / 2;
    // 오른쪽 법선 (nx,nz) 기준 o0 → o1
    this.quad([ax + nx * o1, y, az + nz * o1, bx + nx * o1, y, bz + nz * o1, bx + nx * o0, y, bz + nz * o0, ax + nx * o0, y, az + nz * o0], [0, 1, 0], color, built);
  }
  /** 선분을 따라 놓인 상자(윗면 기울기 허용). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, thick: number, color: string | Color, built: number, topColor?: string | Color) {
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * (w / 2);
    const nz = (dx / len) * (w / 2);
    const L = [ax + nx, az + nz];
    const R = [ax - nx, az - nz];
    const L2 = [bx + nx, bz + nz];
    const R2 = [bx - nx, bz - nz];
    const tc = topColor ?? color;
    this.quad([R[0], ay, R[1], L[0], ay, L[1], L2[0], by, L2[1], R2[0], by, R2[1]], [0, 1, 0], tc, built);
    this.quad([L[0], ay - thick, L[1], L2[0], by - thick, L2[1], L2[0], by, L2[1], L[0], ay, L[1]], [nx / (w / 2), 0, nz / (w / 2)], color, built);
    this.quad([R2[0], by - thick, R2[1], R[0], ay - thick, R[1], R[0], ay, R[1], R2[0], by, R2[1]], [-nx / (w / 2), 0, -nz / (w / 2)], color, built);
    this.quad([R[0], ay - thick, R[1], L[0], ay - thick, L[1], L[0], ay, L[1], R[0], ay, R[1]], [-dx / len, 0, -dz / len], color, built);
    this.quad([L2[0], by - thick, L2[1], R2[0], by - thick, R2[1], R2[0], by, R2[1], L2[0], by, L2[1]], [dx / len, 0, dz / len], color, built);
  }
  /** 축 정렬 기둥. */
  pillar(x: number, z: number, s: number, y0: number, y1: number, color: string, built: number) {
    const h = s / 2;
    this.quad([x + h, y0, z + h, x + h, y0, z - h, x + h, y1, z - h, x + h, y1, z + h], [1, 0, 0], color, built);
    this.quad([x - h, y0, z - h, x - h, y0, z + h, x - h, y1, z + h, x - h, y1, z - h], [-1, 0, 0], color, built);
    this.quad([x - h, y0, z + h, x + h, y0, z + h, x + h, y1, z + h, x - h, y1, z + h], [0, 0, 1], color, built);
    this.quad([x + h, y0, z - h, x - h, y0, z - h, x - h, y1, z - h, x + h, y1, z - h], [0, 0, -1], color, built);
  }
  build(): BufferGeometry | null {
    if (!this.i.length) return null;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('aBuilt', new BufferAttribute(new Float32Array(this.y), 1));
    g.setIndex(this.i.length > 65535 ? new BufferAttribute(new Uint32Array(this.i), 1) : new BufferAttribute(new Uint16Array(this.i), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** 폴리라인을 step 간격 조각으로 나눠 콜백(조각 시작·끝, 누적 거리). */
function walk(pts: [number, number][], step: number, cb: (ax: number, az: number, bx: number, bz: number, d: number) => void) {
  let acc = 0;
  for (let s = 1; s < pts.length; s++) {
    const [ax, az] = pts[s - 1];
    const [bx, bz] = pts[s];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / step));
    for (let q = 0; q < n; q++) {
      const t0 = q / n;
      const t1 = (q + 1) / n;
      cb(ax + (bx - ax) * t0, az + (bz - az) * t0, ax + (bx - ax) * t1, az + (bz - az) * t1, acc + len * t0);
    }
    acc += len;
  }
}

function offsetLine(pts: [number, number][], off: number): [number, number][] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [p[0] - (dz / l) * off, p[1] + (dx / l) * off];
  });
}

const yearMaterial = (app: AppContext, opts: ConstructorParameters<typeof MeshLambertMaterial>[0] = {}) => {
  const m = new MeshLambertMaterial({ vertexColors: true, ...opts });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uYear = app.uniforms.uYear;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBuilt;\nuniform float uYear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aBuilt > 0.5 && uYear < aBuilt) transformed = vec3(0.0);');
  };
  return m;
};

export function createRoadLayers(app: AppContext, ground: GroundQuery): Group {
  // 디오라마 밖(VOID)으로 삐져나가는 조각은 그리지 않는다
  const onMap = (x: number, z: number) => ground.landCoverAt(x, z, 2026) !== 0;
  const { meta: nm, a: N } = app.data.network;
  const group = new Group();
  group.name = 'roads';
  const marks = new Geo();
  const deck = new Geo();
  const rails = new Geo();
  const tubes = new Geo();

  const edgePts = (e: number): [number, number, number][] => {
    const s = N.edgePtStart[e];
    const out: [number, number, number][] = [];
    for (let q = s; q < s + N.edgePtCount[e]; q++) out.push([N.pts[q * 3], N.pts[q * 3 + 1], N.pts[q * 3 + 2]]);
    return out;
  };

  // 교차로 차수(간선~3차로 도로)
  const major = (c: number) => c >= RC.PRIMARY && c <= RC.TERTIARY;
  const deg = new Uint8Array(nm.nodeCount);
  for (let e = 0; e < nm.edgeCount; e++)
    if (major(N.edgeClass[e]) && N.edgeLevel[e] === LEVEL.GROUND) {
      deg[N.edgeA[e]]++;
      deg[N.edgeB[e]]++;
    }

  for (let e = 0; e < nm.edgeCount; e++) {
    const cls = N.edgeClass[e];
    const lvl = N.edgeLevel[e];
    const built = N.edgeBuilt[e];
    const P = edgePts(e);
    const xz = P.map((p) => [p[0], p[2]] as [number, number]);
    if (lvl >= 1 && cls <= RC.SERVICE) {
      // 교량: 상판 + 교각
      for (let s = 1; s < P.length; s++) {
        if (!onMap(P[s - 1][0], P[s - 1][2]) || !onMap(P[s][0], P[s][2])) continue;
        deck.beam(P[s - 1][0], P[s - 1][1], P[s - 1][2], P[s][0], P[s][1], P[s][2], N.edgeWidth[e] + 2, 1.3, '#b9b7b0', built, '#5f656d');
      }
      walk(xz, 32, (ax, az, _bx, _bz, d) => {
        if (d < 8 || !onMap(ax, az)) return;
        const k = Math.max(1, Math.round(d / 32));
        const idx = Math.min(P.length - 1, k);
        const y = P[idx][1] - 1.3;
        const gy = ground.heightAt(ax, az);
        if (y - gy > 1.5) deck.pillar(ax, az, 1.6, gy - 1, y, '#a9a79f', built);
      });
    } else if (lvl < 0 && cls <= RC.TERTIARY) {
      for (let s = 1; s < P.length; s++) if (onMap(P[s][0], P[s][2])) tubes.beam(P[s - 1][0], P[s - 1][1] + 2.5, P[s - 1][2], P[s][0], P[s][1] + 2.5, P[s][2], N.edgeWidth[e] + 1, 5, '#9aa3ad', built);
    }
    if (lvl !== LEVEL.GROUND || !major(cls) || !onMap(xz[0][0], xz[0][1])) continue;
    // 도로 표시(지면 위 0.06m)
    const lanes = N.edgeLanes[e];
    const oneway = N.edgeOneway[e] === 1;
    const lift = (ax: number, az: number) => ground.heightAt(ax, az) + 0.06;
    if (!oneway && lanes >= 2) {
      for (const off of [-0.18, 0.18]) walk(offsetLine(xz, off), 2.5, (ax, az, bx, bz) => marks.strip(ax, az, bx, bz, 0, 0.16, lift((ax + bx) / 2, (az + bz) / 2), '#f4c21a', built));
    }
    const perDir = oneway ? lanes : Math.floor(lanes / 2);
    for (let l = 1; l < perDir; l++) {
      for (const side of oneway ? [0] : [-1, 1]) {
        const off = oneway ? (l - perDir / 2) * 3.2 : side * l * 3.2;
        walk(offsetLine(xz, off), 2.5, (ax, az, bx, bz, d) => {
          if (d % 8 > 3) return;
          marks.strip(ax, az, bx, bz, 0, 0.15, lift((ax + bx) / 2, (az + bz) / 2), '#f7f7f2', built);
        });
      }
    }
    // 횡단보도: 차수 3 이상 교차로 쪽 끝
    const hw = N.edgeWidth[e] / 2;
    for (const end of [0, 1]) {
      const node = end === 0 ? N.edgeA[e] : N.edgeB[e];
      if (deg[node] < 3 || xz.length < 2) continue;
      const p0 = end === 0 ? xz[0] : xz[xz.length - 1];
      const p1 = end === 0 ? xz[1] : xz[xz.length - 2];
      const dx = p1[0] - p0[0];
      const dz = p1[1] - p0[1];
      const len = Math.hypot(dx, dz);
      if (len < 18) continue;
      const ux = dx / len;
      const uz = dz / len;
      const cx = p0[0] + ux * (hw + 5);
      const cz = p0[1] + uz * (hw + 5);
      const y = lift(cx, cz);
      for (let o = -hw + 0.5; o <= hw - 0.5; o += 1.1) {
        const sx = cx - uz * o;
        const sz = cz + ux * o;
        marks.strip(sx - ux * 1.5, sz - uz * 1.5, sx + ux * 1.5, sz + uz * 1.5, 0, 0.55, y, '#f7f7f2', built);
      }
    }
  }

  // 철도: 지상·교량 선로(개통 노선), 지하 튜브(모든 노선)
  for (const line of nm.lines) {
    const built = line.opened;
    const done = line.status === 'completed';
    const col = new Color(line.color);
    for (const p of line.paths) {
      for (let q = p.start + 1; q < p.start + p.count; q++) {
        const ax = N.pathPts[(q - 1) * 3];
        const ay = N.pathPts[(q - 1) * 3 + 1];
        const az = N.pathPts[(q - 1) * 3 + 2];
        const bx = N.pathPts[q * 3];
        const by = N.pathPts[q * 3 + 1];
        const bz = N.pathPts[q * 3 + 2];
        const lv = Math.min(N.pathLevel[q - 1], N.pathLevel[q]);
        if (!onMap(ax, az) || !onMap(bx, bz)) continue;
        if (lv < 0 || N.pathLevel[q - 1] < 0 || N.pathLevel[q] < 0) {
          tubes.beam(ax, ay + 3, az, bx, by + 3, bz, 5, 6, col, done ? built : 0);
          continue;
        }
        if (!done) continue;
        if (lv >= 1) deck.beam(ax, ay - 0.4, az, bx, by - 0.4, bz, 6, 1.6, '#b9b7b0', built, '#8b8078');
        // 레일 2줄 + 침목
        const seg: [number, number][] = [
          [ax, az],
          [bx, bz],
        ];
        for (const off of [-0.75, 0.75]) walk(offsetLine(seg, off), 6, (x0, z0, x1, z1) => rails.beam(x0, ay + 0.25, z0, x1, by + 0.25, z1, 0.12, 0.2, '#c9ccd1', built));
        walk(seg, 2.2, (x0, z0, x1, z1) => {
          const t = Math.hypot(x0 - ax, z0 - az) / (Math.hypot(bx - ax, bz - az) || 1);
          const y = ay + (by - ay) * t + 0.08;
          rails.beam(x0, y, z0, x0 + (x1 - x0) * 0.25, y, z0 + (z1 - z0) * 0.25, 2.6, 0.12, '#6b4f3a', built);
        });
      }
    }
  }

  const add = (g: BufferGeometry | null, mat: MeshLambertMaterial | MeshBasicMaterial, opts: { shadow?: boolean; order?: number } = {}) => {
    if (!g) return null;
    const m = new Mesh(g, mat);
    m.matrixAutoUpdate = false;
    m.castShadow = !!opts.shadow;
    m.receiveShadow = true;
    if (opts.order) m.renderOrder = opts.order;
    group.add(m);
    return m;
  };
  add(marks.build(), yearMaterial(app, { polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
  add(deck.build(), yearMaterial(app), { shadow: true });
  add(rails.build(), yearMaterial(app), { shadow: true });

  // 지하 투시: 땅에 가려진 부분만(GreaterDepth) 비쳐 보이는 반투명 튜브
  const ghost = new MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0, depthWrite: false, depthFunc: GreaterDepth });
  ghost.onBeforeCompile = (sh) => {
    sh.uniforms.uYear = app.uniforms.uYear;
    sh.uniforms.uXray = app.uniforms.uXray;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aBuilt;\nuniform float uYear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nif (aBuilt > 0.5 && uYear < aBuilt) transformed = vec3(0.0);');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uXray;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4(diffuse, 0.45 * uXray);');
  };
  const tubeMesh = add(tubes.build(), ghost, { order: 10 });
  if (tubeMesh) {
    tubeMesh.receiveShadow = false;
    tubeMesh.onBeforeRender = () => {
      tubeMesh.visible = app.uniforms.uXray.value > 0.01;
    };
  }
  return group;
}
