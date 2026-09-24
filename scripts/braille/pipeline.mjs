#!/usr/bin/env node
/**
 * 统一本地/构建流水线。
 *
 * 用法：
 *   node scripts/braille/pipeline.mjs                 # 跑完整流水线（fail-fast）
 *   node scripts/braille/pipeline.mjs check-deps      # 只跑某一步
 *   node scripts/braille/pipeline.mjs verify-build    # 只核验已有产物
 *   npm run verify                                    # 等价于完整流水线
 *
 * 步骤：
 *   1. check-deps    核对 node 版本与 frontend 依赖是否按 package.json 装好
 *   2. clean         删除旧的构建产物（不残留上一次的中间产物）
 *   3. sync-baseline 读取本地基线数据并做结构/取值校验
 *   4. verify-samples 校验示例数据是否存在、取值是否与基线一致
 *   5. typecheck     vue-tsc 类型检查
 *   6. build         vite build
 *   7. verify-build  核验构建产物里确实包含最新基线（指纹 + 全字符 Unicode）
 *
 * 任一步失败立即停止，日志中指出失败步骤、缺什么以及修复命令。
 */
import { rm, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadBaseline, validateSamples, run,
  stepHeader, ok, fail, info, warn, c, BASELINE_REL, SAMPLES_REL,
} from './lib/braille-data.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const frontendDir = path.join(repoRoot, 'frontend')
const distDir = path.join(frontendDir, 'dist')

const STEPS = ['check-deps', 'clean', 'sync-baseline', 'verify-samples', 'typecheck', 'build', 'verify-build']
const TITLES = {
  'check-deps': '核对依赖',
  'clean': '清理旧构建产物',
  'sync-baseline': '同步并校验基线字符数据',
  'verify-samples': '校验示例数据',
  'typecheck': 'TypeScript 类型检查',
  'build': '构建（vite build）',
  'verify-build': '核验构建产物包含最新基线',
}

const selected = process.argv.slice(2)
const toRun = selected.length ? selected : STEPS
const unknown = toRun.filter(s => !STEPS.includes(s))
if (unknown.length) {
  fail(`未知步骤：${unknown.join('、')}`)
  info(`可用步骤：${STEPS.join('、')}`)
  process.exit(2)
}

function reportFailure(step, reasons, fixHints = []) {
  fail(`步骤「${TITLES[step]}」未通过：`)
  for (const r of reasons) console.log(`         ${c.red('•')} ${r}`)
  for (const h of fixHints) console.log(`         ${c.gray('修复：')}${h}`)
}

/* ----------------------------- 各步骤实现 ----------------------------- */

async function stepCheckDeps() {
  const problems = []

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)
  if (nodeMajor < 18) problems.push(`Node 版本为 ${process.versions.node}，本流程需要 Node >= 18（建议使用 Node 20）`)
  else info(`Node ${process.versions.node}`)

  const pkgPath = path.join(frontendDir, 'package.json')
  if (!existsSync(pkgPath)) {
    reportFailure('check-deps', [`找不到 ${path.relative(repoRoot, pkgPath)}`])
    return false
  }
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const wanted = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }

  if (!existsSync(path.join(frontendDir, 'node_modules'))) {
    reportFailure('check-deps', ['frontend/node_modules 不存在，依赖尚未安装'], [
      'npm run setup   （会在 frontend/ 下执行 npm install）',
    ])
    return false
  }

  const missing = []
  const wrong = []
  for (const [name, range] of Object.entries(wanted)) {
    const pj = path.join(frontendDir, 'node_modules', name, 'package.json')
    if (!existsSync(pj)) {
      missing.push(`${name}@${range}`)
      continue
    }
    let installed
    try {
      installed = JSON.parse(await readFile(pj, 'utf8')).version
    } catch {
      missing.push(`${name}@${range}`)
      continue
    }
    // 只核对主版本是否落在声明范围内（^/~/x），避免锁文件被忽略后装上不兼容的新大版本
    const wantedMajor = range.match(/(\d+)\.\d+\.\d+/)?.[1]
    const installedMajor = installed.split('.')[0]
    if (wantedMajor && range.startsWith('^') && installedMajor !== wantedMajor) {
      wrong.push(`${name}: package.json 要求 ${range}，实际安装 ${installed}`)
    }
  }

  if (missing.length) problems.push(`依赖缺失：${missing.join('、')}`)
  if (wrong.length) problems.push(`已安装版本与 package.json 声明的主版本不一致：\n${wrong.map(w => '           - ' + w).join('\n')}`)

  if (problems.length) {
    reportFailure('check-deps', problems, [
      'npm run setup   （在 frontend/ 下重新安装 package.json 声明的依赖）',
    ])
    return false
  }

  // 锁文件在本仓库 .gitignore 中被忽略，不阻断流程，只提示可复现性风险
  const hasLock = existsSync(path.join(frontendDir, 'package-lock.json'))
  ok(`依赖已按 package.json 安装（${Object.keys(wanted).length} 个包全部就位）`)
  if (!hasLock) warn('frontend/package-lock.json 未提交（仓库的 .gitignore 忽略了锁文件），不同机器可能解析到不同补丁版本')
  else info('package-lock.json 存在')
  return true
}

