# dsh-prompt-limiter · 提示词控制器

看清**各方系统提示词到底有多大**，并给单段或整体**设置自定义上限**。

DSH 的系统提示词不是一个字符串，而是每次模型步骤前由许多 provider 现拼出来的：
静态段落（人设/规则/工具用法）、运行时动态上下文（记忆素材包、技能目录、工作区事实）、
工具 schema…… 谁占地方、占多少、有没有爆掉，平时看不见。这个插件把它们量出来，
并把「超了怎么办」交给你定：只记账、截断、还是丢弃。

- **看**：按「哪一方」（每个 Agent / 子智能体）× 「哪个来源」（段落名）两个维度给字符数与 ≈token。
- **限**：逐段上限 + 总字符上限；默认动作 `warn`，**绝不改写提示词**。
- **通**：Web 设置页一张卡片 + 一个 `prompt_size_report` 工具（Agent 自己也能查）。

零依赖、无构建步骤：`lib/client.js` 就是浏览器端源码。

---

## 安装

插件是标准的 DSH bundle 包，profile 里一行依赖 + 一行 patch 即可：

```bash
# npm 安装（发布后）
dsh plugin --profile desktop add dsh-prompt-limiter

# 本地开发目录（本仓库路径）
dsh plugin --profile desktop add /绝对路径/dsh-prompt-limiter
```

本地开发用 `link:` 安装后：

- **浏览器半边**（`lib/client.js`）刷新页面即可重载。
- **宿主半边**（`lib/host.js`）改动需要重启 DSH 进程才生效——Node 的 ESM 模块缓存按 URL 记住
  已加载的模块，插件开关（卸载/重挂）会重新挂载但仍复用那份缓存。**实测**：改完重启进程前，
  运行中的实例仍是旧代码；换了入口文件路径（模块 URL 变了）才会重新导入。
- 重复挂载保护已写在 `cordis.patch.yml` 里：profile 中若已有另一条启用中的同名行，本行自动退避。

手工挂载等价于：

```yaml
# <profile>/package.json  → dependencies 与 dsh.profile.bundles 各加一行
# <profile>/cordis.patch.yml → 以下这层由本包的 cordis.patch.yml 自动并入
- insert:
    - id: prompt-limiter
      name: dsh-prompt-limiter
```

打开 **设置 → 插件 → dsh-prompt-limiter**，卡片就叫「提示词控制器」。
插件页会用 `view: 'summary'`（列表里的一行摘要）和 `view: 'page'`（完整表单）两种姿势
问同一张卡片，两边都实现了。

## 界面在哪

同一个组件有三处入口，越靠前的越显眼：

1. **左侧栏的柱状图图标 → 中央面板**（主入口）。点开就是完整界面：标题条上有「刷新」与
   「现场探测在线 Agent」；下面是限额编辑、各方明细、来源汇总、最近越限、说明。
   - **点开看正文**：每一方行首的「查看全文」把该方提示词**按进模型的顺序**整份铺开
     （静态段落 → 运行时上下文 → 工具 schema），带「复制全文」与逐块「复制」；
     「展开明细」里的**每个段落名/工具名都能点**，就地展开那一项的原文。
     正文走 `/prompt-limiter/text` 懒加载：点开才取，报告本身只带体量。
   - 实现上：`sidebar.panellist` 注册一个 id，`main` 注册**同名** key —— 两处 id/key 必须一致，
     否则侧栏有图标而点了没反应（渲染自测里专门断言了这条）。
2. 设置 → 插件 → dsh-prompt-limiter 插件页里的配置卡片（`view: 'page'`）。
3. 插件列表里该插件行的摘要（`view: 'summary'`，一行字）。

**浏览器半边改完刷新页面即可**（实测：改完不刷新，新注册的侧栏图标与面板也出现在插槽账本里——
宿主会把重建后的前端包再推给页面）；宿主半边改代码则要重启 DSH 进程。

## 配置

