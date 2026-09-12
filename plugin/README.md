# dsh-whale-notebook 插件包（v0.7.8：待审箱两个新入口——页脚「自动收集」开关（`settings.autoAdd`，只写 settings.json）＋页头 ⛏「历史深掘」（`POST /whale/sweep` = `--add` 保底 + `--rebuild --add` 全量重扫历史直接入箱 + 自动开总结会话）· 扫描让出事件循环 · rebuild 维护窗口 · 漂移分级与 check --adopt（lifecycle 0.2.0）· 回声自我放大治理 · 暂存污染清理 · 双计口径加固 · 端点闸门 · 采集健康度可观测 · 打码补漏 · 状态文件完整性 · 归档签名修正 · 讨论落点路由 · 类别展示契约 · CLI 退出码 · 同族确定化 · 决策箱双卡 = 待审箱 + 已解决墙）

鲸鱼小本本从「skill + 脚本」升级为**模块化插件包**：分模块对应未来功能（核心/记录/生效/审核/展示），任何一块都可独立演进。v2.0 只做结构与契约（零挂载风险，现有 skill+AGENTS+脚本继续可用）；v2.1 起做真实 cordis 挂载（决策箱面板 = host half API + browser half 悬浮 UI，`scripts/deploy-web.cjs` 一键部署）。v0.3.0：现象一行一句话、候选详情 sidecar、删除改红色 ✕、自动处理判定表硬规则 + `[WHALE-RISK]` 重大隐患上报与红色警示条。v0.4.0：已解决墙（A1 文档墙 INDEX.md + A2 面板「已解决」卡）＋全局/项目两级分类（entry scope/projects）＋B1（项目级规则不进全局自动段）。**v0.5.0：增量采集（水位线只解新增帧，热启动 11ms）＋运行中实时入箱（宿主 `session/event`）＋聚簇索引（同坑累加次数、已处置复发重开并标注）＋`--dry`/`--full`/只读 `--stats`**。**v0.5.1：自引用/探针回声过滤（两级签名，对 error 类同样生效）——真实历史预演从 26 条噪声候选降到 2 条真坑**。**v0.6.0：拉取式采集——`settings.autoAdd=false` 时扫描照常（增量、0 token）但新发现只暂存 `state.deferred`，**不自动写入待审箱**；用户说「小本本复盘」时 `mine.cjs --add` 一次性冲入待审箱**。**v0.6.1：`--rebuild` 清派生状态后从头梳理全部历史（`--rebuild --add` 一条命令扫完入箱）**。**v0.6.2：回声签名扩充 + 类别正则收紧（真实历史从零重扫候选 36 → 26，且无类别误判）**。**v0.6.3：已处置签名去重——把归档表当事实源，修掉「state 重置/重扫后同一个坑重复开行」（同一行曾先后开出 3 个编号）**。**v0.7.0：同族（family）确定化——`src/core/similarity.cjs` + L1 族合并 + `GET /whale/related` + 面板「族×N」，让「还有类似的问题可以一并处理」由程序算出、可复现可解释，而不是模型即兴归纳**。**v0.7.1：回声过滤补漏——工具结果里对历史日志/sidecar/`state.json` 的转储与 notebook 自渲染行（转储信封 `==== L### <kind>`、候选行 `| C### | … |`）不再被当成新事件开行（此前同一物理事件在复盘会话里被重新开行）；`META_DUMP` 只认渲染痕迹、不认失败语义，故同一失败原文照收**。**v0.7.1 另修 `deploy-web --check`：补与权威源逐文件字节对账，副本陈旧即 exit 1（此前只核结构，实测出现「check 通过但副本仍是 0.7.0、重启后没生效」）。**v0.7.2：修正回声表行判据的行首锚——成功路径会先把输出压成单行（`raw.replace(/\s+/g, ' ')`），带 `^` 则永远匹配不到（实测「打印 echo 归档行」的命令输出照样进暂存）；三条表行判据改为不锚定，并要求时间戳行后随类别词，免得误伤普通表格。** **v0.7.3：讨论落点路由（💬 按候选来源选落点——跨项目 → 固定「鲸鱼全局」工作区；单项目 → 该项目工作区；未知/歧义 → 回退当前并在 toast 说明依据；页脚三态开关 + `localStorage` 记忆；落点与依据写进新会话开局消息）＋ `/whale/inbox` 归档列修复（行尾 `|` 不再被续写成空列）＋ 类别展示契约（补 `error` 标题；把标题兜底与排序秩收成 `schema.cjs` 一处并导出，文档墙与面板分组排序由此一致、未登记类别两侧都排末尾）＋ CLI 退出码（0 成功 / 2 前置缺失 / 1 失败，唯一进程级出口放在薄壳，`cli.run()`/`engine.runScan()` 保持纯函数）＋ 面板样式节点纳入 disposer（谁创建谁回收）。**

