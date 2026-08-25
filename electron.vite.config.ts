import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import pkg from './package.json'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    // Baked in from package.json at build time so the version shown in the app
    // can never drift from the version that was actually shipped.
    define: { __APP_VERSION__: JSON.stringify(pkg.version) }
  }
})
