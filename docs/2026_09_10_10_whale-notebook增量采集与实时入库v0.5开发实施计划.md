# whale-notebook 增量采集与实时入库 v0.5 开发实施计划

> 日期：2026-09-10 ｜ 版本：v0.5.0 ｜ 状态：已实施并验证（本机实测 + 5 套自检全绿）
> 上游文档：《2026_09_09_16_whale-notebook插件化架构设计.md》《2026_09_09_22_whale-notebook决策箱v0.3实施计划.md》《2026_09_09_23_whale-notebook已解决墙与分类v0.4实施计划.md》

## 1. 背景与目标

v0.4 及以前，采集（`mine.cjs --check`）每次都**全量重读全部会话日志**：13 个会话 / 约 23 MB / 约 6 万个 zstd 帧，耗时 2.9～4.2 秒，且随历史增长线性恶化；「运行中刚发生的失败」要等到下一次扫描才可能进箱。

本次要解决三件事：

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 增量扫描：跳过未更新的会话日志，只解新增部分 | 热启动耗时 < 100 ms、读取 0 字节；全量重扫结果与增量结果一致 |
| G2 | 运行中「反复重试且失败」实时进待审箱 | 无需等待扫描、不消耗模型 token、不打断会话 |
| G3 | 不产生重复候选；已处置候选复发要能看见 | 同一坑跨轮次累加次数；复发重开候选并标注来源 |

非目标（本次不做）：告警推送/桌宠通知；跨机同步；把原始会话文本写入经验库。

## 2. 前提核实（实测数据，非推断）

| 结论 | 证据 |
|---|---|
| 采集全程**不调用模型**，token 消耗为 0 | `collector/*` 仅用 `node:zlib` + 正则；全仓无 LLM/网络调用 |
| 全量扫描 13 文件 / 22.93 MB / 59,318 帧 ≈ 2.9～4.2 s | 三次连跑计时（只读探针） |
| 会话日志是**纯追加的多帧 zstd**，每帧以 `\n` 结尾 | 59,318 帧中跨行帧 = 0，坏帧 = 0，平均 400 B/帧 |
| 帧起点在文件任意时刻都与 zstd magic 对齐 | `decoder.scanFrames` 可从任意帧边界续扫，无需回收半行 |
| 宿主提供会话事件总线 `session/event` | DSH 内核 13 个包在用（如 `dsh-file-reference-local`）；事件对象与磁盘记录同形 `{type,time,data}` |
| 真正消耗 token 的位置 | ①（已隐藏的）⚡ 自动处理投递长指令；② 每会话列出待审清单；③ 复盘时翻原始日志 |

## 3. 方案总览

```
                       ┌─────────────── 批扫（mine.cjs / 面板 ⟳ / POST /whale/scan）
会话日志 session.jsonl.zstd ──┤  decoder.decodeLinesFrom(file, offset)：只读新增字节、按帧边界续扫
                       └─────────────── 实时（宿主 session/event → collector/live.cjs）
                                                 │  两条路径共用同一判定与入库
                                                 ▼
                        scanner.classifyRecord ──► engine.ingestFresh
                                                 ├─ 指纹去重（seenFingerprints，带上限截尾）
                                                 ├─ 聚簇索引（clusters：hash → cid/n）
                                                 └─ 复活/新建/累加 → inbox.md 行 + details/C###.md + state.json v2
```

## 4. 详细设计

### 4.1 增量水位线（state.json v2 `files`）

每个会话日志记录 `{ size, mtimeMs, offset, frames, sid, ws, calls }`：

1. `size` 与 `mtimeMs` 都没变 → **只 stat，不解码**（G1 的「未更新就跳过」）；
2. 变大 → 用 `fs.readSync(fd, buf, pos=offset)` 只读 `[offset, EOF)`，只解其中的新帧；
3. `offset > size`（截断/轮转）或 offset 处不是 zstd magic → 该文件**退回全量重扫**并重置水位线；
4. **末尾半写帧/坏帧解压失败 → offset 不推进** → 下次自动重试（天然的失败重试）；
5. `mtimeMs = -1` 用于标记「尾部有未消费帧」，保证下次必扫。

**关键坑（已修）**：增量窗口常只剩 `tool/result` 而没有配对的 `tool/call`，工具名会退化成 `?`；而 `tool` 是聚簇键的一部分 → 同一个坑会被当成新坑重复入箱。解决：水位线里持久化 `callId→工具名` 映射（每文件上限 512，超出丢最旧），增量时继承。自检里专门用「只追加 result 帧」的用例覆盖。

