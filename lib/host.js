/**
 * 提示词控制器（dsh-prompt-limiter）宿主半边。
 *
 * 职责三件：
 *  1. **看** —— 挂在 `system-prompt/assemble` waterfall 的最外层，等所有
 *     provider 组装完，量出这一次组装的实际大小：静态段落（sections）、
 *     运行时动态上下文（contexts）、工具 schema（tools），各按字符与 ≈token
 *     分项记账，并按“哪一方”（发起这一步的 Agent / 子智能体）归档。
 *  2. **限** —— 按用户配置的上限（逐段上限 + 总字符上限）决定要不要动手：
 *     `warn` 只记账、`truncate` 截断超限段落、`drop` 丢掉超限段落。默认
 *     `warn`，即默认绝不改写任何提示词。
 *  3. **通** —— 给 Web 设置页一条 `/prompt-limiter` 路由（读报告、读改限额），
 *     给 Agent 一个 `prompt_size_report` 工具。
 *
 * 归因说明（诚实边界）：归因用 `ctx.agents.currentInitiator()` —— 进程内异步
 * 驱动链上“谁发起了这一步”。它在组装发生在驱动链内时给出确切的 SessionId；
 * 拿不到时记为 `(未归属)`，不猜、不冒充。想知道某个在线 Agent 此刻的确切组成，
 * 用报告里的 `probe=1`：那条路径走 `agentPresets.serviceFor(agent, 'systemPrompt')`，
 * 在该 Agent 自己的作用域里现场组装一次。
 *
 * token 数是**估算**：按 ASCII ≈ 4 字符/token、非 ASCII ≈ 1.5 字符/token 的固定
 * 启发式（中文为主的提示词误差通常在 ±15%）。字符数是精确值。
 *
 * 零依赖：不 import 任何 @deepseek-ai/* 包（越树解析不可靠），只用 node 内置模块，
 * 其余服务一律 `ctx.get()` 可选读取，缺失即降级。
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isTrustedApiRequest } from './trust-fence.js'
import { createProvenance } from './provenance.js'

/** 插件身份（cordis 行 id 与之无关，name 只用于日志/自述）。 */
export const name = 'dsh-prompt-limiter'

/**
 * 代码版本戳，随报告一起返回。
 *
 * 存在的理由是一次实测：宿主半边改完 + 插件关/开重挂之后，运行中的实例仍在跑
 * 旧代码（Node 的 ESM 缓存按模块 URL 记住已加载模块，重挂不会重新导入），
 * 光看行为很容易把「旧代码还在跑」误判成「新代码没生效」。报告带上版本戳，
 * 一眼就能分辨在线实例是哪一版。
 */
const BUILD = '0.2.0'

/**
 * 硬依赖：没有系统提示词注册表就无事可做。
 * webServer / tools / agents / sessions / agentPresets 全部按可选读取，
 * 因此在 headless profile 里也能只做观测。
 */
export const inject = ['systemPrompt']

/** 组装 waterfall 的事件名。 */
const EVENT_ASSEMBLE = 'system-prompt/assemble'
/** 本插件占用的路由前缀。 */
const ROUTE_PATH = '/prompt-limiter'
/** 三种处置动作。 */
const ACTION_KINDS = ['warn', 'truncate', 'drop']
/** 归档的“方”上限（超出按最近活跃淘汰）。 */
const MAX_PARTIES = 40
/** 越限事件保留条数。 */
const MAX_EVENTS = 60
/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024
/** 逐段上限表里的兜底键：未点名段落用它。 */
const DEFAULT_SECTION_CAP_KEY = '*'
/**
 * 默认的「动态回写」名字前缀。
 *
 * 上限真正该管的是这一类：记忆注入、素材包、索引/目录——它们由插件每轮回写、
 * 会自己长大；而静态段落（人设、界面事实）和工具 schema 不该被随手裁剪。
 * 前缀只是先验，更硬的判据是**实测波动**：同一方两次组装之间内容变了 = 动态回写。
 */
const DEFAULT_DYNAMIC_PREFIXES = Object.freeze([
  'soul:memory', 'memory', 'mem:', 'material', 'index', 'assembled', 'warm', 'cold', 'episodic', 'cache', 'skill',
])
/** 预算提示注册成的运行时上下文名。 */
const NOTICE_CONTEXT_NAME = 'prompt-limiter:budget'
/** 预算提示排在最后：它是「使用说明」，不该挤到正文中间。 */
const NOTICE_ORDER = 1e6
/** 提额申请保留条数。 */
const MAX_REQUESTS = 20
/** 预算提示最多列几条上限（再多就成噪音了）。 */
const NOTICE_MAX_LINES = 10
/** 剩余预算小于这个值就不截断了，直接丢弃（留个残段没有意义）。 */
const MIN_TRUNCATE_CHARS = 200
/** 单条错误记录保留条数。 */
const MAX_ERRORS = 10
/**
 * 「具体提示词」原文最多为几方留存（其余只留体量）。
 *
 * 留存的是引用，不是拷贝：被裁剪过的那几段才是新字符串。设上限是防止长跑进程里
 * 四十方 × 几十 KB 静静堆起来——用户要看原文时再看，看不到就说看不到。
 */
const MAX_RAW_PARTIES = 10

/** 上限的出厂值：只观测，绝不改写。 */
export const DEFAULT_LIMITS = Object.freeze({
  action: 'warn',
  totalChars: null,
  sections: {},
})

/**
 * 挂载本插件。
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文（含 systemPrompt）
 * @param {object} [config] cordis 行配置（见 cordis.patch.yml 注释）
 * @returns {object} 内部状态（供测试断言，不构成公开契约）
 */
export function apply(ctx, config = {}) {
  const opts = normalizeConfig(config)
  const state = createState(ctx, opts)

  observeAssemblies(ctx, state)
  if (opts.route) registerRoute(ctx, state)
  if (opts.tool) {
    registerReportTool(ctx, state)
    registerRequestTool(ctx, state)
  }
  // 有额度限制时，把「上限 + 申请通道」作为运行时上下文交给模型——
  // 不知道上限的模型不会压缩，这条提示就是这个功能的意义。
  syncNotice(ctx, state)

  log(ctx, 'info', `已挂载：限额来源=${state.source}，动作=${state.limits.action}，上限文件=${state.file}`)
  return state
}

/* ───────────────────────────── 配置与持久化 ───────────────────────────── */

/** 把行配置收敛成内部选项。 */
function normalizeConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  return {
    action: ACTION_KINDS.includes(raw.action) ? raw.action : DEFAULT_LIMITS.action,
    totalChars: positiveOrNull(raw.totalChars),
    sections: sanitizeSectionCaps(raw.sections),
    persist: raw.persist !== false,
    route: raw.route !== false,
    tool: raw.tool !== false,
    text: raw.text !== false,
    budgetNotice: raw.budgetNotice !== false,
    dynamic: Array.isArray(raw.dynamic) && raw.dynamic.length > 0
      ? raw.dynamic.map((prefix) => String(prefix)).filter((prefix) => prefix !== '')
      : [...DEFAULT_DYNAMIC_PREFIXES],
    provenance: raw.provenance && typeof raw.provenance === 'object' ? raw.provenance : {},
    provenanceNotes: raw.provenanceNotes && typeof raw.provenanceNotes === 'object' ? raw.provenanceNotes : {},
    log: raw.log === true,
  }
}

/** 行配置里的限额部分。 */
function fromConfig(opts) {
  return {
    action: opts.action,
    totalChars: opts.totalChars,
    sections: { ...opts.sections },
  }
}

/** $DSH_HOME（默认 ~/.dsh）——与生态里其它插件同一套规则。 */
function dshHome() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured !== '' ? configured : join(homedir(), '.dsh')
}

/** 限额文件位置：$DSH_HOME/storages/prompt-limiter/limits.json。 */
function limitsPath() {
  return join(dshHome(), 'storages', 'prompt-limiter', 'limits.json')
}

