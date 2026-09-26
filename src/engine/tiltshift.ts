// 틸트시프트(미니어처) 후처리: 화면 가운데 띠는 선명하고 위아래로 갈수록 흐려진다. 가로·세로 두 번 적용.

import type { ShaderMaterialParameters } from 'three';

export function tiltShiftShader(horizontal: boolean): ShaderMaterialParameters & { uniforms: Record<string, { value: unknown }> } {
  return {
    uniforms: {
      tDiffuse: { value: null },
      uDelta: { value: horizontal ? [1 / 1024, 0] : [0, 1 / 1024] },
      uFocus: { value: 0.5 },
      uBand: { value: 0.22 },
      uStrength: { value: 2.6 },
    },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tDiffuse;
      uniform vec2 uDelta;
      uniform float uFocus, uBand, uStrength;
      varying vec2 vUv;
      void main() {
        float d = max(0.0, abs(vUv.y - uFocus) - uBand);
        float r = clamp(d * uStrength * 6.0, 0.0, 1.0) * 6.0;
        vec4 sum = vec4(0.0);
        float wsum = 0.0;
        for (int i = -6; i <= 6; i++) {
          float fi = float(i);
          float wgt = exp(-fi * fi / 18.0);
          sum += texture2D(tDiffuse, vUv + uDelta * fi * r) * wgt;
          wsum += wgt;
        }
        gl_FragColor = sum / wsum;
      }`,
  };
}
