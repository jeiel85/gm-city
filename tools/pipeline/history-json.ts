// P3 historyJson: 연표·시대 요약·랜드마크·개발지구·인구·데이터 한계 고지 → history.json

import { project } from '../../src/data/geo.ts';
import { FORMAT_VERSION, type HistoryFile, type Landmark } from '../../src/data/format.ts';
import type { PipelineContext } from './context.ts';

const PRIORITY: Record<string, 0 | 1 | 2> = {
  mountain: 0, station: 0, stream: 0, tourism: 0, mall: 0, factory: 0, sports: 1, public: 1, culture: 1, park: 1,
  bridge: 2, heritage: 1, hospital: 2, school: 2, religious: 2, road: 2, nature: 1, other: 2,
};

export function buildHistoryJson(ctx: PipelineContext): void {
  const g = ctx.grid;
  const { w, h } = g.spec;
  const cur = ctx.curated;
  const groundAt = (x: number, z: number, r = 0) => {
    const i0 = Math.floor((x - g.spec.x0) / g.spec.cell);
    const j0 = Math.floor((z - g.spec.z0) / g.spec.cell);
    const rc = Math.ceil(r / g.spec.cell);
    let best = -Infinity;
    for (let j = j0 - rc; j <= j0 + rc; j++)
      for (let i = i0 - rc; i <= i0 + rc; i++) if (i >= 0 && j >= 0 && i < w && j < h) best = Math.max(best, g.height[j * w + i]);
    return Number.isFinite(best) ? best : 0;
  };
  const clampYear = (y: number | undefined) => (y ? Math.max(0, y) : 0);

  const events = cur.timeline.events
    .map((e) => {
      const hasXY = e.lat !== undefined && e.lon !== undefined && e.coord_confidence !== 'none';
      const [x, z] = hasXY ? project(e.lat!, e.lon!) : [undefined, undefined];
      return {
        year: e.year,
        ...(e.month ? { month: e.month } : {}),
        title: e.title_ko,
        description: e.description_ko,
        category: e.category,
        status: e.status,
        ...(x !== undefined ? { x: Math.round(x), z: Math.round(z!) } : {}),
        confidence: e.confidence,
        sources: e.sources,
      };
    })
    .sort((a, b) => a.year - b.year || (a.month ?? 0) - (b.month ?? 0));

  const eras = cur.timeline.era_summaries.map((e) => ({ from: e.from_year, to: e.to_year, summary: e.summary_ko, ...(e.population ? { population: e.population } : {}) }));

  const landmarks: Landmark[] = cur.landmarks.landmarks.map((l) => {
    const [x, z] = project(l.lat, l.lon);
    const y = l.kind === 'mountain' ? Math.max(groundAt(x, z, 150), l.height_m ?? 0) : groundAt(x, z);
    return {
      id: l.id,
      name: l.name_ko,
      kind: l.kind,
      x: Math.round(x),
      z: Math.round(z),
      y: Math.round(y * 10) / 10,
      opened: clampYear(l.opened_year),
      closed: clampYear(l.closed_year),
      description: l.description_ko,
      priority: PRIORITY[l.kind] ?? 2,
      sources: l.sources,
    };
  });

  const zones = cur.zones.zones
    .filter((z) => z.id !== 'nt-all')
    .map((z) => {
      let ring: [number, number][];
      if (z.polygon && z.polygon.length >= 3) ring = z.polygon.map(([la, lo]) => project(la, lo).map(Math.round) as [number, number]);
      else {
        const [cx, cz] = project(z.center_lat, z.center_lon);
        const r = z.approx_radius_m ?? 200;
        ring = Array.from({ length: 24 }, (_, a) => [Math.round(cx + Math.cos((a / 24) * Math.PI * 2) * r), Math.round(cz + Math.sin((a / 24) * Math.PI * 2) * r)] as [number, number]);
      }
      return {
        id: z.id,
        name: z.name_ko,
        kind: z.kind,
        ring,
        beforeKind: z.before_kind,
        since: z.before_since_year ?? 0,
        demolition: z.demolition_year ?? 0,
        constructionStart: z.construction_start_year ?? 0,
        completion: z.completion_year ?? 0,
        status: z.status,
        summary: [z.before_desc_ko, z.after_desc_ko].filter(Boolean).join(' → '),
        sources: z.sources,
      };
    });

  const population = eras
    .filter((e) => e.population)
    .map((e) => [Math.round((e.from + Math.min(e.to, ctx.cfg.yearNow)) / 2), e.population!] as [number, number]);

  const notes = [
    '지형·도로·건물·철도·버스 노선은 OpenStreetMap(2026년 9월 기준)과 AWS Terrain Tiles 고도 자료를 5m 격자로 옮긴 것입니다.',
    '건물 준공 연도는 OSM에 기록된 값을 우선 쓰고, 없으면 조사 자료(단지명)·개발지구 연도·주변 건물로 추정했습니다. 건물을 누르면 연도의 출처가 나옵니다.',
    'OSM에 건물이 비어 있는 저층 주거지·상가·공장·비닐하우스는 절차적으로 채운 것이라 실제 배치와 다릅니다.',
    '재개발·재건축으로 사라진 옛 건물(광명뉴타운 저층 주택가, 철산주공 5층 아파트, 택지 개발 전 농가)은 개발지구 조사 자료를 바탕으로 한 근사 복원입니다.',
    'OSM에 토지피복이 없는 시 남부의 숲·논밭·비닐하우스는 고도와 경사로 추정했고, 1960~70년대 경관은 시대 요약을 바탕으로 한 근사 복원입니다.',
    '2027년 이후는 공개된 계획(3기 신도시, 신안산선·월곶판교선 등)에 따른 공사 표시이며 실제 설계가 아닙니다. 개통·입주 시기는 바뀔 수 있습니다.',
    '사람·자동차·버스·열차의 움직임은 실제 운행 정보가 아닌 시뮬레이션입니다. 버스·열차는 실제 노선 경로를 따라 달립니다.',
  ];

  const hist: HistoryFile = { version: FORMAT_VERSION, events, eras, landmarks, zones, population, notes };
  ctx.history = hist;
  ctx.stats.events = events.length;
  ctx.stats.landmarks = landmarks.length;
  ctx.log(`사건 ${events.length}, 시대 ${eras.length}, 랜드마크 ${landmarks.length}, 지구 ${zones.length}`);
}
