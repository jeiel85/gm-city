// 지형·수면: 워커 메싱 결과로 청크 메시(LOD0/LOD1)를 만들고, 셀 텍스처 셰이더로 연도별 색을 칠한다.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  MeshLambertMaterial,
  Vector2,
  Vector3,
  type Raycaster,
} from 'three';
import type { AppContext, GroundQuery, PickResult } from '../../core/types.ts';
import { LC, LC_INFO, MASK } from '../../data/codes.ts';
import { landCoverAt } from '../../data/format.ts';
import { GLSL_CELL, makeCellTextures, paletteUniform } from '../palette.ts';
import { terrainTops, isWater, WATER_SURFACE_DROP } from './tops.ts';
import type { HeightGrid, MeshData } from './mesher.ts';
import type { ChunkResult } from './terrain.worker.ts';

const CHUNK = 64;

interface Chunk {
  lod0: Mesh;
  lod1: Mesh;
  water: Mesh | null;
  center: Vector3;
}

function geometryOf(m: MeshData): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(m.positions, 3));
  g.setAttribute('normal', new BufferAttribute(m.normals, 3, true));
  g.setAttribute('aTop', new BufferAttribute(m.tops, 1));
  g.setIndex(new BufferAttribute(m.indices, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

export interface Terrain {
  group: Group;
  ground: GroundQuery;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
  update(): void;
  pick(r: Raycaster, year: number): PickResult | null;
}

export async function createTerrain(app: AppContext, onProgress: (p: number) => void): Promise<Terrain> {
  const { meta: m, a } = app.data.world;
  const { top, mask } = terrainTops(a, m);
  const base = Math.floor(m.minHeight) - 25;

  // ── 지면 질의(렌더링 윗면과 일치) ──
  const cellK = (x: number, z: number) => {
    const i = Math.floor((x - m.x0) / m.cellSize);
    const j = Math.floor((z - m.z0) / m.cellSize);
    return i < 0 || j < 0 || i >= m.width || j >= m.height ? -1 : j * m.width + i;
  };
  const ground: GroundQuery = {
    heightAt(x, z) {
      const k = cellK(x, z);
      if (k < 0 || !mask[k]) return 0;
      return isWater(a, k) ? Math.round(a.height[k] / 10) - WATER_SURFACE_DROP : top[k];
    },
    landCoverAt(x, z, year) {
      const k = cellK(x, z);
      return k < 0 || !mask[k] ? LC.VOID : landCoverAt(a, k, year);
    },
    inCity(x, z) {
      const k = cellK(x, z);
      return k >= 0 && mask[k] === MASK.CITY;
    },
  };

  // ── 재질 ──
  const tex = makeCellTextures(a, m, app.renderer.capabilities.maxTextureSize);
  const U = app.uniforms;
  const cellUniforms = {
    uCellTex: { value: tex.cell },
    uYearTex: { value: tex.year },
    uPalette: { value: paletteUniform() },
    uGridOrigin: { value: new Vector2(m.x0, m.z0) },
    uGridSize: { value: new Vector2(m.width, m.height) },
    uCellSize: { value: m.cellSize },
  };
  const paper = new Color('#ece6da');
  const terrainMat = new MeshLambertMaterial();
  terrainMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cellUniforms, { uYear: U.uYear, uXray: U.uXray, uCameraPos: U.uCameraPos, uPaper: { value: paper }, uBase: { value: base } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aTop;\nvarying vec3 vWp;\nvarying float vTopH;\nvarying vec3 vN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvTopH = aTop;\nvN = normal;');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform float uYear;
uniform float uXray;
uniform vec3 uCameraPos;
uniform vec3 uPaper;
uniform float uBase;
varying vec3 vWp;
varying float vTopH;
varying vec3 vN;
${GLSL_CELL}`,
      )
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
  vec3 nrm = normalize(vN);
  ivec2 cc = gmCellOf(vWp.xz - nrm.xz * uCellSize * 0.5);
  float msk;
  float lc = gmLcAt(cc, uYear, msk);
  vec3 col = uPalette[int(lc)];
  float hsh = gmHash(vec2(cc));
  col *= 0.955 + 0.09 * hsh;
  if (lc == ${LC.WATER}.0) col = vec3(0.62, 0.55, 0.40);
  bool side = nrm.y < 0.5;
  if (side) {
    float depth = vTopH - vWp.y;
    if (depth > 0.8) {
      float band = step(4.0, depth) + step(12.0, depth);
      vec3 dirt = mix(vec3(0.42, 0.26, 0.15), vec3(0.30, 0.19, 0.12), band * 0.5);
      if (vWp.y < uBase + 12.0) dirt = vec3(0.36, 0.35, 0.37);
      col = dirt * (0.93 + 0.07 * gmHash(floor(vWp.xz * 0.5) + floor(vWp.y)));
    }
    col *= 0.86;
  } else {
    // 가까이서만 보이는 옅은 셀 경계선
    vec2 f = fract((vWp.xz - uGridOrigin) / uCellSize);
    float edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
    float fade = 1.0 - smoothstep(150.0, 600.0, distance(uCameraPos, vWp));
    col *= mix(1.0, mix(0.9, 1.0, smoothstep(0.0, 0.05, edge)), fade);
  }
  if (msk < 1.5) col = mix(col, uPaper, 0.62);
  col *= 1.0 - 0.3 * uXray;
  vec4 diffuseColor = vec4(col, opacity);`,
      );
  };
  const waterMat = new MeshLambertMaterial({ color: '#46b0e8', transparent: true, opacity: 0.84, depthWrite: false });
  waterMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, cellUniforms, { uTime: U.uTime, uDaylight: U.uDaylight, uYear: U.uYear });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform float uTime;\nuniform float uDaylight;\nuniform float uYear;\nvarying vec3 vWp;\n${GLSL_CELL}`)
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `
  vec2 p = vWp.xz * 0.08;
  float wv = sin(p.x * 2.1 + uTime * 1.3) * sin(p.y * 1.7 - uTime * 1.1) + 0.5 * sin((p.x + p.y) * 4.0 + uTime * 2.0);
  vec3 col = diffuse * (0.92 + 0.08 * wv);
  // 물가 거품: 이웃 셀이 물이 아니면 가장자리를 밝게
  ivec2 c = gmCellOf(vWp.xz);
  vec2 f = fract((vWp.xz - uGridOrigin) / uCellSize);
  float m0; float foam = 0.0;
  if (gmLcAt(c + ivec2(1, 0), uYear, m0) != ${LC.WATER}.0) foam = max(foam, smoothstep(0.75, 1.0, f.x));
  if (gmLcAt(c - ivec2(1, 0), uYear, m0) != ${LC.WATER}.0) foam = max(foam, smoothstep(0.25, 0.0, f.x));
  if (gmLcAt(c + ivec2(0, 1), uYear, m0) != ${LC.WATER}.0) foam = max(foam, smoothstep(0.75, 1.0, f.y));
  if (gmLcAt(c - ivec2(0, 1), uYear, m0) != ${LC.WATER}.0) foam = max(foam, smoothstep(0.25, 0.0, f.y));
  col = mix(col, vec3(0.9, 0.97, 1.0), foam * 0.7);
  float spark = step(0.985, gmHash(floor(vWp.xz * 0.7) + floor(uTime * 2.0))) * uDaylight;
  col += spark * 0.35;
  vec4 diffuseColor = vec4(col, opacity);`,
      );
  };

  // ── 워커 메싱 ──
  const group = new Group();
  group.name = 'terrain';
  const waterTop = new Int16Array(top.length);
  const waterMask = new Uint8Array(top.length);
  for (let k = 0; k < top.length; k++)
    if (mask[k] && isWater(a, k)) {
      waterMask[k] = 1;
      waterTop[k] = Math.round(a.height[k] / 10);
    }
  const grid: HeightGrid = { w: m.width, h: m.height, cell: m.cellSize, x0: m.x0, z0: m.z0, top, mask, base };
  const water: HeightGrid = { ...grid, top: waterTop, mask: waterMask };
  const chunks: Chunk[] = [];
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(`지형 워커 오류: ${e.message}`));
    };
    worker.onmessage = (e: MessageEvent<ChunkResult | { type: 'done' } | { type: 'error'; message: string }>) => {
      const d = e.data;
      if (d.type === 'error') {
        worker.terminate();
        reject(new Error(`지형 메싱 실패: ${d.message}`));
        return;
      }
      if (d.type === 'done') {
        worker.terminate();
        resolve();
        return;
      }
      const lod0 = new Mesh(geometryOf(d.lod0), terrainMat);
      const lod1 = new Mesh(geometryOf(d.lod1), terrainMat);
      lod0.receiveShadow = lod1.receiveShadow = true;
      lod1.visible = false;
      lod0.matrixAutoUpdate = lod1.matrixAutoUpdate = false;
      group.add(lod0, lod1);
      let wm: Mesh | null = null;
      if (d.water) {
        wm = new Mesh(geometryOf(d.water), waterMat);
        wm.position.y = -WATER_SURFACE_DROP;
        wm.updateMatrix();
        wm.matrixAutoUpdate = false;
        wm.renderOrder = 2;
        wm.receiveShadow = true;
        group.add(wm);
      }
      const [x0, z0, x1, z1] = d.bounds;
      chunks.push({ lod0, lod1, water: wm, center: new Vector3((x0 + x1) / 2, (lod0.geometry.boundingBox!.max.y + lod0.geometry.boundingBox!.min.y) / 2, (z0 + z1) / 2) });
      onProgress(d.done / d.total);
    };
    worker.postMessage({ grid, water, chunk: CHUNK });
  });
  if (!chunks.length) throw new Error('지형 메시가 비어 있습니다');

  // 도시 경계 범위
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let j = 0; j < m.height; j++)
    for (let i = 0; i < m.width; i++)
      if (mask[j * m.width + i] === MASK.CITY) {
        const x = m.x0 + i * m.cellSize;
        const z = m.z0 + j * m.cellSize;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }

  const camPos = new Vector3();
  return {
    group,
    ground,
    bounds: { minX, minZ, maxX, maxZ },
    update() {
      app.camera.getWorldPosition(camPos);
      const lodD2 = app.quality.lodDistance ** 2;
      for (const c of chunks) {
        const near = camPos.distanceToSquared(c.center) < lodD2;
        c.lod0.visible = near;
        c.lod1.visible = !near;
      }
    },
    pick(r, year) {
      const hits = r.intersectObjects(chunks.map((c) => (c.lod0.visible ? c.lod0 : c.lod1)), false);
      const hit = hits[0];
      if (!hit) return null;
      const p = hit.point;
      const k = cellK(p.x - (hit.face?.normal.x ?? 0) * 0.1, p.z - (hit.face?.normal.z ?? 0) * 0.1);
      if (k < 0 || !mask[k]) return null;
      const lcNow = landCoverAt(a, k, year);
      const dist = a.district[k] !== 255 ? m.districts[a.district[k]]?.name : undefined;
      const hist: string[] = [LC_INFO[a.lc0[k]].name];
      if (a.y1[k]) hist.push(`${a.y1[k]} ${LC_INFO[a.lc1[k]].name}`);
      if (a.y2[k]) hist.push(`${a.y2[k]} ${LC_INFO[a.lc2[k]].name}`);
      const fields = [
        { label: '해발', value: `${ground.heightAt(p.x, p.z).toFixed(0)} m` },
        { label: '변화', value: hist.join(' → ') },
      ];
      const outside = mask[k] === MASK.MARGIN;
      return {
        distance: hit.distance,
        point: [p.x, p.y, p.z],
        info: {
          icon: lcNow === LC.WATER ? '🌊' : lcNow === LC.FOREST ? '🌳' : '🗺️',
          title: LC_INFO[lcNow].name,
          subtitle: outside ? '광명시 밖' : dist ? `광명시 ${dist}` : '광명시',
          fields,
          note: a.y1[k] || a.y2[k] ? '변화 시기는 건물 준공 연도·개발지구 자료로 추정한 값입니다.' : undefined,
        },
      };
    },
  };
}
