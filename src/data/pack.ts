// .gmc 컨테이너: JSON 메타데이터 + 이름 붙은 타입 배열 묶음을 zlib 으로 압축한 파일.
//
// 압축 해제 후 레이아웃 (리틀 엔디언):
//   [0..4)   매직 "GMC1"
//   [4..8)   u32 헤더 바이트 길이 N
//   [8..8+N) 헤더 JSON(UTF-8): { meta, arrays: [{ name, type, length, offset }] }
//   이후 8바이트 경계로 패딩한 뒤 blob 시작. 각 배열은 blob 안 offset(8바이트 정렬)에 있다.
// 해제된 버퍼에서 복사 없이 타입 배열 뷰를 만든다.

import { unzlibSync, zlibSync } from 'fflate';

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export type ArrayMap = Record<string, TypedArray>;

const CTORS = {
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
} as const;
type CtorName = keyof typeof CTORS;

interface ArrayEntry {
  name: string;
  type: CtorName;
  length: number;
  offset: number;
}

const MAGIC = 0x31434d47; // "GMC1" little-endian
const align8 = (n: number) => (n + 7) & ~7;

function typeName(a: TypedArray): CtorName {
  const n = a.constructor.name;
  if (!(n in CTORS)) throw new Error(`지원하지 않는 배열 타입: ${n}`);
  return n as CtorName;
}

/** 메타데이터와 배열들을 .gmc 바이트로 인코딩한다(zlib 압축 포함). */
export function encodePack(meta: unknown, arrays: ArrayMap, level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 = 9): Uint8Array {
  const entries: ArrayEntry[] = [];
  let blobLen = 0;
  for (const [name, arr] of Object.entries(arrays)) {
    entries.push({ name, type: typeName(arr), length: arr.length, offset: blobLen });
    blobLen = align8(blobLen + arr.byteLength);
  }
  const header = new TextEncoder().encode(JSON.stringify({ meta, arrays: entries }));
  const blobStart = align8(8 + header.byteLength);
  const out = new Uint8Array(blobStart + blobLen);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true);
  dv.setUint32(4, header.byteLength, true);
  out.set(header, 8);
  for (const e of entries) {
    const a = arrays[e.name];
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.byteLength), blobStart + e.offset);
  }
  return zlibSync(out, { level });
}

/** .gmc 바이트를 디코딩한다. 형식이 맞지 않으면 예외를 던진다. */
export function decodePack<M = unknown>(compressed: Uint8Array): { meta: M; arrays: ArrayMap } {
  const raw = unzlibSync(compressed);
  if (raw.byteLength < 8) throw new Error('.gmc 파일이 너무 짧습니다');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('.gmc 매직 값이 다릅니다');
  const headerLen = dv.getUint32(4, true);
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + headerLen))) as {
    meta: M;
    arrays: ArrayEntry[];
  };
  // raw 의 byteOffset 이 8의 배수가 아닐 수 있으므로, 정렬이 필요하면 한 번 복사한다.
  const buf = raw.byteOffset % 8 === 0 ? raw : raw.slice();
  const blobStart = buf.byteOffset + align8(8 + headerLen);
  const arrays: ArrayMap = {};
  for (const e of header.arrays) {
    const Ctor = CTORS[e.type];
    if (!Ctor) throw new Error(`알 수 없는 배열 타입 ${e.type}`);
    const byteLen = e.length * Ctor.BYTES_PER_ELEMENT;
    if (blobStart - buf.byteOffset + e.offset + byteLen > buf.byteLength) throw new Error(`배열 ${e.name} 범위 초과`);
    arrays[e.name] = new Ctor(buf.buffer, blobStart + e.offset, e.length);
  }
  return { meta: header.meta, arrays };
}
