# ui/contracts.md — 展示/外观层接入契约（未来功能的地基）

> 目标：让未来的「展示功能、独立小对话框、DSH 桌宠」在不改动 core/store/collector/inject/review 的前提下接入。
> 原则：所有 UI 只消费本目录定义的**视图模型与事件**，只通过 store/repo 读写数据；UI 侧写入一律回落到「先展示→用户确认→工具落盘」流程。

## 1. 数据访问边界（UI 唯一合法入口）

| 能力 | 入口 | 形状 |
|---|---|---|
| 待审小列表 | `ui/viewmodel.cjs → inboxViewModel()` | `{ rows:[{id,cat,n,ws,text,time}], pending, headline }`；`ui/server.cjs → listPayload()` 在其上增补**v0.6 `deferred`**（拉取式下已暂存未入箱的组数）与 **v0.7 每行 `variants`**（该候并由几个同族变体合并，面板显示「族×N」） |
| 同族/相似候选（v0.7） | `ui/server.cjs → relatedPayload(id)` | `{ family:{cid,size,members[],score}, related:[{id,cat,text,score}], entries:[{id,title,score,cat}] }` — 讨论会话的**确定性依据**（程序算，不靠模型归纳） |
| 统计 | `statsViewModel()` | `{ entries, active, byCategory, topRules }` |
| 已解决墙（v0.4） | `solvedViewModel()` | `{ stats:{active,global,project,disabled}, global:[{cat,title,entries[]}], projects:[{ws,entries[]}], disabled[] }`（行=entryLight：id/title/category/rule/occurrences/lastSeen/scope/projects/workspaces，无正文） |
| 条目全文（v0.4） | `store/repo.cjs → readEntryText(id)` | frontmatter+正文 md 文本 |
| 入库计划 | `review/commit.cjs → planCommit()` | `{ entryFiles[], indexMd, agentsBody, ruleLines[] }` |
| 生效预览 | `inject/agents.cjs → buildSectionBody()` | 纯文本（v0.4 B1：只收 scope=global） |
| 自动收集开关（v0.7.8） | `ui/server.cjs → settingsPayload()` / `updateAutoAdd({autoAdd})` | 读 `{ok, autoAdd, autoCollect, liveCapture, scanMode, writable:['autoAdd']}`；写返回 `{ok, changed, autoAdd, pending, deferred}`。**只动 `settings.json`**（`repo.readSettingsStrict` 严格读 + `repo.writeSettings` 原子写 + 键白名单）；**不碰 AGENTS.md**（提醒句口径见 `inject/agents.cjs`） |
| 历史深掘（v0.7.8） | `POST /whale/sweep` → `engine.runScanAsync('--add')` + `engine.runScanAsync('--rebuild', {add:true, maxNewRows:500})` | `{ok, dry, flush, added, bumped, suppressed, dropped, echo, pending, scan, text}`；两阶段语义与保护口径见 `docs/2026_09_12_*_whale-notebook待审箱两个新入口设计与实施.md` 与 CHANGELOG v0.7.8 |

禁止 UI 直接 `fs.readFileSync(inbox.md)` 后自行解析。

## 2. 未来的 UI 平面（按 DSH 扩展体系分层）

