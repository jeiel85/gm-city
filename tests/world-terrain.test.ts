import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshChunk, downsample, type HeightGrid } from '../src/world/terrain/mesher.ts';

function grid(w: number, h: number, tops: number[], mask?: number[]): HeightGrid {
  return { w, h, cell: 5, x0: 0, z0: 0, top: Int16Array.from(tops), mask: Uint8Array.from(mask ?? tops.map(() => 2)), base: -10 };
}

/** 면적 합(법선 방향별). */
function areas(m: ReturnType<typeof meshChunk>) {
  const out = { top: 0, side: 0 };
  for (let q = 0; q < m.indices.length; q += 6) {
    const a = m.indices[q];
    const b = m.indices[q + 1];
    const c = m.indices[q + 2];
    const P = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    const [pa, pb, pc] = [P(a), P(b), P(c)];
    const u = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
    const v = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const area = Math.hypot(cr[0], cr[1], cr[2]); // 사각형 = 삼각형 2개 = |u×v|
    // 삼각형 감김이 법선과 같은 방향인지(바깥을 향하는지) 확인
    const n = [m.normals[a * 3], m.normals[a * 3 + 1], m.normals[a * 3 + 2]];
    assert.ok(cr[0] * n[0] + cr[1] * n[1] + cr[2] * n[2] > 0, '감김 방향이 법선과 같아야 한다');
    if (n[1] > 0) out.top += area;
    else out.side += area;
  }
  return out;
}

test('평평한 격자는 윗면 1개로 병합되고 사방 단면만 생긴다', () => {
  const g = grid(4, 3, Array(12).fill(10));
  const m = meshChunk(g, 0, 0, 4, 3);
  const a = areas(m);
  assert.equal(a.top, 4 * 3 * 25);
  // 둘레 (4+3)*2 셀 × 5m × 높이 20m(10 - (-10))
  assert.equal(a.side, (4 + 3) * 2 * 5 * 20);
  assert.equal(m.indices.length / 6, 1 + 4);
});

test('계단: 높은 셀은 차이만큼 벽을 가지고 윗면 면적은 셀 면적 합과 같다', () => {
  const g = grid(2, 1, [5, 8]);
  const a = areas(meshChunk(g, 0, 0, 2, 1));
  assert.equal(a.top, 2 * 25);
  // 단면: 서쪽 15, 동쪽 18, 남북 각각 (15+18)*5 … 그리고 내부 계단 벽 3m
  const skirt = 5 * 15 + 5 * 18 + 2 * (5 * 15 + 5 * 18);
  assert.equal(a.side, skirt + 5 * 3);
});

test('마스크 밖 셀은 그리지 않고 그쪽으로 단면이 생긴다', () => {
  const g = grid(3, 1, [4, 4, 4], [2, 0, 2]);
  const a = areas(meshChunk(g, 0, 0, 3, 1));
  assert.equal(a.top, 2 * 25);
});

test('청크로 나눠 만든 면적 합 = 한 번에 만든 면적', () => {
  const tops = Array.from({ length: 64 }, (_, k) => (k * 7) % 5);
  const g = grid(8, 8, tops);
  const whole = areas(meshChunk(g, 0, 0, 8, 8));
  const parts = [meshChunk(g, 0, 0, 4, 8), meshChunk(g, 4, 0, 8, 8)].map(areas);
  assert.equal(parts[0].top + parts[1].top, whole.top);
  assert.equal(parts[0].side + parts[1].side, whole.side);
});

test('downsample: 2×2 최대 높이, 마스크 유지', () => {
  const d = downsample(grid(2, 2, [1, 2, 3, 4], [2, 2, 0, 2]));
  assert.equal(d.w, 1);
  assert.equal(d.top[0], 4);
  assert.equal(d.mask[0], 2);
  assert.equal(d.cell, 10);
});
