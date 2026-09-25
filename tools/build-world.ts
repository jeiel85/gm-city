// 데이터 파이프라인 진입점: data-raw(OSM·고도) + data-src(조사 자료) → public/data/*.gmc, history.json
// 사용법: node tools/build-world.ts [--until <단계>]   (npm run data:build)
//   --until 을 주면 그 단계까지만 실행하고 통계만 출력한다(파일 기록 안 함).

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runStages, STAGES, type StageName } from './pipeline/run.ts';
import { writeOutputs } from './pipeline/write.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function main() {
  const t0 = performance.now();
  const argv = process.argv.slice(2);
  const ui = argv.indexOf('--until');
  const until = ui >= 0 ? (argv[ui + 1] as StageName) : undefined;
  if (until && !STAGES.some(([n]) => n === until)) throw new Error(`알 수 없는 단계 ${until} (가능: ${STAGES.map(([n]) => n).join(', ')})`);

  const ctx = createContext(ROOT);
  const g = ctx.grid.spec;
  console.log(`격자 ${g.w}×${g.h} (셀 ${g.cell}m), 경계 링 ${ctx.cityRings.length}`);
  runStages(ctx, until);

  if (!until) {
    const sizes = writeOutputs(ctx, join(ROOT, 'public', 'data'));
    for (const [f, b] of Object.entries(sizes)) console.log(`  ${f}: ${(b / 1024).toFixed(0)} KB`);
  }
  console.log('통계', ctx.stats);
  console.log(`완료 ${((performance.now() - t0) / 1000).toFixed(1)}s`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
