---
name: whale-notebook
description: >-
  鲸鱼闪闪发光的小本本（DeepSeek Harness 自我进化机制）：自动/半自动挖掘本机
  DSH 全部工作区会话日志中遇到的问题，提炼为经验候选（待审核箱 inbox.md），
  经用户逐条勾选确认后写入全局经验库（entries/）并同步到 ~/.dsh/AGENTS.md
  自动段（每会话注入的全局记忆）。当用户说「鲸鱼小本本 / 小本本 / 复盘 / 经验入库 /
  避坑总结 / 待审核箱 / 审核候选 / 小本本讨论<主题> / 小本本忘掉<编号> / 记住这条经验 /
  避免再踩坑」或要求把运行教训沉淀为全局规则时使用。所有提炼内容先展示、经用户
  确认才落盘；禁止把原始会话内容、项目业务细节、个人路径、密钥写入经验库。
whenToUse: 用户要求把本机 DSH 运行中遇到的问题沉淀为经验/规则、查看待审核候选、
  讨论某类坑（可按工作区）、停用或导出经验时。
metadata:
  version: 1
---

# whale-notebook — 鲸鱼闪闪发光的小本本

把「本机反复出现的坑」变成「每个会话自动注入的规则」，并保持全程由用户掌控。

## 架构速览

| 层 | 位置 | 作用 |
|---|---|---|
| L1 全局记忆 | `~/.dsh/AGENTS.md`（自动段，勿手改） | 每会话自动注入 ≤12 条高频**全局规则**（scope=global）+ 提醒句；项目级规则（B1 语义）**不进全局注入** |
| L2 技能 | 本文件 | 采集/审核/入库/讨论/忘掉/统计 的操作手册 |
| 数据 | `~/.dsh/whale-notebook/`（inbox/entries/INDEX=已解决墙/archive/scripts） | 待审箱、经验库、墙与证据 |
| 采集 | `node "$env:DSH_HOME\whale-notebook\scripts\mine.cjs" --check` | 增量扫描 sessions（水位线：未更新的日志只 stat 跳过）；`--add` 把暂存冲入待审箱；`--stats`（只读）/`--full`（全量）/`--dry`（只看不写） |
| 模块源码 | `~/.dsh/whale-notebook/plugin/`（core/store/collector/inject/review/ui 分层） | 模板/生成器以代码为准，见 plugin/README.md |
| 维护 | `node "$env:DSH_HOME\whale-notebook\plugin\scripts\links-doctor.cjs"` | 工具主目录**悬空链接（死链）**体检：默认只读；`--apply` 才删（只摘链接本身）；退出码 0=干净 / 3=发现悬空 / 1=错误 |

## 隐私铁律（每次执行前默念）

1. 只写通用对策与统计；**禁止**粘贴会话原文、项目业务内容、个人路径、密钥。
2. 所有对外文本过一遍打码：脚本输出已打码；你自己书写候选/条目时同样自查
   （token/PAT/密钥→`[REDACTED]`；`C:\Users\gengj\...`→`~`）。
3. 任何写入 entries/、INDEX.md、AGENTS.md 前，先向用户**展示将要新增/修改的完整内容**，获得明确确认。
4. 采集只读 `~/.dsh/sessions`；绝不修改原始会话日志。
5. 导出/发布仅限通用经验与机制模板；本机经验数据默认不随技能发布离开。

## 工作流

### 1. 复盘 / 采集（用户说「小本本复盘/采集」，或 AGENTS.md 提醒有待审时）

