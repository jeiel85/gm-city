// 모듈 사이의 인터페이스. engine / world / sim / ui 는 서로를 직접 import 하지 않고 이 타입으로만 소통한다.

import type { Camera, Raycaster, Scene, Vector3, WebGLRenderer } from 'three';
import type { Store, AppState } from './state.ts';
import type { GlobalUniforms } from './uniforms.ts';
import type { LoadedData } from '../data/loader.ts';

/** 한 프레임의 시간 정보. */
export interface FrameInfo {
  /** 실제 경과 초(최대 0.1로 잘림). */
  dt: number;
  /** 시뮬레이션 경과 초(dt × timeScale, 시계 정지 시 0). */
  simDt: number;
  /** 앱 시작 후 실제 누적 초. */
  time: number;
  /** 현재 타임라인 연도(실수). */
  year: number;
  /** 하루 중 시각(시). */
  timeOfDay: number;
}

/** 정보 카드에 보일 내용. 모듈이 자기 대상의 설명을 직접 만든다. */
export interface InfoCard {
  icon: string; // 이모지 한 글자
  title: string;
  subtitle?: string;
  fields: { label: string; value: string }[];
  /** 추정치·출처 등 주의 문구. */
  note?: string;
}

/** 카메라가 따라갈 수 있는 대상. */
export interface FollowTarget {
  label: string;
  /** 현재 위치를 out 에 써 넣는다. 대상이 사라졌으면 false. */
  getPosition(out: Vector3): boolean;
  /** 진행 방향(라디안, +X 기준 반시계, 위에서 볼 때). 모르면 null. */
  getHeading(): number | null;
}

export interface PickResult {
  distance: number;
  point: [number, number, number];
  info: InfoCard;
  follow?: FollowTarget;
}

/** 지면 질의. world 모듈이 제공하고 sim·ui 가 쓴다. */
export interface GroundQuery {
  /** 렌더링된 지면(지형 블록 윗면) 높이(m). 격자 밖이면 0. */
  heightAt(x: number, z: number): number;
  /** 연도 year 의 토지피복 코드(LC). 격자 밖이면 LC.VOID. */
  landCoverAt(x: number, z: number, year: number): number;
  /** 셀이 광명시 안인지. */
  inCity(x: number, z: number): boolean;
}

/** 매 프레임 갱신되는 구성 요소. */
export interface System {
  readonly name: string;
  update(frame: FrameInfo): void;
  /** 광선이 맞힌 가장 가까운 대상. 없으면 null. */
  pick?(raycaster: Raycaster): PickResult | null;
  dispose?(): void;
}

export interface QualityProfile {
  pixelRatioCap: number;
  shadowMapSize: number;
  /** 사람·차량 수 배율(1 = 기본). */
  agentDensity: number;
  /** 나무 밀도 배율. */
  treeDensity: number;
  /** 원거리 청크를 저해상도 LOD 로 바꾸는 거리(m). */
  lodDistance: number;
}

/** 카메라 상태(URL 공유·복원용). azimuth/polar 는 도(degree). */
export interface CameraState {
  x: number;
  z: number;
  distance: number;
  azimuth: number;
  polar: number;
}

/** engine 이 UI 에 제공하는 조작 API. */
export interface EngineApi {
  readonly canvas: HTMLCanvasElement;
  /** (x, z) 를 화면 중앙으로 부드럽게 이동. distance 를 주면 그 거리까지 줌. */
  focusOn(x: number, z: number, distance?: number): void;
  /** 카메라를 수직축 기준으로 deg 만큼 회전(RCT 식 90° 회전 버튼). */
  rotateBy(deg: number): void;
  resetView(): void;
  getCameraState(): CameraState;
  setCameraState(s: Partial<CameraState>): void;
  /** 카메라에서 주시점까지 거리(m). 라벨 LOD 등에 쓴다. */
  getViewDistance(): number;
  /** 매 프레임 렌더 직후 호출될 콜백 등록(라벨 오버레이 등). 해제 함수 반환. */
  onAfterRender(cb: () => void): () => void;
}

export interface AppContext {
  renderer: WebGLRenderer;
  scene: Scene;
  /** 현재 활성 카메라(원근/등각 전환 시 바뀐다 — 매번 이 속성을 읽을 것). */
  readonly camera: Camera;
  store: Store<AppState>;
  uniforms: GlobalUniforms;
  data: LoadedData;
  quality: QualityProfile;
  /** world 초기화 후 채워진다. */
  ground: GroundQuery;
}
