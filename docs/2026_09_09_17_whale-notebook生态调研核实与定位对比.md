# 市场生态调研核实与定位对比报告（whale-notebook）

> 日期：2026-09-09 ｜ 作者：（待补） ｜ 版本：v1.0
> 性质：调查 / 核实 / 定位对比 ｜ 关联文档：`2026_09_09_16_whale-notebook插件化架构设计.md`、`2026_09_09_16_whale-notebook生命周期设计.md`

## 0. 结论先行

1. **WorkBuddy 生态调研报告主体可信**：报告中点名的"类似插件"经逐项联网核验**绝大多数真实存在**，描述与仓库 README 高度吻合，引用索引站全部实测可达。早前会话中"报告或有大面积失实"的怀疑**不成立**，应订正。
2. **大方向是同一回事**：DSH"跨会话记忆 / 踩坑教训 / 自我进化"赛道已成熟，社区实现众多——需求真实、底层 seam 全部可行，本项目路线被生态验证。
3. **具体形态不是一回事**：核实所有头部插件后，**未发现任何与 whale-notebook 同构的现成实现**。本项目的差异化组合——「离线全量历史 session 挖掘 + 人审决策箱 + AGENTS.md 规则注入 + 指纹级隐私」——在生态中仍是空白生态位。
4. **无需推翻 v1**：生态对 AGENTS.md 注入通道的有效性、对 Cordis 可回滚卸载的"卸载即净"均有独立印证，本项目 v1（AGENTS+skill+scripts）与 v2 插件化方向均正确。

---

## 1. 核实对象与范围

| 项 | 内容 |
|---|---|
| 被核实报告 | `C:\Users\gengj\WorkBuddy\2026-09-09-15-42-03\dsh_自我进化记忆插件生态调研.md`（WorkBuddy AI 产出，2026-09-09） |
| 核实方法 | GitHub REST API 仓库/搜索查询、`raw.githubusercontent.com` README 原文抓取、HTTP 站点探活、npm registry 元数据查询（2026-09-09 17 时执行） |
| 核实清单 | 报告 §2 全部 14 个具名插件/项目、§3 全部 4 类 seam 声称、§5 全部 9 个参考 URL、以及"官方无内置长期记忆 / 700+ 仓库"两项总体声称 |

---

## 2. 逐项核验证据表

### 2.1 具名插件/项目（全部通过 GitHub API 或 README 原文确认存在）

| 声称项目 | 核验结果 | 证据要点 |
|---|---|---|
| `madage/dsh-self-improved` | ✅ 存在（11★） | 默认分支 **master**（按 main 抓取曾 404，属分支名问题非不存在）。描述与报告逐句吻合：L0 捕获→L1 抽取→L2 场景→L3 人格、`agent/pre-step` 注入、SQLite+FTS5+jieba+sqlite-vec、技能合成、M0–M6 完成并部署 web profile |
| `csyangwen/dsh-memory-evolve` | ✅ 存在 | README 确认：五轨记忆、git 分支感知、回合内审查（`reviewEnabled`）、**确认制写入**（"你确认后才生效"）、技能自进化+技能管理器、四轨待办、COI 调度、会话广播、提示词管理器；`dsh plugin --profile web add` 安装，卸载即净 |
| `Phant0Meow/dsh-meow-memory` | ✅ 存在 | 每工作区 `.dsh-meow/memory.db`（node:sqlite）；七层 soul/user/project/fact/**lesson**/topic/rules；BM25×艾宾浩斯衰减打分；首轮长期记忆块注入、次轮起关键词 top-2 命中；空闲 dream 整理；压缩后重注入 |
| `GIT121995/dsh-memory-gate` | ✅ 存在（3★） | GitHub API 确认（报告作者名小写 `git121995` 应为 `GIT121995`） |
| `PerryLink/dsh-memento` | ✅ 存在 | 仓库与 docs/adapters-guide.md 实测可达 |
| `Jesse-njx/dsh-memory` | ✅ 存在 | README 确认：**基于 DSH 无损 session log 的引用式记忆**——会话结束后台蒸馏为 `~/.dsh/memory/` 下的 markdown，每条带 `(sessionId, [start..end])` 引用；`memory_read`/`memory_expand` 工具、索引注入、`/memory` 命令与 CLI；"summaries are an index into ground truth, never the truth" |
| `LoserFox/distill` | ✅ 存在 | README 确认：每回合结束（`agent/turn-stopping`）派发后台反省子代理，提议 create/update 技能；**`distilled-by: dsh-distill` frontmatter 所有权标记**——非自有技能绝不改写；检查点推进，无人工每步确认 |
| `isheng-eqi/dsh-hermes-memory` | ✅ 存在 | MEMORY.md / USER.md 文件式记忆的 hermes-agent 移植 |
| `omdsh-dev/dsh-mnemon` | ✅ 存在 | 三层组合式记忆，含 Web UI Memory Spaces（截图 v0.5.4），有 dshfind 徽章 |
| `@modusensus/dsh-mneme` | ✅ 存在 | npm 包实测可查（报告 §2.⑤） |
| `lovezi0/dsh-memory-palace` | ✅ 存在 | WorkBuddy 文件式记忆移植：人类可读 Markdown、用户级+工作区级双层、**桥接 `.workbuddy/memory` 与 `.codebuddy/memory`**、删除需人工确认、设置页集成 |
| Hindsight（`@vectorize-io/hindsight-coding-agents`） | ✅ 存在 | 官方博客 2026-08-14「Give DeepSeek Harness a Memory of Your Codebase」实测 HTTP 200 |
| 报告 §2.⑤ 尾部极简派（simple-wiki-memory / engramory 等） | ◐ 未逐一深核 | 不影响主结论；与头部机制同类且报告自注"全为社区插件非官方" |

