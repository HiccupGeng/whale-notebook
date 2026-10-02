# whale-notebook 项目全貌导读（新机接手版）

> 日期：2026-09-13 ｜ 对应代码：`main` @ `49c5b0d`（release v0.7.8）｜ 生命周期工具 0.2.0
> 定位：**给"换了机器、重新拉取代码"的接手者（人或 AI）的全貌速览**。基于对源码的逐文件精读重写，不复述既有文档。
> 深入资料：仓库根 `PROJECT-INTRO.md`（权威导读）、`CHANGELOG.md`（版本沿革明细）、`README.md`（门面）；
> 已有 `docs/2026_09_10_16_whale-notebook架构全景图.md` 是按平面展开的全景图，本文按「模块 × 数据流 × 坑」重排，二者互补。

## 0. 一页速览

| 维度 | 事实 |
|---|---|
| 是什么 | DeepSeek Harness（DSH）的**自我进化机制**：挖本机全部会话里反复出现的坑 → 提炼候选 → **人逐条确认** → 写入全局经验库 → 注入 `~/.dsh/AGENTS.md`，让后续会话不再重犯 |
| 代码规模 | 骨架约 5000 行（`plugin/src` + `plugin/lib` + `plugin/lifecycle`），测试约 2000 行 |
| 版本 | 插件 `0.7.10`（`plugin/package.json`）｜ 生命周期 `0.2.0`（`plugin/lifecycle/consts.cjs`） |
| 语言/运行时 | 纯 CommonJS/ESM 混用（`src/**` 与 `lifecycle/**` 是 `.cjs`，`lib/**` 是 ESM）｜ 仅 Node 内建，**零第三方依赖**｜需 Node ≥ 22.15 / 23.8（zstd 内建） |
| 测试 | **17 个测试文件 / 673 断言 PASS / 0 FAIL + 1 项变异反证**（2026-10-02 本机实测；v0.7.10 +32 = DOM 桩点真实 💬 的端到端；反证 = 改回"开机取一次"必须变红） |
| 数据落点 | 运行实例在 `~/.dsh/whale-notebook/`，**用户记忆数据永不进仓库**（`.gitignore` + `sync-release` 双重兜底） |
| 本机状态 | ✅ **已安装并部署到 desktop profile**；宿主 API 已实测生效（6 个 GET + 写端点全 200、闸门四项全拦）；**v0.7.10 修掉"💬 详细讨论 → 当前环境无会话服务"**（DSH 0.2.x 客户端服务时机/API），重启 DSH 后生效（详见 §8.3/§8.4） |

## 1. 本机落地实况与环境

| 项 | 值 |
|---|---|
| 代码位置 | `D:\AI\DeepseekHarnes\whale_notebook`（`main`，工作区干净；含本次 desktop 兼容改造提交） |
| 运行实例 | `C:\Users\A\.dsh\whale-notebook\`（**权威源**，已安装，`phase=verified`） |
| Node | v24.19.0（满足 zstd 前置） |
| git | 2.53.0.windows.1 |
| 网络 | **直连 github.com:443 不通**（20 秒超时）；系统代理 `127.0.0.1:16101` 可用，克隆/拉取需带 `HTTPS_PROXY=http://127.0.0.1:16101` |
| DSH 形态 | **Windows 桌面版**（Electron：`Program\DeepSeek Harness.exe` → `dsh-desktop-host`），Web GUI 在 `http://127.0.0.1:19387` |
| 活跃 profile | **`desktop`**（DSH 自身注入 `DSH_PROFILE=desktop`、`DSH_PROFILE_DIR=...\profiles\desktop`；`web` profile 是不启动的空壳） |

> 注：`dsh` CLI 未在本会话 PATH 中。这不影响任何自检（全部在临时沙盒跑），但影响"重启 dsh web 生效"类操作。

## 2. 权威源 vs 发布镜像（改代码前必读）

这是本项目**最容易搞错的一点**：仓库不是主战场，`~/.dsh/whale-notebook/` 才是。

```
权威源（真正运行/被读取）                     发布镜像（GitHub 仓库）
~/.dsh/whale-notebook/plugin/          ──┐
<工作区>\docs\*whale-notebook*.md       ──┼─→  tools/sync-release.cjs  ──→  plugin/ docs/ scripts/ PROJECT-INTRO.md
~/.dsh/whale-notebook/scripts/          ──┤        （先清空目标目录再整拷）
~/.dsh/whale-notebook/PROJECT-INTRO.md  ──┘
```

由此推出三条硬约束：

