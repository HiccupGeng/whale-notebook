# 鲸鱼闪闪发光的小本本（whale-notebook）· 项目总览

> 给新上手的人与 DeepSeek Harness 会话的**全景导读**：先读本文件，再按 §9 文档导航深入。
> 权威位置：`~/.dsh/whale-notebook/PROJECT-INTRO.md`（本机运行目录）｜ 发布镜像：仓库根 `PROJECT-INTRO.md`（随 `tools/sync-release.cjs` 同步）。

## 1. 项目是什么

DeepSeek Harness（DSH）的**自我进化机制**：把本机全部工作区会话中反复出现的问题/教训，自动挖掘 → 提炼为候选经验 → **经用户逐条确认**后写入全局经验库 → 以规则行注入 `~/.dsh/AGENTS.md` 自动段（每个新会话开始自动注入），让未来的会话不再踩同样的坑。

一句话：**从"这次踩坑"到"永不重犯"的闭环，全部在本机、全部由用户掌控、只存打码摘要。**

四个设计支柱：
1. **数据源**：离线全量挖掘本机 DSH 会话日志（`~/.dsh/sessions/*/session.jsonl.zstd`，zstd 多帧 JSONL）。
2. **沉淀形态**：人类可审的候选箱（inbox.md）→ 条目库（entries/）→ AGENTS.md 规则行（每会话注入）。
3. **人机关系**：决策箱逐条审核——**任何写入前先展示，用户确认才落盘**；AI 从不静默改记忆。
4. **隐私**：只读会话日志、不复制原文；文本入箱前打码（密钥→`[REDACTED]`），指纹仅存 FNV-1a 短哈希；数据永不离开本机（不上库、不上传）。

## 2. 目录地图

### 本机运行环境（~/.dsh 下）

| 路径 | 内容 | 归属 |
|---|---|---|
| `~/.dsh/AGENTS.md` | L1 全局记忆：whale 维护自动段（rules 标记区内，每会话注入）；`<!-- whale-notebook:rules -->`…`<!-- /whale-notebook:rules -->` + `<!-- whale-notebook:privacy -->` 尾注区 | I 集成段 |
| `~/.dsh/skills/whale-notebook.md` | L2 技能：操作手册（触发词→流程），技能目录热加载 | I 集成段 |
| `~/.dsh/whale-notebook/` | ★运行数据目录（下详） | D 数据段 |
| `~/.dsh/whale-notebook/plugin/` | ★插件包源码（模块化，v2 结构；**运行源码权威位**） | D 内（发布镜像于 GitHub 库） |
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-whale-notebook` | R 段运行时：插件包部署副本（**v0.3.0 决策箱面板**；`plugin/scripts/deploy-web.cjs` 管理，重启 dsh web 生效） | R 运行时段（lifecycle 清单内仍 deferred，部署副本由 deploy 工具管） |

### 运行数据目录 `~/.dsh/whale-notebook/` 内部

| 路径 | 内容 |
|---|---|
| `PROJECT-INTRO.md` | ★本文：项目总览 |
| `README.md` | 给"人"的目录说明与隐私策略 |
| `inbox.md` | ★待审核箱：候选行 `\| C### \| 类别 \| 次数 \| 工作区 \| 现象(打码) \| 时间 \|` |
| `entries/` | 已入库经验条目 `E###-*.md`（frontmatter + 现象/根因/对策/验证；v0.4 加 `scope` global\|project + `projects` 适用白名单） |
| `INDEX.md` | ★已解决墙（v0.4：全局区/项目区 × 类别 + 停用；生成器 `repo.buildIndexMd`，`scripts/mine.cjs --wall` 预览；轻口径：入库=已处理） |
| `archive/` | 已处理候选归档（溯源；`archive/details/` = 候选详情随行归档） |
| `details/` | ★v0.3 候选详情 sidecar：`C###.md`（一句话/类别/源会话引用 ≤3/打码摘录 ≤600 字，超长注明源日志路径；删除候选随行进 `archive/details/`） |
| `state.json` | 增量状态：`lastScan`、`seenFingerprints[]`（只存指纹）、`nextCandidateId` |
| `settings.json` | 开关：autoCollect / denylistWorkspaces / minOccurrences / maxRulesInAgents / checkEnabled |
| `scripts/mine.cjs` | v1 兼容薄壳（AGENTS 提醒句/skill 都指向它；转发 plugin 的 collector/cli） |
| `scripts/redact.test.cjs` | 打码回归测试（13 断言） |
| `.lifecycle/` | ★生命周期站点状态：`manifest.json` 足迹清单 + `backups/` 字节快照（**remove 保留、purge 随 D 删除**） |