### 2.2 索引站与总量声称（全部 HTTP 200 实测可达）

| 声称 | 核验 |
|---|---|
| `findharness.com/blog/best-deepseek-harness-memory-plugins`（7+ 记忆插件横评） | ✅ HTTP 200 |
| `deepseek-harness-plugin.com/zh-CN/plugins/dsh-memory-evolve/` | ✅ HTTP 200 |
| `fluxbbs.com/deepseek-harness-plugin-roundup-2026` | ✅ HTTP 200 |
| `deepseekai.works/github`、`martianlee.github.io` 架构长文 | ✅ HTTP 200 |
| `dshfind.com`（另一记忆插件索引，报告未列） | ✅ HTTP 200 |
| GitHub `topic:dsh-plugin` 仓库数 | ✅ API 实测 **14,078**（报告"700+"为早期快照/保守口径，生态只多不少） |
| "DSH 官方无内置长期记忆" | ✅ 佐证：官方仓库 Discussion #2783「Harness 的极简模式当前没有记忆处理，是自己添加吗？」 |

### 2.3 报告勘误清单（小错，不影响结论）

1. `madage/dsh-self-improved` 默认分支是 **master** 非 main（抓 README 需用 master）。
2. 作者名大小写勘正：`GIT121995/dsh-memory-gate`、`Phant0Meow/dsh-meow-memory`、`csyangwen/dsh-memory-evolve`、`LoserFox/distill`。
3. "700+ 仓库"已过时（实测 topic 计数 14,078，口径含全量 topic 标记仓库）。
4. **本会话早前错误假设订正**：曾疑"报告夸大、cordis 自修改工具未安装"——实查 rc.2 profile node_modules 中 `@deepseek-ai/dsh-tool-cordis`、`dsh-cordis-host-runner`、`dsh-host-plugin-inventory` 等**原生生命周期包确实存在**，报告所述 seam（`agent/pre-step`、`agent/turn-stopping`、`dsh.bundle` 自动挂载、`dsh plugin add/remove`）与本地运行时一致。

---

## 3. 生态主流形态（六家头部代表）

| 插件 | 一句话机制 | 对项目最有价值的点 |
|---|---|---|
| dsh-self-improved | 运行时 L0 捕获→LLM L1 抽取→L2 场景→L3 人格；pre-step 召回注入；技能合成 | 完整自进化闭环 + 治理（caps/夜间审查/主开关） |
| dsh-memory-evolve | 五轨记忆 + git 分支感知 + **确认制写入** + 技能自进化 | 人审流（AI 只提议、人确认）与项目最接近 |
| dsh-meow-memory | 七层 SQLite + lesson 层 + 关键词命中注入 + dream 整理 | lesson≈"踩坑层"与"同一石头绊倒"概念同构 |
| dsh-memory (Jesse-njx) | 会话结束蒸馏→markdown 文件+日志引用→可审计可删 | "蒸馏是索引不是真相"+ 人工可审计哲学 |
| distill | 回合后反省子代理提议技能增改，所有权标记防误写 | **所有权标记与项目生命周期反向标记同构** |
| dsh-global-rules / dsh-rule-engine（报告未列，新发现） | 前者：设置面板编辑 `~/.dsh/AGENTS.md`（agent-instructions 通道）；后者：解析 AGENTS.md 规则并工具级机器化执行 | 印证 AGENTS.md 通道有效性；rule-engine ≈ 项目远期 L3 硬执行方向 |

---

## 4. 与 whale-notebook 的对比：同向性与四维硬差异

### 4.1 同向（大方向"是同一回事"的部分）

