// 엔진: 렌더러·카메라(원근/등각)·조작·하늘과 빛·낮밤·시계·틸트시프트·피킹·렌더 루프.

import {
  AmbientLight,
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  NeutralToneMapping,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Spherical,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Camera,
} from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { AppState, Quality, Store } from '../core/state.ts';
import type { GlobalUniforms } from '../core/uniforms.ts';
import type { CameraState, EngineApi, FrameInfo, PickResult, QualityProfile, System } from '../core/types.ts';
import { YEAR_MAX } from '../data/codes.ts';
import { approachYear, computeSky } from './sky.ts';
import { tiltShiftShader } from './tiltshift.ts';

export interface Bounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export interface Engine extends EngineApi {
  renderer: WebGLRenderer;
  scene: Scene;
  readonly camera: Camera;
  quality: QualityProfile;
  addSystem(s: System): void;
  /** 카메라 이동 범위와(선택) 지면 높이 함수. */
  setBounds(b: Bounds, heightAt?: (x: number, z: number) => number): void;
  start(): void;
}

export const QUALITY: Record<Quality, QualityProfile> = {
  low: { pixelRatioCap: 1, shadowMapSize: 1024, agentDensity: 0.4, treeDensity: 0.45, lodDistance: 1200 },
  medium: { pixelRatioCap: 1.5, shadowMapSize: 2048, agentDensity: 0.7, treeDensity: 0.75, lodDistance: 2200 },
  high: { pixelRatioCap: 2, shadowMapSize: 4096, agentDensity: 1, treeDensity: 1, lodDistance: 3500 },
};

const ISO_POLAR = MathUtils.degToRad(58);
const DEG = 180 / Math.PI;

export function isLikelyMobile(): boolean {
  return matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
}

