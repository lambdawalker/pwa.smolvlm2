import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  worker: { format: 'es' },
  plugins: [VitePWA({
    registerType: 'prompt',
    includeAssets: ['icons/*.png', 'ort/*'],
    manifest: {
      name: 'Little Lens · SmolVLM2', short_name: 'Little Lens',
      description: 'Describe your photos privately, on your device.',
      theme_color: '#164f46', background_color: '#f7f6f0', display: 'standalone',
      start_url: './', scope: './',
      icons: [192,512].map(size => ({src:`icons/icon-${size}.png`,sizes:`${size}x${size}`,type:'image/png',purpose:'any maskable'})),
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg,wasm,mjs}'],
      maximumFileSizeToCacheInBytes: 80 * 1024 * 1024,
      navigateFallbackDenylist: [/\/ort\//, /\/api(?:\/|$)/],
    },
  })],
});
