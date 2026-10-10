/**
 * 浏览器半边的离线渲染自测：不装浏览器、不联网，把 lib/client.js 加载进一个
 * 迷你 React，真跑一遍渲染，检查它到底吐不吐得出东西。
 *
 *   node test/render.mjs
 *
 * 为什么需要它：卡片是否出现，取决于「组件渲染时有没有抛异常」——
 * 而抛异常只会被宿主的 error boundary 吞掉，插槽占用者照样显示 active，
 * 从外面看和「注册成功但没渲染」一模一样。这个测试把那一层遮罩拿掉。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

/* ── 迷你 React：只实现真实组件用到的那三件事 ─────────────────────── */

function createMiniReact() {
  let store = []
  let cursor = 0
  let effects = []
  const React = {
    createElement(type, props, ...children) {
      return { type, props: { ...(props || {}), children: children.length <= 1 ? children[0] : children } }
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (store.length <= index) store[index] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        store[index] = typeof next === 'function' ? next(store[index]) : next
      }
      return [store[index], set]
    },
    useEffect(callback) {
      const index = cursor
      cursor += 1
      // 真 React 的 [] 依赖 effect 只在挂载时跑一次；这里也必须只跑一次，
      // 否则每趟渲染都会重新拉报告并把「已复制」之类的提示清掉（会骗出假失败）。
      if (effectDone[index] !== true) effects.push({ index, callback })
    },
  }
  let effectDone = {}
  return {
    React,
    beginPass() {
      cursor = 0
      effects = []
    },
    /** 清掉 hook 存储：让下一个用例从「全新挂载」开始，用例之间不串状态。 */
    resetStore() {
      store = []
      effectDone = {}
      cursor = 0
      effects = []
    },
    runEffects() {
      const pending = effects
      effects = []
      for (const entry of pending) {
        effectDone[entry.index] = true
        entry.callback()
      }
    },
  }
}

/* ── 组件产出物的检查工具 ─────────────────────────────────────────── */

/** 收集渲染树里所有文本。 */
function textOf(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out)
    return out
  }
  if (node.props) textOf(node.props.children, out)
  return out
}

/** 统计元素节点数（用来发现「渲染了个空壳」）。 */
function countNodes(node) {
  if (node === null || node === undefined || typeof node !== 'object') return 0
  if (Array.isArray(node)) return node.reduce((n, child) => n + countNodes(child), 0)
  if (!node.props) return 0
  let total = 1
  const kids = node.props.children
  if (Array.isArray(kids)) for (const child of kids) total += countNodes(child)
  else total += countNodes(kids)
  return total
}

/* ── 一份贴近真机的报告样本（照 2026-10-07 实测抓下来的形状） ──────── */

