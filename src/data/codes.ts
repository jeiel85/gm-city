// 파이프라인(tools/)과 클라이언트(src/)가 함께 쓰는 코드표.
// Node 의 타입 제거 실행과 호환되도록 enum 대신 const 객체만 쓴다.
// 값(숫자)은 바이너리 데이터 포맷의 일부이므로 기존 값을 바꾸지 말고 새 값을 뒤에 추가한다.

/** 셀 토지피복(land cover). world.gmc 의 lc0/lc1/lc2 배열 값. */
export const LC = {
  VOID: 0,
  GRASS: 1, // 공터·풀밭
  FOREST: 2, // 산림 (나무 인스턴스가 올라간다)
  PARK: 3, // 공원 잔디
  PADDY: 4, // 논
  FIELD: 5, // 밭
  GREENHOUSE: 6, // 비닐하우스 단지 바닥
  ORCHARD: 7, // 과수원
  WATER: 8, // 하천·저수지 수면
  RIVERBANK: 9, // 하천 둔치
  BARE: 10, // 나대지·흙
  RESIDENTIAL: 11, // 주거지 대지(단지 안 포장·조경)
  COMMERCIAL: 12, // 상업지 포장
  INDUSTRIAL: 13, // 공업지 콘크리트
  SCHOOLYARD: 14, // 학교 흙 운동장
  SPORTS: 15, // 경기장 잔디·트랙
  PARKING: 16, // 주차장
  ROAD_MOTORWAY: 17, // 고속도로
  ROAD_MAJOR: 18, // 간선(trunk/primary/secondary)
  ROAD_MINOR: 19, // 이면도로(tertiary/residential/unclassified/living_street/service)
  SIDEWALK: 20, // 보도
  PATH: 21, // 산책로·등산로
  CYCLEWAY: 22, // 자전거도로(붉은 포장)
  RAIL: 23, // 철도 자갈 도상
  PLAZA: 24, // 광장·보행자 전용
  CEMETERY: 25, // 묘지
  CONSTRUCTION: 26, // 공사장
  MILITARY: 27, // 군사시설
  VILLAGE: 28, // 옛 농촌 마을 마당(흙)
} as const;
export type LandCover = (typeof LC)[keyof typeof LC];
export const LC_COUNT = 32; // 팔레트 텍스처 폭. 코드 추가 시 32 미만 유지.

/** 토지피복별 표시 이름(정보 카드·범례)과 기본 색. 색은 렌더러 팔레트의 단일 출처다. */
export const LC_INFO: Record<number, { name: string; color: string }> = {
  [LC.VOID]: { name: '없음', color: '#000000' },
  [LC.GRASS]: { name: '풀밭', color: '#8cc85a' },
  [LC.FOREST]: { name: '숲', color: '#4f8f3a' },
  [LC.PARK]: { name: '공원', color: '#9bd466' },
  [LC.PADDY]: { name: '논', color: '#b5d86a' },
  [LC.FIELD]: { name: '밭', color: '#c9a66b' },
  [LC.GREENHOUSE]: { name: '비닐하우스', color: '#d9d2bf' },
  [LC.ORCHARD]: { name: '과수원', color: '#a3c65c' },
  [LC.WATER]: { name: '하천', color: '#4ab3e6' },
  [LC.RIVERBANK]: { name: '둔치', color: '#a9d97a' },
  [LC.BARE]: { name: '나대지', color: '#d6b98a' },
  [LC.RESIDENTIAL]: { name: '주거지', color: '#d8d3c7' },
  [LC.COMMERCIAL]: { name: '상업지', color: '#cfc6bb' },
  [LC.INDUSTRIAL]: { name: '공업지', color: '#b7b8b0' },
  [LC.SCHOOLYARD]: { name: '학교 운동장', color: '#dcb88a' },
  [LC.SPORTS]: { name: '운동장', color: '#6fbf5a' },
  [LC.PARKING]: { name: '주차장', color: '#8c9097' },
  [LC.ROAD_MOTORWAY]: { name: '고속도로', color: '#4d535c' },
  [LC.ROAD_MAJOR]: { name: '큰길', color: '#5a6069' },
  [LC.ROAD_MINOR]: { name: '골목길', color: '#6d737b' },
  [LC.SIDEWALK]: { name: '보도', color: '#cdb9a8' },
  [LC.PATH]: { name: '산책로', color: '#d9c49a' },
  [LC.CYCLEWAY]: { name: '자전거도로', color: '#c0645a' },
  [LC.RAIL]: { name: '철길', color: '#8b8078' },
  [LC.PLAZA]: { name: '광장', color: '#e2d6c4' },
  [LC.CEMETERY]: { name: '묘지', color: '#9fbf74' },
  [LC.CONSTRUCTION]: { name: '공사장', color: '#d8ae72' },
  [LC.MILITARY]: { name: '군사시설', color: '#8fa37a' },
  [LC.VILLAGE]: { name: '마을', color: '#cdb48c' },
};

/** 셀 마스크. 0: 렌더링 안 함, 1: 시 경계 밖 여백(흐리게), 2: 광명시. */
export const MASK = { VOID: 0, MARGIN: 1, CITY: 2 } as const;

