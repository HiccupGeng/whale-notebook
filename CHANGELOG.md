# 更新日志（CHANGELOG）

> **版本沿革的唯一明细入口。** 根 `README.md`、`plugin/README.md`、`PROJECT-INTRO.md` 只写「当前状态」与用法；历史动因、实测数据、设计裁定、踩过的坑都在本文件。
> 版本号口径：插件包 `plugin/package.json`（当前 `0.7.7`）；生命周期工具 `plugin/lifecycle/` 另有独立版本（当前 `0.2.0`）。

## v0.7.7（2026-09-12）扫描让出事件循环 · rebuild 维护窗口 · 漂移分级与 check --adopt

**起因**：接 `docs/2026_09_11_14_whale-notebook五项遗留问题解决方案.md` 的**批次 B（第 2/3 项）与批次 C（第 4 项）**，用户裁定"剩余的帮我修改完毕"。（原计划 B=v0.7.7、C=v0.7.8，因 C 不需要重启而 B 需要一次重启，故合并为一个版本，免得让你重启两次。）

### ① `/whale/scan` 让出事件循环（`engine.cjs` + `lib/index.js`，审计第 2 项）

**问题**：`POST /whale/scan` 的处理器里 `engine.runScan('--check')` 是**同步**调用，`scanHistory` 全程同步 IO（`statSync`/`readFileSync`/`zstdDecompressSync`）。实测增量扫描 23–53ms（无感），但水位线失效或全量时 **44.43MB ≈ 5084ms**，这段时间宿主 Node 事件循环被独占——面板其它端点、实时采集去抖器、GUI 自身请求全部排队。

**修法**：把 `scanHistory` 与 `runScanInner` 的主体改为**生成器**，配两个驱动：同步驱动（CLI，`driveSync` 忽略让出请求 → 退出码与输出口径**零变化**）与异步驱动（宿主 `runScanAsync`，在让出点 `await setImmediate`）。循环体只有一份，两条路永不漂移。宿主侧另加：异步取写锁（`await repo.acquireLock`，等锁也不阻塞）、`/whale/live` 新增 `scanJob`（在飞那一轮的 files/scanned/readBytes/ms）、插件卸载置取消位（扫描在下一个让出点退出并**一定**释放锁）。HTTP 契约与返回体不变，**面板零改动**。

**第二轮修正（同日实测发现第一版不够，已随本版一并交付）**：第一版让出条件是"每 8 个文件或每 4MB"，重启后**实测不合格** —— 全量扫描期间 `/whale/live` 往返延迟最高 **3857ms**（多数探针 900–3800ms）。根因：单个大日志（实测 3.4MB / 8266 帧）会在**一次** `collectEventsFrom` 调用里整段解完，宿主被独占约 1.6s。修法：`decoder.readTail/decodeLinesFrom` 新增 `maxBytes` 窗口读并返回 `more`/`truncated`；`engine` 新增 `readFileWindows` 生成器 —— 大日志按 **256KB 一片**续读（复用既有的 offset 续扫能力，会话上下文逐片前传），片间与文件间都让出事件循环。**复测：同一份 52.1MB 全量扫描，最大事件循环卡顿 69ms，没有任何一次超过 100ms**（扫描 6.0s，`dupFingerprints=241` → 全部事件被指纹去重、未产生新候选）。同步驱动传 `Infinity` → 一次读完，行为与 v0.7.6 逐字节一致。

**验证**：`engine.selftest` +9 —— 「异步与同步扫描结果一致（事件逐字节 + 统计口径）」「异步驱动确实让出事件循环（onProgress 被调用）」「**窗口化（1KB 片）与整读产出完全相同的事件与水位线**」（120 帧大日志把小窗口路径跑满）「小窗口确实切了多片」「取消：明确失败」「取消后不残留写锁与维护窗口」等。

### ② `--rebuild` 维护窗口：让路但不丢事件（`repo.cjs` + `engine.cjs` + `live.cjs`，审计第 3 项）

**问题**：`--rebuild` 清空派生状态后从头梳理全部历史（实测 ≈5s），期间实时采集仍在旁边写：写锁挡住了互相覆盖，但外部**看不出"正在重建"**，重建与实时写入的先后关系也没有任何约定。

