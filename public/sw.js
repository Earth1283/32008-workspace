/* Keeps the app's own files on the device so it opens without a connection. Always prefers the server, so a new
   version shows up on the next load. Team data never passes through here: /api is left to the page. */
const CACHE = "008-app-v2";
const APP_FILES = ["/", "/style.css", "/theme.js", "/data.js", "/scoring.js", "/commands.js", "/menu.js", "/csv.js", "/offline.js", "/scouting.js", "/app.js"];
const SLOW_NETWORK_MS = 3000;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

async function latestThenCached(request, key) {
  const cache = await caches.open(CACHE);
  const fromNetwork = fetch(request).then((response) => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  const slowNetwork = new Promise((resolve) => { setTimeout(resolve, SLOW_NETWORK_MS); });
  try {
    const response = await Promise.race([fromNetwork, slowNetwork]);
    if (response) return response;
  } catch { /* no network: the cached copy below answers */ }
  fromNetwork.catch(() => {});
  return (await cache.match(key)) ?? fromNetwork;
}

self.addEventListener("fetch", (event) => {
  const { request } = event, url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const key = request.mode === "navigate" ? "/" : url.pathname;
  event.respondWith(latestThenCached(request, key));
});
