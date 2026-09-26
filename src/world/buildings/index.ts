// 건물 레이어: 워커 메싱 결과 + 건물 속성 데이터 텍스처 셰이더(연도별 공사·완공·철거, 창문, 밤 불빛, 배색) + 크레인 + 피킹.

import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshDepthMaterial,
  MeshLambertMaterial,
  NearestFilter,
  RGBADepthPacking,
  RGBAFormat,
  type Raycaster,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AppContext, FrameInfo, PickResult, System } from '../../core/types.ts';
import { BF, BK, BK_NAME, LANDMARK_PALETTE, YEAR_SRC_NAME } from '../../data/codes.ts';
import { constructionStartOf } from '../../data/format.ts';
import type { BuildingChunk, BuildingsJob } from './buildings.worker.ts';

const TEX_W = 2048;

/** 건물 i 가 연도 year 에 보이는지(공사 중 포함). 셰이더와 같은 규칙. */
export function buildingVisible(built: number, removed: number, cs: number, year: number): boolean {
  if (removed !== 0 && year >= removed) return false;
  if (built !== 0 && year < cs) return false;
  return true;
}

// 버텍스: 연도에 따른 공사(층 단위로 솟음)·철거(숨김). 그림자 깊이 재질에도 같은 코드를 넣는다.
const VERT_HEAD = /* glsl */ `
attribute float aB;
attribute float aPart;
uniform sampler2D uBTex;
uniform float uYear;
varying float vKind;
varying float vPal;
varying float vFlags;
varying float vPart;
varying float vBuild;
varying float vBId;
varying float vLocalY;
varying float vHgt;
varying float vBuilt;
`;
const VERT_BODY = /* glsl */ `
  int bid = int(aB + 0.5);
  ivec2 t0 = ivec2((bid * 2) % ${TEX_W}, (bid * 2) / ${TEX_W});
  vec4 d0 = texelFetch(uBTex, t0, 0);
  vec4 d1 = texelFetch(uBTex, t0 + ivec2(1, 0), 0);
  float built = d0.x; float removed = d0.y; float cs = d0.z; float hgt = d0.w; float baseY = d1.w;
  float g = 1.0;
  if (built > 0.5) {
    if (uYear < cs) g = 0.0;
    else if (uYear < built) g = clamp((uYear - cs) / max(0.5, built - cs), 0.0, 1.0);
  }
  if (removed > 0.5 && uYear >= removed) g = 0.0;
  float fl = max(1.0, floor(hgt / 3.0));
  g = g <= 0.0 ? 0.0 : (g >= 1.0 ? 1.0 : max(1.0, ceil(g * fl)) / fl);
  vBuild = (built > 0.5 && uYear < built) ? 1.0 : 0.0;
  if (g <= 0.0) transformed = vec3(0.0);
  else transformed.y = baseY + (transformed.y - baseY) * g;
  vKind = d1.x; vPal = d1.y; vFlags = d1.z; vPart = aPart; vBId = aB; vLocalY = transformed.y - baseY; vHgt = hgt * g; vBuilt = built;
`;

const FRAG_HEAD = /* glsl */ `
uniform float uNight;
uniform float uTime;
varying float vKind;
varying float vPal;
varying float vFlags;
varying float vPart;
varying float vBuild;
varying float vBId;
varying float vLocalY;
varying float vHgt;
varying float vBuilt;
varying vec3 vWp;
varying vec3 vN;
float bHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
vec3 hexc(float r, float g, float b) { return pow(vec3(r, g, b) / 255.0, vec3(2.2)); }
bool hasFlag(float f, float bit) { return mod(floor(f / bit), 2.0) > 0.5; }
`;

