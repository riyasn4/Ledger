const CACHE = 'ledger-cache-v3';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './seed-data.js',
  './drive-config.js',
  './drive-sync.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).catch(()=>{}));
  self.skipWaiting();
});

self.addEventListener('activate', e=>{
  e.waitUntil(
    caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e=>{
  const req = e.request;
  if(req.method !== 'GET') return;
  // Only ever handle this app's own files. Anything cross-origin — Google
  // sign-in, the Drive API, fonts — is left completely alone so the page's
  // own fetch() calls behave normally and aren't wrapped in caching logic
  // that doesn't apply to them.
  const url = new URL(req.url);
  if(url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(req).then(cached=>{
      if(cached) return cached;
      return fetch(req).then(networkResp=>{
        const copy = networkResp.clone();
        caches.open(CACHE).then(c=>c.put(req, copy)).catch(()=>{});
        return networkResp;
      }).catch(()=> cached);
    })
  );
});
