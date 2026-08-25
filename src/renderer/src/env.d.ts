import type { Api } from '../../shared/types'

declare global {
  // Exposed by the preload script through contextBridge.
  interface Window {
    api: Api
  }

  // Injected by electron-vite from package.json at build time, so the version
  // shown in the UI can never drift from the version actually shipped.
  const __APP_VERSION__: string
}