async function stepClean() {
  if (existsSync(distDir)) {
    await rm(distDir, { recursive: true, force: true })
    info(`已删除旧产物 ${path.relative(repoRoot, distDir)}/`)
  } else {
    info('无旧产物需要清理')
  }
  ok('构建目录干净，不会混入上一次的中间产物')
  return true
}

async function stepSyncBaseline() {
  const { baseline, index, fingerprint, errors } = loadBaseline(repoRoot)
  if (errors.length) {
    reportFailure('sync-baseline', errors, [
      `修正 ${BASELINE_REL} 后重新执行 npm run verify`,
    ])
    return { ok: false }
  }
  ok(`基线数据有效：${baseline.characters.length} 个字符（A-Z、0-9、空格），版本 v${baseline.version}`)
  info(`基线文件：${BASELINE_REL}（本地保存，开发与构建共用）`)
  info(`数据指纹：${fingerprint}`)
  return { ok: true, baseline, fingerprint, index }
}

async function stepVerifySamples(index) {
  const { samples, errors } = validateSamples(repoRoot, index)
  if (errors.length) {
    reportFailure('verify-samples', errors, [
      `修正 ${SAMPLES_REL} 中指出的条目（缺失字段/取值不合法/与基线不一致）后重跑 npm run verify`,
      `若基线确实变了，请按 ${BASELINE_REL} 的点阵与 Unicode 更新示例期望值`,
    ])
    return false
  }
  ok(`示例数据有效：${samples.length} 条，全部由基线字符组成且期望值与基线一致`)
  info(`示例文件：${SAMPLES_REL}`)
  return true
}

async function stepTypecheck() {
  const r = await run('npm', ['run', 'typecheck'], { cwd: frontendDir })
  if (r.code !== 0) {
    reportFailure('typecheck', ['vue-tsc 发现类型错误（见上方输出）'], [
      '修复类型错误后重跑 npm run verify',
    ])
    return false
  }
  ok('vue-tsc 类型检查通过')
  return true
}

async function stepBuild(fingerprint) {
  const r = await run('npm', ['run', 'build:vite'], {
    cwd: frontendDir,
    env: { BRAILLE_DATA_FINGERPRINT: fingerprint },
  })
  if (r.code !== 0) {
    reportFailure('build', ['vite build 失败（见上方输出）'], [
      '修复构建错误后重跑 npm run verify；旧产物会在下次运行开始时自动清理',
    ])
    return false
  }
  ok(`vite build 完成，产物输出到 frontend/dist/（注入数据指纹 ${fingerprint}）`)
  return true
}

async function listJsAssets(dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await listJsAssets(full)))
    else if (/\.(js|html)$/.test(entry.name)) out.push(full)
  }
  return out
}

