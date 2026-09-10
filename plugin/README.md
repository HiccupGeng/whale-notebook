# dsh-whale-notebook 插件包（v0.6.0：拉取式采集 · 增量水位线 · 决策箱双卡 = 待审箱 + 已解决墙）

鲸鱼小本本从「skill + 脚本」升级为**模块化插件包**：分模块对应未来功能（核心/记录/生效/审核/展示），任何一块都可独立演进。v2.0 只做结构与契约（零挂载风险，现有 skill+AGENTS+脚本继续可用）；v2.1 起做真实 cordis 挂载（决策箱面板 = host half API + browser half 悬浮 UI，`scripts/deploy-web.cjs` 一键部署）。v0.3.0：现象一行一句话、候选详情 sidecar、删除改红色 ✕、自动处理判定表硬规则 + `[WHALE-RISK]` 重大隐患上报与红色警示条。v0.4.0：已解决墙（A1 文档墙 INDEX.md + A2 面板「已解决」卡）＋全局/项目两级分类（entry scope/projects）＋B1（项目级规则不进全局自动段）。**v0.5.0：增量采集（水位线只解新增帧，热启动 11ms）＋运行中实时入箱（宿主 `session/event`）＋聚簇索引（同坑累加次数、已处置复发重开并标注）＋`--dry`/`--full`/只读 `--stats`**。**v0.5.1：自引用/探针回声过滤（两级签名，对 error 类同样生效）——真实历史预演从 26 条噪声候选降到 2 条真坑**。**v0.6.0：拉取式采集——`settings.autoAdd=false` 时扫描照常（增量、0 token）但新发现只暂存 `state.deferred`，**不自动写入待审箱**；用户说「小本本复盘」时 `mine.cjs --add` 一次性冲入待审箱**。

## 模块地图

```
plugin/
├─ package.json            # @deepseek-ai/dsh-whale-notebook (type: module; dsh.client 声明)
├─ cordis.patch.yml        # 主机平面挂载模板(参考；现场行由 deploy-web.cjs 管理)
├─ lib/index.js            # 插件入口(host half: /whale/inbox|detail|solved|entry|live|delete|scan 注册 + v0.5 session/event 实时采集挂载)
├─ lib/client.js           # 浏览器半边(决策箱悬浮面板 bundle; v0.5: ⟳=触发增量扫描再刷新, ⚡隐藏(AUTO_VISIBLE=false), 双卡互跳 ✅/🐳)
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
   │  ├─ privacy.cjs       # 打码 redact(压白, 兼容不变式)/redactLines(保留行结构) / 指纹 hash36 / 规范 canonText（隐私唯一出口）
   │  ├─ summarize.cjs     # v0.3 现象一句话 oneLiner(纯规则行级清洗+句界截断)
   │  └─ schema.cjs        # 类别表/SCOPE_TITLES(global|project)/设置默认/AGENTS 标记/inbox 行与条目模板(scope+projects)/规则行
   ├─ store/               # ★数据层(单一事实源; 未来可换 sqlite/远程)
   │  └─ repo.cjs          # 路径常量 + settings/state/inbox/entries(scope/projects 解析, 去引号)/INDEX=已解决墙生成器/readEntryText/details(C###.md) 读写, 移除候选联动归档
   ├─ collector/           # ★记录层(采集: 批扫 + 实时 共用一个判定层)
   │  ├─ decoder.cjs       # zstd 多帧 JSONL 解码 + v0.5 增量 decodeLinesFrom(file, offset)/readTail(只读新增字节、按帧边界续扫)
   │  ├─ patterns.cjs      # 坑特征词典(展示/硬拦共用)
   │  ├─ scanner.cjs       # 事件判定(失败/特征, 自引用与框架排除) + v0.5 classifyRecord 供批扫与实时共用; 跨窗口继承 callId→工具名
   │  ├─ engine.cjs        # v0.5 增量水位线 scanHistory + 共享入库 ingestFresh(指纹→聚簇累加/复发/静默/新建) + 详情 sidecar; --check|--stats|--prewarm
   │  ├─ live.cjs          # v0.5 实时采集器(宿主 session/event → 去抖 1.5s → 串行写盘; 异常全吞, 不影响会话)
   │  └─ cli.cjs           # CLI 分发(--check/--stats/--prewarm + --full/--dry; --render-rules、--wall)
   ├─ inject/              # ★生效层(L1 AGENTS 自动段; 未来: system-prompt 段/硬拦守卫)
   │  └─ agents.cjs        # 自动段正文生成器(v0.4 B1: 只收 scope=global; 规则行排序/上限/尾注/标记内替换)
   ├─ review/              # ★审核层(人工确认闭环)
   │  └─ commit.cjs        # 计划式入库 planCommit(纯函数) + 候选行选取
   └─ ui/                  # ★展示/外观层(已落地: 决策箱面板)
      ├─ contracts.md      # 接入契约(视图模型/事件/推荐平面)
      ├─ viewmodel.cjs     # inboxViewModel/statsViewModel/solvedViewModel(UI 唯一数据入口; 墙形状=全局区/项目区/停用)
      ├─ server.cjs        # host API 纯逻辑(list/detail/delete + v0.4 solved/entry; 幂等; http 适配在 lib/index.js)
      └─ server.selftest.cjs # server.cjs 沙盒单测(临时 DSH_HOME; v0.4 含墙/agents B1 断言)
```

