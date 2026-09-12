# whale-notebook 五项遗留问题解决方案（P1/P2 批次设计）

- 日期：2026-09-11
- 作者：DSH 会话（whale-notebook 维护方）
- 版本：v1.0（方案设计稿；对应插件当前版本 v0.7.5）
- 范围：① echo 归档自我放大 ② `/whale/scan` 异步化 ③ `--rebuild` 期间暂停实时采集 ④ 漂移守卫噪音 ⑤ live 与批扫双计（先测量）

> 本文只做"方案梳理"，不含代码改动。所有现象数字均为 2026-09-11 本机实测（命令与原始输出见附录 A）。

---

## 1. 结论摘要（先行）

| # | 项 | 实测结论 | 优先级 | 推荐方案（一句话） | 需要你决定的事 |
|---|---|---|---|---|---|
| 1 | echo 归档自我放大 | **确认在发生且已污染记忆池**：echo 归档 231 行 / 仅 77 个不同现象（55 个现象有多行、单个现象最多 8 行）；当前 18 条暂存里 **13 条是自引用/探针输出（72%）** | **P1（本批最优先）** | 三重堵漏：回声改"签名去重 + 幂等追加"、扩强特征签名、"打印我们自己的文件"整类按出处拦截 | 是否顺带清理已污染的 13 条暂存（提供干跑命令） |
| 2 | `/whale/scan` 异步化 | 确认存在：扫描在宿主事件循环里同步跑，全量 ≈5s 期间宿主与面板全部排队 | P1 | **分片让出事件循环**（HTTP 契约与面板零改动） | 是否需要"真·后台任务 + 进度条"（阶段二，需改客户端 bundle） |
| 3 | `--rebuild` 暂停实时采集 | 写锁已挡住互相覆盖，但重建期间 live 仍在对同一批文件写入，且外部看不出"正在重建" | P1 | **维护窗口标记**（state 内 maintenance + TTL），live 见到就让路并保留事件 | 无（TTL 兜底，无需人工） |
| 4 | 漂移守卫噪音 | 确认：`lifecycle check` 恒 exit 1（AGENTS.md 与 skill 各报一条"漂移"）。**附带发现一个真实隐患**：AGENTS 条目登记为 `whole` 模式，而现在该文件已有你的"手动段"，`uninstall remove/purge` 会整文件删除、连你写的内容一起带走 | P2（隐患部分建议提前） | ① 注册模式改 `zones`（保护手动段）② 判定改为"派生式/结构式" ③ 合法写入自动重登记 | 是否同意改注册模式（一次性命令） |
| 5 | live 与批扫双计 | **实测未发生**：同一事件由 live 入暂存后，批扫再扫同一记录得到 `n` 仍为 1、指纹数不变；25/25 指纹 sid 与磁盘会话目录名完全一致 | P1（原本假设需修） | **不修**；改为加"不变量测试 + 计数器"把结论钉住，并列出唯一残留风险点（tool 名退化成 `?`） | 无 |

一句话总结：**五项里只有第 5 项实测是"虚惊"，其余四项都要动，其中第 1 项已经真实拉低记忆质量（72% 噪声），建议最先做。**

---

## 2. 共同背景与硬约束

任何一项的改动都必须落在既有铁律之内，否则修一个坏两个：

1. **三平面归属**：宿主平面（`profiles/web/cordis.patch.yml` 挂载行 + `plugin/lib/index.js`）、会话平面（`~/.dsh/AGENTS.md` 自动段 + `~/.dsh/skills/whale-notebook.md`）、UI 平面（`plugin/lib/client.js`）。宿主半边改动**必须先 `deploy-web.cjs --apply` 再重启 `dsh web`**；只改 `client.js` 刷新页面即可；`mine.cjs` 批扫立即生效。
2. **单写者与互斥**：数据目录所有写路径共用一把写锁（`state.lock`，`wx` 原子创建 + 陈旧回收），且 `state.json` 走 CAS 合并（`mergeStates`）。新增任何写路径都必须走 `repo`，不得绕过。
3. **纯函数出计划、工具落盘**：采集链路（decoder → scanner → engine → repo）里前两层纯函数、无副作用，便于单测；新逻辑不要破坏这个分层。
4. **退出码契约**：0 成功 / 2 前置缺失 / 1 失败。CLI 语义不得因本次改动而变。
5. **隐私唯一出口**：一切进入落盘文本的内容必须过 `core/privacy.cjs`（打码）；本次新增可观测字段（如"卡住的文件"）只允许写 sid/文件名，不写个人目录。
6. **测试基线**：当前 10 套件 386 断言全绿（13 个测试文件 PASS 累计 457）。任何一项落地后此基线只能升不能降；e2e 里已有的"回声过滤"断言（`echo >= 3`、`echoEvents === 3`、`archive/echo-*.md` 文件名匹配）会因第 1 项改造而变，需同步更新。
7. **数据不变式**：`inbox.md` 行格式、打码算法、指纹算法、`details/C###.md` 内容协议均为 v1 不变式，本次不新增破坏性格式变更（第 4 项只动 `.lifecycle/manifest.json` 的登记字段，不动 AGENTS/skill 的内容协议）。

---

## 3. 分项方案

### 3.1 echo 归档自我放大

#### 3.1.1 现象与证据