/** 建初始状态：文件优先于行配置（运行时改过的值才是用户的最新意图）。 */
function createState(ctx, opts) {
  const file = limitsPath()
  const persisted = readLimitsSync(file)
  const state = {
    ctx,
    opts,
    file,
    requestsFile: requestsPath(),
    limits: persisted ?? fromConfig(opts),
    source: persisted === null ? 'config' : 'file',
    parties: new Map(),
    events: [],
    errors: [],
    assemblies: 0,
    /** 现场探测的调用深度与目标（探测期间的组装归到目标名下、记为 probe）。 */
    probe: { depth: 0, target: null },
    /** 提额申请队列（Agent 申请 → 用户在面板批准/拒绝）。 */
    requests: readRequestsSync(),
    /** 预算提示这个运行时上下文的注销器；没有限额时为 null。 */
    noticeDisposer: null,
  }
  state.provenance = createProvenance({
    dshHome,
    declared: opts.provenance,
    notes: opts.provenanceNotes,
    log: (level, line) => log(ctx, level, line),
  })
  return state
}

/** 提额申请落盘位置。 */
function requestsPath() {
  return join(dshHome(), 'storages', 'prompt-limiter', 'requests.json')
}

/** 同步读一次申请队列（与限额同样：装载时读一次，之后异步写）。 */
function readRequestsSync() {
  try {
    const parsed = JSON.parse(readFileSync(requestsPath(), 'utf8'))
    const list = Array.isArray(parsed?.requests) ? parsed.requests : []
    return list.filter((request) => request && typeof request === 'object').slice(-MAX_REQUESTS)
  } catch {
    return []
  }
}

/** 落盘申请队列。 */
async function persistRequests(state) {
  if (!state.opts.persist) return false
  try {
    const json = `${JSON.stringify({ requests: state.requests, updatedAt: Date.now() }, null, 2)}\n`
    const tmp = `${state.requestsFile}.tmp`
    await mkdir(dirname(state.requestsFile), { recursive: true })
    await writeFile(tmp, json, 'utf8')
    await rename(tmp, state.requestsFile)
    return true
  } catch (error) {
    log(state.ctx, 'warn', `申请队列落盘失败：${messageOf(error)}`)
    return false
  }
}

/** 同步读一次限额文件（插件装载时的一次小读，之后不再同步 IO）。 */
function readLimitsSync(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return sanitizeLimits(parsed)
  } catch {
    return null
  }
}

/** 落盘（临时文件 + rename，避免半截文件）。 */
async function persistLimits(state) {
  if (!state.opts.persist) return false
  try {
    const json = `${JSON.stringify({ ...state.limits, updatedAt: Date.now() }, null, 2)}\n`
    const tmp = `${state.file}.tmp`
    await mkdir(dirname(state.file), { recursive: true })
    await writeFile(tmp, json, 'utf8')
    await rename(tmp, state.file)
    state.source = 'file'
    return true
  } catch (error) {
    log(state.ctx, 'warn', `限额落盘失败（本次改动仅在内存中生效）：${messageOf(error)}`)
    return false
  }
}

/* ───────────────────────────── 观测与执行 ───────────────────────────── */

/**
 * 注册组装观测（最外层 + 全局）。
 *
 * `prepend` 让本监听器排在链条最前 = 最外层：`await next()` 拿到的是所有 provider
 * 组装完、并经过其它插件 waterfall 之后的最终值，所以量到的是**真实进模型的那份**；
 * 返回裁剪后的值也因此能真正生效。
 * `global` 跳过作用域过滤：每个 Agent 各自作用域里派发的事件都要被我看到
 * （子智能体也要算“一方”）。
 */
function observeAssemblies(ctx, state) {
  ctx.on(EVENT_ASSEMBLE, async (assembly, _context, next) => {
    const produced = await next()
    try {
      // 现场探测（probe）不由驱动链发起，currentInitiator 为空，所以归到被探测的那个
      // Agent 名下，并且单独记为 probe —— 它不进 assemblies/latest/越限事件，
      // 免得把“主动问一次”混进“实际进模型的那次”。
      const probing = state.probe.depth > 0
      const partyId = probing ? state.probe.target : currentPartyId(ctx)
      const producedStats = measureAssembly(produced)
      const outcome = enforceLimits(produced, state.limits)
      // 留存的原文是**裁剪之后**的那份 —— 也就是真正进模型的东西。
      const effectiveAssembly = outcome.changed ? outcome.assembly : produced
      const effective = outcome.changed ? measureAssembly(effectiveAssembly) : producedStats
      if (probing) {
        rememberProbe(state, { partyId, stats: producedStats, assembly: effectiveAssembly })
      } else {
        remember(state, {
          partyId,
          produced: producedStats,
          effective,
          notes: outcome.notes,
          assembly: effectiveAssembly,
          from: 'observed',
        })
      }
      if (state.opts.log) {
        log(ctx, 'info', `${probing ? '探测' : '组装'} ${partyId ?? '(未归属)'}：${producedStats.totalChars} 字符 / ≈${producedStats.estTokens} token`)
      }
      return outcome.changed ? outcome.assembly : produced
    } catch (error) {
      rememberError(state, error)
      return produced
    }
  }, { prepend: true, global: true })
}

/** 当前这一跳属于哪一方（发起该异步驱动链的 Agent 的 SessionId）。 */
function currentPartyId(ctx) {
  try {
    const id = ctx.get('agents')?.currentInitiator?.()?.id
    return typeof id === 'string' && id !== '' ? id : null
  } catch {
    return null
  }
}

/** 量一次组装结果。纯函数。 */
export function measureAssembly(assembly) {
  const sections = listOf(assembly?.sections)
  const contexts = listOf(assembly?.contexts)
  const tools = listOf(assembly?.tools)

  const sectionStats = sections.map((section) => itemStats(section?.name, section?.text))
  const contextStats = contexts.map((context) => itemStats(context?.name, context?.text))
  const toolStats = tools.map((tool) => {
    const charCount = textLen(safeJson(tool))
    return {
      name: String(tool?.name ?? '(未命名)'),
      chars: charCount,
      estTokens: estimateTokens(safeJson(tool)),
      deferred: tool?.deferLoading === true,
    }
  })

  const sectionChars = sum(sectionStats, 'chars')
  const contextChars = sum(contextStats, 'chars')
  const toolChars = sum(toolStats, 'chars')
  return {
    at: Date.now(),
    totalChars: sectionChars + contextChars + toolChars,
    estTokens: sum(sectionStats, 'estTokens') + sum(contextStats, 'estTokens') + sum(toolStats, 'estTokens'),
    sectionChars,
    contextChars,
    toolChars,
    sections: sectionStats,
    contexts: contextStats,
    tools: { count: toolStats.length, chars: toolChars, items: toolStats },
    variables: assembly?.variables && typeof assembly.variables === 'object' ? Object.keys(assembly.variables).length : 0,
  }
}

/**
 * 按限额决定动不动手。纯函数，返回新的组装对象（仅在需要改动时）。
 *
 * 顺序（可预期地写在 README 里）：
 *  ① 逐段上限：命中即 `truncate`（截断并加标记）或 `drop`（整段移除）；
 *  ② 总上限：先扣掉「永不裁剪」的工具 schema 字符，剩下的预算按段落顺序
 *     （sections → contexts）走一遍：装得下的整段保留，第一个装不下的截断
 *     保留，**排在它后面的整段丢弃**（预算已尽，它们本来也装不下）。
 * 工具 schema 不动手：裁掉它等于改坏工具签名，那是另一类问题，报告里只标出来。
 * `warn` 模式下 `notes` 照记，但返回的组装对象与入参同一个引用（零改写）。
 */