## 模块地图

```
plugin/
├─ package.json            # @deepseek-ai/dsh-whale-notebook (type: module; dsh.client 声明)
├─ cordis.patch.yml        # 主机平面挂载模板(参考；现场行由 deploy-web.cjs 管理)
├─ lib/index.js            # 插件入口(host half: /whale/inbox|detail|solved|entry|live|related|delete|scan 注册 + v0.5 session/event 实时采集挂载)
├─ lib/client.js           # 浏览器半边(决策箱悬浮面板 bundle; v0.5: ⟳=触发增量扫描再刷新, ⚡隐藏(AUTO_VISIBLE=false), 双卡互跳 ✅/🐳)
├─ manifest.json           # ★包内默认清单(生命周期: 足迹=卸载白名单, schema v1)
├─ lifecycle/              # ★自举生命周期模块(第 0 功能: 安装/卸载/清单, 仅 node 内建)
│  ├─ README.md            # ★本模块速查: 三段足迹/命令/约定/清单结构(R 段写入归 deploy-web.cjs)
│  ├─ cli.cjs              # status/check/install/uninstall detach|remove|purge
│  ├─ consts.cjs           # 版本/路径解析/AGENTS 模板/帮助
│  ├─ zones.cjs            # AGENTS 标记区几何操作(纯文本; 亦用于 R 段 patch 标记区对账)
│  ├─ manifest.cjs         # 站点清单 .lifecycle/manifest.json 存取/合并/迁移/快照
│  ├─ fsx.cjs              # 原子写/哈希/树复制删除(字节安全)
│  └─ selftest.cjs         # 沙盒端到端自测(临时 home, 104 PASS: 含 R 段与"不碰真实部署"反证)
├─ scripts/
│  ├─ deploy-web.cjs       # ★部署工具: 复制包 + patch web profile(幂等; dry/apply/undo/check)
│  ├─ links-doctor.cjs     # ★维护工具: 工具主目录悬空链接(junction/死链)体检/清理(dry 默认只读, --apply 才删; 退出码 0/3/1)
│  ├─ links-doctor.selftest.cjs # 43 断言(临时夹具+真 junction: 只读/根外拒删/目标已修复不删/幂等, 含反证)
│  ├─ discuss-route.selftest.cjs # 28 断言(讨论落点路由判定表; v0.7.3)
│  ├─ panel-actions.selftest.cjs # 30 断言(v0.7.8 面板两个新入口: 两态表/pin 降级/深掘结果行与开局消息)
│  └─ bundle-smoke.cjs     # client bundle 桩执行检查(vm + __ModuleLoader__ 桩 + v0.4–v0.7.8 结构断言)
└─ src/
```
   ├─ core/                # ★领域层(零依赖, 全模块共用契约)
   │  ├─ util.cjs          # fmtTime
   │  ├─ privacy.cjs       # 打码 redact(压白, 兼容不变式)/redactLines(保留行结构) / 指纹 hash36 / 规范 canonText（隐私唯一出口）
   │  ├─ summarize.cjs     # v0.3 现象一句话 oneLiner(纯规则行级清洗+句界截断)
   │  ├─ similarity.cjs    # v0.7 骨架归一 skeleton + 3-gram 相似度 + bestFamily 族判定(同类 0.6/跨类 0.8, settings 可调); 纯函数
   │  ├─ similarity.selftest.cjs # 20 断言(含四条「不得误并」反证)
   │  └─ schema.cjs        # 类别表/SCOPE_TITLES(global|project)/设置默认/AGENTS 标记/inbox 行与条目模板(scope+projects)/规则行
   ├─ store/               # ★数据层(单一事实源; 未来可换 sqlite/远程)
   │  └─ repo.cjs          # 路径常量 + settings(v0.7.8 readSettingsStrict/writeSettings)/state/inbox/entries(scope/projects 解析, 去引号)/INDEX=已解决墙生成器/readEntryText/details(C###.md) 读写, 移除候选联动归档
   ├─ collector/           # ★记录层(采集: 批扫 + 实时 共用一个判定层)
   │  ├─ decoder.cjs       # zstd 多帧 JSONL 解码 + v0.5 增量 decodeLinesFrom(file, offset)/readTail + v0.7.7 maxBytes 窗口读(大日志 256KB 片续读, 让出事件循环)
   │  ├─ patterns.cjs      # 坑特征词典(展示/硬拦共用; v0.6.2 收紧 model-api/权限类正则)
   │  ├─ scanner.cjs       # 事件判定(失败/特征, 自引用与框架排除) + v0.5 classifyRecord 供批扫与实时共用; v0.5.1 isMetaEcho 两级回声签名; 跨窗口继承 callId→工具名
   │  ├─ engine.cjs        # v0.5 增量水位线 scanHistory + 共享入库 ingestFresh(指纹→聚簇累加/复发/静默/新建) + 详情 sidecar; v0.6 拉取式暂存 deferred + --rebuild; v0.6.2 已处置签名索引(归档表为事实源); v0.7 族合并; v0.7.7 生成器+双驱动/维护窗口; v0.7.8 opts.maxNewRows 透传(深掘上限 500)
   │  ├─ live.cjs          # v0.5 实时采集器(宿主 session/event → 去抖 1.5s → 串行写盘; 异常全吞, 不影响会话; 同样遵守 autoAdd 只暂存)
   │  ├─ cli.cjs           # CLI 分发(--check/--stats/--prewarm + --add/--dry/--full/--rebuild; --render-rules、--wall)
   │  └─ *.selftest.cjs    # engine(38) · engine.dedup(24) · e2e(67, zstd 全链) · live(48) · sweep(20, v0.7.8 深掘全链)
   ├─ inject/              # ★生效层(L1 AGENTS 自动段; 未来: system-prompt 段/硬拦守卫)
   │  └─ agents.cjs        # 自动段正文生成器(v0.4 B1: 只收 scope=global; v0.7.8 尾注改"双模式自述": 以 --check 输出为准)
   ├─ review/              # ★审核层(人工确认闭环)
   │  └─ commit.cjs        # 计划式入库 planCommit(纯函数) + 候选行选取
   └─ ui/                  # ★展示/外观层(已落地: 决策箱面板)
      ├─ contracts.md      # 接入契约(视图模型/事件/推荐平面)
      ├─ viewmodel.cjs     # inboxViewModel/statsViewModel/solvedViewModel(UI 唯一数据入口; 墙形状=全局区/项目区/停用)
      ├─ server.cjs        # host API 纯逻辑(list/detail/delete + v0.4 solved/entry + v0.7.8 settingsPayload/updateAutoAdd)
      └─ server.selftest.cjs # server.cjs 沙盒单测(临时 DSH_HOME; v0.4 含墙/agents B1 断言; v0.7.8 含开关写路径纪律)
