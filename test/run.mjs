/**
 * 纯函数自测：限额执行、量测、净化。
 *
 *   node test/run.mjs        （或用工作区内置 node 直接跑这个文件）
 *
 * 只测不依赖 cordis 的那一半：观测/裁剪是被测主体，HTTP 与插槽那半边只能
 * 在真机上验（README 的“验证”一节写了怎么抓）。
 */
import assert from 'node:assert/strict'
import { __internal, measureAssembly, enforceLimits, estimateTokens } from '../lib/host.js'

const { sanitizeSubmittedLimits, sanitizeSectionCaps, capFor, cutText, positiveOrNull, validateRequest, classifyItem } = __internal

let passed = 0
const failures = []

/** 一个断言 = 一个用例。 */
function it(name, body) {
  try {
    body()
    passed += 1
    process.stdout.write(`  ok  ${name}\n`)
  } catch (error) {
    failures.push({ name, error })
    process.stdout.write(`  FAIL ${name}\n        ${error && error.message}\n`)
  }
}

/** 造一份样本组装结果。 */
function fixture() {
  return {
    sections: [
      { name: 'A', text: 'x'.repeat(1000) },
      { name: 'B', text: '中'.repeat(600) },
      { name: 'C', text: 'y'.repeat(100) },
    ],
    contexts: [{ name: 'ctx1', text: 'z'.repeat(500) }],
    tools: [{ name: 't1', description: 'd', parameters: { type: 'object' } }],
    variables: { a: '1', b: '2' },
  }
}

const toolChars = JSON.stringify(fixture().tools[0]).length

process.stdout.write('measureAssembly\n')

it('总计 = 段落 + 上下文 + 工具 schema', () => {
  const m = measureAssembly(fixture())
  assert.equal(m.sectionChars, 1700)
  assert.equal(m.contextChars, 500)
  assert.equal(m.toolChars, toolChars)
  assert.equal(m.totalChars, 1700 + 500 + toolChars)
  assert.equal(m.variables, 2)
  assert.equal(m.tools.count, 1)
})

it('token 用启发式估算（ASCII/4 + 非 ASCII/1.5）', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('x'.repeat(1000)), 250)
  assert.equal(estimateTokens('中'.repeat(600)), 400)
  const m = measureAssembly(fixture())
  assert.equal(m.sections[0].estTokens, 250)
  assert.equal(m.sections[1].estTokens, 400)
})

it('非字符串/空输入不产生 NaN', () => {
  const m = measureAssembly({ sections: [{ name: 'x' }, null], contexts: undefined, tools: 'nope' })
  assert.equal(m.totalChars, 0)
  assert.equal(m.estTokens, 0)
  assert.equal(m.sections.length, 2)
  assert.equal(m.tools.count, 0)
  assert.equal(measureAssembly(null).totalChars, 0)
})

process.stdout.write('enforceLimits · warn（默认：只记账不改写）\n')

it('warn 模式零改写：返回同一个引用 + 记下越限', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'warn', totalChars: null, sections: { A: 100 } })
  assert.equal(out.changed, false)
  assert.equal(out.assembly, assembly)
  assert.equal(out.notes.length, 1)
  assert.deepEqual(
    { scope: out.notes[0].scope, name: out.notes[0].name, chars: out.notes[0].chars, limit: out.notes[0].limit, action: out.notes[0].action },
    { scope: 'item', name: 'A', chars: 1000, limit: 100, action: 'warn' },
  )
})

it('逐项上限同样管运行时上下文（记忆/索引也可能是 context）', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'truncate', totalChars: null, sections: { ctx1: 120 } })
  assert.equal(out.notes[0].scope, 'item')
  assert.equal(out.notes[0].name, 'ctx1')
  assert.ok(out.assembly.contexts[0].text.length <= 120)
  assert.match(out.assembly.contexts[0].text, /dsh-prompt-limiter/)
  assert.equal(out.assembly.sections, assembly.sections, '没被点名的段落不该动')
})

it('总上限在 warn 下也只记不动', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'warn', totalChars: 100, sections: {} })
  assert.equal(out.changed, false)
  assert.equal(out.notes[0].scope, 'total')
  assert.equal(out.notes[0].limit, 100)
})

