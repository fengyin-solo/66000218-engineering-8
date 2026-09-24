// English Braille Grade 1
//
// 字符数据不再硬编码：统一从仓库根目录 data/braille-baseline.json 导入。
// dev server 与 vite build 通过 vite.config.ts 中的同一个插件读取这份基线，
// 构建产物里会注入基线指纹，由 scripts/braille/pipeline.mjs 核验。
import baselineJson from '@data/braille-baseline.json'

type BaselineChar = { char: string; dots: number[]; unicode: string }

const baselineChars: BaselineChar[] = baselineJson.characters

/** 字符 → 已排序的点阵编号（1-6） */
export const BRAILLE_MAP: Record<string, number[]> = Object.fromEntries(
  baselineChars.map(c => [c.char, [...c.dots].sort((a, b) => a - b)]),
)

/** 字符 → Unicode 盲文字符（以基线为准） */
export const BRAILLE_UNICODE_MAP: Record<string, string> = Object.fromEntries(
  baselineChars.map(c => [c.char, c.unicode]),
)

// Dot positions in 2x3 grid (col, row): 1=(0,0), 2=(0,1), 3=(0,2), 4=(1,0), 5=(1,1), 6=(1,2)
export const DOT_POSITIONS: Record<number, [number, number]> = {
  1: [0, 0], 2: [0, 1], 3: [0, 2],
  4: [1, 0], 5: [1, 1], 6: [1, 2],
}

export function textToBraille(text: string): number[][] {
  return text.toUpperCase().split('').map(c => BRAILLE_MAP[c] || [])
}

export function brailleToText(dots: number[]): string {
  // 注意：不能对入参 dots 调 .sort()（会原地修改调用方数组），先拷贝再比较
  const key = JSON.stringify([...dots].sort((a, b) => a - b))
  for (const [char, d] of Object.entries(BRAILLE_MAP)) {
    if (JSON.stringify([...d].sort((a, b) => a - b)) === key) return char
  }
  return '?'
}

export function dotsToUnicode(dots: number[]): string {
  // 以基线 Unicode 为准：完全匹配某个基线字符时直接返回，保证与基线逐位一致
  const key = JSON.stringify([...dots].sort((a, b) => a - b))
  for (const c of baselineChars) {
    if (JSON.stringify([...c.dots].sort((a, b) => a - b)) === key) return c.unicode
  }
  // 兜底：理论上不会走到（所有合法点阵都在基线里），保留位运算实现
  if (!dots.length) return '⠀'
  let code = 0x2800
  for (const d of dots) code += Math.pow(2, d - 1)
  return String.fromCodePoint(code)
}