| 证据 | 数字 |
|---|---|
| `archive/echo-20260910.md` | 218 行（30,138 字节） |
| `archive/echo-20260911.md` | 13 行（1,793 字节） |
| 合计行 / 不同现象 | **231 行 / 77 个** |
| 同一现象出现多行 | **55 个现象（71%）有多行；单个现象最多 8 行** |
| 现象本身就是"我们自己的渲染行" | 20 行（如 `--- echo tail --- \| 2026-09-10 12:21 \| error \| 2 \| …`） |
| 当前 18 条暂存中的自引用/探针输出 | **13 条（72%）**：`HTTP 200 {"ok":true,…"candidate"…}`、`lines=2946 chars=129046 …`、`encoding-probe: …`、`exists=True lines=163 …`、`=== listEntries ===`、`topKeys=ok,stats,…`、`panel_ids = …`、`logged97 statNow ok=0 …`、`== clusters sample (2614-2660) == "clusters": {…}`、`=== lifecycle/selftest.cjs ===`、`archive-20260909.md rows 1 parsed 1 …`、`C001 parts=7 […]`、`v 2 lastScan … files 30 clusters 59 …` |
| 已进过候选流（clusters 里带 cid） | C092 `--- echo tail --- \| …`（n=4）、C130 `STATUS 200 {"ok":true,"version":"0.7.2",…}`、C135 `legacy cells=8 \| textClean=false …` |

#### 3.1.2 根因（三层，缺一层就还会长）

1. **回声行按"聚簇哈希"聚合，而聚簇键用的是完整文本**：`ingestFresh` 里回声分组用 `it.hash = hash36(clusterKey(ev))`，`clusterKey` = `cat|tool|canonText(整段文本)`。同一份 echo 内容被打印第二次时，尾部（打印出来的表行本身、行号、上下文）与第一次不同 → 哈希不同 → **新开一行**而不是累加 `n`。这就是"打印一次 echo 文件就多一行"。
2. **落档不做幂等**：`repo.appendEchoArchive` 只做 append，从不检查当日文件里是否已有同一现象签名；历史行永不合并、永不裁剪。
3. **签名表覆盖不到"我们自己的产物"**：现有三道过滤（`SELF_REF` / `ENC_DIAG_RE` / `META_STRONG|META_DUMP|META_WEAK`）刻意只认"采集器源码名/探针标记/渲染痕迹"，但实测漏掉了大批量形态：
   - 我们 API 的 JSON 信封：`{"ok":true,"id":"C122","candidate":{…}}`（弱特征 `"ok":true,"pending"` 差一个键就漏）
   - `state.json` 自身的字段名（`"reAddedAt"`、`"familyScore"`、`"clusters"`…）
   - 一次性探针的中文/英文抬头（`topKeys=`、`parts=7 [`、`rows 1 parsed 1`、`== clusters sample`）
   - 自检输出（`=== lifecycle/selftest.cjs ===`、`top occurrences`）
   上层"工具结果判定"只在**命令类工具**的成功结果里扫描特征词，`error` 类事件直接绕过——探针一旦以非零退出码结束（很常见），就整条漏网。

#### 3.1.3 方案（推荐 A1+A2+A3 一起做，A4 收尾）

**A1 回声不再增生（治"长"）**
- `engine.ingestFresh` 里回声分组的键，从聚簇哈希改为**回声签名**：`echoSig = cat + '|' + oneLiner(redactLines(text), 90)`（与该文件已有列口径一致，签名算法复用 `resolvedSig` 的截断口径）。
- 落档前先读当日 echo 文件已存在的签名集合（沿用 `loadResolvedCached` 的"目录 name/size/mtime 缓存"套路，新增 `echoCache`），**只追加文件里没有的签名行**，已存在则跳过（`skippedDup` 计数）。
- 结果：同一现象无论打印多少次，都只占一行（`n` 照常累加在内存统计里，落档行不重复）。

**A2 扩大强特征签名（治"漏"）**
在 `scanner.cjs` 增加一组"我们独有"的强特征（单条命中即判回声），刻意只选**不可能出现在真实故障文本里**的串：
- state 字段名：`"seenFingerprints"`、`"nextCandidateId"`、`"reAddedAt"`、`"familyScore"`、`"lastScanStats"`、`"deferred"`+`"refs"`
- 我们 API 信封：`"ok":true` 与（`"candidate"` | `"entries"` | `"deferredTotal"` | `"pending"`）**同时**出现
- 探针抬头：`encoding-probe|topKeys=|panel_ids|rawHead=|exists=True lines=|logged\d+ statNow|=== listEntries|parts=\d+ \[|== clusters sample|rows \d+ parsed|archive-\d{8}\.md rows`
- 表格渲染残留（补 META_DUMP）：`--- echo tail ---`、表头 `| 时间 | 类别 | 次数 | 工作区 |`
- 验收原则不变：**宁可漏滤不可误伤**；每条新特征都要配一条"真实故障反证"（用当前 clusters 里的真样本 `wzr1vg`/`1c2f2xw`/`zahbbc`/`1ndrizy`/`1paw2ow` 作反证集，要求 0 误伤）。