const report = {
  generatedAt: 1791350778197,
  package: 'dsh-prompt-limiter',
  build: '0.1.0',
  limitsPath: 'C:/Users/CW/.dsh/storages/prompt-limiter/limits.json',
  limitsSource: 'file',
  limits: { action: 'warn', totalChars: null, sections: { 'soul:memory': 1000 } },
  defaults: { action: 'warn', totalChars: null, sections: {} },
  enforcing: false,
  observedAssemblies: 5,
  probed: [{ sessionId: 'session-1c699c50', ok: true, totalChars: 10441 }],
  parties: [
    {
      key: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342',
      sessionId: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342',
      live: true,
      header: { cwd: 'D:/dp1', parentSession: null, origin: null, delegationDepth: null, agentPreset: 'cordis', createdAt: 1791350000000 },
      assemblies: 5,
      firstAt: 1791350000000,
      lastAt: 1791350778197,
      totalChars: 41476,
      estTokens: 12080,
      sectionChars: 9620,
      contextChars: 302,
      toolChars: 31554,
      effectiveTotalChars: 41476,
      peak: { totalChars: 41476, at: 1791350778197 },
      probe: { at: 1791350778197, totalChars: 10441, estTokens: 3000, sectionChars: 6000, contextChars: 100, toolChars: 4341, sectionCount: 10, toolCount: 10 },
      violations: 1,
      sections: [
        { name: 'soul:memory', chars: 1418, estTokens: 900, limit: 1000, over: true, class: 'dynamic', dynamic: true, dynamicBecause: 'volatile', source: { plugin: 'dsh-linghun', basis: 'code', note: '内容由 dsh-linghun-assembler 写入 assembled.md' } },
        { name: 'ui:deliverable-file-references', chars: 1304, estTokens: 700, limit: null, over: false, class: 'dynamic', dynamic: true, dynamicBecause: 'volatile', source: { plugin: '@deepseek-ai/dsh-client-ui-*（界面/交付事实）', basis: 'prefix', note: null } },
        { name: 'soul:identity', chars: 1097, estTokens: 600, limit: null, over: false, class: 'static', dynamic: false, dynamicBecause: 'static', source: { plugin: 'dsh-linghun', basis: 'code', note: null } },
      ],
      contexts: [{ name: 'approval:policy', chars: 175, estTokens: 60, limit: null, over: false, class: 'static', dynamic: false, dynamicBecause: 'static', source: { plugin: '@deepseek-ai/dsh-user-approval', basis: 'prefix', note: null } }],
      tools: { count: 40, chars: 31554, items: [{ name: 'pwsh', chars: 3438, estTokens: 1200, limit: null, over: false, class: 'tool', dynamic: false, dynamicBecause: 'tool', deferred: false, source: { plugin: '@deepseek-ai/dsh-tools（工具注册项）', basis: 'prefix', note: null } }] },
      dynamic: { items: 2, chars: 2722, volatileItems: 2, limited: 1, over: 1 },
      sources: [{ plugin: 'dsh-linghun', basis: 'code', chars: 2515, items: 2, dynamicChars: 1418, dynamicItems: 1 }],
      over: true,
    },
    {
      key: '(未归属)',
      sessionId: null,
      live: false,
      header: null,
      assemblies: 2,
      firstAt: 1791350000000,
      lastAt: 1791350778197,
      totalChars: 10441,
      estTokens: 3000,
      sectionChars: 6000,
      contextChars: 100,
      toolChars: 4341,
      effectiveTotalChars: 10441,
      peak: { totalChars: 10441, at: 1791350778197 },
      probe: null,
      violations: 0,
      sections: [{ name: 'global-only', chars: 6000, estTokens: 2000, limit: null, over: false, class: 'static', dynamic: false, dynamicBecause: 'static', source: { plugin: null, basis: 'unknown', note: null } }],
      contexts: [],
      tools: { count: 10, chars: 4341, items: [] },
      dynamic: { items: 0, chars: 0, volatileItems: 0, limited: 0, over: 0 },
      sources: [],
      over: false,
    },
  ],
  aggregate: [
    { kind: 'tool', name: 'pwsh', chars: 3438, estTokens: 1200, parties: 1, class: 'tool', dynamic: false, source: { plugin: '@deepseek-ai/dsh-tools（工具注册项）', basis: 'prefix', note: null }, limit: null },
    { kind: 'section', name: 'soul:memory', chars: 1418, estTokens: 900, parties: 1, class: 'dynamic', dynamic: true, source: { plugin: 'dsh-linghun', basis: 'code', note: null }, limit: 1000 },
    { kind: 'context', name: 'index:skills', chars: 900, estTokens: 300, parties: 1, class: 'dynamic', dynamic: true, source: { plugin: 'dsh-linghun', basis: 'code', note: null }, limit: null },
    { kind: 'section', name: 'soul:identity', chars: 1097, estTokens: 600, parties: 1, class: 'static', dynamic: false, source: { plugin: 'dsh-linghun', basis: 'code', note: null }, limit: null },
  ],
  dynamic: { items: 2, chars: 2318, volatileItems: 1, limited: 1, over: 1 },
  sources: [{ plugin: 'dsh-linghun', basis: 'code', chars: 3415, items: 3, dynamicChars: 2318, dynamicItems: 2, parties: 1 }],
  requests: [{
    id: 'req-abc123',
    at: 1791350778197,
    sessionId: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342',
    scope: 'section',
    name: 'soul:memory',
    wantChars: 20000,
    current: 1000,
    reason: '记忆条目确实变多了，压缩不掉',
    status: 'pending',
  }],
  notice: { active: true, text: '【提示词预算·dsh-prompt-limiter】\n· soul:memory（dsh-linghun）≤ 1000 字符，上一跳实测 1418\n超限动作：截断。' },
  provenance: { at: 1791350778197, packages: 6, files: 40, bytes: 1024, reason: 'test', known: 1, declared: {} },
  events: [{ at: 1791350778197, sessionId: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342', scope: 'section', name: 'soul:memory', chars: 1418, limit: 1000, action: 'warn' }],
  errors: [],
  notes: ['字符数是精确值；token 是启发式估算。', '观测数据只在内存中。'],
}

/* ── 把 client.js 装进沙箱，取回插件工厂 ──────────────────────────── */

const mini = createMiniReact()
let spec = null

/* ── 正文样本（GET /prompt-limiter/text 的应答形状） ───────────────── */

const textFixture = {
  ok: true,
  party: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342',
  sessionId: 'session-1c699c50-6cf5-4cbf-a7b0-91c4b8c30342',
  available: true,
  from: 'observed',
  at: 1791350778197,
  chars: 1424 + 1304 + 1097 + 175 + 26,
  trimmed: false,
  producedChars: 41476,
  effectiveChars: 41476,
  sections: [
    { name: 'soul:memory', text: 'SOUL-MEMORY-BODY 你是一个认知主体……' },
    { name: 'ui:deliverable-file-references', text: 'FILE-REFS-BODY' },
    { name: 'soul:identity', text: 'IDENTITY-BODY' },
  ],
  contexts: [{ name: 'approval:policy', text: 'APPROVAL-POLICY-BODY' }],
  tools: [{ name: 'pwsh', json: '{\n  "name": "pwsh",\n  "description": "run"\n}' }],
}

/** fetch 行为开关：ok / down（网络失败）/ textMissing（报告在，正文路由是旧宿主没有的）。 */
let fetchMode = 'ok'
const fetchLog = []

const sandbox = {
  window: { __ModuleLoader__: { load(value) { spec = value } } },
  document: { documentElement: { lang: 'zh-CN' } },
  navigator: { language: 'zh-CN', clipboard: { writeText: async () => {} } },
  console,
  fetch: async (url) => {
    const target = String(url)
    fetchLog.push(target)
    if (fetchMode === 'down') throw new Error('route down')
    if (fetchMode === 'textMissing' && target.includes('/text')) {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) }
    }
    if (fetchMode === 'oldHost') {
      return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not-found' }) }
    }
    const body = target.includes('/text') ? textFixture : report
    return { ok: true, status: 200, json: async () => body }
  },
  setTimeout,
  setImmediate,
  clearTimeout,
  Promise,
  Date,
  JSON,
  Math,
  Number,
  String,
  Object,
  Array,
  Error,
  isFinite,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

assert.ok(spec, 'client.js 没有调用 window.__ModuleLoader__.load')
assert.equal(spec.id, 'dsh-prompt-limiter', '模块 id 必须是包名，否则宿主对不上')

const plugin = spec.factory((name) => {
  if (name === 'react') return mini.React
  throw new Error(`client.js 不该 require 别的包，却要了 ${name}`)
})

/* ── 假客户端 ctx：把插槽注册收下来 ───────────────────────────────── */

const registrations = []
function fakeClientCtx() {
  const locale = { getSnapshot: () => ({ id: 'zh' }) }
  return {
    inject(services, callback) {
      const scope = {
        effect(callback2) { const dispose = callback2(); return () => dispose && dispose() },
        slots: {
          inject(key, generator) {
            const iterator = generator()
            let step = iterator.next()
            while (!step.done) step = iterator.next()
            return () => {}
          },
          register(props, Component) {
            registrations.push({ props, Component })
            return () => {}
          },
        },
      }
      if (services.includes('locale')) scope.locale = locale
      if (services.includes('slots')) scope.slots = scope.slots
      callback(scope)
    },
  }
}

let passed = 0
const failures = []
async function it(label, body) {
  try {
    await body()
    passed += 1
    process.stdout.write(`  ok  ${label}\n`)
  } catch (error) {
    failures.push(label)
    process.stdout.write(`  FAIL ${label}\n        ${error && error.message}\n`)
  }
}

/** 渲染一个组件若干趟（第一趟跑 effect 触发 fetch，后续趟吃掉 setState）。 */
async function render(Component, props, passes = 6) {
  let tree
  for (let pass = 0; pass < passes; pass += 1) {
    mini.beginPass()
    tree = Component(props)
    // 迷你 React 没有 reconciler：函数组件包函数组件时手动展开一层（本项目里
    // 只有「中央面板」这个包装器，它自身不用 hook，所以 hook 下标的顺序不受影响）。
    let guard = 0
    while (tree && typeof tree === 'object' && typeof tree.type === 'function' && guard < 8) {
      tree = tree.type(tree.props)
      guard += 1
    }
    mini.runEffects()
    await new Promise((resolve) => setImmediate(resolve))
  }
  return tree
}

process.stdout.write('插件导出与注册\n')

await it('exports.apply / exports.inject 齐备，且不 require 额外包', () => {
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(plugin.inject.length, 0)
})

plugin.apply(fakeClientCtx())

await it('注册进插件页配置槽（key = 包名）与旧版设置项槽', () => {
  const keys = registrations.map((item) => `${item.props.name}:${item.props.key ?? item.props.id}`)
  assert.ok(keys.includes('plugins.bundle.config:dsh-prompt-limiter'), `实际注册：${keys.join(', ')}`)
  assert.ok(keys.includes('settings.plugin.item:prompt-limiter'))
  for (const item of registrations) assert.equal(typeof item.Component, 'function')
})

await it('注册侧栏图标与中央面板（id 与 main 的 key 同名）', () => {
  const list = registrations.find((item) => item.props.name === 'sidebar.panellist')
  const main = registrations.find((item) => item.props.name === 'main')
  assert.ok(list, '没有注册 sidebar.panellist')
  assert.ok(main, '没有注册 main')
  assert.equal(list.props.id, 'prompt-limiter')
  assert.equal(list.props.id, main.props.key, '侧栏 id 必须等于中央面板的 key，否则点了没反应')
  assert.equal(typeof list.props.label, 'function')
})

const card = registrations.find((item) => item.props.name === 'plugins.bundle.config').Component
const icon = registrations.find((item) => item.props.name === 'sidebar.panellist').Component
const panel = registrations.find((item) => item.props.name === 'main').Component

process.stdout.write('设置页卡片渲染\n')

await it('`page` 视图渲染出完整面板（不是空壳）', async () => {
  mini.resetStore()
  const tree = await render(card, { view: 'page' })
  const text = textOf(tree).join(' | ')
  assert.ok(countNodes(tree) > 80, `节点只有 ${countNodes(tree)} 个，像是空渲染`)
  assert.match(text, /提示词控制器/)
  assert.match(text, /总览/)
  assert.match(text, /动态回写/)
  assert.match(text, /来源/)
  assert.match(text, /soul:memory/)
  assert.match(text, /未归属/)
  assert.match(text, /现场探测/)
  assert.match(text, /limits\.json/)
  assert.doesNotMatch(text, /\[object Object\]/, '元素被拼进字符串了')
  assert.match(text, /1c699c50/, '会话 id 应显示成可辨认的短段')
})

await it('`summary` 视图只出一行摘要', async () => {
  const tree = await render(card, { view: 'summary' })
  const text = textOf(tree).join(' | ')
  assert.ok(countNodes(tree) <= 6, `摘要视图节点过多：${countNodes(tree)}`)
  assert.match(text, /各方/)
  assert.match(text, /41,476|41476/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

await it('拿不到报告时渲染错误行而不是白屏', async () => {
  mini.resetStore()
  fetchMode = 'down'
  const tree = await render(card, { view: 'summary' })
  fetchMode = 'ok'
  const text = textOf(tree).join(' | ')
  assert.match(text, /读取失败|route down/)
})

process.stdout.write('中央面板与侧栏图标\n')

await it('面板铺满主列：标题条 + 独立滚动区', async () => {
  mini.resetStore()
  const tree = await render(panel, {})
  const text = textOf(tree).join(' | ')
  assert.equal(tree.props.style.height, '100%')
  assert.equal(tree.props.style.flexDirection, 'column')
  assert.ok(countNodes(tree) > 80, `面板节点只有 ${countNodes(tree)} 个`)
  assert.match(text, /提示词控制器/)
  assert.match(text, /总览/)
  assert.match(text, /soul:memory/)
  assert.doesNotMatch(text, /\[object Object\]/)
  // 面板视图里不该再出现设置卡片那套「插件配置」措辞（它就是全屏界面本身）。
  assert.doesNotMatch(text, /设为上限[\s\S]*设为上限[\s\S]*设为上限[\s\S]*设为上限/)
})

await it('侧栏图标在 size/active 两种状态下都能画出来', () => {
  const idle = icon({ size: 16, active: false })
  const active = icon({ size: 20, active: true })
  assert.equal(idle.type, 'svg')
  assert.equal(idle.props.width, 16)
  assert.equal(active.props.width, 20)
  assert.ok(countNodes(idle) >= 4, '图标里应该有三根柱子')
  assert.equal(idle.props.stroke, 'currentColor')
  assert.notEqual(active.props.stroke, 'currentColor')
})

await it('图标标签随语言服务解析（不是死字符串）', () => {
  const label = registrations.find((item) => item.props.name === 'sidebar.panellist').props.label
  assert.equal(label(), '提示词控制器')
})

/* ── 点开看正文：全文 / 逐项 / 复制 / 看不到时说清原因 ────────────── */

/** 收集所有满足条件的 vnode（用来找可点的链接）。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (node.props) {
    if (predicate(node)) out.push(node)
    findAll(node.props.children, predicate, out)
  }
  return out
}

/** 找一个文本匹配的可点节点（链接或按钮）并点它；找不到返回 false。 */
function clickLink(tree, wanted) {
  const target = findAll(tree, (node) => (node.type === 'a' || node.type === 'button')
    && textOf(node).join('').includes(wanted))[0]
  if (target === undefined) return false
  target.props.onClick({ preventDefault() {}, stopPropagation() {} })
  return true
}

process.stdout.write('具体提示词：点开看正文\n')

await it('「查看全文」按进模型顺序铺开正文，工具给美化 JSON', async () => {
  mini.resetStore()
  let tree = await render(panel, {})
  assert.equal(clickLink(tree, '查看全文'), true, '找不到「查看全文」入口')
  tree = await render(panel, {})
  const text = textOf(tree).join(' | ')
  assert.match(text, /SOUL-MEMORY-BODY/)
  assert.match(text, /FILE-REFS-BODY/)
  assert.match(text, /IDENTITY-BODY/)
  assert.match(text, /APPROVAL-POLICY-BODY/)
  assert.match(text, /"name": "pwsh"/)
  assert.match(text, /来自实际组装/)
  assert.match(text, /按进模型的顺序/)
  assert.match(text, /收起全文/)
  assert.ok(fetchLog.some((url) => /\/prompt-limiter\/text\?party=/.test(url)), `正文请求没发出去：${fetchLog.join(', ')}`)
})

await it('「复制全文」走剪贴板并给出反馈', async () => {
  let tree = await render(panel, {})
  assert.equal(clickLink(tree, '复制全文'), true, '找不到「复制全文」')
  await new Promise((resolve) => setImmediate(resolve))
  tree = await render(panel, {})
  assert.match(textOf(tree).join(' | '), /已复制/)
})

await it('逐项展开：点段落名看这一段的原文', async () => {
  mini.resetStore()
  let tree = await render(panel, {})
  assert.equal(clickLink(tree, '展开明细'), true, '找不到「展开明细」')
  tree = await render(panel, {})
  assert.equal(clickLink(tree, 'soul:memory'), true, '找不到段落名链接')
  tree = await render(panel, {})
  const text = textOf(tree).join(' | ')
  assert.match(text, /SOUL-MEMORY-BODY/)
  const hint = findAll(tree, (node) => node.type === 'a' && node.props.title === '点开看正文')[0]
  assert.ok(hint, '段落名链接应带「点开看正文」提示（title 属性）')
})

await it('旧宿主（/text 未注册）如实说是旧版本，而不是空壳或谎报', async () => {
  mini.resetStore()
  fetchMode = 'textMissing'
  let tree = await render(panel, {})
  assert.equal(clickLink(tree, '查看全文'), true, '找不到「查看全文」入口')
  tree = await render(panel, {})
  fetchMode = 'ok'
  const text = textOf(tree).join(' | ')
  assert.match(text, /宿主半边还是旧版本/)
  assert.match(text, /重启 DSH/)
})

await it('宿主明说没留存正文时，照它给的原因显示', async () => {
  mini.resetStore()
  const originalText = textFixture.available
  const originalReason = textFixture.reason
  textFixture.available = false
  textFixture.reason = 'text-disabled'
  let tree = await render(panel, {})
  clickLink(tree, '查看全文')
  tree = await render(panel, {})
  textFixture.available = originalText
  textFixture.reason = originalReason
  assert.match(textOf(tree).join(' | '), /text:false 关掉了正文留存/)
})

/* ── 来源 / 动态回写 / 提额申请 ──────────────────────────────────── */

process.stdout.write('来源、动态回写与提额申请\n')

await it('来源列：插件名 + 依据都出现在明细里', async () => {
  mini.resetStore()
  let tree = await render(panel, {})
  assert.equal(clickLink(tree, '展开明细'), true)
  tree = await render(panel, {})
  const text = textOf(tree).join(' | ')
  assert.match(text, /dsh-linghun/)
  assert.match(text, /扫源码/, '来源依据要标出来（这条是按源码扫到的）')
  assert.match(text, /按名前缀推定/, '核心条目按名前缀推定，也要如实标')
  assert.match(text, /实测在变/, '动态回写的判据要写出来')
  assert.match(text, /工具注册项/, '工具 schema 的来源按名前缀推定，也要如实标')
})

await it('来源汇总默认只看动态回写，取消勾选才露出静态条目', async () => {
  mini.resetStore()
  let tree = await render(panel, {})
  let text = textOf(tree).join(' | ')
  assert.match(text, /soul:memory/)
  assert.match(text, /index:skills/, '动态回写条目应当列出')
  assert.doesNotMatch(text, /soul:identity/, '默认不该出现静态条目')
  const box = findAll(tree, (node) => node.type === 'input' && node.props.type === 'checkbox')[0]
  assert.ok(box, '找不到「只看动态回写」的勾选框')
  box.props.onChange({ target: { checked: false } })
  tree = await render(panel, {})
  text = textOf(tree).join(' | ')
  assert.match(text, /soul:identity/, '取消勾选后静态条目应出现')
})

await it('旧宿主没有类别字段时不筛空表格（如实退化）', async () => {
  mini.resetStore()
  const backup = report.aggregate
  report.aggregate = backup.map(function (item) {
    const copy = Object.assign({}, item)
    delete copy.dynamic
    delete copy.class
    return copy
  })
  const tree = await render(panel, {})
  report.aggregate = backup
  const text = textOf(tree).join(' | ')
  assert.match(text, /soul:memory/, '旧宿主下不该把表格筛成空的')
  assert.match(text, /pwsh/)
})

await it('提额申请：把模型的理由摆出来，点「批准」发决定请求', async () => {
  mini.resetStore()
  let tree = await render(panel, {})
  let text = textOf(tree).join(' | ')
  assert.match(text, /待批准的提额申请/)
  assert.match(text, /记忆条目确实变多了/)
  assert.match(text, /20,000/)
  const before = fetchLog.length
  assert.equal(clickLink(tree, '批准'), true, '找不到「批准」按钮')
  await new Promise((resolve) => setImmediate(resolve))
  tree = await render(panel, {})
  assert.ok(fetchLog.slice(before).some((url) => /\/prompt-limiter\/budget\/decide/.test(url)), `没发出决定请求：${fetchLog.slice(before).join(', ')}`)
})

await it('预算提示对用户透明：面板里能看到模型收到的那段话', async () => {
  mini.resetStore()
  const tree = await render(panel, {})
  const text = textOf(tree).join(' | ')
  assert.match(text, /模型当前收到的预算提示/)
  assert.match(text, /soul:memory（dsh-linghun）≤ 1000 字符/)
})

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (registrations.length === 0) process.exitCode = 1
if (failures.length > 0) process.exitCode = 1
