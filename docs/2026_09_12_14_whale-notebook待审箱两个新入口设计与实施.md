# whale-notebook 待审箱两个新入口：设计与实施（v0.7.8）

> 版本：插件 `0.7.8`（2026-09-12）｜ 生命周期工具 `0.2.0`（本版未改动）
> 上游文档：`2026_09_09_18_whale-notebook决策箱面板设计.md`（面板基础）、`2026_09_10_10_..._v0.5开发实施计划.md`（拉取式/重建）、`2026_09_11_14_whale-notebook五项遗留问题解决方案.md`（异步扫描/维护窗口）
> 完整沿革与实测数字见仓库根 `CHANGELOG.md` 的 v0.7.8 段；本文只记"需求如何落到已有功能上"。

---

## 1. 需求原文与梳理

> 「我想在待审箱的页面上，增加两个按钮，一个是开关：开启关闭自动收集待审核条目。另一个功能是，自动开启新的 Session，并且扫描历史记录，抓取历史所有的错误，总结后放到待审箱里。」

拆成两件事：

| # | 需求 | 用户真正要的 | 落点 |
|---|---|---|---|
| ① | 开关：开/关自动收集待审核条目 | 决定"新发现要不要自己进待审箱"，并且**要看得见当前是哪种模式** | `settings.autoAdd`（v0.6 就有的拉取式开关），此前只能手改 JSON |
| ② | 开新 Session → 扫历史 → 抓所有历史错误 → 总结 → 放待审箱 | 一键把**全部历史**里的坑翻出来进待审箱，并让模型给一份"总结/该合并哪些/该怎么入库" | 已有 `mine.cjs --rebuild --add`（全量重扫直接入箱）+ 已有 💬 的"开新会话并投递开局消息"通路 |

**结论：两件事都不需要新引擎。** ①是把已有开关搬到面板上；②是把两个已有模式按顺序调一次（外加一个上限参数），再开一个会话让模型做它擅长的部分（归纳与建议），确定性部分（扫描/去重/入箱）仍由本地零 token 的引擎完成。

---

## 2. 决策与被否决项

| # | 决策 | 理由 |
|---|---|---|
| D1 | 开关 = `settings.autoAdd`（不是 `autoCollect`） | "自动收集待审核条目"＝"新发现要不要进待审箱"；`autoAdd=true` 直接入箱、`false` 只进 `state.deferred` 暂存。`autoCollect`/`liveCapture` 是采集总开关与实时采集开关，做成按钮会让面板变成控制台 |
| D2 | 生效值 = `settings.autoAdd !== false`（缺键＝开启） | 与引擎判定口径**逐字一致**（`engine` 里写的是 `settings.autoAdd === false`），避免出现"面板说关闭、引擎却在入箱" |
| D3 | **面板开关不写 AGENTS.md**；改为把提醒句一次性改成"以命令输出为准"的双模式自述 | 见 §3；被否决的备选是"点一次开关就改写 AGENTS 自动段" |
| D4 | 深掘用 `--rebuild --add`，不用 `--full` | `--full` 保留指纹 → 当前暂存的历史发现"已见"被跳过 → 进不了箱；只有重建才是"历史全抓一遍" |
| D5 | 深掘前先跑一次 `--add` | `--rebuild` 会清空 `state.deferred`；不先冲一遍，"日志已轮转/已删除"的老发现就永久丢失 |
| D6 | 单轮开行上限 30 → **500** | 重建时"超上限被丢弃"会同时记下指纹＝永久抓不到，与"抓取所有历史错误"直接冲突；真超了 `dropped` 显式回报 |
| D7 | 深掘**忽略** `autoCollect/liveCapture` 门禁 | 它是用户显式触发的动作，静默不干活是最糟的失败模式；但它必须拿写锁，与 CLI/实时采集互斥 |
| D8 | 深掘完成后**自动开新会话**做总结；落点固定「鲸鱼全局」 | 用户明确要求"自动开启新的 Session"；深掘天生跨全部工作区，与既有"跨项目候选 → 鲸鱼全局"同源。**无新发现且待审为空则不开**（不白烧 token） |
| D9 | 面板加"记忆"（pin）：主动开过面板后，待审为 0 也保留侧边入口 | 否则"待审=0 且要切换的模式正是自动入箱"时整块面板消失 —— 那正是最需要开关的时候 |
| D10 | 深掘提供 `{dry:true}` 只读预演 | 让验收与自测能跑完整链路而**不动用户数据**；也方便将来做"先看看会抓出什么" |

