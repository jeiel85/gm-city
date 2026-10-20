/* GM City 서비스워커 (scope: 이 파일이 있는 /gm-city/ 디렉터리)
 * - 내비게이션: network-first, 실패 시 캐시된 같은 페이지 → index.html (오프라인 실행)
 * - data/ (해시 없는 월드 데이터): network-first — 새 배포의 앱과 데이터 버전이 어긋나지 않게.
 *   용량이 커서 프리캐시하지 않고 런타임 캐시에만 둔다.
 * - 그 밖의 같은 출처 정적 자산(GET): stale-while-revalidate
 * - 페이지가 첫 로드에 받은 같은 출처 자원 목록(CACHE_URLS 메시지)을 받아 캐시에 채운다.
 *   (해시된 번들은 빌드마다 이름이 바뀌어 프리캐시 목록에 고정할 수 없고, 첫 로드는 SW 제어 전에 끝나므로)
 * - 캐시 쓰기는 event.waitUntil 로 이벤트 수명 안에서 끝낸다.
 * - 배포 구조가 바뀌면 CACHE_VERSION 을 올려 이전 캐시를 정리한다.
 */
const CACHE_VERSION = 'v1';
const CACHE_PREFIX = 'gm-city-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;
const SCOPE_PATH = new URL('./', self.location).pathname;
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];
const DATA_PATH = SCOPE_PATH + 'data/';

// 프리캐시한 HTML이 참조하는 빌드 산출물(assets/ 아래 해시된 JS·CSS)도 함께 받아 둔다.
function precacheReferencedAssets(cache) {
  const pages = PRECACHE.filter((path) => path.endsWith('.html'));
  return Promise.all(pages.map((page) => cache.match(page)
    .then((response) => (response ? response.text() : ''))
    .then((html) => {
      const assets = new Set();
      for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const url = new URL(match[1], new URL(page, self.location));
        if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PATH + 'assets/')) {
          assets.add(url.href);
        }
      }
      return cache.addAll([...assets]);
    })));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).then(() => precacheReferencedAssets(cache)))
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

function cachePut(request, response) {
  if (!response || !response.ok) return Promise.resolve();
  const copy = response.clone();
  return caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
}

// 네트워크 우선. 응답이 오면 캐시 갱신을 이벤트 수명에 묶고, 실패하면 캐시(→ fallback)로 응답한다.
function networkFirst(event, fallbackUrl) {
  const { request } = event;
  const network = fetch(request);
  event.waitUntil(network.then((response) => cachePut(request, response)).catch(() => {}));
  return network.catch(() => caches.match(request, { ignoreSearch: request.mode === 'navigate' })
    .then((cached) => cached || (fallbackUrl ? caches.match(fallbackUrl) : undefined))
    .then((cached) => cached || Response.error()));
}

// 캐시가 있으면 즉시 응답하고, 백그라운드 갱신은 event.waitUntil 로 끝까지 수행한다.
function staleWhileRevalidate(event) {
  const { request } = event;
  const network = fetch(request);
  event.waitUntil(network.then((response) => cachePut(request, response)).catch(() => {}));
  return caches.match(request)
    .then((cached) => cached || network.catch(() => Response.error()));
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(event, './index.html'));
    return;
  }

  if (url.pathname.startsWith(DATA_PATH)) {
    event.respondWith(networkFirst(event));
    return;
  }

  event.respondWith(staleWhileRevalidate(event));
});

// 페이지가 보낸 자원 목록 중 이 scope 안의 같은 출처 URL을, 아직 캐시에 없으면 받아 둔다.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'CACHE_URLS' || !Array.isArray(data.urls)) return;
  const urls = [];
  for (const raw of data.urls) {
    try {
      const url = new URL(raw, self.location);
      if (url.origin === self.location.origin && url.pathname.startsWith(SCOPE_PATH)) {
        url.hash = '';
        urls.push(url.href);
      }
    } catch {
      // 잘못된 URL은 건너뛴다.
    }
  }
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => Promise.all(
    [...new Set(urls)].map((url) => cache.match(url).then((hit) => hit || fetch(url)
      .then((response) => (response.ok ? cache.put(url, response) : undefined))
      .catch(() => {})))
  )));
});
