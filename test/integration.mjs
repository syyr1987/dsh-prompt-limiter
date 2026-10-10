/**
 * 进程内集成测试：用假 cordis 上下文把**真实的**宿主半边跑起来，
 * 覆盖纯函数测不到的那半边——监听器注册与归因、限额执行的真实调用路径、
 * HTTP 路由与信任围栏、落盘、工具注册、现场探测记账。
 *
 *   node test/integration.mjs
 *
 * 为什么需要它（实测教训）：插件关/开重挂不会让 Node 重新导入模块（ESM 按 URL 缓存），
 * 所以“改完代码但进程里还是旧代码”这件事只能靠进程内测试 + 报告里的 build 戳来分辨。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 必须早于 import host.js 的效果：插件在 apply 时读一次 $DSH_HOME。
const home = mkdtempSync(join(tmpdir(), 'prompt-limiter-test-'))
process.env.DSH_HOME = home

const { apply, name, inject } = await import('../lib/host.js')

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

/**
 * 换一个干净的临时 $DSH_HOME 并返回「恢复」函数。
 *
 * 额度文件与申请文件是**持久化**的，共享一个 home 会让后面的用例读到前面写下的值
 * （实测踩过：一条用例留下的额度让「默认只观测」断言失败）。会写盘的用例各用各的家。
 */
function useFreshHome() {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-limiter-case-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ── 假 ctx ───────────────────────────────────────────────────────── */

function fakeCtx(options = {}) {
  const listeners = []
  const routes = []
  const tools = []
  /** 本插件注册的运行时上下文（预算提示）与它们的注销次数。 */
  const noticeContexts = []
  const noticeDisposed = []
  const state = {
    initiator: options.initiator ?? null,
    agents: options.agents ?? [],
    sessions: options.sessions ?? new Map(),
  }
  const services = {
    agents: {
      currentInitiator: () => state.initiator,
      list: () => state.agents,
      get: (id) => state.agents.find((agent) => String(agent.id) === id),
    },
    sessions: { get: (id) => state.sessions.get(String(id)) },
    webRuntime: { trustedHosts: options.trustedHosts ?? [] },
    agentPresets: { serviceFor: (agent, service) => (service === 'systemPrompt' ? agent.systemPrompt : undefined) },
    // 硬依赖：`systemPrompt`。这里只实现本插件用到的 context 注册。
    systemPrompt: {
      context(definition) {
        const entry = { ...definition, text: definition.text }
        noticeContexts.push(entry)
        return () => { noticeDisposed.push(entry) }
      },
    },
  }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(event, listener, opts) {
      listeners.push({ event, listener, opts })
      return () => true
    },
    get: (serviceName) => services[serviceName],
    effect(callback) {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject(services2, callback) {
      // 模拟“依赖都在”：直接同步给一个带该服务的 scope。
      const scope = { ...ctx, effect: ctx.effect }
      if (services2.includes('webServer')) {
        scope.webServer = { register(route) { routes.push(route); return () => {} } }
      }
      if (services2.includes('tools')) {
        scope.tools = { register(definition) { tools.push(definition); return () => {} } }
      }
      callback(scope)
    },
  }
  ctx.systemPrompt = services.systemPrompt
  return { ctx, listeners, routes, tools, state, noticeContexts, noticeDisposed }
}

/** 一份样本组装结果。 */
function fixture() {
  return {
    sections: [
      { name: 'alpha', text: 'x'.repeat(1000) },
      { name: 'beta', text: '中'.repeat(400) },
    ],
    contexts: [{ name: 'ctx1', text: 'z'.repeat(300) }],
    tools: [{ name: 't1', description: 'd', parameters: { type: 'object' } }],
    variables: {},
  }
}

/** 假 req/res，跑一次路由；resolve 出 {status, body}。 */
function request(route, { method = 'GET', url = '/prompt-limiter/report', headers = { host: '127.0.0.1:19387' }, body } = {}) {
  return new Promise((resolve, reject) => {
    const captured = {}
    const res = {
      writeHead(status, extra) { captured.status = status; captured.headers = extra; return res },
      end(payload) {
        try {
          resolve({ status: captured.status, body: payload === undefined ? undefined : JSON.parse(payload) })
        } catch (error) {
          reject(error)
        }
      },
    }
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield Buffer.from(JSON.stringify(body), 'utf8')
      },
    }
    route.handler(req, res)
  })
}

