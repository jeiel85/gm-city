// 하루 시각 → 태양 방향·빛 세기·하늘/안개/조명 색. 순수 함수(단위 테스트 대상).

export interface SkyState {
  /** 태양 방향(지면에서 태양 쪽, 정규화). 밤에는 달 방향. */
  sunDir: [number, number, number];
  /** 태양 고도(라디안, 음수면 지평선 아래). */
  elevation: number;
  /** 낮 정도 0~1. */
  daylight: number;
  /** 밤 정도 0~1(창문·가로등). */
  night: number;
  skyTop: [number, number, number];
  horizon: [number, number, number];
  sunColor: [number, number, number];
  sunIntensity: number;
  hemiSky: [number, number, number];
  hemiGround: [number, number, number];
  hemiIntensity: number;
}

type RGB = [number, number, number];
const hex = (h: number): RGB => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// 키프레임: [시각, 하늘 위, 지평선, 태양색]
const KEYS: [number, RGB, RGB, RGB][] = [
  [0, hex(0x0b1630), hex(0x1d2d52), hex(0x8fa8ff)],
  [4.8, hex(0x1a2448), hex(0x3a3f6b), hex(0x9aa6ff)],
  [5.8, hex(0x5e6fa8), hex(0xf2a58a), hex(0xffb487)],
  [7, hex(0x7fb6ec), hex(0xffd9b0), hex(0xffe2c0)],
  [10, hex(0x6fb3f2), hex(0xcfe8ff), hex(0xfff6e8)],
  [15, hex(0x6fb3f2), hex(0xd6ecff), hex(0xfff4e2)],
  [17.8, hex(0x7aa6de), hex(0xffcf9a), hex(0xffc98a)],
  [18.9, hex(0x4d5a9c), hex(0xff9a6b), hex(0xff9a66)],
  [19.8, hex(0x1d2a58), hex(0x4a3f72), hex(0x9aa6ff)],
  [24, hex(0x0b1630), hex(0x1d2d52), hex(0x8fa8ff)],
];

export const SUNRISE = 6;
export const SUNSET = 19;

export function computeSky(timeOfDay: number): SkyState {
  const t = ((timeOfDay % 24) + 24) % 24;
  // 태양: 일출 6시 동쪽(+X) → 정오 남쪽(+Z) 높이 → 일몰 19시 서쪽(−X)
  const dayFrac = (t - SUNRISE) / (SUNSET - SUNRISE); // 0~1 이 낮
  const ang = dayFrac * Math.PI; // 0 = 동, π = 서
  const maxElev = (62 * Math.PI) / 180;
  const elevation = Math.sin(ang) * maxElev;
  let sunDir: [number, number, number];
  if (dayFrac > -0.05 && dayFrac < 1.05) {
    const az = ang; // 동→남→서
    const ce = Math.cos(Math.max(elevation, 0.05));
    sunDir = [Math.cos(az) * ce, Math.sin(Math.max(elevation, 0.05)), Math.sin(az) * ce * 0.8 + 0.2];
  } else {
    // 밤: 남쪽 하늘 높이 뜬 달(그림자 방향용)
    sunDir = [-0.3, 0.8, 0.5];
  }
  const len = Math.hypot(...sunDir);
  sunDir = [sunDir[0] / len, sunDir[1] / len, sunDir[2] / len];

  let a = KEYS[0];
  let b = KEYS[KEYS.length - 1];
  for (let i = 0; i + 1 < KEYS.length; i++)
    if (t >= KEYS[i][0] && t <= KEYS[i + 1][0]) {
      a = KEYS[i];
      b = KEYS[i + 1];
      break;
    }
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  const skyTop = mix(a[1], b[1], f);
  const horizon = mix(a[2], b[2], f);
  const sunColor = mix(a[3], b[3], f);
  const daylight = smooth(-0.08, 0.35, elevation);
  const night = 1 - smooth(-0.12, 0.12, elevation);
  return {
    sunDir,
    elevation,
    daylight,
    night,
    skyTop,
    horizon,
    sunColor,
    sunIntensity: 0.35 + 2.6 * daylight,
    hemiSky: mix(hex(0x6b7fc4), hex(0xdff0ff), daylight),
    hemiGround: mix(hex(0x2a2f45), hex(0xb9a98a), daylight),
    hemiIntensity: 0.55 + 0.75 * daylight,
  };
}

/** 표시 연도를 목표 연도로 부드럽게(최대 maxRate 년/초) 이동. */
export function approachYear(current: number, target: number, dt: number, maxRate = 12): number {
  const d = target - current;
  if (Math.abs(d) < 1e-3) return target;
  const step = Math.sign(d) * Math.min(Math.abs(d), Math.max(maxRate * dt, Math.abs(d) * Math.min(1, dt * 3)));
  return current + step;
}