// 종류·팔레트·시대별 벽/지붕 색 + 창문·불빛. 결과: col(바탕색), emit(발광)
const FRAG_BODY = /* glsl */ `
  vec3 nrm = normalize(vN);
  bool wall = abs(nrm.y) < 0.5;
  float kind = floor(vKind + 0.5);
  float pal = vPal;
  float v4 = mod(pal, 4.0);
  float v8 = mod(floor(pal / 4.0), 8.0);
  vec3 wallC = hexc(236.0, 230.0, 216.0);
  vec3 roofC = hexc(196.0, 196.0, 190.0);
  vec3 band = wallC;
  float winW = 2.5; float winOn = 1.0; float balcony = 0.0;
  if (kind == ${BK.APARTMENT}.0) {
    if (vBuilt > 0.5 && vBuilt < 1995.0) { wallC = hexc(232.0, 220.0, 196.0); band = hexc(140.0, 180.0, 120.0); }
    else if (vBuilt < 2010.0) { wallC = hexc(242.0, 240.0, 234.0); band = v4 < 2.0 ? hexc(120.0, 170.0, 210.0) : hexc(220.0, 150.0, 110.0); }
    else { wallC = hexc(244.0, 244.0, 242.0); band = v4 < 2.0 ? hexc(80.0, 88.0, 100.0) : hexc(150.0, 120.0, 90.0); }
    roofC = hexc(205.0, 205.0, 200.0); balcony = 1.0;
  } else if (kind == ${BK.VILLA}.0) {
    wallC = v4 < 1.0 ? hexc(178.0, 98.0, 74.0) : v4 < 2.0 ? hexc(214.0, 196.0, 164.0) : v4 < 3.0 ? hexc(190.0, 120.0, 90.0) : hexc(226.0, 214.0, 190.0);
    roofC = hexc(200.0, 196.0, 186.0); winW = 3.0;
  } else if (kind == ${BK.HOUSE}.0 || kind == ${BK.FARMHOUSE}.0) {
    wallC = kind == ${BK.FARMHOUSE}.0 ? hexc(222.0, 206.0, 170.0) : (v4 < 2.0 ? hexc(170.0, 92.0, 66.0) : hexc(228.0, 216.0, 192.0));
    roofC = v8 < 3.0 ? hexc(70.0, 104.0, 150.0) : v8 < 5.0 ? hexc(196.0, 104.0, 64.0) : hexc(90.0, 90.0, 96.0);
    winW = 3.5; winOn = 0.7;
  } else if (kind == ${BK.COMMERCIAL}.0) {
    wallC = v8 < 2.0 ? hexc(238.0, 224.0, 200.0) : v8 < 4.0 ? hexc(210.0, 226.0, 236.0) : v8 < 6.0 ? hexc(240.0, 214.0, 214.0) : hexc(226.0, 232.0, 210.0);
    band = v4 < 1.0 ? hexc(230.0, 70.0, 60.0) : v4 < 2.0 ? hexc(40.0, 120.0, 200.0) : v4 < 3.0 ? hexc(250.0, 190.0, 40.0) : hexc(60.0, 170.0, 110.0);
    winW = 3.0;
  } else if (kind == ${BK.OFFICE}.0 || kind == ${BK.HOSPITAL}.0) {
    wallC = kind == ${BK.HOSPITAL}.0 ? hexc(240.0, 242.0, 246.0) : hexc(170.0, 196.0, 214.0);
    winW = 2.0;
  } else if (kind == ${BK.INDUSTRIAL}.0) {
    wallC = hexc(206.0, 208.0, 204.0); roofC = v4 < 3.0 ? hexc(66.0, 116.0, 176.0) : hexc(120.0, 160.0, 120.0); winOn = 0.25; winW = 6.0;
  } else if (kind == ${BK.SCHOOL}.0) {
    wallC = v4 < 2.0 ? hexc(240.0, 226.0, 196.0) : hexc(196.0, 110.0, 80.0); roofC = hexc(220.0, 140.0, 80.0); winW = 3.0;
  } else if (kind == ${BK.PUBLIC}.0) {
    wallC = hexc(232.0, 222.0, 200.0); winW = 3.0;
  } else if (kind == ${BK.RELIGIOUS}.0) {
    wallC = hexc(248.0, 246.0, 240.0); roofC = hexc(160.0, 70.0, 60.0); winOn = 0.5;
  } else if (kind == ${BK.STATION}.0) {
    wallC = hexc(160.0, 200.0, 224.0); roofC = hexc(220.0, 226.0, 232.0); winW = 2.0;
  } else if (kind == ${BK.BIGBOX}.0) {
    wallC = hexc(222.0, 222.0, 218.0); winOn = 0.0;
  } else if (kind == ${BK.GREENHOUSE}.0) {
    wallC = hexc(236.0, 240.0, 236.0); roofC = hexc(236.0, 242.0, 238.0); winOn = 0.0;
  } else if (kind == ${BK.PARKING}.0) {
    wallC = hexc(180.0, 184.0, 186.0); winOn = 0.0;
  }
  // 랜드마크 배색
  if (hasFlag(vFlags, ${BF.LANDMARK}.0)) {
    float p = floor(pal + 0.5);
    if (p == ${LANDMARK_PALETTE.IKEA}.0) { wallC = hexc(0.0, 88.0, 163.0); band = hexc(255.0, 219.0, 0.0); roofC = hexc(200.0, 204.0, 208.0); winOn = 0.0; }
    else if (p == ${LANDMARK_PALETTE.COSTCO}.0) { wallC = hexc(226.0, 226.0, 222.0); band = hexc(227.0, 24.0, 55.0); winOn = 0.0; }
    else if (p == ${LANDMARK_PALETTE.LOTTE_OUTLET}.0) { wallC = hexc(240.0, 234.0, 222.0); band = hexc(218.0, 41.0, 28.0); winOn = 0.3; }
    else if (p == ${LANDMARK_PALETTE.KTX_STATION}.0) { wallC = hexc(150.0, 196.0, 222.0); roofC = hexc(230.0, 236.0, 240.0); winW = 2.0; }
    else if (p == ${LANDMARK_PALETTE.CITY_HALL}.0) { wallC = hexc(236.0, 226.0, 204.0); roofC = hexc(120.0, 140.0, 160.0); }
    else if (p == ${LANDMARK_PALETTE.SPEEDOME}.0) { wallC = hexc(214.0, 220.0, 228.0); roofC = hexc(190.0, 200.0, 214.0); winOn = 0.0; }
    else if (p == ${LANDMARK_PALETTE.KIA_PLANT}.0) { wallC = hexc(232.0, 232.0, 232.0); roofC = hexc(80.0, 96.0, 118.0); winOn = 0.2; }
  }
  vec3 col = wallC;
  vec3 emit = vec3(0.0);
  float part = floor(vPart + 0.5);
  if (!wall || part == 1.0) col = roofC;
  if (part == 2.0 && !wall) col = hexc(64.0, 168.0, 110.0);
  if (part == 4.0) col = hexc(214.0, 214.0, 208.0);
  if (part == 3.0) { col = hexc(240.0, 240.0, 240.0); emit = hexc(255.0, 40.0, 40.0) * uNight * 3.0; }
  if (wall && part == 0.0) {
    float ly = vLocalY;
    float fy = fract(ly / 3.0);
    float fi = floor(ly / 3.0);
    float along = dot(vWp.xz, vec2(-nrm.z, nrm.x));
    float fx = fract(along / winW);
    float ci = floor(along / winW);
    bool topBand = ly > vHgt - 2.2;
    if ((kind == ${BK.COMMERCIAL}.0 && ly < 3.0 && fy < 0.35) || ((kind == ${BK.APARTMENT}.0 || hasFlag(vFlags, ${BF.LANDMARK}.0)) && topBand)) col = band;
    else if (winOn > 0.0 && ly > 0.8 && fy > 0.32 && fy < 0.82 && fx > 0.18 && fx < 0.82 && bHash(vec3(ci, fi, vBId)) < winOn) {
      col = hexc(92.0, 122.0, 150.0);
      float lit = step(0.52, bHash(vec3(ci * 1.7, fi * 3.1, vBId + 0.5)));
      emit = hexc(255.0, 214.0, 140.0) * lit * uNight * 1.6;
    } else if (balcony > 0.5 && fy < 0.14) col = mix(wallC, vec3(1.0), 0.35);
  }
  if (vBuild > 0.5) {
    // 공사 중: 회색 골조 + 초록 안전망
    col = mod(floor(vLocalY / 1.5), 2.0) < 1.0 ? hexc(150.0, 152.0, 150.0) : hexc(70.0, 140.0, 90.0);
    emit = vec3(0.0);
  }
  if (hasFlag(vFlags, ${BF.OUTSIDE}.0)) { col = mix(col, hexc(240.0, 236.0, 228.0), 0.8); emit *= 0.0; }
  col *= 0.97 + 0.06 * bHash(vec3(vBId, 1.0, 2.0));
`;

