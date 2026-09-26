// 개발용: 파이프라인을 지정 단계까지 돌리고 현재 토지피복(lcNow)과 건물 발자국을 PNG 로 그린다.
// 사용법: node tools/dev/grid-png.ts <출력.png> [단계=landcover] [축소배율=2]

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { createContext, runStages, type StageName } from '../pipeline/run.ts';
import { LC_INFO, MASK } from '../../src/data/codes.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const [out, until = 'landcover', scaleArg = '2'] = process.argv.slice(2);
if (!out) throw new Error('사용법: node tools/dev/grid-png.ts <출력.png> [단계] [축소배율]');
const S = Number(scaleArg);

const ctx = createContext(ROOT);
runStages(ctx, until as StageName, false);
const g = ctx.grid;
const { w, h } = g.spec;
const W = Math.floor(w / S);
const H = Math.floor(h / S);
const png = new PNG({ width: W, height: H });
const hex = (s: string) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const k = y * S * w + x * S;
    let c = [30, 30, 36];
    if (g.mask[k] !== MASK.VOID) {
      c = hex(LC_INFO[g.lcNow[k]]?.color ?? '#ff00ff');
      const hx = g.height[Math.min(w * h - 1, k + 1)] - g.height[Math.max(0, k - 1)];
      const s = Math.max(0.6, Math.min(1.3, 1 - hx * 0.02));
      c = c.map((v) => v * s);
      if (g.mask[k] === MASK.MARGIN) c = c.map((v) => v * 0.4 + 140);
    }
    const o = (y * W + x) * 4;
    png.data[o] = Math.min(255, c[0]);
    png.data[o + 1] = Math.min(255, c[1]);
    png.data[o + 2] = Math.min(255, c[2]);
    png.data[o + 3] = 255;
  }
const ratio = g.spec.cell / ctx.cfg.subSize;
for (const b of ctx.buildings) {
  const col = b.removed ? [255, 120, 40] : b.flags & 1 ? [170, 80, 170] : [60, 60, 70];
  for (const [a0, b0, a1, b1] of b.rects)
    for (let z = Math.floor(b0 / ratio / S); z < Math.ceil(b1 / ratio / S); z++)
      for (let x = Math.floor(a0 / ratio / S); x < Math.ceil(a1 / ratio / S); x++) {
        if (x < 0 || z < 0 || x >= W || z >= H) continue;
        const o = (z * W + x) * 4;
        png.data[o] = col[0];
        png.data[o + 1] = col[1];
        png.data[o + 2] = col[2];
      }
}
writeFileSync(out, PNG.sync.write(png));
console.log(`${out} (${W}×${H})`);