**A3 按"出处"整类拦截（治"根"）**
- 在 `scanner.classifyRecord` 的 `tool/call` 分支里，除 `callId → tool` 外再记 `callId → 命令首行（≤160 字符）`（`callCmd`，与 `callName` 同一张表、同一 `boundCalls` 裁剪策略，512 上限）。
- 判定规则：**命令首行命中我们的资产**（`whale-notebook|mine\.cjs|INDEX\.md|state\.json|details[\\/]|archive[\\/]|whale/(live|inbox|solved|scan)`）**且**结果文本含渲染痕迹（表行 / `{`-`}` JSON 信封 / 上述字段名）→ 判 `meta=true`。
- 为什么要求"同时满足两条"：只按命令判会误伤"跑插件自检时发现的真实 bug"（历史上真发现过 `ERR_OUT_OF_RANGE` 这类真问题）；只按文本判就是现状（漏）。两条同时满足才是"打印我们的产物"这一整类。
- 这条同时覆盖**未来新增的任何自引用形态**——不用每出现一种探针就往签名表里补一条。

**A4 卫生与可观测**
- 当日 echo 文件加行数上限（如 400 行）+ 超限时轮转为 `echo-YYYYMMDD-2.md`，避免单文件无限增长。
- `/whale/live` 增 `echo: { today, total, dupSkipped }`，面板/排障一眼可见"回声在不在长"。

**可选：数据修复**（需你点头）
- 新增 `mine.cjs --forget-echo [--dry|--apply]`：按 A2/A3 的判定对**现有暂存**做一次干跑清单（预计命中 13 条），确认后删除。默认只干跑，不自动执行。

#### 3.1.4 落点

| 文件 | 改动 |
|---|---|
| `plugin/src/collector/scanner.cjs` | 新增强特征组、`callCmd` 映射与 A3 双条件判定；`classifyToolResult` 对 `isError` 结果也走新签名 |
| `plugin/src/collector/engine.cjs` | 回声分组改签名键；落档前读当日签名集合（`echoCache`）；`echoDupSkipped` 计数 |
| `plugin/src/store/repo.cjs` | `appendEchoArchive(rowsText)` → 增 `signatures` 参数或新增 `readEchoSignatures(day)`；行数上限与轮转 |
| `plugin/lib/index.js` | `/whale/live` 增 `echo` 字段 |
| `plugin/src/collector/e2e.selftest.cjs` | 回声断言改为"幂等：重复投入同一回声不会新增行"；新增 A3 双条件正反例 |
| `plugin/src/collector/live.selftest.cjs` | 新增 A2 新特征的正例与"真实故障反证"断言 |

#### 3.1.5 验收（可判定）

1. 构造"把 `archive/echo-YYYYMMDD.md` 打印两遍"的夹具：echo 文件行数**第 1 遍 +N，第 2 遍 +0**。
2. 用当前 13 条真实漏网文本逐条跑 `isMetaEcho` → 13/13 命中；5 条真实故障样本 → 0 命中。
3. `mine.cjs --check` 在"打印我们自己的文件"之后：`自引用回声过滤` 计数上升、**暂存数不增**。
4. 全量回放历史：echo 归档总行数不再随时间单调上升（同一现象只 1 行）。

---

### 3.2 `/whale/scan` 异步化

#### 3.2.1 现象与证据

- `plugin/lib/index.js` 的 `POST /whale/scan` 处理器里 `engine.runScan('--check')` 是**同步**调用；`runScan` → `runScanInner` → `scanHistory` 全程同步 IO（`fs.statSync` / `readFileSync` / `zstdDecompressSync`）。
- 实测：增量扫描 32 文件里"未更新跳过 31 + 扫 1" ≈ 23–53ms（无感）；水位线失效或全量时实测 **44.43MB / 5084ms**，这段时间宿主 Node 事件循环被独占——面板其它端点、实时采集的去抖定时器、以及 GUI 自身的请求全部排队。
- 客户端 `lib/client.js` 的 `apiScan()` 只依赖 `POST /whale/scan` 的返回 JSON（`{ok, added, bumped, pending, ms}`），不关心耗时；`scanning` 标志已提供单飞（409）语义。

#### 3.2.2 方案（推荐"分片让出"，不动客户端契约）

**阶段一（本次，推荐）**
1. `engine` 新增 `runScanAsync(mode, opts)`：与 `runScan` 同形返回；差异只有三处：
   - 前置检查（sessions 根 / 数据目录 / zstd 能力）不变，仍在加锁之前；
   - 用**异步** `repo.acquireLock(waitMs)` 拿锁（`live.flush` 已在用这条路径），拿不到就返回"锁忙"；
   - 扫描主体改为 `scanHistoryAsync`：**每 N 个文件或每读取 ≥4MB 让出一次事件循环**（`await new Promise((r) => setImmediate(r))`），其余逻辑与同步版逐行同源。
2. 同步版 `scanHistory` / `runScan` **原样保留**给 CLI（`mine.cjs` 的退出码与输出口径零变化）。
3. `/whale/scan` 改为 `await engine.runScanAsync('--check')`；`scanning` 单飞标志保留；返回体不变（面板无需改动）。
4. 可观测：`/whale/live` 增 `scanJob: { running, startedAt, files, scanned, ms } | null`；扫描结束清空。
5. 边界：**总时长上限 60s**；插件卸载/`ctx.effect` 清理时置取消位，扫描在下一个分片点退出并释放锁（绝不留 `.lock`）。

**阶段二（可选，明确不在本次）**
`202 Accepted + jobId` + `GET /whale/scan/status` + 面板进度条。成本：要改 `lib/client.js`（手工 bundle）与 `bundle-smoke.cjs` 的结构断言，并在部署时同步副本。收益只有"可见进度"，与本次要解决的"宿主被占"无关，故不做。