async function stepVerifyBuild(baseline, expectedFingerprint) {
  if (!existsSync(distDir)) {
    reportFailure('verify-build', [`构建产物目录 ${path.relative(repoRoot, distDir)}/ 不存在，请先执行 build 步骤`])
    return false
  }
  const assets = await listJsAssets(distDir)
  const blobs = await Promise.all(assets.map(f => readFile(f, 'utf8')))
  const bundle = blobs.join('\n')

  const problems = []
  if (!bundle.includes(expectedFingerprint)) {
    problems.push(`产物中找不到当前基线指纹 ${expectedFingerprint}，构建用的数据不是本地最新基线`)
  }
  // 37 个字符的 Unicode 盲文字符必须全部能在产物中找到
  const missingChars = baseline.characters
    .filter(e => !bundle.includes(e.unicode))
    .map(e => JSON.stringify(e.char) === '" "' ? "' '(空格)" : e.char)
  if (missingChars.length) {
    problems.push(`产物中缺少以下基线字符的盲文 Unicode：${[...new Set(missingChars)].join('、')}`)
  }
  if (!existsSync(path.join(distDir, 'index.html'))) {
    problems.push('产物缺少 index.html')
  }

  if (problems.length) {
    reportFailure('verify-build', problems, [
      '确认 src 代码确实从基线数据导入字符映射，然后重跑 npm run verify（会先清理旧产物）',
    ])
    return false
  }
  ok(`产物核验通过：指纹 ${expectedFingerprint} 已注入，${baseline.characters.length} 个基线字符的盲文 Unicode 全部在产物中`)
  info(`共扫描 ${assets.length} 个 js/html 产物文件`)
  return true
}

/* ------------------------------- 编排 ------------------------------- */

console.log(c.bold('盲文学习器 · 统一本地/构建流水线'))
info(`仓库根目录：${repoRoot}`)
info(`执行步骤：${toRun.join(' → ')}`)

const total = toRun.length
let result = { baseline: null, fingerprint: null }
let failed = null

for (let i = 0; i < toRun.length; i++) {
  const step = toRun[i]
  stepHeader(i + 1, total, TITLES[step])
  let passed
  switch (step) {
    case 'check-deps': passed = await stepCheckDeps(); break
    case 'clean': passed = await stepClean(); break
    case 'sync-baseline': {
      const r = await stepSyncBaseline()
      passed = r.ok
      if (passed) result = { baseline: r.baseline, fingerprint: r.fingerprint }
      break
    }
    case 'verify-samples': {
      if (!result.index) {
        // 单独跑 verify-samples 时，临时加载一次基线
        const loaded = loadBaseline(repoRoot)
        if (loaded.errors.length) {
          reportFailure('verify-samples', ['前置基线数据无效，请先通过 sync-baseline：', ...loaded.errors])
          passed = false
          break
        }
        result = { baseline: loaded.baseline, fingerprint: loaded.fingerprint, index: loaded.index }
      }
      passed = await stepVerifySamples(result.index)
      break
    }
    case 'typecheck': passed = await stepTypecheck(); break
    case 'build': {
      if (!result.fingerprint) {
        const loaded = loadBaseline(repoRoot)
        if (loaded.errors.length) {
          reportFailure('build', ['前置基线数据无效，请先通过 sync-baseline：', ...loaded.errors])
          passed = false
          break
        }
        result = { baseline: loaded.baseline, fingerprint: loaded.fingerprint }
      }
      passed = await stepBuild(result.fingerprint)
      break
    }
    case 'verify-build': {
      if (!result.fingerprint) {
        const loaded = loadBaseline(repoRoot)
        if (loaded.errors.length) {
          reportFailure('verify-build', ['前置基线数据无效，请先通过 sync-baseline：', ...loaded.errors])
          passed = false
          break
        }
        result = { baseline: loaded.baseline, fingerprint: loaded.fingerprint }
      }
      passed = await stepVerifyBuild(result.baseline, result.fingerprint)
      break
    }
  }
  if (!passed) {
    failed = step
    break
  }
}

console.log('')
if (failed) {
  console.log(c.red(c.bold(`流水线在「${TITLES[failed]}」终止，后续步骤未执行。修复后重新运行 npm run verify 即可，旧产物会自动清理。`)))
  process.exit(1)
}
console.log(c.green(c.bold(`全部 ${total} 步通过 ✓`)))
