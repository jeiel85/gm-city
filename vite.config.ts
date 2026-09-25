import { defineConfig } from 'vite';

// GitHub Pages 프로젝트 사이트는 /<저장소명>/ 아래에서 서비스된다.
export default defineConfig({
  base: process.env.GM_CITY_BASE ?? '/gm-city/',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
});