旧文件 → 新归属：`scripts/mine.cjs`=兼容薄壳（转发 cli.cjs）；`scripts/redact.test.cjs`=core/privacy 测试；数据文件(inbox/entries/state/settings/INDEX/archive)不动。

## 部署：决策箱面板（v0.4.0 已实现）

设计文档：项目 `docs/2026_09_09_18_whale-notebook决策箱面板设计.md`（v2.1 基础）+ `docs/2026_09_09_22_whale-notebook决策箱v0.3实施计划.md` + `docs/2026_09_09_23_whale-notebook已解决墙与分类v0.4实施计划.md` + `docs/2026_09_10_10_whale-notebook增量采集与实时入库v0.5开发实施计划.md`。浏览器半边=悬浮侧边面板**双卡**：待审箱（⚡自动处理(暂隐)/💬详细讨论/✕删除）+ 已解决墙（全局区/项目区分组，行点击展开条目全文）；host 半边注册 `GET /whale/inbox`、`GET /whale/inbox/detail`、`GET /whale/solved`、`GET /whale/entry`、`GET /whale/live`、`POST /whale/inbox/delete`、`POST /whale/scan`。

v0.3 语义要点：现象行 = 规则精炼一句话（堆栈/`Error:` 清洗，≤90 字）；候选详情存 `~/.dsh/whale-notebook/details/C###.md`（源会话引用 + 打码摘录 ≤600 字，删除候选时随行进 `archive/details/`）；删除按钮=红色 ✕（移入归档，可恢复）；⚡自动处理模板内嵌判定表（只读诊断；补全型小修——不删除/不碰 DSH 结构/影响域封闭/可自验证——可自动执行，先预告后动手；禁区一律禁止，回复固定行 `[WHALE-RISK]`），面板轮询会话消息识别该标记后弹红色警示条并支持「转人工讨论」一键开新会话。

v0.4 语义要点：条目 frontmatter 新增 `scope: global|project` + `projects: [项目…]`（缺省/旧条目 = global，零迁移；判定为语义判断，入库时 AI 建议 + 用户确认）；**B1**：AGENTS 自动段只收 scope=global（项目级永不注入全局，状态行注明去向）；已解决墙 = 轻口径（入库即已处理）——A1 文档墙（INDEX.md 升级：全局区/项目区 × 类别 + 停用收尾，`mine.cjs --wall` 预览）与 A2 面板「已解决」卡同源（viewmodel.solvedViewModel → `/whale/solved`；行详情 `/whale/entry?id=E###`）。

v0.5 语义要点：**增量采集**——`state.json` v2 记每个会话日志的水位线 `{size,mtimeMs,offset,frames,ws,calls}`：未更新只 stat 跳过，变大只读 `[offset,EOF)` 的新帧（帧边界与行边界严格对齐，无需回收半行），末尾半写帧不推进 offset 下次自动重试；水位线失效（截断/轮转）该文件退回全量。**实时入库**——宿主半边订阅 `session/event`，与批扫共用同一判定层与 `ingestFresh`，去抖 1.5s、串行写盘、每轮现读现写 state，全程零模型 token，异常不影响会话（`liveCapture:false` 可关）。**聚簇索引**——`clusters[hash]→cid`：同一坑跨轮次再次出现时**累加次数**而不是新增重复行；候选已处置（不在 inbox）后再出现 = **复发**，重开候选并在现象列标 `复发（原 C0xx）：`，`reAddCooldownDays`（默认 7 天）内只静默计数。**CLI**：`--check`（增量）/`--full`（全量校验）/`--dry`（只看不写）；`--stats` 改为**纯只读**（旧版会写掉 seen 指纹，等于静默吞掉这批候选）。**面板**：⟳ = 先 `POST /whale/scan`（增量扫描）再刷新列表；`GET /whale/live` 暴露实时采集与水位线状态。**待审行**：写入时 `|` 转全角 `｜`（否则该行无法被表格解析）；解析收敛到 `repo.parseInboxRows`。**提醒句**：待审 > `reminderListMax`（默认 3）只报数字 + 提示面板，不再逐条列清单（省 token）。设计文档：`docs/2026_09_10_10_whale-notebook增量采集与实时入库v0.5开发实施计划.md`。

