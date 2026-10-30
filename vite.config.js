import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  server: { proxy: { '/api': 'http://127.0.0.1:8080' } },
  worker: { format: 'es' },
  build: { rollupOptions: { input: { main: 'index.html', describe: 'describe.html', models: 'models.html', login: 'login.html', signup: 'signup.html', sessions: 'sessions.html' } } },
  plugins: [VitePWA({
    registerType: 'prompt',
    includeAssets: ['icons/*.png'],
    manifest: {
      name: 'Audit', short_name: 'Audit',
      description: 'Audit photos with Gemma 4 E2B on Amazon Bedrock.',
      theme_color: '#164f46', background_color: '#f7f6f0', display: 'standalone',
      start_url: './', scope: './',
      icons: [192,512].map(size => ({src:`icons/icon-${size}.png`,sizes:`${size}x${size}`,type:'image/png',purpose:'any maskable'})),
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,png,svg}'],
      cleanupOutdatedCaches: true,
      maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      navigateFallbackDenylist: [/\/(?:describe|models|login|signup|sessions)\.html$/, /\/ort\//, /\/api(?:\/|$)/],
    },
  })],
});
