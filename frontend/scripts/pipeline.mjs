#!/usr/bin/env node
/**
 * 盲文数据流水线 —— 本地开发与构建共用的唯一入口。
 *
 *   node scripts/pipeline.mjs dev    开发前置：依赖核对 → 基线校验 → 示例校验（npm run dev 自动触发）
 *   node scripts/pipeline.mjs build  完整流程：上述三步 + 类型检查 → 构建 → 产物数据指纹校验
 *   node scripts/pipeline.mjs data   只跑数据部分：基线校验 → 示例校验
 *
 * 每一步都会打印通过/失败结论；失败时指出是哪一步、原因与修复方法，并以非 0 码退出。
 * 重新执行时：构建产物目录 dist 会先清空，生成文件采用临时文件原子替换，不残留上一次的中间产物。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_PATH = join(ROOT, 'package.json')
const LOCK_PATH = join(ROOT, 'package-lock.json')
const BASELINE_PATH = join(ROOT, 'data', 'baseline', 'braille-grade1.json')
const SAMPLES_DIR = join(ROOT, 'data', 'samples')
const GENERATED_DIR = join(ROOT, 'src', 'data')
const GENERATED_FILE = join(GENERATED_DIR, 'braille-data.ts')
const GENERATED_TMP = join(GENERATED_DIR, '.braille-data.ts.tmp')
const DIST_DIR = join(ROOT, 'dist')

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const green = s => c('32', s)
const red = s => c('31', s)
const yellow = s => c('33', s)
const cyan = s => c('36', s)
const dim = s => c('90', s)

const mode = process.argv[2]
if (!['dev', 'build', 'data'].includes(mode)) {
  console.error(red('用法: node scripts/pipeline.mjs <dev|build|data>'))
  process.exit(2)
}

// ---- 统一的步骤结果收集 ---------------------------------------------------
const issues = [] // { step, reasons: string[], fix?: string }

function stepTitle(total, n, name) {
  console.log(`\n${cyan(`▶ [${n}/${total}] ${name}`)} ${dim('...')}`)
}
function stepPass(total, n, name, detail) {
  console.log(`${green('✅')} [${n}/${total}] ${name}通过${detail ? ` ${dim('— ' + detail)}` : ''}`)
}
function stepFail(total, n, name, reasons, fix) {
  console.log(`${red('❌')} [${n}/${total}] ${name}失败`)
  console.log(red('   原因：'))
  for (const r of reasons) console.log(red(`     · ${r}`))
  if (fix) console.log(yellow(`   修复：${fix}`))
  issues.push({ step: `[${n}/${total}] ${name}`, reasons, fix })
}
function ok(msg) { console.log(`  ${green('✓')} ${msg}`) }
function info(msg) { console.log(`  ${dim('·')} ${msg}`) }

// ---- 极小版本号比较（支持 ^ ~ x * 精确值 比较器 与 ||） -------------------
function parseVersion(v) {
  const m = String(v).trim().replace(/^[v=]+/, '').match(/^(\d+)\.(\d+)\.(\d+)/)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
function cmp(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1 }
  return 0
}
function satisfiesOne(version, range) {
  range = range.trim()
  if (range === '' || range === '*' || range === 'x' || range === 'X' || range.toLowerCase() === 'latest') return true
  if (range.includes('||')) return range.split('||').some(r => satisfiesOne(version, r))
  const v = parseVersion(version)
  if (!v) return false
  const m = range.match(/^([\^~>=<]*)\s*v?(\d+|x|X|\*)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?/)
  if (!m) return { unsupported: range }
  const op = m[1] || '='
  const nums = [m[2], m[3], m[4]].map(x => (x === undefined || x === 'x' || x === 'X' || x === '*' ? 'x' : Number(x)))
  const lo = nums.map(n => (n === 'x' ? 0 : n))

  if (op === '^') {
    if (cmp(v, lo) < 0) return false
    if (nums[0] === 'x' || nums[0] > 0) return nums[0] === 'x' || v[0] === nums[0]
    // 0.x 系列：^0.2.x 锁到 0.2，^0.0.3 锁到 0.0.3
    if (nums[1] !== 'x' && nums[1] > 0) return v[0] === 0 && v[1] === nums[1]
    return v[0] === 0 && v[1] === 0 && v[2] === nums[2]
  }
  if (op === '~') {
    if (cmp(v, lo) < 0) return false
    return v[0] === nums[0] && (nums[1] === 'x' || v[1] === nums[1])
  }
  if (op === '=' && nums.some(n => n === 'x')) {
    // 部分精确范围，如 1.x、1.2：按已给层级比较
    if (nums[1] === 'x') return v[0] === nums[0]
    return v[0] === nums[0] && v[1] === nums[1]
  }
  const r = cmp(v, lo)
  if (op === '=') return r === 0
  if (op === '>=') return r >= 0
  if (op === '>') return r > 0
  if (op === '<=') return r <= 0
  if (op === '<') return r < 0
  return { unsupported: range }
}
function satisfies(version, range) {
  // 空格分隔的 AND 范围
  return range.split(/\s+/).filter(Boolean).every(r => {
    const res = satisfiesOne(version, r)
    return res === true || res === false ? res : false
  })
}

// ---- 盲文编码（与 src/utils/braille.ts 运行时逻辑一致，独立实现用于校验） --
function dotsToUnicode(dots) {
  let code = 0x2800
  for (const d of dots) code += 2 ** (d - 1)
  return String.fromCodePoint(code)
}
function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')) }

// ===========================================================================
// 步骤定义
// ===========================================================================
const steps = []

// [1] 依赖核对
steps.push({
  name: '依赖核对',
  run() {
    const reasons = []
    if (!existsSync(join(ROOT, 'node_modules'))) {
      reasons.push('未发现 node_modules/，依赖尚未安装')
      return { reasons, fix: '在 frontend/ 目录执行 npm install（会依据 package-lock.json 安装与构建机一致的版本）' }
    }
    const nodeRange = '>=18.18'
    const nodeVer = process.version.replace(/^v/, '')
    if (!satisfies(nodeVer, nodeRange)) reasons.push(`Node 版本 ${process.version} 不满足要求 ${nodeRange}`)
    else ok(`Node ${process.version}（要求 ${nodeRange}）`)

    let pkg
    try { pkg = readJson(PKG_PATH) } catch (e) { return { reasons: [`无法解析 package.json：${e.message}`] } }
    const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }

    let lock = null
    if (!existsSync(LOCK_PATH)) {
      reasons.push('未发现 package-lock.json —— 各机器只会按 package.json 范围各自解析版本，本地与构建产物无法保证一致')
    } else {
      try {
        lock = readJson(LOCK_PATH)
        ok(`package-lock.json 存在（lockfileVersion ${lock.lockfileVersion ?? '?'}）`)
        const lockRootDeps = { ...(lock.packages?.['']?.dependencies || {}), ...(lock.packages?.['']?.devDependencies || {}) }
        for (const [name, range] of Object.entries(declared)) {
          if (lockRootDeps[name] !== range) {
            reasons.push(`package-lock.json 中 ${name} 记录为 ${lockRootDeps[name] ?? '缺失'}，与 package.json 声明 ${range} 不一致（锁文件已过期）`)
          }
        }
      } catch (e) { reasons.push(`package-lock.json 解析失败：${e.message}`) }
    }

    let checked = 0
    for (const [name, range] of Object.entries(declared)) {
      const depPkgPath = join(ROOT, 'node_modules', name, 'package.json')
      if (!existsSync(depPkgPath)) { reasons.push(`缺少依赖 ${name}（声明 ${range}），node_modules 中未安装`); continue }
      let installed
      try { installed = readJson(depPkgPath).version } catch { reasons.push(`${name} 的 node_modules/${name}/package.json 损坏`); continue }
      const res = satisfiesOne(installed, range)
      if (res === true) { checked++; continue }
      if (res && typeof res === 'object' && 'unsupported' in res) { reasons.push(`${name} 使用了暂不支持核对的版本范围 ${range}，请改为 ^/~ /精确版本`); continue }
      reasons.push(`${name} 安装版本 ${installed} 不满足 package.json 声明 ${range}`)
      if (lock?.packages?.[`node_modules/${name}`]?.version && lock.packages[`node_modules/${name}`].version !== installed) {
        reasons.push(`${name} 的 node_modules 版本与 package-lock.json（${lock.packages[`node_modules/${name}`].version}）也不一致`)
      }
    }
    if (reasons.length) return { reasons, fix: '在 frontend/ 目录执行 npm install 对齐依赖；仍失败可删除 node_modules 后重装，再重新运行本命令' }
    ok(`已安装依赖版本全部满足 package.json 声明（${checked} 个）`)
    return null
  },
})

// [2] 基线数据校验 + 生成运行时数据
let baseline = null
steps.push({
  name: '基线字符数据校验',
  run() {
    const reasons = []
    let raw
    if (!existsSync(BASELINE_PATH)) {
      return { reasons: [`基线文件缺失：data/baseline/braille-grade1.json`], fix: '从版本库恢复该文件；它是本地与构建共用的唯一字符事实源，不应只存在于某台机器' }
    }
    try { raw = readJson(BASELINE_PATH) } catch (e) { return { reasons: [`基线文件不是合法 JSON：${e.message}`], fix: '修正 data/baseline/braille-grade1.json 的 JSON 语法后重跑' } }

    if (typeof raw.version !== 'number') reasons.push('缺少数值类型的顶层字段 version')
    if (!Array.isArray(raw.characters) || raw.characters.length === 0) { reasons.push('characters 必须是非空数组'); return { reasons } }

    const REQUIRED = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ...'0123456789', ' ']
    const seen = new Map()
    const entries = []
    raw.characters.forEach((item, i) => {
      const where = `characters[${i}]`
      if (!item || typeof item !== 'object') { reasons.push(`${where} 不是对象`); return }
      const ch = item.char
      const chars = typeof ch === 'string' ? Array.from(ch) : []
      if (chars.length !== 1) { reasons.push(`${where} 的 char 必须是单个字符，收到 ${JSON.stringify(ch)}`); return }
      const duplicate = seen.has(ch)
      if (duplicate) reasons.push(`${where} 字符 ${JSON.stringify(ch)} 与 characters[${seen.get(ch)}] 重复`)
      if (!Array.isArray(item.dots)) { reasons.push(`${where}（${JSON.stringify(ch)}）的 dots 必须是数组`); return }
      const dots = []
      let itemBad = duplicate
      const badDots = new Set()
      item.dots.forEach(d => {
        if (!Number.isInteger(d) || d < 1 || d > 6) { badDots.add(JSON.stringify(d)); itemBad = true }
        else if (dots.includes(d)) { reasons.push(`${where}（${JSON.stringify(ch)}）点位 ${d} 重复`); itemBad = true }
        else dots.push(d)
      })
      for (const d of badDots) reasons.push(`${where}（${JSON.stringify(ch)}）出现非法点位 ${d}，只允许 1-6 的整数`)
      if (itemBad) return
      dots.sort((a, b) => a - b)
      seen.set(ch, i)
      entries.push({ char: ch, dots, unicode: dotsToUnicode(dots) })
    })

    const missing = REQUIRED.filter(ch => !seen.has(ch))
    if (missing.length) reasons.push(`基线覆盖不完整，缺少必需字符：${missing.map(x => JSON.stringify(x)).join('、')}（要求 A-Z、0-9、空格）`)

    if (reasons.length) return { reasons, fix: '按上述原因修正 data/baseline/braille-grade1.json 后重跑，无需手工改 src 下任何文件' }

    // 规范化（按码位排序）后取哈希，保证基线内容相同指纹就相同
    const canonical = JSON.stringify({
      version: raw.version,
      characters: entries
        .slice()
        .sort((a, b) => a.char.codePointAt(0) - b.char.codePointAt(0))
        .map(e => ({ char: e.char, dots: e.dots, unicode: e.unicode })),
    })
    const hash = createHash('sha256').update(canonical, 'utf8').digest('hex')
    baseline = { version: raw.version, entries, hash }
    ok(`基线版本 v${raw.version}，字符 ${entries.length} 个（A-Z、0-9、空格）`)
    ok(`基线内容指纹 sha256:${hash.slice(0, 16)}…`)

    // 由基线生成运行时 TS 模块：临时文件 + 原子替换，失败不留半截文件
    mkdirSync(GENERATED_DIR, { recursive: true })
    const lines = [
      '// 本文件由 scripts/pipeline.mjs 依据 data/baseline/braille-grade1.json 自动生成，请勿手工修改。',
      `export const BASELINE_VERSION = ${raw.version}`,
      `export const BASELINE_HASH = ${JSON.stringify(hash)}`,
      `export interface BrailleEntry { char: string; dots: number[]; unicode: string }`,
      `export const BRAILLE_ENTRIES: BrailleEntry[] = ${JSON.stringify(entries.map(e => ({ char: e.char, dots: e.dots, unicode: e.unicode })), null, 2)}`,
      `export const BRAILLE_MAP: Record<string, number[]> = Object.fromEntries(BRAILLE_ENTRIES.map(e => [e.char, e.dots]))`,
      `export const BRAILLE_UNICODE_BY_DOTS: Record<string, string> = Object.fromEntries(BRAILLE_ENTRIES.map(e => [e.dots.join(','), e.unicode]))`,
      '',
    ]
    writeFileSync(GENERATED_TMP, lines.join('\n'), 'utf8')
    renameSync(GENERATED_TMP, GENERATED_FILE)
    ok(`已生成运行时模块 src/data/braille-data.ts（原子替换，无旧文件残留）`)
    return null
  },
})

// [3] 示例数据校验
let samples = null
steps.push({
  name: '示例数据校验',
  run() {
    const reasons = []
    if (!existsSync(SAMPLES_DIR)) {
      return { reasons: ['示例数据目录 data/samples/ 不存在'], fix: '创建 data/samples/ 并放入至少一个 *.json 示例（字段：name / input / expect.dots / expect.unicode）' }
    }
    const files = readdirSync(SAMPLES_DIR).filter(f => f.endsWith('.json')).sort()
    if (files.length === 0) {
      return { reasons: ['data/samples/ 中没有任何 *.json 示例数据（示例数据只存在本地/缺失时，构建无法自证）'], fix: '补充示例文件，字段：name、input、expect.dots、expect.unicode；期望值必须与基线一致' }
    }
    const byChar = new Map(baseline.entries.map(e => [e.char, e]))
    samples = []
    for (const f of files) {
      const path = join(SAMPLES_DIR, f)
      let s
      try { s = readJson(path) } catch (e) { reasons.push(`${f}：不是合法 JSON（${e.message}）`); continue }
      const tag = `示例 ${f}`
      if (typeof s.name !== 'string' || !s.name.trim()) reasons.push(`${tag}：缺少字符串字段 name`)
      if (typeof s.input !== 'string' || s.input.length === 0) { reasons.push(`${tag}：缺少非空字符串字段 input`); continue }
      const chars = Array.from(s.input.toUpperCase())
      const unsupported = chars.filter(ch => !byChar.has(ch))
      if (unsupported.length) { reasons.push(`${tag}：输入 ${JSON.stringify(s.input)} 含基线不支持的字符 ${[...new Set(unsupported)].map(x => JSON.stringify(x)).join('、')}`); continue }
      const wantDots = chars.map(ch => byChar.get(ch).dots)
      const wantUnicode = chars.map(ch => byChar.get(ch).unicode).join('')

      if (!s.expect || typeof s.expect !== 'object') { reasons.push(`${tag}：缺少 expect 对象（需含 dots 与 unicode）`); continue }
      if (!Array.isArray(s.expect.dots)) reasons.push(`${tag}：expect.dots 必须是数组`)
      else if (s.expect.dots.length !== chars.length) reasons.push(`${tag}：expect.dots 长度 ${s.expect.dots.length} 与输入字符数 ${chars.length} 不符`)
      else {
        for (let i = 0; i < chars.length; i++) {
          const got = Array.isArray(s.expect.dots[i]) ? s.expect.dots[i] : null
          if (!got) { reasons.push(`${tag}：expect.dots[${i}]（对应字符 ${JSON.stringify(chars[i])}）必须是数组`); continue }
          const bad = got.filter(d => !Number.isInteger(d) || d < 1 || d > 6)
          if (bad.length) { reasons.push(`${tag}：expect.dots[${i}] 含非法点位 ${bad.join(',')}（只允许 1-6 整数）`); continue }
          const g = [...got].sort((a, b) => a - b).join(',')
          const w = wantDots[i].join(',')
          if (g !== w) reasons.push(`${tag}：字符 ${JSON.stringify(chars[i])} 的期望点位 [${g}] 与基线 [${w}] 不一致（取值不合法）`)
        }
      }
      if (typeof s.expect.unicode !== 'string') reasons.push(`${tag}：expect.unicode 必须是字符串`)
      else {
        const gotCP = Array.from(s.expect.unicode)
        if (gotCP.length !== chars.length) reasons.push(`${tag}：expect.unicode 字符数 ${gotCP.length} 与输入字符数 ${chars.length} 不符`)
        else if (s.expect.unicode !== wantUnicode) reasons.push(`${tag}：expect.unicode 期望 ${JSON.stringify(s.expect.unicode)}，按基线应为 ${JSON.stringify(wantUnicode)}（取值不合法）`)
      }
      if (!reasons.some(r => r.startsWith(tag))) { ok(`${f}（${s.name}）：${chars.length} 个字符的点位与 Unicode 均与基线一致`); samples.push({ file: f, name: s.name, unicode: wantUnicode }) }
    }
    if (reasons.length) return { reasons, fix: '按上述原因修正/补齐 data/samples/ 下的示例后重跑；示例期望值必须能在基线中推出' }
    return null
  },
})

// [4] 类型检查
steps.push({
  name: '类型检查',
  only: 'build',
  run() {
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit', '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'inherit' })
    if (r.error) return { reasons: [`无法启动 vue-tsc：${r.error.message}`], fix: '执行 npm install 后重跑' }
    if (r.status !== 0) return { reasons: ['vue-tsc 报告了类型错误（见上方原始输出）'], fix: '按 vue-tsc 输出修正类型后重跑' }
    return null
  },
})

// [5] 构建（先清空 dist，杜绝上次产物残留）
steps.push({
  name: '构建',
  only: 'build',
  run() {
    rmSync(join(GENERATED_DIR, '.braille-data.ts.tmp'), { force: true })
    rmSync(DIST_DIR, { recursive: true, force: true })
    info('已清空 dist/，本次构建不携带任何上次产物')
    const r = spawnSync(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: ROOT, stdio: 'inherit' })
    if (r.error) return { reasons: [`无法启动 vite：${r.error.message}`], fix: '执行 npm install 后重跑' }
    if (r.status !== 0) return { reasons: ['vite build 退出码非 0（见上方原始输出）'], fix: '按 vite 输出修正构建错误后重跑；dist/ 已在构建前清空，不会残留旧产物' }
    if (!existsSync(join(DIST_DIR, 'index.html'))) return { reasons: ['构建成功但 dist/index.html 不存在'] }
    return null
  },
})

// [6] 构建产物中的字符数据指纹校验
steps.push({
  name: '构建产物数据校验',
  only: 'build',
  run() {
    const reasons = []
    const htmlPath = join(DIST_DIR, 'index.html')
    if (!existsSync(htmlPath)) return { reasons: ['dist/index.html 不存在：上一步构建未产出文件，无法校验产物数据（请先解决构建步骤的问题）'] }
    const html = readFileSync(htmlPath, 'utf8')
    const assetsDir = join(DIST_DIR, 'assets')
    if (!existsSync(assetsDir)) return { reasons: ['dist/assets/ 不存在，构建未产出 JS/CSS 资源'] }
    const jsFiles = readdirSync(assetsDir).filter(f => f.endsWith('.js'))
    if (!jsFiles.length) return { reasons: ['dist/assets/ 中没有任何 .js 文件'] }
    const bundle = jsFiles.map(f => readFileSync(join(assetsDir, f), 'utf8')).join('\n')
    ok(`产物包含 ${jsFiles.length} 个 JS 资源，共 ${(bundle.length / 1024).toFixed(1)} KiB`)

    // (a) 基线指纹必须原样出现在产物里 —— 证明产物带着最新基线数据，而不是开发机上看到的旧版本
    if (!bundle.includes(baseline.hash)) {
      reasons.push(`产物中找不到基线指纹 sha256:${baseline.hash}（期望来自基线 v${baseline.version}，${baseline.entries.length} 字符）。说明打包使用的不是最新基线数据（src/data/braille-data.ts 未重新生成，或该模块未被纳入打包）`)
    } else {
      ok(`产物内嵌基线指纹 sha256:${baseline.hash.slice(0, 16)}…，与本次基线一致`)
    }

    // (b) 基线中每个字符的 Unicode 字形都必须真实进入产物（兼容压缩器转义 \uXXXX 的情况）
    const escapeForBundle = s =>
      Array.from(s)
        .map(ch => {
          const cp = ch.codePointAt(0)
          if (cp <= 0x7e) return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          return '\\u' + cp.toString(16).padStart(4, '0')
        })
        .join('')
    const bundleHas = s => bundle.includes(s) || bundle.includes(escapeForBundle(s))
    const missingChars = baseline.entries.filter(e => e.char !== ' ' && !bundleHas(e.unicode)).map(e => JSON.stringify(e.char))
    if (missingChars.length) reasons.push(`产物缺少基线字符的 Unicode 字形：${missingChars.join('、')}`)
    else ok(`基线全部 ${baseline.entries.length - 1} 个非空字符的 Unicode 字形均已进入产物`)

    // (c) 每个示例期望的盲文字形必须能在产物中找到
    for (const s of samples) {
      const missing = Array.from(s.unicode).filter(ch => ch !== '⠀' && !bundleHas(ch))
      if (missing.length) reasons.push(`示例 ${s.file}（${s.name}）所需字形 ${missing.join('、')} 未进入构建产物`)
    }
    if (!reasons.some(r => r.startsWith('示例'))) ok(`${samples.length} 个示例所需盲文字形在产物中全部存在`)

    // (d) 入口 HTML 必须引用到 JS 资源
    if (!jsFiles.some(f => html.includes(f))) reasons.push('dist/index.html 未引用任何构建出的 JS 资源')

    if (reasons.length) return { reasons, fix: '确认 data/baseline 与 data/samples 为最新后重新执行 npm run build；流水线会重生成数据模块并清空 dist 后全量重建' }
    return null
  },
})

// ===========================================================================
// 编排执行
// ===========================================================================
const active = steps.filter(s => !s.only || (s.only === 'build' && mode === 'build'))
console.log(cyan('════════════════════════════════════════════'))
console.log(cyan(` 盲文数据流水线 · 模式: ${mode} · ${active.length} 个步骤`))
console.log(cyan('════════════════════════════════════════════'))

// 清理可能的上一次临时中间产物
if (existsSync(GENERATED_TMP)) { try { unlinkSync(GENERATED_TMP) } catch {} }

let failed = false
let stoppedAt = -1
active.forEach((step, i) => {
  const n = i + 1
  const total = active.length
  if (failed) {
    console.log(yellow(`⏭  [${n}/${total}] ${step.name} ${dim('— 跳过（前序步骤失败，其输入不可信）')}`))
    return
  }
  stepTitle(total, n, step.name)
  let result = null
  try {
    result = step.run()
  } catch (e) {
    result = { reasons: [`步骤内部异常：${e?.stack || e}`] }
  }
  if (result) {
    stepFail(total, n, step.name, result.reasons, result.fix)
    failed = true
    stoppedAt = n
  } else {
    stepPass(total, n, step.name, step.after || '')
  }
})

console.log(cyan('\n════════════════════════════════════════════'))
if (failed) {
  console.log(red(`流水线结束：卡在第 ${stoppedAt}/${active.length} 步「${active[stoppedAt - 1].name}」，后续步骤未执行。上面已标出缺什么、如何修复；修复后重新执行同一命令即可。`))
  process.exit(1)
}
console.log(green(`流水线全部 ${active.length} 步通过${mode === 'build' ? '，构建产物与基线/示例数据一致' : '，可以开始本地开发'}。`))
