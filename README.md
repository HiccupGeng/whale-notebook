# 鲸鱼闪闪发光的小本本（whale-notebook）

DeepSeek Harness（DSH）的自我进化机制插件：自动/半自动挖掘本机全部工作区会话日志中遇到的问题 → 提炼为候选经验（待审核箱）→ 经用户逐条确认后写入全局经验库 → 以规则行同步到 `~/.dsh/AGENTS.md` 自动段（每个新会话自动注入），让未来的会话不再踩同样的坑。

**本仓库 = 项目代码与设计文档库**（可发布视图）。运行实例与用户数据位于本机 `~/.dsh/whale-notebook/`，**永不入库**（见下方隐私边界）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `PROJECT-INTRO.md` | ★项目总览（与权威 `~/.dsh/whale-notebook/PROJECT-INTRO.md` 同步；全景/模块功能/命令/文档导航，新上手或 AI 会话先读） |
| `docs/` | 设计/实施/调研文档（九份）：实施记录 · 插件化架构(v2.0) · 生命周期设计 · 生态调研核实 · 决策箱面板设计(v2.1) · 决策箱 v0.3 实施计划 · 已解决展示与分类需求梳理 · v0.4 实施计划 · **增量采集与实时入库 v0.5（§4.7 = v0.6 拉取式、§4.8 = v0.7 同族确定化）** |
| `plugin/` | `@deepseek-ai/dsh-whale-notebook` 插件包源码：core/store/collector/inject/review/ui 六模块 + `lifecycle/`(自举安装卸载工具，速查见 `plugin/lifecycle/README.md`) + 决策箱面板双半(`lib/client.js` browser / `lib/index.js` host / `src/ui/server.cjs`) + `scripts/deploy-web.cjs`(部署与摘除 web 面板，**R 段唯一写入者**) + `manifest.json` + `cordis.patch.yml` |
| `scripts/` | v1 兼容薄壳与回归测试（引用 `../plugin/src`，需与 plugin 同层放置运行） |
| `tools/sync-release.cjs` | 一键发布：权威源 → 本仓库镜像 → commit → push（幂等；无变化则跳过） |
| `README.md` | 本文件（**手工维护，不参与镜像同步**） |

## 现状与路线

- **v2.0**：模块化重构完成（纯结构，零挂载风险）；v1 行为兼容（12 条种子候选原样、测试全绿）。
- **v2.0.x（当前）**：第 0 功能「生命周期」v0.1 已完成——`plugin/lifecycle/` 提供 `status / check / install / uninstall detach|remove|purge`（两段式：干跑计划 → 确认 → `--apply`），覆盖 I(AGENTS+skill)+D(数据) 段足迹登记、字节级快照备份、重装还原、purge 先导出后删除；沙盒自测 66 PASS。
- **v2.1 + v0.3.0（代码与部署已完成）**：决策箱面板 = 真实 cordis 双半挂载——host half 注册 `GET /whale/inbox` / `GET /whale/inbox/detail` / `POST /whale/inbox/delete`（复用 repo.cjs/viewmodel，删除=移入 archive 可恢复）；browser half 为 `__ModuleLoader__` 零依赖 bundle（GUI 右缘悬浮件：一句话现象列表 + ⚡自动处理/💬详细讨论/红色✕删除）。v0.3：候选详情 sidecar（`details/C###.md`，打码摘录 ≤600 字 + 源会话引用）、自动处理判定表硬规则、重大隐患 `[WHALE-RISK]` 上报 → 红色警示条 + 一键转人工讨论。部署：`node plugin/scripts/deploy-web.cjs --apply` → **重启 dsh web**。
- **v0.4.0（代码与部署已完成）**：已解决墙 + 全局/项目两级分类——条目 frontmatter 增 `scope: global|project` + `projects` 白名单（缺省 global 零迁移）；B1：AGENTS 自动段只收全局规则，项目级不进全局注入（状态行注明去向）；A1 文档墙 INDEX.md（全局区/项目区 × 类别 + 停用收尾，`scripts/mine.cjs --wall` 预览）+ A2 面板「已解决」卡（新端点 `GET /whale/solved`、`GET /whale/entry?id=E###`）。决策：轻口径（入库=已处理）；A1+A2 一期都做；先 B1 后 B2（B2 项目级自动注入留待三期逐项目试点）。
- **v0.5.0 / v0.5.1（代码与部署已完成）**：**增量采集**（每份会话日志记水位线：未更新只 stat 跳过 → 热启动 ~10ms / 读 0 字节；只读新增帧）+ **运行中实时入库**（宿主订阅 `session/event`，去抖 1.5s、串行写盘、**零模型 token**、异常不影响会话）+ **聚簇索引**（同坑累加次数；已处置后复发则重开并标「复发（原 C0xx）」，冷却期内静默）+ CLI `--dry`/`--full`/纯只读 `--stats`；v0.5.1 自引用/探针回声过滤（两级签名 + 落档 `archive/echo-*.md` 可审计，真实历史预演 26 → 2 条真坑）。面板 ⟳ = 先触发增量扫描再刷新。
- **v0.6.0 ~ v0.6.3（代码与部署已完成）**：**拉取式采集**（`settings.autoAdd=false`：扫描照常但新发现只暂存 `state.deferred`，用户说「小本本复盘」时 `mine.cjs --add` 才冲入待审箱）；`--rebuild` 从头梳理全部历史；回声签名扩充 + 类别正则收紧（真实重扫 36 → 26 且无误判）；**已处置签名去重**（把归档表当事实源，修掉 state 重置/重扫后同一个坑重复开行）。
- **v0.7.0（当前，代码与部署已完成）**：**同族（family）确定化**——`core/similarity.cjs`（骨架归一 + 3-gram 相似度，同类 0.6 / 跨类 0.8 可调）+ 族合并（同族变体并入既有候选行，sidecar 记「同族并入」，不新开行）+ 新端点 `GET /whale/related?id=C###`（族成员 / 相似候选 / 可能已被条目覆盖三块）+ 面板「族×N」小标 + 技能固定动作：**「还有类似的问题」由程序算出、可复现可解释，不再靠模型即兴归纳**；同族则合并为一条经验（`occurrences` 取总和）。
- **待生效提醒**：v0.5–v0.7 的**宿主半边**特性（实时采集、`POST /whale/scan`、`GET /whale/live`、`GET /whale/related`）需**重启 dsh web** 才生效（部署副本已是 0.7.0）；仅改 `lib/client.js` 则刷新页面即可。
- **未来**：会话平面挂载（工具/事件）、B2 项目级自动注入、复发检测深化（二期）、面板增强（桌宠形态/事件推送）——接入契约已备于 `plugin/src/ui/contracts.md`。

