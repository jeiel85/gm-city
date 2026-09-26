// data-src/*.json (웹 조사 후 검증을 거친 자료)의 타입과 로더.
// 조사 스키마의 필드명(snake_case)을 그대로 둔다. 파이프라인 단계는 이 타입만 보고 쓴다.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type Status = 'completed' | 'under_construction' | 'planned' | 'demolished' | 'cancelled';
export type Confidence = 'high' | 'medium' | 'low';

export interface CuratedEvent {
  year: number;
  month?: number;
  title_ko: string;
  description_ko: string;
  category: 'admin' | 'rail' | 'road' | 'housing' | 'landmark' | 'industry' | 'nature' | 'disaster' | 'future';
  lat?: number;
  lon?: number;
  coord_confidence?: 'exact' | 'approx' | 'none';
  status: Status;
  confidence: Confidence;
  sources: string[];
  note?: string;
}

export interface CuratedEra {
  from_year: number;
  to_year: number;
  summary_ko: string;
  builtup_areas_ko?: string;
  population?: number;
}

export interface CuratedTimeline {
  events: CuratedEvent[];
  era_summaries: CuratedEra[];
}

export interface CuratedStation {
  name_ko: string;
  lat: number;
  lon: number;
  opened_year: number;
  opened_month?: number;
  level: 'underground' | 'surface' | 'elevated';
  in_gwangmyeong: boolean;
  status: Status;
  sources?: string[];
}

export interface CuratedLine {
  id: string;
  name_ko: string;
  kind: 'subway' | 'high_speed' | 'commuter' | 'light_rail' | 'freight';
  operator?: string;
  line_color_hex: string;
  train_body_color_hex?: string;
  train_stripe_color_hex?: string;
  livery_ko?: string;
  cars_per_train?: number;
  car_length_m?: number;
  opened_year_in_gwangmyeong: number;
  opened_month?: number;
  status: Status;
  level_in_gwangmyeong: string;
  osm_match_hint?: string;
  headway_peak_min?: number;
  headway_offpeak_min?: number;
  stations: CuratedStation[];
  confidence: Confidence;
  sources: string[];
  note?: string;
}

export interface CuratedTransit {
  lines: CuratedLine[];
  bus: {
    categories: { name_ko: string; body_color_hex: string; description_ko: string }[];
    notable_routes: { number: string; category: string; path_desc_ko: string; headway_min?: number }[];
    sources: string[];
  };
  roads: { name_ko: string; kind: string; opened_year_in_gwangmyeong: number; level_desc?: string; status: Status; sources: string[] }[];
}

export interface CuratedZone {
  id: string;
  name_ko: string;
  kind: string;
  center_lat: number;
  center_lon: number;
  approx_radius_m?: number;
  polygon?: [number, number][]; // [lat, lon]
  area_m2?: number;
  before_kind: 'farmland' | 'forest' | 'lowrise_housing' | 'old_apartments' | 'industrial' | 'greenhouse' | 'vacant' | 'mixed';
  before_desc_ko?: string;
  after_desc_ko?: string;
  before_since_year?: number;
  demolition_year?: number;
  construction_start_year?: number;
  completion_year?: number;
  predecessor_complexes?: { name_ko: string; completion_year?: number; demolished_year?: number; floors?: number; building_count?: number; households?: number }[];
  successor_names?: string[];
  status: Status;
  confidence: Confidence;
  sources: string[];
  note?: string;
}

export interface CuratedZones {
  zones: CuratedZone[];
}

export interface CuratedLandmark {
  id: string;
  name_ko: string;
  name_en?: string;
  kind: string;
  lat: number;
  lon: number;
  coord_confidence?: 'exact' | 'approx' | 'none';
  opened_year?: number;
  closed_year?: number;
  height_m?: number;
  description_ko: string;
  status: Status;
  confidence: Confidence;
  sources: string[];
}

export interface CuratedLandmarks {
  landmarks: CuratedLandmark[];
}

export interface Overrides {
  buildingsToGround: { osmWayId: number; landcover: 'PARK' | 'GRASS' | 'PLAZA'; reason: string }[];
}

export interface Curated {
  overrides: Overrides;
  timeline: CuratedTimeline;
  transit: CuratedTransit;
  zones: CuratedZones;
  landmarks: CuratedLandmarks;
}

export function loadCurated(dir: string): Curated {
  const read = <T>(name: string): T => {
    const f = join(dir, `${name}.json`);
    if (!existsSync(f)) throw new Error(`${f} 없음 — data-src 조사 자료가 필요합니다`);
    return JSON.parse(readFileSync(f, 'utf8')) as T;
  };
  return {
    overrides: read<Overrides>('overrides'),
    timeline: read<CuratedTimeline>('timeline'),
    transit: read<CuratedTransit>('transit'),
    zones: read<CuratedZones>('zones'),
    landmarks: read<CuratedLandmarks>('landmarks'),
  };
}