**为什么不选 worker/child_process**：分片已经解决"事件循环被占"这一实际问题；而 worker/子进程会引入第二个写入者与生命周期管理（谁持有锁、超时谁杀、取消怎么传），复杂度远超收益。

#### 3.2.3 落实点

| 文件 | 改动 |
|---|---|
| `plugin/src/collector/engine.cjs` | 抽出每文件处理体 → 同步/异步两个驱动（`scanHistory` / `scanHistoryAsync`）；新增 `runScanAsync` 与取消位 |
| `plugin/lib/index.js` | `/whale/scan` 改 `await runScanAsync`；新增 `scanJob` 状态；卸载时取消 |
| `plugin/src/collector/engine.selftest.cjs` | 异步版与同步版"同一夹具产出完全相同的事件与统计"断言；取消后锁被释放断言 |

#### 3.2.4 验收

1. 触发全量扫描期间（制造水位线失效或 `scanMode=full`），另发 `GET /whale/live`：**往返延迟 < 200ms**（改造前约等于扫描时长）。
2. 全量扫描完成后事件数/暂存数/指纹数与改造前**逐字段一致**（同夹具对照）。
3. 扫描中途卸载插件：无 `.lock` 残留、无 `.tmp` 残留，下一次扫描可正常取锁。
4. `mine.cjs --check` 退出码与文本口径不变（回归 10 套件）。

---

### 3.3 `--rebuild` 期间暂停实时采集

#### 3.3.1 现象与现状

- `--rebuild` 语义：清空 `state.files / clusters / deferred / seenFingerprints` 后从头梳理全部历史（全量，实测 44.43MB / ≈5s）。
- 期间宿主进程的 live 采集仍在工作：它拿不到写锁（`live.flush` 会把这批事件放回缓冲、记 `lockBusy`），但重建一结束就会立刻写入；同时**外部没有任何信号**说明"正在重建"——你或我在这个窗口里跑 `--check`、点 ⟳、看 `/whale/live`，看到的都是"半新半旧"的状态。
- 实测澄清（见 3.5）：live 与批扫的指纹**完全一致**，所以"重建后 live 再写一遍"不会双计；本项要解决的是**可见性、顺序与失败语义**，不是计数错误。

#### 3.3.2 方案：维护窗口（maintenance barrier）

1. **标记**：`runScanInner` 的 `rebuild` 分支在**清空之前**先写一次 state（只加一个字段，不动其它内容）：
   ```json
   "maintenance": { "kind": "rebuild", "pid": 12345, "startedAt": 1789…, "expiresAt": 1789… }
   ```
   `expiresAt = startedAt + 120s`（重建实测 5s，留 24 倍余量）。
2. **让路**：`live.flush` 在取锁**之前**先廉价读一次 state（`repo.readState()` 已有，无额外成本）：
   - 若 `maintenance` 存在且未过期 → 本批事件原样放回缓冲、`stats.heldByMaintenance++`、重新定时 1s 后再试；**不写盘、不丢事件**；
   - 维护期内把缓冲上限从 200 临时提到 2000（避免长时间不让路导致溢出丢弃）；仍超限才丢弃并 `log.warn` 记数。
3. **撤标**：重建在 `finally` 里清除 `maintenance` 并写回（成功、失败、异常三条路径都清）。进程被强杀时靠 `expiresAt` 自愈——live 见到过期标记视为无效并清除。
4. **可见**：`/whale/live` 暴露 `maintenance`、`live.heldByMaintenance`；`mine.cjs --rebuild` 的输出头部加一行"维护窗口已开/已关"。将来别的维护动作（归档整理、编号重排）复用同一机制。
5. **不做的**：不引入"暂停/恢复"开关文件、不要求用户在重建期间别干活——窗口很短且 live 事件不丢，代价只是最长 5s 的入库延迟。

#### 3.3.3 落点

`plugin/src/store/repo.cjs`（`normalizeState` 增 `maintenance` 字段、`mergeStates` 对它的合并策略：取"未过期且更晚"的一方）、`plugin/src/collector/engine.cjs`（rebuild 前后写/清）、`plugin/src/collector/live.cjs`（让路 + 计数）、`plugin/lib/index.js`（`/whale/live`）、`engine.selftest.cjs` / `live.selftest.cjs`（新增断言）。

#### 3.3.4 验收

1. 在 `--rebuild` 进行中触发 live 落盘：`heldByMaintenance` 增加、`state.json` 的 `clusters/deferred` 不被 live 改写；重建结束后这批事件**一条不少**地进入（或按指纹判定为已见而静默）。
2. 人为中断重建（中途 kill）：`maintenance` 在 `expiresAt` 后被 live 自动视为过期并清除，采集恢复正常，无需人工干预。
3. `mergeStates` 不因维护字段丢数据（CAS 合并回归测试保持全绿）。

---

### 3.4 漂移守卫噪音（含一个真实隐患）

#### 3.4.1 现象与证据（本机实跑）

```
[check] 差异: 漂移: ~/.dsh/AGENTS.md 登记 sha256:c1f7c… ≠ 现场 sha256:029df…
[check] 差异: 漂移: ~/.dsh/skills/whale-notebook.md 登记 sha256:d6b83… ≠ 现场 sha256:0cc30…
[check] R 段: runtime-web-pkg / runtime-web-patch … 一致（信息级）
[err] check 未通过: 失败 0 / 差异 2 / 孤儿 0
EXIT=1
```