export function enforceLimits(assembly, limits) {
  const notes = []
  if (!assembly || typeof assembly !== 'object') return { assembly, changed: false, notes }

  const action = ACTION_KINDS.includes(limits?.action) ? limits.action : 'warn'
  const caps = limits?.sections && typeof limits.sections === 'object' ? limits.sections : {}
  const sections = listOf(assembly.sections)
  const contexts = listOf(assembly.contexts)
  const tools = listOf(assembly.tools)

  let nextSections = sections
  let nextContexts = contexts
  let changed = false

  // ① 逐项上限。段落**和运行时上下文**都吃这套上限：用户要管的是「动态回写」
  //    的记忆/索引，它们既可能是 section 也可能是 context，按种类区别对待没有道理。
  const sectionCaps = applyItemCaps(sections, caps, action)
  if (sectionCaps.notes.length > 0) {
    notes.push(...sectionCaps.notes)
    nextSections = sectionCaps.items
    changed = changed || sectionCaps.changed
  }
  const contextCaps = applyItemCaps(contexts, caps, action)
  if (contextCaps.notes.length > 0) {
    notes.push(...contextCaps.notes)
    nextContexts = contextCaps.items
    changed = changed || contextCaps.changed
  }

  // ② 总上限。
  const totalCap = positiveOrNull(limits?.totalChars)
  if (totalCap !== null) {
    const toolChars = sum(listOf(tools).map((tool) => ({ chars: textLen(safeJson(tool)) })), 'chars')
    const currentTotal = sumChars(nextSections) + sumChars(nextContexts) + toolChars
    if (currentTotal > totalCap) {
      const budget = totalCap - toolChars
      const note = { scope: 'total', name: '(总计)', chars: currentTotal, limit: totalCap, action }
      if (budget <= 0) {
        // 光工具 schema 就超了：文本侧再怎么裁也救不回来，如实标注、不动手。
        notes.push({ ...note, unactionable: 'tools' })
      } else if (action === 'warn') {
        notes.push(note)
      } else {
        const walk = { left: budget, stopped: false, dropped: [], truncated: [] }
        const keptSections = applyBudget(nextSections, walk, action)
        const keptContexts = applyBudget(nextContexts, walk, action)
        notes.push({
          ...note,
          truncated: walk.truncated,
          dropped: walk.dropped,
          keptChars: sumChars(keptSections) + sumChars(keptContexts) + toolChars,
        })
        nextSections = keptSections
        nextContexts = keptContexts
        changed = true
      }
    }
  }

  if (!changed) return { assembly, changed: false, notes }
  return { assembly: { ...assembly, sections: nextSections, contexts: nextContexts }, changed: true, notes }
}

/**
 * 给一组条目（段落或上下文）套逐项上限。
 *
 * 返回新的列表、要记的越限说明、以及是否真的改过——`warn` 下列表原样返回
 * （同一个引用），只在 notes 里留下「谁超了」。
 *
 * @param {readonly object[]} items 段落或上下文
 * @param {Record<string, number>} caps 名字 → 字符上限（支持 `*` 兜底）
 * @param {string} action warn | truncate | drop
 */
function applyItemCaps(items, caps, action) {
  const hits = new Map()
  for (const item of items) {
    const name = String(item?.name ?? '(未命名)')
    const cap = capFor(caps, name)
    const charCount = textLen(item?.text)
    if (cap === null || charCount <= cap) continue
    hits.set(name, { scope: 'item', name, chars: charCount, limit: cap })
  }
  if (hits.size === 0) return { items, notes: [], changed: false }
  const notes = [...hits.values()].map((hit) => ({ ...hit, action }))
  if (action === 'truncate') {
    return {
      items: items.map((item) => {
        const hit = hits.get(String(item?.name ?? '(未命名)'))
        return hit === undefined ? item : { ...item, text: cutText(item?.text, hit.limit) }
      }),
      notes,
      changed: true,
    }
  }
  if (action === 'drop') {
    return {
      items: items.filter((item) => !hits.has(String(item?.name ?? '(未命名)'))),
      notes,
      changed: true,
    }
  }
  return { items, notes, changed: false }
}

/** 沿列表顺序花预算：装得下的留着，第一个装不下的截断，其余丢弃。 */
function applyBudget(list, walk, action) {
  const kept = []
  for (const item of list) {
    if (walk.stopped) {
      walk.dropped.push(nameOf(item))
      continue
    }
    const charCount = textLen(item?.text)
    if (charCount <= walk.left) {
      kept.push(item)
      walk.left -= charCount
      continue
    }
    if (action === 'truncate' && walk.left > MIN_TRUNCATE_CHARS) {
      const cut = cutText(item?.text, walk.left)
      kept.push({ ...item, text: cut })
      walk.truncated.push({ name: nameOf(item), chars: charCount, kept: textLen(cut) })
      walk.left = 0
      walk.stopped = true
      continue
    }
    walk.dropped.push(nameOf(item))
    walk.stopped = true
  }
  return kept
}

/**
 * 截到 cap 字符以内并追加标记。
 *
 * 保证返回值长度 ≤ cap（含标记）：先按预留位截正文，再按标记的实际长度回退，
 * 所以上限小到装不下标记时不会反而变长——那种情况只截断、不加标记。
 */
function cutText(text, cap) {
  const source = typeof text === 'string' ? text : ''
  const limit = Math.max(0, Math.floor(typeof cap === 'number' ? cap : 0))
  if (source.length <= limit) return source
  const marker = truncateMark(source.length)
  if (limit <= marker.length) return source.slice(0, limit)
  const keep = Math.max(0, limit - marker.length)
  return `${source.slice(0, keep)}${marker}`
}

/** 截断标记（长度随字符数变化，故调用方按实际长度回退）。 */
function truncateMark(droppedChars) {
  return `\n…[dsh-prompt-limiter: 超出上限，已截断 ${droppedChars} 字符]`
}

/** 取某段落的上限：精确名优先，其次 `*` 兜底，都没有则 null。 */
function capFor(caps, sectionName) {
  const exact = positiveOrNull(caps?.[sectionName])
  if (exact !== null) return exact
  return positiveOrNull(caps?.[DEFAULT_SECTION_CAP_KEY])
}

/* ───────────────────────────── 归档 ───────────────────────────── */

/** 把一次组装归到某一方名下。 */
function remember(state, entry) {
  const { partyId, produced, effective, notes, assembly, from } = entry
  const party = ensureParty(state, partyId, produced)
  party.assemblies += 1
  party.lastAt = produced.at
  party.latest = produced
  party.effective = effective
  party.trimmed = effective.totalChars !== produced.totalChars
  captureRaw(state, party, assembly, from)
  // 波动只在「实际进模型的那次」上判定：探测是主动问一次，混进来会让
  // 「动态回写」这一类被误标（探测拿到的组成本来就和实际那次不同）。
  if (from === 'observed') trackVolatility(party, assembly)
  if (produced.totalChars > party.peak.totalChars) {
    party.peak = { totalChars: produced.totalChars, at: produced.at }
  }
  if (notes.length > 0) {
    party.violations += notes.length
    for (const note of notes) {
      state.events.push({ at: produced.at, sessionId: partyId, ...note })
      if (state.events.length > MAX_EVENTS) state.events.shift()
    }
  }
  state.assemblies += 1
}

/**
 * 更新「谁在变」的实测记录。
 *
 * 判据就一句话：同一方两次组装之间，这一条的内容指纹变了 = 它在被动态回写。
 * 这比名字前缀可靠——它不需要猜作者给段落起了什么名。
 */
function trackVolatility(party, assembly) {
  const next = {}
  const mark = (kind, item) => {
    const name = nameOf(item)
    const text = typeof item?.text === 'string' ? item.text : safeJson(item)
    const key = `${kind}:${name}`
    const fingerprint = fingerprintOf(text)
    next[key] = fingerprint
    const previous = party.fingerprints?.[key]
    if (previous !== undefined && previous !== fingerprint) party.volatile[key] = true
  }
  for (const section of listOf(assembly?.sections)) mark('section', section)
  for (const context of listOf(assembly?.contexts)) mark('context', context)
  party.fingerprints = next
  party.volatileCount = Object.keys(party.volatile).length
}

/** 廉价的 djb2 指纹（长度 + 哈希），够用来判断「这一条变了没有」。 */
function fingerprintOf(text) {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0
  }
  return `${text.length}:${hash}`
}