1. **仓库内 `docs/` 是同步产物**：`sync-release.cjs` 会 `rmTree(dst)` 后整拷，往里放新文档会被下次同步**删掉**。
   新文档要写进 `<工作区>\docs\`（本机即 `D:\AI\DeepseekHarnes\docs\`，文件名含 `whale-notebook` 才会被同步）。
2. **同理 `plugin/` 也是整体镜像**：在克隆里直接改 `plugin/**`，下次同步会被权威源覆盖。只有"权威源不可用"时才把它当工作副本。
3. **目录布局有隐含要求**：脚本用 `path.resolve(REPO, '..')` 当工作区，所以仓库必须位于 `<工作区>\whale-notebook\`。
   本机 `D:\AI\DeepseekHarnes\whale_notebook` 符合（工作区 = `D:\AI\DeepseekHarnes`）。

`README.md` / `CHANGELOG.md` / `LICENSE` **不参与镜像同步**，是手工维护的，可直接在仓库编辑。

## 3. 三平面架构与模块依赖

DSH 是「一切皆插件」（Cordis）运行时。本项目按三个平面挂载，方向单向、永不回环：

```
┌─ H 宿主平面（host half）  plugin/lib/index.js ── 需重启 dsh web 才生效
│    ① 实时采集：ctx.on('session/event') → collector/live.cjs
│    ② 11 个 /whale/* JSON 端点（统一过 guardRequest 闸门）
│
├─ U 浏览器平面（browser half）  plugin/lib/client.js ── 刷新页面即生效
│    决策箱悬浮面板（零依赖纯 DOM，__ModuleLoader__ 装载，轮询 + 三动作）
│
└─ S 会话平面（agent/skill）  ~/.dsh/skills/whale-notebook.md + AGENTS.md 自动段
     触发词「小本本复盘 / 入库 / 讨论 / 忘掉 / 统计」
```

模块依赖（严格单向，`core` 零依赖）：

```
ui ──→ viewmodel ──→ store ──→ core
review ──→ (schema, inject, store)
inject ──→ schema
collector ──→ (core, store)
lifecycle ──→ 仅 node 内建（刻意与业务模块解耦，插件没挂载时也能装/卸）
```

| 层 | 模块 | 职责一句话 |
|---|---|---|
| 领域 | `core/schema.cjs` | 全部公共协议：类别表、设置默认、inbox 行、条目模板、规则行、类别排序契约 |
| 领域 | `core/privacy.cjs` | **隐私唯一出口**：打码 `redact`/`redactLines`、指纹 `hash36`、规范文本 `canonText` |
| 领域 | `core/summarize.cjs` | 现象一句话（行级清洗 + 句界截断 ≤90 字） |
| 领域 | `core/similarity.cjs` | 骨架归一 + 3-gram 相似度 + 族判定（纯函数，可复现） |
| 数据 | `store/repo.cjs` | **唯一读写入口**：路径常量、原子写、严格读、CAS 合并、跨进程写锁、维护窗口、已解决墙生成 |
| 记录 | `collector/decoder.cjs` | zstd 多帧 JSONL 解码（含帧边界检查、窗口读、损坏分类） |
| 记录 | `collector/scanner.cjs` | 单会话事件抽取 + 回声过滤判定（特征词典在 `patterns.cjs`） |
| 记录 | `collector/engine.cjs` | **采集核心**（983 行）：扫描 → 指纹去重 → 聚簇/族 → 入库/暂存 |
| 记录 | `collector/live.cjs` | 实时采集（去抖 1.5s、串行写盘、异常全吞） |
| 记录 | `collector/cli.cjs` | CLI 分发 + 退出码 |
| 生效 | `inject/agents.cjs` | AGENTS 自动段正文生成（标记区内整段替换，落盘由 agent 用 edit 工具执行） |
| 审核 | `review/commit.cjs` | 计划式入库纯函数（**只出计划、不写盘**） |
| 展示 | `ui/viewmodel.cjs` · `ui/server.cjs` · `lib/client.js` | 视图模型 · host API 纯逻辑 · 面板 bundle |
| 自举 | `lifecycle/` | 安装/卸载/清单（三段足迹 + 两段式写操作 + 漂移分级） |
| 维护 | `scripts/deploy-web.cjs` · `scripts/links-doctor.cjs` | R 段唯一写入者 · 悬空链接体检 |

## 4. 数据契约（改动前的红线）

### 4.1 inbox 候选行（6 列）

```
| 编号 | 类别 | 次数 | 工作区 | 现象（一行，已打码） | 首次出现 |
| C001 | error | 3 | SandBox1 | ... | 2026-09-10 14:22 |
```

- 唯一解析入口 `repo.parseInboxRows`（正则 `INBOX_ROW_RE`），viewmodel / engine / 面板共用，避免多处正则漂移。
- **现象与工作区列里的 `|` 会被换成全角 `｜`**（`schema.cell`）——否则整行无法被表格解析，面板看不见且无法累加次数。
- 编号从 `^C\d{3,}$`（v0.7.4 放宽，原来 3 位定长，过 999 后详情写入静默失败、面板删不掉）。
- 编号下限 = `max(state.nextCandidateId, 在箱最大+1, 归档最大+1)`（防 state 重置后与历史撞号）。

### 4.2 经验条目 frontmatter（`entries/E###-*.md`）

`id / title / category / status(active|disabled) / scope(global|project) / projects[] / occurrences / firstSeen / lastSeen / workspaces[] / rule / created / updated / sources[]`
+ 正文四节 `## 现象 / ## 根因 / ## 对策 / ## 验证`。`scope` 缺省 = `global`（旧条目零迁移）。

### 4.3 规则行与 AGENTS 自动段

- 规则行 = `- 【类别】对策一句话`；进自动段按 `occurrences` 降序取前 `maxRulesInAgents`(12)。
- **只收 `scope=global`**：项目级条目永不进全局注入（B1 语义），只在 `INDEX.md` 项目区/面板已解决卡查阅。
- 自动段由 `inject/agents.cjs` 整段维护，**勿手改**（下次入库会覆盖）。标记：`<!-- whale-notebook:rules -->` … `<!-- /whale-notebook:rules -->`。

### 4.4 `state.json`（派生状态，可重建）

| 键 | 形状与含义 |
|---|---|
| `files` | `{"<日志绝对路径>": {size, mtimeMs, offset, frames, badRounds, sid, ws, calls, cmds}}` ← **增量水位线** |
| `clusters` | `{"<聚簇哈希>": {cid, cat, text, n, first, last, reAddedAt, reAdds, silentN?, family?, familyScore?}}` |
| `seenFingerprints` | 事件级指纹数组（按 `maxFingerprints`(5000) 截尾） |
| `deferred` | 拉取式暂存摘要（`autoAdd=false` 时新发现落这里，不入箱） |
| `nextCandidateId` / `lastScan` / `lastScanStats` | 编号游标 / 上次扫描时间 / 扫描健康度 |

**关键口径**：`state.json` 可被重置/重建，**不作为"已处置"判据**——已处置的事实源是 `archive/archive-*.md`（末列非空 = 已处置）。

### 4.5 设置（`settings.json`）

`autoCollect / autoAdd / liveCapture / scanMode / denylistWorkspaces / minOccurrences / maxRulesInAgents / reminderListMax / maxDeferred / maxFingerprints / reAddCooldownDays / familyThresholdSame / familyThresholdCross`
（`minOccurrences` 目前是**死设置**：全仓无读取点，见 §9）

## 5. 三条主数据流

### 5.1 批扫（离线，0 token）

```
sessionFiles()          找出全部 ~/.dsh/sessions/*/session.jsonl.zstd
   ↓ 逐文件 statSync
