// 복셀 모델: 상자 목록 → 병합 BufferGeometry(정점색 + 속성).
// 원점 = 바닥 중심, +X = 진행 방향. 색 'SLOT' 은 인스턴스 색(instanceColor)으로 칠해진다.
// 속성: color(고정색, SLOT 이면 흰색), aSlot(1 = 인스턴스 색 곱), aSwing(걷기 흔들림: +1 앞다리/팔, −1 반대), aLamp(1 전조등, 2 미등, 3 창문 불빛)

import { BufferAttribute, BufferGeometry, Color } from 'three';

export const SLOT = 'slot';
type Box = [number, number, number, number, number, number, string, number?, number?];
// [x0, y0, z0, x1, y1, z1, 색 | SLOT, swing?, lamp?]

export function buildModel(boxes: Box[], scale = 1): BufferGeometry {
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const slot: number[] = [];
  const swing: number[] = [];
  const lamp: number[] = [];
  const idx: number[] = [];
  const c = new Color();
  const face = (v: number[], n: [number, number, number], color: string, sw: number, lp: number) => {
    const b = pos.length / 3;
    const isSlot = color === SLOT;
    c.set(isSlot ? '#ffffff' : color);
    for (let k = 0; k < 12; k += 3) {
      pos.push(v[k] * scale, v[k + 1] * scale, v[k + 2] * scale);
      nrm.push(...n);
      col.push(c.r, c.g, c.b);
      slot.push(isSlot ? 1 : 0);
      swing.push(sw);
      lamp.push(lp);
    }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  for (const [x0, y0, z0, x1, y1, z1, color, sw = 0, lp = 0] of boxes) {
    face([x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0], [0, 1, 0], color, sw, lp);
    face([x1, y0, z1, x1, y0, z0, x1, y1, z0, x1, y1, z1], [1, 0, 0], color, sw, lp);
    face([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0], [-1, 0, 0], color, sw, lp);
    face([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1], [0, 0, 1], color, sw, lp);
    face([x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0], [0, 0, -1], color, sw, lp);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('aSlot', new BufferAttribute(new Float32Array(slot), 1));
  g.setAttribute('aSwing', new BufferAttribute(new Float32Array(swing), 1));
  g.setAttribute('aLamp', new BufferAttribute(new Float32Array(lamp), 1));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

const GLASS = '#6f8fa8';
const TIRE = '#2b2b2e';

/** 사람(약 1.7m). 셔츠 = SLOT. */
export const PERSON: Box[] = [
  [-0.12, 0, -0.2, 0.12, 0.8, -0.03, '#3b4a6b', 1], // 다리
  [-0.12, 0, 0.03, 0.12, 0.8, 0.2, '#3b4a6b', -1],
  [-0.15, 0.8, -0.24, 0.15, 1.4, 0.24, SLOT],
  [-0.1, 0.85, -0.34, 0.1, 1.35, -0.24, SLOT, -1], // 팔
  [-0.1, 0.85, 0.24, 0.1, 1.35, 0.34, SLOT, 1],
  [-0.16, 1.4, -0.16, 0.16, 1.72, 0.16, '#f1c9a5'], // 머리
  [-0.18, 1.62, -0.18, 0.12, 1.78, 0.18, '#2a211c'], // 머리카락
];

const car = (len: number, w: number, h: number, cabin: [number, number], body: string): Box[] => [
  [-len / 2, 0.35, -w / 2, len / 2, h * 0.55, w / 2, body],
  [cabin[0], h * 0.55, -w / 2 + 0.1, cabin[1], h, w / 2 - 0.1, GLASS],
  [cabin[0] + 0.15, h * 0.98, -w / 2 + 0.15, cabin[1] - 0.15, h * 1.02, w / 2 - 0.15, body],
  [len / 2 - 0.05, 0.55, -w / 2 + 0.15, len / 2 + 0.02, 0.8, -w / 2 + 0.45, '#fffbe0', 0, 1],
  [len / 2 - 0.05, 0.55, w / 2 - 0.45, len / 2 + 0.02, 0.8, w / 2 - 0.15, '#fffbe0', 0, 1],
  [-len / 2 - 0.02, 0.6, -w / 2 + 0.15, -len / 2 + 0.05, 0.8, -w / 2 + 0.4, '#c0302a', 0, 2],
  [-len / 2 - 0.02, 0.6, w / 2 - 0.4, -len / 2 + 0.05, 0.8, w / 2 - 0.15, '#c0302a', 0, 2],
  [len / 2 - 1.2, 0, -w / 2 - 0.02, len / 2 - 0.5, 0.6, w / 2 + 0.02, TIRE],
  [-len / 2 + 0.5, 0, -w / 2 - 0.02, -len / 2 + 1.2, 0.6, w / 2 + 0.02, TIRE],
];

export const SEDAN = car(4.6, 1.85, 1.45, [-1.2, 1.0], SLOT);
export const SUV = car(4.8, 1.95, 1.8, [-1.9, 1.1], SLOT);
export const TAXI: Box[] = [...car(4.7, 1.85, 1.45, [-1.2, 1.0], '#f0f0ea'), [-0.3, 1.45, -0.3, 0.3, 1.75, 0.3, '#f28c28']];
export const TRUCK: Box[] = [
  [0.9, 0.4, -1.0, 3.0, 2.4, 1.0, SLOT],
  [2.2, 1.4, -0.95, 3.02, 2.2, 0.95, GLASS],
  [-3.0, 0.5, -1.1, 0.8, 2.9, 1.1, '#e8e4dc'],
  [2.95, 0.6, -0.9, 3.03, 0.9, -0.6, '#fffbe0', 0, 1],
  [2.95, 0.6, 0.6, 3.03, 0.9, 0.9, '#fffbe0', 0, 1],
  [-3.03, 0.7, -1.0, -2.98, 0.95, -0.7, '#c0302a', 0, 2],
  [-3.03, 0.7, 0.7, -2.98, 0.95, 1.0, '#c0302a', 0, 2],
  [1.8, 0, -1.05, 2.6, 0.7, 1.05, TIRE],
  [-2.4, 0, -1.15, -1.4, 0.7, 1.15, TIRE],
];

/** 시내버스 11m. 차체 = SLOT(노선색). */
export const BUS: Box[] = [
  [-5.5, 0.4, -1.25, 5.5, 3.1, 1.25, SLOT],
  [-5.2, 1.5, -1.27, 5.0, 2.5, 1.27, GLASS, 0, 3],
  [5.45, 1.2, -1.1, 5.52, 2.7, 1.1, GLASS],
  [-5.3, 3.1, -1.1, 5.3, 3.25, 1.1, '#e9e9e4'],
  [4.8, 2.55, -0.8, 5.52, 2.95, 0.8, '#222222', 0, 1],
  [5.47, 0.6, -1.1, 5.53, 0.9, -0.8, '#fffbe0', 0, 1],
  [5.47, 0.6, 0.8, 5.53, 0.9, 1.1, '#fffbe0', 0, 1],
  [-5.53, 0.7, -1.1, -5.47, 1.0, -0.8, '#c0302a', 0, 2],
  [-5.53, 0.7, 0.8, -5.47, 1.0, 1.1, '#c0302a', 0, 2],
  [3.2, 0, -1.3, 4.3, 0.8, 1.3, TIRE],
  [-4.0, 0, -1.3, -2.9, 0.8, 1.3, TIRE],
];

/** 전동차 한 량(20m). 띠 = SLOT(노선색). */
export const METRO_CAR: Box[] = [
  [-9.8, 0.6, -1.55, 9.8, 3.8, 1.55, '#d4d8dc'],
  [-9.5, 2.0, -1.57, 9.5, 3.0, 1.57, GLASS, 0, 3],
  [-9.8, 1.2, -1.58, 9.8, 1.7, 1.58, SLOT],
  [-9.6, 3.8, -1.2, 9.6, 4.0, 1.2, '#b5babf'],
  [-8.0, 0, -1.3, -6.0, 0.7, 1.3, TIRE],
  [6.0, 0, -1.3, 8.0, 0.7, 1.3, TIRE],
];

/** KTX 동력차(22m, 뾰족한 앞). 띠 = SLOT. */
export const KTX_HEAD: Box[] = [
  [-11, 0.6, -1.5, 5, 3.9, 1.5, '#f7f7f5'],
  [5, 0.6, -1.4, 8, 3.3, 1.4, '#f7f7f5'],
  [8, 0.6, -1.2, 10, 2.6, 1.2, '#f7f7f5'],
  [10, 0.6, -0.9, 11, 1.8, 0.9, '#f7f7f5'],
  [5.5, 2.4, -1.42, 8.2, 3.2, 1.42, '#2a3340'],
  [-11, 1.3, -1.52, 8, 1.8, 1.52, SLOT],
  [-10, 2.2, -1.52, 4, 2.9, 1.52, GLASS, 0, 3],
  [10.9, 0.9, -0.6, 11.05, 1.2, 0.6, '#fffbe0', 0, 1],
  [-9, 0, -1.3, -6.5, 0.7, 1.3, TIRE],
  [4, 0, -1.3, 6.5, 0.7, 1.3, TIRE],
];
export const KTX_CAR: Box[] = [
  [-11, 0.6, -1.5, 11, 3.9, 1.5, '#f7f7f5'],
  [-11, 1.3, -1.52, 11, 1.8, 1.52, SLOT],
  [-10.5, 2.2, -1.52, 10.5, 2.9, 1.52, GLASS, 0, 3],
  [-9, 0, -1.3, -6.5, 0.7, 1.3, TIRE],
  [6.5, 0, -1.3, 9, 0.7, 1.3, TIRE],
];