/**
 * 这一条属于哪一类。
 *
 * `dynamic` = 动态回写（记忆注入、素材包、索引/目录…）：**上限该管的就是它**。
 * 判据顺序：实测波动 > 名字前缀 > 静态。工具 schema 单独一类，永不裁剪。
 */
function classifyItem(kind, name, party, opts) {
  if (kind === 'tool') return { kind: 'tool', dynamic: false, because: 'tool' }
  const key = `${kind === 'section' ? 'section' : 'context'}:${name}`
  if (party?.volatile?.[key] === true) return { kind: 'dynamic', dynamic: true, because: 'volatile' }
  for (const prefix of opts.dynamic) {
    if (String(name).startsWith(prefix)) return { kind: 'dynamic', dynamic: true, because: `prefix:${prefix}` }
  }
  return { kind: 'static', dynamic: false, because: 'static' }
}
/**
 * 记一次「现场探测」（probe=1）。
 *
 * 探测是主动问一次，不是实际进模型的那次：所以它不增加 assemblies、不覆盖
 * latest、也不产生越限事件，只挂在 party.probe 上，报告里分列显示。
 */
function rememberProbe(state, entry) {
  const { partyId, stats, assembly } = entry
  const party = ensureParty(state, partyId, stats)
  party.probe = {
    at: stats.at,
    totalChars: stats.totalChars,
    estTokens: stats.estTokens,
    sectionChars: stats.sectionChars,
    contextChars: stats.contextChars,
    toolChars: stats.toolChars,
    sectionCount: stats.sections.length,
    toolCount: stats.tools.count,
  }
  // 探测同样留存原文：点开看到的正文与旁边那个体量数字来自同一次组装
  // （是哪一次由 raw.from 标明，观察值以实际进模型的那次为准）。
  captureRaw(state, party, assembly, 'probe')
}

/**
 * 留存「具体提示词」原文。
 *
 * 存的是引用：段落/上下文文本、工具 schema 的 JSON 都是刚组装出来的那些字符串，
 * 只有被限额裁剪过的段落是新字符串。上限由 MAX_RAW_PARTIES 管。
 */
function captureRaw(state, party, assembly, from) {
  if (!state.opts.text || assembly === null || typeof assembly !== 'object') return
  const sections = listOf(assembly.sections).map((section) => ({
    name: nameOf(section),
    text: typeof section?.text === 'string' ? section.text : '',
  }))
  const contexts = listOf(assembly.contexts).map((context) => ({
    name: nameOf(context),
    text: typeof context?.text === 'string' ? context.text : '',
  }))
  const tools = listOf(assembly.tools).map((tool) => ({
    name: String(tool?.name ?? '(未命名)'),
    json: prettyJson(tool),
  }))
  party.raw = {
    at: Date.now(),
    from,
    chars: sections.reduce((n, section) => n + section.text.length, 0)
      + contexts.reduce((n, context) => n + context.text.length, 0)
      + tools.reduce((n, tool) => n + tool.json.length, 0),
    sections,
    contexts,
    tools,
  }
  pruneRaw(state)
}

/** 原文只保留最近动过的 MAX_RAW_PARTIES 方；体量记账不受影响。 */
function pruneRaw(state) {
  const holders = [...state.parties.values()].filter((party) => party.raw != null)
  if (holders.length <= MAX_RAW_PARTIES) return
  holders.sort((a, b) => (b.raw.at ?? 0) - (a.raw.at ?? 0))
  for (const party of holders.slice(MAX_RAW_PARTIES)) party.raw = null
}

/**
 * 路由用的原文视图。
 *
 * `available:false` 有三种诚实的原因，UI 各给一句人话：
 * 配置关掉了留存 / 没这一方 / 这一方还没组装过（或原文已被上限淘汰）。
 */
function rawView(state, party) {
  if (!state.opts.text) return { available: false, reason: 'text-disabled' }
  if (party === undefined) return { available: false, reason: 'unknown-party' }
  if (party.raw == null) return { available: false, reason: 'not-captured' }
  return {
    available: true,
    from: party.raw.from,
    at: party.raw.at,
    chars: party.raw.chars,
    trimmed: party.trimmed === true,
    producedChars: party.latest?.totalChars ?? null,
    effectiveChars: party.effective?.totalChars ?? null,
    sections: party.raw.sections,
    contexts: party.raw.contexts,
    tools: party.raw.tools,
  }
}

/** JSON 美化：工具 schema 是给人看的，别让人自己猜。 */
function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return ''
  }
}

/** 从一份原文视图里只取一项（给 curl 用；UI 通常一次抓整份再本地切）。 */
function selectRawItem(view, kind, name) {
  if (kind === 'section' || kind === 'context') {
    const list = kind === 'section' ? view.sections : view.contexts
    const found = list.find((item) => item.name === name)
    return found === undefined ? undefined : { chars: found.text.length, text: found.text }
  }
  if (kind === 'tool') {
    const found = view.tools.find((item) => item.name === name)
    return found === undefined ? undefined : { chars: found.json.length, text: found.json }
  }
  return undefined
}

/** 取出（必要时建立）某一方的归档位。 */
function ensureParty(state, partyId, seed) {
  const key = partyId ?? '(未归属)'
  let party = state.parties.get(key)
  if (party === undefined) {
    party = {
      key,
      sessionId: partyId,
      firstAt: seed.at,
      lastAt: seed.at,
      assemblies: 0,
      violations: 0,
      peak: { totalChars: seed.totalChars, at: seed.at },
      latest: seed,
      effective: seed,
      probe: null,
      raw: null,
      trimmed: false,
      /** 上一条观测的内容指纹（用来判「这一条在变吗」）。 */
      fingerprints: {},
      /** 实测变过的条目：`section:名字` / `context:名字`。 */
      volatile: {},
    }
    state.parties.set(key, party)
    pruneParties(state)
  }
  return party
}

/** 归档超过上限时，淘汰最久没动过的一方。 */
function pruneParties(state) {
  while (state.parties.size > MAX_PARTIES) {
    let oldestKey = null
    let oldestAt = Infinity
    for (const [key, party] of state.parties) {
      if (party.lastAt < oldestAt) {
        oldestAt = party.lastAt
        oldestKey = key
      }
    }
    if (oldestKey === null) return
    state.parties.delete(oldestKey)
  }
}

/** 记一条内部错误（不打断组装）。 */
function rememberError(state, error) {
  state.errors.push({ at: Date.now(), message: messageOf(error) })
  if (state.errors.length > MAX_ERRORS) state.errors.shift()
  log(state.ctx, 'warn', `观测失败（已忽略，不影响本次组装）：${messageOf(error)}`)
}

/* ───────────────────────────── 报告 ───────────────────────────── */

/**
 * 组装一份给 UI / 工具看的报告。
 * @param {object} ctx 宿主上下文
 * @param {object} state 插件状态
 * @param {boolean} probe 是否为每个在线 Agent 现场重新组装一次
 */
