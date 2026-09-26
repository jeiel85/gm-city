// 건물 메싱 워커: 건물들을 공간 청크(약 320m)로 나눠 청크별 병합 메시를 만든다.

import { MeshBuilder, meshBuilding } from './mesher.ts';

export interface BuildingsJob {
  rects: Uint16Array;
  rectStart: Uint32Array;
  rectCount: Uint16Array;
  heightDm: Uint16Array;
  baseDm: Int16Array;
  kind: Uint8Array;
  roof: Uint8Array;
  cx: Float32Array;
  cz: Float32Array;
  sub: number;
  x0: number;
  z0: number;
  chunkSize: number;
}

export interface BuildingChunk {
  type: 'chunk';
  positions: Float32Array;
  normals: Int8Array;
  bid: Float32Array;
  part: Uint8Array;
  indices: Uint32Array;
  done: number;
  total: number;
}

self.onmessage = (e: MessageEvent<BuildingsJob>) => {
  try {
    const d = e.data;
    const n = d.kind.length;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < n; i++) {
      const key = `${Math.floor(d.cx[i] / d.chunkSize)},${Math.floor(d.cz[i] / d.chunkSize)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push(i);
    }
    let done = 0;
    for (const ids of groups.values()) {
      const B = new MeshBuilder();
      for (const i of ids) {
        meshBuilding(B, {
          rects: d.rects,
          rectStart: d.rectStart[i],
          rectCount: d.rectCount[i],
          sub: d.sub,
          x0: d.x0,
          z0: d.z0,
          base: d.baseDm[i] / 10,
          height: Math.max(2, d.heightDm[i] / 10),
          kind: d.kind[i],
          roof: d.roof[i],
          index: i,
        });
      }
      done += ids.length;
      const res: BuildingChunk = {
        type: 'chunk',
        positions: new Float32Array(B.pos),
        normals: new Int8Array(B.nrm),
        bid: new Float32Array(B.bid),
        part: new Uint8Array(B.part),
        indices: new Uint32Array(B.idx),
        done,
        total: n,
      };
      (self as unknown as Worker).postMessage(res, [res.positions.buffer, res.normals.buffer, res.bid.buffer, res.part.buffer, res.indices.buffer]);
    }
    (self as unknown as Worker).postMessage({ type: 'done' });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
