import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'
import { loadBaseline } from '../scripts/braille/lib/braille-data.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const VIRTUAL_DATA_ID = 'virtual:braille-data'
const RESOLVED_DATA_ID = '\0virtual:braille-data'

/**
 * 基线数据插件：开发服务器（vite dev）与构建（vite build）共用同一入口。
 * 启动时立即加载并校验 data/braille-baseline.json，校验失败直接报错，
 * 保证“开发时看到的数据”与“构建进产物的数据”必然来自同一份本地基线。
 *
 * 版本/指纹通过虚拟模块 virtual:braille-data 暴露（dev 与 build 走同一条解析路径），
 * 避免 define 在两种模式下行为不一致。
 */
function brailleBaselinePlugin(): Plugin {
  const loaded = loadBaseline(repoRoot)
  if (loaded.errors.length) {
    // 工厂阶段就抛出：dev 和 build 都会立刻失败，绝不使用无效基线
    throw new Error(
      `[braille-baseline] 基线数据校验失败（data/braille-baseline.json）：\n`
      + loaded.errors.map(e => `  - ${e}`).join('\n'),
    )
  }
  const version = loaded.baseline!.version
  const fingerprint = process.env.BRAILLE_DATA_FINGERPRINT || loaded.fingerprint

  return {
    name: 'braille-baseline-data',
    config() {
      console.log(`[braille-baseline] 基线已加载：${loaded.baseline!.characters.length} 个字符，版本 v${version}，指纹 ${fingerprint}`)
      return {
        resolve: {
          alias: {
            '@data': fileURLToPath(new URL('../data', import.meta.url)),
          },
        },
      }
    },
    resolveId(id) {
      if (id === VIRTUAL_DATA_ID) return RESOLVED_DATA_ID
    },
    load(id) {
      if (id === RESOLVED_DATA_ID) {
        return [
          `export const DATA_VERSION = ${JSON.stringify(version)}`,
          `export const DATA_FINGERPRINT = ${JSON.stringify(fingerprint)}`,
        ].join('\n')
      }
    },
  }
}

export default defineConfig({
  plugins: [vue(), brailleBaselinePlugin()],
  server: {
    port: 5181,
    open: true,
    // 基线数据在仓库根 data/ 下（frontend/ 之外），开发服务器需要放行仓库根
    fs: { allow: [repoRoot] },
    proxy: { '/api': 'http://localhost:8002' },
  },
})
