// 파이프라인 결과 확인용: public/data 를 읽어 연도별 평면도 PNG 를 그린다.
// 사용법: node tools/dev/preview.ts <출력폴더> [연도 ...]   (기본 1965 1985 2000 2015 2026 2032)
// 색: 토지피복(LC_INFO) × 음영기복, 건물은 종류별 색(공사 중은 주황 테두리 느낌의 밝은 색), 철도·버스 경로 선.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { decodePack } from '../../src/data/pack.ts';
import { landCoverAt, constructionStartOf, type BuildingsArrays, type BuildingsMeta, type NetworkArrays, type NetworkMeta, type WorldArrays, type WorldMeta } from '../../src/data/format.ts';
import { LC_INFO, MASK } from '../../src/data/codes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DATA = join(ROOT, 'public', 'data');

const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const KIND_COLOR: [number, number, number][] = [
  [240, 236, 226], [196, 120, 96], [170, 90, 70], [120, 150, 220], [90, 110, 170], [110, 140, 200],
  [240, 180, 90], [200, 120, 200], [255, 255, 255], [60, 60, 60], [230, 90, 90], [40, 90, 200],
  [235, 240, 235], [150, 110, 70], [140, 140, 140], [150, 150, 150],
];

function main() {
  const [outDir, ...yearArgs] = process.argv.slice(2);
  if (!outDir) throw new Error('사용법: node tools/dev/preview.ts <출력폴더> [연도 ...]');
  const years = yearArgs.length ? yearArgs.map(Number) : [1965, 1985, 2000, 2015, 2026, 2032];
  mkdirSync(outDir, { recursive: true });

  const w = decodePack<WorldMeta>(readFileSync(join(DATA, 'world.gmc')));
  const W = w.meta.width;
  const H = w.meta.height;
  const a = w.arrays as unknown as WorldArrays;
  const b = decodePack<BuildingsMeta>(readFileSync(join(DATA, 'buildings.gmc')));
  const ba = b.arrays as unknown as BuildingsArrays;
  const n = decodePack<NetworkMeta>(readFileSync(join(DATA, 'network.gmc')));
  const na = n.arrays as unknown as NetworkArrays;
  const ratio = w.meta.cellSize / w.meta.subSize;

  // 음영기복(북서쪽 빛)
  const shade = new Float32Array(W * H);
  for (let j = 0; j < H; j++)
    for (let i = 0; i < W; i++) {
      const k = j * W + i;
      const hx = a.height[j * W + Math.min(W - 1, i + 1)] - a.height[j * W + Math.max(0, i - 1)];
      const hz = a.height[Math.min(H - 1, j + 1) * W + i] - a.height[Math.max(0, j - 1) * W + i];
      shade[k] = Math.max(0.6, Math.min(1.25, 1 + (-hx - hz) * 0.006));
    }

  for (const year of years) {
    const png = new PNG({ width: W, height: H });
    for (let k = 0; k < W * H; k++) {
      const m = a.mask[k];
      let c: [number, number, number] = [30, 30, 36];
      if (m !== MASK.VOID) {
        const lc = landCoverAt(a, k, year);
        c = hex(LC_INFO[lc]?.color ?? '#ff00ff');
        const s = shade[k];
        c = [c[0] * s, c[1] * s, c[2] * s];
        if (m === MASK.MARGIN) c = [c[0] * 0.35 + 150, c[1] * 0.35 + 146, c[2] * 0.35 + 140];
      }
      png.data[k * 4] = Math.min(255, c[0]);
      png.data[k * 4 + 1] = Math.min(255, c[1]);
      png.data[k * 4 + 2] = Math.min(255, c[2]);
      png.data[k * 4 + 3] = 255;
    }
    let shown = 0;
    let building = 0;
    for (let i = 0; i < b.meta.count; i++) {
      const built = ba.built[i];
      const removed = ba.removed[i];
      const cs = constructionStartOf(ba, i);
      if (cs !== 0 && year < cs) continue;
      if (removed !== 0 && year >= removed) continue;
      const underConstruction = built !== 0 && year < built;
      if (underConstruction) building++;
      else shown++;
      const col = underConstruction ? [255, 150, 40] : KIND_COLOR[ba.kind[i]] ?? [255, 0, 255];
      const r0 = ba.rectStart[i];
      for (let r = r0; r < r0 + ba.rectCount[i]; r++) {
        const sx0 = ba.rects[r * 4] / ratio;
        const sz0 = ba.rects[r * 4 + 1] / ratio;
        const sx1 = ba.rects[r * 4 + 2] / ratio;
        const sz1 = ba.rects[r * 4 + 3] / ratio;
        for (let z = Math.floor(sz0); z < Math.ceil(sz1); z++)
          for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
            if (x < 0 || z < 0 || x >= W || z >= H) continue;
            const k = z * W + x;
            png.data[k * 4] = col[0];
            png.data[k * 4 + 1] = col[1];
            png.data[k * 4 + 2] = col[2];
          }
      }
    }
    // 철도 경로
    for (const line of n.meta.lines) {
      if (line.opened > year) continue;
      const col = hex(line.color);
      for (const p of line.paths)
        for (let q = p.start; q < p.start + p.count; q++) {
          const x = Math.floor((na.pathPts[q * 3] - w.meta.x0) / w.meta.cellSize);
          const z = Math.floor((na.pathPts[q * 3 + 2] - w.meta.z0) / w.meta.cellSize);
          const under = na.pathLevel[q] < 0;
          for (let dz = -1; dz <= 1; dz++)
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              const zz = z + dz;
              if (xx < 0 || zz < 0 || xx >= W || zz >= H) continue;
              if (under && (dx + dz) % 2 !== 0) continue;
              const k = zz * W + xx;
              png.data[k * 4] = col[0];
              png.data[k * 4 + 1] = col[1];
              png.data[k * 4 + 2] = col[2];
            }
        }
    }
    const file = join(outDir, `preview-${year}.png`);
    writeFileSync(file, PNG.sync.write(png));
    console.log(`${file}: 건물 ${shown}동 + 공사 중 ${building}동`);
  }
}

main();
