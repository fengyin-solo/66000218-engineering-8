/**
 * 本地开发与构建共用的盲文数据内核。
 *
 * 不依赖任何第三方包，可被：
 *   - scripts/braille/pipeline.mjs（统一流水线，node 直接运行）
 *   - frontend/vite.config.ts（dev server 与 vite build 共用的数据插件）
 * 同时引用，保证“开发时看到的数据”与“构建进产物的数据”是同一份基线。
 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

export const BASELINE_REL = 'data/braille-baseline.json'
export const SAMPLES_REL = 'data/samples.json'

const ALLOWED_CHARS = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ',
])

/** 把点阵编号（1-6）转成 Unicode 盲文字符（0x2800 + 位掩码）。 */
export function dotsToUnicode(dots) {
  let code = 0x2800
  for (const d of dots) code += 2 ** (d - 1)
  return String.fromCodePoint(code)
}

function loadJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

/**
 * 读取并校验基线数据。
 * @returns {{baseline: object, index: Map<string, number[]>, fingerprint: string, errors: string[]}}
 */
export function loadBaseline(repoRoot) {
  const file = `${repoRoot}/${BASELINE_REL}`
  const errors = []
  let raw
  try {
    raw = loadJson(file)
  } catch (e) {
    return {
      baseline: null,
      index: new Map(),
      fingerprint: null,
      errors: [`无法读取基线文件 ${BASELINE_REL}：${e.message}（请确认基线数据已保存在本地仓库中）`],
    }
  }

  const chars = raw?.characters
  if (!Array.isArray(chars)) {
    errors.push('基线数据缺少 characters 数组字段')
    return { baseline: raw, index: new Map(), fingerprint: null, errors }
  }
  if (!Number.isInteger(raw.version)) errors.push('基线数据缺少整数类型的 version 字段')

  const index = new Map()
  const seenPattern = new Map()
  for (let i = 0; i < chars.length; i++) {
    const entry = chars[i]
    const where = `characters[${i}]`
    if (!entry || typeof entry !== 'object') {
      errors.push(`${where} 不是对象`)
      continue
    }
    const { char, dots, unicode } = entry
    if (typeof char !== 'string' || char.length !== 1) {
      errors.push(`${where} 的 char 必须是单字符字符串，实际为 ${JSON.stringify(char)}`)
      continue
    }
    if (!ALLOWED_CHARS.has(char)) {
      errors.push(`${where} 字符 ${JSON.stringify(char)} 不在基线允许范围（A-Z、0-9、空格）内`)
      continue
    }
    if (!Array.isArray(dots) || dots.some(d => !Number.isInteger(d) || d < 1 || d > 6)) {
      errors.push(`${where}（字符 ${JSON.stringify(char)}）的 dots 必须是 1-6 的整数数组，实际为 ${JSON.stringify(dots)}`)
      continue
    }
    const unique = [...new Set(dots)]
    if (unique.length !== dots.length) {
      errors.push(`${where}（字符 ${JSON.stringify(char)}）的 dots 存在重复点号：${JSON.stringify(dots)}`)
    }
    const sorted = [...dots].sort((a, b) => a - b)
    if (typeof unicode !== 'string' || [...unicode].length !== 1) {
      errors.push(`${where}（字符 ${JSON.stringify(char)}）的 unicode 必须是单个 Unicode 字符，实际为 ${JSON.stringify(unicode)}`)
    } else if (unicode !== dotsToUnicode(sorted)) {
      errors.push(
        `${where}（字符 ${JSON.stringify(char)}）的 unicode ${unicode}（U+${unicode.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}）`
        + `与点阵 [${sorted.join(',')}] 应有的 ${dotsToUnicode(sorted)} 不一致`,
      )
    }
    if (index.has(char)) errors.push(`字符 ${JSON.stringify(char)} 在基线中重复定义`)
    index.set(char, sorted)

    const patternKey = sorted.join(',')
    if (seenPattern.has(patternKey)) {
      const prev = seenPattern.get(patternKey)
      // 字母与数字同形是 Braille Grade 1 的正常现象（数字靠数字号区分），仅在同类内重复才算错误
      if (/[A-Z]/.test(prev) && /[A-Z]/.test(char)) {
        errors.push(`字母 ${prev} 与 ${char} 的点阵重复（[${patternKey}]），字母之间不允许同形`)
      } else if (/[0-9]/.test(prev) && /[0-9]/.test(char)) {
        errors.push(`数字 ${prev} 与 ${char} 的点阵重复（[${patternKey}]），数字之间不允许同形`)
      }
    } else {
      seenPattern.set(patternKey, char)
    }
  }

  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (!index.has(ch)) errors.push(`基线缺少字母 ${ch}`)
  }
  for (const ch of '0123456789') {
    if (!index.has(ch)) errors.push(`基线缺少数字 ${ch}`)
  }
  if (!index.has(' ')) errors.push('基线缺少空格字符')

  return { baseline: raw, index, fingerprint: errors.length ? null : fingerprintOf(raw), errors }
}

