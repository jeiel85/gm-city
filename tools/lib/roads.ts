// OSM highway 태그 해석(등급·폭·차로·높이 단계). landcover(래스터)와 network(그래프)가 같은 규칙을 쓰도록 공유한다.

import { LEVEL, RC } from '../../src/data/codes.ts';
import type { Tags } from './osm.ts';

const CLASS: Record<string, number> = {
  motorway: RC.MOTORWAY,
  motorway_link: RC.MOTORWAY,
  trunk: RC.TRUNK,
  trunk_link: RC.TRUNK,
  primary: RC.PRIMARY,
  primary_link: RC.PRIMARY,
  secondary: RC.SECONDARY,
  secondary_link: RC.SECONDARY,
  tertiary: RC.TERTIARY,
  tertiary_link: RC.TERTIARY,
  unclassified: RC.RESIDENTIAL,
  residential: RC.RESIDENTIAL,
  living_street: RC.LIVING,
  service: RC.SERVICE,
  busway: RC.BUSWAY,
  footway: RC.FOOTWAY,
  cycleway: RC.CYCLEWAY,
  path: RC.PATH,
  track: RC.PATH,
  bridleway: RC.PATH,
  steps: RC.STEPS,
  pedestrian: RC.PEDESTRIAN,
};

/** highway 태그 → RC. 도로가 아니거나(공사 중·폐도·복도 등) 모르는 값이면 null. */
export function roadClass(tags: Tags | undefined): number | null {
  const hw = tags?.highway;
  if (!hw) return null;
  if (hw === 'construction' || hw === 'proposed' || hw === 'abandoned' || hw === 'corridor' || hw === 'platform' || hw === 'elevator') return null;
  if (tags.indoor === 'yes') return null;
  return CLASS[hw] ?? null;
}

export function isLink(tags: Tags | undefined): boolean {
  return !!tags?.highway?.endsWith('_link');
}

/** 전체 차로 수(양방향 합). lanes 태그가 없으면 등급 기본값. */
export function roadLanes(tags: Tags | undefined, cls: number): number {
  const v = tags?.lanes ? parseInt(tags.lanes, 10) : NaN;
  if (Number.isFinite(v) && v > 0) return Math.min(v, 12);
  if (isLink(tags)) return 1;
  switch (cls) {
    case RC.MOTORWAY:
      return 3; // 보통 방향별로 따로 그려진 일방 도로
    case RC.TRUNK:
      return 6;
    case RC.PRIMARY:
      return 6;
    case RC.SECONDARY:
      return 4;
    case RC.TERTIARY:
      return 2;
    case RC.BUSWAY:
      return 2;
    case RC.RESIDENTIAL:
    case RC.LIVING:
    case RC.SERVICE:
      return 2;
    default:
      return 1;
  }
}

/** 차도(보도 제외) 폭(m). width 태그가 있으면 우선. */
export function roadWidth(tags: Tags | undefined, cls: number): number {
  const w = tags?.width ? parseFloat(tags.width) : NaN;
  if (Number.isFinite(w) && w > 0.5 && w < 80) return w;
  switch (cls) {
    case RC.FOOTWAY:
    case RC.PATH:
    case RC.STEPS:
      return 2;
    case RC.CYCLEWAY:
      return 2.5;
    case RC.PEDESTRIAN:
      return 6;
    case RC.SERVICE:
      return 4.5;
    case RC.LIVING:
      return 5;
    case RC.RESIDENTIAL:
      return tags?.lanes ? roadLanes(tags, cls) * 3.0 : 6;
    default: {
      const lanes = roadLanes(tags, cls);
      const laneW = cls === RC.MOTORWAY || cls === RC.TRUNK ? 3.6 : 3.3;
      return lanes * laneW + (cls === RC.MOTORWAY ? 2 : 1);
    }
  }
}

/** 일방 여부. -1 이면 점 순서의 반대 방향 일방(호출자가 점을 뒤집어야 한다). */
export function roadOneway(tags: Tags | undefined, cls: number): 0 | 1 | -1 {
  const o = tags?.oneway;
  if (o === 'yes' || o === '1' || o === 'true') return 1;
  if (o === '-1' || o === 'reverse') return -1;
  if (o === 'no') return 0;
  if (tags?.junction === 'roundabout') return 1;
  if (cls === RC.MOTORWAY) return 1;
  return 0;
}

/** 높이 단계: 터널 −1, 지상 0, 교량 1 이상(layer 반영). */
export function roadLevel(tags: Tags | undefined): number {
  if (!tags) return LEVEL.GROUND;
  const layer = tags.layer ? parseInt(tags.layer, 10) : 0;
  if (tags.tunnel && tags.tunnel !== 'no' && tags.tunnel !== 'building_passage') return LEVEL.TUNNEL;
  if (tags.covered === 'yes' && Number.isFinite(layer) && layer < 0) return LEVEL.TUNNEL;
  if (tags.bridge && tags.bridge !== 'no') return Math.max(1, Number.isFinite(layer) ? layer : 1);
  return LEVEL.GROUND;
}

/** 지면에 칠할 도로인지(터널·교량 제외). */
export function paintsGround(tags: Tags | undefined): boolean {
  return roadLevel(tags) === LEVEL.GROUND;
}