| 功能 | 推荐平面 | 说明 |
|---|---|---|
| ① 展示功能（侧栏/面板徽标、待审列表卡片） | **client-plugin**（dsh web 浏览器侧插件图，host 经 `window.__DSH_BOOT__` 引导） | **✅ 已实现（v0.4.0 双卡 → v0.7.0）**：browser half `lib/client.js` + host API `GET /whale/inbox`（v0.6 附 `deferred`）、`GET /whale/inbox/detail`、`GET /whale/solved`（v0.4 已解决墙聚合）、`GET /whale/entry?id=E###`（v0.4 条目全文）、`GET /whale/live`（v0.5 实时采集与水位线状态）、`GET /whale/related?id=C###`（**v0.7 同族/相似候选**：`family`+`related`+`entries` 三块，💬 讨论消息据此带确定依据）、`POST /whale/inbox/delete`、`POST /whale/scan`（v0.5 ⟳ = 先触发增量扫描再刷新；零 token）、**`GET /whale/settings` + `POST /whale/settings`（v0.7.8 面板「自动收集」开关 = `settings.autoAdd`，只写 `settings.json`）**、**`POST /whale/sweep`（v0.7.8 面板 ⛏「历史深掘」= `--add` 保底 + `--rebuild --add` 全量重扫历史直接入箱；`{dry:true}` 为只读预演）**（`server.cjs` 纯逻辑 + `lib/index.js` 注册）。部署/回退 `scripts/deploy-web.cjs`；生效需重启 dsh web（仅 `lib/client.js` 改动刷新页面即可）。卡一待审箱：现象行=规则精炼一句话；详情在 `details/C###.md` sidecar（源引用+打码摘录，删除→随行归档）；删除=红色 ✕（移入归档可恢复）；⚡ 自动处理=判定表硬规则（只读诊断+补全型小修可自动，禁区上报），重大隐患经 `[WHALE-RISK]` 固定行识别 → 红色警示条 + 一键转人工讨论；**v0.7.8 页脚「自动收集 [自动入箱｜仅暂存]」开关 + 页头 ⛏「历史深掘」（完成后自动开一个新会话做历史错误总结，落点＝鲸鱼全局）**；**面板可见性含「面板记忆」pin**（用户主动开过面板后待审为 0 也保留入口，否则开关够不着）。卡二已解决墙：轻口径（入库=已处理）；全局区（scope=global 按类别分组）/ 项目区（scope=project 按适用项目）/ 停用收尾；行点击展开条目全文（无待审且无条目且无暂存且未 pin 时整面板隐藏） |
| ② 独立小对话框（与会话并行的鲸鱼窗口） | client-plugin 的自有 surface + host API | 复用 ① 的桥；审核动作仍要求「带编号回写会话」由 agent 执行。**已部分落地**：💬 详细讨论 = 取 `relatedPayload` 后开新会话并带上三块证据（`relatedBlock`）+ 固定收尾动作 |
| ③ 桌宠（悬浮/托盘/气泡） | ①外部进程桥(ACP/sdk) 或 ②client overlay | 两种形态都只消费 inboxViewModel/事件流；本仓库只提供事件源与 JSON 契约，不绑定具体桌宠实现 |
| ④ 外观（皮肤/主题/动画） | client-plugin 层 | 与数据层零耦合 |

## 3. 事件契约（跨平面通知，未来实现）

建议事件名（host→UI 桥，v2.2 实现时落为类型化事件）：

- `whale/inbox-changed` `{ pending }` — 待审数变化（采集/入库/忘掉后触发）
- `whale/entry-committed` `{ entryId, ruleLine }` — 新经验生效
- `whale/reminder` `{ headline, rowsPreview }` — 会话开始时想提醒用户的摘要

## 4. 采集引擎的复用契约（记录功能扩展点）

- CLI：`scripts/mine.cjs --check | --stats | --prewarm | --render-rules | --wall | --add | --dry | --full | --rebuild | --forget-echo [--apply]`（v0.4 `--wall` = 已解决墙预览；v0.5 `--dry` 只看不写 / `--full` 全量校验 / `--stats` 纯只读；v0.6 `--add` 把暂存冲入待审箱；v0.6.1 `--rebuild` 清派生状态后从头梳理全部历史；v0.7.6 `--forget-echo` 清暂存回声）
- 库：`plugin/src/collector/engine.cjs → runScan(mode, opts)` 返回 `{ ok, text, data }`；宿主侧用 `runScanAsync(mode, {ctl, add, dry, maxNewRows})`（同形、让出事件循环、可取消、**`maxNewRows` 可放开单轮开行上限**，v0.7.7/0.7.8）
- **v0.7.8「历史深掘」的组合口径**：`--add`（保底，防重建清空丢件）→ `--rebuild --add`（全量重扫直接入箱、已处置不复活、在箱候选只累加）。**深掘不是新引擎**，只是这两个既有模式按顺序调一次 + 一个上限参数。
- 相似度（v0.7）：`plugin/src/core/similarity.cjs` 纯函数 `skeleton/similarity/bestFamily/thresholdFor` —— 族判定可复现、可解释、可调（`settings.familyThresholdSame/Cross`）
- 实时化：**✅ 已实现（v0.5）** —— 宿主半边订阅 `session/event` → `collector/live.cjs`（去抖 1.5s、串行写盘、异常全吞），与批扫共用同一判定层（`scanner.classifyRecord`）与入库路径（`engine.ingestFresh`）；零模型 token，`settings.liveCapture=false` 可关。事件去重复用 `core/privacy.hash36 + state.seenFingerprints`