**修法**：`--rebuild` 在清空之前先写一个**维护窗口标记** `~/.dsh/whale-notebook/.maintenance.json`（`{kind,pid,startedAt,expiresAt}`，`expiresAt` 上限夹到 10 分钟），`finally` 里无条件关闭（成功/失败/异常都关）。实时采集在**取锁之前**先读这个标记（独立小文件，比解析整个 state 便宜得多，也不必给 state 加字段、不必动 CAS 合并语义）：命中就让路——事件原样留在内存缓冲、1s 后重试、`live.heldByMaintenance` 计数，**一条都不丢**。进程被强杀时靠 `expiresAt` 自愈（过期标记在读取时自动清理）。`/whale/live` 新增 `maintenance`。

**验证**：`engine.selftest`「rebuild 期间维护窗口开启（让出点可见 kind=rebuild）」「结束后关闭」；`e2e.selftest`「--rebuild 结束后不残留维护窗口标记」；`live.selftest`「维护窗口：flush 让路（不写盘）」「窗口关闭后缓冲补上（事件一条不丢）」；`repo.selftest` +6（TTL 过期自愈、超长有效期夹到上限、原子写、幂等清除）。

### ③ 漂移守卫分级 + `check --adopt` + AGENTS 迁 zones（`lifecycle/`，审计第 4 项；工具版本 0.1.1 → **0.2.0**）

**问题**（实测）：`lifecycle check` 恒 exit 1，两条"差异"分别是 AGENTS.md 与 skill —— 而这两个文件**本来就会被合法重写**（AGENTS 自动段随每次经验入库重写；skill 随版本迭代更新），登记 hash 停在安装那一刻。于是"真损坏"和"我只是正常更新过"再也分不开，信号被稀释。**附带发现一个真隐患**：`manifest.json` 里 `agents` 条目登记为 `whole` 模式（"整文件归本插件所有，卸载整文件删除"），而该文件已含用户的「手动段（用户自写区）」→ `uninstall remove/purge` 会把用户手写内容一起删掉。

**修法**：把漂移判定**分三级** ——
- **exit 1（真问题）**：文件缺失、标记区缺失、**结构损坏**（截断 / 非法 UTF-8 替换字符 / frontmatter 丢失 / 缺 `## 工作流` / 小节过少 / 正文未提及本插件）、孤儿、清单待迁移；
- **diffs（`remove` 仍要求 `--yes`）**：内容与登记不一致 —— 删除前确认；
- **stale「待登记」（信息级，exit 0）**：内容变了但**结构完好** = 一次合法演进，提示跑 `check --adopt`。

新增 `check --adopt`：把 I 段"合法演进过"的现场**重新登记为基线**（只更新清单里的 hash，**不碰任何文件内容**；结构损坏的条目拒绝登记并提示先修）。
另：**AGENTS 条目迁移到 `zones` 模式**（`install --apply --agents-mode zones`）——此后只对账两个标记区（区内基线 `zoneHash`），**区外用户内容改了/加了/删了都不算漂移**，`remove` 也只剥区、绝不整文件删除。

**实测（本机真实 home）**：迁移前 `check` → exit 1（2 条漂移）；迁移后 → **exit 0**；迁移过程 **AGENTS.md 字节未变**（迁移前后 sha256 一致）；`uninstall remove` 干跑输出「AGENTS.md 标记区(zones; **区外内容保留**)」。
**验证**：`lifecycle.selftest` 104 → **120**（+16：区外改动不产生待登记、区内改动＝待登记且 exit 0、`--adopt` 后清空待登记且文件内容未改、结构损坏 → exit 1、`remove` 仍要 `--yes`）。
**流程闭环**：技能文件 §7 增补"入库改写了自动段 / 更新了技能文件之后跑一次 `check --adopt`"，把重新登记纳入日常流程。