---

## 3. 为什么开关不写 AGENTS.md（D3 展开）

`~/.dsh/AGENTS.md` 的自动段里有一句"自动采集提醒"，它直接决定**每个新会话**里 agent 的采集纪律（新发现要不要报清单、要不要先跑 `--add`）。v0.6 的设计是"这句随 `autoAdd` 二选一"，于是开关一变，注入文本就可能与实际行为矛盾。

两条路：

- **备选 A（被否决）**：面板切换时顺手用 `inject/agents.cjs → applyToText` 重写自动段。问题：① 每次点击都动用户的全局记忆文件；② 会与 agent 的入库编辑抢写同一个文件；③ 每次切换都把 lifecycle 的标记区基线打成「待登记」，让漂移信号变钝（v0.7.7 刚把它调干净）。
- **采纳 B**：把提醒句**一次性**改成"**本轮是自动入箱还是仅暂存，以 `--check` 的命令输出为准**（`settings.autoAdd`，面板开关可切）"，然后分别写明两种输出对应的纪律（输出含「新发现暂存 N 组」＝仅暂存；输出含「新发现 N 条」＝自动入箱）。这样：注入文本**永远不撒谎**（命令输出本身就是事实），而开关切换**一个字节都不碰 AGENTS.md**，也不再需要为它跑 `--adopt`。

代价：提醒句长了一点（长了约 1/3，仍是单行）。换来的是"面板可以随意切换、记忆文件不动"。

---

## 4. 接口契约

```http
GET /whale/settings
→ 200 { "ok":true, "autoAdd":false, "autoCollect":true, "liveCapture":true,
        "scanMode":"incremental", "writable":["autoAdd"] }
→ 500 { "ok":false, "error":"settings.json 内容损坏（…）；未做任何写入，请先修好再试" }

POST /whale/settings      body {"autoAdd": true}
→ 200 { "ok":true, "autoAdd":true, "changed":true, "pending":2, "deferred":7 }
→ 400 { "ok":false, "error":"body 需含布尔 { autoAdd: true | false }" }      # 非布尔
→ 400 { "ok":false, "error":"本版只开放 autoAdd（收到未知键: scanMode）" }    # 白名单外
→ 500 { "ok":false, "error":"settings.json 内容损坏（…）" }                   # 损坏 → 一个字节都不写

POST /whale/sweep         body {}            # {"dry":true} = 只读预演（零写盘、不开维护窗口）
→ 200 { "ok":true, "dry":false,
        "flush":{ "added":7, "bumped":0, "suppressed":0, "dropped":0, "remaining":0 },   # 阶段①
        "added":3, "bumped":5, "suppressed":2, "dropped":0,                              # 阶段②
        "echo":4, "echoEvents":12, "echoDupSkipped":0,
        "pending":12, "deferredTotal":0, "ms":11487, "wallMs":12100,
        "scan":{ "files":32, "scanned":32, "skipped":0, "readBytes":54815000, "ms":11400, … },
        "text":"rebuild：…" }
→ 409 { "ok":false, "error":"扫描/深掘进行中，请稍后重试" }        # 与 POST /whale/scan 共用互斥位
→ 500 { "ok":false, "error":"写入锁不可用（…）", "flush":… }       # 锁被 CLI 占着等

GET /whale/live  （既有端点，新增一层）
→ settings:{ "ok":true, "autoAdd":false, "autoCollect":true, "liveCapture":true, "scanMode":"incremental" }
   scanJob:{ "running":true, "kind":"sweep", "dry":false, "phase":"rebuild", "scanned":12, "files":32, … }
```