it('没越限就不产生任何记录', () => {
  const out = enforceLimits(fixture(), { action: 'truncate', totalChars: 999999, sections: { A: 5000 } })
  assert.equal(out.changed, false)
  assert.deepEqual(out.notes, [])
})

process.stdout.write('enforceLimits · 逐段上限\n')

it('truncate：超限段落截到上限以内并带标记，其它段原样', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'truncate', totalChars: null, sections: { A: 300 } })
  assert.equal(out.changed, true)
  assert.ok(out.assembly.sections[0].text.length <= 300, `实际 ${out.assembly.sections[0].text.length}`)
  assert.match(out.assembly.sections[0].text, /dsh-prompt-limiter/)
  assert.equal(out.assembly.sections[1], assembly.sections[1])
  assert.equal(out.assembly.sections[2], assembly.sections[2])
  assert.equal(out.assembly.contexts, assembly.contexts)
})

it('上限小到装不下标记时，结果不超过上限（只截断、不加标记）', () => {
  const out = enforceLimits(fixture(), { action: 'truncate', totalChars: null, sections: { A: 20 } })
  assert.equal(out.assembly.sections[0].text.length, 20)
  assert.doesNotMatch(out.assembly.sections[0].text, /dsh-prompt-limiter/)
})

it('drop：整段移除，顺序不变', () => {
  const out = enforceLimits(fixture(), { action: 'drop', totalChars: null, sections: { B: 100 } })
  assert.deepEqual(out.assembly.sections.map((s) => s.name), ['A', 'C'])
})

it('兜底键 * 命中未点名段落，精确名优先', () => {
  const caps = { '*': 100, B: 700 }
  assert.equal(capFor(caps, 'A'), 100)
  assert.equal(capFor(caps, 'B'), 700)
  assert.equal(capFor(caps, 'C'), 100)
  assert.equal(capFor({}, 'A'), null)
  const out = enforceLimits(fixture(), { action: 'drop', totalChars: null, sections: caps })
  // A 只被 * 兜住（1000 > 100）→ 丢；B 有精确上限 700 且未超 → 留；
  // C 恰好等于 * = 100（未超）→ 留。精确名优先于兜底键，就在这里。
  assert.deepEqual(out.assembly.sections.map((s) => s.name), ['B', 'C'])
})

process.stdout.write('enforceLimits · 总上限（预算走一遍）\n')

it('第一个装不下的截断，排在它后面的整段丢弃', () => {
  const assembly = fixture()
  const cap = toolChars + 400
  const out = enforceLimits(assembly, { action: 'truncate', totalChars: cap, sections: {} })
  assert.equal(out.changed, true)
  assert.deepEqual(out.assembly.sections.map((s) => s.name), ['A'])
  assert.deepEqual(out.assembly.contexts, [])
  const total = out.assembly.sections.reduce((n, s) => n + s.text.length, 0) + toolChars
  assert.ok(total <= cap, `实际 ${total} > ${cap}`)
  assert.deepEqual(out.notes[0].dropped, ['B', 'C', 'ctx1'])
  assert.equal(out.notes[0].truncated[0].name, 'A')
})

it('drop 模式下总上限：只丢不截（装得下的整段留）', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'drop', totalChars: toolChars + 1700, sections: {} })
  assert.deepEqual(out.assembly.sections.map((s) => s.name), ['A', 'B', 'C'])
  assert.deepEqual(out.assembly.contexts, [])
  assert.deepEqual(out.notes[0].dropped, ['ctx1'])
})

it('剩余预算太小就整段丢，不产生残段', () => {
  const out = enforceLimits(fixture(), { action: 'truncate', totalChars: toolChars + 50, sections: {} })
  assert.deepEqual(out.assembly.sections, [])
  assert.deepEqual(out.assembly.contexts, [])
})

it('光工具 schema 就超限：如实标注、不动文本', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'truncate', totalChars: 10, sections: {} })
  assert.equal(out.changed, false)
  assert.equal(out.notes[0].unactionable, 'tools')
})

it('工具 schema 永不裁剪（预算再紧也只动文本侧）', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'truncate', totalChars: toolChars + 100, sections: {} })
  assert.deepEqual(out.assembly.tools, assembly.tools)
  assert.deepEqual(out.assembly.sections, [])
  assert.deepEqual(out.assembly.contexts, [])
  assert.deepEqual(out.notes[0].dropped, ['A', 'B', 'C', 'ctx1'])
})

