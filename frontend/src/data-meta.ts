// 当前运行时使用的盲文基线版本与指纹，由 vite.config.ts 的
// braille-baseline-data 插件通过虚拟模块在 dev/build 同一条路径上提供。
// 流水线 verify-build 步骤会确认构建产物里包含的指纹与 data/braille-baseline.json 一致。
export { DATA_VERSION, DATA_FINGERPRINT } from 'virtual:braille-data'