export function createEngine(container: HTMLElement, store: Store<AppState>, uniforms: GlobalUniforms): Engine {
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (err) {
    throw new Error(`WebGL2 를 시작할 수 없습니다. 최신 브라우저에서 하드웨어 가속을 켜 주세요. (${err instanceof Error ? err.message : String(err)})`);
  }
  if (isLikelyMobile() && store.get().quality === 'high') store.set({ quality: 'medium' });
  const quality: QualityProfile = { ...QUALITY[store.get().quality] };

  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.setClearColor(0x000000, 0);
  const canvas = renderer.domElement;
  canvas.className = 'gm-canvas';
  canvas.setAttribute('aria-label', '광명시 3D 복셀 지도');
  container.prepend(canvas);

  const scene = new Scene();
  const persp = new PerspectiveCamera(30, 1, 1, 30000);
  const ortho = new OrthographicCamera(-1, 1, 1, -1, 1, 60000);
  persp.position.set(3000, 5000, 6000);

  // 빛
  const hemi = new HemisphereLight(0xdff0ff, 0xb9a98a, 1.2);
  const ambient = new AmbientLight(0x8090c0, 0.15);
  const sun = new DirectionalLight(0xffffff, 2.5);
  sun.castShadow = true;
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(hemi, ambient, sun, sun.target);

  // 조작
  const controls = new MapControls(persp, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.screenSpacePanning = false;
  controls.zoomToCursor = true;
  controls.minDistance = 20;
  controls.maxDistance = 16000;
  controls.maxPolarAngle = MathUtils.degToRad(78);
  controls.minPolarAngle = MathUtils.degToRad(8);
  controls.zoomSpeed = 1.2;

  let bounds: Bounds = { minX: -4000, minZ: -6000, maxX: 4000, maxZ: 6000 };
  const systems: System[] = [];
  const afterRender = new Set<() => void>();

  // 틸트시프트(필요할 때만 생성)
  let composer: EffectComposer | null = null;
  let tiltH: ShaderPass | null = null;
  let tiltV: ShaderPass | null = null;
  const ensureComposer = () => {
    if (composer) return composer;
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, persp));
    tiltH = new ShaderPass(tiltShiftShader(true));
    tiltV = new ShaderPass(tiltShiftShader(false));
    composer.addPass(tiltH);
    composer.addPass(tiltV);
    composer.addPass(new OutputPass());
    return composer;
  };

  const activeCamera = (): Camera => (store.get().cameraMode === 'isometric' ? ortho : persp);

  const resize = () => {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatioCap));
    renderer.setSize(w, h);
    persp.aspect = w / h;
    persp.updateProjectionMatrix();
    composer?.setSize(w, h);
    composer?.setPixelRatio(renderer.getPixelRatio());
    if (tiltH && tiltV) {
      (tiltH.uniforms.uDelta.value as number[]) = [1 / (w * renderer.getPixelRatio()), 0];
      (tiltV.uniforms.uDelta.value as number[]) = [0, 1 / (h * renderer.getPixelRatio())];
    }
  };
  window.addEventListener('resize', resize);
  resize();

  const applyQuality = (q: Quality) => {
    Object.assign(quality, QUALITY[q]);
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.map?.dispose();
    sun.shadow.map = null;
    resize();
  };
  applyQuality(store.get().quality);
  store.subscribe(applyQuality, (s) => s.quality);

  // 등각 모드: 방위를 45°+90°k 로, 극각 고정
  const applyMode = (mode: AppState['cameraMode']) => {
    if (mode === 'isometric') {
      controls.minPolarAngle = controls.maxPolarAngle = ISO_POLAR;
      const az = controls.getAzimuthalAngle();
      const snapped = Math.round((az - Math.PI / 4) / (Math.PI / 2)) * (Math.PI / 2) + Math.PI / 4;
      animateTo({ azimuth: snapped * DEG, polar: ISO_POLAR * DEG });
    } else {
      controls.minPolarAngle = MathUtils.degToRad(8);
      controls.maxPolarAngle = MathUtils.degToRad(78);
    }
    controls.enableRotate = mode !== 'isometric';
  };
  store.subscribe(applyMode, (s) => s.cameraMode);

  // ── 카메라 상태 ──
  const sph = new Spherical();
  const tmp = new Vector3();
  const getCameraState = (): CameraState => {
    tmp.copy(persp.position).sub(controls.target);
    sph.setFromVector3(tmp);
    return { x: controls.target.x, z: controls.target.z, distance: sph.radius, azimuth: sph.theta * DEG, polar: sph.phi * DEG };
  };
  const setCameraState = (s: Partial<CameraState>) => {
    const cur = getCameraState();
    const n = { ...cur, ...s };
    controls.target.set(n.x, 0, n.z);
    controls.target.y = groundY(n.x, n.z);
    sph.set(MathUtils.clamp(n.distance, controls.minDistance, controls.maxDistance), MathUtils.degToRad(n.polar), MathUtils.degToRad(n.azimuth));
    sph.phi = MathUtils.clamp(sph.phi, controls.minPolarAngle, controls.maxPolarAngle);
    persp.position.setFromSpherical(sph).add(controls.target);
    persp.lookAt(controls.target);
    controls.update();
  };
  let groundY = (_x: number, _z: number) => 0;

  // 부드러운 이동 애니메이션
  let anim: { from: CameraState; to: CameraState; t: number; dur: number } | null = null;
  const animateTo = (to: Partial<CameraState>, dur = 0.8) => {
    const from = getCameraState();
    const target = { ...from, ...to };
    // 방위는 가까운 쪽으로 돌기
    let d = target.azimuth - from.azimuth;
    d = ((d + 540) % 360) - 180;
    target.azimuth = from.azimuth + d;
    anim = { from, to: target, t: 0, dur };
  };

  const clampTarget = () => {
    const t = controls.target;
    const cx = MathUtils.clamp(t.x, bounds.minX, bounds.maxX);
    const cz = MathUtils.clamp(t.z, bounds.minZ, bounds.maxZ);
    if (cx !== t.x || cz !== t.z) {
      const dx = cx - t.x;
      const dz = cz - t.z;
      t.x = cx;
      t.z = cz;
      persp.position.x += dx;
      persp.position.z += dz;
    }
  };

  const api: EngineApi = {
    canvas,
    focusOn(x, z, distance) {
      store.set({ follow: null });
      animateTo({ x, z, ...(distance ? { distance } : {}) });
    },
    rotateBy(deg) {
      const cur = getCameraState();
      const base = anim ? anim.to.azimuth : cur.azimuth;
      animateTo({ azimuth: base + deg }, 0.6);
    },
    resetView() {
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cz = (bounds.minZ + bounds.maxZ) / 2;
      const span = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ);
      setCameraState({ x: cx, z: cz + span * 0.05, distance: span * 1.45, azimuth: 35, polar: 42 });
    },
    getCameraState,
    setCameraState,
    getViewDistance: () => persp.position.distanceTo(controls.target),
    onAfterRender(cb) {
      afterRender.add(cb);
      return () => afterRender.delete(cb);
    },
  };

  // ── 키보드 ──
  const keys = new Set<string>();
  const isTyping = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  };
  window.addEventListener('keydown', (e) => {
    if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(k)) {
      keys.add(k);
      store.set({ follow: null });
      e.preventDefault();
    } else if (k === 'q') api.rotateBy(-90);
    else if (k === 'e') api.rotateBy(90);
    else if (k === 'r') api.resetView();
    else if (k === 'escape') store.set({ follow: null, selected: null });
    else if (k === '+' || k === '=') animateTo({ distance: getCameraState().distance / 1.6 }, 0.35);
    else if (k === '-' || k === '_') animateTo({ distance: getCameraState().distance * 1.6 }, 0.35);
  });
  window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
  window.addEventListener('blur', () => keys.clear());

  // ── 피킹 ──
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let downAt: [number, number] | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    downAt = [e.clientX, e.clientY];
  });
  canvas.addEventListener('pointerup', (e) => {
    if (!downAt) return;
    const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
    downAt = null;
    if (moved > 6) return;
    const rect = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, activeCamera());
    let best: PickResult | null = null;
    for (const s of systems) {
      if (!s.pick) continue;
      const r = s.pick(raycaster);
      if (r && (!best || r.distance < best.distance)) best = r;
    }
    store.set({ selected: best });
  });
  controls.addEventListener('start', () => {
    anim = null;
    if (store.get().follow) store.set({ follow: null });
  });

  // ── 디버그 오버레이 ──
  const debug = new URLSearchParams(location.search).has('debug');
  let debugEl: HTMLDivElement | null = null;
  if (debug) {
    debugEl = document.createElement('div');
    debugEl.className = 'gm-debug';
    container.appendChild(debugEl);
  }

  // ── 루프 ──
  let displayYear = store.get().year;
  let time = 0;
  let last = performance.now();
  let fpsAcc = 0;
  let fpsN = 0;
  let lastTodSet = store.get().timeOfDay;
  const followPos = new Vector3();
  const bg = new Color();
  const bgTop = new Color();
  let lastBg = '';

  const frame = (now: number) => {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (document.hidden) return;
    dt = Math.min(0.1, Math.max(0, dt));
    time += dt;
    const st = store.get();

    // 시계
    let tod = st.timeOfDay;
    const simDt = st.timeRunning ? dt * st.timeScale : 0;
    if (simDt) {
      tod = (tod + simDt / 3600) % 24;
      if (Math.abs(tod - lastTodSet) > 0.02 || tod < lastTodSet) {
        lastTodSet = tod;
        store.set({ timeOfDay: tod });
      }
    }
    if (st.yearPlaying) {
      const ny = Math.min(YEAR_MAX, st.year + st.yearSpeed * dt);
      store.set({ year: ny, yearPlaying: ny < YEAR_MAX });
    }
    displayYear = approachYear(displayYear, store.get().year, dt);

    // 카메라 애니메이션·키 이동·따라가기
    if (anim) {
      anim.t = Math.min(1, anim.t + dt / anim.dur);
      const e = anim.t < 0.5 ? 4 * anim.t ** 3 : 1 - (-2 * anim.t + 2) ** 3 / 2;
      const f = anim.from;
      const to = anim.to;
      setCameraState({
        x: f.x + (to.x - f.x) * e,
        z: f.z + (to.z - f.z) * e,
        distance: f.distance * Math.pow(to.distance / f.distance, e),
        azimuth: f.azimuth + (to.azimuth - f.azimuth) * e,
        polar: f.polar + (to.polar - f.polar) * e,
      });
      if (anim.t >= 1) anim = null;
    }
    if (keys.size) {
      const dist = persp.position.distanceTo(controls.target);
      const speed = dist * 0.9 * dt;
      const fwd = new Vector3().subVectors(controls.target, persp.position).setY(0).normalize();
      const right = new Vector3(-fwd.z, 0, fwd.x);
      const mv = new Vector3();
      if (keys.has('w') || keys.has('arrowup')) mv.add(fwd);
      if (keys.has('s') || keys.has('arrowdown')) mv.sub(fwd);
      if (keys.has('d') || keys.has('arrowright')) mv.add(right);
      if (keys.has('a') || keys.has('arrowleft')) mv.sub(right);
      mv.normalize().multiplyScalar(speed);
      controls.target.add(mv);
      persp.position.add(mv);
    }
    if (st.follow) {
      if (st.follow.getPosition(followPos)) {
        const d = followPos.clone().sub(controls.target).multiplyScalar(Math.min(1, dt * 4));
        controls.target.add(d);
        persp.position.add(d);
      } else store.set({ follow: null });
    }
    controls.update();
    clampTarget();

    // 카메라 원근 범위·등각 카메라 동기화
    const dist = persp.position.distanceTo(controls.target);
    persp.near = Math.max(0.5, dist * 0.01);
    persp.far = dist + 26000;
    persp.updateProjectionMatrix();
    if (st.cameraMode === 'isometric') {
      const hh = dist * Math.tan(MathUtils.degToRad(persp.fov / 2));
      ortho.left = -hh * persp.aspect;
      ortho.right = hh * persp.aspect;
      ortho.top = hh;
      ortho.bottom = -hh;
      ortho.position.copy(persp.position).sub(controls.target).setLength(Math.max(4000, dist * 3)).add(controls.target);
      ortho.quaternion.copy(persp.quaternion);
      ortho.near = 1;
      ortho.far = Math.max(8000, dist * 3) + 26000;
      ortho.updateProjectionMatrix();
    }
    const cam = activeCamera();

    // 하늘·빛
    const sky = computeSky(tod);
    uniforms.uYear.value = displayYear;
    uniforms.uTime.value = time;
    uniforms.uTimeOfDay.value = tod;
    uniforms.uDaylight.value = sky.daylight;
    uniforms.uNight.value = sky.night;
    uniforms.uSunDir.value.set(...sky.sunDir);
    uniforms.uXray.value += ((st.layers.xray ? 1 : 0) - uniforms.uXray.value) * Math.min(1, dt * 5);
    cam.getWorldPosition(uniforms.uCameraPos.value);
    bg.setRGB(...sky.horizon, SRGBColorSpace);
    uniforms.uFogColor.value.copy(bg);
    hemi.color.setRGB(...sky.hemiSky, SRGBColorSpace);
    hemi.groundColor.setRGB(...sky.hemiGround, SRGBColorSpace);
    hemi.intensity = sky.hemiIntensity;
    ambient.intensity = 0.1 + 0.25 * sky.night;
    sun.color.setRGB(...sky.sunColor, SRGBColorSpace);
    sun.intensity = sky.sunIntensity;
    const shadowSpan = MathUtils.clamp(dist * 0.9, 120, 3000);
    sun.castShadow = st.layers.shadows && sky.daylight > 0.02;
    sun.target.position.copy(controls.target);
    sun.position.copy(controls.target).addScaledVector(uniforms.uSunDir.value, shadowSpan * 2.5);
    const sc = sun.shadow.camera;
    sc.left = -shadowSpan;
    sc.right = shadowSpan;
    sc.top = shadowSpan;
    sc.bottom = -shadowSpan;
    sc.near = 1;
    sc.far = shadowSpan * 6;
    sc.updateProjectionMatrix();
    bgTop.setRGB(...sky.skyTop, SRGBColorSpace);
    const bgKey = `${bgTop.getHexString()}${bg.getHexString()}`;
    if (bgKey !== lastBg) {
      lastBg = bgKey;
      container.style.background = `linear-gradient(to bottom, #${bgTop.getHexString()} 0%, #${bg.getHexString()} 70%)`;
    }

    // 시스템 갱신
    const fi: FrameInfo = { dt, simDt, time, year: displayYear, timeOfDay: tod };
    for (const s of systems) s.update(fi);

    // 렌더
    if (st.layers.tiltShift && st.cameraMode === 'perspective') {
      const c = ensureComposer();
      c.render(dt);
    } else renderer.render(scene, cam);
    for (const cb of afterRender) cb();

    if (debugEl) {
      fpsAcc += dt;
      fpsN++;
      if (fpsAcc > 0.5) {
        const info = renderer.info.render;
        debugEl.textContent = `${Math.round(fpsN / fpsAcc)} fps · draw ${info.calls} · tri ${(info.triangles / 1000).toFixed(0)}k · 거리 ${dist.toFixed(0)}m`;
        fpsAcc = 0;
        fpsN = 0;
      }
    }
  };

  return {
    ...api,
    renderer,
    scene,
    get camera() {
      return activeCamera();
    },
    quality,
    addSystem(s) {
      systems.push(s);
    },
    setBounds(b, heightAt) {
      bounds = b;
      if (heightAt) groundY = heightAt;
    },
    start() {
      last = performance.now();
      requestAnimationFrame(frame);
    },
  };
}
