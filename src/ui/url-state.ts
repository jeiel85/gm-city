// URL 공유 상태: ?y=연도&t=시각&cam=x,z,거리,방위,극각&l=레이어비트
// 잘못된 값은 무시하고 범위를 넘으면 잘라낸다.

import type { AppState, Layers } from '../core/state.ts';
import type { CameraState } from '../core/types.ts';
import { YEAR_MAX, YEAR_MIN } from '../data/codes.ts';

export const LAYER_KEYS: (keyof Layers)[] = ['buildings', 'trees', 'people', 'cars', 'buses', 'trains', 'labels', 'xray', 'tiltShift', 'shadows'];

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const num = (s: string | null): number | null => {
  if (s === null || s.trim() === '') return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
};

export function readUrlState(search: string): { state: Partial<AppState>; camera?: Partial<CameraState> } {
  const p = new URLSearchParams(search);
  const state: Partial<AppState> = {};
  const y = num(p.get('y'));
  if (y !== null) state.year = clamp(y, YEAR_MIN, YEAR_MAX);
  const t = num(p.get('t'));
  if (t !== null) state.timeOfDay = ((t % 24) + 24) % 24;
  const l = num(p.get('l'));
  if (l !== null && l >= 0 && Number.isInteger(l)) {
    const layers = {} as Layers;
    LAYER_KEYS.forEach((k, i) => (layers[k] = ((l >> i) & 1) === 1));
    state.layers = layers;
  }
  if (p.get('iso') === '1') state.cameraMode = 'isometric';
  let camera: Partial<CameraState> | undefined;
  const cam = p.get('cam');
  if (cam) {
    const v = cam.split(',').map(Number);
    if (v.length === 5 && v.every(Number.isFinite)) camera = { x: v[0], z: v[1], distance: clamp(v[2], 20, 16000), azimuth: v[3], polar: clamp(v[4], 5, 85) };
  }
  return { state, camera };
}

export function layersToBits(l: Layers): number {
  return LAYER_KEYS.reduce((b, k, i) => b | ((l[k] ? 1 : 0) << i), 0);
}

export function writeUrlState(s: Pick<AppState, 'year' | 'timeOfDay' | 'layers' | 'cameraMode'>, cam: CameraState): string {
  const p = new URLSearchParams();
  p.set('y', s.year.toFixed(1).replace(/\.0$/, ''));
  p.set('t', s.timeOfDay.toFixed(1));
  p.set('cam', [cam.x, cam.z, cam.distance, cam.azimuth, cam.polar].map((v) => Math.round(v)).join(','));
  p.set('l', String(layersToBits(s.layers)));
  if (s.cameraMode === 'isometric') p.set('iso', '1');
  return `?${p.toString()}`;
}

/** 연도 표시: 정수 연도와 계획 여부. */
export function yearLabel(year: number, now: number): { text: string; planned: boolean } {
  const y = Math.floor(year);
  return { text: `${y}`, planned: y > now };
}

/** 시각 표시 "오후 4:30". */
export function timeLabel(h: number): string {
  const t = ((h % 24) + 24) % 24;
  const hh = Math.floor(t);
  const mm = Math.floor((t - hh) * 60);
  const ampm = hh < 12 ? '오전' : '오후';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${ampm} ${h12}:${String(mm).padStart(2, '0')}`;
}

/** 연도가 prev → next 로 움직일 때 지나친 사건 인덱스(정렬된 목록 기준). */
export function crossedEvents(years: number[], prev: number, next: number): number[] {
  if (next <= prev) return [];
  const out: number[] = [];
  years.forEach((y, i) => {
    if (y > Math.floor(prev) && y <= Math.floor(next)) out.push(i);
  });
  return out;
}
