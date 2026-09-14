// Replace the previous BETTER_CODEX service worker without caching private content.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