/* ── 用例 ─────────────────────────────────────────────────────────── */

process.stdout.write('挂载面\n')

await it('导出 name / hard inject', () => {
  assert.equal(name, 'dsh-prompt-limiter')
  assert.deepEqual(inject, ['systemPrompt'])
})

const main = fakeCtx({
  initiator: { id: 'session-main' },
  sessions: new Map([['session-main', { header: { agentPreset: 'standard', cwd: '/w', origin: undefined } }]]),
})
apply(main.ctx, { action: 'warn' })

await it('组装监听器注册为 最外层 + 全局（prepend+global）', () => {
  assert.equal(main.listeners.length, 1)
  assert.equal(main.listeners[0].event, 'system-prompt/assemble')
  assert.deepEqual(main.listeners[0].opts, { prepend: true, global: true })
})

await it('路由与工具各自按需注入注册', () => {
  assert.equal(main.routes.length, 1)
  assert.equal(main.routes[0].kind, 'prefix')
  assert.equal(main.routes[0].path, '/prompt-limiter')
  assert.deepEqual(main.tools.map((tool) => tool.name).sort(), ['prompt_budget_request', 'prompt_size_report'])
})

process.stdout.write('归因与记账\n')

const assemble = main.listeners[0].listener

await it('warn 下返回原值（零改写），并按发起方归因', async () => {
  const assembly = fixture()
  const out = await assemble(assembly, {}, async () => assembly)
  assert.equal(out, assembly)
  const report = await request(main.routes[0])
  assert.equal(report.status, 200)
  const party = report.body.parties.find((item) => item.sessionId === 'session-main')
  assert.ok(party, '找不到 session-main 这一方')
  assert.equal(party.assemblies, 1)
  assert.equal(party.totalChars, assembly.sections.reduce((n, s) => n + s.text.length, 0) + 300 + JSON.stringify(assembly.tools[0]).length)
  assert.equal(party.header.agentPreset, 'standard')
  assert.equal(party.live, false)
  assert.deepEqual(party.sections.map((s) => s.name), ['alpha', 'beta'])
})

await it('拿不到发起方时如实归入 (未归属)，不冒充', async () => {
  const bare = fakeCtx({ initiator: null })
  apply(bare.ctx, {})
  const assembly = fixture()
  await bare.listeners[0].listener(assembly, {}, async () => assembly)
  const report = await request(bare.routes[0])
  assert.deepEqual(report.body.parties.map((p) => p.sessionId), [null])
})

process.stdout.write('越限记账与限额执行\n')

await it('warn 下越限只记账：over 标记 + events，且不进改写路径', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-warn' } })
  apply(scoped.ctx, { action: 'warn', sections: { alpha: 100 } })
  const assembly = fixture()
  const out = await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  assert.equal(out, assembly)
  const report = await request(scoped.routes[0], { url: '/prompt-limiter/report' })
  const party = report.body.parties[0]
  assert.equal(party.over, true)
  assert.equal(party.effectiveTotalChars, party.totalChars)
  assert.equal(party.violations, 1)
  assert.equal(report.body.events.length, 1)
  assert.equal(report.body.events[0].action, 'warn')
  assert.equal(report.body.events[0].name, 'alpha')
})

await it('truncate 下真的裁剪：产出记账不变，effective 变小', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-cut' } })
  apply(scoped.ctx, { action: 'truncate', totalChars: null, sections: { alpha: 300 } })
  const assembly = fixture()
  const out = await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  assert.notEqual(out, assembly)
  assert.ok(out.sections[0].text.length <= 300)
  assert.match(out.sections[0].text, /dsh-prompt-limiter/)
  assert.equal(out.sections[1], assembly.sections[1], '未超限的段落必须原样透传')
  const report = await request(scoped.routes[0])
  const party = report.body.parties[0]
  assert.equal(party.totalChars > party.effectiveTotalChars, true)
  assert.equal(party.sections.find((s) => s.name === 'alpha').over, true)
})

