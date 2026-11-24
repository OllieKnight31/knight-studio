import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: '.',
  base: './',                       // so the build also loads over file://
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', emptyOutDir: true, target: 'chrome130' }
})