- 两个"差异"都是**合法重写**：AGENTS 自动段每次规则入库都会被小本本流程重写；skill 文件随版本迭代被更新。登记 hash 停留在 `2026-09-10T11:46:35`（`install --apply` 那次），之后再没重登记。
- 后果：`check` 恒 exit 1 → "真漂移/真损坏"与"我只是正常更新过"无法区分，信号被稀释。
- **附带发现（比噪音重要）**：`.lifecycle/manifest.json` 里 `agents` 条目的 `agentsMode` 是 **`whole`**（备注原文："整文件归本插件所有，卸载整文件删除"）。但该文件现在包含你的**「手动段（用户自写区）」**——也就是说，今天若走 `uninstall remove` 或 `uninstall purge`，会把你手写的内容**一起删掉**。这是本次梳理里唯一一个"会造成不可逆内容损失"的隐患。

#### 3.4.2 方案（三层，L1 建议提前做）

**L1 数据修复（一次性命令，需你同意）**
`node plugin/lifecycle/cli.cjs install --apply --agents-mode zones`
- 效果：注册模式从 `whole` 改为 `zones`；从此只管理两个标记区（`whale-notebook:rules` / `whale-notebook:privacy`），区外你的内容永不触碰；`check` 也不再对 AGENTS 做整文件 hash 比对。
- 回滚：`manifest.json` 变更有快照（lifecycle 自带 backups 机制），必要时改回 `whole`。

**L2 判定改造（把"登记 hash"降级为"派生校验"）**
- **AGENTS（zones 模式）**：只校验"两个标记区都在 + 区内内容 = 登记时写下的内容"；区外改动不算漂移。缺区/区损坏 = 失败（exit 1）。
- **skill 文件**：整文件属插件，且每次合法演进都会改 → 把 hash 比对降级为**结构校验**：frontmatter 关键字段存在、必需小节标题齐全、UTF-8 可完整解析、字节数在合理区间。结构不符才 exit 1（能抓住真正的截断/乱码损坏），正常更新不再报错。
- **输出分级**：`失败`（exit 1）与`待登记（结构完好）`（信息级）分开打印，`check 通过` 的判据只看前者。

**L3 流程闭环（治本，可选但推荐）**
- 在合法写入路径（`src/inject/agents.cjs` 重写自动段、技能更新流程）写完调用 `lifecycle/manifest.cjs` 导出的轻量重登记 `touchEntryHash(home, id)`，使登记 hash 始终跟随最后一次合法写入。
- 这样 `check` 的 exit 1 就**真的**只代表"有人手改或文件损坏"。
- 依赖方向：`src → lifecycle` 单向（lifecycle 仍保持"零业务依赖、可在插件未挂载时自举"），不破坏 bootstrap 契约；`manifest.json` 低频写，用原子替换 + last-writer-wins 即可。

#### 3.4.3 验收

1. 跑一次规则入库（合法重写 AGENTS 自动段）后 `lifecycle check` **exit 0**。
2. 手工把 skill 文件截断成半个 UTF-8 字符 / 删掉必需小节 → `lifecycle check` **exit 1** 且指明原因。
3. `lifecycle uninstall remove` 干跑输出："只剥离两个标记区，区外内容保留"；你的手动段在干跑预览里可见且不被删除。
4. `lifecycle status` 与 R 段对账（`runtime-web-pkg` / `runtime-web-patch`）保持"信息级、不影响退出码"的既有语义。

---

### 3.5 live 与批扫双计（先测量 → 结论：未发生）

#### 3.5.1 实验与结果（可复现）

1. 在本会话制造一个真实工具失败（`Get-Item` 指向不存在的路径）。
2. 等 3s 让 live 去抖落盘，读 `/whale/live`：
   `events=1 flushes=1 added=0 bumped=0 silent=0 deferGroups=1`；指纹 **215 → 216**。
3. 立刻跑 `mine.cjs --check`（读同一会话日志的新增帧，`scanned=1 / skipped=31 / 53ms`）。
4. 复查该事件在 `state.deferred` 里的计数：**`n=1`，`first == last == 1789107694684`**（若被批扫重复聚合，`n` 应为 2）。

```
{"ok":true,"before":{"deferred":19,"seen":216},"after":{"deferred":18,"seen":215},
 "removedKeys":["1qygmio:file-missing"],"removedFp":1}
```

5. 指纹身份核对：`distinctSidsInFingerprints = 25`，与磁盘会话目录名 **25/25 全部匹配**；按 `at|hash` 分组 **0 组出现两个不同 sid**。

**结论**：live 与批扫对同一物理事件产出**完全相同**的指纹 `sid|at|hash36(cat|tool|text)`，因此批扫只会把它当"已见"跳过。**不存在双计**。实验产生的合成痕迹已从 `state.json` 精确移除（暂存 19→18、指纹 216→215，恢复到实验前）。

#### 3.5.2 残留风险（唯一可能双计的两条路径）与处置

只有两个变量能让同一事件算出两个指纹：

| 变量 | 触发条件 | 现状证据 | 处置 |
|---|---|---|---|
| `tool` 名退化成 `?` | live 侧漏掉对应的 `tool/call` 记录（订阅晚于事件、或映射被裁剪），而批扫从日志里读到了工具名 → `clusterKey` 不同 | 未观测到 | live 增计数 `toolUnknown`（tool=='?' 的事件数），写进 `/whale/live`；长期为 0 即证伪 |
| `at` 不一致 | 宿主事件对象的 `time` 与日志记录 `time` 不同 | 未观测到（本次实验 `n=1` 正说明两者一致） | 单测里加"同一记录 → live 与 batch 逐字节相同指纹"的不变量断言 |