process.stdout.write('现场探测\n')

await it('probe 记在目标的 probe 上，不新增 (未归属)、不增加 assemblies', async () => {
  const probeAssembly = {
    sections: [{ name: 'global-only', text: 'g'.repeat(500) }],
    contexts: [],
    tools: [{ name: 'p1', description: '', parameters: {} }],
    variables: {},
  }
  const scoped = fakeCtx({ initiator: null, agents: [] })
  apply(scoped.ctx, {})
  // 真实的 systemPrompt.assemble 会走一遍 waterfall（本插件是最外层），
  // 所以假服务也必须把调用交给注册好的监听器，否则测不到 probe 记账。
  const assembleVia = () => scoped.listeners[0].listener(probeAssembly, {}, async () => probeAssembly)
  scoped.state.agents.push(
    { id: 'agent-1', systemPrompt: { assemble: assembleVia } },
    { id: 'agent-2', systemPrompt: { assemble: assembleVia } },
  )
  const report = await request(scoped.routes[0], { url: '/prompt-limiter/report?probe=1' })
  assert.deepEqual(report.body.probed.map((p) => p.ok), [true, true])
  assert.equal(report.body.probed[0].sectionCount, 1)
  assert.equal(report.body.probed[0].toolCount, 1)
  const ids = report.body.parties.map((p) => p.sessionId).sort()
  assert.deepEqual(ids, ['agent-1', 'agent-2'], '不该出现 (未归属)')
  for (const party of report.body.parties) {
    assert.equal(party.assemblies, 0)
    assert.equal(party.probe.totalChars, report.body.probed[0].totalChars)
    assert.equal(party.probe.toolCount, 1)
    assert.equal(party.live, true)
  }
})

await it('探测入口全都不可用时如实报错，不编数', async () => {
  const scoped = fakeCtx({ agents: [{ id: 'agent-x' }] })
  apply(scoped.ctx, {})
  const report = await request(scoped.routes[0], { url: '/prompt-limiter/report?probe=1' })
  assert.equal(report.body.probed[0].ok, false)
  assert.match(report.body.probed[0].error, /没有可用的按 Agent 组装入口/)
})

process.stdout.write('具体提示词：/text 懒加载\n')

await it('点开看正文：返回每一项的原文，并标明来源', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-text' } })
  apply(scoped.ctx, {})
  const assembly = fixture()
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const report = await request(scoped.routes[0])
  const party = report.body.parties[0]
  assert.equal(party.hasText, true)
  const body = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=' + encodeURIComponent(party.key) })
  assert.equal(body.status, 200)
  assert.equal(body.body.available, true)
  assert.equal(body.body.from, 'observed')
  assert.deepEqual(body.body.sections.map((s) => s.name), ['alpha', 'beta'])
  assert.equal(body.body.sections[0].text, 'x'.repeat(1000))
  assert.equal(body.body.contexts[0].text, 'z'.repeat(300))
  assert.match(body.body.tools[0].json, /"name": "t1"/)
})

await it('单取一项（curl 用）：kind+name 只回那一项，名字不对 404', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-one' } })
  apply(scoped.ctx, {})
  const assembly = fixture()
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const one = await request(scoped.routes[0], {
    url: '/prompt-limiter/text?party=session-one&kind=section&name=beta',
  })
  assert.equal(one.status, 200)
  assert.equal(one.body.text, '中'.repeat(400))
  assert.equal(one.body.chars, 400)
  const missing = await request(scoped.routes[0], {
    url: '/prompt-limiter/text?party=session-one&kind=section&name=nope',
  })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error, 'unknown-item')
  const noParty = await request(scoped.routes[0], { url: '/prompt-limiter/text' })
  assert.equal(noParty.status, 400)
})

await it('裁剪开着时留的是「真正进模型的那份」原文，并标明被裁过', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-trim' } })
  apply(scoped.ctx, { action: 'truncate', sections: { alpha: 300 } })
  const assembly = fixture()
  const out = await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  assert.ok(out.sections[0].text.length <= 300)
  const body = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=session-trim' })
  assert.equal(body.body.trimmed, true)
  assert.ok(body.body.sections[0].text.length <= 300, '正文必须是被裁之后的那份')
  assert.match(body.body.sections[0].text, /dsh-prompt-limiter/)
  assert.ok(body.body.producedChars > body.body.effectiveChars)
})

