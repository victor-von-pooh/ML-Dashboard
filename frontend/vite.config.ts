import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// 開発時は API をバックエンドに転送し, ビルドはバックエンドのパッケージの中に出力
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // バックエンドのポートは make dev-frontend PORT=... で揃える
      '/api': `http://127.0.0.1:${process.env.API_PORT ?? '8765'}`,
    },
  },
  build: {
    outDir: '../backend/src/ml_dashboard/static',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // e2e/ は Playwright の通しのテストなので, Vitest では src/ だけを実行
    include: ['src/**/*.test.{ts,tsx}'],
  },
})
