import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodePack, decodePack } from '../src/data/pack.ts';
import { project, unproject, ORIGIN } from '../src/data/geo.ts';
import { landCoverAt } from '../src/data/format.ts';
import { fillRings, greedyRects, strokePolyline, type GridSpec } from '../tools/lib/raster.ts';
import { assembleRings } from '../tools/lib/osm.ts';
import { clipPolylineToRings, offsetPolyline, pointInRings, type Ring } from '../tools/lib/geom.ts';
import { roadClass, roadLevel, roadOneway, roadWidth } from '../tools/lib/roads.ts';
import { RC } from '../src/data/codes.ts';

test('pack: 메타와 모든 타입 배열이 그대로 왕복한다', () => {
  const arrays = {
    a: new Uint8Array([1, 2, 3]),
    b: new Int16Array([-5, 300, 32767]),
    c: new Float32Array([1.5, -2.25]),
    d: new Float64Array([123456789012, 0.1]),
    e: new Uint32Array([4294967295]),
    f: new Int8Array([-128, 127]),
  };
  const bytes = encodePack({ hello: '광명', n: 3 }, arrays);
  const { meta, arrays: out } = decodePack<{ hello: string; n: number }>(bytes);
  assert.deepEqual(meta, { hello: '광명', n: 3 });
  for (const [k, v] of Object.entries(arrays)) {
    assert.equal(out[k].constructor, v.constructor, k);
    assert.deepEqual(Array.from(out[k]), Array.from(v), k);
  }
});

test('pack: 손상된 입력은 예외', () => {
  const bytes = encodePack({}, { a: new Uint8Array(4) });
  const bad = bytes.slice(0, bytes.length - 3);
  assert.throws(() => decodePack(bad));
});

test('geo: 원점은 (0,0), 투영-역투영 왕복 오차 1mm 미만, 북쪽은 -Z', () => {
  assert.deepEqual(project(ORIGIN.lat, ORIGIN.lon).map((v) => Math.abs(v) < 1e-9), [true, true]);
  const [x, z] = project(37.4789, 126.8646); // 철산역 부근
  const [lat, lon] = unproject(x, z);
  assert.ok(Math.abs(lat - 37.4789) < 1e-8 && Math.abs(lon - 126.8646) < 1e-8);
  assert.ok(z < 0, '원점보다 북쪽이면 z 가 음수');
  // 위도 0.01도 ≈ 1109m
  const [, z2] = project(ORIGIN.lat + 0.01, ORIGIN.lon);
  assert.ok(Math.abs(-z2 - 1109.9) < 2);
});

test('landCoverAt: 3단계 이력 선택', () => {
  const a = { lc0: Uint8Array.of(4), lc1: Uint8Array.of(11), lc2: Uint8Array.of(26), y1: Uint16Array.of(1975), y2: Uint16Array.of(2028) };
  assert.equal(landCoverAt(a, 0, 1960), 4);
  assert.equal(landCoverAt(a, 0, 1975), 11);
  assert.equal(landCoverAt(a, 0, 2027.9), 11);
  assert.equal(landCoverAt(a, 0, 2028), 26);
  const none = { lc0: Uint8Array.of(2), lc1: Uint8Array.of(2), lc2: Uint8Array.of(2), y1: Uint16Array.of(0), y2: Uint16Array.of(0) };
  assert.equal(landCoverAt(none, 0, 2035), 2);
});

test('fillRings: 사각형은 셀 중심 기준으로 정확히 채워지고 구멍은 빠진다', () => {
  const g: GridSpec = { w: 10, h: 10, x0: 0, z0: 0, cell: 1 };
  const outer: Ring = [
    [2, 2],
    [8, 2],
    [8, 8],
    [2, 8],
  ];
  const hole: Ring = [
    [4, 4],
    [6, 4],
    [6, 6],
    [4, 6],
  ];
  const cells = new Set<number>();
  fillRings(g, [outer, hole], (i, j) => cells.add(j * 10 + i));
  assert.equal(cells.size, 36 - 4);
  assert.ok(cells.has(2 * 10 + 2));
  assert.ok(!cells.has(4 * 10 + 4));
  assert.ok(!cells.has(8 * 10 + 8));
});

