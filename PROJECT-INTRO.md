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
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-whale-notebook` | R 段运行时：插件包部署副本（**v2.1 决策箱面板**；`plugin/scripts/deploy-web.cjs` 管理，重启 dsh web 生效） | R 运行时段（lifecycle 清单内仍 deferred，部署副本由 deploy 工具管） |

### 运行数据目录 `~/.dsh/whale-notebook/` 内部

| 路径 | 内容 |
|---|---|
| `PROJECT-INTRO.md` | ★本文：项目总览 |
| `README.md` | 给"人"的目录说明与隐私策略 |
| `inbox.md` | ★待审核箱：候选行 `\| C### \| 类别 \| 次数 \| 工作区 \| 现象(打码) \| 时间 \|` |
| `entries/` | 已入库经验条目 `E###-*.md`（frontmatter + 现象/根因/对策/验证） |
| `archive/` | 已处理候选归档（溯源） |
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
- **条目 frontmatter**：id/title/category/status(active|disabled)/occurrences/firstSeen/lastSeen/workspaces/rule/created/updated/sources——模板见 `schema.cjs renderEntryFile`。
- **规则行**：`- 【类别】对策一句话`，进 AGENTS 自动段按 occurrences 排序、最多 `maxRulesInAgents`(12) 条。
- **AGENTS 自动段**：整段由生成器维护（`plugin/src/inject/agents.cjs`），**勿手改**（会被下次入库刷新覆盖）。
- **唯一读写入口**：`plugin/src/store/repo.cjs`（路径常量 + 原子写）；`plugin/src/core/privacy.cjs` 是打码/指纹唯一出口。
- **采集口径（v2.0 起）**：只收**用户报障类消息**的失败/特征事件 + 工具失败信号；助手叙述回声已移除（自引用污染）。
- **隐私铁律**：任何文本进箱前过 `redact`（密钥打码）+ `hash36`（指纹）；禁止存原文、个人路径、密钥。

## 5. 插件模块地图（plugin/src/，单向依赖）

| 层 | 模块 | 职责 | 关键导出 |
|---|---|---|---|
| 领域 | `core/schema.cjs` | 类别表/设置默认/AGENTS 标记/inbox 行/条目模板/规则行 | `CATEGORY_TITLES`、`AGENTS_MARK`、`inboxRow`、`renderEntryFile`、`ruleLine` |
| 领域 | `core/privacy.cjs` | 打码 redact / 指纹 hash36 / 规范 canonText（隐私唯一出口） | `redact`、`hash36`、`canonText` |
| 领域 | `core/util.cjs` | fmtTime 等小工具 | `fmtTime` |
| 数据 | `store/repo.cjs` | 路径常量 + settings/state/inbox/entries/archive/INDEX 读写（原子替换；未来可换 sqlite/远程） | `P`(路径)、读写函数、`listEntries` |
| 记录 | `collector/decoder.cjs` | zstd 多帧 JSONL 会话解码（Node≥22） | `decode` |
| 记录 | `collector/patterns.cjs` | 坑特征词典（展示/硬拦共用） | 特征表 |
| 记录 | `collector/scanner.cjs` | 单会话事件抽取（失败/特征；自引用与框架排除） | `scanSession` |
| 记录 | `collector/engine.cjs` | 扫描→指纹去重→聚簇→check 追加候选；--stats/--prewarm | `runScan` |
| 记录 | `collector/cli.cjs` | CLI 分发（含 --render-rules 预览自动段正文） | `run` |
| 生效 | `inject/agents.cjs` | AGENTS 自动段正文生成（排序/上限/尾注/标记内替换）；落盘由 agent 用 edit 工具执行 | `buildSectionBody`、`applyToText` |
| 审核 | `review/commit.cjs` | 计划式入库纯函数（展示→确认后由 agent 落盘） | `planCommit` |
| 展示 | `ui/viewmodel.cjs` | 待审/统计视图模型（UI 唯一数据入口） | `inboxViewModel` 等 |
| 展示 | `ui/server.cjs` | 决策箱面板 host API 纯逻辑（list / delete→归档，幂等） | `listPayload`、`deleteCandidate` |
| 展示 | `ui/contracts.md` | UI/桌宠接入契约与事件平面 | — |
| 入口 | `lib/index.js` | cordis 插件入口 host half：注册 `GET /whale/inbox`、`POST /whale/inbox/delete` | `apply` |
| 浏览器 | `lib/client.js` | 决策箱悬浮面板 bundle（`__ModuleLoader__` 零依赖纯 DOM；轮询 + 三动作：自动处理/讨论新会话/删除） | `apply`（browser） |
| 挂载 | `cordis.patch.yml` | 主机平面挂载行模板（参考；现场行由 deploy-web.cjs 写 profiles/web/cordis.patch.yml） | — |
| ★部署 | `scripts/deploy-web.cjs` | 复制包 → profile node_modules + patch loader 行（幂等 dry/apply/undo/check；生效需重启 dsh web） | — |
| 测试 | `src/ui/server.selftest.cjs`、`scripts/bundle-smoke.cjs` | 面板 host 逻辑沙盒 17 断言 / client bundle 桩执行 | — |
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
- **v2.1（已完成代码与部署工具，待重启生效）**：决策箱悬浮侧边面板 —— host half（`/whale/*` API）+ browser half（client-plugin，零依赖 bundle）+ `deploy-web.cjs` 一键部署；设计见 `docs/2026_09_09_18_…决策箱面板设计.md`。**生效需用户择机重启 GUI**。
- **未来**：失败事件实时采集（订阅 tool/result、agent/request-error）；会话平面挂载；面板增强（桌宠形态/事件推送，契约已备）。

## 9. 文档导航（docs/，均为设计记录）

| 文档 | 内容 |
|---|---|
| `2026_09_09_15_whale-notebook自我进化机制实施记录.md` | v1 落地过程：机制/路径/命令/隐私 |
| `2026_09_09_16_whale-notebook插件化架构设计.md` | v2.0 架构：三平面(H/S/U) + 六模块 + 挂载路线 |
| `2026_09_09_16_whale-notebook生命周期设计.md` | 第 0 功能设计：足迹/清单/卸载分级/验收 |
| `2026_09_09_17_whale-notebook生态调研核实与定位对比.md` | 生态核实（14 项目）+ 四维差异 + 结论 |
| `2026_09_09_18_whale-notebook决策箱面板设计.md` | v2.1 决策箱面板：机制勘察/架构/契约/部署验收 |

## 10. 常用命令速查

```text
node ~/.dsh/whale-notebook/scripts/mine.cjs --check|--prewarm|--stats|--render-rules   # 采集 CLI(v1 壳)
node ~/.dsh/whale-notebook/plugin/lifecycle/selftest.cjs                                # 生命周期沙盒自测(66 PASS)
node ~/.dsh/whale-notebook/plugin/lifecycle/cli.cjs status|check|install|uninstall …    # 生命周期工具
node ~/.dsh/whale-notebook/plugin/scripts/deploy-web.cjs [--apply|--undo|--check]      # 决策箱面板部署(改后需重启 dsh web)
node ~/.dsh/whale-notebook/plugin/src/ui/server.selftest.cjs                           # 面板 host 逻辑沙盒自测(17 PASS)
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
6. 决策箱面板（GUI 右缘悬浮件）：列表只读 inbox；「删除」动作=移入 archive（可恢复）；面板部署/回退/升级一律 `plugin/scripts/deploy-web.cjs`（改 client.js 后需重启 dsh web）。
7. 改完运行源码/文档 → `node tools\sync-release.cjs` 同步到 GitHub 库（在镜像库目录下执行）。