**验证汇总**：10 套件 **444 PASS / 0 FAIL** ＋ `bundle-smoke` ＋ `redact.test` 22 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28 ＝ 13 个测试文件 PASS 累计 **537**（2026-09-12）。新增/变化：`repo` 28→34、`engine` 26→35、`e2e` 66→67、`live` 45→48、`lifecycle` 104→120。
**生效**：`lifecycle check --adopt` 与漂移分级**立即生效**（命令侧）；`lib/index.js` 的异步扫描 / `scanJob` / `maintenance` 属宿主半边 → **先 `deploy-web --apply` 再重启 `dsh web`**。

## v0.7.6（2026-09-12）回声自我放大治理 · 暂存污染清理 · 双计口径加固

**起因**：接 `docs/2026_09_11_14_whale-notebook五项遗留问题解决方案.md` 的五项梳理。用户裁定按批次 A（本版）→ B → C 执行，并同意清理已污染的暂存。本版做**批次 A**：回声自我放大（唯一实测在发生的增长问题）＋ 双计口径加固（实测证明无需修，改为钉住结论）。

### ① 回声落档「稳定签名 + 幂等追加」（`engine.cjs` + `repo.cjs` + `scanner.cjs`）

**问题**（实测）：`archive/echo-20260910.md` 218 行 + `echo-20260911.md` 13 行 = **231 行只对应 77 个不同现象**（55 个现象有多行、单现象最多 8 行），其中 20 行的现象本身就是"我们自己的渲染行"（`--- echo tail --- | 2026-09-10 12:21 | error | 2 | …`）。根因是**分组方式**：回声按「聚簇哈希 = `cat|tool|整段文本`」聚合，同一现象第二次被打印时尾部（打印出来的表行、行号、上下文）已变 → 哈希不同 → **新开一行**而不是累加 `n`；落档又只 append、从不与已有行比对 → 文件单调增长。

**修法**：① 回声签名改为 **`类别|一句话现象(≤90字)`**（与归档列同口径，`echoSigOf()`），同现象永远同一行；② 落档前用 `repo.readEchoSignatures()` 读回当日归档已有签名，**已存在就不写**（幂等），CLI 输出「其中 N 组已在当日归档(不重复落档)」；③ 当日分片超 `ECHO_MAX_ROWS`（400）自动轮转 `echo-<日期>-2.md`；④ `GET /whale/live` 增 `echo`（当日/累计行数/上限），回声在不在长一眼可见。

### ② 签名表补全（A2）+ 按出处整类拦截（A3）（`scanner.cjs`）

**问题**（实测）：18 组暂存里 **13 组（72%）是我们自己的产物**：我们 API 的 JSON 信封（`HTTP 200 {"ok":true,"id":"C122","candidate":{…}}`）、`state.json` 的字段名（`"reAddedAt": 0`）、一次性探针的抬头（`topKeys=…`、`parts=7 […]`、`== clusters sample`、`exists=True lines=`、`logged97 statNow`、`=== listEntries ===`、`archive-20260909.md rows 1 parsed 1`）、自检输出（`=== lifecycle/selftest.cjs ===`）。它们多以「命令类工具的成功结果」形态出现，而**旧签名只认渲染痕迹与采集器源码名**，于是全部漏网（同一批污染也在候选流里开过行：C092 的现象就是 `--- echo tail --- | …`）。

**修法**：① `META_ARTIFACT` —— 我们自己的标识符与抬头**单条命中即判**（`seenFingerprints`/`nextCandidateId`/`reAddedAt`/`lastScanStats`/`familyScore` 五个 field 名、探针抬头、表头 `| 时间 | 类别 |`）；② API 信封判据（`"ok":true` **且** 出现我们 API 的键名，单独出现不算）；③ **A3 出处拦截**：命令碰过我们的**数据产物/接口**（`whale-notebook/{state.json,inbox.md,INDEX.md,details,archive,entries}`、`/whale/*`、`mine.cjs`）**且**结果里是我们渲染的结构化输出（≥3 列表格行 / JSON 对象字面量）→ 判回声。**只碰 `plugin/src|lib|scripts` 的开发调试不算**（跑自检发现的真实 bug 必须继续进箱——历史上真从自检里发现过框架级 bug）；`callId→命令摘要` 与既有 `callId→工具名` 一样**跨水位线窗口继承**，否则增量扫描里出处判定会失效。

