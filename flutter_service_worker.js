/* flutter_service_worker.js — СТАТИЧЕСКАЯ (WASM/Pyodide) сборка «Ежедневника».
 *
 * Приложение целиком живёт в браузере (Pyodide), поэтому кэшируем все
 * статические ресурсы источника: загрузчик, Flutter, Pyodide+wheels,
 * app.tar.gz, CanvasKit, шрифты. После первого запуска открытие страницы
 * работает без сети (авиарежим / недоступный хостинг).
 *
 * - Навигация (index.html): network-first, офлайн — из кэша.
 * - Остальное same-origin GET: cache-first (обновление — через новую
 *   версию SW: при пересборке имя кэша меняется, старый удаляется).
 * - Кросс-доменное (Firebase REST): только сеть, SW не вмешивается.
 */
const VERSION = 'ezh-wasm-v4-subpath-1793342333';
const CORE = [
  './', './index.html', './flutter_bootstrap.js', './flutter.js',
  './python.js', './python-worker.js', './main.dart.js', './main.dart.mjs',
  './manifest.json', './version.json', './offline.html', './favicon.png',
  './icon.png', './icons/icon-192.png', './icons/icon-512.png',
  './assets/fonts/MaterialIcons-Regular.otf', './assets/fonts/roboto.woff2'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Индивидуально: отсутствие одного файла не срывает установку
    await Promise.allSettled(CORE.map((u) => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.startsWith('ezh-wasm-')).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // Firebase и пр. — сеть

  // Навигация: сначала сеть (обновления доходят), офлайн — кэш.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (e) {
        const cache = await caches.open(VERSION);
        return (await cache.match('./index.html'))
          || (await cache.match('./offline.html'))
          || new Response('Offline', { status: 503 });
      }
    })());
    return;
  }

  // Прочее same-origin: cache-first (без фоновых перезакачек — обновления
  // приходят сменой VERSION при новой сборке).
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) cache.put(req, fresh.clone());
      return fresh;
    } catch (e) {
      return new Response('Offline', { status: 503 });
    }
  })());
});