```

旧文件 → 新归属：`scripts/mine.cjs`=兼容薄壳（转发 cli.cjs；**v0.7.3 起自带退出码契约 0 成功 / 2 前置缺失 / 1 失败**——唯一进程级出口，`cli.run()` 与 `engine.runScan()` 保持纯函数，宿主半边走后者）；`scripts/redact.test.cjs`=core/privacy 测试；数据文件(inbox/entries/state/settings/INDEX/archive)不动。

## 部署：决策箱面板（v2.1 起已实现，现状 v0.7.8）

设计文档：项目 `docs/2026_09_09_18_whale-notebook决策箱面板设计.md`（v2.1 基础）+ `docs/2026_09_09_22_whale-notebook决策箱v0.3实施计划.md` + `docs/2026_09_09_23_whale-notebook已解决墙与分类v0.4实施计划.md` + `docs/2026_09_10_10_whale-notebook增量采集与实时入库v0.5开发实施计划.md`（该文档 §4.7/§4.8 同时承载 v0.6 与 v0.7）+ `docs/2026_09_12_*_whale-notebook待审箱两个新入口设计与实施.md`（v0.7.8）。浏览器半边=悬浮侧边面板**双卡**：待审箱（⚡自动处理(暂隐)/💬详细讨论/✕删除/**v0.7.8 ⛏历史深掘 + 页脚「自动收集」开关**）+ 已解决墙（全局区/项目区分组，行点击展开条目全文）；host 半边注册 `GET /whale/inbox`、`GET /whale/inbox/detail`、`GET /whale/solved`、`GET /whale/entry`、`GET /whale/live`、`GET /whale/related`、**`GET /whale/settings`（v0.7.8）**、`POST /whale/inbox/delete`、`POST /whale/scan`、**`POST /whale/settings`（v0.7.8 自动收集开关）**、**`POST /whale/sweep`（v0.7.8 历史深掘）**。

## 现状语义速览（v0.7.8）

> 只写**现在的行为**。每条的完整沿革、起因与实测数据见仓库根 **`CHANGELOG.md`**；设计论证见 `docs/`。

**采集**
- **增量**：`state.watermarks` 记每份会话日志的水位线；未更新只 stat 跳过，变大只读 `[offset,EOF)` 的新帧（帧边界与行边界对齐，末尾半写帧不推进 offset，下次自动重试）；水位线失效（截断/轮转）该文件退回全量。
- **实时**：宿主半边订阅 `session/event`，与批扫共用同一判定层（`scanner.classifyRecord`）与入库路径（`engine.ingestFresh`）；去抖 1.5s、串行写盘、每轮现读现写 state，**零模型 token**，异常全吞不影响会话（`liveCapture:false` 可关）。
- **拉取式**：`settings.autoAdd=false` 时新发现只进 `state.deferred`（上限 `maxDeferred`），说「小本本复盘」时 `mine.cjs --add` 才冲入待审箱；**已在箱候选命中共聚簇只累加次数**。
- **回声过滤**：`scanner.isMetaEcho()` 四级签名（STRONG 单条即判 / **v0.7.6 新增 META_ARTIFACT：我们自己的产物标识与探针抬头（`seenFingerprints` 等 state 字段名、`topKeys=`/`parts=N [` 等探针抬头、`| 时间 | 类别 |` 表头）单条即判** / WEAK 需 ≥2 条 / **v0.7.1 新增 META_DUMP，单条即判（v0.7.2 起表行判据不锚定、时间戳行要求类别词）**：会话日志转储信封 `==== L### <kind>`、会话记录 JSON 信封、notebook 表行）过滤自引用、探针输出与「转储/回显」型回声，命中者落档 `archive/echo-<日期>.md` 再排除（不静默丢弃）。**v0.7.6 出处整类拦截（A3）**：命令碰过我们的数据产物/接口（`whale-notebook/{state.json,inbox.md,INDEX.md,details,archive,entries}`、`/whale/*`、`mine.cjs`）**且**结果里是我们自己渲染的结构化输出（表格行 / JSON 对象字面量）→ 判回声；只碰 `plugin/src|lib|scripts` 的**开发调试不算**（跑自检发现的真实 bug 必须继续进箱）。
- **回声不再自我放大（v0.7.6）**：回声落档改为「**稳定签名 + 幂等追加**」——签名 = `类别|一句话现象（≤90 字）`（与归档列同口径），落档前与当日归档已有签名比对，已存在就不写。旧的「按聚簇哈希（整段文本）分组」会让同一现象每次被打印都新开一行（实测 231 行只对应 77 个现象、单现象最多 8 行）。当日分片超 `ECHO_MAX_ROWS`（400）自动轮转 `echo-<日期>-2.md`；`GET /whale/live` 的 `echo` 报当日/累计行数，不会无限增长。
- **暂存污染清理（v0.7.6）**：`mine.cjs --forget-echo [--apply]` 用同一套回声判定回头清理**历史**污染（默认干跑列清单）。首次执行实测：18 组暂存里 13 组（72%）是我们自己的探针/接口/状态转储 → 清理后剩 5 组真实发现。
- **去重与复发**：`clusters[hash]→cid` 累加次数而不是新增重复行；已处置签名（**归档表为事实源**）压掉重复开行；候选已处置后再现 = **复发**，重开并标 `复发（原 C0xx）：`，`reAddCooldownDays`（默认 7 天）内只静默计数。
- **同族**：未命中同文聚簇但与某「族」（同一 cid 的多个聚簇）相似 → **并入该族已有候选行**（累加次数 + sidecar 记「## 同族并入」），不新开行；同类阈值 **0.6** / 跨类 **0.8**（`familyThresholdSame/Cross` 可调）。
- **数据口径**：待审行写入时 `|` 转全角 `｜`（否则该行无法被表格解析），解析统一走 `repo.parseInboxRows`；**提醒句（v0.7.8）**改为**双模式自述**——以「本轮是自动入箱还是仅暂存，以 `--check` 的命令输出为准（`settings.autoAdd`，面板「自动收集」开关可切）」开头，再分别写明两种输出对应的纪律。这样注入文本永远不撒谎，且**开关切换一个字节都不碰 AGENTS.md**（注入口径与实际行为一致，这是 v0.6 就立下的不变式）。

**CLI**：`--check`（增量）· `--add`（暂存入箱）· `--prewarm` · `--stats`（**纯只读**）· `--full`（全量校验）· `--dry`（只看不写）· `--rebuild`（清派生状态后从头梳理全部历史）· `--forget-echo [--apply]`（v0.7.6：清理暂存里的自引用回声，默认干跑）· `--render-rules` · `--wall`。

**面板**：双卡（待审箱 / 已解决墙）。现象行 = 规则精炼一句话（≤90 字）；详情 `details/C###.md`（源会话引用 + 打码摘录 ≤600 字，删除候选随行进 `archive/details/`）；删除 = 红色 ✕（移入归档可恢复）；⚡ 自动处理只允许「补全型小修」（不删除 / 不碰 DSH 结构 / 影响域封闭 / 可自验证），禁区一律禁止并回复固定行 `[WHALE-RISK]` → 红色警示条 + 一键转人工讨论；`⟳` = 先 `POST /whale/scan` 再刷新（**v0.7.7：扫描让出事件循环，全量 ≈5s 期间宿主不再被独占**）；`GET /whale/live` 暴露实时采集、水位线、回声归档与维护窗口状态；`GET /whale/related?id=C###` 给讨论会话三块确定依据（族成员 / 相似候选 / 可能已被条目覆盖）；行带「族×N」小标。**提醒句**：待审 > `reminderListMax`（默认 3）只报数字 + 提示面板，不再逐条列清单。

**v0.7.8 两个新入口（面板）**
- **页脚「自动收集」开关**（两态：`自动入箱`｜`仅暂存`）：改的是 `settings.autoAdd`，**只写 `settings.json`**（严格读 + 原子写 + `autoAdd` 白名单；损坏的文件报错且一个字节都不写），立即生效、无需重启；状态**取自服务端** `GET /whale/settings`（不是 localStorage），读失败时面板显示未知态并提示，不假装成功。
- **页头 ⛏「历史深掘」**（`POST /whale/sweep`）：阶段① `--add`（先把已有暂存冲进待审箱，防重建清空丢件）→ 阶段② `--rebuild --add`（清空水位线/指纹/聚簇后从头梳理全部历史，直接入箱）。已处置保护不变（归档签名在重建时不剔除 → 归档/入库过的不复活；在箱候选只累加不重复开行）。单轮开行上限提到 **500**（默认 30：超限被丢弃会同时记指纹＝永久抓不到；真超了 `dropped` 会显式暴露）。深掘期间复用 v0.7.7 的"让出事件循环 + 维护窗口"，`/whale/live` 的 `scanJob.kind='sweep'` 带 `phase` 进度；`{"dry":true}`＝只读预演（零写盘）。完成后**自动开一个新会话**做「历史错误总结 / 同族合并建议 / 入库草案」（落点＝鲸鱼全局，复用 💬 通路；开局消息含扫描统计、待审清单 ≤20 条与只读约束；无新发现且待审为空则不开，不白烧 token）。
- **面板记忆（pin）**：用户主动展开过面板后，即使待审为 0 也保留侧边入口（`localStorage['whale.panelPin']`）——否则"待审=0 且要切换开关"时入口会消失，那正是最需要开关的时候；对从没开过面板的人行为不变（不打扰）。

**扫描与维护窗口（v0.7.7）**：`scanHistory` 与 `runScanInner` 改为**生成器 + 双驱动** —— 同步驱动（CLI，退出码不变）忽略让出请求，异步驱动（宿主 `runScanAsync`）在让出点 `await setImmediate`，所以点 ⟳ 触发全量扫描时面板/GUI/实时采集都照常响应。让出粒度经**实测修正**：第一版"每 8 文件 / 每 4MB"仍会让宿主卡到 **3857ms**（单个 3.4MB 大日志一次整段解完），现改为 `decoder` 的 `maxBytes` 窗口读 + `readFileWindows` 生成器，大日志按 **256KB 一片**续读，**复测最大卡顿 69ms**。`/whale/live` 的 `scanJob` 可看到在飞那一轮，插件卸载时置取消位（扫描在下一个让出点退出并**一定释放写锁**）。`--rebuild` 开一个**维护窗口**（`.maintenance.json` 标记 + `expiresAt` 兜底）：期间实时采集**让路但不丢事件**（留在内存缓冲、1s 后重试，`live.heldByMaintenance` 计数），窗口在 `finally` 里无条件关闭，进程被强杀也不会永久停写。

**安装面（lifecycle，v0.2.0 / 插件 v0.7.8）**：AGENTS 建议用 **zones 模式**（只管理两个标记区，区外是用户自己的内容——`uninstall remove` 只剥区、绝不整文件删除）。`lifecycle check` 的漂移判定分级：**缺失 / 结构损坏（截断、乱码、frontmatter 丢失、必需小节消失）/ 孤儿 / 清单待迁移 → exit 1**；**内容变了但结构完好 → 「待登记」（信息级，exit 0）**，跑 `check --adopt` 重新登记基线（只改清单里的 hash，不碰文件内容）。`uninstall remove` 遇到内容不一致仍要求 `--yes`（删除前确认）。**v0.7.8 起面板开关不写 AGENTS.md**，因此切换开关**不会**产生「待登记」。

**条目与生效**：frontmatter 含 `scope: global|project` + `projects` 白名单（缺省/旧条目 = global，零迁移）；**B1**：AGENTS 自动段只收 `scope=global`（项目级永不进全局注入，状态行注明去向）；已解决墙 = 轻口径（入库即已处理），文档墙 `INDEX.md` 与面板「已解决」卡同源（`GET /whale/solved` / `GET /whale/entry?id=E###`）。**类别展示契约（v0.7.3）**：分组标题与顺序由 `core/schema.cjs` 的 `categoryTitle` / `sortCategoryKeys` 统一给出——文档墙与面板因此永远同序，**未登记类别一律排末尾**（此前面板排最前、文档墙排最后），且新增类别漏登记标题会被自测的完备性断言拦下。

```powershell
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs"            # dry-run
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --apply    # 复制包 + patch ~/.dsh/profiles/web/cordis.patch.yml
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --check    # 自检（v0.7.1 起含与权威源逐文件字节对账：副本陈旧 exit 1）
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --undo --apply [--yes]  # 回退
```

- **生效差异（v0.5 起）**：浏览器半边 `lib/client.js` 改动**只需刷新页面**（loader 每请求现读磁盘 + `no-cache`）；宿主半边 `lib/index.js`/`src/**` 改动（实时采集、新端点如 `/whale/related`）**需重启 dsh web**（会中断在线会话，时机由用户定）；`mine.cjs` 增量批扫不依赖重启，立即可用。
- dsh 升级/pnpm 重装清掉 `profiles/node_modules` 后重跑 `--apply` 即可；**重装会换掉旧 junction 指向的包缓存 → 留下悬空链接（死链）：它会让 ripgrep 搜索模式 exit 2、整次检索结果被丢弃（经验条目 E005）**。体检/清理用 `node scripts/links-doctor.cjs`（默认只读，exit 3 = 发现悬空）/ `--apply`（逐条复验后只摘链接本身）。
- 验证（2026-09-12 实测全绿，v0.7.8）：`node src/ui/server.selftest.cjs`(82，v0.7.8 +19 自动收集开关) + `src/core/privacy.selftest.cjs`(23) + `src/core/summarize.selftest.cjs`(10) + `src/core/similarity.selftest.cjs`(20) + `src/store/repo.selftest.cjs`(34) + `src/collector/engine.selftest.cjs`(38，v0.7.8 +3 maxNewRows) + `src/collector/engine.dedup.selftest.cjs`(24) + `src/collector/e2e.selftest.cjs`(67) + `src/collector/live.selftest.cjs`(48) + `src/collector/sweep.selftest.cjs`(20，v0.7.8 新增：深掘全链) + `lifecycle/selftest.cjs`(120) = **11 套件 486 断言** + `node scripts/bundle-smoke.cjs`（bundle 桩）+ `scripts/redact.test.cjs`(22 断言) + `scripts/links-doctor.selftest.cjs`(43 断言) + `scripts/discuss-route.selftest.cjs`(28) + `scripts/panel-actions.selftest.cjs`(30，v0.7.8 新增)，全绿（16 个测试文件 PASS 累计 609）。

### 风险与前提（务必先读）

- 本机安装版契约以实际 `dump-config`/包 README 为准；研究文档基于主分支，存在版本漂移。
- 依赖解析依赖 hoisted 布局；物理复制而非符号链接（symlink realpath 会脱离 node_modules）。
- 改 profile = 影响正在运行的 GUI：**必须由你选择时机并亲自重启**。

## 生命周期工具（安装/卸载/清单, v0.2.0: R+I+D 三段 + 漂移分级）

速查见 **`lifecycle/README.md`**；设计文档: 项目 `docs/2026_09_09_16_whale-notebook生命周期设计.md`。三段足迹 = R 运行时(web 面板部署副本+挂载行) / I 集成(AGENTS+skill) / D 数据(用户记忆)。

```text
node lifecycle/cli.cjs status                 # 阶段/足迹/上次操作(含 R 段对账)
node lifecycle/cli.cjs check                  # 清单 vs 现场对账 + 孤儿扫描(退出码 1 = 有问题)
node lifecycle/cli.cjs install                # 干跑出计划 → 确认后加 --apply
node lifecycle/cli.cjs uninstall remove       # 清 R+I, D 原样保留(记忆永不清)
node lifecycle/cli.cjs uninstall purge        # 全清: 必须 --export-dir <目录> --yes(先导出后删除)
node lifecycle/cli.cjs uninstall detach       # 仅 R 段(驱动 deploy-web --undo; 加 --yes 连副本目录一起删)
```

要点（与设计文档的偏差/裁定记录）:

1. **只依赖 node 内建**：插件未挂载、甚至数据目录被移动时, 从任意位置 `node <pkg>/lifecycle/cli.cjs` 均可用（自举）。
2. **两段式写操作**：默认 dry-run 出计划 → 展示 → 确认后 `--apply`；apply 全程幂等、失败重跑可续。
3. **前像快照**：凡改写/删除外部目标先字节级快照至 `.lifecycle/backups/<时间戳>/<id>.bak`；remove 后重装自动从备份还原字节（round-trip 等价）。
4. **AGENTS 两种归属模式**：`whole`(默认, 整文件归插件, remove 整文件删) / `zones`(install --agents-mode zones: 只管理两个标记区: rules+privacy, 区外用户内容永不动)。隐私尾注(原无标记)在 whole/zones 安装时都会纳入 `<!-- whale-notebook:privacy -->` 标记区——设计文档 §5.4「痕迹必须可指认」的落地。
5. **漂移守卫**：登记后文件被外部改动, remove 会中止并提示加 `--yes`（仍先快照留档）。
6. **R 段(运行时)**: 清单如实登记真实部署位(`profiles/web/node_modules/…` + `profiles/web/cordis.patch.yml` 的标记区, `managedBy: scripts/deploy-web.cjs`)。lifecycle 只**登记/对账/快照/驱动**, 写入与删除一律交唯一写入者 `deploy-web.cjs`(幂等, 自带 `--check`/`--undo`); R 段对账是**信息级**, 不左右 `check` 退出码(没部署 ≠ 装坏了)。清单版本迁移(条目改名/新增)由 `install --apply` 自动完成, `check` 会以「待迁移」提示。
7. **`remove` 后 `.lifecycle` 保留**（在 D 内）——与设计稿「清单随最后一级卸载删除」的裁定：remove 不清 D，.lifecycle 是重装/恢复依据；**purge 随 D 一起物理消失**, 无任何残留（含清单自身）。
8. **成果确认约定**：卸载计划先输出成果文件清单（待审候选/经验条目/归档计数 + 逐项去留），AI 删除前必须经用户确认；purge 前置导出（`--export-dir`）与二次确认（`--yes`）。
9. **已验证**（2026-09-09 本机真实演练 + 沙盒自测）：remove → 残留核对 → 重装字节等价还原（hash 一致）；中途 AGENTS 注入/skill 目录的移除与恢复均由 DSH 原生机制即时反映。2026-09-10 补 R 段覆盖 → **104 PASS / 0 FAIL**，含反证「R 段测试全程不碰真实 home 的 `cordis.patch.yml`（`DSH_HOME` 覆盖生效）」。本机真实安装已用 `install --apply` 完成清单迁移与重新登记，`check` 全绿（对账 R 段 2 条）。
