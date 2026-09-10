# lifecycle/ — 安装 / 卸载 / 清单（第 0 功能）

自举生命周期工具：**登记足迹 → 现场对账 → 分级卸载**。
本目录**只依赖 node 内建**（不 `require` 任何业务模块），所以插件未挂载、甚至 DSH 数据目录被移动时，从任意位置执行 `node <pkg>/lifecycle/cli.cjs …` 依然可用。

- 设计依据：项目 `docs/2026_09_09_16_whale-notebook生命周期设计.md`
- 开发者视角的模块地图 / 版本沿革：`../README.md`
- 项目全景（含 AI 会话快速指引）：`PROJECT-INTRO.md` §6

## 1. 三段足迹

| 段 | 内容 | 归属 | 谁执行写入/删除 |
|---|---|---|---|
| **I 集成** | `~/.dsh/AGENTS.md`（`whole` 整文件 / `zones` 只标记区）+ `~/.dsh/skills/whale-notebook.md` | plugin | lifecycle 本体（删前字节级快照，重装即还原） |
| **D 数据** | `~/.dsh/whale-notebook/`（用户记忆：inbox/entries/state/archive/INDEX/.lifecycle） | user-memory | **只有 `purge` 动**，且必须先 `--export-dir` 导出 + `--yes` 二次确认 |
| **R 运行时** | `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-whale-notebook`（部署副本）+ `~/.dsh/profiles/web/cordis.patch.yml`（加载器挂载行，标记区内） | plugin | **`../scripts/deploy-web.cjs`（唯一写入者）** |

**唯一写入者原则**：R 段的复制与删除由 `scripts/deploy-web.cjs` 执行（幂等，自带 `--check` / `--undo`）。
lifecycle 对 R 段只做四件事：**登记、对账、出计划、留快照，然后驱动那个工具**——避免"部署 web profile"出现两份实现各写一半。

## 2. 命令

```text
node lifecycle/cli.cjs status                              # 阶段 / 三段足迹 / 上次操作（含 R 段对账）
node lifecycle/cli.cjs check                               # 清单 vs 现场对账 + 孤儿扫描（有问题退出码 1）
node lifecycle/cli.cjs install                             # 干跑出计划 → 确认后 --apply
node lifecycle/cli.cjs uninstall detach                    # 仅 R 段（web 面板部署副本 + 挂载行）
node lifecycle/cli.cjs uninstall remove                    # R + I；D 段（用户记忆）原样保留
node lifecycle/cli.cjs uninstall purge                     # R + I + D；必须 --export-dir <目录> --yes
node lifecycle/cli.cjs help
```

常用标志：`--apply`（执行；默认干跑）、`--agents-mode whole|zones`、`--seed-dir <目录>`（迁移/新机素材）、
`--export-dir <目录>`（purge 必填）、`--yes`（二次确认 / 放行漂移 / 连副本目录一起删）、`--home <目录>`（覆盖 DSH_HOME，自测用）。

退出码：`0` 通过 · `1` 现场有问题 · `2` 被保护闸拒绝（缺导出目录 / 缺 `--yes` / 条件不满足）。

## 3. 约定（改动前务必遵守）

1. **两段式**：任何写操作默认只出计划，展示给用户确认后才 `--apply`；apply 全程幂等，中断后重跑可续。
2. **前像快照**：凡改写/删除外部目标，先字节级快照到 `.lifecycle/backups/<时间戳>/<id>.bak`（含 R 段的 patch 文件）。
3. **漂移守卫**：登记后文件被外部改动，`remove` 会中止并要求 `--yes`（仍先快照留档）。
4. **R 段对账是信息级**：`check` 会打印 R 段实际状态，但**不参与退出码判定**——因为 R 段的真相由 `deploy-web.cjs` 决定，
   生命周期不该因为"你还没部署"或"你手动撤了部署"而报装坏了；不一致时只提示 `install --apply` 重新登记或 `uninstall detach` 摘除。
5. **清单版本迁移**：站点清单（`.lifecycle/manifest.json`）里"包内默认清单已不存在"的条目会被丢弃，默认清单新增的条目会被补登记；
   缺条目时 `check` 会以 `待迁移` 报出（退出码 1），按提示重跑 `install --apply` 即可自愈。
6. **`remove` 后 `.lifecycle` 保留**（它在 D 内）：这是重装/恢复的依据；`purge` 才随 D 一起消失，无任何残留（含清单自身）。
7. **成果确认**：卸载计划先输出成果文件清单（待审候选 / 经验条目 / 归档计数 + 逐项去留），AI 删除前必须经用户确认。

## 4. 清单结构（`manifest.json` = 卸载白名单）

包内默认清单 `../manifest.json` 声明足迹结构，`install --apply` 按它 realize 出站点清单 `<nbDir>/.lifecycle/manifest.json`（含实际路径 / hash / 状态 / 时间戳）。
**卸载只允许删除或还原清单内的条目，清单外一律不碰。**

条目字段：`id / segment(I|D|R) / kind(file|dir|edit) / owner / path`（模板变量 `{dshHome}` `{nbDir}` `{pkgDir}`），另可带：

- `zones`：`edit` 类条目的标记区定义（AGENTS 的 rules/privacy 区）；
- `markers`：R 段 patch 文件的标记区（`begin`/`end`，与 `deploy-web.cjs` 的 `MARK_START`/`MARK_END` 逐字一致，自测会校验）；
- `managedBy`：该条目的**写入者**（R 段 = `scripts/deploy-web.cjs`；lifecycle 只登记与驱动）；
- `state`：`pending`（待安装）/ `installed` / `absent`（R 段现场探测结果）/ `removed` / `probe`（R 段默认：安装时现场探测）。

## 5. 自测

```text
node plugin/lifecycle/selftest.cjs
```

沙盒自测（临时 DSH home，**绝不触碰真实 `~/.dsh`**）覆盖：全新机安装与幂等、remove 后无残留且重装字节还原、purge 保护闸与导出、
zones 模式的区外保护、漂移守卫、以及 R 段的清单一致性 / 现场探测登记 / 摘除只经唯一写入者。
当前 **104 PASS / 0 FAIL**；其中包含反证：整个 R 段测试跑完后，真实 home 的 `cordis.patch.yml` 字节不变（`DSH_HOME` 覆盖生效）。