async function buildReport(ctx, state, probe) {
  const probed = probe ? await probeLiveAgents(ctx, state) : []
  const limits = state.limits
  const parties = []
  const known = new Set()

  // 先把「见过的名字」交给来源目录补扫一次（只扫没见过的，结果缓存）。
  const names = []
  for (const party of state.parties.values()) {
    for (const item of party.latest?.sections ?? []) names.push(item.name)
    for (const item of party.latest?.contexts ?? []) names.push(item.name)
  }
  state.provenance.ensure(names)

  for (const party of state.parties.values()) {
    parties.push(presentParty(ctx, party, limits, state.opts, state.provenance))
    if (party.sessionId) known.add(party.sessionId)
  }
  for (const agent of liveAgents(ctx)) {
    const id = String(agent?.id ?? '')
    if (id === '' || known.has(id)) continue
    parties.push({
      key: id,
      sessionId: id,
      live: true,
      header: sessionHeader(ctx, id),
      assemblies: 0,
      firstAt: null,
      lastAt: null,
      totalChars: 0,
      estTokens: 0,
      effectiveTotalChars: 0,
      peak: null,
      probe: null,
      hasText: false,
      trimmed: false,
      violations: 0,
      over: false,
      dynamic: { items: 0, chars: 0, volatileItems: 0, limited: 0, over: 0 },
      sources: [],
      sections: [],
      contexts: [],
      tools: { count: 0, chars: 0, items: [] },
      neverObserved: true,
    })
  }
  parties.sort((a, b) => b.totalChars - a.totalChars)

  return {
    generatedAt: Date.now(),
    package: name,
    build: BUILD,
    limitsPath: state.file,
    limitsSource: state.source,
    limits: { ...limits, sections: { ...limits.sections } },
    defaults: DEFAULT_LIMITS,
    enforcing: limits.action !== 'warn',
    observedAssemblies: state.assemblies,
    probed,
    parties,
    dynamic: summariseDynamic(parties),
    sources: summariseSources(parties),
    requests: [...state.requests].reverse(),
    notice: { active: state.noticeDisposer !== null, text: noticeText(state) },
    provenance: { ...state.provenance.info(), declared: state.opts.provenance },
    aggregate: aggregateSources(parties),
    events: [...state.events].reverse(),
    errors: state.errors,
    notes: REPORT_NOTES,
  }
}

/** 一方一行：附上会话头信息、来源、类别、逐段上限与越限标记。 */
function presentParty(ctx, party, limits, opts, provenance) {
  const latest = party.latest ?? emptyMeasure()
  const effective = party.effective ?? latest
  /** 给一条明细补上：来源插件、类别（动态回写/静态/工具）、越限。 */
  const annotate = (kind, item) => {
    const limit = capFor(limits.sections, item.name)
    const classification = classifyItem(kind, item.name, party, opts)
    return {
      ...item,
      limit,
      over: isOver(item.chars, limit),
      source: provenance.of(item.name),
      class: classification.kind,
      dynamic: classification.dynamic,
      dynamicBecause: classification.because,
    }
  }
  const sections = latest.sections.map((section) => annotate('section', section))
  const contexts = latest.contexts.map((context) => annotate('context', context))
  const tools = (latest.tools?.items ?? []).map((tool) => annotate('tool', tool))
  const totalLimit = positiveOrNull(limits.totalChars)

  /** 这一方的分项按来源插件汇总（「谁占了我多少」的直接答案）。 */
  const bySource = new Map()
  const addSource = (item) => {
    const plugin = item.source?.plugin ?? '(未知来源)'
    const bucket = bySource.get(plugin) ?? {
      plugin,
      basis: item.source?.basis ?? 'unknown',
      chars: 0,
      items: 0,
      dynamicChars: 0,
      dynamicItems: 0,
    }
    bucket.chars += item.chars
    bucket.items += 1
    if (item.dynamic) {
      bucket.dynamicChars += item.chars
      bucket.dynamicItems += 1
    }
    bySource.set(plugin, bucket)
  }
  for (const item of [...sections, ...contexts]) addSource(item)

  const dynamicItems = [...sections, ...contexts].filter((item) => item.dynamic)
  return {
    key: party.key,
    sessionId: party.sessionId,
    live: party.sessionId !== null && isLive(ctx, party.sessionId),
    header: sessionHeader(ctx, party.sessionId),
    assemblies: party.assemblies,
    firstAt: party.firstAt,
    lastAt: party.lastAt,
    totalChars: latest.totalChars,
    estTokens: latest.estTokens,
    sectionChars: latest.sectionChars,
    contextChars: latest.contextChars,
    toolChars: latest.toolChars,
    effectiveTotalChars: effective.totalChars,
    peak: party.peak,
    probe: party.probe ?? null,
    // 有没有「具体提示词」可点开看（正文本身走 /text 懒加载，报告只带这面旗）。
    hasText: party.raw != null,
    rawAt: party.raw?.at ?? null,
    rawFrom: party.raw?.from ?? null,
    trimmed: party.trimmed === true,
    violations: party.violations,
    /** 动态回写这一类的体量：上限真正要管的部分。 */
    dynamic: {
      items: dynamicItems.length,
      chars: dynamicItems.reduce((total, item) => total + item.chars, 0),
      volatileItems: Object.keys(party.volatile ?? {}).length,
      limited: dynamicItems.filter((item) => item.limit !== null).length,
      over: dynamicItems.filter((item) => item.over).length,
    },
    sources: [...bySource.values()].sort((a, b) => b.chars - a.chars),
    sections,
    contexts,
    tools: { count: tools.length, chars: latest.tools?.chars ?? 0, items: tools },
    over: sections.some((section) => section.over)
      || contexts.some((context) => context.over)
      || isOver(latest.totalChars, totalLimit),
  }
}

/** 全局：动态回写这一类有多少、被限了多少。 */
function summariseDynamic(parties) {
  const totals = { items: 0, chars: 0, volatileItems: 0, limited: 0, over: 0 }
  for (const party of parties) {
    const dynamic = party.dynamic ?? { items: 0, chars: 0, volatileItems: 0, limited: 0, over: 0 }
    totals.items += dynamic.items
    totals.chars += dynamic.chars
    totals.volatileItems += dynamic.volatileItems
    totals.limited += dynamic.limited
    totals.over += dynamic.over
  }
  return totals
}

/** 全局：按来源插件汇总（「哪个插件占了我多少」的直接答案）。 */
function summariseSources(parties) {
  const buckets = new Map()
  for (const party of parties) {
    for (const source of party.sources ?? []) {
      const bucket = buckets.get(source.plugin) ?? {
        plugin: source.plugin,
        basis: source.basis,
        chars: 0,
        items: 0,
        dynamicChars: 0,
        dynamicItems: 0,
        parties: 0,
      }
      bucket.chars += source.chars
      bucket.items += source.items
      bucket.dynamicChars += source.dynamicChars
      bucket.dynamicItems += source.dynamicItems
      bucket.parties += 1
      buckets.set(source.plugin, bucket)
    }
  }
  return [...buckets.values()].sort((a, b) => b.chars - a.chars)
}

/* ─────────────────── 预算提示：让模型知道上限（并申请提升） ─────────────────── */

/**
 * 有额度限制时，把「预算提示」注册成一个运行时上下文；没有就注销。
 *
 * 这一步是整个功能的闭环：**只知道体积没用，模型不知道上限就不会压缩**。
 * 所以限额一改（POST /limits、批准申请）就重新同步一次。
 */
function syncNotice(ctx, state) {
  const wanted = state.opts.budgetNotice && hasConfiguredLimits(state.limits)
  if (wanted && state.noticeDisposer === null) {
    try {
      state.noticeDisposer = ctx.systemPrompt.context({
        name: NOTICE_CONTEXT_NAME,
        order: NOTICE_ORDER,
        text: () => noticeText(state),
      })
      log(ctx, 'info', '已注入「提示词预算」上下文：模型会看到上限，并可经 prompt_budget_request 申请提升')
    } catch (error) {
      log(ctx, 'warn', `预算提示注入失败（其余功能不受影响）：${messageOf(error)}`)
    }
    return
  }
  if (!wanted && state.noticeDisposer !== null) {
    try {
      state.noticeDisposer()
    } catch {
      /* 已经注销过也无妨 */
    }
    state.noticeDisposer = null
  }
}

/** 配了任何一条上限吗？（没有就不该占提示词的位置） */
function hasConfiguredLimits(limits) {
  return positiveOrNull(limits?.totalChars) !== null
    || Object.keys(limits?.sections ?? {}).length > 0
}

/**
 * 预算提示的正文——**这段字是写给模型看的**。
 *
 * 只说三件事：哪些条目有上限、超限会怎样、怎么申请提升。带上「上一跳实测」
 * 让模型知道自己离上限还有多远（有实测就给，没有就省掉，不编数字）。
 */
