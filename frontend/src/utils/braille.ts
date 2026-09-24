// 盲文编码运行时工具。字符数据来自由流水线依据基线生成的 ../data/braille-data.ts，
// 不要在本文件内硬编码字符映射，否则构建产物数据指纹校验会失败。
import { BRAILLE_MAP, BRAILLE_UNICODE_BY_DOTS } from '../data/braille-data'

export { BRAILLE_MAP, BASELINE_VERSION, BASELINE_HASH } from '../data/braille-data'

// Dot positions in 2x3 grid (col, row): 1=(0,0), 2=(0,1), 3=(0,2), 4=(1,0), 5=(1,1), 6=(1,2)
export const DOT_POSITIONS: Record<number, [number, number]> = {
  1: [0, 0], 2: [0, 1], 3: [0, 2],
  4: [1, 0], 5: [1, 1], 6: [1, 2],
}

export function textToBraille(text: string): number[][] {
  return text.toUpperCase().split('').map(c => BRAILLE_MAP[c] || [])
}

export function brailleToText(dots: number[]): string {
  const key = [...dots].sort((a, b) => a - b).join(',')
  for (const [char, d] of Object.entries(BRAILLE_MAP)) {
    if (d.join(',') === key) return char
  }
  return '?'
}

export function dotsToUnicode(dots: number[]): string {
  if (!dots.length) return '⠀'
  return BRAILLE_UNICODE_BY_DOTS[[...dots].sort((a, b) => a - b).join(',')] ?? '⠀'
}
