# 更新日志（CHANGELOG）

> **版本沿革的唯一明细入口。** 根 `README.md`、`plugin/README.md`、`PROJECT-INTRO.md` 只写「当前状态」与用法；历史动因、实测数据、设计裁定、踩过的坑都在本文件。
> 版本号口径：插件包 `plugin/package.json`（当前 `0.7.3`）；生命周期工具 `plugin/lifecycle/` 另有独立版本（当前 `0.1.1`）。

## v0.7.3（2026-09-10）讨论落点路由 · 类别展示契约 · CLI 退出码

**要解决的四个问题**（都属"判断依据不可靠"，不是功能缺失）：

- ① **💬 讨论落点不可控**：面板把候选转成新会话时，会话固定开在"当前会话的工作区"——跨项目的候选被开进无关项目，讨论上下文自带噪声。
- ② **类别展示口径缺失**：`error` 是采集**主力类别**（`scanner.cjs` 对任何工具失败结果直接判 `error`，`engine.cjs` 还为它单独开了绕过模式白名单的特权），但 `CATEGORY_TITLES` 里**唯独没有它的标题**；更麻烦的是两个消费者对"未登记类别"的排序判断**相反**——面板（`viewmodel.cjs` 用 `indexOf` → `-1`）排到最前，文档墙（`repo.cjs` 用 filter 追加）排到最后，同一份数据两侧分组顺序不一致。
- ③ **CLI 退出码恒 0**：`mine.cjs` / `collector/cli.cjs` 成功与失败都返回 `0`——全项目唯一例外（`lifecycle/cli.cjs` 0/1/2、`deploy-web` 0/1、`links-doctor` 0/3/1、7 个 selftest 都有退出码）。数据目录缺失时会打印一行错误却返回 0，等于**静默失效**。
- ④ **面板样式节点未回收**：`ensureCss()` 注入的 `<style>` 是唯一不在 `ctx.effect` disposer 里的副作用。

**实现**

- **讨论落点路由**（`lib/client.js`）：跨项目候选 → 开在固定的「鲸鱼全局」工作区（惰性注册并缓存 workspaceId）；单项目 → 开在该项目工作区；未知/歧义 → 回退当前工作区并在 toast 说明依据。页脚加三态开关（自动 / 强制🐳全局 / 强制📁项目，`localStorage` 记忆），落点与判定依据写进新会话开局消息。bundle 不能 `require`，故经 `exports.__internals` 暴露纯函数供自测——`scripts/discuss-route.selftest.cjs` 28 断言。
- **`/whale/inbox` 归档列修复**（`src/ui/server.cjs`）：inbox 行本身以 `|` 结尾，旧写法直接续上 ` | 面板删除 …` 会让归档表多出一列、处置列错位；自测加「归档行恰为 7 列」断言。另修面板收起/外点/Esc 后卡片状态回填错误、以及"重绘判据以卡片可见兜底"。
- **类别展示契约**（`src/core/schema.cjs`）：新增 `error: '工具报错（未归类的失败结果）'`（位置刻意放在具体类别之后、`other` 之前）；把"标题兜底 + 排序秩"收成 `CATEGORY_ORDER` / `categoryTitle` / `categoryRank` / `sortCategoryKeys` 一处并导出，`repo.cjs`（文档墙 `INDEX.md`）与 `viewmodel.cjs`（面板已解决墙）改为调用它 → **未登记类别两侧一律排末尾**。自测 +4，含**完备性断言**（`PATTERNS` 全部 id + `error` 都必须有标题，将来新增类别漏登记即失败）。
- **CLI 退出码契约**（`scripts/mine.cjs`）：`0` 成功（"有新发现/有暂存"亦为成功）／`2` 前置缺失（`sessions` 根或数据目录不存在，对齐 `lifecycle/cli.cjs` 的 2）／`1` 失败或结果形状异常。**唯一进程级出口**放在薄壳里，`cli.run()` 与 `engine.runScan()` 保持纯函数——宿主半边 `POST /whale/scan` 走的是 `engine.runScan`，不经 `cli.run()`，故退出码不会污染 `dsh web` 进程。自测 +3（正常 0 / 两处 `ok:false` → 2 / 早返回分支 0）。
- **面板样式节点纳入 disposer**（`lib/client.js`）：`ensureCss()` 改为返回**本次创建**的节点（复用既有则 `null`），`apply` 记住 `cssNode`，disposer 只回收属于自己的那个——"谁创建谁回收"，避免后一代卸载误删上一代仍在用的节点。bundle 桩 +2 结构断言。

