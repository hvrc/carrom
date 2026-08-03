import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3001,
    strictPort: true,
    // Ruler mode runs the REAL simulation to forecast a shot, so the client
    // imports server/sim/* directly rather than keeping a second copy of the
    // physics that could drift from the authority.
    fs: { allow: ['..'] }
  },
  build: {
    outDir: 'dist',
    assetsDir: '.',
    sourcemap: false
  }
});