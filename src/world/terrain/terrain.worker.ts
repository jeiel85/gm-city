// 지형 메싱 워커: 전체 격자를 받아 청크별 LOD0/LOD1 지형과 수면 메시를 만들어 돌려준다.

import { meshChunk, downsample, type HeightGrid, type MeshData } from './mesher.ts';

export interface TerrainJob {
  grid: HeightGrid;
  /** 수면 격자(마스크 = 물 셀, top = 수면 높이 정수 m). */
  water: HeightGrid;
  chunk: number;
}

export interface ChunkResult {
  type: 'chunk';
  ci: number;
  cj: number;
  bounds: [number, number, number, number]; // minX, minZ, maxX, maxZ
  lod0: MeshData;
  lod1: MeshData;
  water: MeshData | null;
  done: number;
  total: number;
}

function topOnly(m: MeshData): MeshData | null {
  const keep: number[] = [];
  for (let q = 0; q < m.indices.length; q += 6) if (m.normals[m.indices[q] * 3 + 1] > 0) keep.push(q);
  if (!keep.length) return null;
  const idx = new Uint32Array(keep.length * 6);
  keep.forEach((q, n) => idx.set(m.indices.subarray(q, q + 6), n * 6));
  return { ...m, indices: idx };
}

self.onmessage = (e: MessageEvent<TerrainJob>) => {
  try {
    const { grid, water, chunk } = e.data;
    const coarse = downsample(grid);
    const cx = Math.ceil(grid.w / chunk);
    const cz = Math.ceil(grid.h / chunk);
    const total = cx * cz;
    let done = 0;
    for (let cj = 0; cj < cz; cj++)
      for (let ci = 0; ci < cx; ci++) {
        const i0 = ci * chunk;
        const j0 = cj * chunk;
        const i1 = Math.min(grid.w, i0 + chunk);
        const j1 = Math.min(grid.h, j0 + chunk);
        const lod0 = meshChunk(grid, i0, j0, i1, j1);
        done++;
        if (!lod0.indices.length) continue;
        const lod1 = meshChunk(coarse, i0 / 2, j0 / 2, Math.ceil(i1 / 2), Math.ceil(j1 / 2));
        const wm = topOnly(meshChunk(water, i0, j0, i1, j1));
        const res: ChunkResult = {
          type: 'chunk',
          ci,
          cj,
          bounds: [grid.x0 + i0 * grid.cell, grid.z0 + j0 * grid.cell, grid.x0 + i1 * grid.cell, grid.z0 + j1 * grid.cell],
          lod0,
          lod1,
          water: wm,
          done,
          total,
        };
        const transfer: Transferable[] = [];
        for (const m of [lod0, lod1, wm]) if (m) transfer.push(m.positions.buffer, m.normals.buffer, m.tops.buffer, m.indices.buffer);
        (self as unknown as Worker).postMessage(res, transfer);
      }
    (self as unknown as Worker).postMessage({ type: 'done', total });
  } catch (err) {
    (self as unknown as Worker).postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
