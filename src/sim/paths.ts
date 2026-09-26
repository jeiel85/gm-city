// 폴리라인 경로 샘플링과 도로 그래프. 순수 로직(단위 테스트 대상).

/** 점 배열(x, y, z 평탄) 위의 경로. */
export class Polyline {
  readonly cum: Float32Array;
  readonly length: number;
  readonly pts: Float32Array | number[];
  readonly start: number;
  readonly count: number;
  constructor(pts: Float32Array | number[], start: number, count: number) {
    this.pts = pts;
    this.start = start;
    this.count = count;
    this.cum = new Float32Array(count);
    let acc = 0;
    for (let i = 1; i < count; i++) {
      const a = (start + i - 1) * 3;
      const b = (start + i) * 3;
      acc += Math.hypot(pts[b] - pts[a], pts[b + 2] - pts[a + 2]);
      this.cum[i] = acc;
    }
    this.length = acc;
  }

  /** 선분 번호 찾기(이진 탐색). */
  private seg(d: number): number {
    let lo = 0;
    let hi = this.count - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 거리 d 의 위치와 진행 방향. offset 은 진행 방향 오른쪽(+)으로 민 거리.
   * out = [x, y, z, heading(라디안; +X 기준, 위에서 볼 때 시계 방향 = atan2(dz, dx))]
   */
  sample(d: number, offset: number, out: Float64Array | number[], reverse = false): number {
    const L = this.length;
    let dd = Math.min(L, Math.max(0, d));
    if (reverse) dd = L - dd;
    const s = this.seg(dd);
    const a = (this.start + s) * 3;
    const b = (this.start + Math.min(this.count - 1, s + 1)) * 3;
    const segLen = this.cum[Math.min(this.count - 1, s + 1)] - this.cum[s];
    const t = segLen > 0 ? (dd - this.cum[s]) / segLen : 0;
    const p = this.pts;
    let dx = p[b] - p[a];
    let dz = p[b + 2] - p[a + 2];
    if (reverse) {
      dx = -dx;
      dz = -dz;
    }
    const l = Math.hypot(dx, dz) || 1;
    const nx = -dz / l;
    const nz = dx / l;
    out[0] = p[a] + (p[b] - p[a]) * t + nx * offset;
    out[1] = p[a + 1] + (p[b + 1] - p[a + 1]) * t;
    out[2] = p[a + 2] + (p[b + 2] - p[a + 2]) * t + nz * offset;
    out[3] = Math.atan2(dz, dx);
    return reverse ? this.count - 1 - (s + 1) : s;
  }
}

export interface GraphEdge {
  a: number;
  b: number;
  cls: number;
  lanes: number;
  oneway: boolean;
  level: number;
  width: number;
  built: number;
  line: Polyline;
}

/** 인접 리스트. 노드마다 (간선, 이 노드에서 출발하는 방향이 정방향인지). */
export class RoadGraph {
  readonly out: { edge: number; forward: boolean }[][];
  readonly edges: GraphEdge[];
  constructor(edges: GraphEdge[], nodeCount: number) {
    this.edges = edges;
    this.out = Array.from({ length: nodeCount }, () => []);
    edges.forEach((e, i) => {
      this.out[e.a].push({ edge: i, forward: true });
      if (!e.oneway) this.out[e.b].push({ edge: i, forward: false });
    });
  }

  /** 간선 진행 방향(도착 노드에서의 방향각). */
  heading(edge: number, forward: boolean, atEnd: boolean): number {
    const L = this.edges[edge].line;
    const o = [0, 0, 0, 0];
    L.sample(atEnd ? L.length - 0.5 : 0.5, 0, o, !forward);
    return o[3];
  }