既有端点**形状零变化**（面板 ⟳ 的调用方无需改动）。

---

## 5. 交互设计

| 控件 | 位置 | 行为 |
|---|---|---|
| `⛏` | 待审箱页头（✅ 与 ⟳ 之间） | 点击 → `POST /whale/sweep`；运行中置灰 + 转 `⛏…`；页脚状态行显示「⛏ 深掘中（全量重扫）：已扫 12/32 个日志｜3.4MB…」（每 1.2s 轮询 `/whale/live`，页面隐藏时不打扰宿主，上限 ≈3 分钟） |
| `自动收集 [自动入箱｜仅暂存]` | 页脚（讨论落点下方） | 点击 → `POST /whale/settings`；状态**取自服务端** `GET /whale/settings`（不是 localStorage）；读失败时两态都不高亮并 toast，不假装成功 |
| 状态行 | 页脚第三行 | 默认「候选来自 inbox.md｜⛏ = 全量重扫历史入箱」→ 深掘中显示进度 → 完成后留 20s 显示「⛏ 新开 3｜累加 5｜压掉 2｜回声过滤 4 组｜52.28MB｜11.5s」 |
| 结果 toast | 右下 | 开关：「自动收集已开启：新发现直接进待审箱（立即生效，无需重启）」；深掘：「⛏ 新开 N｜累加 M｜…（待审箱现有 P 条）」＋「已开总结会话 → 鲸鱼全局」 |

无二次确认弹窗（与 💬 一致）：深掘结果全部落在待审箱里、每条可 ✕（移入归档、可恢复），会话本身可关。

**深掘开局消息**（`sweepMessage()`，由宿主落盘的事实拼成，不靠模型回忆）：扫描统计（文件数/体积/耗时）＋入箱/累加/压掉/回声四个数字＋暂存冲入数＋待审总数＋落点与依据＋候选清单（≤20 条，其余只报数量）＋固定动作（按技能 §1 复盘流程：总览 → 编号清单 → 同族合并建议 → 拆分边界 → 拟 scope）＋**只读约束**（不写 entries/INDEX/AGENTS/inbox，等用户逐条确认）＋"不要重复跑 `--rebuild`"。

---

## 6. 边界与失败模式

| 场景 | 行为 |
|---|---|
| `settings.json` 损坏或不可读 | 严格读报错 → 400/500，**一个字节都不写**（`readSettings()` 会静默返回 `{}`，直接读-改-写会吃掉用户的其它开关 → 为此新增 `readSettingsStrict`）；面板提示读取失败，两个态都不高亮 |
| 缺 `autoAdd` 键 + 用户点「自动入箱」 | 生效值已是 `true` → `changed:false`，不写盘、不创建文件，toast 说明"已是该模式" |
| 深掘时已有扫描在跑 | 进程内 `scanning` 互斥 → 409；跨进程由写锁兜底 → 引擎返回「写入锁不可用」原样报出 |
| 环境缺 zstd / sessions 根缺失 / 数据目录缺失 | 引擎前置失败 → 500 原样报，不假装成功（沿用 v0.7.5 契约） |
| 深掘期间实时采集在写 | `--rebuild` 自动开**维护窗口**（v0.7.7）：实时采集让路但事件留在缓冲、一条不丢；窗口 `finally` 无条件关闭，强杀靠 TTL 自愈 |
| 历史坑数超过单轮上限 | `dropped>0` 在返回体、页脚状态行、会话开局消息**三处显式暴露**（面板深掘用 500，实测语料远低于此） |
| 无 `sessions` 服务（面板降级） | 开关照常可用；深掘照常执行并入箱，仅跳过开会话，toast 说明 |
| 「鲸鱼全局」工作区建不出来 | 回退当前工作区，落点与依据写进开局消息并在 toast 说明 |
| 连点 ⛏ | 客户端置灰 + 服务端 409 双保险 |
| 深掘中关页面/插件卸载 | 取消位触发 → 扫描在让出点退出、释放写锁、关闭维护窗口；无 `.lock`/`.maintenance.json` 残留 |

