# 鲸鱼闪闪发光的小本本（whale-notebook）

DeepSeek Harness（DSH）的自我进化机制插件：自动/半自动挖掘本机全部工作区会话日志中遇到的问题 → 提炼为候选经验（待审核箱）→ 经用户逐条确认后写入全局经验库 → 以规则行同步到 `~/.dsh/AGENTS.md` 自动段（每个新会话自动注入），让未来的会话不再踩同样的坑。

**本仓库 = 项目代码与设计文档库**（可发布视图）。运行实例与用户数据位于本机 `~/.dsh/whale-notebook/`，**永不入库**（见下方隐私边界）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `docs/` | 设计/实施/调研文档：实施记录 · 插件化架构(v2.0) · 生命周期设计(安装/卸载/清单) · 生态调研核实与定位对比 |
| `plugin/` | `@deepseek-ai/dsh-whale-notebook` 插件包源码：core/store/collector/inject/review/ui 六模块 + `lifecycle/`(自举安装卸载工具) + `manifest.json`(足迹清单) + `cordis.patch.yml`(挂载模板) |
| `scripts/` | v1 兼容薄壳与回归测试（引用 `../plugin/src`，需与 plugin 同层放置运行） |
| `README.md` | 本文件 |

## 现状与路线

- **v2.0**：模块化重构完成（纯结构，零挂载风险）；v1 行为兼容（12 条种子候选原样、测试全绿）。
- **v2.0.x（当前）**：第 0 功能「生命周期」v0.1 已完成——`plugin/lifecycle/` 提供 `status / check / install / uninstall detach|remove|purge`（两段式：干跑计划 → 确认 → `--apply`），覆盖 I(AGENTS+skill)+D(数据) 段足迹登记、字节级快照备份、重装还原、purge 先导出后删除；沙盒自测 66 PASS。
- **v2.1（待做）**：真实 cordis 挂载（headless pilot → web profile bundles → 需用户择机重启 GUI）；R 段（运行时）条目已在清单预登记为 deferred，挂载后启用 detach 与两拍删除。
- **未来**：失败事件实时采集、UI 平面（待审徽标/面板/小对话框/桌宠）——接入契约已备于 `plugin/src/ui/contracts.md`。

## 隐私边界（务必遵守）

1. **本仓库不含任何用户记忆数据**：inbox 候选行、entries 经验条目、state 指纹、settings 实值、AGENTS.md、`.lifecycle` 快照/备份均只在用户本机 `~/.dsh` 内。
2. 采集只读 `~/.dsh/sessions`，绝不修改原始会话日志；不复制会话原文，仅存打码摘要与指纹（`plugin/src/core/privacy.cjs` 为唯一出口）。
3. 所有提炼内容先展示、经用户确认后才落盘；denylist 可整工作区拉黑；用户数据可随时本地清除。
4. 若克隆到其他机器使用：先复制 `~/.dsh/whale-notebook` 数据目录结构（可用 `plugin/lifecycle` 的种子机制），再放置本仓库的 `plugin/`。

## 开发流

- **运行源码权威位置**：本机 `~/.dsh/whale-notebook/plugin/`（采集/skill/AGENTS 提醒直接引用它）。仓库 `plugin/` 与 `docs/` 是其**发布镜像**：改动先在权威位置完成并验证（`node plugin/lifecycle/selftest.cjs`、`scripts/redact.test.cjs`），再同步到本仓库提交。
- 同步后提交前自查：库内不得出现 `inbox.md / state.json / settings.json / entries/ / archive/ / .lifecycle/`（.gitignore 已兜底）。
- 卸载/移除本机安装：`node <pkg>/lifecycle/cli.cjs uninstall remove|purge`（purge 需 `--export-dir` + `--yes`，先导出成果后删除）。

## 快速验证

```text
node plugin/lifecycle/selftest.cjs      # 生命周期沙盒自测(临时 home, 不碰真实环境)
node scripts/redact.test.cjs            # 打码回归测试
```
