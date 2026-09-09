# whale-notebook 决策箱 v0.3.0 实施计划

> 日期：2026-09-09 ｜ 作者：DSH agent（鲸鱼小本本项目）｜ 版本：v0.3.0
> 前置：v0.2.1 决策箱面板（悬浮侧边，双半插件）已上线待重启生效；本文为其功能演进实施计划。
> 相关文档：`docs/2026_09_09_18_whale-notebook决策箱面板设计.md`（v2.1 面板基础设计，本版增量不改其机制结论）。

## 1. 背景与需求（用户决定点，已逐条确认）

围绕决策箱面板的四点功能决定：

1. **待审行要「一句话」清晰**：现「现象」列是工具报错原文头部 redact 后截 120 字（`collector/engine.cjs`），像报错开头而非问题概括。改为规则精炼的一句话。
2. **后台保留详情**：mine 扫描时明明掌握源会话（sid/at/原文）却未留存。新增 `details/C###.md` sidecar：一句话、类别/次数/工作区/首次时间、源会话引用（≤3：sid+时间戳+日志路径）、错误摘录（redact 后 ≤600 字，超长截断并注明完整见源日志路径）。错误太大时只存路径，不整段复制；上下文归纳不在采集层做（无模型），留给「详细讨论」新会话按需读取归纳。
3. **删除图标改红色 ✕**：纯 UI；语义仍为「移入归档、可恢复、无二次确认」。
4. **自动处理不得处理重大隐患**：涉及删除/覆盖已有内容、动 DSH 结构或 `~/.dsh` 运行面、影响用户产出，或方案多选/原因不明 → 禁止动手，按固定行上报 `[WHALE-RISK]`；面板检测到后弹红色警示条并提供「转人工讨论」一键入口（新会话带上下文与风险描述）。

用户示例语义（决定点 1）：多个 Session 执行 Python 脚本都因环境变量缺 Python 路径而失败——解决方案就是直接配好 Python 路径，属于「简单问题」，应自动处理（可执行修改，而非只读建议）。判定工作交由 agent 按 §2 判定表执行。

## 2. 自动处理边界（判定表，写入自动处理模板成为硬规则）

### 可自动执行（全部满足才动手）
1. 问题单一、方案标准无歧义（只有一种公认做法，不存在需用户权衡的路线选择）；
2. 修复动作属于「补全型小修」：新增/修正配置项、补环境变量或 PATH、安装缺失依赖——**不删除任何已有内容**；
3. 影响域封闭：只动本机应用环境或单一项目配置；**不碰** DSH 本体（cordis/插件/加载器/依赖树）、不碰 `~/.dsh` 运行结构、不碰用户产出物（文档/代码/数据/仓库文件）、不碰隐私敏感文件；
4. 可自验证：修完能重跑原失败操作确认成功。

判定通过后的执行纪律：先输出一行「自动修复：将执行 <具体动作>」预告 → 执行最小修改 → 重跑原失败操作自验证 → 报告改动与验证结果。执行中发现任何禁区情景立即停止。不触碰 inbox/entries/AGENTS（那走小本本既有确认流程）。

### 命中任一条即禁止动手（上报 `[WHALE-RISK] <一句话原因>`，可附建议计划）
- 需要删除/覆盖任何已有内容（文件/行/数据）；
- 修改 DSH 本体或 `~/.dsh` 运行结构（profiles/cordis*.yml、plugins、loader、依赖树等）；
- 改动用户产出文件/文档/代码/数据/仓库；
- 方案存在多种互斥选择、需要用户权衡；
- 原因不明 / 影响不明 / 有任何不确定性。

注：所有「写入类」动作在红线语境下（写入先展示、用户掌控）的完整语义 = 简单低危小修可自动 + 其余写入回到既有确认流程 + 禁区直接 RISK 上报，本判定表即此分层的执行化。

## 3. 总体设计