**验证**：9 套件 **320 PASS / 0 FAIL**（server 50 · privacy 10 · summarize 10 · similarity 20 · engine 10 · engine.dedup 19 · e2e 63 · live 34 · lifecycle 104）＋ `bundle-smoke`（v0.4–v0.7.3 结构完整，含样式回收）＋ `redact.test` 13 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28，全绿。

## v0.7.2（2026-09-10）回声表行判据修正

**要解决的问题**：v0.7.1 新增的表行判据带了 `^` 行首锚，**而成功路径会先把工具输出压成单行**（`raw.replace(/\s+/g, ' ')`），带锚则永远匹配不到——实测「打印 echo 归档行」的命令输出照样进暂存。

- 三条表行判据改为**不锚定**，并要求时间戳行后随类别词，免得误伤普通表格。
- 自测：`live.selftest` +2（含反证）。宿主半边需重启 dsh web 生效。

## v0.7.1（2026-09-10）回声过滤补漏 + `deploy-web --check` 字节对账

**要解决的问题**：v0.5 的 `isMetaEcho` 只挡「助手叙述 / 探针输出」类回声；**工具结果里对历史日志、sidecar、`state.json` 的转储与 notebook 自渲染行**（例：诊断脚本打印的 `==== L### <kind>` 信封、`| C### | … |` 候选行）不含既有强特征，会被当成新事件开行——实测同一物理事件在复盘会话里被重新开行为候选。

- 新增单条命中即判的 `META_DUMP` 三类签名（会话日志转储信封 / 会话记录 JSON 信封 / notebook 表行）；**只认渲染痕迹、不认失败语义**，故同一失败原文照收。自测：`live.selftest` +4（含「不误伤原文」反证）。
- 另修 `deploy-web --check`：补与权威源**逐文件字节对账**，副本陈旧即 exit 1——此前只核结构，实测出现过「check 通过但副本仍是 0.7.0、重启后没生效」；副本多余文件只提示不判失败（dsh/pnpm 重装可能留下附带文件）。

## v0.7.0（2026-09-10）同族确定化

**要解决的问题**：「还有类似的问题可以一并处理吗？」此前**不可复现**——面板 💬 把候选转新会话时，消息里只有这一条（程序里唯一的"相似"是 `cat|tool|canonText` 全等的精确同文聚簇），所以"还有类似"全靠模型自己翻 inbox 归纳：可能漏、可能编。

- 新增 `src/core/similarity.cjs`（纯函数）：`skeleton()` 剥掉易变部分（IP / 端口 / 时间戳 / 行号 / 路径 / 字节数 / 会话 id / uuid）→ 字符 3-gram + 包含度相似度；`bestFamily()` 按类别相容组选阈值（**同类 0.6 / 跨类 0.8**，`git-net|timeout|model-api` 视为 net，`error` 与任意类别相容，`settings.familyThresholdSame/Cross` 可调）→ 判定**可复现、可解释、可调**。
- **L1 族合并**：族**复用既有 `state.clusters`**（同一 cid 的多个聚簇天然是一族，不新增状态字段）。采集时未命中同文聚簇但与某族相似 → **并入该族已有候选行**（累加次数 + 变体现象写进 sidecar 的「## 同族并入」段），不新开一行；该族已处置则整族压掉；族曾开行后被处置 → 仍走复发语义。`--add`（`flushDeferred`）同规则。
- **L2/L3 讨论会话拿确定依据**：新端点 `GET /whale/related?id=C###` 返回三块——`family`（族成员/变体/相似度）、`related`（其它在箱行，相似度 ≥0.35）、`entries`（可能已被条目覆盖，≥0.25 或同类别）；面板 💬 先取它并把三块写进新会话消息，末尾附固定动作「先看同族 → 判断是否同根因 → 是则合并为一条经验（occurrences 取总和）；再核对覆盖提示」；面板行显示「族×N」。
- **L4 措辞固化**：技能「讨论」流程加为**第 0 步**（面板/端点不可用时退回读 inbox + `clusters` 同 cid 判族并写明判据）；「入库」流程加同族合并口径（一条候选 = 一条经验）。
- **边界（写进技能）**：**同族 ≠ 一定同根因**。程序保证"该看哪些"确定、可复现、可解释；是否同根因由人/agent 给结论并说明依据。
- 自检：新增 `src/core/similarity.selftest.cjs`（20 断言，含「不得误并」反证）与 e2e v0.7 段（同族合并 / 族成员同 cid / sidecar 记录 / related 三块 / 不误并）。