### 4.2 聚簇索引与复发策略（`clusters`）

`clusters[hash] = { cid, cat, text, n, first, last, reAddedAt, reAdds }`，`hash = hash36(clusterKey(ev))`（与指纹同源，不改算法 → 历史指纹不变式不受影响）。

每批新事件判定四种结局：

| 结局 | 条件 | 动作 |
|---|---|---|
| 累加（bump） | 聚簇存在且候选**仍在 inbox** | 就地改写该行「次数」列；sidecar 追加「## 复发记录」 |
| 复发（readd） | 聚簇存在但候选已不在 inbox（已入库/已删除） | 新开候选，现象列前缀 `复发（原 C0xx）：`，sidecar 标注原候选 |
| 静默（silent） | 复发且距上次重开 < `reAddCooldownDays`（默认 7 天） | 只累计次数 + sidecar 记录，不重开候选、不打扰 |
| 新建（new） | 无聚簇 | 按 v0.4 行为新建候选 |

升级自愈：v0.4 时代的候选没有簇索引，同 `类别 + 现象列` 时**认领**为同一聚簇，避免升级后第一次复发变成重复行。

### 4.3 实时采集（`collector/live.cjs`）

宿主 `lib/index.js` 在 `apply(ctx)` 中订阅 `ctx.on('session/event', ...)`：

- `tool/call` → 记 `callId→工具名`；`tool/result` → 失败优先判定；成功结果仅对命令类工具做特征扫描；`user/message` → 真实用户报障判定（沿用 v2.1 政策）。
- **与批扫共用 `scanner.classifyRecord`**（同形事件对象）→ 判定表永不漂移。
- 去抖 1.5 s 合并一波重试；写盘走 promise 链**串行化**；每轮 flush **现读现写** `state.json`，不缓存水位线，避免覆盖 CLI 批扫刚建立的水位线。
- 单轮最多开 6 行（噪声上限），超出只记指纹；`autoCollect/liveCapture=false` 时整体停用；**监听器内吞掉一切异常**，采集失败绝不影响用户会话。
- 自检 `GET /whale/live` 暴露 `{version, live:{events,flushes,added,bumped,...}, watermarks, clusters, fingerprints}`。

### 4.4 面板 ⟳ 与 CLI

- `POST /whale/scan`：先把实时缓冲落盘 → 再按水位线增量扫描 → 返回 `{added, bumped, pending, ms}`；并发调用返回 409。
- 面板 ⟳：由「只重拉列表」改为「触发扫描 → 刷新列表」，按钮 tooltip 显示本次结果。

| 命令 | 语义 |
|---|---|
| `mine.cjs --check` | 增量扫描入箱（默认） |
| `mine.cjs --check --full` | 忽略水位线全量重扫（排障/校验） |
| `mine.cjs --check --dry` | 只报结果不落盘（含不写 state） |
| `mine.cjs --stats` | 全量统计**纯只读**（v0.5 起不再写 state） |
| `mine.cjs --prewarm` | 只记指纹与水位线不入箱；输出警告说明会「消费」候选 |

### 4.5 顺带修复的缺陷

1. **`--stats` / `--prewarm` 静默吞候选**：旧版会把 `seenFingerprints` 落盘，等于跑一次统计就让这批新 error 永不进箱 → `--stats` 改为纯只读。
2. **`seenFingerprints` 无限增长** → 按 `maxFingerprints`（默认 5000）截尾。
3. **现象列含 `|` 时整行无法解析**（表格列分隔符冲突 → 面板看不见、也无法累加次数）→ 行列写入时 `|` 转全角 `｜`；待审行解析收敛到 `repo.parseInboxRows`（store 层唯一入口）。
4. **会话开始提醒的 token 成本**：待审 > `reminderListMax`（默认 3）时只报「新增 N / 待审共 M」并提示面板，不再逐条列清单。

### 4.6 v0.5.1 自引用/探针回声过滤（原 §8.1 遗留项，已修）

**问题**：`SELF_REF` / `ENC_DIAG_RE` 只作用于「成功的命令结果」，`error` 类事件直接绕过 → 维修采集器自身、研究会话日志格式时产生的失败与探针输出全部进箱。真实历史预演：26 条新候选中约 20 条属此类。

**方案**：`scanner.isMetaEcho(text)` 两级签名，**命中者标记 `meta=true` 交由 engine 落档后再排除**（不静默丢弃）：

