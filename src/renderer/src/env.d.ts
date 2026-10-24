/// <reference types="vite/client" />

import type { BrowserApi } from '../../shared/types'

declare global {
  const __APP_VERSION__: string
  interface Window {
    browserApi: BrowserApi
  }
}

export {}