水位线比对               size+mtime 都没变 → 只 stat 跳过（增量热启动 ~10ms）
   ↓ 变了
readFileWindows()       从 wm.offset 续读，每片 256KB（宿主异步路径）→ 片间让出事件循环
   ↓
decoder.scanFramesEx()  帧边界检查 → complete / eof(半写，正常) / bad(中段损坏)
   ↓
scanner.classifyRecord() 抽取「工具失败 + 特征词典命中」事件；命令类成功结果里做回声判定
   ↓
ingestFresh()           ★ 唯一入库实现（CLI 与实时共用）
```

`ingestFresh` 内部四步（`engine.cjs:415-637`）：

1. **指纹去重**：指纹 = `sid|at|hash36(类别|工具|规范文本)`；命中即跳过（**先记指纹再判定**，故超限丢弃的行不会下轮再捞）。
2. **同聚簇聚合**：聚簇键 = `类别|工具|canonText(文本)`；`canonText` = 打码 + 小写 + 去 sid/uuid/goal + 截 90 字。
3. **结局判定**（每条聚簇落到恰好一个分支）：

| 结局 | 条件 | 动作 |
|---|---|---|
| `bump` | 同聚簇已在箱 | 只累加次数 |
| `bump`（族并入） | 命中同族且族有在箱候选 | 并入该族代表行，不新开行 |
| `readd`（复发） | 曾开行、已处置、且过了冷却期 | 重开并标「复发（原 C0xx）」 |
| `silent` | 已处置但仍在 `reAddCooldownDays`(7) 内 | 只计数不出声 |
| `resolved` | 归档签名命中（含**族级**） | 压掉，不开行 |
| 新开行 | 以上都不命中 | 分配新 `C###` + 写 sidecar |

4. **落盘**：`deferredOn = (未显式 --add) && settings.autoAdd === false` → 只写 `state.deferred`；否则写 inbox 行 + `details/C###.md`。