实测（真实历史 23.88MB/13 会话）：冷启动全量 2233ms → 热启动 **11ms / 读取 0 字节 / 跳过 13 文件**；`--full` 复核新发现 0 条（增量无漏采）。

v0.5.1 补充：**自引用/探针回声过滤**——`SELF_REF`/`ENC_DIAG_RE` 原先只作用于成功结果，`error` 类绕过，导致「维修采集器自身」的失败与探针输出全部进箱。新增 `scanner.isMetaEcho()` 两级签名（STRONG 单条命中即判；WEAK 需 ≥2 条同时命中，避免误伤真实故障文本），命中者标 `meta=true` 后由 engine **落档 `archive/echo-<日期>.md` 再排除**（不静默丢弃），扫描输出报「自引用回声过滤 N 组/M 条」，`GET /whale/live` 同步计数。效果：同一份真实历史新候选 **26 → 2**（留下的是真的沙箱拒绝坑）。

v0.6.2 补充（真实从零重扫三轮迭代而来）：① 回声签名扩充——简报技能自己的扫描输出（`### WORKSPACE:`/`filesWritten:`/`recentFiles:`/`real user msgs:`/`sessions: N`/`workspaces: N`/`asst: N`）、DSH 源码与 profile 摘录（行号前缀 `361: …`、YAML `- id: …`、`disabled: true`）、zstd 十六进制转储、含候选编号的自查输出（`C030 | model-api | …`）全部识别为回声；用户叙述侧补 `生成经验|经验库|避坑|运行记录` 框架词（元讨论不算运行坑）。② 类别正则收紧——`model-api` 原 `/429|insufficient|balance/` 会把「文件名清单里的字节数 429」「insufficient permissions」误判为模型 API 错，现改为限流/配额语境；权限类文本（`insufficient permissions`/`access is denied`/`拒绝访问`）归口 `sandbox-file`，而 ssh 的 `Permission denied (publickey)`、`Host key verification failed` 归口 `git-net`。效果：真实历史从零重扫的候选 36 → **26**，且无类别误判。

v0.6 语义要点：**拉取式（pull）**——`settings.autoAdd=false` 时，`--check` 照常增量扫描并推进水位线/指纹（8ms、0 token），但新发现不写 `inbox.md`，而是合并进 `state.json` 的 `deferred` 摘要（`{cat,text,n,first,last,ws[],refs[],excerpt}`，上限 `maxDeferred`）；用户主动说「小本本复盘 / 待审核箱」时才 `mine.cjs --add` 把暂存冲入待审箱（重建候选行 + `details/C###.md`，曾经处置过的标「复发（原 C0xx）」）。**已在待审箱里的候选不受影响**：命中共聚簇时仍只累加次数（不新增行）。**提醒句随开关二选一**（`agents.cjs`：注入文本必须与实际行为一致）：拉取式下只报一行「新发现 N 组已暂存（未入箱）」，不展开清单、不询问审核，比自动模式更省 token。**面板**：`GET /whale/inbox` 附带 `deferred` 组数，仅有暂存时候选入口不隐藏，卡片提示「回复『小本本复盘』入箱后审核」。实时采集（`liveCapture`）同样遵守 `autoAdd`：关掉也只暂存、不写箱。设计文档：`docs/2026_09_10_10_whale-notebook增量采集与实时入库v0.5开发实施计划.md` §4.7。

```powershell
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs"            # dry-run
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --apply    # 复制包 + patch ~/.dsh/profiles/web/cordis.patch.yml
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --check    # 自检
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --undo --apply [--yes]  # 回退
```

- **生效差异（v0.5 起）**：浏览器半边 `lib/client.js` 改动**只需刷新页面**（loader 每请求现读磁盘 + `no-cache`）；宿主半边 `lib/index.js`/`src/**` 改动（实时采集、新端点）**需重启 dsh web**（会中断在线会话，时机由用户定）；`mine.cjs` 增量批扫不依赖重启，立即可用。
- dsh 升级/pnpm 重装清掉 `profiles/node_modules` 后重跑 `--apply` 即可。
- 验证：`node src/ui/server.selftest.cjs`（host 逻辑 45 断言）、`node src/core/privacy|summarize.selftest.cjs`、`node src/collector/engine|e2e|live.selftest.cjs`（engine 10 + zstd 全链 51 + 实时 19 断言）、`node scripts/bundle-smoke.cjs`（bundle 桩，含 v0.4/v0.5/v0.6 结构断言）——共 6 套件 **145 断言** + bundle 桩，全绿（2026-09-10 v0.6.0）。

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