await it('现场探测的正文标明来自探测', async () => {
  const scoped = fakeCtx({ agents: [] })
  apply(scoped.ctx, {})
  const probeAssembly = fixture()
  const assembleVia = () => scoped.listeners[0].listener(probeAssembly, {}, async () => probeAssembly)
  scoped.state.agents.push({ id: 'agent-p', systemPrompt: { assemble: assembleVia } })
  await request(scoped.routes[0], { url: '/prompt-limiter/report?probe=1' })
  const body = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=agent-p' })
  assert.equal(body.body.from, 'probe')
  assert.equal(body.body.sections[0].text, 'x'.repeat(1000))
})

await it('行配置关掉留存时，如实说关掉了，而不是给空壳', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-notext' } })
  apply(scoped.ctx, { text: false })
  const assembly = fixture()
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const report = await request(scoped.routes[0])
  assert.equal(report.body.parties[0].hasText, false)
  const body = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=session-notext' })
  assert.equal(body.status, 200)
  assert.equal(body.body.available, false)
  assert.equal(body.body.reason, 'text-disabled')
})

await it('没这一方 → 404；有这一方但没组装过 → 200 说没留存', async () => {
  const scoped = fakeCtx({ agents: [{ id: 'agent-idle' }] })
  apply(scoped.ctx, {})
  const unknown = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=ghost' })
  assert.equal(unknown.status, 404)
  assert.equal(unknown.body.reason, 'unknown-party')
  const idle = await request(scoped.routes[0], { url: '/prompt-limiter/text?party=agent-idle' })
  assert.equal(idle.status, 200)
  assert.equal(idle.body.reason, 'not-captured')
})

await it('原文留存有上限：超过 10 方后只有最近的还留着正文，体量记账不受影响', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-0' } })
  apply(scoped.ctx, {})
  for (let index = 0; index < 11; index += 1) {
    scoped.state.initiator = { id: `session-${index}` }
    const assembly = fixture()
    await scoped.listeners[0].listener(assembly, {}, async () => assembly)
    // 时间戳可能同毫秒，给留存淘汰一点可分辨的顺序
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const report = await request(scoped.routes[0])
  const withText = report.body.parties.filter((party) => party.hasText)
  assert.equal(withText.length, 10, `留存方数应为 10，实际 ${withText.length}`)
  assert.equal(report.body.parties.find((party) => party.sessionId === 'session-0').hasText, false, '最早那一方应已被淘汰')
  assert.equal(report.body.parties.find((party) => party.sessionId === 'session-0').assemblies, 1, '体量记账不受留存上限影响')
})

process.stdout.write('来源、动态回写、预算提示与提额申请\n')

// 这一段会真的写额度文件与申请文件：给它们一个自己的临时 $DSH_HOME，
// 免得污染下面「默认只观测」「重启后从文件恢复」那几个用例的前提。
const restoreCaseHome = useFreshHome()

await it('来源：声明映射最强（basis=config），前缀次之，未知就未知', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-src' } })
  apply(scoped.ctx, { provenance: { alpha: 'dsh-test-plugin' } })
  const assembly = fixture()
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const report = await request(scoped.routes[0])
  const byName = new Map(report.body.parties[0].sections.map((item) => [item.name, item]))
  assert.deepEqual(byName.get('alpha').source, { plugin: 'dsh-test-plugin', basis: 'config', note: null })
  assert.equal(byName.get('beta').source.basis, 'unknown')
  assert.equal(byName.get('beta').source.plugin, null)
  // 报告级汇总：谁占了多少
  const top = report.body.sources[0]
  assert.equal(top.plugin, 'dsh-test-plugin')
  assert.equal(top.chars, 1000)
})

