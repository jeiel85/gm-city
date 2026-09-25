# GM City 설계 문서

경기도 광명시를 실제 지형·도로·건물 데이터로 옮긴 **복셀 아트 3D 디오라마**. RCT(롤러코스터 타이쿤)의 아기자기함 + 길건너 친구들(Crossy Road)의 큐브 감성. 타임라인(1960–2035)으로 도시의 변화를 보고, 사람·자동차·버스·열차가 움직이는 모습을 확대해서 볼 수 있다.

- 정적 웹앱: Vite + TypeScript + Three.js. GitHub Pages 배포(`base: /gm-city/`).
- 데이터: 빌드 시 오프라인 파이프라인(`tools/`)이 OSM·고도·조사 자료를 `public/data/`의 압축 바이너리로 만든다. 앱은 그것만 읽는다(런타임 외부 API 호출 없음, 폰트 CDN 제외).

## 1. 저장소 구조와 담당

| 경로 | 내용 | 담당 |
|---|---|---|
| `src/data/` | 코드표(`codes.ts`), 좌표계(`geo.ts`), 컨테이너(`pack.ts`), 파일 포맷 계약(`format.ts`), 로더(`loader.ts`) | 기반(수정 시 전 모듈 합의) |
| `src/core/` | 전역 상태(`state.ts`), 공유 uniform(`uniforms.ts`), 모듈 인터페이스(`types.ts`) | 기반 |
| `src/main.ts` | 앱 조립 | 기반 |
| `tools/lib/` | 기하·OSM·래스터·고도 유틸 | 기반 |
| `tools/build-world.ts`, `tools/pipeline/{context,curated,write}.ts` | 파이프라인 실행기·컨텍스트·출력 | 기반 |
| `tools/pipeline/{terrain,landcover,cell-history}.ts` | 지형·토지피복·셀 이력 | P1 |
| `tools/pipeline/buildings.ts` (+ `tools/pipeline/buildings/*`) | 건물·절차 생성·철거된 옛 건물 | P2 |
| `tools/pipeline/{network,trees,history-json}.ts` (+ 하위 폴더) | 도로 그래프·철도·버스·나무·역사 JSON | P3 |
| `src/engine/` | 렌더러·카메라·조작·하늘·낮밤·후처리·피킹·루프 | C2 |
| `src/world/` 지형 계열 | 지형 메싱(워커)·수면·도로 표시·교량·철길·지하 투시 | C1a |
| `src/world/` 건물 계열 | 건물 메싱(워커)·크레인·나무 | C1b |
| `src/sim/` | 사람·차·버스·열차 시뮬레이션과 복셀 모델 | C3 |
| `src/ui/`, `index.html` | 화면 UI 전부, 라벨, URL 상태 | C4 |
| `tests/` | `node --test` 단위 테스트(`<모듈>.*.test.ts`) | 각자 |

모듈끼리는 `src/core/types.ts`의 인터페이스로만 소통한다. 다른 담당의 파일을 고치지 말고, 필요한 계약 변경은 보고한다.

## 2. 좌표·단위·연도

- 로컬 좌표(m): 원점 광명시 bbox 중심(37.44835, 126.863). **X = 동, Z = 남, Y = 위.** 북쪽은 −Z. (`src/data/geo.ts`)
- 셀 격자: `cellSize = 5m`. 셀 (i, j), 인덱스 `j*width+i`. 건물 세부 격자 `subSize = 2.5m`.
- 연도는 서기 정수, 0 = 해당 없음. 타임라인 1960–2035, 데이터 기준 연도 `YEAR_NOW = 2026`(그 이후는 계획).
- 셀 토지피복은 3단계 이력 `lc0 →(y1)→ lc1 →(y2)→ lc2` (`landCoverAt()`).
- 건물은 `constructStart ≤ year < built` 이면 공사 중, `built ≤ year < removed(또는 0)` 이면 완공 상태.

## 3. 데이터 파일 (`src/data/format.ts`가 단일 출처)

