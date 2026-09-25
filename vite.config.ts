import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: {
    // The dev server is reached from the LAN as `dub` (the user's host).
    allowedHosts: ['dub'],
  },
  optimizeDeps: {
    // Pre-bundle every three entry in ONE esbuild pass so `three`,
    // `three/webgpu` and the TSL addons share a single `three.core` chunk.
    // Otherwise the lazily imported cyberpunk view (src/render/punk/) is
    // discovered late, optimised separately, and ships a second copy of
    // three — `instanceof` across the two then fails.
    include: [
      'three',
      'three/webgpu',
      'three/tsl',
      'three/addons/tsl/display/BloomNode.js',
      'three/addons/tsl/display/LensflareNode.js',
      'three/addons/tsl/display/GaussianBlurNode.js',
      'three/addons/tsl/display/SMAANode.js',
      'three/addons/tsl/display/FilmNode.js',
      'three/addons/tsl/display/SSRNode.js',
    ],
  },
});