### 5.2 实时（运行中，0 token）

```
ctx.on('session/event') → live.onEvent()
   → 同一套 scanner.classifyRecord
   → 缓冲（去抖 1.5s / 满 200 条立即 flush）
   → flush：读维护窗口 → 取写锁 → repo.readState() → ingestFresh() → writeState()
```

三重保护：① **维护窗口**期间让路但不丢事件（留缓冲 + 1s 重试，`heldByMaintenance` 计数）；
② **写锁忙**同样退回缓冲（`lockBusy`）；③ 任何异常在监听器内吞掉，**绝不打断用户会话**。
`liveCapture=false` / `autoCollect=false` 时整批跳过。

### 5.3 审核闭环（人在环，这是设计红线）

```
候选 C###  →  面板/技能展示（现象一句话）
           →  GET /whale/related?id=C###    取三块确定性依据：族成员 / 相似候选 / 可能已覆盖的条目
           →  人判断是否同根因（程序只保证"该看哪些"）
           →  review.commit.planCommit()    出计划：entryFiles + indexMd + agentsBody + ruleLines
           →  ★ 展示给人确认 ★
           →  agent 用 edit 工具落盘 entries/ + INDEX.md + AGENTS.md 标记区
```

**AI 从不静默改记忆**：入库是两段式的（先计划后落盘）；`commit.cjs` 本身是纯函数，不做任何文件写。

## 6. 端点契约（H 平面，共 11 个）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/whale/inbox` | 待审列表（附 `deferred` 组数、每行 `variants` 族大小） |
| GET | `/whale/inbox/detail` | 候选详情 sidecar |
| GET | `/whale/solved` | 已解决墙聚合 |
| GET | `/whale/entry` | 条目全文 |
| GET | `/whale/related` | 同族 + 相似候选 + 可能已覆盖条目（讨论用确定性依据） |
| GET | `/whale/live` | 运行状态与**采集健康度**：zstd 能力、上轮扫描统计、卡住的水位线、回声归档规模、`scanJob`、`maintenance`、写盘诊断、双计口径 |
| GET/POST | `/whale/settings` | 「自动收集」开关 = `settings.autoAdd`（**只写 settings.json，白名单仅 autoAdd，绝不碰 AGENTS.md**） |
| POST | `/whale/inbox/delete` | 删除候选 → 移入归档（可恢复，detail 随行归档） |
| POST | `/whale/scan` | 面板 ⟳：先 flush 实时缓冲，再增量扫描 |
| POST | `/whale/sweep` | 面板 ⛏ 历史深掘 = 阶段① `--add` 保底 + 阶段② `--rebuild --add` 全量重扫入箱 |

`guardRequest` 三道闸门（`ui/server.cjs:207-233`，不影响本机面板/CLI/curl）：

1. **Host 必须回环** → 防 DNS rebinding（正解是 Host 白名单，`Sec-Fetch-Site` 对同源重绑定无效）；
2. **Origin/Referer 若存在必须回环** → 挡跨站发起；
3. **写操作必须 `Content-Type: application/json`** → 跨站"简单请求"失效（浏览器必发预检，而我们不答 CORS）。

## 7. 隐私与并发（本项目的两条工程主线）

### 7.1 隐私铁律

任何要离开会话日志、进入 inbox/entries/AGENTS/UI 的文本，**必须**过 `core/privacy.cjs`：

- `redact` 打码 8 类：凭据头（Authorization/Cookie）、URL 内凭据、已知前缀令牌（`sk_live_`/`xoxb-`/`npm_`/`AIza`/`ghs_`/`glpat-`…）、历史令牌形态、`密钥名 = 值`（含 snake_case）、超长 hex/base64、家目录 → `~`、绝对路径参数化。
- **不含凭据的文本输出逐字节不变** → 普通文本指纹不漂移（这是 v0.7.4 加规则时能保持兼容的前提）。
- `hash36` = FNV-1a 32bit → base36（只存短哈希，不存原文）；`canonText` 供聚簇/指纹。

### 7.2 并发与状态完整性（v0.7.4–v0.7.7 的主要战场）

