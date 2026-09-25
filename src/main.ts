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
    engine.setBounds(world.bounds);
    engine.addSystem(world);

    ui.setLoading(0.97, '사람과 차량 배치 중');
    const sim = createSimulation(app);
    engine.addSystem(sim);

    engine.addSystem(ui.attach(app, engine));
    if (url.camera) engine.setCameraState(url.camera);
    else engine.resetView();

    engine.start();
    ui.setLoading(1, '완료');
  } catch (err) {
    console.error(err);
    ui.showError(err instanceof Error ? err.message : String(err));
  }
}

void main();