行配置只提供**初始默认值**；一旦在卡片上改过并保存，`limits.json` 优先。

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `action` | `warn` | 超限动作：`warn` 只记录 / `truncate` 截断 / `drop` 丢弃 |
| `totalChars` | `null` | 系统提示词总字符上限（= 段落 + 上下文 + 工具 schema）；`null` 不限 |
| `sections` | `{}` | 逐段上限，键为段落名；特殊键 `*` 是所有未点名段落的兜底 |
| `persist` | `true` | 运行时改动是否落盘 |
| `route` | `true` | 是否暴露 `/prompt-limiter` 路由（Web 面板依赖它） |
| `tool` | `true` | 是否给 Agent 注册 `prompt_size_report` 工具 |
| `text` | `true` | 是否留存「具体提示词」原文供界面点开查看（`false` = 只留体量、不留正文） |
| `budgetNotice` | `true` | 配了上限时，是否把「预算提示」作为运行时上下文交给模型 |
| `dynamic` | 记忆/索引前缀表 | 「动态回写」的判定前缀（**实测波动优先于它**）；上限默认对着这一类 |
| `provenance` | `{}` | 来源映射 `名字 → 插件名`，优先级最高（覆盖扫描与前缀推定） |
| `provenanceNotes` | `{}` | 来源备注 `名字 → 一句说明`，只用于显示 |
| `log` | `false` | 每次组装都打一行日志（很吵，排查时才开） |

限额文件：`$DSH_HOME/storages/prompt-limiter/limits.json`；申请队列：
`$DSH_HOME/storages/prompt-limiter/requests.json`（`$DSH_HOME` 默认 `~/.dsh`）。

## 来源、动态回写、预算提示与提额申请

这四件事是一套：**先认出谁在写、再只管会长的那些、然后让写的人知道边界、最后给他一个申诉的口子。**

**① 来源（哪个插件塞进来的）**：DSH 的 `systemPrompt` **不记录注册者**——`section()`/`context()`
只留名字，谁注册的它不说。所以这里用三层可核对的证据，并把强度标在界面上（`config` > `code` > `prefix`）：

| 依据 | 怎么来的 | 实测 |
| --- | --- | --- |
| `config` | 你在 `provenance` 里写死的映射 | —— |
| `code` | 扫 profile 的直接依赖包，看**哪个插件的源码里出现了这个名字** | `soul:memory / identity / judgment` → `dsh-linghun`（它的源码里就写着 `const SECTION_MEMORY = "soul:memory"`） |
| `prefix` | 按 DSH 命名约定推定核心归属 | `tool:*` → dsh-tools、`ui:*` → dsh-client-ui-*、`app:*` → dsh-web-app… |
| `unknown` | 都不命中就写「未知来源」 | 不编 |

扫描有界（只看直接依赖、≤80 文件 / ≤2MB，跳过 test/docs），实测 24ms / 1.4MB。
两个坑是实测踩出来的：**必须排除本插件自己**（我的源码里就写着 `soul:memory` 这些默认前缀，
不排除的话每一条都会被「找到」自己）；测试与文档里的名字不算证据。

**② 动态回写（上限真正该管的一类）**：判据是**实测波动**——同一方两次组装之间内容指纹变了，
就是它在被回写；名字前缀只是兜底先验。实测里 `soul:memory` 在本会话内从 1418 涨到 2221 字符，
自动被标成「动态回写 · 实测在变」。界面默认**只看动态回写**；静态段落与工具 schema 不是裁剪目标
（名字后标着「静态/工具：默认不建议设限」，但你要设也拦不住你）。

**③ 预算提示（让模型知道自己有边界）**：只要配了任何一条上限，本插件就注入一个运行时上下文
`prompt-limiter:budget`（排在提示词末尾），把「哪些条目有上限 / 上一跳实测多少 / 超限会怎样 /
怎么申请」讲给模型听。**不知道上限的模型不会主动压缩**——这条提示是整件事的闭环。
面板上有「模型当前收到的预算提示」一栏，模型看到的那段话对你完全透明；没配上限时它不注册，不占位置。

**④ 提额申请（模型能申诉，人做决定）**：模型调用 `prompt_budget_request`（`scope` / `name` /
`wantChars` / `reason`，理由不可为空），申请进入面板「待批准的提额申请」，你点**批准**才改额度并落盘，
**拒绝**则额度不动，已决定的不会被重复决定翻转。两个文件都在 `$DSH_HOME/storages/prompt-limiter/`。

**逐项上限同时管运行时上下文**：记忆/索引既可能是 `section` 也可能是 `context`，按种类区别对待没有道理。

## 超限时到底动了什么手

顺序固定、可预期（只有 `action` 不是 `warn` 时才会真的改）：

