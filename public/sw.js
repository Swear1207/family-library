self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(
  caches.keys()
    .then(keys => Promise.all(keys.filter(key => key.startsWith('yiwushu-shell-') || key.startsWith('family-knowledge-shell-')).map(key => caches.delete(key))))
    .then(() => self.registration.unregister())
));
