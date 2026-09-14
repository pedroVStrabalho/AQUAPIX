import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs. Vercel serves this game from the domain root, but a
  // relative base also works from a sub-path (project previews, GitHub Pages,
  // itch.io zips) with no rebuild, and costs nothing when it is not needed.
  base: './',

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    // The pixel renderer and the simulation are plain ES modules with no
    // runtime eval, so a modern browser target keeps the bundle small.
    target: 'es2020',
    sourcemap: false,
    emptyOutDir: true,
  },

  server: { port: 5178, strictPort: false },
  preview: { port: 4173 },
});
