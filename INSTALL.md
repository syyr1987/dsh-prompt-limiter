# 异机安装（dsh-prompt-limiter · 提示词控制器）

**零依赖**：不用联网、不用 `pnpm install`、没有构建步骤（`lib/client.js` 就是浏览器端源码）。
包里只有 7 个文件：`package.json` / `cordis.patch.yml` / `lib/`（4 个）/ `README.md` / 本文件 / `LICENSE`。

---

## 方式 A：一行命令（推荐）

把 `dsh-prompt-limiter-0.2.0.tgz` 拷到目标机器任意位置，然后：

```bash
dsh plugin --profile <profile名> add /绝对路径/dsh-prompt-limiter-0.2.0.tgz
```

`<profile名>` 是目标机器的 profile（桌面版通常是 `desktop`，用 `dsh plugin list` 或看
`$DSH_HOME/profiles/` 下的目录名确认）。

装完 **重启 DSH**（宿主半边的代码在进程启动时装载一次，不重启不会生效——实测：装完不重启时
新路由是 404）。

> 若安装命令因 profile 的 pnpm 供应链策略（`minimumReleaseAge`）报错，见方式 B。
> 那种报错与本事无关，是 profile 里别的包太新触发的预检。

## 方式 B：手工装（无 pnpm / 无网络 / 命令装不上时）

1. 解压 `.tgz`（`tar -xzf dsh-prompt-limiter-0.2.0.tgz`）或直接用 `.zip`，得到 `package/` 目录。
2. 把整个目录放到 profile 的 `node_modules` 下，**名字必须是 `dsh-prompt-limiter`**：
   `<profile目录>/node_modules/dsh-prompt-limiter/`
   （可以放目录本身，也可以放一个指向它的 junction/symlink——DSH 两边都能扫到。）
3. 编辑 `<profile目录>/package.json`，加两处：

   ```json
   {
     "dependencies": {
       "dsh-prompt-limiter": "link:../vendor/dsh-prompt-limiter"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "…原有内容…",
           "dsh-prompt-limiter"
         ]
       }
     }
   }
   ```

   `dependencies` 里的值用你实际的路径（`link:` / `file:` 都行，指向第 2 步那个目录）。
4. **重启 DSH**。

## 装好之后怎么确认（三步）

```bash
# 1) 宿主半边活着：应返回 {"ok":true,...}（不是 404）
curl -s http://127.0.0.1:19387/prompt-limiter/limits

# 2) 版本戳（升级/排查用）：report 里的 build 字段
curl -s http://127.0.0.1:19387/prompt-limiter/report

# 3) 浏览器半边：DSH 界面左侧栏图标区应多出一个柱状图图标，点开就是面板
```

自测（可选，需要 node）：进包目录 `node test/run.mjs && node test/integration.mjs && node test/render.mjs`
—— 三套共 73 项，全绿说明这份包在这台机器上完好。

## 卸载

```bash
dsh plugin --profile <profile名> remove dsh-prompt-limiter
```
或手工：从 `dsh.profile.bundles` 与 `dependencies` 里删掉那两行，删掉
`node_modules/dsh-prompt-limiter`，重启。限额文件可以留着（`$DSH_HOME/storages/prompt-limiter/`）。

---

## 配置速查

行配置写在 profile 的 `cordis.patch.yml`（或让 DSH 的插件页改）；**运行时改动落在**
`$DSH_HOME/storages/prompt-limiter/limits.json`，**文件优先于行配置**。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `action` | `warn` | 超限动作：只记录 / 截断 / 丢弃（默认只记录，**绝不改写提示词**） |
| `totalChars` | `null` | 提示词总字符上限 |
| `sections` | `{}` | 逐项上限（段落**与运行时上下文**都吃这套；`*` 为兜底键） |
| `text` | `true` | 是否留存原文供界面点开查看（`false` = 只留体量） |
| `budgetNotice` | `true` | 配了上限时，把「预算提示」交给模型（模型不知道上限就不会压缩） |
| `dynamic` | 记忆/索引前缀表 | 「动态回写」判定前缀；实测波动优先于它 |
| `provenance` | `{}` | 来源映射 `名字 → 插件名`（覆盖扫描与前缀推定） |

## 已知边界（先知道，别踩）

- **宿主半边不热重载**：改代码 / 升级包之后必须重启 DSH 进程。报告里的 `build` 字段用来确认在线版本。
- **路由没有令牌认证**：插件路由只吃「本机页面」这一层信任围栏（与生态里 better-sidebar 的
  `/sidebar/api` 同理）；对外暴露请自行在反代补认证。
- **正文留存有上限**：只留最近 10 方的原文；留的是**裁剪之后**真正进模型的那份。
- **token 是启发式估算**（ASCII≈4 字符/token、非 ASCII≈1.5），字符数才是精确值。
- **来源是三层证据**：`config`（你写的）> `code`（扫已装插件源码）> `prefix`（按名前缀推定），
  界面上每条都标了是哪一层；不命中就写「未知来源」，不编。
- 想看清所有细节（含实测记录与踩坑），读包里的 `README.md`。
