// 앱 조립: 상태 → UI(로딩 화면) → 데이터 → 엔진 → 월드 → 시뮬레이션 → UI 연결 → 렌더 루프.
// 각 모듈의 진입 함수 계약은 ARCHITECTURE.md "모듈 진입점" 절에 있다.

import './ui/styles.css';
import { DEFAULT_STATE, Store, type AppState } from './core/state.ts';
import { createGlobalUniforms } from './core/uniforms.ts';
import type { AppContext } from './core/types.ts';
import { loadData } from './data/loader.ts';
import { createUI } from './ui/ui.ts';
import { readUrlState } from './ui/url-state.ts';
import { createEngine } from './engine/engine.ts';
import { createWorld } from './world/world.ts';
import { createSimulation } from './sim/simulation.ts';

async function main() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app 요소가 없습니다');

  const url = readUrlState(location.search);
  const store = new Store<AppState>({ ...DEFAULT_STATE, ...url.state });
  const uniforms = createGlobalUniforms();
  const ui = createUI(root, store);

  try {
    ui.setLoading(0, '데이터 내려받는 중');
    const data = await loadData(import.meta.env.BASE_URL + 'data/', (loaded, total, label) =>
      ui.setLoading(0.6 * (loaded / total), `${label} 내려받는 중`),
    );

    const engine = createEngine(root, store, uniforms);
    const app: AppContext = {
      renderer: engine.renderer,
      scene: engine.scene,
      get camera() {
        return engine.camera;
      },
      store,
      uniforms,
      data,
      quality: engine.quality,
      ground: {
        heightAt: () => 0,
        landCoverAt: () => 0,
        inCity: () => false,
      },
    };

    const world = await createWorld(app, (p, label) => ui.setLoading(0.6 + 0.35 * p, label));
    app.ground = world.ground;
    engine.setBounds(world.bounds, (x, z) => world.ground.heightAt(x, z));
    engine.addSystem(world);

    ui.setLoading(0.97, '사람과 차량 배치 중');
    const sim = createSimulation(app);
    engine.addSystem(sim);

    engine.addSystem(ui.attach(app, engine));
    if (url.camera) engine.setCameraState(url.camera);
    else engine.resetView();

    engine.start();
    ui.setLoading(1, '완료');
    primeServiceWorkerCache();
  } catch (err) {
    console.error(err);
    ui.showError(err instanceof Error ? err.message : String(err));
  }
}

// 설치형 PWA: 배포 빌드에서만 서비스워커를 등록한다(개발 서버의 HMR 요청을 가로채지 않도록).
function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(import.meta.env.BASE_URL + 'sw.js').catch((err: unknown) => {
      console.warn('서비스워커 등록 실패:', err);
    });
  });
}

// 첫 방문은 서비스워커가 페이지를 제어하기 전에 로드되므로, 로딩이 끝난 뒤 실제로 받은 같은 출처 자원
// (해시된 번들·워커·data/)을 서비스워커에 알려 캐시에 채운다. 설치 직후 오프라인 실행에 필요하다.
function primeServiceWorkerCache() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((registration) => {
    const urls = performance.getEntriesByType('resource').map((entry) => entry.name);
    urls.push(location.href);
    registration.active?.postMessage({ type: 'CACHE_URLS', urls });
  });
}

registerServiceWorker();
void main();
