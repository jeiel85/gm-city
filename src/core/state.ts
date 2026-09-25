// 앱 전역 상태 저장소. UI·엔진·월드·시뮬레이션이 모두 이 상태를 읽고, 사용자 조작은 UI 가 set 한다.

import type { PickResult, FollowTarget } from './types.ts';
import { YEAR_NOW } from '../data/codes.ts';

export interface Layers {
  buildings: boolean;
  trees: boolean;
  people: boolean;
  cars: boolean;
  buses: boolean;
  trains: boolean;
  labels: boolean;
  /** 지하 투시: 지면을 반투명하게 하고 지하철·터널을 보여 준다. */
  xray: boolean;
  /** 미니어처 느낌의 틸트시프트 흐림. */
  tiltShift: boolean;
  shadows: boolean;
}

export type Quality = 'low' | 'medium' | 'high';
export type CameraMode = 'perspective' | 'isometric';

export interface AppState {
  /** 타임라인 연도(실수, 예: 2004.25). YEAR_MIN~YEAR_MAX. */
  year: number;
  yearPlaying: boolean;
  /** 재생 중 초당 진행 연도 수. */
  yearSpeed: number;
  /** 하루 중 시각(시, 0~24). */
  timeOfDay: number;
  /** 시뮬레이션 시계가 흐르는지. */
  timeRunning: boolean;
  /** 실제 1초당 흐르는 시뮬레이션 초. 60 = 1초에 1분. */
  timeScale: number;
  layers: Layers;
  quality: Quality;
  cameraMode: CameraMode;
  /** 클릭으로 선택한 대상의 정보 카드. */
  selected: PickResult | null;
  /** 카메라가 따라가는 대상. */
  follow: FollowTarget | null;
}

export const DEFAULT_STATE: AppState = {
  year: YEAR_NOW,
  yearPlaying: false,
  yearSpeed: 2,
  timeOfDay: 16.5,
  timeRunning: true,
  timeScale: 60,
  layers: {
    buildings: true,
    trees: true,
    people: true,
    cars: true,
    buses: true,
    trains: true,
    labels: true,
    xray: false,
    tiltShift: false,
    shadows: true,
  },
  quality: 'high',
  cameraMode: 'perspective',
  selected: null,
  follow: null,
};

type Listener<T> = (state: T, prev: T) => void;

export class Store<T extends object> {
  private state: T;
  private listeners = new Set<Listener<T>>();

  constructor(initial: T) {
    this.state = initial;
  }

  get(): T {
    return this.state;
  }

  /** 얕은 병합. 바뀐 값이 없으면 알리지 않는다. */
  set(patch: Partial<T>): void {
    const prev = this.state;
    let changed = false;
    for (const k in patch) {
      if (!Object.is(prev[k], patch[k])) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.state = { ...prev, ...patch };
    for (const l of this.listeners) l(this.state, prev);
  }

  /** 상태가 바뀔 때마다 호출. selector 를 주면 그 값이 바뀔 때만 호출한다. 해제 함수를 돌려준다. */
  subscribe<S>(listener: (value: S, state: T) => void, selector: (s: T) => S): () => void;
  subscribe(listener: Listener<T>): () => void;
  subscribe<S>(listener: ((value: S, state: T) => void) | Listener<T>, selector?: (s: T) => S): () => void {
    let l: Listener<T>;
    if (selector) {
      const fn = listener as (value: S, state: T) => void;
      l = (s, p) => {
        const v = selector(s);
        if (!Object.is(v, selector(p))) fn(v, s);
      };
    } else {
      l = listener as Listener<T>;
    }
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