### 发布仓库（GitHub：HiccupGeng/whale-notebook，private；工作区镜像 `C:\DeepSeekHarnes\SandBox1\whale-notebook\`）

| 路径 | 内容 |
|---|---|
| `PROJECT-INTRO.md` | 本文发布镜像（与权威一致，sync 自动带） |
| `README.md` | 库门面：结构/现状路线/隐私边界/开发流 |
| `plugin/` | 插件包源码镜像（`~/.dsh/whale-notebook/plugin`） |
| `docs/` | 设计/调研记录（四份，sync 自动带） |
| `tools/sync-release.cjs` | 一键同步提交：权威 → 库 → commit → push |
| `scripts/` | mine.cjs / redact.test.cjs 镜像 |

> 开发流：**改动先在权威位（运行 plugin / 工作区 docs / 本文件）完成并验证**，再 `node tools\sync-release.cjs` 一键同步提交推送。库内禁止出现用户记忆数据（.gitignore + 脚本双层兜底）。

## 3. 工作流（技能触发词）

| 你说 | 做什么 |
|---|---|
| 「小本本复盘」 | 全量采集并提炼候选（写 inbox.md，先展示） |
| 「小本本待审 / 审核箱」 | 查看候选编号列表（C### 一行一条） |
| 「入库 C001,C003」（勾选） | 经 commit.cjs 计划式生成条目 → 展示 → 确认 → 写 entries + 更新 AGENTS 自动段 |
| 「小本本讨论 <主题>」 | 就地讨论某类问题，新结论可再入库 |
| 「小本本忘掉 E###」 | 条目停用并移出自动段 |
| 「小本本统计 / 导出」 | 统计总览 / 导出打包（仅通用经验） |
| 新会话自动 | scripts/mine.cjs --check 有新候选时静默提醒一次（用户「先不管」则本会话不再提醒） |

## 4. 数据不变式（改数据前必读）

- **inbox 行**：`| C### | 类别 | 次数 | 工作区 | 现象(打码,≤120字) | 时间 |`；类别键见 `plugin/src/core/schema.cjs` `CATEGORY_TITLES`（encoding/stale-fs/sandbox-*/approval/tool-mode/git-net/secret/session-state/data-access/long-session/timeout/model-api/file-missing/port-busy/other）。
- **条目 frontmatter**：id/title/category/status(active|disabled)/**scope(global|project)**/**projects(适用白名单)**/occurrences/firstSeen/lastSeen/workspaces/rule/created/updated/sources——模板见 `schema.cjs renderEntryFile`（scope 缺省=global，旧条目零迁移）。
- **规则行**：`- 【类别】对策一句话`，进 AGENTS 自动段按 occurrences 排序、最多 `maxRulesInAgents`(12) 条；**v0.4 B1：自动段只收 scope=global 条目**，项目级永不进全局注入（去向见状态行与 INDEX 已解决墙项目区）。
- **AGENTS 自动段**：整段由生成器维护（`plugin/src/inject/agents.cjs`），**勿手改**（会被下次入库刷新覆盖）。
- **唯一读写入口**：`plugin/src/store/repo.cjs`（路径常量 + 原子写）；`plugin/src/core/privacy.cjs` 是打码/指纹唯一出口。
- **采集口径（v2.0 起）**：只收**用户报障类消息**的失败/特征事件 + 工具失败信号；助手叙述回声已移除（自引用污染）。
- **去重事实源（v0.6.3）**：`state.json` 可被重置/重建，**不作为"已处置"判据**；已处置以 `archive/archive-*.md` 为准（末列非空 = 已处置）。`engine.loadResolvedIndex()` 按 `parseArchiveRow`（前 4 列固定、从右端切时间列与处置列，容忍行内半角 `|` 与两种历史行形态）建签名索引，新聚簇命中即压掉不开行；在箱聚簇由 `pruneResolvedIndex` 剔除以保留复发语义。约束：**归档行的现象文本必须与引擎聚簇文本一致**（勿在归档时改写正文，否则签名失配）。
- **隐私铁律**：任何文本进箱前过 `redact`（密钥打码）+ `hash36`（指纹）；禁止存原文、个人路径、密钥。