function noticeText(state) {
  const limits = state.limits
  if (!state.opts.budgetNotice || !hasConfiguredLimits(limits)) return ''
  const sizes = latestSizes(state)
  const caps = Object.entries(limits.sections ?? {})
    .filter(([name, cap]) => positiveOrNull(cap) !== null && name !== DEFAULT_SECTION_CAP_KEY)
  const lines = caps.slice(0, Math.max(1, NOTICE_MAX_LINES - 1)).map(([name, cap]) => {
    const source = state.provenance.of(name)
    const measured = sizes.get(name)
    return `· ${name}${source.plugin ? `（${source.plugin}）` : ''} ≤ ${cap} 字符`
      + (measured === undefined ? '' : `，上一跳实测 ${measured}`)
  })
  const hidden = caps.length - lines.length
  if (hidden > 0) lines.push(`· …另有 ${hidden} 条上限（见「提示词控制器」面板）`)
  const totalCap = positiveOrNull(limits.totalChars)
  if (totalCap !== null) lines.push(`· 系统提示词总计 ≤ ${totalCap} 字符`)
  if (lines.length === 0) return ''
  return [
    '【提示词预算·dsh-prompt-limiter】以下内容有上限，超出会被截断或丢弃；',
    '请主动压缩你自己写入的内容（记忆条目、索引、素材包宁短勿滥）：',
    ...lines,
    `超限动作：${limits.action === 'warn' ? '只记录（当前不改写）' : limits.action === 'drop' ? '整条丢弃' : '截断'}。`,
    '确实需要更多空间：调用 prompt_budget_request（scope=section|context|total、name、wantChars、reason）提交申请，用户在「提示词控制器」面板批准后生效。',
  ].join('\n')
}

/** 各条目的最近实测字符数（同名取最大，跨方）。 */
function latestSizes(state) {
  const sizes = new Map()
  for (const party of state.parties.values()) {
    for (const item of [...(party.latest?.sections ?? []), ...(party.latest?.contexts ?? [])]) {
      const current = sizes.get(item.name)
      if (current === undefined || item.chars > current) sizes.set(item.name, item.chars)
    }
  }
  return sizes
}

/* ───────────────────────────── 提额申请 ───────────────────────────── */

/** 校验一条申请（校验不通过就明说哪里不对，别让模型猜）。 */
function validateRequest(args) {
  const scope = args?.scope
  if (!['section', 'context', 'total'].includes(scope)) return { error: 'scope 必须是 section / context / total' }
  const wantChars = positiveOrNull(args?.wantChars)
  if (wantChars === null) return { error: 'wantChars 必须是正整数' }
  const reason = typeof args?.reason === 'string' ? args.reason.trim() : ''
  if (reason === '') return { error: 'reason 不可为空：说清为什么需要，用户据此判断' }
  const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : null
  if (scope !== 'total' && name === null) return { error: 'scope 是具体条目时必须给 name' }
  return { scope, name, wantChars, reason: reason.slice(0, 400) }
}

/** 当前生效的额度（给申请做对照；`*` 兜底也算数）。 */
function currentCapFor(limits, scope, name) {
  if (scope === 'total') return positiveOrNull(limits.totalChars)
  const exact = positiveOrNull(limits.sections?.[name])
  return exact ?? capFor(limits.sections, name)
}

/** 建一条待批准申请。 */
function createRequest(state, input, partyId) {
  const request = {
    id: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
    sessionId: partyId ?? null,
    scope: input.scope,
    name: input.name,
    wantChars: input.wantChars,
    current: currentCapFor(state.limits, input.scope, input.name),
    reason: input.reason,
    status: 'pending',
  }
  state.requests.push(request)
  if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS)
  return request
}

/**
 * 批准 / 拒绝一条申请。
 *
 * 批准才改额度：**能不能多给上下文，是人的判断，不是模型自己的判断**——
 * 所以这里只落记录，决定权在面板上点按钮的那个人。
 */
async function decideRequest(state, id, approve) {
  const request = state.requests.find((item) => item.id === id)
  if (request === undefined) return null
  if (request.status !== 'pending') return request
  request.status = approve ? 'approved' : 'rejected'
  request.decidedAt = Date.now()
  if (approve) {
    if (request.scope === 'total') state.limits = { ...state.limits, totalChars: request.wantChars }
    else state.limits = { ...state.limits, sections: { ...state.limits.sections, [request.name]: request.wantChars } }
  }
  await persistRequests(state)
  if (approve) {
    await persistLimits(state)
    syncNotice(state.ctx, state)
    log(state.ctx, 'info', `提额申请 ${request.id} 已批准：${request.scope} ${request.name ?? ''} → ${request.wantChars} 字符`)
  }
  return request
}

/** 注册 prompt_budget_request：模型唯一的申请通道。 */
function registerRequestTool(ctx, state) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['tools'], (scope) => {
    try {
      scope.tools.register({
        name: 'prompt_budget_request',
        description: '为系统提示词的额度申请提升上限。当某个动态回写条目（记忆注入、素材包、索引等）已接近或触到上限，而你判断确实需要更多空间时调用：给出 scope（section/context/total）、name、wantChars 与理由。申请进入「提示词控制器」面板等用户批准；批准前请按现有上限主动压缩，不要指望被截断兜底。',
        parameters: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['section', 'context', 'total'], description: '申请哪一类：具体条目（section/context）或总上限' },
            name: { type: 'string', description: '条目名（scope=total 时可省）' },
            wantChars: { type: 'number', description: '希望提升到的字符上限' },
            reason: { type: 'string', description: '为什么需要（用户据此判断，不可为空）' },
          },
          required: ['scope', 'wantChars', 'reason'],
        },
        output: {
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
          const validated = validateRequest(args)
          if (validated.error !== undefined) return { ok: false, error: validated.error }
          const request = createRequest(state, validated, currentPartyId(ctx))
          await persistRequests(state)
          log(ctx, 'info', `收到提额申请 ${request.id}：${request.scope} ${request.name ?? ''} → ${request.wantChars} 字符（待批准）`)
          return {
            ok: true,
            id: request.id,
            status: 'pending',
            current: request.current,
            wantChars: request.wantChars,
            note: '申请已提交，等用户在「提示词控制器」面板批准；在此之前请按现有上限主动压缩。',
          }
        },
      })
    } catch (error) {
      log(ctx, 'warn', `prompt_budget_request 注册失败：${messageOf(error)}`)
    }
  })
}

/** 把各方的分项按“来源名”横向汇总（谁最占地方，一眼看到）。 */
function aggregateSources(parties) {
  const buckets = new Map()
  const push = (kind, item) => {
    const key = `${kind}:${item.name}`
    const bucket = buckets.get(key) ?? {
      kind,
      name: item.name,
      chars: 0,
      estTokens: 0,
      parties: 0,
      class: item.class ?? (kind === 'tool' ? 'tool' : 'static'),
      dynamic: item.dynamic === true,
      source: item.source ?? { plugin: null, basis: 'unknown', note: null },
      limit: item.limit ?? null,
    }
    bucket.chars += item.chars
    bucket.estTokens += item.estTokens
    bucket.parties += 1
    if (item.limit !== null && item.limit !== undefined) bucket.limit = item.limit
    buckets.set(key, bucket)
  }
  for (const party of parties) {
    for (const section of party.sections ?? []) push('section', section)
    for (const context of party.contexts ?? []) push('context', context)
    for (const tool of party.tools?.items ?? []) push('tool', tool)
  }
  return [...buckets.values()].sort((a, b) => b.chars - a.chars)
}

