import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE ?? '/',
  server: {
    // The dev server is reached from the LAN as `dub` (the user's host).
    allowedHosts: ['dub'],
  },
});
