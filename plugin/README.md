# dsh-whale-notebook 插件包（v0.2.1：双半插件 · 决策箱面板已就绪）

鲸鱼小本本从「skill + 脚本」升级为**模块化插件包**：分模块对应未来功能（核心/记录/生效/审核/展示），任何一块都可独立演进。v2.0 只做结构与契约（零挂载风险，现有 skill+AGENTS+脚本继续可用）；v2.1 起做真实 cordis 挂载（决策箱面板 = host half API + browser half 悬浮 UI，`scripts/deploy-web.cjs` 一键部署）。

## 模块地图

```
plugin/
├─ package.json            # @deepseek-ai/dsh-whale-notebook (type: module; dsh.client 声明)
├─ cordis.patch.yml        # 主机平面挂载模板(参考；现场行由 deploy-web.cjs 管理)
├─ lib/index.js            # 插件入口(host half: /whale/* API 注册, v2.1)
├─ lib/client.js           # 浏览器半边(决策箱悬浮面板 bundle, __ModuleLoader__ 零依赖)
├─ manifest.json           # ★包内默认清单(生命周期: 足迹=卸载白名单, schema v1)
├─ lifecycle/              # ★自举生命周期模块(第 0 功能: 安装/卸载/清单, 仅 node 内建)
│  ├─ cli.cjs              # status/check/install/uninstall detach|remove|purge
│  ├─ consts.cjs           # 版本/路径解析/AGENTS 模板/帮助
│  ├─ zones.cjs            # AGENTS 标记区几何操作(纯文本)
│  ├─ manifest.cjs         # 站点清单 .lifecycle/manifest.json 存取/合并/快照
│  ├─ fsx.cjs              # 原子写/哈希/树复制删除(字节安全)
│  └─ selftest.cjs         # 沙盒端到端自测(临时 home, 验收 §13)
├─ scripts/
│  ├─ deploy-web.cjs       # ★部署工具: 复制包 + patch web profile(幂等; dry/apply/undo/check)
│  └─ bundle-smoke.cjs     # client bundle 桩执行检查(vm + __ModuleLoader__ 桩)
└─ src/
```
   ├─ core/                # ★领域层(零依赖, 全模块共用契约)
   │  ├─ util.cjs          # fmtTime
   │  ├─ privacy.cjs       # 打码 redact / 指纹 hash36 / 规范 canonText（隐私唯一出口）
   │  └─ schema.cjs        # 类别表/设置默认/AGENTS 标记/inbox 行与条目模板/规则行
   ├─ store/               # ★数据层(单一事实源; 未来可换 sqlite/远程)
   │  └─ repo.cjs          # 路径常量 + settings/state/inbox/entries/INDEX 读写
   ├─ collector/           # ★记录层(采集)
   │  ├─ decoder.cjs       # zstd 多帧 JSONL 解码
   │  ├─ patterns.cjs      # 坑特征词典(展示/硬拦共用)
   │  ├─ scanner.cjs       # 单会话事件抽取(失败/特征, 自引用与框架排除)
   │  ├─ engine.cjs        # 扫描→指纹→聚簇→(check)追加待审行; --stats/--prewarm
   │  └─ cli.cjs           # CLI 分发(含 --render-rules)
   ├─ inject/              # ★生效层(L1 AGENTS 自动段; 未来: system-prompt 段/硬拦守卫)
   │  └─ agents.cjs        # 自动段正文生成器(规则行排序/上限/尾注/标记内替换)
   ├─ review/              # ★审核层(人工确认闭环)
   │  └─ commit.cjs        # 计划式入库 planCommit(纯函数) + 候选行选取
   └─ ui/                  # ★展示/外观层(已落地: 决策箱面板)
      ├─ contracts.md      # 接入契约(视图模型/事件/推荐平面)
      ├─ viewmodel.cjs     # inboxViewModel/statsViewModel(UI 唯一数据入口)
      ├─ server.cjs        # host API 纯逻辑(list/delete→归档; 幂等; http 适配在 lib/index.js)
      └─ server.selftest.cjs # server.cjs 沙盒单测(临时 DSH_HOME)
