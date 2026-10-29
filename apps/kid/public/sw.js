self.addEventListener("install", (event) => {
  event.waitUntil(caches.open("gp-shell-1").then((cache) => cache.addAll(["/", "/favicon.svg"])));
  self.skipWaiting();
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/media")) return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