**验证**：`live.selftest` +10（13 条真实漏网样本全部命中 + **5 条真实故障反证 0 误伤** + 出处判定正例 1／反证 2 + 命令摘要跨窗口继承）；`e2e.selftest` +3（幂等：同一现象重复打印后归档行数**不变**且 `echoDupSkipped=3`；出处拦截：打印 `state.json` 的失败结果不进箱）。

### ③ 历史污染清理：`mine.cjs --forget-echo [--apply]`（`cli.cjs` + `engine.forgetEchoDeferred()`）

**修法**：用同一套回声判定回头清理**暂存**（默认**干跑**列清单，`--apply` 才删；写盘走同一把写锁）。**实测执行**：命中 13 组 / 剩余暂存 **18 → 5**（保留的正是 5 条真实发现：沙箱拒写、DNS/TCP443 不通、SSH 公钥被拒、工具调用超时、未知工具名），`seenFingerprints` 215 与 `nextCandidateId` 137 均未受影响。`engine.selftest` +5（签名口径/稳定性/不吞并不同内容 + 干跑不动数据 + apply 保留真实故障）。

### ④ 双计口径加固（审计第 5 项：实测**未发生**，改为钉住结论）

**实测方法**：制造一次真实工具失败 → 等 3s 让实时采集落盘（`events=1 flushes=1 deferGroups=1`，指纹 215→216）→ 立刻跑 `mine.cjs --check` 重扫同一会话日志（`scanned=1 / 53ms`）。结果：该事件在 `state.deferred` 里 **`n=1` 且 `first == last`**（若被两侧各记一次应为 2），指纹数与聚簇数不变；指纹身份核对 **25/25 的 sid 与磁盘会话目录名一致**、按 `at|hash` 分组 **0 组出现两个不同 sid**。结论：live 与批扫对同一物理事件产出**完全相同**的指纹，不存在双计。**修法不是改指纹**（迁移 215 条历史指纹的风险大于收益），而是把结论钉住：`live` 增 `toolUnknown`（工具名退化成 `?` 的次数——`tool` 是聚簇键的一部分，是唯一残留的双计路径，长期为 0 即为证伪）与 `skippedByFingerprint`（因指纹已见而跳过的条数，是"两侧共用同一指纹"的正面证据），并入 `GET /whale/live` 的 `dedup`；`live.selftest` 增不变量断言「live 与批扫指纹逐字节一致」。

**验证汇总**：10 套件 **409 PASS / 0 FAIL** ＋ `bundle-smoke` ＋ `redact.test` 22 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28 ＝ 13 个测试文件 PASS 累计 **502**（2026-09-12）。新增/变化：`repo.selftest` 23→28、`engine.selftest` 21→26、`e2e.selftest` 63→66、`live.selftest` 35→45。
**生效**：回声判定与幂等落档、`--forget-echo` 在**批扫侧立即生效**；`lib/index.js` 新增的 `/whale/live` 观测字段属宿主半边，需**先 `deploy-web --apply` 再重启 `dsh web`**。
**未做（保留给批次 B/C）**：`/whale/scan` 异步化（分片让出事件循环）、`--rebuild` 维护窗口、漂移守卫（`lifecycle check` 恒 exit 1；附带发现 AGENTS 条目登记为 `whole` 模式、而该文件已含用户「手动段」→ 卸载会整文件删除，需先改 `zones`，用户要求稍后单议）。

## v0.7.5（2026-09-11）端点闸门（防跨站/防重绑定）· 采集健康度可观测

**起因**：接 v0.7.4 的审计，修其中「安全」与「可观测」两类里最要紧的两项（用户指定）：**任意网页能否打到本机端点** 与 **采集会不会静默停摆而无人知道**。

### ① 8 个 `/whale/*` 端点加统一闸门（`lib/index.js` + `src/ui/server.cjs`，审计 N3/N4）

