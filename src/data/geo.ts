// 경위도 ↔ 로컬 좌표(미터) 변환. 파이프라인과 클라이언트가 똑같이 쓴다.
// 로컬 좌표계: 원점 = 광명시 경계 bbox 중심, X = 동쪽(+), Z = 남쪽(+), Y = 위(+). 1 단위 = 1 m.
// 광명시 규모(약 7×11 km)에서는 등장방형 근사의 오차가 수 cm 수준이라 충분하다.

export const ORIGIN = { lat: 37.44835, lon: 126.863 } as const;

const PHI = (ORIGIN.lat * Math.PI) / 180;
/** 위도 1도당 미터 (WGS84 근사식). */
export const M_PER_DEG_LAT = 111132.92 - 559.82 * Math.cos(2 * PHI) + 1.175 * Math.cos(4 * PHI);
/** 경도 1도당 미터 (WGS84 근사식). */
export const M_PER_DEG_LON = 111412.84 * Math.cos(PHI) - 93.5 * Math.cos(3 * PHI) + 0.118 * Math.cos(5 * PHI);

/** 경위도 → 로컬 [x, z] (미터). */
export function project(lat: number, lon: number): [number, number] {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, -(lat - ORIGIN.lat) * M_PER_DEG_LAT];
}

/** 로컬 [x, z] (미터) → [lat, lon]. */
export function unproject(x: number, z: number): [number, number] {
  return [ORIGIN.lat - z / M_PER_DEG_LAT, ORIGIN.lon + x / M_PER_DEG_LON];
}
