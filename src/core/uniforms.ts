// 모든 커스텀 셰이더가 공유하는 uniform. engine 이 매 프레임 값을 갱신하고,
// world·sim 은 머티리얼의 onBeforeCompile 에서 shader.uniforms 에 이 객체들을 그대로 연결한다(값 복사 금지).

import { Color, Vector3 } from 'three';
import { YEAR_NOW } from '../data/codes.ts';

export function createGlobalUniforms() {
  return {
    /** 타임라인 연도(실수). */
    uYear: { value: YEAR_NOW as number },
    /** 애니메이션용 누적 시간(초). */
    uTime: { value: 0 },
    /** 하루 중 시각(시, 0~24). */
    uTimeOfDay: { value: 12 },
    /** 낮 정도 0(밤)~1(한낮). 조명 세기에 쓴다. */
    uDaylight: { value: 1 },
    /** 밤 정도 0~1. 창문·가로등·전조등 발광 세기에 쓴다. */
    uNight: { value: 0 },
    /** 태양 방향(월드, 정규화, 지면에서 태양 쪽). */
    uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
    /** 지하 투시 정도 0~1. */
    uXray: { value: 0 },
    /** 카메라 월드 위치. */
    uCameraPos: { value: new Vector3() },
    /** 안개 색(하늘 지평선 색과 맞춘다). */
    uFogColor: { value: new Color('#cfe8ff') },
  };
}

export type GlobalUniforms = ReturnType<typeof createGlobalUniforms>;