- **展示与详情分离**：inbox 行 = 一句话（≤~90 字，规则清洗）；`details/C###.md` = 详情（磁盘文件，不占模型记忆、不进 git/AGENTS/聊天默认展示；仅在用户主动开讨论/自动会话时按需注入新会话上下文，预算 ≤600 字摘录）。
- 生命周期同构：删除候选（面板 🗑 / 忘掉 / 入库后移行）→ detail 随行归档至 `archive/details/`，可恢复、不销毁。
- **联动范围（已核实的偏差）**：`removeInboxRows` 联动归档覆盖「面板删除」路径；「入库 / 忘掉」由技能流程中的 agent 按 commit.cjs 纯函数手工编辑 inbox 文本（不经 repo API），其候选 detail 会留在 `details/` 成为归档孤儿（KB 级、已打码、本地可查，无害；后续如需清理可加 cli 子命令，本期不做）。
- **隐私不变式**：detail 事件源是 `tool/result`（工具失败文本），天然不含 user 消息原文；入 detail 前仍过 redact（密钥等）；永不进入 AGENTS.md / entries / git。
- **重大隐患双闸**：① 指令闸——自动模板内嵌 §2 判定表 + 固定上报行 `[WHALE-RISK]`；② UI 闸——client.js 在投递自动处理后轮询目标会话最新 assistant 回复（client runtime `SessionFace` 提供消息快照 + `loadOlder`，纯 DOM 可订阅），发现上报行即显示红色警示条 + 「转人工讨论」按钮（复用 💬 新会话逻辑，附候选上下文与风险行），候选行打「需人工」标（内存态）。若读消息能力验证受阻：降级为 toast 提示 + 聊天内固定首行本身醒目（兜底）。
- **详细讨论/自动首条携带 detail**：client 先 `GET /whale/inbox/detail?id=C###`，有 detail 则拼入新会话/自动投递消息（含源路径，供按需精读）；旧候选（无 detail）回退现行为。

## 4. 文件改动清单

| 文件（plugin 权威位 `~/.dsh/whale-notebook/plugin/`） | 改动 | 层 |
|---|---|---|
| `src/core/summarize.cjs`（新增） | `oneLiner(raw, max=90)`：去堆栈行/`Error:` 前缀、空白压缩、句界截断 | 数据 |
| `src/core/summarize.selftest.cjs`（新增） | 纯函数单测 | 测试 |
| `src/collector/engine.cjs` | 事件补 file；聚簇保留源事件 evs；现象列走 oneLiner；同步写 detail | 数据 |
| `src/store/repo.cjs` | `P.details`；write/read/archiveDetail；`removeInboxRows` 联动归档 detail | 数据 |
| `src/ui/server.cjs` | `detailPayload(id)`（校验/读文件，不碰 req/res） | host |
| `src/ui/server.selftest.cjs` | detail 端点与联动断言 | 测试 |
| `lib/index.js` | 注册 `GET /whale/inbox/detail` | host |
| `lib/client.js` | 红 ✕ 按钮；doAuto 判定表模板 + RISK 行；detail 预取；RISK 观察器 + 警示条 + 转讨论 | browser |
| `package.json` / README / contracts.md / PROJECT-INTRO / NB README | v0.3.0 版本与说明 | 文档 |

版本号 0.3.0（不涉及 lifecycle 卸载重装；loader 行不变，仅文件内容更新 → 仍走 deploy-web + 重启生效路径）。

## 5. 分阶段任务

### P0 数据层
- `summarize.cjs`：纯规则精炼（见 §4），保持截断在句子边界、输出 ≤90 字符。
- `engine.cjs`：`collectEvents(file)` 结果补 `file` 字段；聚簇对象增 `evs`（源事件，含 sid/at/ws/file/text）；行文本改用 `oneLiner(redact(...))`；追加行时以同一 id 写 `details/C###.md`（摘录取簇内最长文本 redact 后 ≤600 字，超长截断注明完整见源；源引用取去重后最新 ≤3）。
- `repo.cjs`：details 目录常量与 ensure；`writeDetail/readDetail/archiveDetail`（原子写、递归建目录）；`removeInboxRows` 内对每个移除 id 联动 `archiveDetail`（无源即 no-op）——入库/忘掉/面板删除全部收敛到该入口。

### P1 host 端点
- `server.cjs` 增 `detailPayload(id)`：非法 id / 不存在 → `{ok:false,error}`；存在 → `{ok:true,text}`。
- `lib/index.js` 注册 `{kind:'exact', path:'/whale/inbox/detail'}`，query 解析 id。