1. 运行 `node "$env:DSH_HOME\whale-notebook\scripts\mine.cjs" --check` 与 `--stats`（后台/前台均可）。
   - **入箱模式以命令输出为准**（`settings.autoAdd`；v0.7.8 起面板页脚「自动收集」开关可一键切换，切换立即生效、无需重启）：
     - 输出含「**新发现暂存 N 组**」＝**仅暂存**（拉取式）：只把新发现写进 `state.json` 的 `deferred`，**不写待审箱**。接着运行 `--add` 把它们冲入待审箱（输出会报「入箱 N 条 / 剩余暂存 M 组」），再往下走；若 `--add` 报「入箱 0 条」则本轮没有新坑，直接告知用户。
     - 输出含「**新发现 N 条**」＝**自动入箱**：`--check` 已直接入箱，跳过 `--add`。
   - **面板 ⛏「历史深掘」= 全量重扫全部历史的等价链路**（用户点按钮时宿主已自动完成，不必重跑）：阶段① `--add`（把已有暂存先入箱，防重建清空丢件）→ 阶段② `--rebuild --add`（清空水位线/指纹/聚簇后从头梳理全部历史、直接入箱；已处置的不复活、在箱候选只累加不重复开行）。**不要重复跑 `--rebuild`**；深掘后若需补扫只跑 `--check`。
2. 阅读 `inbox.md` 全文与现有 `entries/`、`INDEX.md`（先去重：同类别已有条目则不再重复建候选，而提示「已有 E00x 覆盖，本次仅追加次数/证据」）。
3. 输出**概览**（类别|出现次数|受影响工作区|首次~最近时间），再**编号列出候选**，每条两行：
   - `C0xx｜现象：<一行>`
   - `拟对策：<一行祈使句，将进入 AGENTS.md 的形态>`
4. 等待用户选择；未确认前**不写任何文件**。

### 2. 查看待审核箱（「小本本待审 / 审核箱」）

- 直接渲染 `inbox.md` 表格（编号|类别|次数|工作区|现象|时间），并问用户是否入库。
- 面板入口对应关系（v0.7.8）：`⟳` = 增量扫描后刷新（零 token）｜`⛏` = 历史深掘（全量重扫全部历史直接入箱 + 自动开总结会话，等价 `--add` + `--rebuild --add`）｜页脚`自动收集 [自动入箱｜仅暂存]` = 切换 `settings.autoAdd`（只写 settings.json，立即生效）。
- 若用户说「先不管」：本轮不再提示，不写任何状态。

### 3. 入库（用户确认编号后执行）

1. **先给每条候选拟「适用范围」（scope）建议**，随拟规则一起列给用户确认，不要自行假设：
   - `scope: global`：所有工作区普遍适用（例：命令链路中文编码转义、沙箱纪律）——这类规则进全局自动段；
   - `scope: project` + `projects: [项目名…]`：只对列出的项目适用（例：某 Python 工作区的环境配置坑；可多项目共用一条，如两个 Python 项目）。依据 = 候选行工作区列 + 详情源引用；**项目是否只有一个也未必是项目级**（语义判断，非统计判断）；入库后项目级规则**不进全局自动段**（B1），见 INDEX.md 已解决墙「项目区」。
   - **v0.7 同族合并**：候选行若带「族×N」小标（或 sidecar 里有「## 同族并入」段），说明它由 N 个变体合并而成——**一条候选 = 一条经验**，`occurrences` 取族内总和（如行内次数），对策需覆盖全部变体（在「## 现象」里列出变体要点，不要只为代表变体写对策）。若讨论结论是「变体其实不同根因」，明确告知用户并只取其中适用的那部分入条目。
2. 对每个被选中的候选行 C0xx，写 `~/.dsh/whale-notebook/entries/E0NN-slug.md`：
   - 文件名：`E0NN` 取 entries 目录现有最大号 +1；slug 用 ASCII 短词（如 `E001-encoding-utf8.md`）。
   - frontmatter：
     ```yaml
     ---
     id: E001
     title: <中文标题>
     category: <encoding|stale-fs|sandbox-file|sandbox-ep|approval|tool-mode|git-net|secret|session-state|data-access|long-session|other>
     status: active
     scope: global|project
     projects: [<项目名...>]   # scope=project 时必填（适用项目白名单，可多项目）；global 留空 []
     occurrences: <出现次数>
     firstSeen: <YYYY-MM-DD>
     lastSeen: <YYYY-MM-DD>
     workspaces: [<工作区名...>]  # 出现证据（统计用），与 scope 无关
     rule: "<一行祈使句对策——将来进入 AGENTS.md 自动段的形态（scope=project 时仅展示在墙，不注入）>"
     created: <YYYY-MM-DD>
     updated: <YYYY-MM-DD>
     sources: [<会话id前缀，仅作溯源>]
     ---
     ```
   - 正文章节：`## 现象`（一行概括）／`## 根因`（要点）／`## 对策`（≥2 条可执行步骤）／`## 验证`（如何确认不再犯，可选）。
