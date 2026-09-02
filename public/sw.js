// Minimal service worker. It doesn't do offline caching (this app needs a
// live connection to Supabase anyway) — it exists mainly because Chrome on
// Android requires a registered service worker before showing the
// "Add to Home Screen" / install prompt.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Pass-through: always hit the network. No offline cache.
});
