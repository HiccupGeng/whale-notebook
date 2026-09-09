# ui/contracts.md — 展示/外观层接入契约（未来功能的地基）

> 目标：让未来的「展示功能、独立小对话框、DSH 桌宠」在不改动 core/store/collector/inject/review 的前提下接入。
> 原则：所有 UI 只消费本目录定义的**视图模型与事件**，只通过 store/repo 读写数据；UI 侧写入一律回落到「先展示→用户确认→工具落盘」流程。

## 1. 数据访问边界（UI 唯一合法入口）

| 能力 | 入口 | 形状 |
|---|---|---|
| 待审小列表 | `ui/viewmodel.cjs → inboxViewModel()` | `{ rows:[{id,cat,n,ws,text,time}], pending, headline }` |
| 统计 | `statsViewModel()` | `{ entries, active, byCategory, topRules }` |
| 入库计划 | `review/commit.cjs → planCommit()` | `{ entryFiles[], indexMd, agentsBody, ruleLines[] }` |
| 生效预览 | `inject/agents.cjs → buildSectionBody()` | 纯文本 |

禁止 UI 直接 `fs.readFileSync(inbox.md)` 后自行解析。

## 2. 未来的 UI 平面（按 DSH 扩展体系分层）

| 功能 | 推荐平面 | 说明 |
|---|---|---|
| ① 展示功能（侧栏/面板徽标、待审列表卡片） | **client-plugin**（dsh web 浏览器侧插件图，host 经 `window.__DSH_BOOT__` 引导） | **✅ 已实现（v0.3.0 决策箱面板）**：browser half `lib/client.js` + host API `GET /whale/inbox`、`GET /whale/inbox/detail`、`POST /whale/inbox/delete`（`server.cjs` 纯逻辑 + `lib/index.js` 注册）。部署/回退 `scripts/deploy-web.cjs`；生效需重启 dsh web。现象行=规则精炼一句话；详情在 `details/C###.md` sidecar（源引用+打码摘录，删除→随行归档）；删除=红色 ✕（移入归档可恢复）；⚡ 自动处理=判定表硬规则（只读诊断+补全型小修可自动，禁区上报），重大隐患经 `[WHALE-RISK]` 固定行识别 → 红色警示条 + 一键转人工讨论 |
| ② 独立小对话框（与会话并行的鲸鱼窗口） | client-plugin 的自有 surface + host API | 复用 ① 的桥；审核动作仍要求「带编号回写会话」由 agent 执行 |
| ③ 桌宠（悬浮/托盘/气泡） | ①外部进程桥(ACP/sdk) 或 ②client overlay | 两种形态都只消费 inboxViewModel/事件流；本仓库只提供事件源与 JSON 契约，不绑定具体桌宠实现 |
| ④ 外观（皮肤/主题/动画） | client-plugin 层 | 与数据层零耦合 |

## 3. 事件契约（跨平面通知，未来实现）

建议事件名（host→UI 桥，v2.2 实现时落为类型化事件）：

- `whale/inbox-changed` `{ pending }` — 待审数变化（采集/入库/忘掉后触发）
- `whale/entry-committed` `{ entryId, ruleLine }` — 新经验生效
- `whale/reminder` `{ headline, rowsPreview }` — 会话开始时想提醒用户的摘要

## 4. 采集引擎的复用契约（记录功能扩展点）

- CLI：`scripts/mine.cjs --check | --stats | --prewarm | --render-rules`
- 库：`plugin/src/collector/engine.cjs → runScan(mode)` 返回 `{ ok, text, data }`
- 实时化（未来）：订阅 `tool/result` 失败 + `agent/request-error`，事件去重逻辑复用 `core/privacy.hash36 + state.seenFingerprints`
