import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const THEME_COLOR = "#0f766e";
const BACKGROUND_COLOR = "#ffffff";

// Everything the built app shell needs to boot with no network at all.
const PRECACHE_GLOB = "**/*.{js,css,html,svg,png,woff2}";

// Navigations under /api/ must never be answered with index.html.
const API_ROUTE = /^\/api\//;

const manifest = {
  name: "Setu",
  short_name: "Setu",
  description: "Offline-first field data collection",
  id: "/",
  start_url: "/",
  scope: "/",
  display: "standalone",
  theme_color: THEME_COLOR,
  background_color: BACKGROUND_COLOR,
  icons: [
    { src: "pwa-192x192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    {
      src: "maskable-icon-512x512.png",
      sizes: "512x512",
      type: "image/png",
      purpose: "maskable",
    },
  ],
};

const pwa = VitePWA({
  // "prompt", not "autoUpdate". autoUpdate activates a new service worker and
  // reloads every open tab as soon as it downloads, which would wipe a form a
  // field worker is halfway through. With "prompt" the new version waits until
  // the user chooses to reload (see components/UpdatePrompt.jsx).
  registerType: "prompt",

  // UpdatePrompt registers the worker itself through virtual:pwa-register/react.
  injectRegister: false,

  manifest,
  // PRECACHE_GLOB already picks up the icon PNGs; including them again only
  // duplicates entries in the precache list.
  includeManifestIcons: false,

  workbox: {
    globPatterns: [PRECACHE_GLOB],
    cleanupOutdatedCaches: true,

    // Deep links such as /records/123 load the cached shell offline, and the
    // React app takes over from there.
    navigateFallback: "/index.html",
    navigateFallbackDenylist: [API_ROUTE],

    runtimeCaching: [
      {
        // /api is NetworkOnly on purpose. Do not "optimise" this into a cache.
        // Dexie is the offline data layer, and the HTTP cache must not become a
        // second one: a cached response would be another copy of server data
        // that can quietly disagree with IndexedDB and with the server. It would
        // also keep tokens, hashes and other users' data on disk outside the
        // stores removeAccountFromDevice() wipes. When the network is down, API
        // calls must fail with a TypeError so apiFetch reports a NetworkError
        // and the app falls back to Dexie.
        //
        // Workbox writes this function into sw.js as source text, so it cannot
        // use variables from this file. Workbox routes only match GET by
        // default. POST/PUT/DELETE (login, logout, future sync pushes) are never
        // intercepted, and the Cache API cannot store them anyway.
        urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
      },
    ],
  },

  devOptions: {
    // Registers the service worker under `npm run dev` too, so registration and
    // the update prompt can be checked without a build. Dev only: this option
    // is ignored by `vite build`, and the dev worker precaches only index.html
    // because there is no build output yet. A real offline test still needs
    // `vite build` + `vite preview`.
    enabled: true,
    navigateFallback: "index.html",
    type: "module",
  },
});

export default defineConfig({
  plugins: [react(), pwa],
  server: {
    port: 5173,
    proxy: {
      //this tells vite: if react code tries to fetch url starting with '/api' ex '/api/health'....intercept it and forward it to the
      //target : "http://localhost:5000" ie the express backend

      //changeOrigin: true: This rewrites the request headers so that the Express server thinks the request originated from its own 
      // port (5000) rather than the React port (5173). It's a standard practice to prevent backends from rejecting the request.
      
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
      },
    },
  },
});