| 级别 | 语义 | 例 |
|---|---|---|
| STRONG（单条命中即判） | 采集器/本机制自身产物的唯一性标记 | `whale-notebook`、`mine.cjs`、`inbox.md`、`details/C###`、`[dry 只读]`、`新发现 N 条`、`byCat`、`ENC_DIAG`、`SELF_REF`、`*.selftest.cjs`、`sync-release`、`frame layout`、`endNL=`、`variant A` |
| WEAK（需 ≥2 条同时命中） | 弱特征，单独出现很可能是真实故障文本 | `cordis`、`plugin-group`、`dsh-host-webserver`、`ctx.router`、`session.jsonl.zstd`、`frames=N`、`gbk decode`、`permission/preset`、`@deepseek-ai`、`AppData\Roaming\npm` |

**可审计**：被过滤条目按聚簇落档到 `~/.dsh/whale-notebook/archive/echo-<YYYYMMDD>.md`（`| 时间 | 类别 | 次数 | 工作区 | 现象 |`），扫描输出报「自引用回声过滤 N 组/M 条」，`GET /whale/live` 与实时统计同样计数。

**效果**（同一份真实历史）：新候选 **26 → 2**（保留的两条是真的 `[sandbox: file access denied under workspace-write mode]` 沙箱拒绝坑）。自检新增 4 断言：回声不进箱、计数与提示、落档可查、弱特征单命中不误伤。


### 4.7 v0.6.0 拉取式：扫描照常、发现暂存、`--add` 才入箱

**动机**：用户偏好「不要未经要求的待审积压」。核实过的 token 账：**自动入箱本身 0 token**（纯 Node 写文件）；真正花 token 的是会话开头报告清单、以及审核时读 inbox/详情——所以这里省的不是扫描成本，而是**主动打扰与积压**。

**语义**（`settings.autoAdd`）：

| autoAdd | `--check` 行为 | 待审箱 | 取用方式 |
|---|---|---|---|
| `true`（旧行为） | 增量扫描 + 直接入箱 | 自动增长 | 会话开始提醒报告 |
| `false`（本机当前） | 增量扫描 + 合并进 `state.deferred` 摘要 | **不增长** | 用户说「小本本复盘」→ `mine.cjs --add` |

要点：

1. **不丢发现**：水位线与指纹照常推进；暂存摘要 `deferred[hash] = {cat,text,n,first,last,ws[],refs[],excerpt,at}`，上限 `maxDeferred`（默认 200，超出按最近出现时间保留最新）。
2. **已在箱中的候选不受影响**：命中共聚簇时仍只累加次数（`bump`），不新增行。
3. **`--add` 不重新扫描**：复杂度只与暂存组数有关；入箱时重建候选行 + `details/C###.md`（用暂存的 ≤3 条源引用与最长摘录），曾经处置过的标 `复发（原 C0xx）：`；幂等（无暂存时入箱 0 条）。
4. **实时采集同样遵守**：`liveCapture` 打开也只暂存、不写箱。
5. **提醒句随开关二选一**（`inject/agents.cjs → tailLines`）：注入文本必须与实际行为一致——拉取式下只报一行「新发现 N 组已暂存（未入箱）」，明确写「不要展开清单、不要询问审核」，比自动模式更省 token。
6. **面板**：`GET /whale/inbox` 附带 `deferred` 组数；仅有暂存时候选入口不隐藏（面板不会「躲起来」），徽标显示暂存数，卡片提示「回复『小本本复盘』入箱后审核」。

**效果（本机实测）**：`--check` 仍为 8ms/读 0 字节，待审箱保持 11 条不再自行增长；`--add` 幂等。自检新增 11 断言（拉取式不写箱、暂存摘要与证据、水位线照常推进、同坑合并、`--add` 入箱与 sidecar 重建、幂等、在箱候选仍只累加）。

### 4.8 v0.7.0 同族（family）确定化：让「还有类似的问题可以一并处理」不再靠模型即兴归纳

**问题（用户提出）**：面板 💬 把某条候选转新会话时，消息里**只有这一条**（`lib/client.js → discussMessage()` 只拼 `contextLine(r)` + 该条 sidecar；`openDiscussion()` 新建会话只投递这段文本）。程序里唯一的「相似」是精确同文聚簇（`cat|tool|canonText` 全等），只用于去重与次数累加。因此「还有类似的可以一并处理」实际上是 **LLM 自己翻 inbox 后的归纳**——不可复现、可能漏、可能编；换个会话结论可能不同。

**目标**：把「该看哪些」变成程序算的、可复现、可解释；「是否同一根因」仍由人/agent 判断（这是能力的边界，必须写清）。

