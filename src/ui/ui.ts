// 화면 UI: 로딩·오류, 제목·연도, 타임라인, 설정 패널, 정보 카드, 토스트, 랜드마크 라벨, 도움말·출처 모달, URL 공유, 단축키.

import { Vector3 } from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import type { AppState, Layers, Quality, Store } from '../core/state.ts';
import type { AppContext, EngineApi, FrameInfo, System } from '../core/types.ts';
import { YEAR_MAX, YEAR_MIN, YEAR_NOW } from '../data/codes.ts';
import type { HistoryEvent, Landmark } from '../data/format.ts';
import { crossedEvents, timeLabel, writeUrlState, yearLabel } from './url-state.ts';

type Attrs = Record<string, string | number | boolean | ((e: Event) => void) | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined) el.append(c);
  return el;
}

const CAT: Record<HistoryEvent['category'], { name: string; color: string }> = {
  admin: { name: '행정', color: '#8e6cd8' },
  rail: { name: '철도', color: '#1f7ae0' },
  road: { name: '도로', color: '#8a8a8a' },
  housing: { name: '주거', color: '#e58f2a' },
  landmark: { name: '명소', color: '#e2553d' },
  industry: { name: '산업', color: '#3f9aa6' },
  nature: { name: '자연', color: '#3aa35a' },
  disaster: { name: '사고', color: '#2b2b2b' },
  future: { name: '계획', color: '#f0c020' },
};
const KIND_ICON: Record<string, string> = { mountain: '⛰️', station: '🚉', stream: '🏞️', bridge: '🌉', mall: '🛍️', factory: '🏭', public: '🏛️', culture: '🎨', sports: '🏟️', park: '🌳', tourism: '📸', heritage: '🏯', hospital: '🏥', school: '🏫', nature: '🌿', religious: '⛪' };
const LAYER_NAMES: [keyof Layers, string][] = [
  ['buildings', '🏢 건물'],
  ['trees', '🌳 나무'],
  ['people', '🧍 사람'],
  ['cars', '🚗 자동차'],
  ['buses', '🚌 버스'],
  ['trains', '🚆 열차'],
  ['labels', '🏷️ 이름표'],
  ['xray', '🔍 지하 투시'],
  ['tiltShift', '📷 미니어처 효과'],
  ['shadows', '🌗 그림자'],
];
const safeStorage = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* 저장소를 쓸 수 없는 환경(사생활 보호 모드 등)에서는 기억하지 않는다 */
    }
  },
};

export function createUI(root: HTMLElement, store: Store<AppState>) {
  // ── 로딩 ──
  const bar = h('div');
  const loadLabel = h('div', { class: 'label', role: 'status', 'aria-live': 'polite' }, '준비 중');
  const stack = h(
    'div',
    { class: 'gm-stack', 'aria-hidden': 'true' },
    ...['#8cc85a', '#f2efe6', '#4ab3e6', '#f08a24', '#b5654a'].map((c, i) => h('i', { style: `--c:${c};--d:${i * 0.15}s;--h:${30 + ((i * 17) % 34)}px` })),
  );
  const loading = h(
    'div',
    { class: 'gm-loading' },
    h('div', { class: 'gm-panel card' }, stack, h('h1', {}, '광명 미니어처'), h('p', {}, '경기도 광명시를 줄여 옮긴 복셀 디오라마'), h('div', { class: 'gm-bar', role: 'progressbar', 'aria-label': '불러오는 중' }, bar), loadLabel),
  );
  root.append(loading);

  return {
    setLoading(p: number, label: string) {
      bar.style.width = `${Math.round(Math.min(1, Math.max(0, p)) * 100)}%`;
      loadLabel.textContent = label;
      if (p >= 1) {
        loading.classList.add('done');
        setTimeout(() => loading.remove(), 700);
      }
    },
    showError(msg: string) {
      loading.classList.remove('done');
      loading.replaceChildren(
        h(
          'div',
          { class: 'gm-panel gm-error', role: 'alert' },
          h('h2', {}, '앗, 미니어처를 펼치지 못했어요'),
          h('p', {}, msg),
          h('p', {}, '최신 Chrome·Edge·Safari·Firefox 에서 하드웨어 가속을 켜고 다시 시도해 주세요.'),
          h('button', { class: 'gm-btn primary', onclick: () => location.reload() }, '새로고침'),
        ),
      );
    },
    attach(app: AppContext, engine: EngineApi): System {
      return attachHud(root, store, app, engine);
    },
  };
}