| 机制 | 解决的问题 |
|---|---|
| 跨进程写锁 `state.json.lock`（`wx` 原子创建，>15s 陈旧锁可回收） | CLI 扫描 / 宿主实时 flush / 面板删除三方互斥 |
| **严格读** `readJsonStrict`（只有 ENOENT 算空，损坏先备份 `.corrupt-<ts>` 再抛） | 防"读失败当空状态"静默覆盖好文件 |
| **CAS 写前合并** `writeState`（比对 size+mtimeMs，变了就并集合并重放） | 防秒级扫描窗口内被 live flush 整段覆盖 |
| 本进程独有临时名 `tmpNameFor`（带 pid + 序号） | 防两写者共用 `x.tmp` 互相覆盖 / rename ENOENT |
| 维护窗口 `.maintenance.json`（TTL 夹到 10 分钟） | `--rebuild` 期间实时采集让路但不丢事件；强杀靠过期自愈 |
| 生成器 + 双驱动（同步 `driveSync` / 异步 `driveAsync`） | CLI 输出与退出码零变化的同时，宿主扫描让出事件循环 |
| 256KB 窗口续读 | 实测把全量扫描期间的最大事件循环卡顿从 **3857ms** 降到 **69ms** |

## 8. 本机安装实况（已按 desktop profile 完成）

**状态：✅ 已安装并部署完毕**（2026-10-01）。`lifecycle check` exit 0、`phase=verified`。

实际执行顺序与结果：

| 步骤 | 命令 | 结果 |
|---|---|---|
| 1 | 建数据目录 + 拷 `plugin/` `scripts/` `PROJECT-INTRO.md` | `~/.dsh/whale-notebook/` 就位；权威位自检 137 PASS |
| 2 | 创建 `~/.dsh/AGENTS.md`（含 rules/privacy 两标记区） | 写入后**被系统即时注入**（实证注入链路通） |
| 3 | `lifecycle cli.cjs install --apply --agents-mode zones` | exit 0；`AGENTS zones 标记区齐备, **零改动**` |
| 4 | `deploy-web.cjs --apply` | 46 文件 → `profiles/desktop/node_modules/...`；patch **尾部追加** managed 块；自检"逐字节一致"通过 |
| 5 | `install --apply` 重跑（登记 R 段） | R 段两条 → `installed`；`check` 全绿 |
| 6 | `scripts/mine.cjs --check` | **新发现 7 条**（error/git-net/encoding/file-missing/timeout），3 日志 1.46MB，172ms，0 token |

**三条关键注意事项**：

1. **`AGENTS.md` 归属模式默认是 `whole`（整文件归插件所有，卸载整文件删除）**。
   要 `zones`（只管理两个标记区、区外内容永远是你的、`remove` 只剥区不删文件）→ 必须显式 `--agents-mode zones`。
   **本机已用 zones。** 且 zones 模式要求文件已存在，所以第 2 步先建文件。
2. **R 段（面板）改动生效顺序铁律**：先 `deploy-web.cjs --apply`，**再**重启 DSH。反序等于重启加载的仍是旧副本。
3. **重启那一步只能由人做**：本机 DSH 就是承载当前会话的 Electron 进程，重启它 = 结束会话。

### 8.1 Windows 桌面版（desktop profile）兼容改造 ⚠️ 重要

**问题**：DSH 的 profile 由 `dsh --profile <name>` 选择 —— 桌面版跑 **desktop**，纯 Web 服务形态才是 **web**。
而原 `deploy-web.cjs` **写死 `profiles/web`** → 在桌面版机器上部署会"成功"写进一个**没人启动的 profile**，
面板永远不出现，而所有自检都通过（**静默失效**；本机实测确认过该失败形态）。

**改造**（提交 `feat(deploy): 支持 desktop profile`，自检 609 → **626 PASS**）：

| 层 | 改动 |
|---|---|
| `scripts/deploy-web.cjs` | 目标 profile 可配置：`--profile <name>` > `DSH_PROFILE` > 默认 `web`；**profile 不存在时明确报错并列出可用项**（把静默失效变成显式错误）；部署成功后写入 `.lifecycle/runtime-profile.json` |
| `lifecycle/consts.cjs` | 新增 `{profile}` 路径模板变量 + `readRuntimeProfile`（默认 web） |
| `lifecycle/manifest.cjs` | `ctxOf` 带 profile；`mergedView` 按当前上下文重解析派生路径 |
| `lifecycle/cli.cjs` | `ensureSiteEntries` 刷新已存在条目的 path；`detach` 把记录的 profile 传给唯一写入者 |
| `manifest.json` | R 段路径 → `{dshHome}/profiles/{profile}/...` |
| `lifecycle/selftest.cjs` | 新增 F6l：desktop 端到端 15 条断言（含"无记录回退 web"与"记录 desktop 后认到现场"对照） |

**顺带修掉一个隐藏 bug**：站点清单的 R 段路径原先**只在首次 `install` 时解析一次、之后永不刷新**。
路径动态化后，这会导致"现场明明部署了却登记 absent"（本机已复现并修复）。

**意外的好处**：`DSH_PROFILE` 由 **DSH 自身注入会话环境**，所以在 DSH 会话里直接跑部署脚本会**自动命中 desktop**，
不需要记忆任何参数。验证过的行为：默认→desktop、显式 `--profile desktop`→desktop、
`--profile nosuchprofile`→exit 1 并列出 `desktop, web`、`--profile` 缺参数→exit 2。