## v0.6.3（2026-09-10）已处置签名去重

**要解决的问题**：同一个坑会因 `state.json` 被重置（或 `--rebuild` 重扫）而**反复开新候选行**——同一段日志在新状态下拿到新指纹 + 新聚簇哈希，而原候选已不在 inbox，于是被当成全新坑（本机同一行先后开出 3 个编号）。

- 不再依赖易失的 state，改为**把归档表当"已处置"事实源**：`engine.loadResolvedIndex()` 收集末列非空的归档行 → `resolvedSig(cat, text)`（类别 + 空白归一后 90 单元截断）建签名索引 → 新聚簇命中即压掉不开行（`clusters[hash] = {cid:null, silentN}`，输出报「已处置签名压掉重复候选 N 条」）；`flushDeferred`（`--add`）同规则。
- 两个坑：① 归档行历史上有两种渲染形态（早期 6 列无处置列／批量清理后追加列且**行内残留半角 `|`**）→ 放弃按列数解析，改 `parseArchiveRow`「前 4 列固定 + 从右端切掉时间列与处置列」；② 时间列必须切掉，否则混进现象文本会让签名永远对不上。
- 在箱聚簇由 `pruneResolvedIndex` 从索引剔除，保留既有**复发**语义。新增 `src/collector/engine.dedup.selftest.cjs`（19 断言，含端到端复现「重置后重扫」与反证）。

## v0.6.2（2026-09-10）回声签名扩充 + 类别正则收紧

真实「从零重扫三轮」迭代而来：

- ① 回声签名扩充——简报技能自身的扫描输出（`### WORKSPACE:`/`filesWritten:`/`recentFiles:`/`real user msgs:`/`sessions: N`/`workspaces: N`/`asst: N`）、DSH 源码与 profile 摘录（行号前缀 `361: …`、YAML `- id: …`、`disabled: true`）、zstd 十六进制转储、含候选编号的自查输出（`C030 | model-api | …`）全部识别为回声；用户叙述侧补 `生成经验|经验库|避坑|运行记录` 框架词（元讨论不算运行坑）。
- ② 类别正则收紧——`model-api` 原 `/429|insufficient|balance/` 会把「文件名清单里的字节数 429」「insufficient permissions」误判为模型 API 错，现改为限流/配额语境；权限类文本归口 `sandbox-file`，而 ssh 的 `Permission denied (publickey)`、`Host key verification failed` 归口 `git-net`。
- 效果：真实历史从零重扫的候选 **36 → 26**，且无类别误判。

## v0.6.1（2026-09-10）`--rebuild`

`--rebuild` 清派生状态（指纹/聚簇/水位线）后从头梳理全部历史，可配 `--add` 一条命令扫完入箱。

## v0.6.0（2026-09-10）拉取式采集

