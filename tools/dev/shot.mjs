// 개발용 스크린샷·스모크 테스트: 헤드리스 Chrome 을 DevTools 프로토콜로 띄워 페이지를 열고,
// 실제 시간으로 기다린 뒤 캡처하며 콘솔 오류·예외를 모아 출력한다. 오류가 있으면 종료 코드 1.
// 사용법: node tools/dev/shot.mjs <url> <out.png> [대기초=25] [폭=1600] [높이=900] [--mobile]

import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const mobile = args.includes('--mobile');
const [url, out, waitS = '25', wS = '1600', hS = '900'] = args.filter((a) => !a.startsWith('--'));
if (!url || !out) throw new Error('사용법: node tools/dev/shot.mjs <url> <out.png> [대기초] [폭] [높이] [--mobile]');

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const chrome = CANDIDATES.find((p) => existsSync(p));
if (!chrome) throw new Error('Chrome/Edge 실행 파일을 찾지 못했습니다 (CHROME_PATH 지정 가능)');

const port = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(tmpdir(), 'gm-shot-'));
const proc = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${prof}`,
  '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader',
  '--hide-scrollbars',
  '--no-first-run',
  `--window-size=${wS},${hS}`,
  'about:blank',
]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let targets;
  for (let i = 0; i < 50; i++) {
    try {
      targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      if (targets.length) break;
    } catch {
      /* 아직 시작 중 */
    }
    await sleep(200);
  }
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('헤드리스 페이지를 찾지 못했습니다');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let id = 0;
  const pending = new Map();
  const problems = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.exceptionThrown') problems.push(`예외: ${m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text}`);
    else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) problems.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`);
  };
  const send = (method, params = {}) =>
    new Promise((r) => {
      const i = ++id;
      pending.set(i, r);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  if (mobile) {
    await send('Emulation.setDeviceMetricsOverride', { width: Number(wS), height: Number(hS), deviceScaleFactor: 2, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
  }
  // 첫 방문 도움말을 건너뛰도록 같은 출처에서 표시 기록을 남긴 뒤 다시 연다
  await send('Page.navigate', { url: new URL('/', url).href });
  await sleep(800);
  await send('Runtime.evaluate', { expression: "try{localStorage.setItem('gm-city-help-seen','1')}catch(e){}" });
  await send('Page.navigate', { url });
  await sleep(Number(waitS) * 1000);
  if (process.env.SHOT_EVAL) {
    await send('Runtime.evaluate', { expression: process.env.SHOT_EVAL, awaitPromise: true });
    await sleep(Number(process.env.SHOT_EVAL_WAIT ?? 3) * 1000);
  }
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(out, Buffer.from(r.result.data, 'base64'));
  const info = await send('Runtime.evaluate', { expression: 'JSON.stringify({err: document.querySelector(".gm-error")?.innerText ?? null, loading: !!document.querySelector(".gm-loading:not(.done)"), url: location.search})', returnByValue: true });
  console.log(`캡처: ${out}`);
  console.log(`상태: ${info.result.result.value}`);
  for (const p of problems) console.log(p);
  ws.close();
  const state = JSON.parse(info.result.result.value);
  if (state.err || problems.some((p) => p.startsWith('예외') || p.startsWith('error'))) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => proc.kill());