### 8.2 新机安装的真实缺口（本次踩到，建议上游修）

1. **`skills/whale-notebook.md` 从未进过仓库**：`sync-release.cjs` 的权威源只列了 `plugin/`、工作区 `docs/`、
   `scripts/`、`PROJECT-INTRO.md`，**没有 `skills/`** → 技能文件只存在于开发机 `~/.dsh/skills/`。
   新机器上 `install` 会直接卡死（`skill 缺失且无种子/备份`，exit 2）。
   本次由用户提供原版文件解决（15211 B，含 7 步工作流）。**建议把 `skills/` 纳入同步**。
2. **`install` 还要求数据目录预先存在**（否则报 `数据目录不存在`），需先手工建目录或给 `--seed-dir`。

三段足迹与卸载分级（`lifecycle/README.md`）：

| 段 | 内容（本机实际路径） | 谁能删 |
|---|---|---|
| I 集成 | `~/.dsh/AGENTS.md`（**zones 模式**，只两个标记区）+ `~/.dsh/skills/whale-notebook.md` | `remove` / `purge` |
| D 数据 | `~/.dsh/whale-notebook/`（**用户记忆**） | **只有 `purge`**，且必须先 `--export-dir` + `--yes` |
| R 运行时 | `profiles/**desktop**/node_modules/@deepseek-ai/dsh-whale-notebook` + `profiles/desktop/cordis.patch.yml` 标记区 | `uninstall detach`（内部驱动 `deploy-web --undo`，profile 从记录读取） |

`uninstall remove` **原样保留 D 段**——记忆永不清。所有写操作默认干跑出计划，确认后 `--apply`。

### 8.3 重启 DSH 让面板生效（2026-10-01 实测；口径已被 8.4 修正）

**当时的实测结论：宿主半边已经被加载，不需要重启；需要重启的是浏览器半边。**

| 半边 | 状态 | 证据 |
|---|---|---|
| **H 宿主**（`lib/index.js` 的 11 个 `/whale/*` 端点 + 实时采集） | ✅ 已生效（0.7.8） | `/whale/inbox`→200 `pending=7`；`/whale/live`→200 `version=0.7.8`、`live.enabled=true` 且已跟踪当前会话；`POST /whale/scan`→200；四项端点闸门实测 403/403/403/415 |
| **U 浏览器**（`lib/client.js` 决策箱悬浮面板） | ❌ 未加载 | client bundle 未进 boot graph，需重启 DSH 重新计算 |

> ⚠️ **8.4 已推翻上表第二行的因果与第一行的口径**：那次"宿主已生效"是观测 confound（先部署 → 用户重启 → 才测端点）；
> 干净对照（部署后不重启）显示 `/whale/live` 仍自报旧版本 → **宿主与浏览器两边都需重启 dsh**。

### 8.4 v0.7.10：面板能显示 ≠ 面板能用 —— 💬「当前环境无会话服务」的真根因（2026-10-02 实测）

**现象**：面板正常出现、待审能刷新、⟳/✕/开关都可用，只有 **💬 详细讨论**（以及隐藏的 ⚡ 自动处理、⛏ 完成后的总结会话）弹
「当前环境无会话服务，无法开新会话」。

**排查（三步排除 + 一步定性）**：

1. 排除部署/profile：`profiles/desktop/cordis.patch.yml` 有挂载行、`node_modules` 有副本，且**副本与权威源逐字节一致**（SHA256）。
2. 排除"面板整体没起来"：面板 DOM、`/whale/*` 请求全部正常 → client bundle 确实加载了。
3. 读内核源码定性：本机 DSH `0.2.0-rc.2` 里 `sessions` / `workspaces` 是**客户端**服务，由
   `dsh-api-session-controller`（`inject = ['connection','fileUpload','typert','remote','remote.commands','remote.session','remote.subagents']`）
   与 `dsh-api-workspace-controller`（`inject = ['remote','remote.workspace']`）的客户端半边**在连接建立 + gateway 装好 remote 命名空间之后**才 `provide`；
   `cordis` 严格模式下提供者 fiber 未 ACTIVE 时 `ctx.get()` 只返回 `undefined`。
4. 定性：面板 client fiber **不声明 inject**、开机最先 apply，旧写法在 `apply()` 里 `ctx.get("sessions")` **取一次并永久缓存** ⇒ 必然是 `null`。
   面板原来声明的 `dsh.client.inject: ["@deepseek-ai/dsh-client-runtime"]` 是 0.1.x 的排序保证，**该包在新内核里已不存在**，缺失行被静默忽略 → 这就是"以前能用、现在不能用"的原因。

