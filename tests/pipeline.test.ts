import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BK, LC } from '../src/data/codes.ts';
import { areaLandCover, roadLandCover } from '../tools/pipeline/landcover.ts';
import { classifyBuilding, normName, roofFor } from '../tools/pipeline/buildings.ts';
import { checkHistory } from '../tools/pipeline/cell-history.ts';
import { chainWays } from '../tools/pipeline/network.ts';
import { RC } from '../src/data/codes.ts';

test('areaLandCover: 주요 태그 매핑', () => {
  assert.equal(areaLandCover({ natural: 'wood' }), LC.FOREST);
  assert.equal(areaLandCover({ landuse: 'residential' }), LC.RESIDENTIAL);
  assert.equal(areaLandCover({ amenity: 'school' }), LC.SCHOOLYARD);
  assert.equal(areaLandCover({ natural: 'water', water: 'river' }), LC.WATER);
  assert.equal(areaLandCover({ landuse: 'farmland', crop: 'rice' }), LC.PADDY);
  assert.equal(areaLandCover({ building: 'yes' }), null);
  assert.equal(roadLandCover(RC.MOTORWAY), LC.ROAD_MOTORWAY);
  assert.equal(roadLandCover(RC.FOOTWAY), LC.PATH);
});

test('classifyBuilding: 태그·층수·면적·주변 피복으로 종류 결정', () => {
  assert.equal(classifyBuilding({ building: 'apartments' }, 15, 800, LC.RESIDENTIAL), BK.APARTMENT);
  assert.equal(classifyBuilding({ building: 'apartments' }, 4, 200, LC.RESIDENTIAL), BK.VILLA);
  assert.equal(classifyBuilding({ building: 'yes' }, 0, 100, LC.RESIDENTIAL), BK.HOUSE);
  assert.equal(classifyBuilding({ building: 'yes' }, 0, 3000, LC.INDUSTRIAL), BK.INDUSTRIAL);
  assert.equal(classifyBuilding({ building: 'yes', name: '이케아 광명점' }, 0, 50000, LC.COMMERCIAL), BK.BIGBOX);
  assert.equal(classifyBuilding({ building: 'church' }, 0, 300, LC.RESIDENTIAL), BK.RELIGIOUS);
  assert.ok(roofFor(BK.VILLA, 0.1) !== roofFor(BK.VILLA, 0.9));
});

test('normName: 공백·괄호 제거', () => {
  assert.equal(normName('철산 래미안자이 (재건축)'), '철산래미안자이');
});

test('checkHistory: 불변식 위반을 잡는다', () => {
  const ok = { lc0: Uint8Array.of(4), lc1: Uint8Array.of(11), lc2: Uint8Array.of(11), y1: Uint16Array.of(1985), y2: Uint16Array.of(0) };
  assert.doesNotThrow(() => checkHistory(ok, 1960, 2035));
  const bad1 = { ...ok, lc2: Uint8Array.of(12) };
  assert.throws(() => checkHistory(bad1, 1960, 2035));
  const bad2 = { ...ok, y2: Uint16Array.of(1980), lc2: Uint8Array.of(26) };
  assert.throws(() => checkHistory(bad2, 1960, 2035));
  const bad3 = { ...ok, y1: Uint16Array.of(1950) };
  assert.throws(() => checkHistory(bad3, 1960, 2035));
});

test('chainWays: 뒤집힌 조각도 이어 붙이고 겹치는 끝점은 한 번만', () => {
  const { pts, tags } = chainWays([
    { pts: [[0, 0], [10, 0]], tag: 1 },
    { pts: [[20, 0], [10, 0]], tag: 2 },
    { pts: [[20, 0], [30, 0]], tag: 3 },
  ]);
  assert.deepEqual(pts, [[0, 0], [10, 0], [20, 0], [30, 0]]);
  assert.deepEqual(tags, [1, 1, 2, 3]);
});

test('chainWays: 첫 조각이 반대로 놓여 있으면 뒤집는다', () => {
  const { pts } = chainWays([
    { pts: [[10, 0], [0, 0]], tag: 1 },
    { pts: [[10, 0], [20, 0]], tag: 2 },
  ]);
  assert.deepEqual(pts, [[0, 0], [10, 0], [20, 0]]);
});
