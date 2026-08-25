import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es'
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          pdfjs: ['pdfjs-dist'],
          vendor: ['react', 'react-dom', 'zustand', 'framer-motion']
        }
      }
    }
  }
});
