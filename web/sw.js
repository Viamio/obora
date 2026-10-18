// Service worker aplikacji Obora: działanie bez internetu, aktualizacje i powiadomienia.
// Zmiana WERSJA = nowa wersja aplikacji -> na telefonach pojawi się pasek "Aktualizuj".
const WERSJA = "4.1";
const CACHE = "obora-" + WERSJA;
const PLIKI = [
  "./", "index.html", "app.mjs", "logic.mjs", "style.css", "config.js", "manifest.webmanifest",
  "ikona-192.png", "ikona-512.png", "apple-touch-icon.png", "odznaka-96.png", "tlo.jpg",
];

importScripts("config.js");
if (self.OBORA_FIREBASE && self.OBORA_FIREBASE.apiKey) {
  importScripts(
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js",
    "https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js"
  );
  firebase.initializeApp(self.OBORA_FIREBASE);
  firebase.messaging(); // pokazuje powiadomienia wysłane przez automat, gdy aplikacja jest zamknięta
}

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PLIKI.map((p) => new Request(p, { cache: "reload" })))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("obora-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (e) => { if (e.data === "AKTUALIZUJ") self.skipWaiting(); });

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // pliki aplikacji: z pamięci telefonu (nowa wersja przychodzi przez "Aktualizuj")
  if (url.origin === location.origin) {
    e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req)));
    return;
  }
  // biblioteki Firebase i czcionki: zapamiętaj, żeby działało bez zasięgu
  if (url.hostname === "www.gstatic.com" || url.hostname.endsWith("fonts.googleapis.com") || url.hostname === "fonts.gstatic.com") {
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === "opaque") c.put(req, res.clone());
      return res;
    }));
  }
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return self.clients.openWindow("./");
  }));
});
