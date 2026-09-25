// data-raw/elevation (tools/fetch-elevation.mjs 결과)를 읽어 로컬 좌표 고도 샘플러를 만든다.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unproject } from '../../src/data/geo.ts';
import type { Elevation } from '../pipeline/context.ts';

interface ElevationMeta {
  zoom: number;
  tileX0: number;
  tileY0: number;
  width: number;
  height: number;
}

export function loadElevation(rawDir: string): Elevation {
  const dir = join(rawDir, 'elevation');
  let meta: ElevationMeta;
  let buf: Buffer;
  try {
    meta = JSON.parse(readFileSync(join(dir, 'elevation.json'), 'utf8')) as ElevationMeta;
    buf = readFileSync(join(dir, 'elevation.bin'));
  } catch {
    throw new Error(`${dir} 에 고도 자료가 없습니다 — node tools/fetch-elevation.mjs 를 먼저 실행하세요`);
  }
  const data = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  if (data.length !== meta.width * meta.height) throw new Error('elevation.bin 크기가 메타데이터와 다릅니다');
  const n = 2 ** meta.zoom;
  const at = (px: number, py: number) => {
    const x = px < 0 ? 0 : px >= meta.width ? meta.width - 1 : px;
    const y = py < 0 ? 0 : py >= meta.height ? meta.height - 1 : py;
    return data[y * meta.width + x];
  };
  return {
    sample(x: number, z: number): number {
      const [lat, lon] = unproject(x, z);
      const tx = ((lon + 180) / 360) * n;
      const r = (lat * Math.PI) / 180;
      const ty = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n;
      // 픽셀 중심 기준 좌표
      const fx = (tx - meta.tileX0) * 256 - 0.5;
      const fy = (ty - meta.tileY0) * 256 - 0.5;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const h00 = at(x0, y0);
      const h10 = at(x0 + 1, y0);
      const h01 = at(x0, y0 + 1);
      const h11 = at(x0 + 1, y0 + 1);
      return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    },
  };
}