- `settings.autoAdd=false` 时，`--check` 照常增量扫描并推进水位线/指纹（~8ms、0 token），但新发现**不写 `inbox.md`**，而是合并进 `state.json` 的 `deferred` 摘要（`{cat,text,n,first,last,ws[],refs[],excerpt}`，上限 `maxDeferred`）。
- 用户主动说「小本本复盘 / 待审核箱」时才 `mine.cjs --add` 把暂存冲入待审箱（重建候选行 + `details/C###.md`，曾处置过的标「复发（原 C0xx）」）。**已在箱候选不受影响**：命中共聚簇仍只累加次数。
- **提醒句随开关二选一**（`inject/agents.cjs`：注入文本必须与实际行为一致）——拉取式下只报一行「新发现 N 组已暂存（未入箱）」，不展开清单、不询问审核，比自动模式更省 token。
- 面板：`GET /whale/inbox` 附带 `deferred` 组数，仅有暂存时入口不隐藏；实时采集（`liveCapture`）同样遵守 `autoAdd`。

## v0.5.1（2026-09-10）自引用 / 探针回声过滤

- **要解决的问题**：`SELF_REF`/`ENC_DIAG_RE` 原先只作用于成功结果，`error` 类绕过 → 「维修采集器自身」的失败与探针输出全部进箱。
- 新增 `scanner.isMetaEcho()` 两级签名（STRONG 单条命中即判；WEAK 需 ≥2 条同时命中，避免误伤真实故障文本），命中者标 `meta=true` 后由 engine **落档 `archive/echo-<日期>.md` 再排除**（不静默丢弃），输出报「自引用回声过滤 N 组/M 条」，`GET /whale/live` 同步计数。
- 效果：同一份真实历史新候选 **26 → 2**（留下的是真的沙箱拒绝坑）。

## v0.5.0（2026-09-10）增量采集 + 实时入库 + 聚簇索引 + CLI

- **增量采集**：`state.json` v2 记每份会话日志的水位线 `{size,mtimeMs,offset,frames,ws,calls}`——未更新只 stat 跳过，变大只读 `[offset,EOF)` 的新帧（帧边界与行边界严格对齐，无需回收半行），末尾半写帧不推进 offset 下次自动重试；水位线失效（截断/轮转）该文件退回全量。
- **实时入库**：宿主半边订阅 `session/event`，与批扫共用同一判定层与 `ingestFresh`，去抖 1.5s、串行写盘、每轮现读现写 state，**全程零模型 token**，异常不影响会话（`liveCapture:false` 可关）。
- **聚簇索引**：`clusters[hash]→cid`，同一坑跨轮次再次出现只**累加次数**；候选已处置后再出现 = **复发**，重开并标 `复发（原 C0xx）：`，`reAddCooldownDays`（默认 7 天）内只静默计数。
- **CLI**：`--check`（增量）/`--full`（全量校验）/`--dry`（只看不写）；`--stats` 改为**纯只读**（旧版会写掉 seen 指纹，等于静默吞掉这批候选）。
- **面板**：⟳ = 先 `POST /whale/scan`（增量扫描）再刷新列表；`GET /whale/live` 暴露实时采集与水位线状态。
- **待审行**：写入时 `|` 转全角 `｜`（否则该行无法被表格解析）；解析收敛到 `repo.parseInboxRows`。**提醒句**：待审 > `reminderListMax`（默认 3）只报数字 + 提示面板。
- 实测（真实历史 23.88MB / 13 会话）：冷启动全量 2233ms → 热启动 **11ms / 读取 0 字节 / 跳过 13 文件**；`--full` 复核新发现 0 条（增量无漏采）。

## v0.4.0（2026-09-09）已解决墙 + 全局/项目两级分类

- 条目 frontmatter 新增 `scope: global|project` + `projects: [项目…]`（缺省/旧条目 = global，零迁移；判定为语义判断，入库时 AI 建议 + 用户确认）。
- **B1**：AGENTS 自动段只收 `scope=global`（项目级永不注入全局，状态行注明去向）。
- 已解决墙 = 轻口径（入库即已处理）：**A1** 文档墙 `INDEX.md`（全局区/项目区 × 类别 + 停用收尾，`mine.cjs --wall` 预览）与 **A2** 面板「已解决」卡同源（`GET /whale/solved`、`GET /whale/entry?id=E###`）。
- 裁定：①轻口径 ②A1+A2 一期都做 ③先 B1 后 B2（B2 项目级注入 = 三期逐项目试点）。