  /**
   * 노드에서 다음 간선 고르기. allow 로 걸러낸 후보 중 직진(각도 차 작음)에 가중.
   * rnd 는 0~1 난수. 후보가 없으면 null(유턴은 막다른 길에서만 호출자가 처리).
   */
  next(node: number, fromEdge: number, fromHeading: number, allow: (e: number) => boolean, rnd: number): { edge: number; forward: boolean } | null {
    const cands = this.out[node].filter((c) => c.edge !== fromEdge && allow(c.edge));
    if (!cands.length) return null;
    const w = cands.map((c) => {
      const h = this.heading(c.edge, c.forward, false);
      let d = Math.abs(h - fromHeading) % (Math.PI * 2);
      if (d > Math.PI) d = Math.PI * 2 - d;
      return Math.exp(-d * 1.4) + 0.05;
    });
    const sum = w.reduce((s, v) => s + v, 0);
    let r = rnd * sum;
    for (let i = 0; i < cands.length; i++) {
      r -= w[i];
      if (r <= 0) return cands[i];
    }
    return cands[cands.length - 1];
  }
}

/** 2현시 신호: 방향각으로 그룹(동서/남북), 주기 30초. 녹색이면 true. */
export function signalGreen(heading: number, time: number, phaseOffset: number): boolean {
  const ew = Math.abs(Math.cos(heading)) >= Math.abs(Math.sin(heading));
  const t = (time + phaseOffset) % 30;
  return ew ? t < 13 : t >= 15 && t < 28;
}

/** 연대 계수: 1960 0.03 → 1980 0.3 → 2000 0.8 → 2026 1.0 (선형 보간). */
export function eraFactor(year: number): number {
  const K: [number, number][] = [
    [1960, 0.03],
    [1980, 0.3],
    [2000, 0.8],
    [2026, 1.0],
    [2035, 1.05],
  ];
  if (year <= K[0][0]) return K[0][1];
  for (let i = 1; i < K.length; i++)
    if (year <= K[i][0]) {
      const t = (year - K[i - 1][0]) / (K[i][0] - K[i - 1][0]);
      return K[i - 1][1] + (K[i][1] - K[i - 1][1]) * t;
    }
  return K[K.length - 1][1];
}

/** 하루 시각 계수: 출퇴근 1.2, 낮 0.9, 심야 0.25. */
export function hourFactor(h: number): number {
  const t = ((h % 24) + 24) % 24;
  if (t < 5) return 0.25;
  if (t < 7) return 0.25 + ((t - 5) / 2) * 0.85;
  if (t < 9.5) return 1.2;
  if (t < 17) return 0.9;
  if (t < 19.5) return 1.2;
  if (t < 23) return 1.2 - ((t - 19.5) / 3.5) * 0.8;
  return 0.35;
}

/** 결정적 이름·생각(가상 인물). */
const SUR = ['김', '이', '박', '최', '정', '강', '조', '윤', '장', '임', '한', '오', '서', '신', '권', '황', '안', '송', '류', '홍'];
const GIV = ['민', '서', '지', '현', '준', '윤', '하', '은', '도', '연', '수', '예', '우', '진', '아', '빈', '호', '린', '결', '솔', '율', '온', '재', '희'];
export function personName(id: number): string {
  const h = (n: number) => Math.abs(Math.imul(id + 1, 2654435761 + n * 97) >>> 0);
  return SUR[h(1) % SUR.length] + GIV[h(2) % GIV.length] + GIV[h(3) % GIV.length];
}

export function personThought(id: number, year: number, place: string): string {
  const now = [
    '철산역까지 걸어가는 중이에요.',
    '이케아에서 뭐 살지 고민 중!',
    '안양천 벚꽃길 걸으러 가야지.',
    '광명동굴 한번 가 보고 싶다.',
    '버스가 언제 오려나…',
    '오늘 날씨 참 좋다!',
    '광명시장에서 떡볶이 먹을까?',
    'KTX 타고 부산 가는 날!',
    '도덕산 출렁다리 건너 볼까?',
    '새 아파트 입주가 코앞이에요.',
    '구름산에 올라가면 광명이 다 보여요.',
    '퇴근길 지하철은 늘 붐벼요.',
    '아이 학원 데리러 가는 길이에요.',
    '스피돔에서 경륜 구경 가요.',
    '카페에서 잠깐 쉬어 갈까?',
    '공원 산책은 역시 저녁이 좋아.',
    '이 동네 많이 바뀌었네…',
    '장 보러 코스트코 가요.',
    '운동장 몇 바퀴 뛰고 와야지.',
    '오늘 저녁은 뭐 먹지?',
  ];
  const old = [
    '서울로 출근하려면 서둘러야 해.',
    '논에 물 대러 가는 길이에요.',
    '새로 생긴 아파트가 신기하네.',
    '시흥군 장날이라 바빠요.',
    '안양천에서 빨래하던 시절이 그립네.',
    '버스 타려면 한참 걸어야 해요.',
  ];
  const pool = year < 1990 ? old.concat(now.slice(4, 6)) : now;
  const t = pool[Math.abs(Math.imul(id + 7, 40503)) % pool.length];
  return place ? `${t} (${place})` : t;
}