`world.gmc`(셀 격자), `buildings.gmc`, `trees.gmc`, `network.gmc`(도로 그래프·철도·버스 경로), `history.json`(연표·시대·랜드마크·개발지구·인구·고지). `.gmc` = `pack.ts` 컨테이너(zlib). 총 용량 목표 25MB 이하.

## 4. 파이프라인 (`npm run data:build`)

순서: `terrain → landcover → buildings → cellHistory → network → trees → historyJson → write`. 각 단계는 `PipelineContext`(`tools/pipeline/context.ts`)의 필드를 채운다. 모든 무작위성은 `ctx.rng`나 `hash2(x, z, salt)`로 결정적이어야 한다(같은 입력 → 같은 출력). 각 단계는 `ctx.stats`에 주요 수치를 남긴다.

입력: `data-raw/osm/*.json`(Overpass, `tools/fetch-osm.mjs`), `data-raw/elevation`(Terrarium, `tools/fetch-elevation.mjs`), `data-src/*.json`(웹 조사 후 검증한 연표·교통·개발지구·랜드마크, 타입은 `tools/pipeline/curated.ts`).

### P1 terrain
- mask: 셀 중심이 광명시 링 안 → `CITY`, 경계에서 `marginMeters` 이내 → `MARGIN`, 나머지 `VOID`.
- height: 셀 중심 고도 샘플 → SRTM 잡음 완화(도시부 3×3 중앙값 등). 단위 m.
- district: `osm.districts`(admin_level 8 행정동, 광명시 안의 것)로 셀별 인덱스와 `grid.districts`(이름·중심).

### P1 landcover
- 기본 GRASS 위에 면적 큰 폴리곤부터 작은 순으로 landuse/natural/leisure/amenity 를 칠한다(태그→LC 매핑은 코드에 표로).
- 수계: natural=water 면, waterway 선(river ≈ 실폭, stream 4–8m), 안양천·목감천 옆 둔치(RIVERBANK). 수면 셀 높이는 주변 최저로 평탄화해 계단 없는 수면을 만든다.
- 도로: `tools/lib/roads.ts`(기반)의 등급·폭 함수로 칠한다. 터널·교량 구간은 지면에 칠하지 않는다(교량 상판은 클라이언트가 따로 그린다). 도시부 간선·이면도로 양옆 약 3m 보도(SIDEWALK). `grid.road`에 등급+1.
- 철도: 지상 구간 RAIL 띠(선로당 약 4–6m).
- 도로 셀 높이는 도로를 따라 부드럽게(±20m 평균) 다듬어 차량이 계단을 오르내리지 않게 한다.

### P2 buildings
- OSM 건물(way + multipolygon relation) → 종류(BK)·층수·높이·이름·연도·팔레트·지붕. 광명시 밖(MARGIN) 건물은 `BF.OUTSIDE`로 남긴다(흰 모형처럼 표시).
- 연도 우선순위: OSM `start_date` → 조사 자료 단지명 매칭 → 개발지구 완공 연도 → 주변 연대 추정(`YEAR_SRC`). 추정은 정보 카드에 "추정"으로 표시된다 — 출처를 정확히 기록할 것.
- 발자국을 세부 격자에 래스터화 후 `greedyRects`로 사각형 분해. 최소 1칸. `baseM` = 발자국 아래 지면 최저.
- 옛 건물(`BF.PREDECESSOR`): 개발지구 자료로 철거된 저층 주택가·5층 주공아파트·농가 마을을 절차 생성하고 `removed` 연도를 준다.
- 절차 생성(`BF.PROCEDURAL`): OSM 건물이 비어 있는 주거·상업·공업 셀과 비닐하우스 단지를 필지 단위로 채운다. 도로·수면·기존 건물과 겹치지 않게.
- 랜드마크 배색: `BF.LANDMARK` + `LANDMARK_PALETTE`(이케아·코스트코·롯데아울렛·KTX 광명역·시청·스피돔·기아 공장).