## v0.3.0（2026-09-09）决策箱面板增强

- 现象行 = 规则精炼一句话（堆栈/`Error:` 清洗，≤90 字）；候选详情存 `details/C###.md`（源会话引用 + 打码摘录 ≤600 字，删除候选随行进 `archive/details/`）；删除按钮 = 红色 ✕（移入归档，可恢复）。
- ⚡ 自动处理内嵌判定表：只读诊断；「补全型小修」（不删除 / 不碰 DSH 结构 / 影响域封闭 / 可自验证）可自动执行，先预告再动手；禁区一律禁止，回复固定行 `[WHALE-RISK]`——面板轮询会话消息识别该标记后弹红色警示条并支持「转人工讨论」。

## v2.1（2026-09-09）决策箱面板真实挂载

- host half（`lib/index.js` 注册 `/whale/*`）+ browser half（`lib/client.js`，`__ModuleLoader__` 零依赖 bundle，GUI 右缘悬浮件）。
- 部署/回退一律走 `plugin/scripts/deploy-web.cjs`（幂等，dry / apply / check / undo）；**宿主半边改动需重启 dsh web**，仅 `lib/client.js` 改动刷新页面即可。

## v2.0（2026-09-09）插件化模块重构

六模块（core / store / collector / inject / review / ui）+ 单向依赖；纯结构重构，零挂载风险，v1 行为与数据不变式兼容。

## v2.0.x / lifecycle v0.1.0 → v0.1.1（2026-09-10）生命周期工具

- 三段足迹：**I 集成**（AGENTS 标记区 + skill）/ **D 数据**（`~/.dsh/whale-notebook/`，用户记忆）/ **R 运行时**（web 面板部署副本 + 加载器挂载行）。
- 命令：`status` / `check` / `install` / `uninstall detach|remove|purge`，全部两段式（默认干跑 → 确认 → `--apply`），幂等可续，删除前字节级快照。
- **v0.1.1（2026-09-10）**：R 段从"零动作 + deferred"改为**如实登记与对账**——登记真实部署位（`profiles/web/node_modules/…` + `profiles/web/cordis.patch.yml` 标记区，`managedBy: scripts/deploy-web.cjs`），写入/删除交唯一写入者 `deploy-web.cjs`；`detach` 现在会驱动 `deploy-web --undo`（加 `--yes` 连副本目录一起删）；新增清单版本迁移（旧条目自动丢弃、新条目自动补登记，`check` 以「待迁移」提示）；R 段对账为信息级，不左右 `check` 退出码。沙盒自测 **104 PASS**（含反证：R 段测试全程不碰真实部署）。

## v1（2026-09-09）机制奠基

skill + scripts 落地：AGENTS 标记注入链路打通，采集/打码/指纹/审核流程成型（详见 `docs/2026_09_09_15_whale-notebook自我进化机制实施记录.md`）。

---

## 自检基线（随版本滚动）

| 套件 | 断言数 |
|---|---|
| `plugin/lifecycle/selftest.cjs` | 104 |
| `plugin/src/ui/server.selftest.cjs` | 45 |
| `plugin/src/core/privacy.selftest.cjs` | 10 |
| `plugin/src/core/summarize.selftest.cjs` | 10 |
| `plugin/src/core/similarity.selftest.cjs` | 20 |
| `plugin/src/collector/engine.selftest.cjs` | 10 |
| `plugin/src/collector/engine.dedup.selftest.cjs` | 19 |
| `plugin/src/collector/e2e.selftest.cjs` | 60 |
| `plugin/src/collector/live.selftest.cjs` | 28 |
| **合计** | **306**（+ `scripts/bundle-smoke.cjs` 结构断言 + `scripts/redact.test.cjs` 13 断言） |

最近一次全绿：**2026-09-10**。