| 层 | 实现 | 关键设计 |
|---|---|---|
| L1 族合并 | `engine.js`：未命中同文聚簇时用 `bestFamily()` 与「已登记的族」比相似度，命中即**并入该族已有的候选行**（累加次数 + 变体现象写进 sidecar 的「## 同族并入」段） | **族复用既有 `state.clusters`**——同一 `cid` 的多个聚簇天然就是一族，**不新增状态字段**；族已处置则整族压掉（与 v0.6.3 文本级守卫同义但按族生效）；族曾开行后被处置 → 仍走复发语义 |
| L2 讨论带依据 | 新端点 `GET /whale/related?id=C###` → `family`（族成员/变体/相似度）+ `related`（其它在箱行，相似度 ≥0.35）+ `entries`（可能已覆盖，相似度 ≥0.25 或同类别）；面板 💬 先取它并写进新会话消息（`relatedBlock`），消息末尾附固定动作 | 端点不可用时优雅退回单条上下文（`apiRelated` 失败返回 null → `relatedBlock(null)` 为空串），不阻断讨论 |
| L3 覆盖提示 | 同上 `entries` 块（`listEntries()` × `similarity(候选现象, 标题+对策)`，同类别给 0.3 下限） | 入库前去重从「自己翻 entries」变成「核对程序给的候选」 |
| L4 措辞固化 | 技能「讨论」加为**第 0 步**（程序给依据；退化路径 = 读 inbox + `clusters` 同 cid 判族 + 写明判据）；「入库」加同族合并口径（一条候选 = 一条经验，occurrences 取总和，对策覆盖全部变体） | 让「一并处理」成为每轮必做而非偶发 |

**相似度口径**（`src/core/similarity.cjs`，纯函数）：`skeleton()` 剥掉易变部分（IP/端口/时间戳/行号/路径/字节数/会话 id/uuid）后做字符 3-gram 集合相似度，取 Jaccard 与包含度×0.9 的较大者；阈值同类 0.6 / 跨类 0.8（`settings.familyThresholdSame/Cross` 可调）；类别相容组：`git-net|timeout|model-api` → `net`，`sandbox-file|sandbox-ep` → `sandbox`，`error` 与任意类别相容。骨架短于 12 字符只认完全相等（防无信息文本乱命中）。

**与 v0.6.3（另一会话同期实现）的关系**：他们从「归档表是已处置的事实源」出发压掉重置后重扫的重复开行；本层把同一思路推广到**族级**（族的代表被处置 → 整个族压掉），并复用他们的 `clusters` 结构，两者叠加而非冲突。

**实测（本机真实数据）**：`--rebuild --dry` 显示 16 文件 / 27.61MB / 2317ms、暂存 38 组、回声过滤 57 组、累加已有候选 3 条；`related` 对 git 类候选给出「可能已被 E002/E003 覆盖（0.3）」。自检新增 `similarity.selftest.cjs`（20 断言，含四条「不得误并」反证）与 e2e v0.7 段（5 断言：同族合并、族成员同 cid、sidecar 记录、related 三块齐备、不误并），全仓 **202 断言全绿**（含 v0.6.3 的 19 条）。

**回滚**：L1 只影响新事件的归族（阈值置 1.0 即等于关闭合并，`settings.familyThresholdSame/Cross`）；L2/L3 是只读端点（不部署宿主半边即不生效）；L4 只改技能文本。

## 5. 任务拆解与执行顺序（已全部完成）

| # | 任务 | 产物 | 状态 |
|---|---|---|---|
| 1 | 解码层增量入口 | `collector/decoder.cjs` (`decodeLinesFrom`/`readTail`) | ✅ |
| 2 | 判定层抽出共用函数 | `collector/scanner.cjs` (`classifyRecord`/`classifyToolResult`/`classifyUserMessage`/`boundCalls`) | ✅ |
| 3 | 存储层 state v2 + 行操作 | `store/repo.cjs` (`normalizeState`/`parseInboxRows`/`pendingIds`/`bumpInboxRows`/`writeInboxText`/`appendDetailNote`) | ✅ |
| 4 | 引擎：水位线 + 聚簇/复发 + dry | `collector/engine.cjs` (`scanHistory`/`ingestFresh`/`markSeen`) | ✅ |
| 5 | 实时采集器 | `collector/live.cjs`（新增） | ✅ |
| 6 | CLI 旗标 | `collector/cli.cjs`（`--full`/`--dry`） | ✅ |
| 7 | 宿主挂载 + 新端点 | `lib/index.js`（`session/event`、`POST /whale/scan`、`GET /whale/live`） | ✅ |
| 8 | 面板 ⟳ 语义 | `lib/client.js`（`apiScan`） | ✅ |
| 9 | 设置与提醒句 | `settings.json`、`core/schema.cjs`（`SETTINGS_DEFAULTS`）、`inject/agents.cjs` | ✅ |
| 10 | 自检 | `collector/e2e.selftest.cjs`（35 断言）、`collector/live.selftest.cjs`（新增 17 断言）、`scripts/bundle-smoke.cjs`（v0.5 结构断言） | ✅ |
| 11 | 部署与镜像 | `scripts/deploy-web.cjs --apply` → `profiles/web/node_modules/...`；`tools/sync-release.cjs` → 发布镜像库 | ✅ |

