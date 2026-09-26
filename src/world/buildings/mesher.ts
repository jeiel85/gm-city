// 건물 하나 → 복셀 메시(윗면 사각형 + 외곽 벽 구간 병합 + 지붕 형태). 순수 함수(워커·테스트 공용).
// 좌표는 월드 m. 부품(aPart): 0 벽, 1 지붕, 2 초록 옥상, 3 십자가, 4 옥상 구조물.

import { BK, ROOF } from '../../data/codes.ts';

export const PART = { WALL: 0, ROOF: 1, GREEN: 2, CROSS: 3, TOPBOX: 4 } as const;

export class MeshBuilder {
  pos: number[] = [];
  nrm: number[] = [];
  bid: number[] = [];
  part: number[] = [];
  idx: number[] = [];
  quad(p: number[], n: [number, number, number], b: number, part: number) {
    const base = this.pos.length / 3;
    for (let i = 0; i < 12; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nrm.push(n[0] * 127, n[1] * 127, n[2] * 127);
      this.bid.push(b);
      this.part.push(part);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  /** 축 정렬 상자(바닥면 제외). */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, b: number, part: number, topPart = part) {
    this.quad([x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0], [0, 1, 0], b, topPart);
    this.quad([x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], [1, 0, 0], b, part);
    this.quad([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], [-1, 0, 0], b, part);
    this.quad([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], [0, 0, 1], b, part);
    this.quad([x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], [0, 0, -1], b, part);
  }
  get quads() {
    return this.idx.length / 6;
  }
}

export interface BuildingInput {
  /** 세부 격자 사각형 [sx0, sz0, sx1, sz1] (끝 배타적). */
  rects: ArrayLike<number>;
  rectStart: number;
  rectCount: number;
  sub: number;
  x0: number;
  z0: number;
  base: number;
  height: number;
  kind: number;
  roof: number;
  index: number;
}

/** 건물 몸체(윗면 병합 + 외곽 벽) + 지붕 장식을 builder 에 추가한다. */
export function meshBuilding(B: MeshBuilder, b: BuildingInput): void {
  const { rects, rectStart, rectCount, sub, x0, z0, base, height: H, kind, roof, index } = b;
  let mi = Infinity;
  let mj = Infinity;
  let Mi = -Infinity;
  let Mj = -Infinity;
  for (let r = rectStart; r < rectStart + rectCount; r++) {
    mi = Math.min(mi, rects[r * 4]);
    mj = Math.min(mj, rects[r * 4 + 1]);
    Mi = Math.max(Mi, rects[r * 4 + 2]);
    Mj = Math.max(Mj, rects[r * 4 + 3]);
  }
  const bw = Mi - mi;
  const bh = Mj - mj;
  const m = new Uint8Array(bw * bh);
  for (let r = rectStart; r < rectStart + rectCount; r++)
    for (let j = rects[r * 4 + 1]; j < rects[r * 4 + 3]; j++) for (let i = rects[r * 4]; i < rects[r * 4 + 2]; i++) m[(j - mj) * bw + (i - mi)] = 1;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < bw && j < bh && m[j * bw + i] === 1;
  const X = (i: number) => x0 + (mi + i) * sub;
  const Z = (j: number) => z0 + (mj + j) * sub;
  const top = base + H;
  const topPart = roof === ROOF.GREEN_TOP ? PART.GREEN : PART.ROOF;

  // 윗면: 이미 겹치지 않는 사각형들
  for (let r = rectStart; r < rectStart + rectCount; r++) {
    const a0 = rects[r * 4] - mi;
    const b0 = rects[r * 4 + 1] - mj;
    const a1 = rects[r * 4 + 2] - mi;
    const b1 = rects[r * 4 + 3] - mj;
    B.quad([X(a0), top, Z(b0), X(a0), top, Z(b1), X(a1), top, Z(b1), X(a1), top, Z(b0)], [0, 1, 0], index, topPart);
  }
  // 벽: 방향별 경계 구간 병합
  for (const dir of [1, -1]) {
    for (let i = 0; i < bw; i++) {
      let j = 0;
      while (j < bh) {
        if (!(on(i, j) && !on(i + dir, j))) {
          j++;
          continue;
        }
        let je = j + 1;
        while (je < bh && on(i, je) && !on(i + dir, je)) je++;
        const x = dir > 0 ? X(i + 1) : X(i);
        if (dir > 0) B.quad([x, base, Z(je), x, base, Z(j), x, top, Z(j), x, top, Z(je)], [1, 0, 0], index, PART.WALL);
        else B.quad([x, base, Z(j), x, base, Z(je), x, top, Z(je), x, top, Z(j)], [-1, 0, 0], index, PART.WALL);
        j = je;
      }
    }
    for (let j = 0; j < bh; j++) {
      let i = 0;
      while (i < bw) {
        if (!(on(i, j) && !on(i, j + dir))) {
          i++;
          continue;
        }
        let ie = i + 1;
        while (ie < bw && on(ie, j) && !on(ie, j + dir)) ie++;
        const z = dir > 0 ? Z(j + 1) : Z(j);
        if (dir > 0) B.quad([X(i), base, z, X(ie), base, z, X(ie), top, z, X(i), top, z], [0, 0, 1], index, PART.WALL);
        else B.quad([X(ie), base, z, X(i), base, z, X(i), top, z, X(ie), top, z], [0, 0, -1], index, PART.WALL);
        i = ie;
      }
    }
  }

  // 지붕 장식: 가장 큰 사각형 기준
  let big = rectStart;
  let bigA = -1;
  for (let r = rectStart; r < rectStart + rectCount; r++) {
    const ar = (rects[r * 4 + 2] - rects[r * 4]) * (rects[r * 4 + 3] - rects[r * 4 + 1]);
    if (ar > bigA) {
      bigA = ar;
      big = r;
    }
  }
  const rx0 = x0 + rects[big * 4] * sub;
  const rz0 = z0 + rects[big * 4 + 1] * sub;
  const rx1 = x0 + rects[big * 4 + 2] * sub;
  const rz1 = z0 + rects[big * 4 + 3] * sub;
  const sx = rx1 - rx0;
  const sz = rz1 - rz0;
  const alongX = sx >= sz;
  const short = Math.min(sx, sz);
  if ((roof === ROOF.GABLE || roof === ROOF.DOME) && short >= 4) {
    // 계단식 박공: 짧은 축으로 안쪽으로 들어가며 두 단
    const steps = roof === ROOF.DOME ? [0.18, 0.36] : [0.2, 0.38];
    const dh = roof === ROOF.DOME ? 0.9 : Math.min(1.4, short * 0.14);
    steps.forEach((f, s) => {
      const ins = short * f;
      const y0 = top + dh * s;
      if (alongX) B.box(rx0, y0, rz0 + ins, rx1, y0 + dh, rz1 - ins, index, PART.ROOF);
      else B.box(rx0 + ins, y0, rz0, rx1 - ins, y0 + dh, rz1, index, PART.ROOF);
    });
  } else if (roof === ROOF.TANK_TOP && sx >= 10 && sz >= 7) {
    const cx = (rx0 + rx1) / 2;
    const cz = (rz0 + rz1) / 2;
    B.box(cx - 2.5, top, cz - 2, cx + 2.5, top + 3, cz + 2, index, PART.TOPBOX);
    if (Math.max(sx, sz) > 30) {
      const off = (Math.max(sx, sz) / 2) * 0.6;
      if (alongX) B.box(cx - off - 2, top, cz - 1.5, cx - off + 2, top + 2.5, cz + 1.5, index, PART.TOPBOX);
      else B.box(cx - 1.5, top, cz - off - 2, cx + 1.5, top + 2.5, cz - off + 2, index, PART.TOPBOX);
    }
  } else if (roof === ROOF.GREEN_TOP && sx >= 5 && sz >= 5) {
    B.box(rx0 + 0.4, top, rz0 + 0.4, rx0 + 3.0, top + 2.6, rz0 + 3.0, index, PART.WALL, PART.ROOF);
  } else if (roof === ROOF.SAWTOOTH && short >= 8) {
    const len = alongX ? sx : sz;
    for (let d = 2; d + 3 < len; d += 7) {
      if (alongX) B.box(rx0 + d, top, rz0 + 1, rx0 + d + 3, top + 1.6, rz1 - 1, index, PART.ROOF);
      else B.box(rx0 + 1, top, rz0 + d, rx1 - 1, top + 1.6, rz0 + d + 3, index, PART.ROOF);
    }
  }
  if (kind === BK.RELIGIOUS && short >= 4) {
    const cx = (rx0 + rx1) / 2;
    const cz = (rz0 + rz1) / 2;
    const y = top + (roof === ROOF.GABLE ? 2.8 : 0);
    B.box(cx - 0.3, y, cz - 0.3, cx + 0.3, y + 5.5, cz + 0.3, index, PART.CROSS);
    B.box(cx - 1.4, y + 3.4, cz - 0.3, cx + 1.4, y + 4.1, cz + 0.3, index, PART.CROSS);
  }
}