---

## 7. 实现清单（文件级）

| 文件 | 改动 |
|---|---|
| `plugin/src/store/repo.cjs` | 新增 `readSettingsStrict()`（ENOENT→`{}`；损坏→抛错且不改名不覆盖）、`writeSettings()`（原子写，**按人读样式** 2 空格缩进 + 结尾换行写回——settings.json 是用户会手编的配置文件，不该用 state.json 那套 1 空格机器样式）；导出 |
| `plugin/src/ui/server.cjs` | 新增 `SETTINGS_WRITABLE` / `effectiveAutoAdd` / `settingsPayload` / `updateAutoAdd`（严格读 + 原子写 + 白名单 + 返回 `code` 区分 400/500） |
| `plugin/src/collector/engine.cjs` | `opts.maxNewRows` 从 `runScanTail` 透传到 `ingestFresh`，并在 `--add` 分支透传给 `flushDeferred`（**不传＝仍 30，既有调用零行为变化**） |
| `plugin/lib/index.js` | v0.7.8；注册 `GET/POST /whale/settings`、`POST /whale/sweep`（两阶段 + 共用互斥位 + `scanJob.kind/phase` + `dry`）；`/whale/live` 增 `settings`；注册日志行补齐 `/whale/related`（自 v0.7 起漏登记） |
| `plugin/lib/client.js` | `SETTINGS_MODES`/`PIN_KEY`/轮询常量；`apiLive`/`apiSettings`/`apiSetAutoAdd`/`apiSweep`；`⛏` 按钮；页脚开关 + 动态状态行；`doSweep`/`startSweepPoll`/`openSweepSession`/`sweepMessage`/`sweepSummaryText`；`applyState` 纳入 pin；`__internals` 暴露新纯函数 |
| `plugin/src/inject/agents.cjs` | 提醒句改双模式自述（D3） |
| 测试 | `server.selftest` +19、`engine.selftest` +3、新增 `collector/sweep.selftest.cjs`（20）、新增 `scripts/panel-actions.selftest.cjs`（30）、`bundle-smoke` 增结构断言 |

**数据口径**：`settings.json` / `state.json` **零新增字段、零迁移**；新增端点不改变任何既有端点形状。

---

## 8. 测试与实测记录

**(1) 全量自检**：11 套件 **486 PASS / 0 FAIL** ＋ `bundle-smoke` 结构断言 ＋ `redact.test` 22 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28 ＋ `panel-actions.selftest` 30 ＝ 16 个测试文件 PASS 累计 **609**。

**(2) 深掘语义端到端**（`sweep.selftest.cjs`，独立临时 home，10 条互不相同的失败 + 1 条重复）：
- 拉取式下 `--check` 只暂存（箱子为空）→ **dry 预演零写盘**（state/inbox/settings 逐字节不变、不写 sidecar、不开维护窗口、不留写锁）；
- 阶段① `--add`：暂存全部入箱、暂存清空、每条都有 sidecar；
- 阶段② `--rebuild --add`：**`added=0`、`bumped ≥10`**（同现象被认领而非新开行）、箱子行数不变、`cat|text` 无重复、水位线重建到位；
- 再跑一次：**幂等**（`added=0`、行数不变、无重复）；
- 删掉一条候选（入归档）后重建：**`suppressed ≥1`、不复活**；
- 上限实验：`maxNewRows:2` 时只开 2 行、**丢弃 3 条**；放大到 500 后**被丢的全部补回且 `dropped=0`** —— 这正是把上限从 30 提到 500 的实测依据；
- 收尾：无写锁、无维护窗口、无 `.tmp`、`settings.json` 未被深掘改写。

