/* Household Helper service worker.
   The app works offline after the first visit, and updates itself: every file
   of the app is fetched fresh from the site when there is a connection, and the
   saved copy is used only when offline. No version bump is needed when you
   publish a change. */
const VERSION = "household-helper-v9";
const SHELL = ["./", "index.html", "family.js", "account.js", "pantry.js", "lunchbox.js", "cook.js", "reminders.js", "vendor/supabase.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
const RUNTIME = "hh-runtime-v1";

self.addEventListener("install", e => {
  // cache: "reload" skips the browser's HTTP cache so the saved copy is the newest one
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.map(u => new Request(u, {cache: "reload"}))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("message", e => { if (e.data === "skipWaiting") self.skipWaiting(); });

// Network first (revalidating with the site), saved copy when offline
function fresh(req, key){
  return fetch(req, {cache: "no-cache"}).then(res => {
    if (res.ok){ const copy = res.clone(); caches.open(VERSION).then(c => c.put(key || req, copy)); }
    return res;
  }).catch(() => caches.match(key || req, {ignoreSearch: true}).then(hit => hit || Response.error()));
}

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (req.mode === "navigate"){ e.respondWith(fresh(req, "index.html")); return; }
  if (url.origin === location.origin){ e.respondWith(fresh(req)); return; }
  // Fonts and the barcode reader: keep a copy after first use so they work offline
  if (/fonts\.(googleapis|gstatic)\.com$/.test(url.hostname) || url.hostname === "cdn.jsdelivr.net"){
    e.respondWith(caches.open(RUNTIME).then(c => c.match(req).then(hit => hit || fetch(req).then(res => { if (res.ok || res.type === "opaque") c.put(req, res.clone()); return res; }))));
  }
  // Everything else (shop links etc.) goes straight to the network
});

// Daily reminders: show the notification the server sends, and open the app when it's tapped
self.addEventListener("push", e => {
  let d = {}; try{ d = e.data ? e.data.json() : {}; }catch{ d = {body: e.data ? e.data.text() : ""}; }
  e.waitUntil(self.registration.showNotification(d.title || "Household Helper", {
    body: d.body || "", icon: "icons/icon-192.png", badge: "icons/favicon-32.png", tag: "hh-reminder", renotify: true, data: {url: d.url || "./"}
  }));
});
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(clients.matchAll({type: "window", includeUncontrolled: true}).then(list => {
    const open = list.find(c => c.url.startsWith(self.registration.scope));
    return open ? open.focus() : clients.openWindow(url);
  }));
});