### P1 cellHistory
- `urbanYear`: 셀 위 건물의 최소 착공 연도, 개발지구 연도, 도시 폴리곤 안 건물들의 연도 등으로 추정.
- `lc0`: 도시화 이전 모습(저지대·하천 근처는 논, 나머지 밭, 옛 마을은 VILLAGE, 산은 그대로 숲). `y1 = urbanYear` 에 `lc1`(현재 또는 중간 단계)로 바뀐다. 재개발 지구는 저층 주택가 단계를 거친다. 미래 개발지구는 `y2 = 착공 연도`에 CONSTRUCTION.
- 불변식: `y1=0 → lc1=lc0`, `y2=0 → lc2=lc1`, `y1<y2`, 연도 범위 [1960, 2035]. 위반하면 예외.

### P3 network
- 도로 그래프: OSM way 를 공유 노드(교차로)에서 쪼갠 간선. 등급(RC)·차로·일방·높이 단계·폭·개통 연도·이름. 점마다 y(지상 = 격자 높이, 교량 = 양 끝 보간, 터널 = 지면 −10m).
- 철도: 조사 자료의 노선(7호선·KTX·1호선 광명셔틀·신안산선·월곶판교선 등)을 OSM route relation/선로 way 로 경로 조립(방향별 path), 점별 LEVEL, 역은 경로 위 거리로 투영. 노선색·차체색·량수·배차·개통 연도·상태.
- 버스: OSM `route=bus` relation → 경로(격자 안 가장 긴 연속 구간), 정류장 거리, 색(노선 colour 태그 → 조사 자료 분류 색), 배차.

### P3 trees
- 숲 셀(약 9m 간격 밀도), 공원, 간선 가로수(은행나무·벚나무, 하천변은 벚나무), 아파트 단지 조경, 과수원. 도로·건물 회피. 총 15만 그루 이하.
- `planted` = 셀 도시화 연도, `removed` = 숲이 개발된 연도.

### P3 historyJson
- 연표·시대 요약·랜드마크(로컬 좌표, 라벨 높이, 줌 우선순위)·개발지구 링·인구·데이터 한계 고지(`notes`, 한국어).

## 5. 클라이언트

### 모듈 진입점 (main.ts 가 부르는 계약)

```ts
// src/engine/engine.ts
export function createEngine(container: HTMLElement, store: Store<AppState>, uniforms: GlobalUniforms): Engine;
interface Engine extends EngineApi {
  renderer: WebGLRenderer; scene: Scene; readonly camera: Camera; quality: QualityProfile;
  addSystem(s: System): void;
  setBounds(b: { minX: number; minZ: number; maxX: number; maxZ: number }): void; // 카메라 이동 범위
  start(): void;
}
// src/world/world.ts
export function createWorld(app: AppContext, onProgress?: (p: number, label: string) => void): Promise<World>;
interface World extends System { ground: GroundQuery; bounds: { minX; minZ; maxX; maxZ } }
// src/sim/simulation.ts
export function createSimulation(app: AppContext): System;
// src/ui/ui.ts
export function createUI(root: HTMLElement, store: Store<AppState>): {
  setLoading(p: number, label: string): void; showError(msg: string): void;
  attach(app: AppContext, engine: EngineApi): System; // 라벨·타임라인 등 연결, 매 프레임 update
};
// src/ui/url-state.ts
export function readUrlState(search: string): { state: Partial<AppState>; camera?: Partial<CameraState> };
```

