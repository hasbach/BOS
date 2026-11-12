/* BOS service worker (T082): keeps the static shell files (built scripts, styles, fonts, icons) so the
 * app opens quickly, and does nothing else. It never touches /api/ (every API request goes straight
 * to the network, so nothing from the server is ever kept or shown stale), never takes over page
 * navigations, and never handles anything but same-origin GET requests. Offline, the page already
 * on screen shows the offline notice (OfflineNotice); nothing is queued to send later. */

const CACHE = "bos-shell-v1";
const STATIC = [/^\/_next\/static\//, /^\/icons\//];

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

function isStaticShellFile(url) {
  // The API is never cached, whatever else the rules above might match.
  if (url.pathname.startsWith("/api/")) return false;
  return STATIC.some((pattern) => pattern.test(url.pathname));
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !isStaticShellFile(url)) return;

  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response && response.ok && response.type === "basic") cache.put(request, response.clone());
            return response;
          }),
      ),
    ),
  );
});