```

旧文件 → 新归属：`scripts/mine.cjs`=兼容薄壳（转发 cli.cjs）；`scripts/redact.test.cjs`=core/privacy 测试；数据文件(inbox/entries/state/settings/INDEX/archive)不动。

## 部署：决策箱面板（v2.1 已实现）

设计文档：项目 `docs/2026_09_09_18_whale-notebook决策箱面板设计.md`。浏览器半边=悬浮侧边面板（待审核候选列表 + 自动处理/详细讨论/删除）；host 半边注册 `GET /whale/inbox` 与 `POST /whale/inbox/delete`。

```powershell
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs"            # dry-run
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --apply    # 复制包 + patch ~/.dsh/profiles/web/cordis.patch.yml
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --check    # 自检
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --undo --apply [--yes]  # 回退
```

- **生效需重启 dsh web**（loader 行集启动时固定；重启会中断在线会话，历史已持久化可恢复）→ 重启后刷新页面即出现面板。
- dsh 升级/pnpm 重装清掉 `profiles/node_modules` 后重跑 `--apply` 即可。
- 改动 bundle/代码后：deploy `--apply` → 重启。
- 验证：`node src/ui/server.selftest.cjs`（host 逻辑 17 断言）、`node scripts/bundle-smoke.cjs`（bundle 桩）。

### 风险与前提（务必先读）

- 本机安装版契约以实际 `dump-config`/包 README 为准；研究文档基于主分支，存在版本漂移。
- 依赖解析依赖 hoisted 布局；物理复制而非符号链接（symlink realpath 会脱离 node_modules）。
- 改 profile = 影响正在运行的 GUI：**必须由你选择时机并亲自重启**。

## 生命周期工具（安装/卸载/清单, v0.1: I+D 段）

设计文档: 项目 `docs/2026_09_09_16_whale-notebook生命周期设计.md`。三段足迹 = R 运行时(v2.1) / I 集成(AGENTS+skill) / D 数据(用户记忆)。

```text
node lifecycle/cli.cjs status                 # 阶段/足迹/上次操作
node lifecycle/cli.cjs check                  # 清单 vs 现场对账 + 孤儿扫描(退出码 1 = 有问题)
node lifecycle/cli.cjs install                # 干跑出计划 → 确认后加 --apply
node lifecycle/cli.cjs uninstall remove       # 清 R+I, D 原样保留(记忆永不清)
node lifecycle/cli.cjs uninstall purge        # 全清: 必须 --export-dir <目录> --yes(先导出后删除)
node lifecycle/cli.cjs uninstall detach       # 仅 R 段(v2.1 挂载后启用)
```

要点（与设计文档的偏差/裁定记录）:

1. **只依赖 node 内建**：插件未挂载、甚至数据目录被移动时, 从任意位置 `node <pkg>/lifecycle/cli.cjs` 均可用（自举）。
2. **两段式写操作**：默认 dry-run 出计划 → 展示 → 确认后 `--apply`；apply 全程幂等、失败重跑可续。
3. **前像快照**：凡改写/删除外部目标先字节级快照至 `.lifecycle/backups/<时间戳>/<id>.bak`；remove 后重装自动从备份还原字节（round-trip 等价）。
4. **AGENTS 两种归属模式**：`whole`(默认, 整文件归插件, remove 整文件删) / `zones`(install --agents-mode zones: 只管理两个标记区: rules+privacy, 区外用户内容永不动)。隐私尾注(原无标记)在 whole/zones 安装时都会纳入 `<!-- whale-notebook:privacy -->` 标记区——设计文档 §5.4「痕迹必须可指认」的落地。
5. **漂移守卫**：登记后文件被外部改动, remove 会中止并提示加 `--yes`（仍先快照留档）。
6. **R 段(运行时)**: 清单已预登记(deferred), v2.1 挂载后实施; 当前 detach/remove 对 R 零动作。
7. **`remove` 后 `.lifecycle` 保留**（在 D 内）——与设计稿「清单随最后一级卸载删除」的裁定：remove 不清 D，.lifecycle 是重装/恢复依据；**purge 随 D 一起物理消失**, 无任何残留（含清单自身）。
8. **成果确认约定**：卸载计划先输出成果文件清单（待审候选/经验条目/归档计数 + 逐项去留），AI 删除前必须经用户确认；purge 前置导出（`--export-dir`）与二次确认（`--yes`）。
9. **已验证**（2026-09-09 本机真实演练 + 沙盒 66 PASS）：remove → 残留核对 → 重装字节等价还原（hash 一致）；中途 AGENTS 注入/skill 目录的移除与恢复均由 DSH 原生机制即时反映。