### 공유 규칙
- **조명·그림자·안개 일관성**: 커스텀 표현은 `MeshLambertMaterial`/`MeshStandardMaterial`의 `onBeforeCompile`로 확장해 three 기본 조명·그림자·안개를 유지한다. 전역 uniform(`uYear`, `uNight`, `uXray` …)은 `app.uniforms`의 객체를 그대로 연결한다.
- **타임라인**: 표시 연도는 `FrameInfo.year`(엔진이 `store.year`를 향해 부드럽게 따라가는 값, 셰이더 `uYear`와 같음). 연도 변화는 셰이더/인스턴스 속성으로 처리하고 메시를 다시 만들지 않는다.
- **지하 투시(xray)**: 지형을 투명하게 만들지 않는다. 지하 대상(터널 선로, 지하철 차량)을 `depthFunc: GreaterDepth` + 반투명 발광 재질의 "유령 패스"로 한 번 더 그려, 땅에 가려진 부분만 비쳐 보이게 한다. 켜짐 정도는 `uXray`.
- **에이전트 시간**: 사람·차량·열차 이동은 실제 시간(`frame.dt` × 약 1.5) 기준. 하루 시계(`timeScale`)는 조명·밀도에만 쓴다. 배차 간격은 1/5로 압축해 적용.
- **피킹**: 엔진이 클릭 광선을 각 System 의 `pick()`에 묻고 가장 가까운 결과를 `store.selected`에 넣는다. 정보 카드 내용(InfoCard)은 대상 모듈이 만든다. 추정 연도·절차 생성 여부는 반드시 note 에 밝힌다.
- **정직성**: 데이터가 없는 곳을 채운 것(절차 생성·추정 연도·미래 계획)은 화면과 README 에서 그렇다고 밝힌다. OSM(ODbL)·고도 자료 출처 표기는 항상 접근 가능해야 한다.

### C2 engine
렌더러(sRGB, 톤매핑, PCF 소프트 그림자, DPR 상한), 원근 카메라(FOV 약 30°, 거리 기반 near/far), 등각(RCT) 직교 카메라 모드와 90° 회전, MapControls(관성, 커서 기준 줌, 범위 제한, 키보드 WASD/방향키·Q/E·+/−·R·F·Esc), 따라가기 모드, 하늘 그라데이션·태양광(주시점 따라가는 그림자 박스)·반구광·안개, 낮밤 색 키프레임과 uniform 갱신, 시계(하루 시각·연도 재생, `uYear` 부드러운 추종), 틸트시프트 후처리(켤 때만 컴포저), 클릭 피킹, 품질 프로필(모바일 자동 하향), 렌더 루프.

### C1a world — 지형 계열
- 셀 데이터 텍스처(lc0/lc1/lc2/mask, y1/y2)와 팔레트 텍스처를 만들어 **색은 프래그먼트 셰이더에서 셀 조회**로 정한다. 그래서 윗면은 **높이만 같으면 색이 달라도 병합**(탐욕적 메싱)할 수 있다.
- 워커에서 64×64 셀 청크 메싱: 윗면 병합, 높이차 옆면(구간 병합), 마스크 외곽의 디오라마 단면(흙·돌 띠). 원거리용 2배 축소 LOD. 높이 양자화 1m.
- 옆면 윗부분 약 0.8m 는 토지피복 색, 그 아래는 흙 띠(마인크래프트 잔디 블록 느낌). MARGIN 셀은 옅은 종이색으로 탈색.
- 셀 단위 미세 명암(해시), 정점 AO.
- 수면: 합쳐진 수면 사각형 + 잔물결·반짝임·물가 거품 셰이더.
- 도로 표시: 중앙선(노란 겹선), 차선(흰 점선), 교차로 횡단보도 — 연도 가시성 포함.
- 교량 상판·교각(도로·철도), 지상 철길(침목·레일), 지하 구간 유령 패스(터널 튜브).
- `GroundQuery` 구현(렌더링된 윗면 높이와 일치).

