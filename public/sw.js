/* GM City 서비스워커 (scope: 이 파일이 있는 /gm-city/ 디렉터리)
 * - 내비게이션: network-first, 실패 시 캐시된 index.html (오프라인 실행)
 * - data/ (월드 데이터, 해시 없는 파일명): network-first — 새 배포의 앱과 데이터 버전이 어긋나지 않게
 * - 그 밖의 같은 출처 정적 자산(해시된 assets/ 등): stale-while-revalidate
 * - 대용량 data/ 는 프리캐시하지 않고, 한 번 내려받은 뒤 런타임 캐시에만 둔다.
 * - 배포 구조가 바뀌면 CACHE_VERSION 을 올려 이전 캐시를 정리한다.
 */
const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'gm-city-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
const DATA_PATH = new URL('./data/', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (!response || !response.ok) return;
  const copy = response.clone();
  caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
}

function networkFirst(request, fallbackUrl) {
  return fetch(request)
    .then((response) => {
      putInCache(request, response);
      return response;
    })
    .catch(() => caches.match(request)
      .then((cached) => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined))
      .then((cached) => cached || Response.error()));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, './index.html'));
    return;
  }

  if (url.pathname.startsWith(DATA_PATH)) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          putInCache(request, response);
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    })
  );
});
