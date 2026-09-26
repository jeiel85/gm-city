// 높이 격자 → 복셀 지형 메시(청크 단위). 순수 함수라 워커와 단위 테스트에서 함께 쓴다.
//
// - 윗면: 같은 높이(정수 m)의 셀을 탐욕적으로 병합한다. 색은 셰이더가 셀 텍스처로 칠하므로 색은 병합을 막지 않는다.
// - 옆면: 이웃보다 높은 셀이 그 차이만큼 벽을 가진다. 가장자리 방향으로 같은 (아래, 위) 구간을 병합한다.
// - 마스크 밖(VOID)·격자 밖과 맞닿는 곳은 base 높이까지 내려가는 디오라마 단면.
// 정점 속성: position(월드 m), normal(Int8), aTop(그 면이 속한 기둥의 윗면 높이).

export interface HeightGrid {
  w: number;
  h: number;
  /** 셀 한 변(m). */
  cell: number;
  x0: number;
  z0: number;
  /** 기둥 윗면 높이(정수 m). */
  top: Int16Array;
  /** 0 이면 그리지 않는다. */
  mask: Uint8Array;
  /** 디오라마 바닥 높이(m). */
  base: number;
}

export interface MeshData {
  positions: Float32Array;
  normals: Int8Array;
  tops: Float32Array;
  indices: Uint32Array;
}

class Builder {
  pos: number[] = [];
  nrm: number[] = [];
  top: number[] = [];
  idx: number[] = [];
  quad(p: number[], n: [number, number, number], t: number) {
    const b = this.pos.length / 3;
    for (let i = 0; i < 12; i += 3) {
      this.pos.push(p[i], p[i + 1], p[i + 2]);
      this.nrm.push(n[0] * 127, n[1] * 127, n[2] * 127);
      this.top.push(t);
    }
    this.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  build(): MeshData {
    return {
      positions: new Float32Array(this.pos),
      normals: new Int8Array(this.nrm),
      tops: new Float32Array(this.top),
      indices: new Uint32Array(this.idx),
    };
  }
}

/** 2배 축소 격자(원거리 LOD). 높이는 2×2 중 마스크 안 최대, 마스크는 하나라도 있으면. */
export function downsample(g: HeightGrid): HeightGrid {
  const w = Math.ceil(g.w / 2);
  const h = Math.ceil(g.h / 2);
  const top = new Int16Array(w * h);
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      let m = 0;
      let t = -32768;
      for (let dj = 0; dj < 2; dj++)
        for (let di = 0; di < 2; di++) {
          const x = i * 2 + di;
          const y = j * 2 + dj;
          if (x >= g.w || y >= g.h) continue;
          const k = y * g.w + x;
          if (g.mask[k]) {
            m = Math.max(m, g.mask[k]);
            t = Math.max(t, g.top[k]);
          }
        }
      mask[j * w + i] = m;
      top[j * w + i] = m ? t : 0;
    }
  return { w, h, cell: g.cell * 2, x0: g.x0, z0: g.z0, top, mask, base: g.base };
}

/** 셀 (i0..i1, j0..j1] 범위의 청크 메시. */
export function meshChunk(g: HeightGrid, i0: number, j0: number, i1: number, j1: number): MeshData {
  const B = new Builder();
  const { w, h, cell, x0, z0, top, mask, base } = g;
  const X = (i: number) => x0 + i * cell;
  const Z = (j: number) => z0 + j * cell;
  const on = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] !== 0;
  const ht = (i: number, j: number) => top[j * w + i];

  // 윗면 병합
  const cw = i1 - i0;
  const chh = j1 - j0;
  const used = new Uint8Array(cw * chh);
  for (let j = j0; j < j1; j++)
    for (let i = i0; i < i1; i++) {
      const u = (j - j0) * cw + (i - i0);
      if (used[u] || !on(i, j)) continue;
      const t = ht(i, j);
      let ie = i + 1;
      while (ie < i1 && !used[(j - j0) * cw + (ie - i0)] && on(ie, j) && ht(ie, j) === t) ie++;
      let je = j + 1;
      grow: while (je < j1) {
        for (let x = i; x < ie; x++) if (used[(je - j0) * cw + (x - i0)] || !on(x, je) || ht(x, je) !== t) break grow;
        je++;
      }
      for (let y = j; y < je; y++) for (let x = i; x < ie; x++) used[(y - j0) * cw + (x - i0)] = 1;
      // 위에서 볼 때 반시계(법선 +Y): (x0,z0) → (x0,z1) → (x1,z1) → (x1,z0)
      B.quad([X(i), t, Z(j), X(i), t, Z(je), X(ie), t, Z(je), X(ie), t, Z(j)], [0, 1, 0], t);
    }

  // 옆면: 방향별로 가장자리를 따라 (아래, 위) 구간이 같은 연속 셀을 병합
  const lowOf = (ni: number, nj: number): number => (on(ni, nj) ? ht(ni, nj) : base);
  // 동(+X)·서(−X) 면: j 를 따라 달린다
  for (const dir of [1, -1]) {
    for (let i = i0; i < i1; i++) {
      let j = j0;
      while (j < j1) {
        if (!on(i, j)) {
          j++;
          continue;
        }
        const hi = ht(i, j);
        const lo = lowOf(i + dir, j);
        if (lo >= hi) {
          j++;
          continue;
        }
        let je = j + 1;
        while (je < j1 && on(i, je) && ht(i, je) === hi && lowOf(i + dir, je) === lo) je++;
        const x = dir > 0 ? X(i + 1) : X(i);
        if (dir > 0) B.quad([x, lo, Z(je), x, lo, Z(j), x, hi, Z(j), x, hi, Z(je)], [1, 0, 0], hi);
        else B.quad([x, lo, Z(j), x, lo, Z(je), x, hi, Z(je), x, hi, Z(j)], [-1, 0, 0], hi);
        j = je;
      }
    }
  }
  // 남(+Z)·북(−Z) 면: i 를 따라 달린다
  for (const dir of [1, -1]) {
    for (let j = j0; j < j1; j++) {
      let i = i0;
      while (i < i1) {
        if (!on(i, j)) {
          i++;
          continue;
        }
        const hi = ht(i, j);
        const lo = lowOf(i, j + dir);
        if (lo >= hi) {
          i++;
          continue;
        }
        let ie = i + 1;
        while (ie < i1 && on(ie, j) && ht(ie, j) === hi && lowOf(ie, j + dir) === lo) ie++;
        const z = dir > 0 ? Z(j + 1) : Z(j);
        if (dir > 0) B.quad([X(i), lo, z, X(ie), lo, z, X(ie), hi, z, X(i), hi, z], [0, 0, 1], hi);
        else B.quad([X(ie), lo, z, X(i), lo, z, X(i), hi, z, X(ie), hi, z], [0, 0, -1], hi);
        i = ie;
      }
    }
  }
  return B.build();
}
