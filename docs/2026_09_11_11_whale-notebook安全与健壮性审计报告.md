# 鲸鱼闪闪发光的小本本（whale-notebook）· 安全与健壮性审计报告

> 日期：2026-09-11 ｜ 版本：针对 v0.7.3（源码与部署副本 SHA256 逐字节一致）｜ 类型：调查/分析报告（只读审计）
> 配套文档：架构事实看 `2026_09_10_16_whale-notebook架构全景图.md`；A/B 批次修复记录看 `2026_09_10_17_whale-notebookAB批次修复开发实施计划.md`。
> **口径**：编号 N1–N29 与全景图 §11.2 / §11.3 一一对应。等级＝「真实可利用性 × 影响面」，理论可能性单列在 §5。

---

## 1. 结论摘要（先看这一页）

- **架构与隐私设计成立**：数据不出本机、无出站网络、无第三方依赖、无 `eval`/`innerHTML`、路径穿越与 XSS 均不可达（§4 给出 20 项正面证据）；删除是「移入归档」而非销毁，可恢复。
- **本轮共记录 29 项缺口**：**高 3 · 中高 1 · 中 13 · 低 12**。它们不是「设计错了」，而是**承诺与实现之间的缝**——尤其集中在「隐私打码」「已处置守卫」「状态文件完整性」三处。
- **最该先修的三项**（都不改动架构，都是小改）：
  1. **N1 打码对最常见凭据失效**——`Authorization: Bearer …` 只打掉 `Bearer`，令牌原样进 `inbox.md`/`details/`/`archive/`/面板，并可能被归纳进 **`AGENTS.md` 自动段（注入本机每个会话）**。
  2. **N18 归档「已处置」签名 63% 失配**——`--rebuild`/状态重置后，这些坑会被当成新坑重复开行（复发守卫形同虚设）；实时路径甚至根本不查该索引。
  3. **N19 `state.json` 损坏即静默归零并覆盖**——读失败被当成「空状态」，同一次调用把空状态落盘，水位线/指纹/聚簇/暂存无备份消失、编号从 C001 重开并与归档撞号。
- **一条重要澄清**：本报告**没有发现**「数据外泄到本机之外」的路径。最敏感的风险是**本机内的数据卫生**（凭据落盘、个人路径落盘）与**状态文件完整性**。
- **修复成本**：三项 P0 合计约 60–100 行代码 + 若干测试断言；其余多为一行级修补。**不需要重构**。

---

## 2. 审计范围与方法