3. 更新 `INDEX.md`（=「已解决墙」，格式以 `plugin/src/store/repo.cjs → buildIndexMd` 为准）：全局区（按类别分组列出全部 active 且 scope=global 条目）+ 项目区（scope=project 条目按适用项目列出）+ 停用收尾；行含编号/标题/对策/次数/最近。批量刷新时可 `node "$env:DSH_HOME\whale-notebook\scripts\mine.cjs" --wall` 预览全文后落盘。
4. **重写 AGENTS.md 自动段**：
   - 正文由 `plugin/src/inject/agents.cjs → buildSectionBody` 规范生成；落盘前先运行 `node "$env:DSH_HOME\whale-notebook\scripts\mine.cjs" --render-rules` 预览（输出即标准正文，可整段作为替换内容）。
   - 保留 `<AGENTS.md>` 中 `<!-- whale-notebook:rules -->` 与 `<!-- /whale-notebook:rules -->` 之外的全部内容；
   - 自动段 = 规则行 + 固定尾注。规则行取**全部 active 且 scope=global 的条目**按 occurrences 降序前 ≤12 条，每条一行 `- 【category】rule内容`（项目级条目永不写入自动段，其去向已在状态行注明）；
   - 固定尾注三行：自动采集提醒句、触发词句、隐私句（样式参考现网 AGENTS.md 自动段，保持行文一致）；
   - 用 edit 工具替换整个自动段后，**把改动内容展示给用户**。
5. 把已入库的候选行从 `inbox.md` 移除，追加到 `archive/archive-<YYYYMMDD>.md`（注明入库条目 E0NN）。
6. 汇报：入库 N 条（标注各自 scope）+ AGENTS.md 新增全局规则行一览。

### 4. 讨论（「小本本讨论 <主题/工作区>」，或面板某行点 💬 转新会话）

0. **v0.7 固定第一步：同族/相似候选必须由程序给出，不靠模型回忆。**
   - 面板 💬 转新会话时，消息里已自动附带三块（程序算的）：**同族证据**（该候选由哪几个变体合并而成，含相似度）、**其它相似候选**（相似度 ≥0.35 的在箱行）、**可能已被现有条目覆盖**（相似度 ≥0.25 或同类别）。
   - 在会话内手工讨论某条候选时，等价调用：
     `curl "http://127.0.0.1:3080/whale/related?id=C0xx"`（host 端点，返回 `family/related/entries` 三块）；
     面板/端点不可用时退回命令行：读 `inbox.md` 全文 + `state.json` 的 `clusters`（**cid 相同的聚簇即同族**）+ `entries/` 逐个比对，并把所用判据（相似度/同类别）写在回答里。
   - **判断口径**：同族 ≠ 一定同根因。程序只保证「该看哪些」确定、可复现、可解释；是否同一根因由你给出结论并说明依据（引用变体现象与相似度）。
1. 按主题词/工作区/项目名检索 `entries/`（frontmatter 的 category/title/scope/projects/workspaces）与 `INDEX.md`（已解决墙：全局区/项目区）。
2. 需要时运行 `--stats` 看分布；如用户想深挖某工作区原始证据，得到用户同意后在**会话内**临时解码该工作区会话日志（只读、输出打码、不落盘经验库）。
3. 就地回答/分析；若讨论形成新经验 → 先以候选形式列给用户（含拟 scope 建议）→ 按第 3 步入库。

### 4.1 已解决墙（「小本本墙 / 已解决 / 我们解决过什么」）

- 文档墙 = `~/.dsh/whale-notebook/INDEX.md`（生成器 buildIndexMd）：全局区（scope=global，按类别分组，对策注入每个会话）+ 项目区（scope=project 按适用项目）+ 停用收尾。直接 read 该文件即可向用户/会话作答。
- 运行 `node "$env:DSH_HOME\whale-notebook\scripts\mine.cjs" --wall` 可预览/刷新墙全文（dry，落盘前展示确认）。
- GUI 侧：决策箱面板「已解决」tab 与文档墙同源（host GET /whale/solved + /whale/entry）。