function attachHud(root: HTMLElement, store: Store<AppState>, app: AppContext, engine: EngineApi): System {
  const hist = app.data.history;
  const events = hist.events;
  const hud = h('div', { class: 'gm-hud' });
  root.append(hud);

  // ── 제목·연도 ──
  const yearB = h('b', { 'aria-live': 'polite' });
  const badge = h('span', { class: 'badge' }, '계획');
  const clock = h('span', { class: 'clock' });
  const era = h('div', { class: 'gm-era' });
  hud.append(
    h('div', { class: 'gm-panel gm-title' }, h('h1', {}, '광명 미니어처'), h('div', { class: 'sub' }, '경기도 광명시 복셀 디오라마 · 1960–2035'), h('div', { class: 'gm-year' }, yearB, badge, clock), era),
  );

  // ── 도구 버튼 ──
  const toggleBtn = (label: string, icon: string, onClick: () => void, cls = '') => h('button', { class: `gm-btn icon ${cls}`, 'aria-label': label, title: label, onclick: onClick }, icon);
  const side = h('div', { class: 'gm-panel gm-side gm-hidden', id: 'gm-side', role: 'region', 'aria-label': '보기 설정' });
  const sideBtn = toggleBtn('보기 설정', '⚙️', () => {
    side.classList.toggle('gm-hidden');
    sideBtn.setAttribute('aria-pressed', String(!side.classList.contains('gm-hidden')));
  });
  sideBtn.setAttribute('aria-controls', 'gm-side');
  sideBtn.setAttribute('aria-pressed', 'false');
  hud.append(
    h(
      'div',
      { class: 'gm-tools' },
      toggleBtn('왼쪽으로 돌리기 (Q)', '⟲', () => engine.rotateBy(-90), 'wide-only'),
      toggleBtn('오른쪽으로 돌리기 (E)', '⟳', () => engine.rotateBy(90), 'wide-only'),
      sideBtn,
      toggleBtn('링크 공유', '🔗', () => openShare()),
      toggleBtn('조작법 (H)', '❔', () => openHelp()),
      toggleBtn('이 지도에 대해', 'ⓘ', () => openAbout()),
    ),
    side,
  );

  // ── 설정 패널 ──
  const chips = LAYER_NAMES.map(([k, name]) => {
    const b = h('button', { class: 'gm-chip', 'aria-pressed': String(store.get().layers[k]), onclick: () => store.set({ layers: { ...store.get().layers, [k]: !store.get().layers[k] } }) }, name);
    store.subscribe((v) => b.setAttribute('aria-pressed', String(v)), (s) => s.layers[k]);
    return b;
  });
  const tod = h('input', { type: 'range', class: 'gm-range', min: 0, max: 24, step: 0.05, 'aria-label': '하루 중 시각' }) as HTMLInputElement;
  tod.value = String(store.get().timeOfDay);
  tod.addEventListener('input', () => store.set({ timeOfDay: Number(tod.value) }));
  const todLabel = h('span', { class: 'grow' });
  const clockBtn = h('button', { class: 'gm-btn', onclick: () => store.set({ timeRunning: !store.get().timeRunning }) });
  const seg = <T extends string | number>(items: [T, string][], get: () => T, set: (v: T) => void, label: string) => {
    const wrap = h('div', { class: 'gm-seg', role: 'group', 'aria-label': label });
    const btns = items.map(([v, t]) => h('button', { 'aria-pressed': String(get() === v), onclick: () => set(v) }, t));
    wrap.append(...btns);
    const sync = () => btns.forEach((b, i) => b.setAttribute('aria-pressed', String(get() === items[i][0])));
    store.subscribe(sync);
    return wrap;
  };
  const places = h('div', { class: 'gm-places' });
  const featured = [...hist.landmarks].sort((a, b) => a.priority - b.priority).slice(0, 16);
  for (const lm of featured) places.append(h('button', { onclick: () => focusLandmark(lm) }, `${KIND_ICON[lm.kind] ?? '📍'} ${lm.name}`));
  side.append(
    h('h3', {}, '보이는 것'),
    h('div', { class: 'gm-chips' }, ...chips),
    h('h3', {}, '하루 시각'),
    h('div', { class: 'gm-row' }, todLabel, clockBtn),
    tod,
    h('div', { class: 'gm-row' }, h('span', { class: 'grow' }, '시계 속도'), seg([[60, '1분/초'], [600, '10분/초'], [3600, '1시간/초']], () => store.get().timeScale, (v) => store.set({ timeScale: v }), '시계 속도')),
    h('h3', {}, '카메라'),
    h('div', { class: 'gm-row' }, seg([['perspective', '원근'], ['isometric', '등각(RCT)']], () => store.get().cameraMode, (v) => store.set({ cameraMode: v }), '카메라 모드'), h('button', { class: 'gm-btn', onclick: () => engine.resetView() }, '처음 시점')),
    h('div', { class: 'gm-row' }, h('span', { class: 'grow' }, '그래픽 품질'), seg<Quality>([['low', '낮음'], ['medium', '보통'], ['high', '높음']], () => store.get().quality, (v) => store.set({ quality: v }), '그래픽 품질')),
    h('h3', {}, '둘러보기'),
    places,
  );

  // ── 타임라인 ──
  const track = h('div', { class: 'gm-track', role: 'slider', tabindex: 0, 'aria-label': '연도', 'aria-valuemin': YEAR_MIN, 'aria-valuemax': YEAR_MAX });
  const pct = (y: number) => ((y - YEAR_MIN) / (YEAR_MAX - YEAR_MIN)) * 100;
  const knob = h('div', { class: 'knob' });
  track.append(h('div', { class: 'rail' }), h('div', { class: 'future', style: `left:${pct(YEAR_NOW + 1)}%` }));
  for (let y = 1960; y <= 2030; y += 10) track.append(h('span', { class: 'tick', style: `left:${pct(y)}%` }, `${y}`));
  const tip = h('div', { class: 'gm-panel gm-tip gm-hidden' });
  const showTip = (e: HistoryEvent, x: string) => {
    tip.replaceChildren(h('b', {}, `${e.year}${e.month ? `.${e.month}` : ''} · ${e.title}`), e.description.length > 140 ? `${e.description.slice(0, 140)}…` : e.description);
    tip.style.left = x;
    tip.classList.remove('gm-hidden');
  };
  events.forEach((e) => {
    const x = `${pct(e.year + ((e.month ?? 6) - 0.5) / 12)}%`;
    const dot = h('button', {
      class: 'dot',
      style: `left:${x};background:${CAT[e.category]?.color ?? '#999'}`,
      'aria-label': `${e.year}년 ${e.title}`,
      onmouseenter: () => showTip(e, x),
      onmouseleave: () => tip.classList.add('gm-hidden'),
      onfocus: () => showTip(e, x),
      onblur: () => tip.classList.add('gm-hidden'),
      onclick: (ev: Event) => {
        ev.stopPropagation();
        store.set({ year: e.year + 0.5, yearPlaying: false });
        if (e.x !== undefined && e.z !== undefined) engine.focusOn(e.x, e.z, 1400);
        toast(e.year, e.title);
      },
    });
    track.append(dot);
  });
  track.append(knob, tip);
  const setFromPointer = (clientX: number) => {
    const r = track.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    store.set({ year: YEAR_MIN + t * (YEAR_MAX - YEAR_MIN), yearPlaying: false });
  };
  let dragging = false;
  track.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).classList.contains('dot')) return;
    dragging = true;
    track.setPointerCapture(e.pointerId);
    setFromPointer(e.clientX);
  });
  track.addEventListener('pointermove', (e) => dragging && setFromPointer(e.clientX));
  track.addEventListener('pointerup', () => (dragging = false));
  track.addEventListener('keydown', (e) => {
    const y = store.get().year;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') store.set({ year: Math.max(YEAR_MIN, Math.floor(y) - 1) });
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') store.set({ year: Math.min(YEAR_MAX, Math.floor(y) + 1) });
    else if (e.key === 'Home') store.set({ year: YEAR_MIN });
    else if (e.key === 'End') store.set({ year: YEAR_MAX });
    else return;
    e.preventDefault();
    e.stopPropagation();
  });
  const playBtn = h('button', { class: 'gm-btn primary', onclick: () => togglePlay() });
  const togglePlay = () => {
    const s = store.get();
    if (!s.yearPlaying && s.year >= YEAR_MAX - 0.01) store.set({ year: YEAR_MIN });
    store.set({ yearPlaying: !store.get().yearPlaying });
  };
  const speed = h('div', { class: 'gm-seg', role: 'group', 'aria-label': '재생 속도' });
  const speedBtns = ([1, 2, 5] as const).map((v) => h('button', { 'aria-pressed': String(store.get().yearSpeed === v), onclick: () => store.set({ yearSpeed: v }) }, `${v}년/초`));
  speed.append(...speedBtns);
  store.subscribe((v) => speedBtns.forEach((b, i) => b.setAttribute('aria-pressed', String([1, 2, 5][i] === v))), (s) => s.yearSpeed);
  const nowBtn = h('button', { class: 'gm-btn', onclick: () => store.set({ year: YEAR_NOW, yearPlaying: false }) }, '지금');
  const legend = h('div', { class: 'gm-legend' }, ...Object.values(CAT).map((c) => h('span', { style: `--c:${c.color}` }, c.name)));
  hud.append(h('div', { class: 'gm-panel gm-timeline', role: 'region', 'aria-label': '타임라인' }, h('div', { class: 'ctrl' }, playBtn, speed), track, h('div', { class: 'ctrl' }, nowBtn), legend));

  // ── 정보 카드 ──
  const info = h('div', { class: 'gm-panel gm-info gm-hidden', role: 'dialog', 'aria-label': '선택한 대상 정보' });
  hud.append(info);
  const renderInfo = () => {
    const s = store.get();
    const sel = s.selected;
    if (!sel) {
      info.classList.add('gm-hidden');
      return;
    }
    const c = sel.info;
    const following = !!s.follow && s.follow === sel.follow;
    const actions = h('div', { class: 'actions' });
    if (sel.follow) actions.append(h('button', { class: 'gm-btn primary', onclick: () => store.set({ follow: following ? null : sel.follow! }) }, following ? '그만 따라가기' : '🎥 따라가기'));
    actions.append(h('button', { class: 'gm-btn x', 'aria-label': '닫기', onclick: () => store.set({ selected: null, follow: null }) }, '닫기'));
    info.replaceChildren(
      h('div', { class: 'head' }, h('div', { class: 'ico', 'aria-hidden': 'true' }, c.icon), h('div', {}, h('h2', {}, c.title), c.subtitle ? h('div', { class: 'subt' }, c.subtitle) : null)),
      h('dl', {}, ...c.fields.flatMap((f) => [h('dt', {}, f.label), h('dd', {}, f.value)])),
      ...(c.note ? [h('div', { class: 'note' }, c.note)] : []),
      actions,
    );
    info.classList.remove('gm-hidden');
  };
  store.subscribe(renderInfo, (s) => s.selected);
  store.subscribe(renderInfo, (s) => s.follow);

  // ── 토스트 ──
  const toasts = h('div', { class: 'gm-toasts', 'aria-live': 'polite' });
  hud.append(toasts);
  const toast = (year: number | string, text: string) => {
    const t = h('div', { class: 'gm-panel gm-toast' }, h('b', {}, String(year)), text);
    toasts.append(t);
    while (toasts.children.length > 3) toasts.firstChild?.remove();
    setTimeout(() => t.remove(), 4200);
  };

  // ── 라벨(CSS2D) ──
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  root.insertBefore(labelRenderer.domElement, hud);
  const labels = hist.landmarks.map((lm) => {
    const el = h('div', { class: `gm-label p${lm.priority}`, role: 'button', tabindex: -1, onclick: () => focusLandmark(lm) }, `${KIND_ICON[lm.kind] ?? '📍'} ${lm.name}`);
    const obj = new CSS2DObject(el);
    obj.position.set(lm.x, lm.y + (lm.kind === 'mountain' ? 12 : 30), lm.z);
    app.scene.add(obj);
    return { lm, obj };
  });
  const resizeLabels = () => labelRenderer.setSize(root.clientWidth, root.clientHeight);
  resizeLabels();
  window.addEventListener('resize', resizeLabels);
  engine.onAfterRender(() => labelRenderer.render(app.scene, app.camera));
  function focusLandmark(lm: Landmark) {
    engine.focusOn(lm.x, lm.z, lm.kind === 'mountain' ? 1600 : 700);
    store.set({
      selected: {
        distance: 0,
        point: [lm.x, lm.y, lm.z],
        info: {
          icon: KIND_ICON[lm.kind] ?? '📍',
          title: lm.name,
          subtitle: lm.opened ? `${lm.opened}년부터` : undefined,
          fields: [{ label: '소개', value: lm.description }, ...(lm.closed ? [{ label: '폐쇄', value: `${lm.closed}년` }] : [])],
          note: lm.sources.length ? `출처 ${lm.sources.length}건 (조사 자료)` : undefined,
        },
      },
    });
  }

  // ── 모달 ──
  const modal = (title: string, ...body: (Node | string)[]) => {
    const close = () => m.remove();
    const m: HTMLDivElement = h('div', { class: 'gm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, onclick: (e: Event) => e.target === m && close() }, h('div', { class: 'gm-panel card' }, h('h2', {}, title), ...body, h('div', { class: 'gm-row' }, h('span', { class: 'grow' }), h('button', { class: 'gm-btn primary', onclick: close }, '닫기'))));
    m.addEventListener('keydown', (e: KeyboardEvent) => e.key === 'Escape' && close());
    document.body.append(m);
    (m.querySelector('button') as HTMLButtonElement | null)?.focus();
  };
  const k = (key: string, what: string) => [h('div', {}, ...key.split(' ').map((s) => h('kbd', {}, s))), h('div', {}, what)];
  function openHelp() {
    modal(
      '조작법',
      h('h3', {}, '마우스'),
      h('div', { class: 'gm-keys' }, ...k('왼쪽드래그', '지도 이동'), ...k('오른쪽드래그', '회전·기울이기'), ...k('휠', '확대·축소'), ...k('클릭', '건물·사람·버스·열차 정보')),
      h('h3', {}, '터치'),
      h('div', { class: 'gm-keys' }, ...k('한손가락', '이동'), ...k('두손가락', '확대·회전'), ...k('탭', '정보 보기')),
      h('h3', {}, '키보드'),
      h('div', { class: 'gm-keys' }, ...k('W A S D', '이동'), ...k('Q E', '90° 회전'), ...k('+ -', '확대·축소'), ...k('R', '처음 시점'), ...k('Space', '타임라인 재생'), ...k('[ ]', '1년 앞뒤로'), ...k('T', '시계 멈춤/재생'), ...k('L', '이름표'), ...k('X', '지하 투시'), ...k('Esc', '선택·따라가기 해제')),
    );
  }
  function openAbout() {
    const w = app.data.world.meta;
    modal(
      '광명 미니어처',
      h('p', {}, '경기도 광명시(38.5km²)를 실제 지형·도로·건물 데이터로 5m 복셀 격자에 옮긴 디오라마입니다. 타임라인으로 1960년 논밭에서 오늘의 도시, 2030년대 계획까지 넘겨 보고, 실제 노선을 따라 달리는 버스·지하철·KTX와 동네를 걷는 사람들을 구경할 수 있어요.'),
      h('h3', {}, '데이터 출처'),
      h('ul', {}, ...w.attribution.map((a) => h('li', {}, linkify(a))), h('li', {}, `연표·개발지구·노선·랜드마크: 웹 조사 후 별도 검증한 자료(사건 ${hist.events.length}건, 항목마다 출처 포함)`)),
      h('h3', {}, '알아 둘 점'),
      h('ul', {}, ...hist.notes.map((n) => h('li', {}, n))),
      h('p', {}, '코드: ', h('a', { href: 'https://github.com/jeiel85/gm-city', target: '_blank', rel: 'noopener' }, 'github.com/jeiel85/gm-city'), ' (MIT) · 지도 데이터는 ODbL'),
    );
  }
  function linkify(s: string): Node {
    const m = /(https?:\/\/\S+)/.exec(s);
    if (!m) return document.createTextNode(s);
    const f = document.createDocumentFragment();
    f.append(s.slice(0, m.index), h('a', { href: m[1], target: '_blank', rel: 'noopener' }, m[1]), s.slice(m.index + m[1].length));
    return f;
  }
  function currentUrl() {
    return `${location.origin}${location.pathname}${writeUrlState(store.get(), engine.getCameraState())}`;
  }
  function openShare() {
    const url = currentUrl();
    const input = h('input', { value: url, readonly: true, 'aria-label': '공유 링크' }) as HTMLInputElement;
    const msg = h('span', { role: 'status' });
    const copy = h('button', {
      class: 'gm-btn primary',
      onclick: async () => {
        try {
          await navigator.clipboard.writeText(url);
          msg.textContent = '복사했어요!';
        } catch {
          input.select();
          msg.textContent = '자동 복사가 막혀 있어요. 선택된 주소를 직접 복사해 주세요.';
        }
      },
    }, '복사');
    modal('지금 보는 장면 공유', h('p', {}, '연도·시각·카메라 위치가 담긴 링크예요.'), h('div', { class: 'gm-share' }, input, copy), msg);
  }
  if (!safeStorage.get('gm-city-help-seen')) {
    safeStorage.set('gm-city-help-seen', '1');
    setTimeout(openHelp, 600);
  }

  // ── 단축키 ──
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.gm-modal')) return;
    const L = store.get().layers;
    switch (e.key) {
      case ' ':
        if (t && t.tagName === 'BUTTON') return;
        e.preventDefault();
        togglePlay();
        break;
      case '[':
        store.set({ year: Math.max(YEAR_MIN, Math.floor(store.get().year) - 1), yearPlaying: false });
        break;
      case ']':
        store.set({ year: Math.min(YEAR_MAX, Math.floor(store.get().year) + 1), yearPlaying: false });
        break;
      case 't':
      case 'T':
        store.set({ timeRunning: !store.get().timeRunning });
        break;
      case 'l':
      case 'L':
        store.set({ layers: { ...L, labels: !L.labels } });
        break;
      case 'x':
      case 'X':
        store.set({ layers: { ...L, xray: !L.xray } });
        break;
      case 'h':
      case 'H':
      case '?':
        openHelp();
        break;
    }
  });

  // ── 프레임 갱신 ──
  let lastYearInt = -1;
  let lastTod = -1;
  let lastPlaying: boolean | null = null;
  let lastRunning: boolean | null = null;
  let prevYear = store.get().year;
  let urlTimer = 0;
  let lastUrl = '';
  const eventYears = events.map((e) => e.year);
  const tmpV = new Vector3();
  return {
    name: 'ui',
    update(f: FrameInfo) {
      const s = store.get();
      knob.style.left = `${pct(s.year)}%`;
      track.setAttribute('aria-valuenow', String(Math.floor(s.year)));
      track.setAttribute('aria-valuetext', `${Math.floor(s.year)}년`);
      const yi = Math.floor(f.year);
      if (yi !== lastYearInt) {
        lastYearInt = yi;
        const yl = yearLabel(f.year, YEAR_NOW);
        yearB.textContent = `${yl.text}년`;
        badge.classList.toggle('gm-hidden', !yl.planned);
        const e = hist.eras.find((x) => yi >= x.from && yi <= x.to);
        era.textContent = e ? `${e.summary}${e.population ? ` (인구 약 ${Math.round(e.population / 10000)}만 명)` : ''}` : '';
        era.title = era.textContent;
      }
      // 재생 중 지나친 사건 알림
      if (s.yearPlaying) for (const i of crossedEvents(eventYears, prevYear, s.year).slice(0, 2)) toast(events[i].year, events[i].title);
      prevYear = s.year;
      if (Math.abs(s.timeOfDay - lastTod) > 0.01) {
        lastTod = s.timeOfDay;
        clock.textContent = timeLabel(s.timeOfDay);
        todLabel.textContent = timeLabel(s.timeOfDay);
        if (document.activeElement !== tod) tod.value = String(s.timeOfDay);
      }
      if (s.yearPlaying !== lastPlaying) {
        lastPlaying = s.yearPlaying;
        playBtn.textContent = s.yearPlaying ? '⏸ 멈춤' : '▶ 재생';
        playBtn.setAttribute('aria-label', s.yearPlaying ? '타임라인 멈춤' : '타임라인 재생');
      }
      if (s.timeRunning !== lastRunning) {
        lastRunning = s.timeRunning;
        clockBtn.textContent = s.timeRunning ? '⏸ 시계 멈춤' : '▶ 시계 재생';
      }
      // 라벨 가시성: 연도·줌 우선순위·거리
      const dist = engine.getViewDistance();
      app.camera.getWorldPosition(tmpV);
      for (const { lm, obj } of labels) {
        const inYear = (!lm.opened || f.year >= lm.opened) && (!lm.closed || f.year < lm.closed);
        const zoomOk = lm.priority === 0 ? dist < 16000 : lm.priority === 1 ? dist < 4500 : dist < 1600;
        const near = tmpV.distanceTo(obj.position) < Math.max(2500, dist * 2.2);
        obj.visible = s.layers.labels && inYear && zoomOk && near;
      }
      // URL 갱신(1초마다, 바뀐 경우만)
      urlTimer += f.dt;
      if (urlTimer > 1) {
        urlTimer = 0;
        const q = writeUrlState(s, engine.getCameraState());
        if (q !== lastUrl) {
          lastUrl = q;
          history.replaceState(null, '', q);
        }
      }
    },
  };
}
