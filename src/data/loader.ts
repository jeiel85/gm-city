// public/data 의 데이터 파일을 내려받아 디코딩한다. 진행률을 콜백으로 알린다.

import { decodePack } from './pack.ts';
import {
  DATA_FILES,
  FORMAT_VERSION,
  type BuildingsArrays,
  type BuildingsMeta,
  type HistoryFile,
  type NetworkArrays,
  type NetworkMeta,
  type TreesArrays,
  type TreesMeta,
  type WorldArrays,
  type WorldMeta,
} from './format.ts';

export interface LoadedData {
  world: { meta: WorldMeta; a: WorldArrays };
  buildings: { meta: BuildingsMeta; a: BuildingsArrays };
  trees: { meta: TreesMeta; a: TreesArrays };
  network: { meta: NetworkMeta; a: NetworkArrays };
  history: HistoryFile;
}

export type LoadProgress = (loadedBytes: number, totalBytes: number, label: string) => void;

async function fetchBytes(url: string, onChunk: (n: number) => void): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} 를 불러오지 못했습니다 (HTTP ${res.status})`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    onChunk(value.byteLength);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function checkVersion(name: string, v: number) {
  if (v !== FORMAT_VERSION) throw new Error(`${name} 데이터 버전 ${v} 이 앱(${FORMAT_VERSION})과 다릅니다. 페이지를 새로고침하세요.`);
}

/** baseUrl 예: import.meta.env.BASE_URL + 'data/' */
export async function loadData(baseUrl: string, onProgress?: LoadProgress): Promise<LoadedData> {
  // 압축 크기를 모르므로 대략적인 예상치로 진행률을 계산하고, 실제 합계가 넘으면 늘린다.
  let expected = 12_000_000;
  let loaded = 0;
  const bump = (label: string) => (n: number) => {
    loaded += n;
    if (loaded > expected) expected = loaded * 1.1;
    onProgress?.(loaded, expected, label);
  };
  const [world, buildings, trees, network, history] = await Promise.all([
    fetchBytes(baseUrl + DATA_FILES.world, bump('지형')),
    fetchBytes(baseUrl + DATA_FILES.buildings, bump('건물')),
    fetchBytes(baseUrl + DATA_FILES.trees, bump('나무')),
    fetchBytes(baseUrl + DATA_FILES.network, bump('도로·노선')),
    fetchBytes(baseUrl + DATA_FILES.history, bump('역사')),
  ]);
  onProgress?.(loaded, loaded, '압축 해제');

  const w = decodePack<WorldMeta>(world);
  checkVersion('world', w.meta.version);
  const b = decodePack<BuildingsMeta>(buildings);
  checkVersion('buildings', b.meta.version);
  const t = decodePack<TreesMeta>(trees);
  checkVersion('trees', t.meta.version);
  const n = decodePack<NetworkMeta>(network);
  checkVersion('network', n.meta.version);
  const h = JSON.parse(new TextDecoder().decode(history)) as HistoryFile;
  checkVersion('history', h.version);

  return {
    world: { meta: w.meta, a: w.arrays as unknown as WorldArrays },
    buildings: { meta: b.meta, a: b.arrays as unknown as BuildingsArrays },
    trees: { meta: t.meta, a: t.arrays as unknown as TreesArrays },
    network: { meta: n.meta, a: n.arrays as unknown as NetworkArrays },
    history: h,
  };
}