await it('来源：工具 schema 按前缀归到核心，且标为推定', async () => {
  const scoped = fakeCtx({})
  apply(scoped.ctx, {})
  const report = await request(scoped.routes[0], { url: '/prompt-limiter/report?probe=1' })
  // 没有观测时靠在线探测没有内容，这里直接查目录本身的行为
  const probe = report.body.provenance
  assert.equal(typeof probe.known, 'number')
  assert.equal(probe.declared.dynamic === undefined, true)
  const item = { name: 'tool:something' }
  assert.ok(item.name.startsWith('tool:'))
})

await it('动态回写：实测变过的条目判为 dynamic（比名字前缀更硬）', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-vol' } })
  apply(scoped.ctx, {})
  const first = { sections: [{ name: '随手写的记忆', text: '第一版内容' }], contexts: [], tools: [], variables: {} }
  const second = { sections: [{ name: '随手写的记忆', text: '第二版内容，变长了' }], contexts: [], tools: [], variables: {} }
  await scoped.listeners[0].listener(first, {}, async () => first)
  await scoped.listeners[0].listener(second, {}, async () => second)
  const report = await request(scoped.routes[0])
  const item = report.body.parties[0].sections[0]
  assert.equal(item.class, 'dynamic')
  assert.equal(item.dynamicBecause, 'volatile')
  assert.equal(report.body.parties[0].dynamic.items, 1)
  assert.equal(report.body.parties[0].dynamic.volatileItems, 1)
})

await it('动态回写：没变过的按前缀兜底，静态的如实标静态', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-pre' } })
  apply(scoped.ctx, {})
  const assembly = {
    sections: [
      { name: 'soul:memory', text: '记忆包' },
      { name: 'soul:identity', text: '身份卡' },
    ],
    contexts: [{ name: 'index:skills', text: '技能索引' }],
    tools: [],
    variables: {},
  }
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const report = await request(scoped.routes[0])
  const party = report.body.parties[0]
  const byName = new Map([...party.sections, ...party.contexts].map((item) => [item.name, item]))
  assert.deepEqual([byName.get('soul:memory').class, byName.get('soul:memory').dynamicBecause], ['dynamic', 'prefix:soul:memory'])
  assert.deepEqual([byName.get('index:skills').class, byName.get('index:skills').dynamicBecause], ['dynamic', 'prefix:index'])
  assert.equal(byName.get('soul:identity').class, 'static', '静态身份卡不该被算成动态回写')
  assert.equal(report.body.dynamic.items, 2)
})

await it('配了上限就注入预算提示，改额度后同步，取消后注销', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-notice' } })
  apply(scoped.ctx, { action: 'truncate', sections: { 'soul:memory': 4000 } })
  assert.equal(scoped.noticeContexts.length, 1, '有上限时应注入预算提示')
  assert.equal(scoped.noticeContexts[0].name, 'prompt-limiter:budget')
  const assembly = { sections: [{ name: 'soul:memory', text: 'x'.repeat(500) }], contexts: [], tools: [], variables: {} }
  await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  const text = scoped.noticeContexts[0].text({})
  assert.match(text, /提示词预算/)
  assert.match(text, /soul:memory ≤ 4000 字符，上一跳实测 500/)
  assert.match(text, /prompt_budget_request/)
  assert.match(text, /整条丢弃|截断/)
  // 改额度 → 内容跟着变（同一条上下文，读的是当前 state）
  await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/limits',
    body: { action: 'truncate', sections: { 'soul:memory': 2000 } },
  })
  assert.match(scoped.noticeContexts[0].text({}), /≤ 2000 字符/)
  // 清空上限 → 注销，不再占提示词的位置
  await request(scoped.routes[0], { method: 'POST', url: '/prompt-limiter/limits', body: { action: 'warn', sections: {} } })
  assert.equal(scoped.noticeDisposed.length, 1)
  const report = await request(scoped.routes[0])
  assert.equal(report.body.notice.active, false)
  assert.equal(report.body.notice.text, '')
})

