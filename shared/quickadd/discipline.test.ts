/**
 * 静态纪律（ADR-014 §8）——**扫源码而非靠人眼**。
 *
 * ADR-014 §后果 的测试矩阵里这一行写着：「⚠️ 这条要真的生效，必须先扩
 * `events-discipline.test.ts` 的扫描根——它现在只扫 `server/`，结构上到不了 `shared/`。
 * **在扫描扩根之前，本行是人工纪律，不是静态纪律**」。
 *
 * 本文件是那句警告的落地：把同一套手法**就地**用在 `shared/quickadd/` 上，
 * 于是这一行在扩根之前也是真的（扩根之后两条并存，不冲突）。
 *
 * **必须先 `stripComments`**：本模块的文档注释里会**逐字引用**「不得 `new Date()`」
 * 这条纪律（见 `lexicon.ts` 的文件头），不去注释会扫到自己。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 参与扫描的**模块**源文件。`*.test.ts` 与 `testing.ts` 是测试夹具，不上生产路径 */
const SOURCES = ['index.ts', 'types.ts', 'lexicon.ts', 'scan.ts', 'resolve.ts'] as const

/**
 * 去注释。
 *
 * 已知边界：也会去掉字符串字面量里的 `//` 之后的内容。本模块的源码里没有这种串
 * （`index.ts` 的注释里出现过路径，但那是注释），若将来有人写了一个含 `//` 的字符串常量，
 * 本函数会把它的尾部吃掉——**后果是漏检而不是误报**，故可以接受。
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

function readSource(file: string): string {
  return stripComments(readFileSync(join(HERE, file), 'utf8'))
}

/**
 * 白名单的**唯一一处例外**（具名、限定到文件，且由下面一条用例钉住数量）。
 *
 * §8 写「运行时导入白名单 = `@shared/time`」，而 §7 又要求
 * 「`DEFAULT_NEXT_ANCHOR_MODE` **必须只有一处声明**（建议由 `shared/recurrence` 导出）」。
 * 两条在字面上冲突：要满足 §7 就只能从 `shared/recurrence` **运行时导入一个值**。
 * 主控 2026-09-22 把该常量落在 `shared/recurrence/types.ts` 并要求接入，
 * 故这里登记这处例外——它不引入任何日期折算，§8 那条白名单真正要防的东西
 * （第二套闰年判定、`new Date()` 折算）在这个导入里不存在。
 */
const RUNTIME_IMPORT_EXCEPTIONS: readonly (readonly [string, string])[] = [
  ['lexicon.ts', '@shared/recurrence/types'],
]

describe('运行时导入白名单 = `@shared/time`（类型导入不限）', () => {
  for (const file of SOURCES) {
    it(`${file}：相对导入之外的运行时导入只有 \`@shared/time\``, () => {
      const source = readSource(file)
      const pattern = /(?:^|\n)[ \t]*(import|export)[ \t]+(type[ \t]+)?([^;\n]*?)from[ \t]*'([^']+)'/g
      const offenders: string[] = []
      for (const matched of source.matchAll(pattern)) {
        const isTypeOnly = matched[2] !== undefined
        const specifier = matched[4] ?? ''
        if (specifier.startsWith('.')) continue // 模块内部文件
        if (isTypeOnly) continue // 类型导入不限（§1 的注）
        if (specifier === '@shared/time') continue
        if (RUNTIME_IMPORT_EXCEPTIONS.some(([allowedFile, allowed]) => allowedFile === file && allowed === specifier)) {
          continue
        }
        offenders.push(specifier)
      }
      expect(offenders).toEqual([])
    })
  }

  it('例外清单只有一条，且就是 §7 那一处（防止它悄悄长大）', () => {
    expect(RUNTIME_IMPORT_EXCEPTIONS).toEqual([['lexicon.ts', '@shared/recurrence/types']])
  })

  it('确实抓得到违规（对样例文本自检，避免规则写成永不触发）', () => {
    const sample = "import { hitSequence } from '@shared/recurrence'\n"
    const pattern = /(?:^|\n)[ \t]*(import|export)[ \t]+(type[ \t]+)?([^;\n]*?)from[ \t]*'([^']+)'/g
    const specs = [...sample.matchAll(pattern)].map((m) => m[4])
    expect(specs).toEqual(['@shared/recurrence'])
  })
})

describe('日期折算的唯一出处（§8）', () => {
  const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
    ['`new Date(`（瞬间的构造不得出现在本模块）', /\bnew\s+Date\s*\(/],
    ['`getUTCDay`（JS 的 0 = 周日不得进入本模块的任何值）', /\bgetUTCDay\b/],
    ['`toISOString`（UTC 序列化切片当日本地日）', /\btoISOString\b/],
    ['自写闰年判定 `% 4`', /%[ \t]*4\b/],
    ['自写闰年判定 `% 100`', /%[ \t]*100\b/],
    ['自写闰年判定 `% 400`', /%[ \t]*400\b/],
  ]

  for (const file of SOURCES) {
    for (const [label, regex] of FORBIDDEN) {
      it(`${file}：不出现 ${label}`, () => {
        expect(readSource(file)).not.toMatch(regex)
      })
    }
  }

  it('本模块只从 `@shared/time` 取日期原语（`lexicon.ts` 的 import 清单可核对）', () => {
    const source = readSource('lexicon.ts')
    const matched = /import\s*\{([^}]*)\}\s*from\s*'@shared\/time'/.exec(source)
    expect(matched).not.toBeNull()
    const names = (matched?.[1] ?? '').split(',').map((name) => name.trim()).filter((name) => name.length > 0)
    expect(names).toEqual([
      'addDays',
      'addMonths',
      'compareDayKey',
      'daysInMonthOf',
      'diffDays',
      'makeDayKey',
      'parseDayKey',
      'weekStart',
    ])
  })
})