### 5. 忘掉 / 停用（「小本本忘掉 E00x」）

1. 展示将停用条目摘要；确认后把该条目 frontmatter 的 `status` 改为 `disabled`（或删除文件，若用户要求彻底删除）。
2. 重新生成 INDEX.md 与 AGENTS.md 自动段（规则行将不再含它）。
3. 汇报自动段减少的行。

### 6. 统计 / 导出

- 统计：`--stats` + INDEX 汇总（条目数/类别分布/各工作区命中）。
- 导出：把 entries/、INDEX.md、README.md 打包到用户指定路径（zip 或目录复制均可）；内容仅通用经验，不含 inbox 原始候选与 evidence。

### 7. 体检 / 维护（「小本本体检 / 死链检查」，或检索报 `exit 2` 且 stderr 全是树内子项 `os error 2`）

1. 运行 `node "$env:DSH_HOME\whale-notebook\plugin\scripts\links-doctor.cjs"`（默认根 = DSH home，跳过 `sessions`/`.git`，**只读**）。
   - `exit 0` = 无悬空；**`exit 3` = 发现悬空**（逐条列出；stdout 的清单即可展示给用户）；`exit 1` = 用法/IO 错误。
   - 只想看机器可读结果：加 `--json`；想换扫描根：`--root <dir>`（`--apply` 只删该根之内的条目）。
2. 展示清单并取得用户同意后，加 `--apply` 清理：工具会在删除前**逐条复验**（仍是链接 + 仍悬空 + 仍在根内），
   只摘链接本身（`rmdir` → `unlink` → `cmd /c rmdir` 兜底），**实体目录、有效链接、根外路径一律不碰**；跑完自动复查并报剩余数。
3. 判据（E005 的坑）：悬空链接只能用**跟随式**判定——`lstatSync` 看它是不是链接、`statSync` 看目标在不在（抛 `ENOENT` 即悬空）。
   反向陷阱：`Test-Path`/`Directory.Exists` 对悬空 junction 会说「存在」，而 `existsSync`/`Get-ChildItem` 会说「不存在」——**单独用哪个都会错**。
4. 体检只处理链接、不动包与数据，也不需要重启 dsh web；若用户要求重装 profile 或改部署，那属于写环境操作，先展示计划再动手（`deploy-web.cjs` 是 R 段唯一写入者）。
5. **清单对账（v0.7.7 起）**：`node "$env:DSH_HOME\whale-notebook\plugin\lifecycle\cli.cjs" check` —— `exit 0` = 一致（或仅有「待登记」：AGENTS 自动段 / skill 被你或我合法改过、结构完好，属正常演进）；`exit 1` = 真问题（文件缺失、标记区缺失、**结构损坏**如截断/乱码/frontmatter 丢失、有孤儿、清单待迁移）。
   - 每次**入库改写了 AGENTS 自动段**或**更新了技能文件**之后，跑一次 `check --adopt` 把现场重新登记为基线（只更新 `.lifecycle/manifest.json` 里的 hash，**不改任何文件内容**）—— 否则下一次 `check` 会显示「待登记」，虽然不拦人但会让信号变钝。
   - `uninstall remove` 遇到"内容与登记不一致"仍会要求 `--yes`（删除前确认），`check --adopt` 不影响这条保护。
   - **面板「自动收集」开关不写 AGENTS.md**（v0.7.8）：提醒句已改成"以 `--check` 输出为准"的双模式自述，所以切开关**不会**产生「待登记」，也不需要 `--adopt`。只有"改了提醒句口径本身"或"入库改写了规则行"才需要。

## 记录格式与口径

- 候选行/条目/规则行只写「现象+对策」，**不写** 具体文件名、影视名、业务词、路径、密钥。
- 次数与来源：次数取挖掘统计（含叙述回声时注明「约」）；来源仅存会话 id 前缀。
- 规则行语言风格：祈使句、无主语、可直接执行（例：`- 【encoding】命令与脚本一律不内联中文：中文内容写入 UTF-8 文件后按路径引用`）。