**(3) 夹具教训（值得记住）**：第一版夹具用「同一句话只改一个数字」做了 10 个"不同的坑"，结果 `--add` 只开出 **1 行** —— 因为那在引擎里是**同一族**（v0.7 语义：并入已有候选行）。夹具因此改成 10 条结构上互不相同的真实错误形态。"同一句话不同数字 = 同一个坑"是这套系统**有意**的行为，不是 bug。

**(4) 开关写路径**（`server.selftest`）：切开关时**逐键保留**用户其它设置（哨兵 `scanMode/maxDeferred/denylistWorkspaces` 均未丢）、**AGENTS.md 逐字节不变**、原子写不留 `.tmp`、写回保持**人读样式**（2 空格 + 结尾换行）、同值再点 `changed:false` 且不创建文件、参数非法一个字节都不写、损坏文件保持原样且未改名。

**(5) 重启后实测（curl，2026-09-12）**：
- 版本与端点：`GET /whale/live` → `version=0.7.8` 且新增 `settings`；`GET /whale/settings` → `{ok, autoAdd:false, writable:["autoAdd"]}`。
- 开关往返：`POST {autoAdd:true}` → `changed:true` 且落盘；**`AGENTS.md` 哈希前后完全一致**；切回后语义逐键复原。反证：非布尔 → 400、白名单外键（`scanMode`）→ 400，且文件未被改动。
- 端点闸门：伪造 Host → **403**、跨站 Origin → **403**、写操作 `text/plain` → **415**、并发深掘第二个 → **409**。
- `POST /whale/sweep {"dry":true}`（真实语料 32 文件 / 52.28MB）：`ok/dry` 正确、`scanJob` 可见（`kind=sweep` + `phase`）、**期间 `/whale/live` 最大往返 <200ms**、**零写盘**（state.json/inbox.md 逐字节不变、details 无新增）、不开维护窗口、无 `.lock`/`.tmp` 残留。
- **发现并当场修掉的一处副作用**：第一次切换把用户手写的 **2 空格** `settings.json` 重排成 1 空格（`writeSettings` 起初复用了 `writeJson` 的机器样式）。键值未丢，但"点一下开关就改排版"没必要 → 改为 2 空格 + 结尾换行写回并加断言；现场文件已按原样式复原（13 键、语义逐键一致）。该修复随下一次重启生效。

---

## 9. 发布与验收步骤

1. 改权威源 `~/.dsh/whale-notebook/plugin/**` → 全量自检；
2. `deploy-web.cjs --apply` → `--check`（逐字节对账 exit 0）；
3. AGENTS 自动段按新口径重渲染（`mine.cjs --render-rules` 预览 → edit 标记区）→ `lifecycle check --adopt`；
4. **重启 `dsh web`**（宿主半边生效前提；由用户执行）；
5. curl 验收：开关往返（含 AGENTS.md 哈希不变）、`POST /whale/sweep {"dry":true}` 全量预演（期间的 `/whale/live` 延迟必须 <200ms）、端点闸门（伪造 Host/跨站/非 JSON/并发 409）；
6. 用户在页面点一次两个控件（浏览器点击无法代劳）；
7. `sync-release.cjs` 镜像回仓库 + git 提交。

## 10. 回滚

- 面板两个控件出问题：删掉 `lib/client.js` 的按钮与 seg 即可（**刷新页面**生效，宿主不受影响）；
- 端点出问题：`lib/index.js` 移除三处注册（其余端点与采集链路不受影响）；
- 数据面无需回滚（`settings.json`/`state.json` 无结构变化）；
- 全量回退：`git revert` + `deploy-web --apply` + 重启 `dsh web`。
