// 나무 레이어: 복셀 나무 한 모델을 종류별로 셰이더에서 변형(모양·색)해 청크별 InstancedMesh 로 그린다.
// 인스턴스 속성: aTree = (심은 해, 제거 해, 크기 0~1, 종류). 원거리는 해시로 솎고 남은 나무를 키운다.

import {
  BoxGeometry,
  BufferAttribute,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshDepthMaterial,
  MeshLambertMaterial,
  RGBADepthPacking,
  Group,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AppContext, FrameInfo, System } from '../../core/types.ts';
import { TREE } from '../../data/codes.ts';

const CHUNK = 900;

function treeGeometry() {
  // 줄기(0), 아래 잎(1), 위 잎(2). 높이 단위: 기본 나무 약 7m
  const trunk = new BoxGeometry(0.7, 2.4, 0.7).translate(0, 1.2, 0);
  const low = new BoxGeometry(4.2, 2.6, 4.2).translate(0, 3.6, 0);
  const high = new BoxGeometry(2.8, 2.0, 2.8).translate(0, 5.6, 0);
  const tag = (g: BoxGeometry, v: number) => {
    g.deleteAttribute('uv');
    g.setAttribute('aLeaf', new BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1));
    return g;
  };
  return mergeGeometries([tag(trunk, 0), tag(low, 1), tag(high, 2)]);
}

const VERT = /* glsl */ `
attribute float aLeaf;
attribute vec4 aTree;
uniform float uYear;
uniform float uTime;
uniform vec3 uCameraPos;
uniform float uDensity;
varying float vLeaf;
varying float vKind;
varying float vShade;
`;
const VERT_BODY = /* glsl */ `
  float kind = aTree.w;
  float sz = 0.7 + aTree.z * 0.8;
  vec3 wp0 = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  float h = fract(sin(dot(wp0.xz, vec2(12.9898, 78.233))) * 43758.5453);
  float d = distance(uCameraPos, wp0);
  // 원거리 솎아내기는 CPU 가 청크별 그릴 개수(count)로 한다. 여기서는 같은 비율로 남은 나무를 키워 빈틈을 메운다.
  float keep = clamp(uDensity * (1.0 - smoothstep(1500.0, 9000.0, d) * 0.8), 0.05, 1.0);
  bool alive = (aTree.x < 0.5 || uYear >= aTree.x) && (aTree.y < 0.5 || uYear < aTree.y);
  sz *= 1.0 + (1.0 - keep) * 0.9;
  vec3 s = vec3(sz);
  if (kind == ${TREE.PINE}.0) { if (aLeaf > 0.5) { s.x *= 0.72; s.z *= 0.72; s.y *= 1.25; } }
  else if (kind == ${TREE.BUSH}.0) { s *= 0.55; }
  else if (kind == ${TREE.GINKGO}.0) { if (aLeaf > 0.5) { s.x *= 0.75; s.z *= 0.75; s.y *= 1.1; } }
  else if (kind == ${TREE.FRUIT}.0) { s *= 0.6; }
  transformed *= s;
  if (aLeaf > 0.5) {
    float sway = sin(uTime * 1.3 + h * 20.0) * 0.08 * (transformed.y / 6.0);
    transformed.x += sway;
  }
  if (!alive) transformed = vec3(0.0);
  vLeaf = aLeaf; vKind = kind; vShade = h;
`;

export function createTreeLayer(app: AppContext): System {
  const { meta, a } = app.data.trees;
  const U = app.uniforms;
  const density = { value: app.quality.treeDensity };
  const geo = treeGeometry();
  const mat = new MeshLambertMaterial();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uYear: U.uYear, uTime: U.uTime, uCameraPos: U.uCameraPos, uDensity: density });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERT}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeaf;\nvarying float vKind;\nvarying float vShade;\nvec3 hx(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `vec3 col = hx(110.0, 78.0, 52.0);
  if (vLeaf > 0.5) {
    float k = floor(vKind + 0.5);
    if (k == ${TREE.PINE}.0) col = hx(46.0, 110.0, 62.0);
    else if (k == ${TREE.CHERRY}.0) col = vLeaf > 1.5 ? hx(255.0, 196.0, 214.0) : hx(248.0, 170.0, 196.0);
    else if (k == ${TREE.GINKGO}.0) col = hx(150.0, 190.0, 70.0);
    else if (k == ${TREE.FRUIT}.0) col = hx(120.0, 170.0, 70.0);
    else col = vLeaf > 1.5 ? hx(120.0, 180.0, 76.0) : hx(92.0, 156.0, 64.0);
    col *= 0.9 + 0.2 * vShade;
  }
  vec4 diffuseColor = vec4(col, opacity);`,
      );
  };
  const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depth.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uYear: U.uYear, uTime: U.uTime, uCameraPos: U.uCameraPos, uDensity: density });
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERT}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
  };

  // 청크로 나누기
  const buckets = new Map<string, number[]>();
  for (let i = 0; i < meta.count; i++) {
    const key = `${Math.floor(a.x[i] / CHUNK)},${Math.floor(a.z[i] / CHUNK)}`;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = []));
    b.push(i);
  }
  const group = new Group();
  group.name = 'trees';
  const m = new Matrix4();
  const chunks: { im: InstancedMesh; n: number; cx: number; cz: number }[] = [];
  const hashOf = (i: number) => {
    const v = Math.sin(a.x[i] * 12.9898 + a.z[i] * 78.233) * 43758.5453;
    return v - Math.floor(v);
  };
  for (const raw of buckets.values()) {
    // 해시 순으로 정렬해 두면 앞에서부터 count 만큼 그리는 것이 곧 균일한 솎아내기가 된다
    const ids = raw.slice().sort((p, q2) => hashOf(p) - hashOf(q2));
    const g = geo.clone();
    const attr = new Float32Array(ids.length * 4);
    const im = new InstancedMesh(g, mat, ids.length);
    ids.forEach((i, q) => {
      const rot = ((a.x[i] * 7.31 + a.z[i] * 3.17) % 4) * (Math.PI / 2);
      m.makeRotationY(rot).setPosition(a.x[i], a.y[i], a.z[i]);
      im.setMatrixAt(q, m);
      attr.set([a.planted[i], a.removed[i], a.size[i] / 255, a.kind[i]], q * 4);
    });
    g.setAttribute('aTree', new InstancedBufferAttribute(attr, 4));
    im.computeBoundingSphere();
    im.castShadow = true;
    im.receiveShadow = true;
    im.customDepthMaterial = depth;
    group.add(im);
    let sx = 0;
    let sz = 0;
    for (const i of ids) {
      sx += a.x[i];
      sz += a.z[i];
    }
    chunks.push({ im, n: ids.length, cx: sx / ids.length, cz: sz / ids.length });
  }
  const cam = new Vector3();
  app.scene.add(group);
  const applyVis = () => (group.visible = app.store.get().layers.trees);
  applyVis();
  app.store.subscribe(applyVis, (s) => s.layers.trees);

  return {
    name: 'trees',
    update(_f: FrameInfo) {
      density.value = app.quality.treeDensity;
      app.camera.getWorldPosition(cam);
      for (const c of chunks) {
        const d = Math.hypot(cam.x - c.cx, cam.y, cam.z - c.cz);
        const t = Math.min(1, Math.max(0, (d - 1500) / 7500));
        const keep = Math.min(1, Math.max(0.05, density.value * (1 - t * t * (3 - 2 * t) * 0.8)));
        c.im.count = Math.ceil(c.n * keep);
      }
    },
  };
}
