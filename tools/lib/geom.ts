// 2D 기하 유틸(로컬 미터 좌표 [x, z]).

export type Pt = [number, number];
export type Ring = Pt[];

/** 짝홀 규칙으로 점이 링들 안에 있는지(바깥 링 + 구멍 링을 한꺼번에 넘기면 구멍이 빠진다). */
export function pointInRings(x: number, z: number, rings: readonly Ring[]): boolean {
  let inside = false;
  for (const ring of rings) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, za] = ring[a];
      const [xb, zb] = ring[b];
      if (za > z !== zb > z && x < ((xb - xa) * (z - za)) / (zb - za) + xa) inside = !inside;
    }
  }
  return inside;
}

/** 부호 있는 면적(x 오른쪽, z 아래 좌표계에서 시계 방향이 양수). */
export function signedArea(ring: readonly Pt[]): number {
  let s = 0;
  for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) s += ring[b][0] * ring[a][1] - ring[a][0] * ring[b][1];
  return s / 2;
}

export function ringArea(ring: readonly Pt[]): number {
  return Math.abs(signedArea(ring));
}

/** 링의 면적 가중 중심. 면적이 0 이면 꼭짓점 평균. */
export function ringCentroid(ring: readonly Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cz = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cz += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-9) {
    let sx = 0;
    let sz = 0;
    for (const p of ring) {
      sx += p[0];
      sz += p[1];
    }
    return [sx / ring.length, sz / ring.length];
  }
  return [cx / (3 * a), cz / (3 * a)];
}

export function bboxOf(pts: readonly Pt[]): { minX: number; minZ: number; maxX: number; maxZ: number } {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (const [x, z] of pts) {
    if (x < minX) minX = x;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (z > maxZ) maxZ = z;
  }
  return { minX, minZ, maxX, maxZ };
}

/** 점과 선분 사이 거리 제곱과 선분 매개변수 t(0~1). */
export function distToSegmentSq(px: number, pz: number, ax: number, az: number, bx: number, bz: number): { d2: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 0 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + dx * t - px;
  const qz = az + dz * t - pz;
  return { d2: qx * qx + qz * qz, t };
}

export function polylineLength(pts: readonly Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return s;
}

/** 폴리라인을 진행 방향 오른쪽으로 offset 만큼 평행 이동한다(음수면 왼쪽). 꺾인 곳은 이웃 법선의 평균을 쓴다. */
export function offsetPolyline(pts: readonly Pt[], offset: number): Pt[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => [p[0], p[1]] as Pt);
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[Math.min(n - 1, i + 1)];
    let dx = p1[0] - p0[0];
    let dz = p1[1] - p0[1];
    const len = Math.hypot(dx, dz) || 1;
    dx /= len;
    dz /= len;
    // 진행 방향 (dx, dz) 의 오른쪽 법선: x 동쪽·z 남쪽 좌표계를 위에서 내려다보면 (-dz, dx).
    out.push([pts[i][0] - dz * offset, pts[i][1] + dx * offset]);
  }
  return out;
}

/** Ramer–Douglas–Peucker 단순화. */
export function simplify(pts: readonly Pt[], tolerance: number): Pt[] {
  if (pts.length <= 2) return pts.slice() as Pt[];
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = -1;
    let idx = -1;
    for (let i = a + 1; i < b; i++) {
      const { d2 } = distToSegmentSq(pts[i][0], pts[i][1], pts[a][0], pts[a][1], pts[b][0], pts[b][1]);
      if (d2 > maxD) {
        maxD = d2;
        idx = i;
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return pts.filter((_, i) => keep[i] === 1) as Pt[];
}

/** 선분 ab 와 cd 의 교차점(없으면 null). */
export function segmentIntersection(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number; p: Pt } | null {
  const rX = b[0] - a[0];
  const rZ = b[1] - a[1];
  const sX = d[0] - c[0];
  const sZ = d[1] - c[1];
  const den = rX * sZ - rZ * sX;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * sZ - (c[1] - a[1]) * sX) / den;
  const u = ((c[0] - a[0]) * rZ - (c[1] - a[1]) * rX) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, p: [a[0] + rX * t, a[1] + rZ * t] };
}

/** 폴리라인을 링들(짝홀 규칙) 안쪽 구간들로 자른다. 경계 교차점을 보간해 넣는다. */
export function clipPolylineToRings(pts: readonly Pt[], rings: readonly Ring[]): Pt[][] {
  const out: Pt[][] = [];
  let cur: Pt[] | null = null;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const inside = pointInRings(p[0], p[1], rings);
    if (i > 0) {
      const prev = pts[i - 1];
      // 이전 점과 현재 점 사이 경계 교차를 모두 찾아 순서대로 처리한다.
      const hits: { t: number; p: Pt }[] = [];
      for (const ring of rings) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const h = segmentIntersection(prev, p, ring[b], ring[a]);
          if (h) hits.push({ t: h.t, p: h.p });
        }
      }
      hits.sort((m, n) => m.t - n.t);
      for (const h of hits) {
        if (cur) {
          cur.push(h.p);
          if (cur.length >= 2) out.push(cur);
          cur = null;
        } else {
          cur = [h.p];
        }
      }
    }
    if (inside) {
      if (!cur) cur = [];
      cur.push([p[0], p[1]]);
    } else if (cur) {
      if (cur.length >= 2) out.push(cur);
      cur = null;
    }
  }
  if (cur && cur.length >= 2) out.push(cur);
  return out;
}