### C1b world — 건물 계열
- 워커에서 건물별 복셀 메시: 사각형들을 로컬 마스크로 합쳐 윗면 병합 + 외곽 벽 구간 병합 + 지붕 형태(박공 계단, 옥상 초록 방수+계단실, 물탱크, 톱날, 비닐하우스 반원 계단). 청크별 병합(프러스텀 컬링).
- 건물 속성은 데이터 텍스처(`built/removed/constructStart/높이/종류/팔레트/flags`)로 셰이더가 조회: 착공 전 숨김 → 공사 중 층 단위로 솟아오름(회색 골조·초록 안전망 무늬) → 완공 → 철거 시 사라짐.
- 벽 창문(층 3m 간격, 발코니 띠), 밤에는 해시로 일부 창에 불, 교회 붉은 십자가 발광. 종류·시대별 배색(80년대 베이지 주공, 2000년대 이후 흰색+브랜드 포인트, 다세대 벽돌+초록 옥상, 공장 파란 지붕), 랜드마크 배색, OUTSIDE 는 흰 모형.
- 공사 중 대형 건물 옆 타워크레인(지브 회전).
- 나무: 종류별 복셀 모델 InstancedMesh(청크별), 심은/제거 연도, 거리 기반 솎아내기 LOD, 그림자.
- 건물 피킹 → InfoCard(이름·종류·층수·준공 연도와 출처·철거 연도·행정동).

### C3 sim
- 복셀 모델 빌더(상자 목록 → 병합 지오메트리, 인스턴스 색 슬롯): 사람(걸음 흔들림), 승용차·SUV·택시·트럭, 시내버스, KTX(앞/중간 차), 전동차. 에이전트 과장 배율 사람 ×1.6, 차량 ×1.2.
- 도로 그래프 탐색, 차량(우측 통행 차로 오프셋, 앞차 간격 유지, 교차로 2현시 신호, 밤 전조등·미등), 버스(노선 경로·정류장 정차·노선색), 열차(노선 경로·역 정차·가감속·량 연결, 지하 구간은 유령 패스로만), 보행자(보도 오프셋, 역·상업지·공원 가중 스폰, 밤에 감소).
- 연도·시각에 따른 밀도(1960년대 드묾 → 현재), 개통 전 노선 없음.
- 피킹·따라가기: 버스 "504번 · 다음 정류장", 열차 "7호선 · 온수행", 사람은 가상의 이름과 RCT 식 생각 한 줄.

### C4 ui
- 한국어 UI. RCT 느낌의 두툼한 둥근 패널(크림색 바탕·갈색 글자·청록/주황 포인트), 제목 폰트 Jua, 본문 Noto Sans KR(Google Fonts).
- 로딩 화면, 제목 카드, 큰 연도 표시, 하단 타임라인(눈금·사건 표시·재생/속도·"지금" 버튼·2027년 이후 "계획" 빗금), 사건 토스트, 시대 요약, 레이어·시각·품질·카메라 모드 패널, 정보 카드(+따라가기), 랜드마크 라벨(CSS2D, 연도·줌 우선순위), 조작법 도움말, 정보·출처 모달(OSM 표기, 데이터 한계 고지), URL 상태 공유, 모바일 레이아웃(좌우 16px 여백, 가로 스크롤 없음).

## 6. 아트 방향

- 큐브가 주인공: 모든 것은 축 정렬 상자. 곡면·텍스처 이미지 없음, 색은 평면 + 셀 단위 미세 명암 + AO.
- 팔레트는 따뜻하고 채도 중간(파스텔 쪽). 토지피복 색의 단일 출처는 `LC_INFO`.
- 한국 도시의 상징적 디테일: 노란 중앙선, 붉은 자전거도로, 흙 운동장, 다세대 옥상의 초록 방수 페인트, 공장의 파란 지붕, 밤의 붉은 교회 십자가, 은행나무 가로수, 안양천 벚꽃, 비닐하우스 단지.

## 7. 성능 목표

- 데스크톱 내장 GPU에서 medium 품질 60fps, 초기 로딩(광대역) 10초 이내.
- 드로우콜은 청크 병합·인스턴싱으로 수백 개 이하. 연도 이동은 uniform 만 바꾼다.
- 모바일은 DPR·그림자·에이전트·나무 밀도를 품질 프로필로 낮춘다.

## 8. 검증

- `npm run typecheck`, `npm test`(단위 테스트), `npm run data:build`(파이프라인), `npm run build`.
- 파이프라인은 불변식 위반·빈 결과를 예외로 드러낸다(삼키지 않는다).
- 브라우저에서 콘솔 오류 없이 로딩되고 연도·시각·레이어 조작이 반영되는지 확인한다.