- 目标同源：从会话中沉淀经验/教训，跨会话生效，避免重复踩坑；
- 自我进化：均可生成/更新技能、巩固与纠正；
- 本地优先：fully local、无数据外传为头部共识；
- 回滚安全：cordis effect 卸载即净为社区统一宣称。

### 4.2 四维硬差异（具体形态"不是一回事"的部分）

| 维度 | 生态主流 | whale-notebook | 差异性质 |
|---|---|---|---|
| 数据源/时机 | 运行时实时捕获（安装后才记新会话） | **离线全量挖掘**（历史全部工作区 session 日志也可挖，含装之前） | 结构性差异，无竞品做历史回填 |
| 沉淀形态 | 记忆检索库（SQLite/向量，每轮动态召回） | **人审后固化成全局规则**（`~/.dsh/AGENTS.md` 静态注入）+ entries 档案 | 规则通道 ≠ 检索通道 |
| 人机关系 | 自动写为主（部分插件半确认/所有权标记） | **决策箱逐条人审**：候选 → 确认 → 才落盘 | 治理强度差异 |
| 隐私底线 | 存对话蒸馏摘要（内容本身） | **只存指纹/打码/通用对策，原文永不落库**（hash36、denylist、show-before-write） | 项目独有硬约束 |

---

## 5. 最接近者分析（各有缺项，无一同构）

| 插件 | 接近点 | 缺项（相对本项目） |
|---|---|---|
| dsh-memory-evolve | 确认制+踩坑轨+技能自进化 | 实时捕获不回溯历史；存对话内容非规则；不写 AGENTS.md |
| dsh-memory | 会话日志蒸馏+人工可审计+可删 | 只蒸会话结束后的新会话；产物是事实库非避坑规则 |
| distill | 所有权标记保护手写资产 | 自动提案无决策箱；只产技能不产 AGENTS 规则 |
| dsh-global-rules | 与项目同一 AGENTS.md 通道 | 仅编辑面板，无挖掘无审核无隐私管线 |

---

## 6. 对项目的结论与含义

1. **路线被验证，v1 无需推翻**：AGENTS.md 注入通道被生态确认为有效机制（连专用编辑器插件都有）；Cordis 卸载可回滚被生态反复宣称"卸载即净"。
2. **生命周期设计的印证**：生态证明"运行时段"（R）卸载由原生 `dsh plugin remove` + effect 回滚解决；本项目生命周期文档判断成立——**真正需要自建的是 I（AGENTS/skill 带标记段）与 D（数据目录）两段的清单化、无残留删除**。
3. **护城河三件套**：离线全量历史回填 + 决策箱人审 + 指纹级隐私（原文永不落库）。生态无人做历史回填，因为多数插件只关心"从现在开始记住你"，而本项目在意"过去踩的坑下次别再踩"。
4. **可点名借鉴**（均已核原文）：distill 的所有权标记（→ 生命周期反向标记）；evolve 的确认流与 git 分支感知（→ 决策箱与工作区粒度）；self-improved 的治理（cap/衰减/夜间审查/总开关）。
5. **不 fork 重造的理由**：生态主流是"记忆库+动态召回"哲学，本项目是"规则固化+静态注入"哲学，存储、注入、治理、隐私全链不同；fork 改造成本不低于自研，且会背上其内容型隐私模型。

---

## 7. 参考链接清单

- dsh-self-improved：https://github.com/madage/dsh-self-improved
- dsh-memory-evolve：https://github.com/csyangwen/dsh-memory-evolve
- dsh-meow-memory：https://github.com/Phant0Meow/dsh-meow-memory
- dsh-memory-gate：https://github.com/GIT121995/dsh-memory-gate
- dsh-memento：https://github.com/PerryLink/dsh-memento
- dsh-memory（Jesse-njx）：https://github.com/Jesse-njx/dsh-memory
- distill：https://github.com/LoserFox/distill
- dsh-hermes-memory：https://github.com/isheng-eqi/dsh-hermes-memory
- dsh-mnemon：https://github.com/omdsh-dev/dsh-mnemon
- dsh-mneme：https://www.npmjs.com/package/@modusensus/dsh-mneme
- dsh-memory-palace：https://github.com/lovezi0/dsh-memory-palace
- dsh-global-rules：https://www.npmjs.com/package/dsh-global-rules
- dsh-rule-engine：https://github.com/jilian-dsh/dsh-rule-engine
- Hindsight DSH 集成：https://hindsight.vectorize.io/blog/2026/08/14/deepseek-harness-persistent-memory
- findharness 记忆插件横评：https://findharness.com/blog/best-deepseek-harness-memory-plugins
- 官方 Discussion #2783（极简模式无记忆）：https://github.com/deepseek-ai/deepseek-harness/discussions/2783