/** 基线指纹：对规范化后的基线内容做 sha256，取前 12 位。只随数据内容变化。 */
export function fingerprintOf(baseline) {
  const canonical = JSON.stringify({
    version: baseline.version,
    characters: [...baseline.characters]
      .map(c => ({ char: c.char, dots: [...c.dots].sort((a, b) => a - b) }))
      .sort((a, b) => a.char.codePointAt(0) - b.char.codePointAt(0)),
  })
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 校验示例数据。
 * @returns {{samples: object[], errors: string[], warnings: string[]}}
 */
export function validateSamples(repoRoot, index) {
  const file = `${repoRoot}/${SAMPLES_REL}`
  const errors = []
  let raw
  try {
    raw = loadJson(file)
  } catch (e) {
    return {
      samples: [],
      errors: [`无法读取示例数据 ${SAMPLES_REL}：${e.message}（示例数据缺失或不是合法 JSON）`],
      warnings: [],
    }
  }
  if (!Array.isArray(raw?.samples)) {
    return { samples: [], errors: [`${SAMPLES_REL} 缺少 samples 数组字段，或文件为空`], warnings: [] }
  }
  if (raw.samples.length === 0) {
    errors.push(`${SAMPLES_REL} 的 samples 为空，至少需要一条示例用于校验翻译结果`)
  }

  for (let i = 0; i < raw.samples.length; i++) {
    const s = raw.samples[i]
    const where = `samples[${i}]`
    if (!s || typeof s !== 'object') {
      errors.push(`${where} 不是对象`)
      continue
    }
    const { input, expectedDots, expectedUnicode } = s
    if (typeof input !== 'string' || input.length === 0) {
      errors.push(`${where} 缺少非空 input 字符串字段`)
      continue
    }

    const unknown = [...input].filter(c => !index.has(c))
    if (unknown.length) {
      errors.push(`${where} 输入 ${JSON.stringify(input)} 含基线中不存在的字符：${[...new Set(unknown)].map(c => JSON.stringify(c)).join('、')}`)
    }

    const wantDots = [...input].map(c => index.get(c) ?? [])
    if (!Array.isArray(expectedDots)) {
      errors.push(`${where}（input=${JSON.stringify(input)}）缺少 expectedDots 数组字段`)
    } else if (JSON.stringify(expectedDots) !== JSON.stringify(wantDots)) {
      errors.push(
        `${where}（input=${JSON.stringify(input)}）期望点阵与基线不符：`
        + `声明 ${JSON.stringify(expectedDots)}，按基线应为 ${JSON.stringify(wantDots)}`,
      )
    }

    const wantUnicode = [...input].map(c => dotsToUnicode(index.get(c) ?? [])).join('')
    if (typeof expectedUnicode !== 'string' || expectedUnicode.length === 0) {
      errors.push(`${where}（input=${JSON.stringify(input)}）缺少非空 expectedUnicode 字段`)
    } else if (expectedUnicode !== wantUnicode) {
      errors.push(
        `${where}（input=${JSON.stringify(input)}）期望 Unicode 与基线不符：`
        + `声明 ${JSON.stringify(expectedUnicode)}，按基线应为 ${JSON.stringify(wantUnicode)}`,
      )
    }
  }

  return { samples: raw.samples, errors, warnings: [] }
}

/* ----------------------- 终端输出与步骤执行 ----------------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
export const c = {
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  cyan: paint('36'),
  gray: paint('90'),
  bold: paint('1'),
}

/** 打印一个带编号的步骤标题。 */
export function stepHeader(n, total, title) {
  console.log(`\n${c.cyan(`[${n}/${total}] ${title}`)}`)
}

export function ok(msg) {
  console.log(`${c.green('✓ PASS')}  ${msg}`)
}
export function fail(msg) {
  console.log(`${c.red('✗ FAIL')}  ${msg}`)
}
export function info(msg) {
  console.log(`${c.gray('       ')}${msg}`)
}
export function warn(msg) {
  console.log(`${c.yellow('! WARN')}  ${msg}`)
}

/**
 * 执行一个外部命令并实时透传输出；返回 { code, stdout, stderr }。
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? process.cwd(),
      stdio: opts.silent ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      shell: process.platform === 'win32',
      env: { ...process.env, ...(opts.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (d) => { stdout += d })
    child.stderr?.on('data', (d) => { stderr += d })
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: stderr + e.message }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}
