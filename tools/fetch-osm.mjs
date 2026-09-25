// OpenStreetMap 원천 데이터 수집기.
// Overpass API에서 광명시 경계 bbox 안의 레이어를 종류별로 나눠 받아 data-raw/osm/*.json 에 저장한다.
// 한 서버가 과부하(429/504)이거나 런타임 오류(remark)를 돌려주면 다음 미러로 넘어가고, 전부 실패하면 비정상 종료한다.
//
// 사용법: node tools/fetch-osm.mjs [레이어명 ...]   (인자가 없으면 전체 레이어)
//         --force 를 주면 이미 받아 둔 파일도 다시 받는다.

import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data-raw', 'osm');

// 광명시(OSM relation 2409171) 경계 bbox + 약 300m 여유. south,west,north,east
export const BBOX = '37.398,126.822,37.499,126.904';
export const CITY_RELATION_ID = 2409171;

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const USER_AGENT = 'gm-city-voxel/0.1 (+https://github.com/jeiel85/gm-city)';

const LAYERS = {
  boundary: `[out:json][timeout:120];rel(${CITY_RELATION_ID});out body geom;`,
  districts: `[out:json][timeout:180];rel["boundary"="administrative"]["admin_level"="8"](${BBOX});out body geom;`,
  buildings: `[out:json][timeout:240];(way["building"](${BBOX});relation["building"](${BBOX}););out body geom qt;`,
  highways: `[out:json][timeout:240];way["highway"](${BBOX});out body geom qt;`,
  railways: `[out:json][timeout:240];(way["railway"](${BBOX});node["railway"](${BBOX});node["public_transport"](${BBOX}););out body geom qt;`,
  routes: `[out:json][timeout:240];relation["route"~"^(subway|train|railway|light_rail|bus)$"](${BBOX});out body geom qt;`,
  water: `[out:json][timeout:240];(way["waterway"](${BBOX});way["natural"="water"](${BBOX});relation["natural"="water"](${BBOX});way["landuse"="reservoir"](${BBOX}););out body geom qt;`,
  landcover: `[out:json][timeout:240];(way["natural"](${BBOX});way["landuse"](${BBOX});way["leisure"](${BBOX});way["amenity"](${BBOX});relation["landuse"](${BBOX});relation["natural"](${BBOX});relation["leisure"](${BBOX});relation["amenity"](${BBOX}););out body geom qt;`,
  pois: `[out:json][timeout:240];(node["place"](${BBOX});node["natural"="peak"](${BBOX});node["amenity"](${BBOX});node["tourism"](${BBOX});node["highway"="bus_stop"](${BBOX});node["shop"~"^(mall|department_store|supermarket)$"](${BBOX});node["historic"](${BBOX});way["tourism"](${BBOX});way["historic"](${BBOX}););out body geom qt;`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function queryOnce(endpoint, query) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`JSON 아님: ${text.slice(0, 200).replace(/\s+/g, ' ')}`);
  }
  if (!Array.isArray(json.elements)) throw new Error('elements 배열 없음');
  // Overpass는 타임아웃·메모리 초과 시에도 200과 함께 remark 를 준다. 이 경우 결과가 잘려 있으므로 실패로 본다.
  if (typeof json.remark === 'string' && /error|timed out|out of memory/i.test(json.remark)) {
    throw new Error(`런타임 오류: ${json.remark}`);
  }
  return { json, bytes: text.length };
}

async function fetchLayer(name, query) {
  const errors = [];
  for (let round = 0; round < 3; round++) {
    for (const ep of ENDPOINTS) {
      try {
        const { json, bytes } = await queryOnce(ep, query);
        json.gmCity = { layer: name, endpoint: ep, fetchedAt: new Date().toISOString(), query };
        await writeFile(join(OUT_DIR, `${name}.json`), JSON.stringify(json));
        console.log(`[ok]   ${name}: ${json.elements.length} elements, ${(bytes / 1e6).toFixed(1)} MB via ${new URL(ep).host}`);
        return;
      } catch (err) {
        errors.push(`${new URL(ep).host}: ${err.message}`);
        console.warn(`[fail] ${name} via ${new URL(ep).host}: ${err.message}`);
      }
    }
    await sleep(15_000 * (round + 1));
  }
  throw new Error(`${name} 수집 실패\n  ${errors.join('\n  ')}`);
}

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const wanted = args.filter((a) => !a.startsWith('--'));
  const names = wanted.length ? wanted : Object.keys(LAYERS);
  for (const n of names) if (!LAYERS[n]) throw new Error(`알 수 없는 레이어: ${n} (가능: ${Object.keys(LAYERS).join(', ')})`);

  await mkdir(OUT_DIR, { recursive: true });
  const failed = [];
  for (const name of names) {
    const out = join(OUT_DIR, `${name}.json`);
    if (!force && (await exists(out))) {
      console.log(`[skip] ${name}: 이미 있음 (--force 로 재수집)`);
      continue;
    }
    try {
      await fetchLayer(name, LAYERS[name]);
    } catch (err) {
      console.error(err.message);
      failed.push(name);
    }
    await sleep(2_000);
  }
  if (failed.length) {
    console.error(`실패한 레이어: ${failed.join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