**问题**：端点无鉴权、无 Origin/Host 校验。实测（改前）带 `Origin: https://evil.example` 的 `POST /whale/scan` 返回 **200** —— 任意网页都能对 `127.0.0.1:3080` 发跨站 POST 产生**副作用**（删候选、触发扫描；候选号空间只有 C001–C999，可被穷举把整箱移入归档）；`readJsonBody` 也不校验 `Content-Type`，跨站"简单请求"（`text/plain`）连预检都不触发。DNS rebinding 侧：宿主路由层用字面量 base 解析 URL、不校验 `Host`，插件侧无白名单 → 重绑定后可以同源身份**读**数据。

**修法**：新增纯函数 `server.guardRequest()`，在 `wrap()` 里对全部 8 个端点统一执行三道闸门——
1. **Host 必须回环**（`127.0.0.1` / `localhost` / `[::1]`，端口任意）→ 否则 403。这是 DNS rebinding 的正解（`Sec-Fetch-Site` 对同源重绑定无效）；
2. **Origin/Referer 若存在必须回环** → 否则 403；
3. **`Sec-Fetch-Site` 若存在必须是 `same-origin`/`none`** → 否则 403；
4. **写操作（POST）必须 `Content-Type: application/json`** → 否则 415（跨站简单请求就此失效；浏览器必发预检，而本服务不答 CORS）。

**验证**：`server.selftest` +13 断言（含反证：本机面板、`localhost`、`[::1]`、无 Host 探针、同源 Origin、GET 无 CT 一律放行）；另用 mock ctx + mock req/res 直连 `lib/index.js` 做了**接线验证**：回环 GET → 200、`Host=evil.example` → 403、跨站 Origin → 403、`Sec-Fetch-Site: cross-site` → 403、`text/plain` 写请求 → 415、跨站删除 → 403（未到业务层）、回环删除 → 到业务层（404 不存在）。**未改面板：它本就发 JSON、本带回环 Host。**

### ② 采集"静默停摆"可见化（`src/collector/decoder.cjs` + `engine.cjs` + `scanner.cjs` + `lib/index.js`，审计 N20/N25）

**问题**（三条都指向同一件事：出事了没人知道）：
- **环境降级**：旧 Node 上 `require('node:zlib')` 不报错但 `zstdDecompressSync` 是 `undefined` → 每帧解压都抛、事件恒 0、`offset` 永不推进，而 CLI 仍以 0 退出并打印「新发现 0 条」；实时采集完全不读日志，也无感。
- **帧扫描越界**：`scanFrames` 直接读块头，末尾半写帧会让它抛 `ERR_OUT_OF_RANGE`，被上层当成"整文件解码失败"（`badFiles++`、水位线不更新）——**与真正的中段损坏长得一模一样**。
- **中段损坏**：坏帧之后的所有日志**永远**读不到（每轮都在同一处重试），输出里只有一句「待重试 N」，既不落 state，面板与 `/whale/live` 也看不到。

**修法**：① `decoder` 增 `zstdAvailable()/assertZstd()`：能力缺失时 `runScan` **明确失败**（CLI 非 0 退出、端点 500），不再"0 事件 + 成功"；② `scanFrames` 全量边界检查并改出 `scanFramesEx()`，返回 `{frames, end, reason}`：`eof` = 尾巴没写完（正常重试）、`bad` = 帧头不自洽且后面还有数据（中段损坏）；③ `decodeLinesFrom` 据此给出 `corruptAt = 'mid' | 'tail' | null`，`scanner` 透传；④ `scanHistory` 计 `corruptFrames`，把 `badRounds` 写进水位线，**连续 ≥2 轮**把文件记进 `stuckFiles`；⑤ 扫描健康度落 `state.lastScanStats`（路径只留 `sid/文件名`，不落个人目录），CLI 扫描行与 **`GET /whale/live` 新增 `zstd` / `scan` / `stuckWatermarks` / `diag`** 四个字段。

**验证**：`engine.selftest` +10 断言（正常帧、半写尾帧不算损坏、半个帧头不抛、中段 magic 错位 → `mid`、`badRounds` 递进到 `stuckFiles`、健康度落 state）；本机 `dsh web` 实测运行在 `C:\Program Files\nodejs\node.exe` v24.19.0，`zstdDecompressSync` 可用 —— **当前没有静默停摆**，本版是把它变成"将来一定会被告警"。