### P2 面板 client.js
- 删除按钮：红色 ✕（SVG 内联或 ✕ 字符 + `color:#e5484d`、hover 加深背景），title「删除：移入归档（可恢复）」；行为不变。
- doAuto 消息 = 判定表硬规则（§2 全文）＋ `[WHALE-RISK] <一句话>` 固定上报行 ＋ 预告/自验证纪律；有 detail 时附摘录。
- doDiscuss 消息：有 detail 附摘录 + 源路径（只读讨论、禁止写、等用户指示模板保持）。
- RISK 观察器：先 spike 验证 `binding(id).session` 消息读取（getSnapshot/节点文本）；可行则投递后 ~4s 间隔轮询（上限 ~180s），检测到 `[WHALE-RISK]` 前缀 → 红色警示条（屏幕边缘小条，不遮挡聊天）＋「转人工讨论」（= doDiscuss 流程附风险行）＋ 行「需人工」标。
- 全部改动用现有 CSS 类体系；无新增依赖。

### P3 测试
- `summarize.selftest.cjs`：堆栈去除 / 前缀剥离 / 句界截断 / 短文本 / 空输入。
- `server.selftest.cjs` 扩展：detailPayload 命中/未知 id/非法 id；delete 联动后 `archive/details/C###.md` 存在。
- `bundle-smoke.cjs` 重跑（client.js 语法与外壳）。
- 沙盒演练（临时 DSH_HOME）：engine 全链需真实 zstd 会话 fixture——若 decoder 无配套编码能力则降级为 repo+server 层文本级联动演练 + engine detail 纯函数抽测，并在交付说明中注明边界。

### P4 部署
- `deploy-web.cjs --apply`（dry-run 先行）→ 现场自检 → 用户重启生效；`undo` 可整体回退。

### P5 文档与镜像
- contracts.md §2 标记 v0.3；plugin README / PROJECT-INTRO / NB README 同步；`tools/sync-release.cjs` 镜像提交（含本文档），网络可达时补推远程。

## 6. 验收清单（可判定）

1. 沙盒 mine 演练后：inbox 新行现象为单句且 ≤~90 字；同编号 `details/C###.md` 存在，含 源引用与 ≤600 字摘录，超长场景注明源路径。
2. `GET /whale/inbox/detail?id=C###`：命中返回 markdown；非法/未知 → `{ok:false}` 不写盘。
3. 面板 🗑 删除 → inbox 少行、当日 archive 增行、detail 移入 `archive/details/`。
4. 面板删除按钮显示为红色 ✕，提示文案含「可恢复」。
5. 自动处理模板含 §2 判定表与 `[WHALE-RISK]` 固定行；命中禁区时 agent 不执行修改。
6. RISK 观察器在候选投递后能识别 `[WHALE-RISK]` 回复 → 警示条出现 → 「转人工讨论」能打开带上下文的新会话（spike 受阻时按 §3 降级项验收 toast/首行醒目标记）。
7. summarize/server.selftest/bundle-smoke 全 PASS；deploy-web 现场自检通过；lifecycle 状态与清单一致。
8. 旧 12 条候选：行文本与状态原样保持（不回填 detail）。

## 7. 部署、回滚与已知限制

- 部署：`node scripts\deploy-web.cjs --dry-run` → `--apply` → 重启 dsh web（loader 内容更新需重启，页面刷新不生效）；`--undo` 恢复旧 patch。
- 回滚：deploy-web undo + 重启；数据文件（details/）无破坏性操作，删除仅移归档。
- 已知限制：旧 12 条无 detail 且不回填（v0.2.1 时期设计）；警示条依赖 client runtime 消息读取可行性（实现期 spike，失败按 §3 降级）；「需人工」标为内存态，刷新面板后消失。

## 8. 隐私与红线（不变式重申）

- detail 只留本机 `~/.dsh/whale-notebook/details/`，redact 后写入；永不进 git / entries / AGENTS.md / 默认 UI 展示。
- 讨论/自动会话携带 detail 摘录仅在用户主动触发时发生；模板保持只读约束与"等用户指示"语义。
- 用户记忆归用户掌控；所有写库路径（entries/AGENTS）仍走「先展示 → 用户确认 → 落盘」既有流程，本版不新增任何静默写入面。