## 隐私边界（务必遵守）

1. **本仓库不含任何用户记忆数据**：inbox 候选行、entries 经验条目、state 指纹、settings 实值、AGENTS.md、`.lifecycle` 快照/备份均只在用户本机 `~/.dsh` 内。
2. 采集只读 `~/.dsh/sessions`，绝不修改原始会话日志；不复制会话原文，仅存打码摘要与指纹（`plugin/src/core/privacy.cjs` 为唯一出口）。
3. 所有提炼内容先展示、经用户确认后才落盘；denylist 可整工作区拉黑；用户数据可随时本地清除。
4. 若克隆到其他机器使用：先复制 `~/.dsh/whale-notebook` 数据目录结构（可用 `plugin/lifecycle` 的种子机制），再放置本仓库的 `plugin/`。

## 开发流

- **运行源码权威位置**：本机 `~/.dsh/whale-notebook/plugin/`（采集/skill/AGENTS 提醒直接引用它）。仓库 `plugin/` 与 `docs/` 是其**发布镜像**：改动先在权威位置完成并验证（`node plugin/lifecycle/selftest.cjs`、`scripts/redact.test.cjs`），再同步到本仓库提交。
- **一键同步提交**（含本工具自身的变更）：

  ```text
  node tools/sync-release.cjs            # 镜像同步(权威→库) → 有变更则 commit → push
  node tools/sync-release.cjs --no-push  # 只同步+提交, 不推送
  node tools/sync-release.cjs --msg "…"  # 自定义提交信息
  ```

  语义：`plugin/`（来自 `~/.dsh/whale-notebook/plugin`）、`docs/`（来自工作区 docs 中文件名含 whale-notebook 的 .md）、`scripts/`（mine.cjs/redact.test.cjs）——目标目录先清后拷，逐字节一致；无变化则跳过提交。数据文件永不触碰（`.gitignore` 兜底 + 脚本内隐私名拒绝）。
- 提交前自查：库内不得出现 `inbox.md / state.json / settings.json / entries/ / archive/ / .lifecycle/`；且镜像与权威源逐字节一致（`sync-release.cjs` 自身保证）。
- 卸载/移除本机安装：`node <pkg>/lifecycle/cli.cjs uninstall detach|remove|purge`（速查 `plugin/lifecycle/README.md`）。
  `detach` 只摘运行时（面板部署副本 + 挂载行，内部驱动 `deploy-web.cjs --undo`）；`remove` = 运行时 + AGENTS/skill（**用户记忆原样保留**）；
  `purge` 全清，需 `--export-dir` + `--yes`（先导出成果后删除）。

## 快速验证

```text
node plugin/lifecycle/selftest.cjs      # 生命周期沙盒自测(临时 home, 不碰真实环境) — 104 PASS, 含 R 段
node plugin/src/ui/server.selftest.cjs  # 决策箱面板 host 逻辑沙盒自测(45 PASS: 含 v0.4 墙/B1、v0.7 related)
node plugin/src/core/privacy.selftest.cjs # 打码出口回归(redact 不变式 + redactLines)
node plugin/src/core/summarize.selftest.cjs # 现象一句话单测
node plugin/src/core/similarity.selftest.cjs # v0.7 相似度/族判定(20 PASS, 含「不得误并」反证)
node plugin/src/collector/engine.selftest.cjs # detail sidecar 协议单测
node plugin/src/collector/engine.dedup.selftest.cjs # 已处置签名去重(19 PASS, 含「重置后重扫」复现)
node plugin/src/collector/e2e.selftest.cjs # mine 全链演练(zstd 假会话 → inbox+detail) — 60 PASS
node plugin/src/collector/live.selftest.cjs # 实时采集单测(28 PASS, 不依赖宿主)
node plugin/scripts/bundle-smoke.cjs    # client bundle 桩执行检查(含 v0.4–v0.7 结构断言)
node scripts/redact.test.cjs            # 打码回归测试(13 PASS)
```

合计 **9 套自检 306 断言** + bundle 桩 + 打码 13 断言（2026-09-10 实测全绿）。