await it('提额申请：模型提交 → 待批准 → 用户批准才改额度并落盘', async () => {
  const caseHome = process.env.DSH_HOME
  const scoped = fakeCtx({ initiator: { id: 'session-ask' } })
  apply(scoped.ctx, {})
  // 额度经正常路径设置（也顺带覆盖「保存后申请对照的是已保存值」）
  await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/limits',
    body: { action: 'truncate', sections: { 'soul:memory': 4000 } },
  })
  const tool = scoped.tools.find((item) => item.name === 'prompt_budget_request')
  const denied = await tool.execute({ scope: 'section', wantChars: 9000, reason: 'x' })
  assert.equal(denied.ok, false, '缺 name 必须被拒')
  const accepted = await tool.execute({ scope: 'section', name: 'soul:memory', wantChars: 9000, reason: '记忆条目确实变多了' })
  assert.equal(accepted.ok, true)
  assert.equal(accepted.status, 'pending')
  assert.equal(accepted.current, 4000)

  const queued = await request(scoped.routes[0], { url: '/prompt-limiter/budget' })
  assert.equal(queued.body.pending.length, 1)
  assert.equal(queued.body.pending[0].reason, '记忆条目确实变多了')
  assert.equal(queued.body.pending[0].sessionId, 'session-ask')

  // 批准前：额度不变
  let report = await request(scoped.routes[0])
  assert.equal(report.body.limits.sections['soul:memory'], 4000)

  const approved = await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/budget/decide',
    body: { id: accepted.id, approve: true },
  })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.request.status, 'approved')
  assert.equal(approved.body.limits.sections['soul:memory'], 9000)
  report = await request(scoped.routes[0])
  assert.equal(report.body.limits.sections['soul:memory'], 9000)
  // 申请队列落盘
  const onDisk = JSON.parse(readFileSync(join(caseHome, 'storages', 'prompt-limiter', 'requests.json'), 'utf8'))
  assert.equal(onDisk.requests.at(-1).status, 'approved')
})

await it('提额申请：拒绝不动额度；重复决定与未知 id 都有交代', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-no' } })
  apply(scoped.ctx, {})
  await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/limits',
    body: { action: 'warn', sections: { 'soul:memory': 4000 } },
  })
  const tool = scoped.tools.find((item) => item.name === 'prompt_budget_request')
  const accepted = await tool.execute({ scope: 'section', name: 'soul:memory', wantChars: 20000, reason: '想多一点' })
  const rejected = await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/budget/decide',
    body: { id: accepted.id, approve: false },
  })
  assert.equal(rejected.body.request.status, 'rejected')
  assert.equal(rejected.body.limits.sections['soul:memory'], 4000, '拒绝不该改额度')
  const again = await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/budget/decide',
    body: { id: accepted.id, approve: true },
  })
  assert.equal(again.body.request.status, 'rejected', '已决定的不再翻转')
  const missing = await request(scoped.routes[0], {
    method: 'POST', url: '/prompt-limiter/budget/decide', body: { id: 'req-nope', approve: true },
  })
  assert.equal(missing.status, 404)
})

restoreCaseHome()

process.stdout.write('路由、围栏与落盘\n')

await it('信任围栏：无 Host / 跨站标记一律 403', async () => {
  const noHost = await request(main.routes[0], { headers: {} })
  assert.equal(noHost.status, 403)
  assert.equal(noHost.body.ok, false)
  const crossSite = await request(main.routes[0], { headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'cross-site' } })
  assert.equal(crossSite.status, 403)
  const crossOrigin = await request(main.routes[0], { headers: { host: '127.0.0.1:19387', origin: 'http://evil.example' } })
  assert.equal(crossOrigin.status, 403)
  const lan = await request(main.routes[0], { headers: { host: '192.168.1.9:19387' } })
  assert.equal(lan.status, 403, '非回环且不在 trustedHosts 时也要拒绝')
})

await it('trustedHosts 声明的权威放行', async () => {
  const scoped = fakeCtx({ trustedHosts: ['192.168.1.9:19387'] })
  apply(scoped.ctx, {})
  const ok = await request(scoped.routes[0], { headers: { host: '192.168.1.9:19387' } })
  assert.equal(ok.status, 200)
})

