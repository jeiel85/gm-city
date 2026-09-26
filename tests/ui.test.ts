import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossedEvents, layersToBits, readUrlState, timeLabel, writeUrlState, yearLabel } from '../src/ui/url-state.ts';
import { DEFAULT_STATE } from '../src/core/state.ts';
import { computeSky, approachYear } from '../src/engine/sky.ts';
import { eraFactor, hourFactor, personName, signalGreen, Polyline } from '../src/sim/paths.ts';

test('URL 상태 왕복과 잘못된 값 무시', () => {
  const cam = { x: 120, z: -340, distance: 800, azimuth: 45, polar: 50 };
  const q = writeUrlState({ ...DEFAULT_STATE, year: 2004, timeOfDay: 18.5 }, cam);
  const r = readUrlState(q);
  assert.equal(r.state.year, 2004);
  assert.equal(r.state.timeOfDay, 18.5);
  assert.deepEqual(r.camera, cam);
  assert.equal(layersToBits(r.state.layers!), layersToBits(DEFAULT_STATE.layers));
  const bad = readUrlState('?y=abc&t=&cam=1,2,3&l=-1');
  assert.deepEqual(bad.state, {});
  assert.equal(bad.camera, undefined);
  assert.equal(readUrlState('?y=1800').state.year, 1960);
});

test('표시 문자열', () => {
  assert.equal(timeLabel(16.5), '오후 4:30');
  assert.equal(timeLabel(0), '오전 12:00');
  assert.deepEqual(yearLabel(2027.4, 2026), { text: '2027', planned: true });
});

test('지나친 사건', () => {
  assert.deepEqual(crossedEvents([1970, 1981, 2004], 1979.5, 1985), [1]);
  assert.deepEqual(crossedEvents([1970, 1981, 2004], 2005, 1990), []);
});

test('하늘: 정오는 밝고 자정은 어둡다, 태양은 정오에 높다', () => {
  const noon = computeSky(12.5);
  const night = computeSky(0);
  assert.ok(noon.daylight > 0.9 && night.daylight < 0.05);
  assert.ok(night.night > 0.9);
  assert.ok(noon.sunDir[1] > 0.6);
  assert.ok(Math.abs(Math.hypot(...noon.sunDir) - 1) < 1e-6);
});

test('연도 추종은 목표를 넘지 않는다', () => {
  let y = 1990;
  for (let i = 0; i < 200; i++) y = approachYear(y, 2020, 1 / 60);
  assert.ok(y <= 2020 && y > 2019.9);
});

test('시뮬레이션 보조 함수', () => {
  assert.ok(eraFactor(1960) < eraFactor(1990) && eraFactor(1990) < eraFactor(2026));
  assert.ok(hourFactor(8) > hourFactor(3));
  assert.equal(personName(42), personName(42));
  // 동서 방향과 남북 방향은 동시에 녹색이 아니다
  for (let t = 0; t < 30; t += 0.5) assert.ok(!(signalGreen(0, t, 0) && signalGreen(Math.PI / 2, t, 0)));
});

test('Polyline: 거리 샘플·오른쪽 오프셋·역방향', () => {
  const pl = new Polyline([0, 0, 0, 10, 0, 0, 10, 0, 10], 0, 3);
  assert.equal(pl.length, 20);
  const o = [0, 0, 0, 0];
  pl.sample(5, 1, o);
  assert.deepEqual([o[0], o[2]], [5, 1]); // 동쪽 진행 → 오른쪽은 남(+Z)
  pl.sample(15, 0, o);
  assert.deepEqual([o[0], o[2]], [10, 5]);
  pl.sample(5, 0, o, true);
  assert.deepEqual([o[0], o[2]], [10, 5]);
});
