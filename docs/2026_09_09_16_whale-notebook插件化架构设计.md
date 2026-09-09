# 鲸鱼小本本（whale-notebook）插件化架构设计

> 日期：2026-09-09 ｜ 版本：v2.0（模块化重构完成，挂载待 v2.1 pilot）｜ 目标：从「skill+脚本」演进为可生长插件，为 展示 / 独立小对话框 / 桌宠 / 外观 等未来功能预留干净扩展面。

---

## 1. 结论先行：是否做架构级整合？

**做。** 理由（对照两份架构调研 + 本机安装实测）：

1. 未来功能横跨 DSH 的多个扩展平面（会话工具/事件、宿主服务、浏览器 client、外部进程桥），不加整合的话，每加一个功能都会把逻辑塞进 skill 文本/单一脚本，互相缠绕。
2. DSH 是「一切皆插件」运行时（Cordis）：正确的长期形态是**一个插件包 + 分模块源码 + 分层挂载**，而不是让模型每次在会话里照 skill 文本“手写”各种文件格式——机器生成的规范（条目模板/INDEX/AGENTS 自动段）应沉淀为代码，供 skill、CLI、未来 UI 三面共用，消灭漂移。
3. 已按“三平面 + 模块地图”落地 v2.0（纯结构重构，零挂载风险），v1 行为与入口完全兼容（12 条候选原样在箱、测试全绿）。

## 2. 目标架构：三平面 + 六模块

### 2.1 平面（DSH 扩展体系，按功能性质归位）

| 平面 | 挂载方式 | 归位功能（现在/未来） |
|---|---|---|
| H 宿主平面（host） | profile `dsh.profile.bundles` 追加包名 + 包内 `cordis.patch.yml` | 数据/存储服务（store 层）；失败事件实时采集（订阅 tool/result、agent/request-error）；host API（给 UI 桥） |
| S 会话平面（agent preset） | 用户级 preset 行（`$DSH_HOME/.agent-presets/…/agent.cordis.yml`） | 采集 CLI 触发工具、注入事件（pre-step/system-prompt 段）、未来工具级硬拦（tools/pre-execute，需另行验证 seam） |
| U UI 平面（client-plugin / 外部桥） | 浏览器 client-plugin；或 ACP/sdk 外部进程桥（桌宠） | 展示（面板/徽标）、独立小对话框、桌宠气泡、外观主题——只消费 `src/ui` 契约 |

> v2.0 阶段 H/S/U 三平面均为“预留契约”，未做任何挂载；不影响现行 skill+AGENTS+scripts 的 v1 链路（走 DSH 官方 agent-instructions 注入，本身即是 S 平面注入机制的官方实现）。

### 2.2 模块地图（对应“核心/记录/生效/展示/外观”演进诉求）

```
plugin/  (@deepseek-ai/dsh-whale-notebook)
├─ core/      领域层    schema(类别/协议/模板) · privacy(打码/指纹) · util
├─ store/     数据层    repo.cjs = 唯一读写入口(sessions 只读; inbox/entries/state/settings/INDEX)
├─ collector/ 记录层    decoder(zstd) · patterns(特征词典) · scanner(事件抽取) · engine(扫描/聚簇) · cli
├─ inject/    生效层    agents.cjs = AGENTS 自动段生成器(规则行排序/上限/尾注/标记内替换)
├─ review/    审核层    commit.cjs = planCommit(计划式入库纯函数, 落盘仍由 agent 工具执行)
└─ ui/        展示层    viewmodel.cjs(待审/统计视图) · contracts.md(事件与接入契约, 桌宠/对话框地基)
```

映射到用户的演进词汇：
- 核心功能 → `core/` + `store/`（改 schema/存储不动其他层）
- 记录功能 → `collector/`（换信号源/词典/实时订阅只动这里）
- 生效功能 → `inject/`（加 system-prompt 段、硬拦守卫都在这层加适配器）
- 展示/外观 → `ui/` + U 平面（不碰数据层）
- 审核交互（新对话框）→ `review/` 复用 + U 平面壳

### 2.3 关键不变式（v1→v2 迁移后依然成立）

- 数据文件路径与行格式不变：`inbox.md`（`| C### | …` 行）、`entries/E###-*.md`（frontmatter）、`state.json`、`settings.json`、`INDEX.md`、AGENTS 自动段标记 `<!-- whale-notebook:rules -->`。
- CLI 兼容：`scripts/mine.cjs --check|--stats|--prewarm|--render-rules`（薄壳转发 plugin cli）。
- 隐私铁律代码化：唯一出口 `core/privacy.cjs`（redact/hash36/canonText）；指纹不存原文；叙述类只收**用户报障**（v2.0 起，助手叙述回声实测会自引用污染，已移除）。
- 生效链路不变：AGENTS.md 自动段由 agent 用 edit 工具落盘（agent-instructions 才能观测到并即时注入新会话/本会话）。

## 3. 模块间依赖（单向，禁止反向）

`ui → viewmodel → store/repo`；`review → (schema, inject/agents, store/repo)`；`inject → schema`；`collector → (core, store)`；`store → core`；`core` 零依赖。
插件入口 `lib/index.js` 只做装配（v2.1 起：注册服务/事件/工具，代码全部留在 src 各层）。

## 4. v2.1 真实挂载路线（下一步，需用户配合重启）

1. **pilot（先行，不碰 web）**：在 headless profile 复制本包、追加 bundles、跑一次性任务验证装载与 `--dump-config` 核对；通过后再动 web。
2. **web 挂载**：包复制到 `profiles/node_modules/@deepseek-ai/dsh-whale-notebook`（hoisted 布局，**物理复制而非符号链接**——symlink realpath 会脱离依赖解析）→ `profiles/web/package.json` 的 `dsh.profile.bundles` 追加 → **用户择时重启 dsh web**（会中断在线会话）。
3. **会话平面**：按 standard preset 行式语法在用户级 preset 挂工具/注入；先核对 isolate realm 约束与装载器契约（以本机 dump-config 为准，防版本漂移）。
4. **UI/桌宠**：client-plugin（浏览器侧）/ 外部桥，只实现 `src/ui/contracts.md` 的契约与事件。

风险清单：研究文档基于主分支、与安装版有差异（hooks/cordis_* 未随发行）；preset 隔离 realm 语义复杂；改 profile 影响运行中 GUI。

## 5. 验证记录（v2.0 重构后）

- `redact.test.cjs`：13/13 PASS（经兼容壳 require 老路径）。
- `mine.cjs --check`：0 新发现、待审 12 条（与重构前一致，种子无损）。
- `mine.cjs --stats`：正常输出；事件口径调整为「工具失败/特征 + 用户报障」（叙述回声清零：46 事件 vs 旧口径 78）。
- `mine.cjs --render-rules`：输出规范空态自动段正文（与 AGENTS.md 现有行文一致）。
- inbox 12 条种子候选原样保留（用户决定暂不入库）。

## 6. 遗留与后续

- [ ] v2.1 pilot（headless 装载验证）→ web 挂载（用户配合重启）
- [ ] 会话平面行 + 失败事件实时采集（订阅 tool/result、agent/request-error，去重复用 state 指纹）
- [ ] UI 平面第一个消费者（待审徽标/面板）——契约已备于 `ui/contracts.md`
- [ ] 桌宠/对话框形态调研（外部桥 or client overlay），事件契约已预留
