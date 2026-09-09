# 鲸鱼小本本 v0.4.0 实施计划：已解决墙（A1+A2）+ 全局/项目分类（B1）

> 日期：2026-09-09 ｜ 前置文档：`2026_09_09_23_whale-notebook已解决问题展示与分类需求梳理.md`
> 决策已拍板（用户 2026-09-09）：①「已解决」= 轻口径（入库即已处理）；② A1 文档墙 + A2 面板 tab **一期都做**；③ 先 B1 后 B2，**本次只做 B1**（project 规则不进全局注入，只进墙/检索）。

## 1. 目标

小本本具备一块「已解决墙」：人可读（INDEX.md 升级，任何会话 read 即可答「解决过哪些问题」）+ GUI 可看（决策箱面板新增「已解决」分区）；问题分**全局/项目**两级（entry 增加 scope/projects 维度）；项目级规则按 B1 语义**不进全局自动段**，避免跨项目噪音。

## 2. 总体设计

- 版本：plugin v0.4.0（package.json / lib index PACKAGE / 文档同步）。
- 数据模型零迁移：frontmatter 新字段 `scope: global|project`（缺省/旧条目 = global）、`projects: [项目…]`（scope=project 必填，白名单可多项目）。
- 墙数据源 = entries(active/disabled) + archive（处置史原地不动）；全部已打码，无新隐私面。
- 展示双载体同源：INDEX.md（A1 静态文档墙）+ 面板「已解决」卡（A2），都消费 `viewmodel.solvedViewModel()` → `server.solvedPayload()` 同一结构。
- B1：`inject/agents.cjs` 全局自动段**只收 scope=global** 条目；存在 project 级条目时状态行注明数量与去向（防止误以为丢失）。
- 面板 UX：待审卡与已解决卡并存。待审卡行为完全不变；已解决卡 = 统计头 + 全局区（按类别分组，行可展开详情）+ 项目区分组 + 停用收尾。**无待审且无已解决条目时面板仍整体隐藏**（不打扰原则不变）。
- 端点（全部只读）：`GET /whale/solved`（墙聚合 JSON）、`GET /whale/entry?id=E###`（条目全文，行展开详情用）。

## 3. 文件改动清单（权威位 `~/.dsh/whale-notebook/plugin/`）

| 文件 | 改动 |
|---|---|
| `src/core/schema.cjs` | renderEntryFile 模板加 scope/projects；`SCOPE_TITLES`（global→全局适用 / project→项目级）；缺省语义注释 |
| `src/store/repo.cjs` | listEntries frontmatter 解析加 scope/projects（缺省 global/[]）；新增 `readEntryText(id)`（读条目文件全文，E### 校验）；`buildIndexMd` 重写为「已解决墙」格式 |
| `src/inject/agents.cjs` | buildSectionBody 只取 scope=global 参与 top cap；状态行「另有 N 条项目级规则（不进全局自动段，见 INDEX 解决墙）」 |
| `src/ui/viewmodel.cjs` | 新增 `solvedViewModel()`：读 entries → stats{active,global,project,disabled} + globalByCat（按 lastSeen 排序）+ projectsByWs + disabled 列表（纯函数） |
| `src/ui/server.cjs` | 新增 `solvedPayload()` 与 `entryPayload(id)`（纯逻辑 + 非法/缺失兜底）；exports 扩充 |
| `lib/index.js` | 注册 `GET /whale/solved`、`GET /whale/entry`（只读）；PACKAGE 版本 '0.4.0' |
| `lib/client.js` | 双卡结构：待审卡（原逻辑改名迁移）+ 已解决卡（拉 /whale/solved → 统计/全局分组行/项目分组行/停用节；行点击拉 /whale/entry 展开详情）；CSS 增补；生命周期清理同步 |
| `src/ui/server.selftest.cjs` | 扩展：solved 分组/统计/缺省 scope 兼容/entry 全文/非法 id；INDEX 墙格式断言 |
| `src/collector/cli.cjs` | （可选）`--wall` 打印 buildIndexMd 生成的解决墙文本（dry，落盘走展示→确认） |
| `scripts/bundle-smoke.cjs` | 更新：检查新端点字符串/双卡 DOM 桩 |

## 4. B1 语义与红线

- 全局自动段（~/.dsh/AGENTS.md 标记区）只含 global 条目 → C# 会话不会收到 Python 项目规则。
- project 条目永远不写自动段；可见性 = INDEX 解决墙 / 面板已解决卡 / 「小本本 <项目> 的坑」检索。
- 入库仍两段式：AI 给「拟 scope 建议（附涉及工作区证据）」→ 用户确认 → 写字段。
- 不静默改记忆、不新增原文采集；本版**不触碰任何用户项目目录**（B2 留待三期，已在需求梳理文档登记）。

## 5. 测试与验收

- 测试（临时 DSH_HOME）：新增/扩展断言组 ——
  ① 条目 roundtrip：scope/projects 写入→解析一致，缺省 = global/[]；
  ② agents：project 条目被排除出 buildSectionBody 规则行、状态行计数正确；
  ③ solvedViewModel：global 按类别分组、project 归入多项目、统计数正确、disabled 单列；
  ④ entryPayload：命中返回全文、未知/非法 id 兜底、错误路径不写盘；
  ⑤ buildIndexMd 墙：分区标题/分组/统计行齐全，entries 空时兜底行。
- bundle-smoke：新 bundle 含 `/whale/solved`、`/whale/entry`、已解决卡 DOM 结构桩。
- 权威位全绿后 `deploy-web --apply`，部署副本复跑 selftest + bundle-smoke。
- 现场验收（重启 dsh web 后）：面板「待审｜已解决」双卡；INDEX.md 墙可读；无待审无条目时面板仍隐藏。

## 6. 文档同步

- plugin README、`~/.dsh/whale-notebook/README.md`、PROJECT-INTRO.md（§5 模块地图/§8 路线/§9 导航）、`src/ui/contracts.md`（§2 端点表加 solved/entry）。
- 需求梳理文档 §9/§10 决策状态更新（① ② 已拍板：② = A1+A2 一期都做；③ = 先 B1，本次范围）。
- 库镜像：README（快速验证清单）+ docs 两份新文档随 `tools/sync-release.cjs` 同步提交（push 网络失败则本地保留）。

## 7. 已知限制（如实）

- 墙的「处置时间线」不重做：archive/*.md 现状即处置史，会话按需查阅，本期不聚合展示（轻口径）。
- 面板可见性依赖 dsh web 重启（与 v0.3 功能同批生效）。
- entries 目前为空：墙的统计/分区在首次入库后才有内容（INDEX.md 首次入库时生成；`cli --wall` 供预览文本）。
