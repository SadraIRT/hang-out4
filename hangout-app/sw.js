const CACHE = 'hangout4-v3-live-sync-2026';
const ASSETS = ['./css/style.css','./js/app.js','./manifest.json','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
  // force all clients to reload once
});
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  // Never cache API/WS - always network
  if(url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws')) return;
  // For navigation (index.html) use network-first to ensure updates via ngrok
  if(e.request.mode === 'navigate' || url.pathname.endsWith('/') || url.pathname.endsWith('index.html')){
    e.respondWith(fetch(e.request).then(res=>{
      // update cache in background
      caches.open(CACHE).then(c=>c.put(e.request, res.clone()));
      return res;
    }).catch(()=>caches.match(e.request).then(r=> r || caches.match('./index.html'))));
    return;
  }
  // For assets, cache-first fallback to network
  e.respondWith(caches.match(e.request).then(r=> r || fetch(e.request).then(res=>{
    caches.open(CACHE).then(c=>c.put(e.request, res.clone()));
    return res;
  }).catch(()=>caches.match('./index.html'))));
});
self.addEventListener('message', e=>{
  if(e.data==='skipWaiting') self.skipWaiting();
});
