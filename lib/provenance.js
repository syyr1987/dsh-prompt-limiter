/**
 * 来源插件目录（provenance）：这一条提示词条目**是谁放进去的**。
 *
 * 为什么不是随口猜：DSH 的 systemPrompt 服务不记录注册者——`section()`/`context()`
 * 只告诉你名字，谁注册的它不说。所以这里用三层**可核对的**证据，并且把每层的
 * 强度如实标在结果里（`basis`），UI 上也不隐藏：
 *
 *   1. `config` —— 用户在行配置/限额文件里写死的映射，最强，也最容易被用户纠正；
 *   2. `code`   —— 扫 profile 的直接依赖包，看**哪个插件的源码里出现了这个段落名**。
 *                  实测：`soul:memory|identity|judgment` 都字面出现在
 *                  dsh-linghun/index.js 里（`const SECTION_MEMORY = "soul:memory"`），
 *                  所以这一层对第三方插件是真凭据，而不是名字猜谜；
 *   3. `prefix` —— 按 DSH 内部命名约定推定核心归属（`tool:`、`ui:`、`harness:`…），
 *                  标为推定，因为它就是推定。
 *
 * 扫描是只读的、有界的（只看 profile 的直接依赖、限文件数与总字节数），
 * 结果缓存在内存里，只在「出现了没见过的名字」或显式要求时重扫。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 核心包的前缀归属表：推定，不是实测。 */
const CORE_PREFIXES = [
  // 本插件自己注入的上下文（`prompt-limiter:budget`）：自报家门，别让扫描去猜。
  ['prompt-limiter:', 'dsh-prompt-limiter（本插件）'],
  ['tool:', '@deepseek-ai/dsh-tools（工具注册项）'],
  ['ui:', '@deepseek-ai/dsh-client-ui-*（界面/交付事实）'],
  ['app:', '@deepseek-ai/dsh-web-app'],
  ['web:', '@deepseek-ai/dsh-web-app'],
  ['agents:', '@deepseek-ai/dsh-agent'],
  ['agent:', '@deepseek-ai/dsh-agent'],
  ['harness:', '@deepseek-ai/dsh-base'],
  ['context:', '@deepseek-ai/dsh-base（运行时上下文）'],
  ['approval:', '@deepseek-ai/dsh-user-approval'],
  ['sandbox:', '@deepseek-ai/dsh-sandbox-policy'],
  ['session:', '@deepseek-ai/dsh-session*'],
  ['fs:', '@deepseek-ai/dsh-fs-*'],
  ['goal:', '@deepseek-ai/dsh-goal'],
  ['plan:', '@deepseek-ai/dsh-plan-mode'],
  ['subagent:', '@deepseek-ai/dsh-subagent'],
  ['workflow:', '@deepseek-ai/dsh-workflow-ptc'],
  ['jobs:', '@deepseek-ai/dsh-jobs-local'],
]

/** 扫描上限：宁可少扫，不要卡启动。 */
const SCAN_MAX_FILES = 80
const SCAN_MAX_BYTES = 2 * 1024 * 1024
const SCAN_MAX_DEPTH = 3
const SCAN_EXTENSIONS = ['.js', '.mjs', '.cjs', '.ts', '.json']
/**
 * 自己不算「来源」。
 *
 * 实测踩到的坑：本插件的源码里本来就写着 `soul:memory`（默认动态前缀表）、
 * 测试与示例里还写着更多名字，于是扫描把每一条都「找到」了自己——真凭据被
 * 自己的噪音盖掉。所以先把自己排除掉。
 */
const SELF_PACKAGE = 'dsh-prompt-limiter'
/** 测试/文档里的名字不算证据（它们最爱列举别人的名字）。 */
const SCAN_SKIP_SEGMENTS = new Set(['test', 'tests', '__tests__', 'docs', 'examples', 'fixtures'])

/**
 * 造一个来源目录。
 * @param {object} options
 * @param {() => string} options.dshHome 取 $DSH_HOME
 * @param {Record<string, string>} [options.declared] 用户声明的 名字 → 插件
 * @param {Record<string, string>} [options.notes] 名字 → 备注（例如「内容由 X 写入」）
 * @param {(level: string, line: string) => void} [options.log]
 */