**不做的事**：不建议现在改 `fpOf` 的构成（例如去掉 sid）。改指纹格式需要迁移 215 条历史指纹，风险大于收益，而风险本身已被测量证伪。

#### 3.5.3 落点与验收

- `live.cjs`：新增 `toolUnknown` 计数、`skippedByFingerprint` 计数；`lib/index.js` 的 `/whale/live` 透出 `dedup` 组。
- `live.selftest.cjs`：新增"live 与 batch 指纹一致"断言（用 e2e 夹具的同一段日志，两侧各算一遍比对）。
- 验收：`/whale/live` 出现 `dedup: { toolUnknown, skippedByFingerprint }`，且 `toolUnknown` 在正常会话中为 0。

---

## 4. 实施批次与顺序（含依赖）

| 批次 | 内容 | 依赖 | 建议版本 |
|---|---|---|---|
| **A** | 3.1（A1+A2+A3+A4）＋ 3.5 加固（计数器 + 不变量测试）＋ 可选数据修复 `--forget-echo` | 无 | v0.7.6 |
| **B** | 3.2 异步化 ＋ 3.3 维护窗口 | 两者都动 `engine` 主路径，合批回归更省；3.3 复用 3.2 的异步取锁 | v0.7.7 |
| **C** | 3.4（L1 注册模式 + L2 判定 + L3 自动重登记） | 动 `lifecycle`（与采集链路解耦，可独立发布） | v0.7.8 |

顺序理由：A 直接提升记忆质量（当前暂存 72% 是噪声，等于审核时要一条条排掉）；B 提升可用性与稳定性；C 属安装面治理，且 L1 是一次性命令，可先单独执行。

**批内执行顺序（关键，避免自伤）**：
1. 先写测试（A2/A3 的正例+反证、A1 的幂等夹具）→ 2. 再改 `scanner` → 3. 再改 `engine`/`repo` → 4. 再改 `/whale/live` 观测字段 → 5. 最后同步 e2e 断言与文档口径。
6. 部署顺序铁律：宿主半边改完 → `deploy-web.cjs --apply` → `deploy-web.cjs --check`（exit 0）→ 重启 `dsh web` → 现场验证（`/whale/live` version 变更 + 计数器归零 + 端点仍 200）。

---

## 5. 总验收清单（可判定）

| 项 | 判定命令 / 观测 | 期望 |
|---|---|---|
| 3.1 | 打印 echo 文件两遍前后行数 | 第 2 遍 +0 行 |
| 3.1 | 13 条漏网样本 + 5 条真样本跑 `isMetaEcho` | 13 命中 / 0 误伤 |
| 3.1 | `mine.cjs --check` 后 `/whale/live`.echo.dupSkipped | >0，且暂存数不增 |
| 3.2 | 全量扫描期间 `GET /whale/live` | 往返 < 200ms |
| 3.2 | 卸载插件后目录 | 无 `.lock` / `.tmp` 残留 |
| 3.3 | 重建期间 live 落盘 | `heldByMaintenance` 增、`state` 不被 live 改写、事后事件不丢 |
| 3.3 | 中断重建 | 过期后自动恢复采集 |
| 3.4 | 合法重写后 `lifecycle check` | exit 0 |
| 3.4 | 截断 skill 后 `lifecycle check` | exit 1 |
| 3.4 | `uninstall remove` 干跑 | 手动段保留、仅剥离标记区 |
| 3.5 | `/whale/live`.dedup.toolUnknown | 0 |
| 全部 | 10 套件自检 | ≥386 断言全绿（新增断言后应上升） |
| 全部 | `deploy-web.cjs --check` | exit 0 |

---

## 6. 版本、部署与回滚

- **版本口径**：A → v0.7.6；B → v0.7.7；C → v0.7.8。每批都要同步六处口径（`plugin/package.json`、`plugin/lib/index.js`、`plugin/README.md`、`PROJECT-INTRO.md`、仓库根 `README.md`、`CHANGELOG.md`）与数据目录 `README.md`。
- **回滚**：
  - 3.1 只影响"哪些事件被判回声/如何落档"：回滚方式是把签名组与幂等落档还原（旧代码仍能读旧文件——echo 文件格式未变，仅"行更少"）。
  - 3.2：`/whale/scan` 改回同步 `runScan` 即恢复原行为（异步入口保留但不再调用）。
  - 3.3：`maintenance` 字段是**可选字段**，旧版代码读它会被 `normalizeState` 原样保留、不解释 → 删除该字段即完全回退。
  - 3.4：`install --apply --agents-mode zones` 可再改回 `whole`；判定改造只影响 `check` 的退出码，不影响文件内容。
  - 3.5：只增观测字段，无回滚需求。
- **数据安全**：本批任何改动都不得触碰 `inbox.md` / `entries/` / `details/` / `archive/` 的内容协议；格式化变更（如 echo 轮转）必须先干跑、再落盘。

---

## 7. 明确不做（非目标）

1. 不改指纹格式（`fpOf` 中 sid 的取舍）——迁移风险大于已被证伪的收益。
2. 不引入 worker/子进程/任务队列；不做面板进度条（阶段二另议）。
3. 不改 `inbox.md` / `details/` / `entries/` 的对外格式与协议。
4. 不自动修改你手写的 AGENTS 手动段；`zones` 迁移只影响插件自己那两个标记区。
5. 不自动清理历史 echo 归档与已污染的暂存——只提供干跑命令，删除由你确认。

