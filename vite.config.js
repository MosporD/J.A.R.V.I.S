import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    port: 5173,
    host: true,
    open: false,
  },
  build: {
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 8192,
  },
});