export function createProvenance(options) {
  const declared = options.declared && typeof options.declared === 'object' ? options.declared : {}
  const notes = options.notes && typeof options.notes === 'object' ? options.notes : {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  /** @type {Map<string, string>} 名字 → 插件（来自源码扫描） */
  let codeHits = new Map()
  /** @type {Set<string>} 已经找过的名字，用来决定要不要重扫 */
  let scannedFor = new Set()
  let scanInfo = { at: null, packages: 0, files: 0, bytes: 0, reason: null }

  /** 在 profile 的直接依赖包里找这些名字。 */
  function scan(names) {
    const wanted = [...new Set(names)].filter((name) => typeof name === 'string' && name !== '')
    const fresh = wanted.filter((name) => !scannedFor.has(name))
    if (fresh.length === 0) return
    const started = Date.now()
    const found = new Map()
    let packages = 0
    let files = 0
    let bytes = 0
    for (const target of profileTargets(options.dshHome())) {
      packages += 1
      for (const file of target.files) {
        if (files >= SCAN_MAX_FILES || bytes >= SCAN_MAX_BYTES) break
        let text
        try {
          text = readFileSync(file, 'utf8')
        } catch {
          continue
        }
        files += 1
        bytes += text.length
        for (const name of fresh) {
          if (!found.has(name) && text.includes(name)) found.set(name, target.plugin)
        }
      }
    }
    // 本次没找到的名字也记下来：下次只补扫新增的名字，不重复读盘。
    for (const name of fresh) scannedFor.add(name)
    for (const [name, plugin] of found) codeHits.set(name, plugin)
    scanInfo = {
      at: Date.now(),
      packages,
      files,
      bytes,
      reason: `扫描 ${fresh.length} 个新名字用了 ${Date.now() - started}ms`,
    }
    log('info', `来源扫描：${scanInfo.reason}（${files} 个文件 / ${Math.round(bytes / 1024)}KB）`)
  }

  return {
    /** 查一个名字的来源；永远返回一个结构，未知也说未知。 */
    of(name) {
      const key = String(name ?? '')
      if (declared[key] !== undefined) {
        return { plugin: String(declared[key]), basis: 'config', note: notes[key] ?? null }
      }
      if (codeHits.has(key)) {
        return { plugin: codeHits.get(key), basis: 'code', note: notes[key] ?? null }
      }
      for (const [prefix, plugin] of CORE_PREFIXES) {
        if (key.startsWith(prefix)) return { plugin, basis: 'prefix', note: notes[key] ?? null }
      }
      return { plugin: null, basis: 'unknown', note: notes[key] ?? null }
    },
    /** 需要时补扫（调用方给当前见过的所有名字）。 */
    ensure(names) {
      try {
        scan(names)
      } catch (error) {
        log('warn', `来源扫描失败（不影响其它功能）：${error instanceof Error ? error.message : String(error)}`)
      }
    },
    info() {
      return { ...scanInfo, known: codeHits.size, declared: Object.keys(declared).length }
    },
  }
}

/**
 * 找出可以扫描的目标：<profile>/node_modules/<直接依赖>。
 *
 * 为什么这么绕：本插件是 `link:` 装的，`import.meta.url` 拿到的是**真实路径**
 * （源码目录），不是 profile 里那个 junction，所以推不出 profile 目录；
 * 只能从 $DSH_HOME/profiles/* 里找出「node_modules 里有本插件」的那一个。
 */
function profileTargets(home) {
  const roots = []
  let profiles = []
  try {
    profiles = readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return roots
  }
  for (const profile of profiles) {
    const dir = join(home, 'profiles', profile)
    const modules = join(dir, 'node_modules')
    let manifest
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const dependencies = Object.keys(manifest?.dependencies ?? {})
    if (!dependencies.includes(SELF_PACKAGE)) continue
    for (const name of dependencies) {
      if (name === SELF_PACKAGE) continue
      const packageDir = join(modules, name)
      let stats
      try {
        // junction 的 dirent.isDirectory() 是 false，所以用 statSync 而不是 dirent
        stats = statSync(packageDir)
      } catch {
        continue
      }
      if (!stats.isDirectory()) continue
      roots.push({ plugin: name, files: collectFiles(packageDir, SCAN_MAX_DEPTH) })
    }
    break
  }
  return roots
}

/** 收集一个包里的可扫文件（有界）。 */
function collectFiles(dir, depth) {
  const out = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    if (SCAN_SKIP_SEGMENTS.has(entry.name)) continue
    if (/\.(test|spec)\.[cm]?[jt]s$/.test(entry.name)) continue
    const full = join(dir, entry.name)
    let stats
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      if (depth > 0) out.push(...collectFiles(full, depth - 1))
      continue
    }
    if (!stats.isFile()) continue
    if (!SCAN_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) continue
    if (stats.size > 512 * 1024) continue
    out.push(full)
    if (out.length >= SCAN_MAX_FILES) break
  }
  return out
}