export async function createBuildingLayer(app: AppContext, onProgress?: (p: number) => void): Promise<System> {
  const { meta: bm, a: B } = app.data.buildings;
  const wm = app.data.world.meta;
  const n = bm.count;
  const U = app.uniforms;

  // 건물 속성 데이터 텍스처(2텍셀/동)
  const rows = Math.max(1, Math.ceil((n * 2) / TEX_W));
  const data = new Float32Array(TEX_W * rows * 4);
  const cs = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    cs[i] = constructionStartOf(B, i);
    const o = i * 8;
    data[o] = B.built[i];
    data[o + 1] = B.removed[i];
    data[o + 2] = cs[i];
    data[o + 3] = B.heightDm[i] / 10;
    data[o + 4] = B.kind[i];
    data[o + 5] = B.palette[i];
    data[o + 6] = B.flags[i];
    data[o + 7] = B.baseDm[i] / 10;
  }
  const btex = new DataTexture(data, TEX_W, rows, RGBAFormat, FloatType);
  btex.magFilter = btex.minFilter = NearestFilter;
  btex.generateMipmaps = false;
  btex.needsUpdate = true;

  const mat = new MeshLambertMaterial();
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uBTex: { value: btex }, uYear: U.uYear, uNight: U.uNight, uTime: U.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}\nvarying vec3 vWp;\nvarying vec3 vN;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`)
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', `${FRAG_BODY}\n  vec4 diffuseColor = vec4(col, opacity);`)
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive + emit;');
  };
  const depthMat = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  depthMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { uBTex: { value: btex }, uYear: U.uYear });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>\n${VERT_HEAD}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${VERT_BODY}`);
  };

  // 워커 메싱
  const group = new Group();
  group.name = 'buildings';
  const meshes: Mesh[] = [];
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./buildings.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`건물 워커 오류: ${e.message}`));
    };
    worker.onmessage = (e: MessageEvent<BuildingChunk | { type: 'done' } | { type: 'error'; message: string }>) => {
      const d = e.data;
      if (d.type === 'error') {
        worker.terminate();
        reject(new Error(`건물 메싱 실패: ${d.message}`));
        return;
      }
      if (d.type === 'done') {
        worker.terminate();
        resolve();
        return;
      }
      const g = new BufferGeometry();
      g.setAttribute('position', new BufferAttribute(d.positions, 3));
      g.setAttribute('normal', new BufferAttribute(d.normals, 3, true));
      g.setAttribute('aB', new BufferAttribute(d.bid, 1));
      g.setAttribute('aPart', new BufferAttribute(d.part, 1));
      g.setIndex(new BufferAttribute(d.indices, 1));
      g.computeBoundingSphere();
      const mesh = new Mesh(g, mat);
      mesh.customDepthMaterial = depthMat;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
      meshes.push(mesh);
      onProgress?.(d.done / d.total);
    };
    const job: BuildingsJob = {
      rects: B.rects,
      rectStart: B.rectStart,
      rectCount: B.rectCount,
      heightDm: B.heightDm,
      baseDm: B.baseDm,
      kind: B.kind,
      roof: B.roof,
      cx: B.cx,
      cz: B.cz,
      sub: wm.subSize,
      x0: wm.x0,
      z0: wm.z0,
      chunkSize: 320,
    };
    worker.postMessage(job);
  });
  app.scene.add(group);

  // 타워크레인: 공사 기간이 있는 큰 건물
  const craneIds: number[] = [];
  for (let i = 0; i < n; i++) {
    const k = B.kind[i];
    if (B.built[i] && (k === BK.APARTMENT || k === BK.OFFICE || k === BK.BIGBOX || k === BK.HOSPITAL) && B.heightDm[i] >= 200 && !(B.flags[i] & BF.OUTSIDE) && B.rectCount[i] > 0) craneIds.push(i);
  }
  const mast = new BoxGeometry(1.6, 1, 1.6).translate(0, 0.5, 0);
  const jib = new BoxGeometry(24, 1.2, 1.2).translate(6, 0, 0);
  const cab = new BoxGeometry(2.2, 2, 2.2);
  const jibParts = mergeGeometries([jib, cab]);
  const markJib = (g: BufferGeometry, v: number) => {
    g.setAttribute('aJib', new BufferAttribute(new Float32Array(g.attributes.position.count).fill(v), 1));
    return g;
  };
  const craneGeo = mergeGeometries([markJib(mast, 0), markJib(jibParts, 1)]);
  const craneMat = new MeshLambertMaterial({ color: '#f2b705' });
  const craneVert = (sh: { uniforms: Record<string, unknown>; vertexShader: string }) => {
    Object.assign(sh.uniforms, { uYear: U.uYear, uTime: U.uTime });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aJib;\nattribute vec4 aCrane;\nuniform float uYear;\nuniform float uTime;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  // aCrane: (착공, 준공, 높이, 위상)
  float h = aCrane.z + 8.0;
  if (aJib < 0.5) transformed.y *= h;
  else {
    float a = uTime * 0.15 + aCrane.w;
    transformed.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * transformed.xz;
    transformed.y += h;
  }
  if (uYear < aCrane.x || uYear >= aCrane.y) transformed = vec3(0.0);`,
      );
  };
  craneMat.onBeforeCompile = craneVert;
  const craneDepth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
  craneDepth.onBeforeCompile = craneVert;
  const cranes = new InstancedMesh(craneGeo, craneMat, Math.max(1, craneIds.length));
  cranes.count = craneIds.length;
  const craneAttr = new Float32Array(Math.max(1, craneIds.length) * 4);
  const mtx = new Matrix4();
  craneIds.forEach((i, q) => {
    const r = B.rectStart[i];
    // 가장 첫 사각형의 모서리 바깥쪽
    const x = wm.x0 + B.rects[r * 4] * wm.subSize - 3;
    const z = wm.z0 + B.rects[r * 4 + 1] * wm.subSize - 3;
    mtx.makeTranslation(x, B.baseDm[i] / 10, z);
    cranes.setMatrixAt(q, mtx);
    craneAttr.set([cs[i], B.built[i], B.heightDm[i] / 10, (i % 17) * 0.37], q * 4);
  });
  craneGeo.setAttribute('aCrane', new InstancedBufferAttribute(craneAttr, 4));
  cranes.customDepthMaterial = craneDepth;
  cranes.castShadow = true;
  cranes.frustumCulled = false;
  app.scene.add(cranes);

  const store = app.store;
  const applyVis = () => {
    const v = store.get().layers.buildings;
    group.visible = v;
    cranes.visible = v;
  };
  applyVis();
  store.subscribe(applyVis, (s) => s.layers.buildings);

  const ICON: Record<number, string> = { [BK.APARTMENT]: '🏢', [BK.VILLA]: '🏘️', [BK.HOUSE]: '🏠', [BK.FARMHOUSE]: '🛖', [BK.COMMERCIAL]: '🏪', [BK.OFFICE]: '🏬', [BK.INDUSTRIAL]: '🏭', [BK.SCHOOL]: '🏫', [BK.PUBLIC]: '🏛️', [BK.RELIGIOUS]: '⛪', [BK.STATION]: '🚉', [BK.HOSPITAL]: '🏥', [BK.BIGBOX]: '🛒', [BK.GREENHOUSE]: '🌱', [BK.PARKING]: '🅿️' };

  return {
    name: 'buildings',
    update(_f: FrameInfo) {},
    pick(r: Raycaster): PickResult | null {
      if (!group.visible) return null;
      const year = U.uYear.value;
      const hits = r.intersectObjects(meshes, false);
      for (const hit of hits) {
        if (!hit.face) continue;
        const geo = (hit.object as Mesh).geometry;
        const i = Math.round((geo.attributes.aB as BufferAttribute).getX(hit.face.a));
        if (!buildingVisible(B.built[i], B.removed[i], cs[i], year)) continue;
        const kind = B.kind[i];
        const name = B.nameIdx[i] >= 0 ? bm.names[B.nameIdx[i]] : null;
        const flags = B.flags[i];
        const fields = [
          { label: '종류', value: BK_NAME[kind] ?? '건물' },
          { label: '층수', value: `${B.floors[i]}층 (높이 약 ${(B.heightDm[i] / 10).toFixed(0)} m)` },
          { label: '준공', value: B.built[i] ? `${B.built[i]}년 · ${YEAR_SRC_NAME[B.yearSource[i]]}` : '1960년 이전 · 추정' },
        ];
        if (B.built[i] && year < B.built[i]) fields.push({ label: '상태', value: `공사 중 (착공 ${cs[i]}년)` });
        if (B.removed[i]) fields.push({ label: '철거', value: `${B.removed[i]}년` });
        let note: string | undefined;
        if (flags & BF.PROCEDURAL) note = 'OSM에 없는 곳을 채운 절차 생성 건물이라 실제 모양·위치와 다릅니다.';
        else if (B.yearSource[i] !== 0) note = '준공 연도는 추정값입니다.';
        if (flags & BF.PLANNED) note = `${note ? note + ' ' : ''}완공 예정 연도는 바뀔 수 있습니다.`;
        if (flags & BF.OUTSIDE) note = '광명시 밖 건물(흰 모형으로 표시).';
        return {
          distance: hit.distance,
          point: [hit.point.x, hit.point.y, hit.point.z],
          info: { icon: ICON[kind] ?? '🏢', title: name ?? BK_NAME[kind] ?? '건물', subtitle: flags & BF.OUTSIDE ? '광명시 밖' : undefined, fields, note },
        };
      }
      return null;
    },
  };
}
