const CACHE_NAME = "ourcom-pwa-v1";
const APP_FILES = [
    "/offline.html",
    "/manifest.webmanifest",
    "/pwa.js",
    "/icons/ourcom-192.png",
    "/icons/ourcom-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_FILES)));
    self.skipWaiting();
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET") return;
    const url = new URL(event.request.url);
    if (url.origin !== self.location.origin) return;

    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).catch(() => caches.match("/offline.html")));
        return;
    }

    if (APP_FILES.includes(url.pathname)) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const copy = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
    }
});

self.addEventListener("push", event => {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
    const url = typeof data.url === "string" && data.url.startsWith("/") ? data.url : "/main.html";
    event.waitUntil(self.registration.showNotification(data.title || "OURCOM", {
        body: data.body || "새 메시지가 도착했습니다.",
        icon: "/icons/ourcom-192.png",
        badge: "/icons/ourcom-192.png",
        tag: data.tag || "ourcom-message",
        renotify: true,
        data: { url }
    }));
});

self.addEventListener("notificationclick", event => {
    event.notification.close();
    const url = event.notification.data?.url || "/main.html";
    event.waitUntil(
        self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
            for (const client of clients) {
                if ("navigate" in client) {
                    return client.navigate(url).then(navigated => navigated ? navigated.focus() : client.focus());
                }
                return client.focus();
            }
            return self.clients.openWindow ? self.clients.openWindow(url) : undefined;
        })
    );
});