## 6. 验证与实测结果

### 6.1 真实历史实测（23.88 MB / 13 文件，临时数据目录，不触碰真实 inbox）

| 场景 | 结果 |
|---|---|
| 冷启动（无水位线 = 全量） | 13/13 文件、读取 23.81 MB、**2233 ms** |
| 热启动（水位线命中） | 解码 **0** 文件、跳过 13、读取 **0.00 MB**、**11 ms**（提速约 350×） |
| `--check --full` 校验 | 2048 ms、**新发现 0 条** ⟹ 增量没有漏采 |
| `--check --dry` | 0 写入 |
| `state.json` | 84.6 KB（水位线 + callId 映射 + 聚簇索引，含 13 会话） |

### 6.2 自检矩阵

| 套件 | 断言 | 结果 |
|---|---|---|
| `src/collector/e2e.selftest.cjs` | 40（含增量等价性、跨窗口工具名继承、`--dry` 不写、`--stats` 只读、复发/冷却、`--full` 无重复、水位线结构、回声过滤 4 条） | 全绿 |
| `src/collector/live.selftest.cjs` | 19（判定、实时入箱、反复重试累加、不覆盖水位线、dispose 冲刷、开关、畸形事件不抛） | 全绿 |
| `src/ui/server.selftest.cjs` / `core/privacy` / `core/summarize` / `collector/engine` | 45 / 10 / 10 / 10 | 全绿 |
| `scripts/bundle-smoke.cjs` | bundle 桩 + v0.4/v0.5 结构断言 | 全绿 |

合计 **134 断言**（6 套件）+ bundle 桩，全绿。

### 6.3 生效方式（**重要**）

| 改动 | 生效条件 |
|---|---|
| `lib/client.js`（浏览器半边） | 只需**刷新页面**（loader 每请求现读磁盘且 `no-cache`） |
| `lib/index.js` / `src/**`（宿主半边：实时采集、`/whale/scan`） | **需重启 dsh web**（cordis 装载器启动时读入）；重启会中断在线会话，须由用户选择时机 |
| `mine.cjs` 增量批扫 | 立即可用，无需重启 |

## 7. 回滚方案

1. 面板/宿主：`node plugin/scripts/deploy-web.cjs --undo --apply`（摘除 patch 行并按清单回退）。
2. 仅想回到「全量扫描」：`settings.json` 置 `"scanMode": "full"`（或命令行 `--full`），无需改代码。
3. 实时采集出问题：`"liveCapture": false`（宿主侧停止入箱，批扫照常）。
4. 数据侧：`state.json` 是纯派生状态，删除后下次扫描会重建水位线与指纹（代价：候选可能被重新发现，不丢数据）。

## 8. 遗留与风险

1. **自引用回声** —— ✅ 已解决：见 §4.6（v0.5.1 两级签名过滤 + 落档可审计；真实预演 26 → 2 条）。
2. **跨进程写竞态**：`dsh web`（实时）与 CLI 批扫可能同时写 `state.json`；已用「原子替换 + 每轮现读现写」把窗口压到最小，但极端情况下仍可能丢一次水位线更新（下一次扫描会自动补扫，不丢数据）。
3. `--check` 单轮最多开 30 行（`maxNewRows`），超出的只记指纹不再进箱（与 v0.4 行为一致，现在会显式报出「超单轮上限丢弃 N 条」）。
4. 首次升级后第一轮扫描仍是全量（建立水位线），此后才享受增量。

## 9. 后续可选增强

- `error` 类事件的自引用/诊断过滤（对应 §8.1）。
- 采集器给自身会话打标（如 `whale-notebook:meta` 标记），从源头排除元讨论回声。
- 定时增量扫描（`dsh-schedule` 可用）替代会话开始触发。
- 已解决墙与聚簇索引打通：入库条目直接记录 cluster hash，复发时在墙上标注「复发」。