/** 건물 종류. buildings.gmc 의 kind 배열 값. */
export const BK = {
  APARTMENT: 0, // 아파트
  VILLA: 1, // 다세대·연립(옥상 초록 방수페인트)
  HOUSE: 2, // 단독주택
  COMMERCIAL: 3, // 상가
  OFFICE: 4, // 업무
  INDUSTRIAL: 5, // 공장·창고(파란 지붕)
  SCHOOL: 6,
  PUBLIC: 7, // 관공서
  RELIGIOUS: 8, // 교회(밤에 붉은 십자가)·성당·절
  STATION: 9, // 역사
  HOSPITAL: 10,
  BIGBOX: 11, // 대형 매장(이케아·아울렛·코스트코)
  GREENHOUSE: 12, // 비닐하우스 동
  FARMHOUSE: 13, // 옛 농가(기와·슬레이트)
  PARKING: 14, // 주차 빌딩
  OTHER: 15,
} as const;
export type BuildingKind = (typeof BK)[keyof typeof BK];
export const BK_NAME: Record<number, string> = {
  [BK.APARTMENT]: '아파트',
  [BK.VILLA]: '다세대·연립주택',
  [BK.HOUSE]: '단독주택',
  [BK.COMMERCIAL]: '상가',
  [BK.OFFICE]: '업무시설',
  [BK.INDUSTRIAL]: '공장·창고',
  [BK.SCHOOL]: '학교',
  [BK.PUBLIC]: '공공시설',
  [BK.RELIGIOUS]: '종교시설',
  [BK.STATION]: '역',
  [BK.HOSPITAL]: '병원',
  [BK.BIGBOX]: '대형매장',
  [BK.GREENHOUSE]: '비닐하우스',
  [BK.FARMHOUSE]: '농가',
  [BK.PARKING]: '주차장 건물',
  [BK.OTHER]: '건물',
};

/** 건물 연도의 출처. 정보 카드에 "준공 1994 (OSM)" 처럼 표시하고, 추정치는 추정이라고 밝힌다. */
export const YEAR_SRC = {
  OSM: 0, // OSM start_date
  CURATED: 1, // data-src 조사 자료(단지명 매칭)
  ZONE: 2, // 개발지구 완공 연도
  INFERRED: 3, // 주변 건물·시대 요약으로 추정
  PROCEDURAL: 4, // OSM에 없는 곳을 채운 절차 생성 건물
} as const;
export const YEAR_SRC_NAME: Record<number, string> = {
  [YEAR_SRC.OSM]: 'OSM 준공일',
  [YEAR_SRC.CURATED]: '조사 자료',
  [YEAR_SRC.ZONE]: '개발지구 연도',
  [YEAR_SRC.INFERRED]: '주변 기준 추정',
  [YEAR_SRC.PROCEDURAL]: '절차 생성(추정)',
};

/** 건물 flags 비트. */
export const BF = {
  PROCEDURAL: 1, // OSM 건물이 아니라 절차 생성
  PREDECESSOR: 2, // 재개발·재건축으로 철거된 옛 건물(removed 연도 보유)
  LANDMARK: 4, // 랜드마크 전용 색·형태
  PLANNED: 8, // 미래 계획(반투명 표시)
  OUTSIDE: 16, // 광명시 경계 밖 여백의 건물(흰 모형처럼 흐리게 표시)
} as const;

/** flags 에 BF.LANDMARK 가 있을 때 palette 값의 의미(랜드마크 전용 배색). */
export const LANDMARK_PALETTE = {
  IKEA: 1, // 파란 상자 + 노란 띠
  COSTCO: 2,
  LOTTE_OUTLET: 3,
  KTX_STATION: 4, // 광명역 유리 지붕
  CITY_HALL: 5,
  SPEEDOME: 6, // 광명스피돔 돔 지붕
  KIA_PLANT: 7, // 기아 오토랜드 광명
} as const;

/** 지붕 형태. */
export const ROOF = { FLAT: 0, GABLE: 1, GREEN_TOP: 2, TANK_TOP: 3, SAWTOOTH: 4, DOME: 5 } as const;

/** 나무 종류. trees.gmc 의 kind 배열 값. */
export const TREE = { DECIDUOUS: 0, PINE: 1, CHERRY: 2, GINKGO: 3, BUSH: 4, FRUIT: 5 } as const;

/** 도로 등급. network.gmc 의 edgeClass 배열 값. */
export const RC = {
  MOTORWAY: 0,
  TRUNK: 1,
  PRIMARY: 2,
  SECONDARY: 3,
  TERTIARY: 4,
  RESIDENTIAL: 5,
  SERVICE: 6,
  LIVING: 7,
  FOOTWAY: 8,
  CYCLEWAY: 9,
  PATH: 10,
  STEPS: 11,
  PEDESTRIAN: 12,
  BUSWAY: 13,
} as const;
export type RoadClass = (typeof RC)[keyof typeof RC];
/** 차가 다닐 수 있는 등급. */
export const DRIVABLE: ReadonlySet<number> = new Set([RC.MOTORWAY, RC.TRUNK, RC.PRIMARY, RC.SECONDARY, RC.TERTIARY, RC.RESIDENTIAL, RC.SERVICE, RC.LIVING, RC.BUSWAY]);
/** 사람이 걸을 수 있는 등급(고속도로·간선 차도 제외, 보도 오프셋으로 걷는 등급 포함). */
export const WALKABLE: ReadonlySet<number> = new Set([RC.PRIMARY, RC.SECONDARY, RC.TERTIARY, RC.RESIDENTIAL, RC.SERVICE, RC.LIVING, RC.FOOTWAY, RC.CYCLEWAY, RC.PATH, RC.STEPS, RC.PEDESTRIAN]);

/** 도로·철도 높이 단계. */
export const LEVEL = { TUNNEL: -1, GROUND: 0, BRIDGE: 1 } as const;

/** 타임라인 범위. */
export const YEAR_MIN = 1960;
export const YEAR_MAX = 2035;
/** 데이터 기준 연도(OSM 스냅샷). 이보다 뒤의 변화는 계획으로 취급한다. */
export const YEAR_NOW = 2026;
