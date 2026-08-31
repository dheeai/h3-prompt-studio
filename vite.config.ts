import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Relative base so the same build works from GitHub Pages (any repo path),
// from a local static server, and from `npx h3-prompt-studio`.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', sourcemap: true },
})
