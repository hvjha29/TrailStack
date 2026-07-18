const CACHE_NAME = "trailstack-v1";
const CDN_ASSETS = [
  "https://cdn.jsdelivr.net/npm/idb@8.0.3/build/umd.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.52.1/dist/umd/supabase.js",
];
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./db.js",
  "./sync.js",
  "./sw.js",
  "./manifest.webmanifest",
  "./style.css",
  "./config.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  ...CDN_ASSETS,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (isSupabaseRequest(url)) {
    event.respondWith(fetch(request));
    return;
  }

  if (request.method !== "GET") return;

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached;

      try {
        return await fetch(request);
      } catch (error) {
        if (request.mode === "navigate") {
          const fallback = await caches.match("./index.html");
          if (fallback) return fallback;
        }
        throw error;
      }
    }),
  );
});

function isSupabaseRequest(url) {
  const supabaseHost =
    url.hostname.endsWith(".supabase.co") ||
    url.hostname.endsWith(".supabase.in");
  const supabasePath = ["/rest/v1/", "/storage/v1/", "/auth/v1/"].some((path) =>
    url.pathname.includes(path),
  );
  return supabaseHost || supabasePath;
}
