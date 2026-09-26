// 월드: 지형·수면·도로 표시·교량·철길·지하 투시 + 건물·나무 레이어를 묶는다.

import type { Raycaster } from 'three';
import type { AppContext, FrameInfo, GroundQuery, PickResult, System } from '../core/types.ts';
import { createTerrain } from './terrain/terrain.ts';
import { createRoadLayers } from './roads/roads.ts';
import { createBuildingLayer } from './buildings/index.ts';
import { createTreeLayer } from './trees/index.ts';

export interface World extends System {
  ground: GroundQuery;
  bounds: { minX: number; minZ: number; maxX: number; maxZ: number };
}

export async function createWorld(app: AppContext, onProgress?: (p: number, label: string) => void): Promise<World> {
  const terrain = await createTerrain(app, (p) => onProgress?.(p * 0.5, '지형 쌓는 중'));
  app.scene.add(terrain.group);
  app.ground = terrain.ground;

  onProgress?.(0.5, '도로와 철길 까는 중');
  app.scene.add(createRoadLayers(app, terrain.ground));

  const buildings = await createBuildingLayer(app, (p) => onProgress?.(0.55 + p * 0.35, '건물 올리는 중'));
  onProgress?.(0.92, '나무 심는 중');
  const trees = createTreeLayer(app);
  const subs: System[] = [buildings, trees];

  return {
    name: 'world',
    ground: terrain.ground,
    bounds: terrain.bounds,
    update(f: FrameInfo) {
      terrain.update();
      for (const s of subs) s.update(f);
    },
    pick(r: Raycaster): PickResult | null {
      let best: PickResult | null = null;
      for (const s of subs) {
        const p = s.pick?.(r);
        if (p && (!best || p.distance < best.distance)) best = p;
      }
      const t = terrain.pick(r, app.uniforms.uYear.value);
      if (t && (!best || t.distance < best.distance - 0.5)) best = t;
      return best;
    },
  };
}