**验证汇总**：10 套件 **386 PASS / 0 FAIL** ＋ `bundle-smoke` ＋ `redact.test` 22 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28 ＝ 13 个测试文件 PASS 累计 **457**（2026-09-11）。
**生效**：改动含宿主半边（`lib/index.js`、`src/**`）→ **先 `deploy-web --apply`，再重启 `dsh web`**；`mine.cjs` 批扫立即生效。

## v0.7.4（2026-09-11）安全审计 P0 三项：打码补漏 · 状态文件完整性 · 归档签名修正

**起因**：对 v0.7.3 做了一次三路只读审计（安全/隐私面、采集流水线健壮性、文档与代码一致性），共记录 29 项缺口（详见 `docs/2026_09_11_11_whale-notebook安全与健壮性审计报告.md`）。本版修其中**三项高危**（P0）＋ 四项顺带小修，全部带回归断言。

### ① 打码对最常见几类凭据失效（`src/core/privacy.cjs`）

**问题**：关键词规则的值部分 `[^"',;\s]{6,}` 不能跨空格 —— `Authorization: Bearer <token>` 只吃掉 `Bearer`，**令牌落在匹配之外**；`\bsecret\b` 在下划线标识符里没有词边界，`AWS_SECRET_ACCESS_KEY` / `client_secret` 整类漏网；长串兜底阈值 48 放过 40 位 AWS secret 与 `sk_live_`/`xoxb-`/`npm_`/`AIza`；完全没有 URL 内凭据规则。实测（假值直调 `redact()`）这些形态**全部原样落进** `inbox.md` / `details/` / `archive/` / `state.deferred[].excerpt`，并经 `/whale/inbox/detail` 逐字节返回浏览器。
**修法**：新增四组规则并置于旧规则之前 —— ① 认证头打码（`authorization`/`cookie`，值吃到行尾或下一个引号，**保留同一行后面的 URL**）；② URL 内凭据 → `scheme://[REDACTED]@`；③ 已知前缀令牌（Stripe / Slack / npm / Google / GitHub app / GitLab / SendGrid）；④「密钥名 = 值」（**去掉 `\b`**，支持 JSON 的 `":"` 形态与引号值）。**不含凭据的文本输出逐字节不变**，故普通文本的 `canonText`/指纹不漂移。
**自检**：`privacy.selftest` +13、`redact.test` +9，含反证「凭据头后面的 URL 仍保留」「普通文本不出现 `[REDACTED]`」。

### ② `state.json` 损坏即静默归零并覆盖（`src/store/repo.cjs`）

**问题**：`readJson` 的 `catch` 把「非法 JSON」「文件被占用」「权限不足」一律当成「读不到 → 用空状态」，而同一次 `runScan` 会把空状态落盘 → 水位线/指纹/聚簇/暂存**无备份消失**，`nextCandidateId` 归 1 → 从 C001 重开并与归档撞号；`/whale/live` 只显示三个 0，**不报任何错误**。
**修法**：① `readState` 改走**严格读**：只有 `ENOENT` 算「没有历史」，其余抛错；内容损坏先把文件改名 `state.json.corrupt-<ts>` 留证再抛；② 临时文件名带 `pid + 序号`（`state.json.<pid>.<n>.tmp`，`inbox.md` / `details/C###.md` 同款）—— 两个进程不再互踩同一个 `.tmp`；③ `writeState` 前 **CAS 比对 `size+mtimeMs`**，变了就把磁盘那份**并集合并**后重放（水位线取更靠前、聚簇/暂存并集取大计数、指纹并集、编号取 max、`lastScan` 取 max）；④ 新增 **`state.lock` 跨进程写锁**（`wx` 原子创建、>15s 陈旧锁可回收、`EEXIST` 才等待），CLI 扫描 / 实时 flush / 面板删除共用（实时侧拿不到锁会把事件放回缓冲，绝不带风险写盘）；⑤ **编号下限** = `max(state, 在箱最大, 归档最大+1)`。
**自检**：新增 `src/store/repo.selftest.cjs`（23 断言）。