const REPORT_NOTES = Object.freeze([
  '字符数是精确值；token 是启发式估算（ASCII ≈ 4 字符/token，非 ASCII ≈ 1.5 字符/token），中文为主时误差通常在 ±15%。',
  '总计 = 静态段落 + 运行时动态上下文 + 工具 schema。',
  '归因来自 ctx.agents.currentInitiator()；取不到时归入“(未归属)”。',
  '「现场探测」是主动问一次（agentPresets.serviceFor(agent, \'systemPrompt\').assemble），单独记录、不混进实际观测；它拿不到的私有 provider 会让数值偏小，以实际观测为准。',
  '「具体提示词」正文走 /text 懒加载：留存的是**裁剪之后**、真正进模型的那份（行配置 text:false 可关掉留存）。',
  '「来源」分三层证据并在 UI 里标明：config（你写死的映射）> code（扫描设备上插件的源码，看谁提到了这个名字）> prefix（按 DSH 命名约定推定核心归属）。都不是运行时拦截所得——DSH 的 systemPrompt 不记录注册者。',
  '「动态回写」= 记忆注入/素材包/索引一类：判据是**实测波动**（同一方两次组装之间内容变了）优先，名字前缀兜底。上限默认只对着它，静态段落与工具 schema 不该被随手裁。',
  '配了任何一条上限时，本插件会注入一段「提示词预算」上下文（名字 prompt-limiter:budget），把上限与申请通道告诉模型——模型不知道上限就不会主动压缩。',
  '观测数据只在内存中，进程重启即清空；限额配置落在 limits.json，重启后仍在。',
  'action=warn（默认）时本插件绝不改写提示词，只记账与告警。',
])

/* ───────────────────────────── 在线探测 ───────────────────────────── */

/**
 * 为每个在线 Agent 现场组装一次提示词（在它自己的作用域里），
 * 让报告不缺“还没组装过”的一方。逐个 try/catch：一个失败不影响其它。
 */
async function probeLiveAgents(ctx, state) {
  const results = []
  for (const agent of liveAgents(ctx)) {
    const id = String(agent?.id ?? '')
    if (id === '') continue
    state.probe.target = id
    state.probe.depth += 1
    try {
      const assembly = await assembleFor(ctx, agent)
      if (assembly === undefined) {
        results.push({ sessionId: id, ok: false, error: '该 profile 没有可用的按 Agent 组装入口' })
        continue
      }
      const stats = measureAssembly(assembly)
      results.push({
        sessionId: id,
        ok: true,
        totalChars: stats.totalChars,
        estTokens: stats.estTokens,
        sectionChars: stats.sectionChars,
        contextChars: stats.contextChars,
        toolChars: stats.toolChars,
        sectionCount: stats.sections.length,
        toolCount: stats.tools.count,
      })
    } catch (error) {
      results.push({ sessionId: id, ok: false, error: messageOf(error) })
    } finally {
      state.probe.depth -= 1
      if (state.probe.depth <= 0) {
        state.probe.depth = 0
        state.probe.target = null
      }
    }
  }
  return results
}

/**
 * 在某个 Agent 的作用域里组装一次提示词。
 * 首选 agentPresets.serviceFor（拿到的是该 Agent 作用域里的 systemPrompt），
 * 退回直接读 agent.ctx.systemPrompt。
 */
async function assembleFor(ctx, agent) {
  try {
    const scoped = ctx.get('agentPresets')?.serviceFor?.(agent, 'systemPrompt')
    if (scoped !== undefined && typeof scoped.assemble === 'function') return await scoped.assemble({})
  } catch {
    /* 落到下一条路径 */
  }
  try {
    const scoped = agent?.ctx?.systemPrompt
    if (scoped !== undefined && typeof scoped.assemble === 'function') return await scoped.assemble({})
  } catch {
    /* 两条路径都不通 */
  }
  return undefined
}

/* ───────────────────────────── HTTP 路由 ───────────────────────────── */

/** 注册 /prompt-limiter（webServer 只在 web profile 存在，故走作用域 inject）。 */
function registerRoute(ctx, state) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['webServer'], (scope) => {
    try {
      scope.effect(() => scope.webServer.register({
        name: 'dsh-prompt-limiter',
        kind: 'prefix',
        path: ROUTE_PATH,
        handler: (req, res) => { void handleRequest(ctx, state, req, res) },
      }), 'dsh-prompt-limiter: /prompt-limiter 路由')
    } catch (error) {
      log(ctx, 'warn', `路由注册失败，设置页卡片将不可用：${messageOf(error)}`)
    }
  })
}

/** 一条请求：围栏 → 分发 → JSON 应答。 */
async function handleRequest(ctx, state, req, res) {
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  if (!isTrustedApiRequest(req, trustedHostsOf(ctx))) {
    send(403, { ok: false, error: 'forbidden' })
    return
  }

  let url
  try {
    url = new URL(req.url ?? '/', 'http://dsh.internal')
  } catch {
    send(400, { ok: false, error: 'bad-url' })
    return
  }
  const route = url.pathname.startsWith(ROUTE_PATH) ? url.pathname.slice(ROUTE_PATH.length) : ''

  try {
    if (req.method === 'GET' && (route === '' || route === '/' || route === '/report')) {
      send(200, await buildReport(ctx, state, url.searchParams.get('probe') === '1'))
      return
    }
    if (req.method === 'GET' && route === '/text') {
      // 「具体提示词」原文：按方取整份（UI 一次抓完再本地切），也可带 kind+name 只取一项。
      const partyKey = url.searchParams.get('party')
      if (partyKey === null || partyKey === '') {
        send(400, { ok: false, error: 'party-required' })
        return
      }
      // 三种「看不到」都如实说清原因，不装作没有这个功能、也不给空壳。
      if (!state.opts.text) {
        send(200, { ok: true, party: partyKey, available: false, reason: 'text-disabled' })
        return
      }
      const party = state.parties.get(partyKey)
      if (party === undefined) {
        // 报告里列着这一方（在线但还没组装过）≠ 这一方不存在：前者说「还没留存」，
        // 后者才是 404。混为一谈会让 UI 把在线子智能体说成「未归属」。
        const known = liveAgents(ctx).some((agent) => String(agent?.id ?? '') === partyKey)
        send(known ? 200 : 404, {
          ok: true,
          party: partyKey,
          available: false,
          reason: known ? 'not-captured' : 'unknown-party',
        })
        return
      }
      const view = rawView(state, party)
      if (!view.available) {
        send(200, { ok: true, party: partyKey, ...view })
        return
      }
      const kind = url.searchParams.get('kind')
      const name = url.searchParams.get('name')
      if (kind !== null && name !== null) {
        const single = selectRawItem(view, kind, name)
        if (single === undefined) {
          send(404, { ok: false, error: 'unknown-item', party: partyKey, kind, name })
          return
        }
        send(200, { ok: true, party: partyKey, from: view.from, at: view.at, kind, name, ...single })
        return
      }
      send(200, { ok: true, party: partyKey, sessionId: party.sessionId, ...view })
      return
    }
    if (req.method === 'GET' && route === '/limits') {
      send(200, { ok: true, ...limitsView(state) })
      return
    }
    if (req.method === 'POST' && route === '/limits') {
      const body = await readJsonBody(req)
      const next = sanitizeSubmittedLimits(body)
      if (next === null) {
        send(400, { ok: false, error: 'invalid-limits', ...limitsView(state) })
        return
      }
      state.limits = next
      const persisted = await persistLimits(state)
      // 限额一改就同步预算提示：模型看到的上限必须与刚保存的一致。
      syncNotice(ctx, state)
      log(ctx, 'info', `限额已更新：动作=${next.action}，总上限=${next.totalChars ?? '无'}，逐段 ${Object.keys(next.sections).length} 条，落盘=${persisted}`)
      send(200, { ok: true, persisted, ...limitsView(state) })
      return
    }
    if (req.method === 'POST' && route === '/limits/reset') {
      state.limits = fromConfig(state.opts)
      const persisted = await persistLimits(state)
      syncNotice(ctx, state)
      send(200, { ok: true, persisted, ...limitsView(state) })
      return
    }
    if (req.method === 'GET' && route === '/budget') {
      const pending = state.requests.filter((request) => request.status === 'pending')
      send(200, {
        ok: true,
        requests: [...state.requests].reverse(),
        pending,
        notice: { active: state.noticeDisposer !== null, text: noticeText(state) },
      })
      return
    }
    if (req.method === 'POST' && route === '/budget/decide') {
      const body = await readJsonBody(req)
      const id = typeof body?.id === 'string' ? body.id : ''
      if (id === '') {
        send(400, { ok: false, error: 'id-required' })
        return
      }
      const decided = await decideRequest(state, id, body?.approve === true)
      if (decided === null) {
        send(404, { ok: false, error: 'unknown-request', id })
        return
      }
      send(200, { ok: true, request: decided, ...limitsView(state) })
      return
    }
    send(404, { ok: false, error: 'not-found' })
  } catch (error) {
    send(500, { ok: false, error: messageOf(error) })
  }
}