1. **逐段上限**：命中 `sections[name]`（或 `*`）的段落，
   - `truncate` → 截到上限并追加一行 `…[dsh-prompt-limiter: 超出上限 N 字符，已截断 M 字符]`；
   - `drop` → 整段移除。
2. **总上限**：先扣掉**永不裁剪**的工具 schema 字符，剩余预算按顺序（静态段落 → 运行时上下文）
   走一遍：装得下的整段保留，**第一个装不下的截断保留，排在它后面的整段丢弃**（预算已尽，它们本来也装不下）。
   剩余预算不足 200 字符时不再截断、直接丢弃——留个残段没有意义。
3. 工具 schema 不动手：裁掉它等于改坏工具签名。若光工具 schema 就超过总上限，
   报告里标记 `unactionable: tools`，文本侧不做无意义的删减。

被裁剪的那一份仍然照原样记账（`totalChars` 是「各来源产出的大小」，`effectiveTotalChars`
是「裁剪后真正进模型的大小」），所以你不会因为开了限额就看不见真实体积。

## 归因与精度（诚实边界）

- **归因**用 `ctx.agents.currentInitiator()`：进程内异步驱动链上「谁发起了这一步」。
  组装发生在驱动链内时给出确切 SessionId；拿不到时如实记为 `(未归属)`，不猜、不冒充。
- 想知道某个在线 Agent **此刻**的确切组成，用卡片上的「现场探测在线 Agent」（`?probe=1`）：
  那条路径走 `agentPresets.serviceFor(agent, 'systemPrompt')`，在它自己的作用域里组装一次。
- **token 是估算**：ASCII ≈ 4 字符/token、非 ASCII ≈ 1.5 字符/token，中文为主时误差通常在 ±15%。
  字符数是精确值。这不是分词器，别拿它当计费依据。
- **观测数据只在内存**：进程重启即清空（限额配置在文件里，重启后仍在）。
- **正文留存**：只保留**最近 10 方**的原文（`MAX_RAW_PARTIES`），更早的只留体量；
  留的正文是**裁剪之后**、真正进模型的那份（被裁过的会在阅读器顶上标出来）。
  不想留正文就把行配置 `text` 设成 `false`——那就只记账、不留内容。
- 观测上限：最多归档 40 方、60 条越限事件；超出按最近活跃淘汰。

## 路由

