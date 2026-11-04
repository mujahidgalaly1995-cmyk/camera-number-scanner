const VERSION = 'v8';
const APP_CACHE = `scanner-app-${VERSION}`;
const RUNTIME_CACHE = `scanner-runtime-${VERSION}`;
const VENDOR_CACHE = 'scanner-vendor-v1';

const VENDOR_ASSETS = [
    './assets/vendor/tesseract/tesseract.min.js',
    './assets/vendor/tesseract/worker.min.js',
    './assets/vendor/tesseract/tesseract-core-simd-lstm.wasm.js',
    './assets/vendor/tesseract/tesseract-core-lstm.wasm.js',
    './assets/tessdata/eng.traineddata.gz',
];

const APP_SHELL = [
    './',
    './index.html',
    './app.js',
    './ocr-utils.js',
    './manifest.webmanifest',
    './assets/app.css',
    './assets/fonts/vazirmatn-arabic.woff2',
    './assets/fonts/vazirmatn-latin.woff2',
    './assets/fa/css/all.min.css',
    './assets/fa/webfonts/fa-solid-900.woff2',
    './assets/fa/webfonts/fa-regular-400.woff2',
    './assets/icons/favicon-32.png',
    './assets/icons/icon-192.png',
    './assets/icons/icon-512.png',
    './assets/icons/icon-1024.png',
    './assets/icons/icon-maskable-512.png',
    './assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const appCache = await caches.open(APP_CACHE);
            await appCache.addAll(APP_SHELL);

            // OCR engine and language model rarely change; cache them once so
            // later versions do not download several megabytes again.
            try {
                const vendorCache = await caches.open(VENDOR_CACHE);
                const cached = await vendorCache.keys();
                if (!cached.length) await vendorCache.addAll(VENDOR_ASSETS);
            } catch (err) {
                // The files are cached on first OCR run instead.
            }

            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches
            .keys()
            .then((keys) =>
                Promise.all(
                    keys
                        .filter((key) => key !== APP_CACHE && key !== RUNTIME_CACHE && key !== VENDOR_CACHE)
                        .map((key) => caches.delete(key))
                )
            )
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const copy = response.clone();
                    caches.open(APP_CACHE).then((cache) => cache.put('./index.html', copy));
                    return response;
                })
                .catch(() => caches.match('./index.html'))
        );
        return;
    }

    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response.ok) {
                        const copy = response.clone();
                        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
                    }
                    return response;
                });
            })
        );
        return;
    }

    // CDN assets (Tesseract OCR core, language data, etc.)
    event.respondWith(
        caches.match(request).then((cached) => {
            const network = fetch(request)
                .then((response) => {
                    if (response.ok || response.type === 'opaque') {
                        const copy = response.clone();
                        caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy));
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || network;
        })
    );
});