it('预算恰好被工具吃光：标注不可处置，不改写', () => {
  const assembly = fixture()
  const out = enforceLimits(assembly, { action: 'drop', totalChars: toolChars, sections: {} })
  assert.equal(out.changed, false)
  assert.equal(out.assembly, assembly)
  assert.equal(out.notes[0].unactionable, 'tools')
})

process.stdout.write('净化与边界\n')

it('只接受正整数上限', () => {
  assert.equal(positiveOrNull(100), 100)
  assert.equal(positiveOrNull(100.7), 100)
  assert.equal(positiveOrNull(0), null)
  assert.equal(positiveOrNull(-5), null)
  assert.equal(positiveOrNull('abc'), null)
  assert.equal(positiveOrNull(undefined), null)
  assert.equal(positiveOrNull(null), null)
})

it('段落上限表被净化成 非空名 → 正整数（向下取整）', () => {
  assert.deepEqual(sanitizeSectionCaps({ A: 10, '  ': 5, B: 'x', C: -1, D: 2.9 }), { A: 10, D: 2 })
  assert.deepEqual(sanitizeSectionCaps(null), {})
  assert.deepEqual(sanitizeSectionCaps(['A']), {})
})

it('非法提交一律拒绝（null），合法但为空照样接受', () => {
  assert.equal(sanitizeSubmittedLimits('nope'), null)
  assert.equal(sanitizeSubmittedLimits({ action: 'nuke' }), null)
  assert.equal(sanitizeSubmittedLimits({ sections: [] }), null)
  assert.deepEqual(sanitizeSubmittedLimits({ action: 'drop', totalChars: -1, sections: { A: 'x' } }),
    { action: 'drop', totalChars: null, sections: {} })
  assert.deepEqual(sanitizeSubmittedLimits({}), { action: 'warn', totalChars: null, sections: {} })
})

it('cutText 结果长度永不超上限', () => {
  assert.equal(cutText('abcdef', 10), 'abcdef')
  for (const cap of [0, 1, 10, 55, 56, 57, 200, 1000]) {
    const out = cutText('y'.repeat(5000), cap)
    assert.ok(out.length <= cap, `cap=${cap} → ${out.length}`)
  }
})

process.stdout.write('动态回写分类与提额申请\n')

it('分类：实测波动 > 名字前缀 > 静态；工具永不裁剪', () => {
  const opts = { dynamic: ['soul:memory', 'index'] }
  const party = { volatile: { 'section:老记忆': true } }
  assert.deepEqual(classifyItem('section', '老记忆', party, opts), { kind: 'dynamic', dynamic: true, because: 'volatile' })
  assert.deepEqual(classifyItem('section', 'soul:memory', { volatile: {} }, opts), { kind: 'dynamic', dynamic: true, because: 'prefix:soul:memory' })
  assert.deepEqual(classifyItem('context', 'index:catalog', { volatile: {} }, opts), { kind: 'dynamic', dynamic: true, because: 'prefix:index' })
  assert.deepEqual(classifyItem('section', 'soul:identity', { volatile: {} }, opts), { kind: 'static', dynamic: false, because: 'static' })
  assert.deepEqual(classifyItem('tool', 'pwsh', { volatile: { 'tool:pwsh': true } }, opts), { kind: 'tool', dynamic: false, because: 'tool' })
})

it('提额申请校验：四种毛病各给一句人话，合法则原样收下', () => {
  assert.match(validateRequest({ scope: 'nope', wantChars: 10, reason: 'r' }).error, /scope/)
  assert.match(validateRequest({ scope: 'section', name: 'a', wantChars: 0, reason: 'r' }).error, /wantChars/)
  assert.match(validateRequest({ scope: 'section', name: 'a', wantChars: 10, reason: '   ' }).error, /reason/)
  assert.match(validateRequest({ scope: 'section', wantChars: 10, reason: 'r' }).error, /name/)
  assert.deepEqual(validateRequest({ scope: 'total', wantChars: 12.7, reason: ' 需要 ', name: '' }),
    { scope: 'total', name: null, wantChars: 12, reason: '需要' })
  assert.equal(validateRequest({ scope: 'section', name: ' soul:memory ', wantChars: 9000, reason: '记忆变长' }).name, 'soul:memory')
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