`/prompt-limiter` 只服务本机页面：Host 必须回环（或本部署声明的 `webRuntime.trustedHosts`），
并拒绝 `sec-fetch-site: cross-site` 与跨源 `Origin`。**这不是身份认证**——DSH 的浏览器网关
要求 URL 里带访问令牌（未带时 `/` 返回 401），而插件注册到原始 webServer 上的路由**不继承**
那层认证（生态里 better-sidebar 的 `/sidebar/api` 同理）。所以它的授权边界就是「本机页面」，
它读写的东西也只有一份本机限额配置：没有凭据、没有用户数据、没有远程能力。要连非回环地址
对外服务时，请自行在反向代理上补认证。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/prompt-limiter/report` | 报告：各方大小、来源汇总、越限事件、当前限额 |
| GET | `/prompt-limiter/report?probe=1` | 同上，并为每个在线 Agent 现场组装一次 |
| GET | `/prompt-limiter/text?party=<key>` | **点开看正文**：这一方的原始提示词（段落/上下文/工具 schema） |
| GET | `/prompt-limiter/text?party=<key>&kind=section&name=<名>` | 只取一项（curl 用） |
| GET | `/prompt-limiter/limits` | 当前限额 + 默认值 + 文件路径 |
| POST | `/prompt-limiter/limits` | 改限额，形如 `{ "action": "truncate", "totalChars": 60000, "sections": { "灵魂卡": 4000 } }` |
| POST | `/prompt-limiter/limits/reset` | 回到 cordis 行配置的默认值 |

## 工具

`prompt_size_report`（可用 `probe: true`）：给 Agent 自己查的一句话入口，返回压缩版
（各方总量 + 前 8 大段落 + 越限标记），明细留给 Web 面板。

## 结构

```
lib/host.js        宿主半边：观测 waterfall、限额执行、路由、工具（纯函数面在 __internal）
lib/client.js      浏览器半边：手写 lazy-CJS，零依赖、无构建；面板 + 设置卡片 + 全文阅读器
lib/trust-fence.js 路由的浏览器信任围栏（与 dsh /api 网关同行为）
lib/provenance.js  来源目录：三层证据（config / 扫源码 / 按名前缀推定）+ 有界扫描
test/run.mjs       纯函数自测
test/integration.mjs  进程内集成（假 cordis 上下文）
test/render.mjs    浏览器半边离线渲染自测（迷你 React）
cordis.patch.yml   profile 挂载层
```

## 验证（本机实测记录）

```bash
node test/run.mjs            # 23 项：量测、限额执行、净化、分类、申请校验
node test/integration.mjs    # 31 项：进程内把真实宿主半边挂起来跑
node test/render.mjs         # 18 项：把 lib/client.js 装进迷你 React 真渲染一遍
```

集成测试用假 cordis 上下文驱动真实代码，覆盖：监听器注册（`prepend`+`global`）、归因、
warn 零改写、truncate 真裁剪且产出记账不变、总上限预算走法、信任围栏 403/放行、
`POST /limits` 落盘 + 立刻影响执行 + 重启后从文件恢复、工具注册、probe 记账（记在目标名下、
不新增「未归属」），以及 `/text` 的六种情形：正常取正文、单取一项 / 名字不对 404、
裁剪后留的是**真正进模型的那份**、探测的正文标明来源、`text:false` 与「没这一方 / 还没组装过」
各自的应答、留存上限（第 11 方淘汰最早的正文但体量记账不受影响）。此外还覆盖本轮新增的：
来源三层证据与未知兜底、动态回写的实测波动判定、预算提示的注入/同步/注销、
提额申请的全流程（缺参被拒 → 待批准 → 批准才改额度并落盘 / 拒绝不动额度 / 已决定不回翻 / 未知 id 404）。
测试用临时 `$DSH_HOME`；会写盘的用例各用各的家（共享一个家会互相污染，实测踩过）。

**来源扫描是拿真机验的**：对着本 profile 的已装插件跑一遍，`soul:memory / identity / judgment`
都按 `code` 归到 `dsh-linghun`（真凭据），核心名按 `prefix` 归到 `@deepseek-ai/dsh-*`（标为推定），
编造的名字如实落到 `unknown`。

渲染自测的价值已经当场兑现四次：

1. **把 React 元素拼进了字符串** —— 总览行会显示成 `max 41,476 字符 · [object Object]`。
   插槽占用者照样 `active: true`，从外面完全看不出问题（后面加「动态回写」那行时又犯了一次，
   被同一条断言当场拦住）。
2. **`var` 在循环里被闭包共享** —— 各方那一段用 `var key = party.key`，于是点**任何一方**的
   「查看全文」都会操作**最后一方**。这个 bug 只有真点一次才会暴露，纯静态渲染断言抓不到。
3. 加中央面板时，先替我把「侧栏 id 必须等于 main 的 key」「面板铺满主列且不是空壳」
   以及「旧宿主没有 /text 时要说人话而不是空壳」钉成断言。

真机实测（profile `desktop`，Web UI）：

- `GET /prompt-limiter/limits` → 默认 `{action: warn, totalChars: null, sections: {}}`；
- `GET /prompt-limiter/report` 抓到两个在线 Agent 的真实组装：**41,476 字符 / ≈12,080 token**
  （25 个段落 + 40 个工具 schema），其中 **工具 schema 占 31,554 字符 = 76%**——
  这条就是本插件存在的理由：真正吃上下文的是工具签名，不是人设；
- `?probe=1` 在线上正常返回（每个在线 Agent 各自组装一次）；
- `plugins.bundle.config` 插槽占用者里出现 `key: dsh-prompt-limiter`（浏览器半边已自动装载）。

两个实测代价，写在这里免得下次再踩：

1. **宿主半边改代码不会热重载。** Node 的 ESM 缓存按模块 URL 记住已加载模块；插件关/开
   只重新挂载、不重新导入，换入口文件路径也无济于事（加载器把这条行缓存了）。
   所以报告里带 `build` 戳——它能把「新代码没生效」和「新代码有 bug」分开。
   要真正生效：重启 DSH 进程（或换包名，那等于一个新模块）。
2. **token 是启发式估算**，字符数才是精确值。做容量预算可以，做计费不行。

## 许可

MIT
