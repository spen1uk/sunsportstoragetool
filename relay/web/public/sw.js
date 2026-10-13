// Minimal service worker: enables installability. No offline caching of customer data (privacy). Push notifications: not yet implemented.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