| 项 | 内容 |
|---|---|
| 审计对象 | `~/.dsh/whale-notebook/plugin/**`（权威源，v0.7.3）＋ 数据目录 `~/.dsh/whale-notebook/**` ＋ 部署副本 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-whale-notebook/**` |
| 三路分工 | ① 安全/隐私面（端点、打码、注入、外泄面）② 采集流水线健壮性（并发、状态一致性、边界、增长、错误吞噬）③ 文档与代码一致性（含版本/口径核对） |
| 运行态探针（全部只读） | 6 个 GET 端点 + 1 次 `POST /whale/scan`（面板 ⟳ 的同款调用，用于测 CSRF 与耗时）；`mine.cjs --check`（增量）/ `--stats`（纯只读全量）；`deploy-web --check`；`lifecycle check`；12 个测试套件实跑；`Get-NetTCPConnection` 看监听地址 |
| 数据面只读复算 | 用真实 `archive-*.md` + 真实 `state.json` 在内存内调用引擎的纯函数（`parseArchiveRow` / `resolvedSig` / `loadResolvedIndex`）复算签名失配率；用假值调用 `redact()` 复核打码覆盖；统计 sidecar 里的未打码路径 |
| 明确**未做**的事 | 未重启 `dsh web`；未写任何数据文件；未执行会写盘的 `mine.cjs --add/--rebuild/--prewarm`；未做破坏性验证（未删候选、未改 state）；未实测浏览器端 CSRF/rebinding（需在浏览器里操作，见 §5） |
| 一致性前提 | 部署副本与权威源 **SHA256 9/9 一致（43 文件全量对账亦全同）** → 下文行号结论对**实际运行的代码**成立 |

---

## 3. 高严重度（3 项）

### N1 打码对最常见几类凭据实际失效（隐私承诺被绕过）

- **位置**：`src/core/privacy.cjs:16`（关键词规则）、`:18`（≥48 位长串规则）
- **机理**：① 关键词规则的值部分 `[^"',;\s]{6,}` 不能跨空格，`Authorization: Bearer <token>` 只吞掉 `Bearer`，令牌落在匹配之外；② `\bsecret\b`/`\btoken\b` 在 `AWS_SECRET_ACCESS_KEY`、`client_secret` 这类**下划线标识符**里没有词边界，整类 snake_case 密钥名不命中；③ 长串阈值 48 位偏大，放过 40 位 AWS secret、`sk_live_`、`npm_`、`AIza`（39 位）、`xoxb-`；④ 完全没有 URL userinfo（连接串/克隆 URL 里的口令）规则。
- **实测（本轮，用假值只读调用 `redact()`）**：

  | 输入形态 | 打码结果 |
  |---|---|
  | `Authorization: Bearer <token>` | ❌ 只打掉 `Bearer`，**令牌原样保留** |
  | `Authorization: Basic <b64>` | ❌ 完全未打码 |
  | `Cookie: sessionid=…; csrftoken=…` | ❌ 完全未打码 |
  | `AWS_SECRET_ACCESS_KEY=<40位>` / `{"client_secret":"…"}` | ❌ 完全未打码 |
  | `https://user:<pw>@host/x.git` / `postgres://u:<pw>@host/db` | ❌ 口令未打码 |
  | `sk_live_…` / `npm_…` / `AIza…` / `xoxb-…` | ❌ 完全未打码（长度不足 48） |
  | `password=…` / `api_key` / `sk-…(≥16)` / `ghp_` / `AKIA` / `JWT` / ≥48 位长串 / 反斜杠家目录路径 | ✅ 正常打码 |

- **影响与触发场景**：候选文本来自**任意工具失败输出**（`scanner.cjs:101`）与**真实用户报障原文**（`scanner.cjs:122`）。终端里一次 `curl -H "Authorization: Bearer …"` 失败、`psql postgres://u:pw@…` 报错、`env` 转储、`git clone https://u:pw@…` 失败，都会把**未打码凭据**带进 `inbox.md` / `details/C###.md` / `archive/` / `state.deferred[].excerpt`，并在面板 `/whale/inbox`、`/whale/inbox/detail` 原样显示；随后还可能被 agent 读 sidecar 后概括进 `entries/` 与 `~/.dsh/AGENTS.md` 自动段——**后者注入本机每一个会话的模型上下文**。
- **存量核查**：对 `inbox.md`、`details/`、`archive/`、`state.json` 检索上述形态，**当前命中 0**（说明无历史泄漏，但一次真实故障即可引入）。
- **最小修复**（`applyRules` 前部加三条独立规则，按整值打码）：
  1. `/(?:proxy-)?authorization\s*:[^\r\n]*/i` → `authorization: [REDACTED]`；
  2. `/[A-Za-z0-9_]*(?:secret|token|passwo?r?d|pwd|apikey|api_key)[A-Za-z0-9_]*\s*[:=]\s*\S+/i`（**不用 `\b`**）；
  3. `/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@/i` → `$1[REDACTED]@`；长串阈值 48 → 32，并补 `xox[bpoas]-|npm_|sk_live_|AIza|ya29\.` 前缀；`Cookie:` 整行打码。
- **验收判据**：`redact.test.cjs` 增加上表全部形态的断言且全绿；对样例文本 `Authorization: Bearer <fake>` 的 `redact()` 输出中不再出现 `<fake>`。

### N18 归档「已处置」签名大面积失配（复发守卫形同虚设）

- **位置**：`src/collector/engine.cjs:57-76`（`parseArchiveRow`，尤其 `69-73`）、`:47-51`（`SIG_TEXT_MAX=90`）、`:86`；实时侧 `src/collector/live.cjs:75`；批扫侧 `engine.cjs:643`
- **机理**：解析器从两端取列，只把尾部「纯日期/纯时刻」列弹掉；历史遗留的 **8 列「空列」形态**（旧版 `deleteCandidate` 直接续写造成，`server.cjs:130` 于 v0.7.3 才修）尾部是**空串**，`while` 判据匹配不到 → 时间列被并进现象文本，`resolvedSig` 与引擎聚簇文本永不相等。另有 readd 行带 `复发（原 C0xx）：` 前缀，同样永不匹配。
- **实测（本轮独立复算，用真实归档数据）**：

  | 指标 | 实测值 |
  |---|---|
  | `archive-*.md` 中有处置列的行 | **130** |
  | 解析出的现象文本被污染（带 `｜ 时间 ｜ ` 尾巴）的行 | **82（63%）** |
  | `loadResolvedIndex()` 索引条目数 | 98 |
  | 其中带 `复发（原 C0xx）：` 前缀、永不匹配的签名 | 4 |

- **影响**：`--rebuild` 或 state 丢失/损坏后重扫历史时，这些坑的「已处置」守卫**不生效** → 面板已处理过的候选**重复开行**（正是 v0.6.2 想修的问题）。**加剧项**：`live.cjs:75` 调用 `ingestFresh` 时未传 `resolved`（第 4 个参数缺失 → 引擎用空 `Set`），所以 state 重置后**实时采集撞见同内容会立刻开新行**，而 CLI 扫描会被压掉——两个入口行为不一致。
- **反向风险**：现有代码与数据下**不会**出现「误判已处置而压掉真问题」（错误签名只会失配不会误命中）。
- **最小修复**：① 兜底 pop 前先剔除空列；② 现象列定义为「第 5 列到第一个日期/时刻列之前」；③ `loadResolvedIndex` 加自检——签名里若含 `\d{4}-\d{2}-\d{2} \d{2}:\d{2}` 判为解析失败并 warn；④ readd 前缀移出或去掉，保证「现象列 = 聚簇文本」；⑤ `live.cjs` 传入 `loadResolvedIndex()`（宿主内按 mtime 缓存）；⑥ `engine.dedup.selftest.cjs` 补第 3 种真实行形态（8 列空列）——现测试只覆盖 7 列与含半角 `|` 两种，所以这个 bug 从未被捕获。
- **验收判据**：新增断言「8 列空列行解析出的文本 == 聚簇文本」「readd 行签名可命中」；复算脚本的「污染行数」降为 0。

### N19 `state.json` 损坏或读失败 → 静默归零并覆盖

- **位置**：`src/store/repo.cjs:28-30`（`catch { return def }`）、`:61`（`readState`）、`:50-60`（`normalizeState`）；写回点 `engine.cjs:574/632/645`
- **机理**：`readJson` 把「非法 JSON」「文件被占用」「权限不足」**一律**当成「读不到 → 用默认值」，而 `emptyState()` 会清空 `files/clusters/deferred/seenFingerprints` 并把 `nextCandidateId` 归 1；紧接着同一次 `runScan` 就把这个空状态落盘。
- **影响**：水位线/指纹/聚簇/暂存**无备份消失**（下轮要重解全部历史，实测全量解码 32 文件 / 44.43MB / 5.1s）；编号从 C001 重开并与 archive 里 C001–C136 **撞号**（面板删除/详情按编号匹配会命中错误行）；冷却状态丢失 → 已处置坑立即重开。`/whale/live` 只会显示 `watermarks: 0 / clusters: 0 / fingerprints: 0`，**不报任何错误**。
- **最小修复**：`readJson` 区分 `ENOENT`（返回初值）与其他错误（抛出并在 `/whale/live` 暴露）；解析失败先把坏文件改名为 `state.json.corrupt-<ts>` 再重建；`writeState` 前做一次 JSON 往返自校验；state 增加 `rev` 字段配合写时 CAS。
- **验收判据**：在 `DSH_WHALE_NB_DIR` 指向的**临时副本**里放一个非法 JSON，`--check` 应报错并留下 `.corrupt-*` 备份，`/whale/live` 应显示错误而非三个 0。

---

## 4. 中高 / 中 / 低严重度（26 项，按等级分组）

### 4.1 中高（1 项）

| # | 缺口 | 要点与证据 |
|---|---|---|
| N20 | 解码失败被静默吞掉，采集可静默停摆 | `decoder.cjs:75-79` 不区分「文件末尾半写帧」（设计如此）与「已消费帧之后损坏」（意味着**该帧之后永久不再被扫描**），输出只有「待重试 N」。最危险的是环境降级：`zstdDecompressSync` 需 Node ≥22.15/23.8，**宿主进程若用旧 Node**则每帧都抛错 → 事件恒 0、退出码仍 0、打印「新发现 0 条」，live 侧完全无感（live 不读日志）。修复：启动探测 API 是否存在（缺失即明确报错）；失败分类并落 `badRounds`，连续 ≥2 轮升级为可见错误 |

### 4.2 中（13 项）

| # | 缺口 | 要点与证据 |
|---|---|---|
| N2 | sidecar 写入未打码的会话日志绝对路径 | `engine.cjs:701` 直接拼 `${ev.file}`（`file` 由 `:179` 从批扫补入，是绝对路径），**从未过 `redact`**——而 `privacy.cjs:22` 本会把这类路径折叠成 `~`。实测：`archive/details/` **119 个文件中 92 个含 `C:\Users\<user>\.dsh\sessions\…`，共 99 处**；该文本还会经 `GET /whale/inbox/detail` **逐字节**返回浏览器 |
| N3 | 8 个 `/whale/*` 端点无鉴权、无 Origin 校验（CSRF） | 任意网页可跨站 POST 产生**副作用**（删候选、触发扫描）；`readJsonBody` 不校验 `Content-Type`，`text/plain` 简单请求即可绕过预检。实测带 `Origin: https://evil.example` 的 `POST /whale/scan` 返回 **200**。缓解：服务只监听 `127.0.0.1:3080`；浏览器侧还有 Local/Private Network Access 策略（见 §5） |
| N4 | DNS rebinding：宿主路由层不校验 `Host` | 根因在宿主（`dsh-host-webserver` 用字面量 base 解析 URL，`Host`/`Origin` 不参与路由），插件侧也无 Host 白名单 → 重绑定后可以**同源身份读到** `/whale/*` 全部数据。修复正解是 Host 白名单（`Sec-Fetch-Site` 对同源重绑定无效），需宿主层配合 |
| N5 | `state.json` 并发「丢失更新」 | CLI 与宿主实时采集各自 `readState → 加工 → writeState`，**无锁、无 CAS、无读回合并**；`runScan` 读在 `engine.cjs:570`、写在 `645`，中间可能是**秒级**全量解码，窗口内 live flush 的指纹/水位线/暂存被整体覆盖。临时文件名固定 `<file>.tmp`（`repo.cjs:32/103/148`），两写者相撞可致 `rename` ENOENT（异常被吞）。已知必然重叠场景：`AGENTS.md` 自动段要求**每个新会话开始时跑 `mine.cjs --check`**，而宿主一直在后台写 |
| N21 | `--rebuild` 会被实时采集整段回滚，却打印成功 | CLI 清空派生状态后写回（`engine.cjs:592-597/645`），期间任何一次 live flush 会把**旧** state 写回 → 重建撤销，而 CLI 已打印成功。半清空中间态更糟：水位线推进而聚簇被清 → 历史坑因 `engine.cjs:168` 的跳过规则**永久漏采** |
| N22 | 同一物理事件可能被 live 与批扫各计一次 | 指纹 `sid\|at\|hash36(cat\|tool\|body)`（`engine.cjs:32-39`）对时间/工具名/文本漂移敏感；live 与落盘记录的 `time` 不一致、或 `tool` 退化成 `'?'` 时，同一事件被两个入口各开一行/各 bump。现场线索：当日 echo 档出现**逐字相同的两行、各 `n=1`**（两批 ingest 各写一行） |
| N23 | 编号跨过 C999 后一套功能静默失效 | `padStart(3)` 产出 `C1000`，而 `repo.cjs:145/154/160` 与 `server.cjs:11` 全用 `^C\d{3}$` → 详情写入返回 `false`（调用方 `engine.cjs:415-418` 不检查返回值）、详情/删除/related 端点一律 400。当前 `nextCandidateId=137` |
| N24 | 资源增长无上限；echo 档自我放大（已实测） | `clusters` 永不裁剪；入库流程用 `edit` 手改 inbox（不走 `removeInboxRows`）→ sidecar 永久留在 `details/`；**echo 行命中 `META_DUMP`** → 打印 echo 档的输出被再判为回声、再追加（审计期间 `echo-20260911.md` 380B→938B）；`state.files` 占 state.json 65%（含 2541 条 callId→工具名映射）；live 的 `sessions` Map 单调增长 |
| N25 | 可观测性缺口：半瘫不可见 | `lastError` 成功后不清（一直显示旧错）；`writeState` 持续失败时是「inbox 行在增、水位线/指纹不推进」的静默半瘫；`badFiles/retryPending/resets/dropped/suppressed` **都不落 state**，只在 CLI 文本或 `/whale/scan` 的一次性响应里出现 |
| N7 | `/whale/scan` 同步执行扫描 | `lib/index.js:166` 同步调用 `engine.runScan`，占用宿主事件循环：增量 ≈ 83–100ms 无感，但全量解码实测 **5084ms**（32 文件 / 44.43MB，`loadResolvedIndex` 还同步读 25KB+30KB 归档）——`settings.scanMode='full'` 或水位线失效时，点一次 ⟳ 面板与 GUI 一起卡住；且 `scanning` 标志只挡同进程 |
| N8 | 回声过滤仍有漏网（自我污染） | 暂存 14 组中至少 7 组是采集器自身/本会话诊断输出（`state.json` 转储、`/whale/solved` 响应、`listEntries`/`clusters` 样本、编码探针）；`META_STRONG/WEAK/DUMP` 对「通用转储 / 自家 API 响应」覆盖不足（如 `/whale/related` 的 `{"ok":true,"id":"C…"}` 形态不命中任何签名）。拉取式下只暂存不打扰，但 `--add` 后进待审箱 |
| N6 | 面板删除候选走非原子写 | `repo.cjs:120`（`removeInboxRows`）直接 `writeFileSync` 重写整个 `inbox.md`，未走同文件的 `writeInboxText`（`102` 的 tmp+rename 原子路径）；唯一调用者是面板 ✕（`server.cjs:131`）→ 中断/并发可**截断用户待审箱**；删除还是「先 append 归档 → 再重写 inbox」两步非事务 |

### 4.3 低（12 项）

| # | 缺口 | 要点与证据 |
|---|---|---|
| N26 | `--prewarm --dry` 仍写盘 | `engine.cjs:629-632` 的 prewarm 分支**缺 `if (!o.dry)` 守卫**（对照 `:574`/`:645` 都有）→ 以为只是预览，实际水位线+指纹已落盘，这批候选被永久消费 |
| N27 | CLI 未知参数被静默忽略 | `cli.cjs:24/39/41` 不校验未知 flag：`--dray` 会被当成「非 dry」**真的写盘**且退出码 0；`exitCodeOf` 把所有 `ok:false` 判 2，未来新增非「前置缺失」类失败会误报 |
| N28 | 死设置 `minOccurrences` | 默认值与现场 `settings.json` 都声明了「进箱最低出现次数」，但**全仓无读取点**；`checkEnabled` 也只影响 AGENTS 提醒文案（`agents.cjs:13`） |
| N29 | TOCTOU：目录类读取无兜底 | `engine.cjs:139`（工作区 `readdirSync`）、`repo.cjs:194`（`entries/`）、`repo.cjs:65`（`inbox.md`）都无 try/catch，而同层级的 `statSync:136`、单文件解码 `:172` 都有 → 会话目录被清理或被杀毒占用时整轮失败（CLI exit 1）或面板 500 |
| N9 | detail sidecar 源会话行渲染 `undefined` | 实时事件不带 `file`（批扫在 `engine.cjs:179` 才补）→ `details/C128.md` 实测出现 `｜SandBox1｜undefined`；超长摘录的「完整错误见源日志 undefined」同理 |
| N10 | 归档文件名按 UTC、处置戳按本地时间 | `repo.cjs:126/135` 用 `toISOString()` 命名，`server.cjs:16` 用本地时间 → UTC+8 环境 00:00–08:00 的归档会落到**前一天**的文件名里 |
| N11 | `state.json` 的 `files` 键是绝对路径（30 条） | 水位线键不经 `redact` → 含用户名与工作区路径，与「个人路径不落盘」口径不一致（本机数据，不外泄） |
| N12 | `familyThresholdSame/Cross` 未登记默认值 | `engine.cjs:109` 会读取，但 `SETTINGS_DEFAULTS` 与现场 `settings.json` 均无此键（缺省走 0.6/0.8）；文档曾把它列为开关 |
| N13 | `links-doctor` 的 `cmd /c rmdir` 兜底存在窄条件注入 | `links-doctor.cjs:123` 把目录名交给 `cmd.exe`；若扫描根内存在**名字含 `&`/`^` 的悬空链接**且 `rmdirSync`/`unlinkSync` 都失败，`--apply` 时 `&` 之后会被当第二条命令执行（需本地已存在恶意目录名，非远程可利用） |
| N14 | sidecar 围栏 / 条目 frontmatter 可被内容闭合 | `engine.cjs:704` 的 ```` ```text ```` 围栏不中和内容里的 ` ``` `；`schema.cjs:69-79` 的 `title/symptom/…` 未做 YAML 转义（只有 `rule` 转义引号）→ **提示注入面**（无代码执行），触发需模型原样搬运原文 |
| N15 | 面板「⚡ 自动处理」话术把日志派生文本标为「可信」 | `client.js:277/287` 的开场消息写「可信但已脱敏」+「按此纪律执行最小修改」；`AUTO_VISIBLE=false`（`:448`）使入口隐藏 → **当前不可达**，一旦恢复应升级为中 |
| N16 | 三处代码小瑕疵 | ① `lib/index.js:204` 注册日志只列 7 个端点，漏 `/whale/related`；② `client.js:447` 的 `alertTimer` 是死代码（只声明+clearTimeout，无赋值）；③ `client.js:510` 用了 `wh-foot-note`，CSS 里只有 `.wh-foot`（无对应规则） |
| N17 | 数据目录 `README.md` 版本行分叉 | `~/.dsh/whale-notebook/README.md:36` 仍写 `v0.7.0`，与镜像根 `README.md`（119 行、写 0.7.3）内容与版本口径都不一致（两文件本就不同：71 行 vs 119 行） |

---

## 5. 需运行态 / 人工确认的 10 项（附判据，本轮未执行）

| # | 要验证什么 | 判据（成立条件） |
|---|---|---|
| 1 | **宿主进程的 Node 版本与 zstd 可用性**（决定 N20 是否**已经在**静默停摆） | 宿主里 `typeof require('node:zlib').zstdDecompressSync !== 'function'` 且每轮 `--check` 报「待重试 N>0」而「新发现/暂存」恒 0 |
| 2 | **公网页 → `127.0.0.1:3080` 的跨站简单请求是否被浏览器放行**（决定 N3 是「可利用」还是「理论」） | 在非 localhost 页面执行 `fetch('http://127.0.0.1:3080/whale/inbox/delete',{method:'POST',mode:'no-cors',body:'{"id":"C0xx"}'})`，随后该编号从 `/whale/inbox` 消失 → 可利用；被 Local/Private Network Access 拦下 → 降为理论 |
| 3 | **rebinding 能读到多少**（决定 N4 的数据敏感度） | `/whale/inbox` 的 `rows[].text`、`/whale/inbox/detail` 返回中是否含用户名、内网主机名、仓库名、业务词 |
| 4 | **N1 的漏网格式是否有存量** | 对 `inbox.md`/`details/`/`archive/`/`state.json` 检索 `Bearer `、`Cookie:`、`://<user>:<pw>@`、`_secret=`、`sk_live_`、`xoxb-`、`npm_`、`AIza`：命中 >0 → 立刻轮换该凭据（本轮静态计数全为 0） |
| 5 | **同一物理事件是否被 live 与批扫双计**（N22） | 取当日 echo 档中 11:00 两条逐字相同的记录，到源会话日志数同文本 `tool/result` 条数：源 1 条而 echo 2 行 → 双计成立 |
| 6 | **并发丢更新现场复现**（N5，只观测，**不要用 `--rebuild`**） | 记录 `state.json` 的 `(size, mtimeMs, nextCandidateId, 水位线数, clusters 数, 指纹数)`；同一时间窗内 (a) 点面板 ⟳ (b) 另开终端跑 `--check`：出现「水位线/clusters 数回退」或「inbox 同号两行」→ 成立 |
| 7 | **`--rebuild` 被 live 回滚**（N21） | 重建前后比较 `(lastScan, 水位线数, clusters 数, 指纹数)`：CLI 打印「已清空…」但四元组回到重建前 → 被回滚 |
| 8 | **`state.json` 损坏恢复路径**（N19） | 在临时 `DSH_WHALE_NB_DIR` 放非法 JSON：`--check --dry` 是否静默返回空状态、`/whale/live` 是否三个 0 且无错误；再跑非 dry 看是否落盘空状态且不留 `.corrupt` 备份 |
| 9 | **echo 自我放大的量级**（N24） | 记录 `archive/echo-*.md` 的行数/字节数，然后在会话里用命令工具读一次该文件：行数 +≥1 即成立 |
| 10 | **`details/` 孤儿是否由入库流程产生**（N24） | 按技能流程走一次真实入库（用 `edit` 把候选行移入 archive）：`details/C###.md` 仍留在 `details/`、`archive/details/` 不新增 → 成立 |

---

## 6. 已核验无问题（正面清单，20 项）

**安全面**
1. **路径穿越不可达**：`^C\d{3}$` / `^E\d{3}$` 在 `server.cjs:50/102/110/118` 与 `repo.cjs:145/154/161` 双重校验，`readEntryText` 只按 `readdirSync` 结果前缀匹配后 `path.join`；URL 解码后的 `../`、`%2e%2e%2f`、`%00`、盘符、UNC 一律不匹配。
2. **XSS 不可达**：全仓 `innerHTML|insertAdjacentHTML|outerHTML|document.write|eval(|new Function` 命中 **0**；面板渲染统一 `textContent`/`createTextNode`（含条目全文、sidecar 全文、风险上报原文），`<style>` 亦经 `textContent` 注入。
3. **无出站网络**：宿主侧无 `http/https/net/dns/tls` 调用；浏览器侧 `fetch` 全部是同源相对路径 `/whale/*`，无绝对 URL、无埋点；`spawnSync` 只在生命周期/维护脚本与自测里。
4. **不写工作区、不碰 git**：写入路径被 `repo.cjs:14-26` 钉死在 `~/.dsh/whale-notebook/**` 与 `~/.dsh/AGENTS.md`；同步脚本只镜像 `plugin/`、`docs/*.md`、`scripts/{mine,redact.test}.cjs`、`PROJECT-INTRO.md` → **`inbox/details/archive/entries` 永不进 git 仓库**（因此 N2 的个人路径不会离开本机）。
5. **响应不带任何 CORS 头**：`sendJson` 只写 content-type，全仓无 `Access-Control-Allow-Origin` → 跨站**读响应体**不可行（但请求仍会执行，故 N3 成立）。
6. **HTTP 基本卫生**：所有响应带 `charset=utf-8`；body 上限 16KB（超限 reject + `req.destroy()`）；8 个端点各自校验 method 并回 405；删除端点对空/非字符串 id 回 400。
7. **监听范围**：`Get-NetTCPConnection` 实测只有 `127.0.0.1:3080`，LAN 地址不可达。
8. **删除语义安全、幂等**：删除＝移入当日归档（可恢复）；未知编号不写盘；`removeInboxRows` 只按行首编号匹配，不会删到别的行。
9. **归档/详情文件名无穿越**：`writeDetail`/`archiveDetail` 均要求 id 过 `^C\d{3}$`，目标目录是常量，重名才加 `Date.now()` 后缀，不做递归删除。
10. **浏览器侧不持久化候选内容**：`localStorage` 只写「讨论落点」模式字符串；无 cookie 写入。

**数据与隐私面**
11. **日志派生文本先打码再落盘**：`engine.cjs:279/286/296` 三处入口统一走 `redactLines`；现场侧证：数据目录 `~\.dsh` 出现 62 处、`[REDACTED]` 3 处。
12. **`state.json` 的 `calls` 与 `deferred.excerpt` 不含凭据**：`calls` 只记 `callId → 工具名`（实测值仅 `read/pwsh/grep/edit/glob/…`，无参数无文本）；`excerpt` 来自已 `redactLines` 的文本、截断 600 字。
13. **表格结构不可破坏**：`schema.cjs:57` 把 `|` 换全角 `｜`，`summarize.cjs:24` 把现象压成单行，解析端单一正则 `repo.cjs:77` 且 `bumpInboxRows` 只改第 3 列——实测在箱 2 行全部解析成功。
14. **inbox 行协议自洽**：写端/解析端共享同一契约，`PROJECT-INTRO.md` 的「现象列必须与聚簇文本一致」在**新写入**路径成立（N18 是历史遗留行的问题）。
15. **state 结构零迁移**：`normalizeState` 对旧 state 缺字段补默认，升级不崩。

**健壮性面**
16. **单进程内不存在读写交错**：live 的 flush 与 `runScan` 都在同一同步块内完成 read→write，JS 单线程下不会读到中间态；风险严格限于**跨进程**（N5）。
17. **tmp+rename 防撕裂本身正确**：三条写路径都是「写 tmp → rename」，单写者下不会产生半写文件；当前磁盘无 `.tmp` 残留。
18. **半写帧/截断检测正确**：不推进 offset 并置 `partial`，`mtimeMs=-1` 使下次必扫（实测 `mtimeMs=-1` 与 `offset<size` 均为 0 条）；`from > size` → 退回全量。
19. **指纹去重主路径有效**：`sid|at|hash` + 每轮 fresh 过滤，并有自测断言（反复重试不新增行、次数累加）；FIFO 截尾语义正确（实测 200/5000 未触发淘汰）；`deferred` 按最近出现保留最新（实测 14/200）。
20. **zstd 帧头解析与 RFC 逐条一致**、只读 offset 之后区间、无外部依赖；单文件解码失败按 `badFiles` 跳过（但见 N20 的分类缺失）；`--stats` 确认纯只读；CLI 退出码契约 0/2/1 三条路径均有测试覆盖。

---

## 7. 修复优先级与建议路线

> **实施进度（2026-09-11 当日回填）**：**v0.7.4 完成 P0 三项 + 四项顺带修**；**v0.7.5 完成 P1-1（N3/N4 端点闸门）与 P1-5 的一半（N20/N25 采集健康度可观测）**。源码与部署副本均已 `deploy-web --apply`（`--check` exit 0），宿主半边待重启 `dsh web`；未修项保留在下表。实施证据见本节末尾「实施记录」。

### P0（先做，直接影响隐私承诺与用户记忆完整性）

| 序 | 修什么 | 改动面 | 验收判据 |
|---|---|---|---|
| P0-1 | **打码补规则**（N1）：authorization/cookie 整行、URL userinfo、snake_case 密钥名、短前缀 token、长串阈值 48→32 | 仅 `core/privacy.cjs` | `redact.test.cjs` 增断言全绿；样例 `Bearer <fake>` 打码后不再出现 `<fake>` |
| P0-2 | **state 读写加固**（N19+N7）：`readJson` 区分 `ENOENT`；损坏先备份 `.corrupt-<ts>`；写入 tmp 名带 pid；`writeState` 前 CAS（比对 mtime/size，变了就 merge 重放）；`state.rev` | `store/repo.cjs` + `engine.cjs` 写回点 | 破坏性演练：非法 JSON 下不丢数据、有备份、有告警；并发演练水位线不回退 |
| P0-3 | **归档签名解析修正**（N18）：剔空列、现象列按「第一个日期列之前」取、索引自检 warn、readd 前缀移出、**live 传 `resolved`** | `engine.cjs` + `live.cjs` + 1 条新测试 | 复算脚本「污染行数」= 0；新增 8 列行 + readd 行断言 |

### P1（其次，中等风险或影响体验）

| 序 | 修什么 | 要点 |
|---|---|---|
| P1-1 | **端点最小防护**（N3/N4）：`Origin` 缺失或不等于本机源 → 403；要求 `content-type: application/json`；`Host` 白名单；并推动宿主层补 Host 校验 | 三件套一起做，跨站简单请求即失效 |
| P1-2 | **`--rebuild` 与实时采集互斥**（N21）：先取写锁 + 暂停 live（或 flush 后置标志），写完 CAS 校验 mtime，不一致则重试或明确报错 | 消除「打印成功但被回滚」 |
| P1-3 | **解码失败分类 + 启动探测**（N20）：区分「末尾半写帧」与「已消费帧之后损坏」，后者落 `badRounds` 并按轮升级为可见错误；`zstdDecompressSync` 缺失时明确报错 | 消除静默停摆 |
| P1-4 | **编号放宽为 `^C\d{3,}$`**（N23）：`repo.cjs` 三处 + `server.cjs`；`writeDetail` 返回值加检查 | 跨过 999 后功能不退化 |
| P1-5 | **可观测性**（N25）：`badFiles/retryPending/resets/dropped/suppressed` 落 state 并在 `/whale/live` 暴露；`lastError` 带时间戳与阶段；连续失败 ≥3 次在面板显示 | 半瘫可见 |
| P1-6 | **`/whale/scan` 异步化**（N7）：`setImmediate`/worker 或按文件分片；`scanning` 升级为写锁 | 点 ⟳ 不再卡 GUI |
| P1-7 | **sidecar 打码 + 修 undefined**（N2/N9）：该行改走 `redactLines`，`ev.file` 缺失时退回 `ev.ws` | 复算「含个人路径文件数」= 0 |

### P2（顺手修，低风险）

非原子写统一（N6）· `--prewarm --dry` 守卫（N26）· CLI 未知 flag 报错（N27）· `minOccurrences` 落地或删除（N28）· 归档日期本地化（N10）· `state.files` 键去绝对路径（N11）· echo 档轮转与 `clusters` 上限（N24）· `details/` 孤儿对账（N24）· TOCTOU 统一兜底（N29）· `links-doctor` 去掉 `cmd` 兜底（N13）· 围栏/frontmatter 中和（N14）· `familyThreshold*` 登记进默认值（N12）· 三处代码小瑕疵（N16）与数据目录 README 版本行（N17）。

> **P2 里的 N24（echo 自我放大）建议优先于其它 P2**：它是唯一一个**已被实测确认在发生**的增长型问题。

### 实施记录（2026-09-11，v0.7.4）

| 项 | 改动文件 | 验证证据 |
|---|---|---|
| **P0-1 打码补漏** | `src/core/privacy.cjs`（新增 4 组规则，置于旧规则之前；**不含凭据的文本输出逐字节不变**，普通文本指纹不漂移） | `privacy.selftest` 10→**23**、`redact.test` 13→**22**，含反证「凭据头后面的 URL 仍保留」「普通文本不出现 `[REDACTED]`」；实测 `Authorization: Bearer <假值>` 打码后不再出现假值 |
| **P0-2 state 完整性** | `src/store/repo.cjs`（`readJsonStrict` / `tmpNameFor` / `statOf` / `mergeStates` / `writeState` CAS / `state.lock` 写锁）、`src/collector/engine.cjs`（`runScan` 加锁 + 前置检查前移）、`src/collector/live.cjs`（异步取锁，拿不到就把事件放回缓冲）、`src/ui/server.cjs`（面板删除持锁） | 新增 `src/store/repo.selftest.cjs` **23 断言**（严格读/损坏留证/临时名/CAS 合并/锁互斥与陈旧回收/编号下限）；真实环境 `mine.cjs --check` exit 0、state 保持 v2 且 `nextCandidateId=137` 未膨胀、无 `.tmp`/`.lock`/`.corrupt` 残留 |
| **P0-3 归档签名修正** | `src/collector/engine.cjs`（剔空列 + 兜底补 `ARCHIVE_TIME_RE` + `resolvedSig` 归一化复发前缀 + `loadResolvedCached`）、`src/collector/live.cjs`（传索引） | 用**真实归档数据**复算：污染现象文本 **82/130（63%）→ 0/130**，死签名 0；`engine.dedup.selftest` 19→**24**、`live.selftest` 34→**35** |
| 顺带 N2/N9 | `engine.cjs`（sidecar 源路径过 `redactLines`，实时来源退化为「（实时采集，无日志文件）」） | `engine.selftest` 10→**11**；实测 sidecar 内不再出现 `session.jsonl.zstd` |
| 顺带 N23 | `repo.cjs` / `server.cjs` / `scanner.cjs`（`^C\d{3}$` → `^C\d{3,}$`） | 编号下限测试同时覆盖 4 位编号（repo.selftest ⑥） |
| 顺带 N26 | `engine.cjs`（prewarm 分支补 `!o.dry` 守卫） | 并入 repo/engine 断言与 `--dry` 语义 |
| 顺带 N6 | `repo.cjs`（`removeInboxRows` 改走 `writeInboxText` 原子路径） | `server.selftest` 50 断言全绿 |

**口径变化（供文档同步）**：源码自检由 **9 套件 320 断言** 变为 **10 套件 386 断言**（新增 `src/store/repo.selftest.cjs` 23 条；`server` 50→63、`engine` 11→21）；13 个测试文件 PASS 累计 **457**；`redact.test` 22。部署副本已 `deploy-web --apply`（`--check` exit 0），**宿主半边需重启 `dsh web` 生效**（`mine.cjs` 批扫立即生效）。

### 实施记录（第二批，v0.7.5）

| 项 | 改动文件 | 验证证据 |
|---|---|---|
| **P1-1 端点闸门（N3/N4）** | `src/ui/server.cjs`（新增纯函数 `guardRequest` / `isLoopbackHostHeader`）、`lib/index.js`（`wrap()` 统一过闸，覆盖全部 8 个端点） | `server.selftest` 50→**63**（+13，含反证：回环/`localhost`/`[::1]`/无 Host/同源 Origin/`same-origin`/GET 无 CT 一律放行）；**mock ctx 接线验证**：回环 GET 200 · `Host=evil.example` 403 · 跨站 Origin 403 · `Sec-Fetch-Site: cross-site` 403 · `text/plain` 写请求 415 · 跨站删除 403（未到业务层）· 回环删除到达业务层（404 不存在，未产生副作用）。面板未改（本就发 JSON、本带回环 Host） |
| **P1-5 一半：采集健康度（N20/N25）** | `src/collector/decoder.cjs`（`zstdAvailable`/`assertZstd`、`scanFramesEx` 边界检查、`corruptAt` 分类）、`engine.cjs`（`corruptFrames`/`badRounds`/`stuckFiles`/`persistScanStats`、zstd 缺失即 `ok:false`）、`scanner.cjs`（`corruptAt` 透传）、`lib/index.js`（`/whale/live` 增 `zstd`/`scan`/`stuckWatermarks`/`diag`）、`repo.cjs`（`lastScanStats` 归一化与合并） | `engine.selftest` 11→**21**（+10：正常帧、半写尾帧不算损坏、半个帧头不再抛 `ERR_OUT_OF_RANGE`、中段 magic 错位 → `mid`、`badRounds` 递进到 `stuckFiles`、健康度落 state）；**现场事实**：`dsh web`（PID 24956）运行在 `C:\Program Files\nodejs\node.exe` v24.19.0，`zstdDecompressSync` 与 `ZSTD_c_checksumFlag` 均可用 → 当前**未发生**静默停摆 |

**仍未修（P1 剩余 / P2）**：N7（`/whale/scan` 同步执行阻塞事件循环）· N21（`--rebuild` 与实时采集的窗口，现由写锁覆盖但未做"暂停 live"）· N22（live 与批扫双计，需生成实际计数）· N8（回声漏网）· N24（echo 自我放大，**唯一已实测在发生的增长问题**）· N10–N17 · N27–N29。

### 实施记录（第三批，v0.7.6 —— 对应 `docs/2026_09_11_14_whale-notebook五项遗留问题解决方案.md` 批次 A）

| 项 | 改动文件 | 验证证据 |
|---|---|---|
| **N8 + N24 回声自我放大**（本批最优先） | `src/collector/engine.cjs`（`echoSig`/`echoSigOf` 稳定签名、回声按签名分组、落档前读当日已有签名做幂等、`echoDupSkipped`、`dupFingerprints`）、`src/store/repo.cjs`（`readEchoSignatures`/`echoStats`/`ECHO_MAX_ROWS=400` 与 `echo-<日期>-2.md` 轮转）、`src/collector/scanner.cjs`（`META_ARTIFACT` 产物标识签名、API 信封判据、`isOwnOutput` 出处拦截、`cmdOf` 命令摘要 + 跨窗口继承）、`lib/index.js`（`/whale/live` 增 `echo`） | 实测基线：echo 归档 **231 行只对应 77 个现象**（55 个多行、单现象最多 8 行）。`live.selftest` +10（13 条真实漏网样本全命中 + **5 条真实故障反证 0 误伤** + 出处正例 1/反证 2 + 摘要继承）；`e2e.selftest` +3（**幂等：同一现象重复打印后归档行数不变**、`echoDupSkipped=3`、出处拦截）；`repo.selftest` +5（签名读回、轮转、跨分片去重） |
| **N22 live 与批扫双计**（原假设需修 → 实测**不成立**） | `src/collector/live.cjs`（`toolUnknown`/`skippedByFingerprint` 计数）、`lib/index.js`（`/whale/live` 增 `dedup`）、`live.selftest`（不变量断言） | 实验：制造 1 次真实工具失败 → live 落盘（`events=1 flushes=1 deferGroups=1`，指纹 215→216）→ 立刻批扫同一日志（`scanned=1/53ms`）→ 该事件 **`n=1` 且 `first==last`**（双计应为 2）、指纹与聚簇数不变；指纹身份 **25/25 sid 与磁盘会话目录名一致**、按 `at|hash` **0 组跨 sid 重复**。结论：两条路指纹逐字节一致，**无需修改**；改为用计数器（`toolUnknown` 为唯一残留路径的观测口径）+ 单测不变量把结论钉住 |
| **数据修复：清理已污染暂存**（用户批准） | `src/collector/cli.cjs`（`--forget-echo [--apply]`）、`engine.forgetEchoDeferred()` | 干跑清单与人工分诊完全一致（13 条）；执行后暂存 **18 → 5 组**（保留沙箱拒写 / DNS+TCP443 / SSH 公钥 / 工具超时 / 未知工具名 5 条真实发现），`seenFingerprints` 215、`nextCandidateId` 137 未变，无 `.lock`/`.tmp` 残留 |

**口径变化（第三批）**：自检由 10 套件 386 → **409 断言**（`repo.selftest` 23→28、`engine.selftest` 21→26、`e2e.selftest` 63→66、`live.selftest` 35→45）；13 个测试文件 PASS 累计 **502**。宿主半边（`/whale/live` 新字段）需**先 `deploy-web --apply` 再重启 `dsh web`**；回声判定/幂等落档与 `--forget-echo` 在批扫侧立即生效。
**追加发现（第 4 项"漂移守卫"前置）**：`.lifecycle/manifest.json` 里 `agents` 条目登记为 `whole` 模式（"整文件归本插件所有，卸载整文件删除"），而该文件现已含用户「手动段（用户自写区）」→ `uninstall remove/purge` 会连用户手写内容一起删除。用户指示**稍后单独讨论再决定**是否改 `zones`，本批未动。

---

## 8. 与既有文档的口径订正

| 既有说法 | 订正 |
|---|---|
| 全景图 §11 #10「toast/警示条在卸载后重挂载不重建」 | **不成立**：`toastEl`/`alertEl` 是 `apply()` 作用域内的局部变量（`client.js:443/446`），重挂载时重新初始化并按惰性守卫重建，文件内无模块级同名变量 |
| 全景图 §11.1「版本号漂移」 | **已失效**：六处口径已统一为 0.7.3，`/whale/live` 自报 0.7.3，`deploy-web --check` exit 0，`contracts.md` 重复行已删 |
| 「特征词典 10 类正则」 | **9 条正则**（`patterns.cjs`）＋ 内建 `error` = 10 个采集类别 |
| 「`CATEGORY_TITLES` 16 个条目展示类标题」 | **17 个**（v0.7.3 补了 `error`） |
| 「9 套件 312 断言」 | **9 套件 320 断言**；加维护工具两个 selftest = 391；再加 `redact.test` = **404 / 13 个测试文件**（本轮实跑：12 个文件 exit 0、391 条 PASS、0 条 FAIL） |
| 「CLI 10 个参数」 | **9 个 flag**（5 MODE + `--render-rules`/`--wall`/`--full`/`--dry`），`--check --add` 是组合用法 |
| 「只收 6 列/7 列归档行」 | 归档行实际存在 6/7/8 列多形态，解析器**必须按内容而非列数**处理（N18 的成因） |
| `PROJECT-INTRO.md` 的套件口径 | 其中 `ui/server(45)` 应为 **50**、`e2e(60)` 应为 **63**（本轮实测） |

---

## 9. 复现命令（全部只读）

```text
# 端点与运行态（只读；POST /whale/scan 等价面板 ⟳，会写 state，慎用）
GET  http://127.0.0.1:3080/whale/live | /whale/inbox | /whale/solved | /whale/inbox/detail?id=C### | /whale/entry?id=E### | /whale/related?id=C###

# 采集侧（--check 会写 state；--stats 纯只读）
node ~/.dsh/whale-notebook/scripts/mine.cjs --check
node ~/.dsh/whale-notebook/scripts/mine.cjs --stats

# 部署与生命周期对账（只读）
node ~/.dsh/whale-notebook/plugin/scripts/deploy-web.cjs --check
node ~/.dsh/whale-notebook/plugin/lifecycle/cli.cjs check

# 监听地址（确认未暴露到 LAN）
Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq 3080

# 打码覆盖复核（本轮用法：只在内存内调用，不落盘）
node -e "const p=require(process.env.USERPROFILE+'/.dsh/whale-notebook/plugin/src/core/privacy.cjs');console.log(p.redact('Authorization: Bearer FAKEVALUE'))"
```

---

## 10. 遗留假设与不确定性

1. **N3（CSRF）的真实可利用性取决于浏览器策略**：现代 Chrome 对「公网页 → 本机地址」有 Local/Private Network Access 限制，Firefox/Safari 与旧版 Chrome 更宽松。**无论是否可利用，修复都很便宜**（Origin + Host + Content-Type 三件套），建议按「可被利用」对待。
2. **N4（rebinding）的根因在宿主路由层**，插件侧只能做 Host 白名单自保；彻底修复需宿主配合——本报告把「插件侧自保」列为 P1 即可。
3. **N22（live 与批扫双计）目前是「读码 + 现场线索」级别的推断**，需要按 §5 第 5 项做一次源日志计数才能定论。
4. **N20 的宿主 Node 版本未实测**：本轮只在 shell 环境确认 v24.19.0 具备 `zstdDecompressSync`；宿主进程若同版本则无风险，但**缺少启动时的显式探测**这一防护本身仍是缺口。
5. **本报告未做任何写操作与破坏性验证**，所有「已修/未修」判定均基于读码 + 只读复算；涉及「实际会不会发生」的项都收在 §5，未写成结论。