---

## 附录 A：本次实测证据（命令与原始数字）

1. **echo 归档统计**
   脚本：`%TEMP%\whale-audit\analyze-echo-live.cjs`（只读）
   ```
   echo.files: echo-20260910.md(218 行, 30138B) / echo-20260911.md(13 行, 1793B)
   totalRows: 231 | uniqueTexts: 77 | multiRowTexts: 55 | maxRowsForOneText: 8
   selfReferentialRows: 20
   ```
2. **暂存污染人工分诊**：18 条中 13 条为自引用/探针输出（键：`z2g0nc` `1hll4rz` `16oggg0` `1hpqvcw` `49wwwo` `1cobmts` `dwu6fk` `8515vk` `79u76w` `q2jgfw` `1popvn4` `8cx3r4` `1b2pml0`），5 条为真实故障（`zahbbc` `wzr1vg` `1c2f2xw` `1paw2ow` `1ndrizy`）。
3. **漂移守卫**
   ```
   node ~/.dsh/whale-notebook/plugin/lifecycle/cli.cjs check
   → 差异: AGENTS.md 登记 c1f7c… ≠ 现场 029df… / skill 登记 d6b83… ≠ 现场 0cc30…
   → [err] check 未通过: 失败 0 / 差异 2 / 孤儿 0   EXIT=1
   manifest.json: entries[agents].agentsMode = "whole"（当前 AGENTS.md 已含「手动段（用户自写区）」）
   ```
4. **live/批扫双计实验**
   ```
   LIVE-AFTER-FAIL: events=1 flushes=1 added=0 bumped=0 silent=0 deferGroups=1 buffered=0
   BEFORE-BATCH: fp=216 clusters=59        →  BATCH-EXIT=0 (scanned=1 skipped=31 ms=53)
   AFTER-BATCH:  fp=216 clusters=59
   deferred entry: n=1, first=last=1789107694684
   指纹身份: distinctSids=25, 与磁盘目录名匹配 25/25, at+hash 重复组 0
   清理复原: deferred 19→18, seen 216→215（合成痕迹已移除）
   ```
5. **扫描耗时基线**：增量 ≈23–53ms（32 文件中 31 个 stat 跳过）；全量 44.43MB ≈5084ms。
6. **测试基线**：10 套件 386 断言全绿；13 个测试文件 PASS 累计 457。

## 附录 B：需要你拍板的三件事（**均已裁定，见下方实施记录**）

1. **是否顺带清理已污染的 13 条暂存**（提供 `mine.cjs --forget-echo --dry` 干跑清单，你确认后再删）。→ **已批准并执行**。
2. **是否现在执行 `install --apply --agents-mode zones`**（保护你手写的 AGENTS 手动段；这是一次性命令，不改内容）。→ **用户要求稍后单独讨论再定，本批未做**。
3. **批次顺序**是否按 A（v0.7.6 回声与噪声）→ B（v0.7.7 异步化 + 维护窗口）→ C（v0.7.8 漂移守卫）执行。→ **已批准按此顺序**。

---

## 附录 C：批次 A 实施记录（v0.7.6，2026-09-12 回填）

| 计划项 | 落地情况 | 证据 |
|---|---|---|
| 3.1 A1 回声不再增生 | ✅ `engine.echoSig/echoSigOf`（签名＝`类别\|一句话(≤90字)`，与归档列同口径）＋ 落档前用 `repo.readEchoSignatures()` 幂等过滤 ＋ `echoDupSkipped` 计数与 CLI 可见 | `e2e.selftest`：「同一现象重复打印 → 归档行数**不变**、`echoDupSkipped=3`」 |
| 3.1 A2 签名补全 | ✅ `META_ARTIFACT`（state 字段名 / 探针抬头 / 表头，单条即判）＋ API 信封判据（`"ok":true` 且出现我们的键名） | `live.selftest`：**13 条真实漏网样本全命中**；**5 条真实故障反证 0 误伤** |
| 3.1 A3 出处拦截 | ✅ `OWN_ASSET_RE`（数据产物/接口，**不含** `plugin/src\|lib\|scripts`）＋ `RENDER_ROW_RE/RENDER_JSON_RE` 双条件 ＋ `cmdOf` 命令摘要**跨水位线窗口继承** | `live.selftest` 出处正例 1 + 反证 2（同出处真实报错不误伤 / 开发源码的失败仍进箱）；`e2e.selftest` 端到端 1 条 |
| 3.1 A4 轮转与观测 | ✅ `ECHO_MAX_ROWS=400` 自动轮转 `echo-<日期>-2.md`（跨分片签名去重仍生效）；`/whale/live` 增 `echo`（`day/files/rows/bytes/totalFiles/totalRows/cap`） | `repo.selftest` +5（签名读回、轮转文件名、跨分片去重、`echoStats`） |
| 3.1 数据修复 | ✅ `mine.cjs --forget-echo [--apply]`（默认干跑、持锁写回） | 干跑 13 条与人工分诊一致；`--apply` 后暂存 **18 → 5 组**（保留 5 条真实发现），`seen=215`/`next=137` 未变，无 `.lock`/`.tmp` 残留 |
| 3.5 双计加固 | ✅ 结论：**实测不成立，不改指纹**；改为 `live.stats.toolUnknown`（唯一残留路径的观测口径）＋ `skippedByFingerprint`（两侧共用指纹的正面证据），并入 `/whale/live.dedup`；单测加不变量 | 实验：`n=1`（双计应为 2）、`fp` 不变、`25/25 sid` 与目录名一致、`at\|hash` 跨 sid 重复 0 组；`live.selftest`：「live 与批扫指纹逐字节一致」 |
| 3.2 / 3.3 / 3.4 | ✅ 已落地（批次 B + C 合并为 v0.7.7，见附录 D） | 见下 |