**结论：与桌面版/profile 无关**（两个 profile 的 bundles 逐字相同、客户端插件图相同；`dsh web` 形态同样会中招），是内核版本漂移。

**v0.7.10 的修法**（全部在浏览器半边 `lib/client.js`；宿主半边零改动）：

| # | 旧写法（0.2.x 已失效） | 新写法 |
|---|---|---|
| ① | `apply()` 时 `ctx.get("sessions")` 取一次 | 每次动作前 `syncServices()` 现取（`svcOf` 三态降级） |
| ② | `waitBinding()` 轮询 `sessions.binding(id)`（新建会话永不命中 → 超时后**静默丢首条消息**） | `retain(id,{source})` → `await ref.ready` → `ref.binding.session.prompt(blocks,"queue")` → `release` |
| ③ | `sessions.open(id)` | `ctx.uiWorkspace.openSession(id)` |
| ④ | `workspaces.createDirectory(parent,name)` | `ctx.uiWorkspace.createDirectory(path,name)` |
| ⑤ | `sessions.list.getSnapshot().current` | 快照里 `retainedBy.mainView > 0` 的那条（官方 UI 同口径） |

**验证**：新增 `scripts/api-compat.selftest.cjs`（32 断言，DOM 桩 boot 面板 → 服务就绪 → 点真实渲染出的 💬 → 断言建会话/投递/导航/toast），
外加 `scripts/api-compat.mutation.cjs` 变异反证（把"现取"改回"开机取一次"必须变红）；`bundle-smoke` 增加旧 API 回流禁令。
全套 17 个测试文件 **673 PASS / 0 FAIL**。

**待你操作**：重启 DSH（面板属客户端 bundle，无法热加载）→ 点 💬 应看到：在"讨论落点"判定的工作区里新建会话、自动跳过去，
开局消息含候选上下文 + 同族证据 + 只读约束。

> **重启口径（本节更正 §8.3 的旧说法）**：`cordis.patch.yml` 的加载器行虽会被运行中的实例重新解析，但**已加载的宿主模块不会重载**
> （干净对照：部署后不重启，`/whale/live` 仍自报旧 `version`）→ 宿主代码改动同样要重启；client 模块图更是启动时算定的 → 浏览器半边必须重启。
> 顺序铁律仍然成立：**先 `deploy-web --apply`，再重启** —— 反序的话重启加载的是旧副本。

## 9. 精读中发现的文档漂移（建议顺手修）

| # | 现象 | 依据 | 影响 |
|---|---|---|---|
| 1 | 文档里的 `runScanInner` **在源码中不存在**，实体是 `runScanGen` | `PROJECT-INTRO.md` §5/§8、`CHANGELOG.md` v0.7.7 与 `docs/...五项遗留问题...md` 均写 `runScanInner`；`grep` 全仓仅文档命中，源码只有 `runScanGen`（`engine.cjs:820`） | 低（只是名字不对），但会让接手者找一个不存在的函数 |
| 2 | `README.md` 顶部写「486 断言」、底部又写「386 断言 + 457 累计」 | `README.md:6` vs `README.md:100`；实测为 **609 PASS**（15 套件 + bundle-smoke，16 文件） | 低（自述不一致，易误导） |
| 3 | `PROJECT-INTRO.md` §5 模块地图漏登记 `store/repo.selftest.cjs` | 该文件存在（34 PASS），§5「测试」行未列它 | 低 |
| 4 | `settings.minOccurrences` 是**死设置** | `schema.cjs:36` 有默认值、文档多处声明，但全仓无读取点（审计 N28 已记录，仍未修） | 低（用户以为设了有用） |
| 5 | `plugin/manifest.json` 的 `agentsMode` 仍是 `whole`，而 v0.7.7 已"迁 zones 模式" | `manifest.json:14` vs CHANGELOG v0.7.7 ③ | **中**：新机安装默认走 whole，与"zones 已是主流"的叙述不一致（见 §8） |
| 6 | 退出码注释称「2 = 前置缺失」，实际 `ok:false` **还覆盖"写锁不可用"与"Node 缺 zstd"** | `cli.cjs:23` 注释 vs `engine.cjs:788`（缺 zstd）、`engine.cjs:792/813`（锁忙）都返回 `ok:false` → `mine.cjs` 一律 exit 2 | 低：脚本若按"2 = 环境没装好"分支处理会误判 |
| 7 | `engine.cjs:612` 的 `opts.echoSeen` 无任何调用方传入 | 全仓仅此一处出现，实际总是走 `repo.readEchoSignatures()` | 低（死分支） |

## 10. 测试与验收