test('greedyRects: 분해 결과의 합집합이 마스크와 같고 겹치지 않는다', () => {
  const w = 7;
  const h = 5;
  const mask = new Uint8Array(w * h);
  const on = [
    [0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [3, 1], [5, 2], [5, 3], [6, 3], [1, 4],
  ];
  for (const [i, j] of on) mask[j * w + i] = 1;
  const rects = greedyRects(mask, w, h);
  const cover = new Uint8Array(w * h);
  for (const [i0, j0, i1, j1] of rects) for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) cover[j * w + i]++;
  assert.deepEqual(Array.from(cover), Array.from(mask));
});

test('strokePolyline: 대각선도 끊김 없이 칠한다', () => {
  const g: GridSpec = { w: 20, h: 20, x0: 0, z0: 0, cell: 1 };
  const hit = new Uint8Array(400);
  strokePolyline(g, [[1, 1], [18, 18]], 0.3, (i, j) => (hit[j * 20 + i] = 1));
  // 끝점 (18,18) 은 셀 18 의 모서리라 셀 18 중심은 선분 밖이다 → 1..17 만 대각 셀.
  for (let k = 1; k < 18; k++) assert.equal(hit[k * 20 + k], 1, `대각 셀 ${k}`);
  // 4방향 연결: 대각으로 이웃한 두 셀 사이의 옆 셀 중 하나는 칠해져 있어야 한다.
  for (let k = 1; k < 17; k++) assert.ok(hit[k * 20 + k + 1] || hit[(k + 1) * 20 + k], `연결 ${k}`);
});

test('assembleRings: 조각난 경계 way 를 닫힌 링으로 잇는다(역방향 조각 포함)', () => {
  const rings = assembleRings([
    [[0, 0], [10, 0]],
    [[10, 10], [10, 0]],
    [[10, 10], [0, 10], [0, 0]],
  ]);
  assert.equal(rings.length, 1);
  assert.equal(rings[0].length, 4);
});

test('clipPolylineToRings: 경계에서 잘린 조각만 남긴다', () => {
  const sq: Ring = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
  ];
  const parts = clipPolylineToRings([[-5, 5], [5, 5], [15, 5]], [sq]);
  assert.equal(parts.length, 1);
  assert.deepEqual(parts[0].map((p) => p.map((v) => Math.round(v))), [[0, 5], [5, 5], [10, 5]]);
  assert.ok(pointInRings(5, 5, [sq]));
});

test('offsetPolyline: 동쪽으로 가는 선의 오른쪽은 남쪽(+Z)', () => {
  const out = offsetPolyline([[0, 0], [10, 0]], 2);
  assert.deepEqual(out.map((p) => p.map((v) => Math.round(v * 100) / 100)), [[0, 2], [10, 2]]);
});

test('roads: 등급·폭·일방·높이 단계', () => {
  assert.equal(roadClass({ highway: 'primary' }), RC.PRIMARY);
  assert.equal(roadClass({ highway: 'construction' }), null);
  assert.equal(roadWidth({ highway: 'secondary', lanes: '4' }, RC.SECONDARY), 4 * 3.3 + 1);
  assert.equal(roadOneway({ highway: 'motorway' }, RC.MOTORWAY), 1);
  assert.equal(roadOneway({ highway: 'residential', oneway: '-1' }, RC.RESIDENTIAL), -1);
  assert.equal(roadLevel({ highway: 'primary', bridge: 'yes', layer: '2' }), 2);
  assert.equal(roadLevel({ highway: 'primary', tunnel: 'yes', layer: '-1' }), -1);
});