**测试口径（批次 A）**：10 套件 **409 断言全绿**（`repo` 23→28、`engine` 21→26、`e2e` 63→66、`live` 35→45）；13 个测试文件 PASS 累计 **502**。
**生效差异**：回声判定/幂等落档、`--forget-echo` **批扫侧立即生效**；`/whale/live` 新字段属宿主半边，需**先 `deploy-web --apply` 再重启 `dsh web`**。

---

## 附录 D：批次 B + C 实施记录（v0.7.7，2026-09-12 回填）

> 用户裁定"剩余的帮我修改完毕"（含批准 `zones` 迁移）。原计划 B=v0.7.7 / C=v0.7.8，因 B 需要一次重启而 C 不需要，**合并为 v0.7.7**，避免让你重启两次。相对原设计有两处实现层面的偏离，都记录在下面（结论：更简单、更安全）。

| 计划项 | 落地情况 | 证据 |
|---|---|---|
| 3.2 `/whale/scan` 异步化 | ✅ **不做 202+jobId**，改为把 `scanHistory`/`runScanInner` 做成**生成器 + 双驱动**（同步驱动给 CLI、异步驱动给宿主），每 8 文件或每 4MB `await setImmediate`。HTTP 契约与返回体**完全不变量 → 面板零改动**；另加异步取锁（等锁也不阻塞）、`/whale/live.scanJob` 可观测、卸载取消位（保证释放写锁） | `engine.selftest` +7：「异步与同步结果一致（事件逐字节 + 统计口径）」「让出点确实被触发（onProgress）」「取消：明确失败」「取消后不残留写锁与维护窗口」 |
| 3.3 `--rebuild` 维护窗口 | ✅ 原设计用 `state.maintenance` 字段；实施改为**独立标记文件** `.maintenance.json`（读它比解析整个 state 便宜；不必给 state 加字段 → 也就不必改 CAS 合并语义）+ `expiresAt` TTL 兜底 + `finally` 无条件关窗。live 在**取锁前**先读它，命中就让路：事件留在缓冲、1s 后重试、`heldByMaintenance` 计数，**一条不丢** | `engine.selftest`「窗口开启（让出点可见）」+「结束后关闭」；`e2e.selftest`「rebuild 后不残留标记」；`live.selftest`「flush 让路不写盘」+「窗口关闭后缓冲补上」；`repo.selftest` +6（TTL 自愈 / 夹上限 / 原子写 / 幂等清除） |
| 3.4 L1 注册模式迁移 | ✅ 已执行 `install --apply --agents-mode zones`：**AGENTS.md 字节未变**（sha256 前后一致），`uninstall remove` 干跑现显示「AGENTS.md 标记区(zones; 区外内容保留)」 | 迁移前 `check` exit 1（2 条漂移）→ 迁移后 **exit 0** |
| 3.4 L2 判定改造 | ✅ **三级分级**：exit 1 只给"缺失 / 结构损坏（截断、非法 UTF-8、frontmatter 丢失、缺 `## 工作流`、小节过少等）/ 孤儿 / 清单待迁移"；「内容变了但结构完好」= **待登记**（信息级，exit 0）；`remove` 仍用 diffs 要求 `--yes`（删除前确认）；zones 模式**只对账两个标记区**（区内容基线 `zoneHash`）——你在区外写的东西改了/加了/删了都**不算漂移** | `lifecycle.selftest` 104→**120**：区外改动零待登记、区内改动＝待登记且 exit 0、结构损坏 exit 1、`remove` 仍要 `--yes`、adopt 不改文件内容 |
| 3.4 L3 流程闭环 | ✅ 新增 `check --adopt`（只更新清单基线、**不碰任何文件内容**；结构损坏的条目拒绝登记）+ 技能 §7 增补"入库改写自动段 / 更新技能后跑一次 adopt"；lifecycle 工具 0.1.1 → **0.2.0** | 实测：改完技能 → `check` 报 1 项待登记（exit 0）→ `check --adopt` → 重新登记 agents（含区基线）与 skill → `check` 恢复「通过」 |

**测试口径（v0.7.7）**：10 套件 **442 断言全绿**（`repo` 28→34、`engine` 26→33、`e2e` 66→67、`live` 45→48、`lifecycle` 104→120）；13 个测试文件 PASS 累计 **535**。
**生效差异**：漂移分级与 `check --adopt` 属**命令侧、立即生效**；异步扫描 / `scanJob` / `maintenance` 属宿主半边，需**先 `deploy-web --apply` 再重启 `dsh web`**（本次已 `--apply`，`--check` exit 0）。
**五项全部收口**：① 回声自我放大（v0.7.6）② 扫描异步化（v0.7.7）③ rebuild 维护窗口（v0.7.7）④ 漂移守卫（v0.7.7）⑤ 双计（实测不成立，已用计数器 + 不变量断言钉住）。审计清单里其余项（N7 已随之解决、N10–N17、N27–N29 等）仍按原优先级保留。
