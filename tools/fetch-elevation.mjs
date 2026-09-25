// 지형 고도 수집기.
// AWS Open Data "Terrain Tiles"(Terrarium 인코딩 PNG)에서 광명시 bbox를 덮는 타일을 받아
// data-raw/elevation/ 에 원본 PNG를 캐시하고, 하나로 이어 붙인 고도 격자(Float32, 미터)를 elevation.bin + elevation.json 으로 저장한다.
// Terrarium 복호: height = (R * 256 + G + B / 256) - 32768
//
// 사용법: node tools/fetch-elevation.mjs [--zoom 14] [--force]

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'data-raw', 'elevation');
const TILE_URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;

// fetch-osm.mjs 의 BBOX 와 같은 범위 (south, west, north, east)
const BBOX = { south: 37.398, west: 126.822, north: 37.499, east: 126.904 };

const argv = process.argv.slice(2);
const ZOOM = Number(argv[argv.indexOf('--zoom') + 1]) || 14;
const FORCE = argv.includes('--force');

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function getTile(z, x, y) {
  const cache = join(OUT_DIR, `${z}_${x}_${y}.png`);
  if (!FORCE && (await exists(cache))) return readFile(cache);
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(TILE_URL(z, x, y), { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      await writeFile(cache, buf);
      return buf;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error(`타일 ${z}/${x}/${y} 수집 실패: ${lastErr.message}`);
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const x0 = Math.floor(lon2x(BBOX.west, ZOOM));
  const x1 = Math.floor(lon2x(BBOX.east, ZOOM));
  const y0 = Math.floor(lat2y(BBOX.north, ZOOM));
  const y1 = Math.floor(lat2y(BBOX.south, ZOOM));
  const tilesX = x1 - x0 + 1;
  const tilesY = y1 - y0 + 1;
  const width = tilesX * 256;
  const height = tilesY * 256;
  const heights = new Float32Array(width * height);
  console.log(`zoom ${ZOOM}: 타일 ${tilesX}×${tilesY} (${width}×${height} px)`);

  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const png = PNG.sync.read(await getTile(ZOOM, tx, ty));
      if (png.width !== 256 || png.height !== 256) throw new Error(`예상치 못한 타일 크기 ${png.width}×${png.height}`);
      const ox = (tx - x0) * 256;
      const oy = (ty - y0) * 256;
      for (let py = 0; py < 256; py++) {
        for (let px = 0; px < 256; px++) {
          const i = (py * 256 + px) * 4;
          const h = png.data[i] * 256 + png.data[i + 1] + png.data[i + 2] / 256 - 32768;
          heights[(oy + py) * width + (ox + px)] = h;
        }
      }
    }
  }

  let min = Infinity;
  let max = -Infinity;
  for (const h of heights) {
    if (h < min) min = h;
    if (h > max) max = h;
  }

  // 픽셀 (px, py) 의 중심 좌표 = 타일 좌표 (x0 + (px+0.5)/256, y0 + (py+0.5)/256) 를 경위도로 역변환해서 쓰면 된다.
  const meta = {
    source: 'AWS Terrain Tiles (Terrarium), https://registry.opendata.aws/terrain-tiles/',
    zoom: ZOOM,
    tileX0: x0,
    tileY0: y0,
    tilesX,
    tilesY,
    width,
    height,
    minMeters: min,
    maxMeters: max,
    format: 'Float32Array little-endian, row-major, row 0 = north',
  };
  await writeFile(join(OUT_DIR, 'elevation.bin'), Buffer.from(heights.buffer));
  await writeFile(join(OUT_DIR, 'elevation.json'), JSON.stringify(meta, null, 2));
  console.log(`[ok] 고도 범위 ${min.toFixed(1)}m ~ ${max.toFixed(1)}m 저장`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
