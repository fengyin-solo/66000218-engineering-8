/// <reference types="vite/client" />
declare module '*.vue' { import type { DefineComponent } from 'vue'; const component: DefineComponent<{}, {}, any>; export default component }

// 由 vite.config.ts 的 braille-baseline-data 插件提供的虚拟模块
declare module 'virtual:braille-data' {
  export const DATA_VERSION: number
  export const DATA_FINGERPRINT: string
}