## 5. 插件模块地图（plugin/src/，单向依赖）

| 层 | 模块 | 职责 | 关键导出 |
|---|---|---|---|
| 领域 | `core/schema.cjs` | 类别表/适用范围 SCOPE_TITLES/设置默认/AGENTS 标记/inbox 行/条目模板(scope+projects)/规则行 | `CATEGORY_TITLES`、`SCOPE_TITLES`、`AGENTS_MARK`、`inboxRow`、`renderEntryFile`、`ruleLine` |
| 领域 | `core/privacy.cjs` | 打码 redact(压白,兼容不变式) / redactLines(保留行结构) / 指纹 hash36 / 规范 canonText（隐私唯一出口） | `redact`、`redactLines`、`hash36`、`canonText` |
| 领域 | `core/util.cjs` | fmtTime 等小工具 | `fmtTime` |
| 领域 | `core/summarize.cjs` | v0.3 现象一句话 oneLiner（纯规则行级清洗 + 句界截断 ≤90 字） | `oneLiner` |
| 数据 | `store/repo.cjs` | 路径常量 + settings/state/inbox/entries(scope/projects 解析+去引号)/INDEX 已解决墙生成/readEntryText/details 读写（原子替换；移除候选联动归档 detail） | `P`(路径)、读写函数、`listEntries`、`readEntryText`、`buildIndexMd`、`writeDetail` |
| 记录 | `collector/decoder.cjs` | zstd 多帧 JSONL 会话解码（Node≥22） | `decode` |
| 记录 | `collector/patterns.cjs` | 坑特征词典（展示/硬拦共用） | 特征表 |
| 记录 | `collector/scanner.cjs` | 单会话事件抽取（失败/特征；自引用与框架排除） | `scanSession` |
| 记录 | `collector/engine.cjs` | 扫描→指纹去重→聚簇→check 追加候选（现象一句话）+ 详情 sidecar（源引用/600 字摘录）；--stats/--prewarm | `runScan`、`buildDetailMd` |
| 记录 | `collector/cli.cjs` | CLI 分发（--render-rules 预览自动段；v0.4 --wall 预览已解决墙全文） | `run` |
| 生效 | `inject/agents.cjs` | AGENTS 自动段正文生成（v0.4 B1：只收 scope=global；排序/上限/尾注/标记内替换）；落盘由 agent 用 edit 工具执行 | `buildSectionBody`、`applyToText` |
| 审核 | `review/commit.cjs` | 计划式入库纯函数（展示→确认后由 agent 落盘） | `planCommit` |
| 展示 | `ui/viewmodel.cjs` | 待审/统计/**已解决墙**视图模型（UI 唯一数据入口） | `inboxViewModel`、`statsViewModel`、`solvedViewModel` |
| 展示 | `ui/server.cjs` | 决策箱面板 host API 纯逻辑（list / detail 读取 / delete→归档 / v0.4 solved 聚合 / entry 全文，幂等） | `listPayload`、`detailPayload`、`deleteCandidate`、`solvedPayload`、`entryPayload` |
| 展示 | `ui/contracts.md` | UI/桌宠接入契约与事件平面 | — |
| 入口 | `lib/index.js` | cordis 插件入口 host half：注册 `GET /whale/inbox`、`GET /whale/inbox/detail`、`GET /whale/solved`、`GET /whale/entry`、`POST /whale/inbox/delete` | `apply` |
| 浏览器 | `lib/client.js` | 决策箱悬浮面板 bundle（`__ModuleLoader__` 零依赖纯 DOM；轮询 + 三动作；v0.3：红 ✕ / 判定表模板 / detail 预取 / `[WHALE-RISK]` 观察→红色警示条→一键转人工讨论；v0.4：**双卡** 待审箱｜已解决墙——全局区/项目区分组、行点击拉全文展开） | `apply`（browser） |
| 挂载 | `cordis.patch.yml` | 主机平面挂载行模板（参考；现场行由 deploy-web.cjs 写 profiles/web/cordis.patch.yml） | — |
| ★部署 | `scripts/deploy-web.cjs` | 复制包 → profile node_modules + patch loader 行（幂等 dry/apply/undo/check；生效需重启 dsh web） | — |
| 测试 | `src/ui/server.selftest.cjs`(45) + `src/core/privacy|summarize.selftest.cjs`(20) + `src/collector/engine|e2e.selftest.cjs`(21, zstd 全链) + `scripts/bundle-smoke.cjs` | v0.4.0 共 5 套件 86 断言 + bundle 桩（含 v0.4 结构断言），全绿 | — |
| ★自举 | `lifecycle/` | 安装/卸载/清单（第 0 功能，**仅 node 内建**，与业务模块解耦） | `cli.cjs` 等 |
| ★清单 | `manifest.json` | 包内默认足迹清单（I/D/R 条目 = 卸载白名单） | — |

模块依赖单向：`ui → viewmodel → store`；`review → (schema, inject, store)`；`inject → schema`；`collector → (core, store)`；`store → core`；`core` 零依赖。

## 6. 生命周期（安装/卸载/清单，第 0 功能）

- **三段足迹**：**R 运行时**（profiles 包本体 + bundles 声明，v2.1 挂载后才有，清单内 deferred）；**I 集成**（AGENTS 标记区 + skill 文件）；**D 数据**（`~/.dsh/whale-notebook/`，**用户记忆，永不静默删**）。
- **命令**（`node plugin/lifecycle/cli.cjs …`，全部两段式：先干跑出计划 → 确认 → `--apply`）：

| 命令 | 作用 |
|---|---|
| `status` | 阶段/各段足迹/上次操作 |
| `check` | 清单 vs 现场对账 + 孤儿扫描（问题 exit 1） |
| `install` | 登记/安装（默认 whole 模式整文件管 AGENTS；`--agents-mode zones` 只管标记区） |
| `uninstall remove` | 清 R+I；**D 原样保留**（记忆永不清）；删除前快照 |
| `uninstall purge` | 全清：必须 `--export-dir` + `--yes`（先导出成果后删除） |
| `uninstall detach` | 仅 R 段（v2.1 后启用） |

- **约定**：卸载计划先输出**成果文件清单**（待审/条目/归档计数+去留）——AI 删除前必先经用户确认；漂移守卫（登记后文件被改需 `--yes`）；快照 `backups/` 支持重装字节还原。
- **已验证**（2026-09-09）：沙盒 66 PASS + 本机真实卸载演练（remove→核对→重装 hash 一致）。

## 7. 隐私与安全模型（红线）

1. 数据只在本机 `~/.dsh`；不自动联网、不上传、不随技能离开。
2. 采集只读会话日志，绝不修改原始日志。
3. 不复制原文；密钥打码；指纹短哈希；条目/规则只写通用对策。
4. 先展示后写入；denylist 整工作区拉黑；「忘掉 E###」即停用。
5. 卸载分级保护：remove 不碰 D；purge 必须先导出 + 二次确认。
6. 记忆数据（inbox/entries/state/AGENTS/.lifecycle）**永不进 git 仓库**。

## 8. 现状与路线图

- **v1**（已完成）：skill + scripts 落地（AGENTS 标记注入链路打通；本机有 12 条种子候选 C001–C012 待审）。
- **v2.0**（已完成）：插件化模块重构（六模块 + 单向依赖；行为/数据不变式兼容）。
- **v2.0.x 当前**：第 0 功能「生命周期」v0.1 完成（lifecycle 工具 + manifest + 演练）；GitHub 私有库建立 + 一键同步工具。
- **v2.1 + v0.3.0（代码与部署已完成，待用户重启 GUI 生效）**：决策箱悬浮侧边面板 —— host half（`/whale/*` API）+ browser half（client-plugin，零依赖 bundle）+ `deploy-web.cjs` 一键部署；v0.3.0 增强：现象行一句话、候选详情 sidecar（`details/C###.md` + `GET /whale/inbox/detail`）、删除改红色 ✕、自动处理判定表硬规则 + `[WHALE-RISK]` 上报 → 面板红色警示条 + 一键转人工讨论。设计见 `docs/2026_09_09_18_…面板设计.md` 与 `docs/2026_09_09_22_…v0.3实施计划.md`。**生效需用户择机重启 GUI**。
- **v0.4.0（代码与部署已完成，随重启同批生效）**：已解决墙 + 两级分类 —— 条目 frontmatter 增 `scope`（global|project）+`projects` 白名单（缺省 global 零迁移）；**B1**：AGENTS 自动段只收全局规则，项目级不进全局注入（状态行注明去向）；A1 文档墙 INDEX.md（全局区/项目区 × 类别 + 停用收尾）+ A2 面板「已解决」卡（`GET /whale/solved`、`GET /whale/entry?id=E###`，行点击展开全文）。决策：①轻口径（入库=已处理）②A1+A2 一期都做 ③先 B1 后 B2（本次 B1；B2 项目级注入 = 三期试点）。设计见 `docs/2026_09_09_23_…需求梳理.md` 与 `docs/2026_09_09_23_…v0.4实施计划.md`。
- **未来**：失败事件实时采集（订阅 tool/result、agent/request-error）；会话平面挂载；B2 项目级自动注入（项目根 AGENTS.md，逐项目知情试点）；复发检测（二期，engine/state 扩展）；面板增强（桌宠形态/事件推送，契约已备）。

## 9. 文档导航（docs/，均为设计记录）

| 文档 | 内容 |
|---|---|
| `2026_09_09_15_whale-notebook自我进化机制实施记录.md` | v1 落地过程：机制/路径/命令/隐私 |
| `2026_09_09_16_whale-notebook插件化架构设计.md` | v2.0 架构：三平面(H/S/U) + 六模块 + 挂载路线 |
| `2026_09_09_16_whale-notebook生命周期设计.md` | 第 0 功能设计：足迹/清单/卸载分级/验收 |
| `2026_09_09_17_whale-notebook生态调研核实与定位对比.md` | 生态核实（14 项目）+ 四维差异 + 结论 |
| `2026_09_09_18_whale-notebook决策箱面板设计.md` | v2.1 决策箱面板：机制勘察/架构/契约/部署验收 |
| `2026_09_09_22_whale-notebook决策箱v0.3实施计划.md` | v0.3.0：一句话现象+详情 sidecar / 红✕ / 自动判定表与 RISK 上报 / P0–P5 与验收 |
| `2026_09_09_23_whale-notebook已解决问题展示与分类需求梳理.md` | 需求梳理：已解决墙 A1/A2、全局/项目分类、B1/B2/B3 对比、决策与答疑记录 |
| `2026_09_09_23_whale-notebook已解决墙与分类v0.4实施计划.md` | v0.4.0：scope/projects 数据模型 + INDEX 已解决墙 + 面板双卡 + B1 + 测试验收 |

## 10. 常用命令速查

```text
node ~/.dsh/whale-notebook/scripts/mine.cjs --check|--prewarm|--stats|--render-rules|--wall   # 采集 CLI(v1 壳; --wall=v0.4 已解决墙预览)
node ~/.dsh/whale-notebook/plugin/lifecycle/selftest.cjs                                # 生命周期沙盒自测(66 PASS)
node ~/.dsh/whale-notebook/plugin/lifecycle/cli.cjs status|check|install|uninstall …    # 生命周期工具
node ~/.dsh/whale-notebook/plugin/scripts/deploy-web.cjs [--apply|--undo|--check]      # 决策箱面板部署(改后需重启 dsh web)
node ~/.dsh/whale-notebook/plugin/src/ui/server.selftest.cjs                           # 面板 host 逻辑沙盒自测(45 PASS, 含 v0.4 墙/B1)
node ~/.dsh/whale-notebook/plugin/src/core/privacy.selftest.cjs | summarize.selftest.cjs  # 打码出口/一句话(10+10)
node ~/.dsh/whale-notebook/plugin/src/collector/engine.selftest.cjs | e2e.selftest.cjs    # detail 协议 / zstd 全链(10+11)
node ~/.dsh/whale-notebook/plugin/scripts/bundle-smoke.cjs                             # client bundle 桩检查
node ~/.dsh/whale-notebook/scripts/redact.test.cjs                                      # 打码回归
node <repo>/tools/sync-release.cjs                                                      # 一键同步提交(库内)
```

## 11. 给 AI 会话的快速指引

1. 用户提到小本本相关诉求 → 加载技能 `whale-notebook` 按其流程执行；本文件提供全景背景。
2. 任何**读**数据：直接读（inbox.md 展示、entries frontmatter、settings/state）。
3. 任何**写**数据：先用 repo 层纯函数/生成器出计划 → **展示给用户** → 用户确认 → 才落盘；AGENTS 自动段改动用 edit 工具替换标记区内整段（保证 agent-instructions 观测到变更）。
4. 私密内容处理走 `core/privacy.cjs`；拿不准的文本一律先打码。
5. 涉及安装/卸载/删除 → 走 `lifecycle/cli.cjs`（干跑 → 展示成果清单 → 确认 → --apply），绝不手工乱删。
6. 决策箱面板（GUI 右缘悬浮件）：**双卡**——待审箱（只读 inbox，现象=一句话；详情在 `details/C###.md`（v0.3 起新候选自动生成，旧候选无）；「删除」✕=移入 archive（可恢复，detail 随行归档）；⚡自动处理只允许「补全型小修」自动执行，重大隐患（删除/动 DSH 结构/影响产出等）禁止并上报 `[WHALE-RISK]`，红色警示条可一键转人工讨论）与 已解决墙（✅ 有条目才出现；轻口径：入库=已处理；全局区/项目区，行点击展开条目全文）；面板部署/回退/升级一律 `plugin/scripts/deploy-web.cjs`（改 client.js 后需重启 dsh web）。
7. 条目适用范围（v0.4）：入库时给用户「拟 scope」建议并确认——global 进全局自动段；project 级条目带 `projects` 白名单、**永不进全局自动段**（B1），只在 INDEX.md 已解决墙项目区/面板已解决卡按项目查阅；想回答「解决过哪些问题」read INDEX.md 即可。
8. 改完运行源码/文档 → `node tools\sync-release.cjs` 同步到 GitHub 库（在镜像库目录下执行）。
