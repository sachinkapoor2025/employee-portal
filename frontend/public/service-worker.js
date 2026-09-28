/* DGV Employee Portal — static shell service worker (Phase 2B).
   Caches same-origin public assets only. Never intercepts auth or API. */

const CACHE_VERSION = "dgv-static-v1";
const CACHE_PREFIX = "dgv-static-";

const PRECACHE_URLS = [
  "/manifest.json",
  "/logo192.png",
  "/logo512.png",
  "/favicon.ico",
];

function isNonGet(request) {
  return request.method !== "GET";
}

function isCrossOrigin(url) {
  return url.origin !== self.location.origin;
}

function isNavigation(request) {
  return request.mode === "navigate";
}

function isDeniedPath(url) {
  const path = url.pathname || "";
  if (path === "/api" || path.indexOf("/api/") === 0) return true;
  const host = (url.hostname || "").toLowerCase();
  if (host.indexOf("amazoncognito.com") !== -1) return true;
  if (host.indexOf("cognito-idp") !== -1) return true;
  if (host.indexOf("execute-api") !== -1) return true;
  if (host.indexOf("amazonaws.com") !== -1) return true;
  return false;
}

function isStaticShellUrl(url) {
  const path = url.pathname || "";
  if (path === "/manifest.json") return true;
  if (path === "/logo192.png" || path === "/logo512.png") return true;
  if (path === "/favicon.ico") return true;
  if (path.indexOf("/static/js/") === 0) return true;
  if (path.indexOf("/static/css/") === 0) return true;
  if (path.indexOf("/static/media/") === 0) return true;
  return false;
}

function shouldHandle(request) {
  if (isNonGet(request)) return false;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return false;
  }
  if (isCrossOrigin(url)) return false;
  if (isNavigation(request)) return false;
  if (isDeniedPath(url)) return false;
  if (!isStaticShellUrl(url)) return false;
  return true;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_VERSION) {
              return caches.delete(key);
            }
            return undefined;
          })
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (!shouldHandle(event.request)) return;

  event.respondWith(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.match(event.request).then((cached) => {
        if (cached) return cached;
        return fetch(event.request)
          .then((response) => {
            if (response && response.ok && response.type === "basic") {
              cache.put(event.request, response.clone());
            }
            return response;
          })
          .catch((err) => {
            throw err;
          });
      })
    )
  );
});
