import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist/renderer',
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'editor-vendor': [
            'codemirror',
            '@codemirror/state',
            '@codemirror/view',
            '@codemirror/lang-markdown',
            '@codemirror/language',
            '@codemirror/autocomplete',
            '@codemirror/commands',
            '@codemirror/search',
            '@replit/codemirror-vim',
          ],
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