/** 设置页要的那份限额视图。 */
function limitsView(state) {
  return {
    limits: { ...state.limits, sections: { ...state.limits.sections } },
    defaults: DEFAULT_LIMITS,
    limitsPath: state.file,
    limitsSource: state.source,
    actions: ACTION_KINDS,
    defaultSectionCapKey: DEFAULT_SECTION_CAP_KEY,
    notes: REPORT_NOTES,
  }
}

/** 本部署信任的非回环权威（没有就只认回环）。 */
function trustedHostsOf(ctx) {
  try {
    const hosts = ctx.get('webRuntime')?.trustedHosts
    return Array.isArray(hosts) ? hosts : []
  } catch {
    return []
  }
}

/** 读 JSON 请求体（有上限，超限即抛）。 */
async function readJsonBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY_BYTES) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/* ───────────────────────────── Agent 工具 ───────────────────────────── */

/** 注册 prompt_size_report：让 Agent 自己也能查。 */
function registerReportTool(ctx, state) {
  if (typeof ctx.inject !== 'function') return
  ctx.inject(['tools'], (scope) => {
    try {
      scope.tools.register({
        name: 'prompt_size_report',
        description: '查看各方（每个 Agent / 子智能体）系统提示词的大小：静态段落、运行时上下文、工具 schema 的字符数与 ≈token 估算，以及逐段/总上限配置和最近的越限事件。需要某个在线 Agent 此刻的确切组成时传 probe=true（会在它自己的作用域里现场组装一次）。',
        parameters: {
          type: 'object',
          properties: {
            probe: {
              type: 'boolean',
              description: '是否为每个在线 Agent 现场重新组装一次（更准，代价是一次组装）',
            },
          },
          required: [],
        },
        output: {
          render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
          const report = await buildReport(ctx, state, args?.probe === true)
          return {
            ...report,
            // 工具结果给模型看的是压缩版：明细留给 Web 面板。
            parties: report.parties.map((party) => ({
              sessionId: party.sessionId,
              live: party.live,
              origin: party.header?.origin ?? null,
              agentPreset: party.header?.agentPreset ?? null,
              assemblies: party.assemblies,
              totalChars: party.totalChars,
              estTokens: party.estTokens,
              probe: party.probe,
              topSections: [...party.sections].sort((a, b) => b.chars - a.chars).slice(0, 8),
              toolCount: party.tools?.count ?? 0,
              toolChars: party.toolChars,
              over: party.over,
            })),
            aggregate: report.aggregate.slice(0, 20),
          }
        },
      })
    } catch (error) {
      log(ctx, 'warn', `prompt_size_report 工具注册失败：${messageOf(error)}`)
    }
  })
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

/** 量一段文本。 */
function itemStats(rawName, text) {
  return {
    name: String(rawName ?? '(未命名)'),
    chars: textLen(text),
    estTokens: estimateTokens(text),
  }
}

/** 字符数（非字符串记 0，绝不为 NaN）。 */
function textLen(text) {
  return typeof text === 'string' ? text.length : 0
}

/**
 * ≈token 估算：ASCII ≈ 4 字符/token，非 ASCII（CJK 等）≈ 1.5 字符/token。
 * 这是估算，不是分词器。字符数才是精确值。
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let ascii = 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 128) ascii += 1
    else wide += 1
  }
  return Math.round(ascii / 4 + wide / 1.5)
}

/** 只接受正数，其余（0/负数/NaN/字符串/undefined）= 不限制。 */
function positiveOrNull(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number) || number <= 0) return null
  return Math.floor(number)
}

/** 段落名 → 上限 的净化：只留正整数。 */
function sanitizeSectionCaps(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const cleaned = {}
  for (const [key, value] of Object.entries(raw)) {
    const name = String(key).trim()
    if (name === '') continue
    const cap = positiveOrNull(value)
    if (cap !== null) cleaned[name] = cap
  }
  return cleaned
}

/** 一份持久化/提交上来的限额是否可用。 */
function sanitizeLimits(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    action: ACTION_KINDS.includes(raw.action) ? raw.action : DEFAULT_LIMITS.action,
    totalChars: positiveOrNull(raw.totalChars),
    sections: sanitizeSectionCaps(raw.sections),
  }
}

/** UI 提交的限额：非法即 null（区别于“合法但为空”）。 */
function sanitizeSubmittedLimits(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (raw.action !== undefined && !ACTION_KINDS.includes(raw.action)) return null
  if (raw.sections !== undefined && raw.sections !== null
    && (typeof raw.sections !== 'object' || Array.isArray(raw.sections))) return null
  return sanitizeLimits(raw)
}

/** 数组化（非数组一律空数组，避免 undefined 传播）。 */
function listOf(value) {
  return Array.isArray(value) ? value : []
}

/** 求和某个数值字段。 */
function sum(items, field) {
  let total = 0
  for (const item of items) total += typeof item?.[field] === 'number' ? item[field] : 0
  return total
}

/** 段落列表的字符总和。 */
function sumChars(items) {
  let total = 0
  for (const item of items) total += textLen(item?.text)
  return total
}

/** 段落名。 */
function nameOf(item) {
  return String(item?.name ?? '(未命名)')
}

/** JSON 序列化（失败记空串，不抛）。 */
function safeJson(value) {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** 是否越限。 */
function isOver(chars, limit) {
  return limit !== null && limit !== undefined && chars > limit
}

/** 所有在线 Agent。 */
function liveAgents(ctx) {
  try {
    return listOf(ctx.get('agents')?.list?.())
  } catch {
    return []
  }
}

/** 某个 Session 是否在线。 */
function isLive(ctx, sessionId) {
  try {
    return ctx.get('agents')?.get?.(sessionId) !== undefined
  } catch {
    return false
  }
}

/** 会话头（出身、父会话、深度、预设、cwd）——子智能体与主 Agent 的区分依据。 */
function sessionHeader(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  try {
    const header = ctx.get('sessions')?.get?.(sessionId)?.header
    if (!header || typeof header !== 'object') return null
    return {
      cwd: header.cwd ?? null,
      parentSession: header.parentSession ?? null,
      origin: header.origin ?? null,
      delegationDepth: typeof header.delegationDepth === 'number' ? header.delegationDepth : null,
      agentPreset: header.agentPreset ?? null,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : null,
    }
  } catch {
    return null
  }
}

/** 空量测（还没观测过的一方）。 */
function emptyMeasure() {
  return {
    at: 0,
    totalChars: 0,
    estTokens: 0,
    sectionChars: 0,
    contextChars: 0,
    toolChars: 0,
    sections: [],
    contexts: [],
    tools: { count: 0, chars: 0, items: [] },
    variables: 0,
  }
}

/** 错误消息。 */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/** 日志：优先宿主 logger，缺失退回 console。 */
function log(ctx, level, line) {
  const logger = ctx?.logger
  const method = logger?.[level]
  if (typeof method === 'function') {
    try {
      method.call(logger, `[dsh-prompt-limiter] ${line}`)
      return
    } catch {
      /* 落到 console */
    }
  }
  if (level === 'error') console.error(`[dsh-prompt-limiter] ${line}`)
  else if (level === 'warn') console.warn(`[dsh-prompt-limiter] ${line}`)
  else console.log(`[dsh-prompt-limiter] ${line}`)
}

/** 纯函数面（测试用，不构成公开契约）。 */
export const __internal = {
  measureAssembly,
  enforceLimits,
  estimateTokens,
  sanitizeLimits,
  sanitizeSubmittedLimits,
  sanitizeSectionCaps,
  positiveOrNull,
  capFor,
  cutText,
  limitsPath,
  validateRequest,
  classifyItem,
  fingerprintOf,
  DEFAULT_LIMITS,
}