### ③ 归档「已处置」签名 63% 失配（`src/collector/engine.cjs` + `live.cjs`）

**问题**：历史遗留的 8 列「空列」形态（`… | 现象 | 时间 |  | 处置 |`）让 `parts[last-1]` 变成空串 → 兜底循环第一轮就停住 → 时间被并进现象文本；而时间列是**整列** `YYYY-MM-DD HH:mm`，只认 `^\d{4}-\d{2}-\d{2}$` 也弹不掉。**实测复算：130 行归档里 82 行（63%）签名永久失配** → `--rebuild` 或 state 重置后，这些"已处置"的坑会被重新开行。另有第二类死签名：复发行现象列的 `复发（原 C0xx）：` 前缀；且**实时采集路径压根没传 `resolved` 索引**（重置后撞见同内容会立刻开新行，与 CLI 行为不一致）。
**修法**：① 现象列先**剔空列**再走兜底循环，兜底判据补 `ARCHIVE_TIME_RE`；② `resolvedSig` 归一化掉复发前缀（索引构建与在箱剔除两端同时生效）；③ 新增 `loadResolvedCached()`（按 `archive-*.md` 的 name/size/mtime 缓存索引与归档最大编号）供实时路径使用；④ `live.cjs` 每次 flush 传入该索引。
**自检**：`engine.dedup.selftest` +5、`live.selftest` +1；复算脚本「污染行数」由 82 → 0。

### 顺带修复（同批审计的低危项）

- **sidecar 泄露会话日志绝对路径**（`engine.cjs`）：源引用行原来直接拼 `${ev.file}`，实测 119 个归档 sidecar 里 92 个含用户名与目录结构；现过 `redactLines`（折叠为 `<path>`）。同时修掉**实时来源无 `file` 字段时输出字面 `undefined`**（改为「（实时采集，无日志文件）」）。
- **编号放宽 `^C\d{3,}$`**（`repo.cjs` / `server.cjs` / `scanner.cjs`）：编号过 999 后原来会导致 sidecar 写入静默失败、详情与删除端点一律 400。
- **`--prewarm --dry` 零写盘**（`engine.cjs`）：prewarm 分支此前缺 `--dry` 守卫。
- **面板删除改原子写**（`repo.cjs`）：`removeInboxRows` 原来直接 `writeFileSync` 重写 inbox，现与其它路径统一走 tmp+rename。

**验证**：10 套件 **363 PASS / 0 FAIL**（lifecycle 104 · server 50 · privacy 23 · summarize 10 · similarity 20 · repo 23 · engine 11 · engine.dedup 24 · e2e 63 · live 35）＋ `bundle-smoke` ＋ `redact.test` 22 ＋ `links-doctor.selftest` 43 ＋ `discuss-route.selftest` 28 —— 13 个测试文件 PASS 累计 **434**，全绿（2026-09-11）。
**生效**：改动含宿主半边（`lib/index.js`、`src/**`）→ **先 `deploy-web --apply`，再重启 `dsh web`**；`mine.cjs` 增量批扫与 `--stats` 立即生效。

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
| `plugin/lifecycle/selftest.cjs` | 120 |
| `plugin/src/ui/server.selftest.cjs` | 63 |
| `plugin/src/core/privacy.selftest.cjs` | 23 |
| `plugin/src/core/summarize.selftest.cjs` | 10 |
| `plugin/src/core/similarity.selftest.cjs` | 20 |
| `plugin/src/store/repo.selftest.cjs` | 34 |
| `plugin/src/collector/engine.selftest.cjs` | 35 |
| `plugin/src/collector/engine.dedup.selftest.cjs` | 24 |
| `plugin/src/collector/e2e.selftest.cjs` | 67 |
| `plugin/src/collector/live.selftest.cjs` | 48 |
| **合计** | **444**（+ `scripts/bundle-smoke.cjs` 结构断言 + `scripts/redact.test.cjs` 22 断言 + `scripts/links-doctor.selftest.cjs` 43 + `scripts/discuss-route.selftest.cjs` 28 ＝ 13 个测试文件 PASS 累计 **537**） |

最近一次全绿：**2026-09-12**（v0.7.7）。