```powershell
# 全量自检（全部在临时沙盒跑，绝不触碰真实 ~/.dsh）
node plugin\lifecycle\selftest.cjs                    # 152 PASS 安装/卸载/清单/漂移分级/desktop 端到端/不碰真实部署反证
node plugin\src\ui\server.selftest.cjs                #  82 PASS 面板 host 逻辑 + 端点闸门 + 开关写路径纪律
node plugin\src\store\repo.selftest.cjs               #  34 PASS 严格读/CAS/写锁/编号下限/回声轮转/TTL
node plugin\src\collector\engine.selftest.cjs         #  38 PASS 异步一致/窗口化/维护窗口/取消清理
node plugin\src\collector\engine.dedup.selftest.cjs   #  24 PASS 已处置签名去重
node plugin\src\collector\e2e.selftest.cjs            #  67 PASS zstd 全链端到端
node plugin\src\collector\live.selftest.cjs           #  48 PASS 实时采集/双计口径/维护让路
node plugin\src\collector\sweep.selftest.cjs          #  20 PASS 历史深掘全链（两阶段/幂等/上限）
node plugin\src\core\privacy.selftest.cjs             #  23 PASS 打码出口
node plugin\src\core\summarize.selftest.cjs           #  10 PASS 现象一句话
node plugin\src\core\similarity.selftest.cjs          #  20 PASS 同族判定（含"不得误并"反证）
node plugin\scripts\panel-actions.selftest.cjs        #  30 PASS 面板两个新入口纯函数
node plugin\scripts\links-doctor.selftest.cjs         #  43 PASS 悬空链接体检
node plugin\scripts\discuss-route.selftest.cjs        #  28 PASS 讨论落点路由
node plugin\scripts\api-compat.selftest.cjs           #  32 PASS（v0.7.10）DOM 桩起面板 → 点真实 💬 → 建会话/投递/导航
node plugin\scripts\api-compat.mutation.cjs           #  变异反证（改回"开机取一次"必须变红）
node scripts\redact.test.cjs                          #  22 PASS 打码回归
node plugin\scripts\bundle-smoke.cjs                  #  结构断言（client bundle 桩 + 旧客户端 API 回流禁令，不计 PASS 数）
```

实测合计 **673 PASS / 0 FAIL + 1 项变异反证**（2026-10-02，17 个测试文件）。这些自检是**改代码时的第一道防线**，改动后必须全绿再同步发布。

## 11. 待办与后续方向

**审计剩余（`docs/2026_09_11_11_...安全与健壮性审计报告.md`，v0.7.4–v0.7.8 已清掉 P0 三项 + P1 大部分）**：

| 优先级 | 项 | 说明 |
|---|---|---|
| P1 剩余 | N20 | 中段坏帧已分类并计数（`corruptAt=mid` + `badRounds`/`stuckFiles`），但"连续 ≥2 轮升级为可见错误"尚仍只落在 `/whale/live`，未做主动升级 |
| P1 | N8 | 回声过滤仍有漏网（已有五层签名 + 出处整类拦截，属持续对抗） |
| P1 | N22 | live 与批扫双计（实测**未发生**，已留 `toolUnknown`/`skippedByFingerprint` 观测口径） |
| P2 | N24 | `clusters` 永不裁剪；`state.files` 占 state.json ~65%（含 callId→工具名映射） |
| P2 | N25 剩余 | `lastError` 成功后不清；"半瘫"（inbox 在增但水位线不推进）未主动告警 |
| P2 批次 | N2/N9–N17/N26/N27/N28/N29 | 一批低风险顺手修，其中较实在的：**N26** `--prewarm --dry` 仍写盘（缺 `if (!o.dry)` 守卫）· **N27** CLI 未知参数静默忽略（`--dray` 会被当成非 dry **真的写盘**且退出码 0）· **N28** 死设置 `minOccurrences` · **N29** 目录类读取无 try/catch（TOCTOU） |

**路线图（`PROJECT-INTRO.md` §8「未来」）**：会话平面挂载（工具/事件）· B2 项目级自动注入（项目根 AGENTS.md，逐项目知情试点）· 复发检测深化（二期）· 面板增强（桌宠形态/事件推送，契约已备于 `ui/contracts.md`）。

**接手建议顺序**：

1. 先决定是否安装运行实例（§8），让权威源就位；
2. 若继续开发，**先在权威源改**（`~/.dsh/whale-notebook/plugin/`），跑对应自检，再 `node tools\sync-release.cjs` 同步回仓库；
3. 若暂不安装，则把仓库当工作副本，但**同步前务必先解决"权威源会覆盖仓库"的问题**（否则一跑 sync 改动全丢）；
4. 顺手修 §9 的 6 处文档漂移（纯文档改动，零风险，但能显著降低后续接手成本）。