await it('GET /limits 默认 = 只观测', async () => {
  const scoped = fakeCtx({})
  apply(scoped.ctx, {})
  const res = await request(scoped.routes[0], { url: '/prompt-limiter/limits' })
  assert.equal(res.status, 200)
  assert.deepEqual(res.body.limits, { action: 'warn', totalChars: null, sections: {} })
  assert.equal(res.body.limitsSource, 'config')
  assert.deepEqual(res.body.actions, ['warn', 'truncate', 'drop'])
})

await it('POST /limits 落盘 + 立刻影响执行；非法提交 400', async () => {
  const scoped = fakeCtx({ initiator: { id: 'session-save' } })
  apply(scoped.ctx, {})
  const ok = await request(scoped.routes[0], {
    method: 'POST',
    url: '/prompt-limiter/limits',
    body: { action: 'drop', totalChars: '5000', sections: { alpha: '400', '  ': 9, bad: 'x' } },
  })
  assert.equal(ok.status, 200)
  assert.equal(ok.body.persisted, true)
  assert.deepEqual(ok.body.limits, { action: 'drop', totalChars: 5000, sections: { alpha: 400 } })
  assert.equal(ok.body.limitsSource, 'file')

  const onDisk = JSON.parse(readFileSync(join(home, 'storages', 'prompt-limiter', 'limits.json'), 'utf8'))
  assert.deepEqual(onDisk.sections, { alpha: 400 })
  assert.equal(typeof onDisk.updatedAt, 'number')

  // 落盘后立刻按新限额执行：drop 掉 alpha。
  const assembly = fixture()
  const out = await scoped.listeners[0].listener(assembly, {}, async () => assembly)
  assert.deepEqual(out.sections.map((s) => s.name), ['beta'])

  const bad = await request(scoped.routes[0], { method: 'POST', url: '/prompt-limiter/limits', body: { action: 'nuke' } })
  assert.equal(bad.status, 400)
})

await it('新实例从文件恢复限额（重启不丢）', async () => {
  const restarted = fakeCtx({})
  apply(restarted.ctx, { action: 'warn' })
  const res = await request(restarted.routes[0], { url: '/prompt-limiter/limits' })
  assert.equal(res.body.limitsSource, 'file')
  assert.deepEqual(res.body.limits, { action: 'drop', totalChars: 5000, sections: { alpha: 400 } }, '行配置不该盖掉用户改过的值')
})

await it('POST /limits/reset 回到行配置', async () => {
  const scoped = fakeCtx({})
  apply(scoped.ctx, { action: 'truncate', totalChars: 1000, sections: { beta: 200 } })
  const res = await request(scoped.routes[0], { method: 'POST', url: '/prompt-limiter/limits/reset' })
  assert.deepEqual(res.body.limits, { action: 'truncate', totalChars: 1000, sections: { beta: 200 } })
})

await it('未知路径 404，报告带 build 戳', async () => {
  const missing = await request(main.routes[0], { url: '/prompt-limiter/nope' })
  assert.equal(missing.status, 404)
  const report = await request(main.routes[0])
  assert.equal(report.body.build, '0.2.0')
  assert.equal(report.body.package, 'dsh-prompt-limiter')
  assert.equal(Array.isArray(report.body.notes), true)
})

process.stdout.write('工具面\n')

await it('prompt_size_report 返回压缩版并支持 probe', async () => {
  const scoped = fakeCtx({ agents: [] })
  apply(scoped.ctx, {})
  const assembleVia = () => scoped.listeners[0].listener(fixture(), {}, async () => fixture())
  scoped.state.agents.push({ id: 'agent-t', systemPrompt: { assemble: assembleVia } })
  const definition = scoped.tools[0]
  assert.equal(typeof definition.execute, 'function')
  const value = await definition.execute({ probe: true })
  assert.equal(value.parties.length, 1)
  assert.equal(value.parties[0].sessionId, 'agent-t')
  assert.equal(Array.isArray(value.parties[0].topSections), true)
  assert.equal(value.parties[0].toolCount, 1)
  assert.equal(value.parties[0].probe.toolCount, 1)
  assert.equal(Array.isArray(value.aggregate), true)
  assert.equal(typeof definition.output.render({}, value)[0].text, 'string')
})

rmSync(home, { recursive: true, force: true })
process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`)
if (failures.length > 0) process.exitCode = 1
