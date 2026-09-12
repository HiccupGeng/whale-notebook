# 鲸鱼闪闪发光的小本本（whale-notebook）

> **把 DSH 会话里踩过的坑，变成下一个会话不会再踩的规则。**
> DeepSeek Harness 的自我进化机制：挖掘本机全部会话里反复出现的问题 → 提炼成候选经验 → **经你逐条确认**后写入全局经验库 → 注入 `~/.dsh/AGENTS.md` 自动段（每个新会话自动生效）。

**当前版本 `0.7.7`** ｜ 全部自检 **444 断言全绿**（13 个测试文件 PASS 累计 537） ｜ 用户记忆数据**只在本机、永不入库**

---

## 它是怎么工作的

```text
① 采集（0 token）        ② 审核（人来定）            ③ 生效（自动注入）
离线扫会话日志        →   决策箱逐条勾选        →   AGENTS.md 自动段
+ 运行中实时采集          现象/根因/对策/验证       每个新会话开局即加载
```

四条设计红线：

- **人审**——任何写入前先展示，你确认才落盘；AI 从不静默改记忆。
- **零模型开销**——采集、去重、聚类、同族判定全是本地纯函数，不调模型。
- **隐私**——只读会话日志、不复制原文；入库前打码（密钥→`[REDACTED]`）+ 指纹短哈希；数据不上传、不随技能离开本机。
- **可解释**——"还有哪些类似问题"由程序按相似度算出（可复现、阈值可调），不靠模型即兴归纳。

## 快速开始

前置：DSH（`dsh` CLI + web 全局件）与 Node ≥ 22（会话日志是 zstd 多帧 JSONL，用到 Node 内建 zstd）。

```powershell
# 1) 取源码
git clone https://github.com/HiccupGeng/whale-notebook.git
# 2) 放置运行源码（DSH 数据目录下）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\whale-notebook" | Out-Null
Copy-Item -Recurse whale-notebook\plugin  "$env:USERPROFILE\.dsh\whale-notebook\plugin"
Copy-Item -Recurse whale-notebook\scripts "$env:USERPROFILE\.dsh\whale-notebook\scripts"
Copy-Item whale-notebook\PROJECT-INTRO.md "$env:USERPROFILE\.dsh\whale-notebook\"
# 3) 登记安装（两段式：先干跑看计划，确认后 --apply）
node "$env:USERPROFILE\.dsh\whale-notebook\plugin\lifecycle\cli.cjs" install
node "$env:USERPROFILE\.dsh\whale-notebook\plugin\lifecycle\cli.cjs" install --apply
# 4) 采集一次看看（增量、0 token）
node "$env:USERPROFILE\.dsh\whale-notebook\scripts\mine.cjs" --check
# 5) 可选：部署 GUI 决策箱悬浮面板（改 profile → 需重启 dsh web）
node "$env:USERPROFILE\.dsh\whale-notebook\plugin\scripts\deploy-web.cjs" --apply
```

装完在会话里说 **「小本本复盘」** 即可开始审核。卸载同样两段式：`uninstall detach`（只摘运行时面板）→ `remove`（R+I，**用户记忆原样保留**）→ `purge`（全清，需先 `--export-dir` 导出 + `--yes`），详见 `plugin/lifecycle/README.md`。

## 日常用法（说什么都行）

| 你说 | 它做什么 |
|---|---|
| 小本本复盘 / 待审核箱 | 出候选清单（含「族×N」= 由几个同族变体合并），逐条给出建议 |
| 入库 C003,C007 | 生成条目 → 展示 → 你确认 → 写 `entries/` + 刷新 AGENTS 自动段 |
| 小本本讨论 `<主题>` | 开新会话专门讨论某类问题，开局自带「同族 / 相似候选 / 可能已被条目覆盖」三块确定依据 |
| 小本本墙 / 我们解决过什么 | 看已解决墙（`INDEX.md`，全局区 / 项目区 × 类别） |
| 小本本忘掉 E002 | 停用条目并从自动段移除 |
| 小本本统计 / 导出 | 统计总览；导出打包（只含通用经验） |

面板（GUI 右缘悬浮件）双卡：**待审箱**（⚡自动处理 / 💬详细讨论 / ✕删除）与**已解决墙**；`⟳` = 先触发增量扫描再刷新（不花 token）。

## 目录结构

| 路径 | 内容 |
|---|---|
| `plugin/` | 插件包源码：`core`(领域) · `store`(数据) · `collector`(采集) · `inject`(生效) · `review`(审核) · `ui`(面板/视图模型) · `lifecycle/`(自举安装卸载) · `scripts/deploy-web.cjs`(面板部署，R 段唯一写入者) · `lib/`(host half + browser half) |
| `scripts/` | v1 兼容薄壳 `mine.cjs` 与打码回归 `redact.test.cjs` |
| `docs/` | 设计/实施/调研记录（九份，含 v0.5–v0.7 的详细方案） |
| `PROJECT-INTRO.md` | **项目全景导读**：目录地图 / 数据不变式 / 模块地图 / 常用命令 → 新上手或 AI 会话先读这份 |
| `CHANGELOG.md` | **版本沿革明细**：每个版本解决了什么问题、怎么解决、实测数据 |
| `tools/sync-release.cjs` | 一键发布：权威源 → 本仓库镜像 → commit → push（幂等） |

> `README.md`、`CHANGELOG.md` 与 `LICENSE` 为**手工维护**（不参与镜像同步）；其余目录与 `PROJECT-INTRO.md` 是本机运行源码的逐字节镜像。
> 运行实例与用户数据在 `~/.dsh/whale-notebook/`，**永不入库**。

## 隐私边界（务必遵守）

1. **本仓库不含任何用户记忆数据**：候选行、经验条目、增量状态、设置实值、`AGENTS.md`、`.lifecycle` 快照只在用户本机 `~/.dsh` 内（`.gitignore` + 发布脚本双重兜底）。
2. 采集**只读** `~/.dsh/sessions`，绝不修改原始会话日志；不复制原文，只存打码摘要与指纹。
3. 所有提炼内容**先展示、经确认才落盘**；denylist 可整工作区拉黑；数据可随时本地清除。
4. 经验条目与规则行只写**通用对策**；来源仅存会话 ID 作统计溯源。

## 验证

```powershell
node plugin/lifecycle/selftest.cjs                    # 104 PASS · 含"不碰真实部署"反证
node plugin/src/ui/server.selftest.cjs                # 45 PASS · 面板 host 逻辑
node plugin/src/core/privacy.selftest.cjs             # 10 PASS · 打码出口
node plugin/src/core/summarize.selftest.cjs           # 10 PASS · 现象一句话
node plugin/src/core/similarity.selftest.cjs          # 20 PASS · 同族判定（含「不得误并」反证）
node plugin/src/collector/engine.selftest.cjs         # 10 PASS · 详情 sidecar 协议
node plugin/src/collector/engine.dedup.selftest.cjs   # 19 PASS · 已处置签名去重
node plugin/src/collector/e2e.selftest.cjs            # 60 PASS · zstd 全链端到端
node plugin/src/collector/live.selftest.cjs           # 28 PASS · 实时采集
node plugin/scripts/bundle-smoke.cjs                  # 面板 bundle 桩（结构断言）
node scripts/redact.test.cjs                          # 22 PASS · 打码回归（含 Bearer/Cookie/URL 凭据/密钥名）
```

合计 **10 套自检 386 断言** + bundle 桩 + 22 打码断言 + 43 死链体检断言 + 28 讨论落点断言 ＝ 13 个测试文件 PASS 累计 **457**（最近全绿：2026-09-11）。所有自检都在临时沙盒里跑，**不触碰真实 `~/.dsh`**。

## 版本沿革（明细见 `CHANGELOG.md`）

| 版本 | 一句话 |
|---|---|
| `0.7.5` | **端点闸门**（8 个 `/whale/*` 统一校验 Host 回环 / Origin / `Sec-Fetch-Site` / 写操作必须 JSON → 跨站副作用与 DNS rebinding 读数据均被拒）· **采集健康度可观测**（zstd 能力探测、帧扫描边界检查、中段坏帧分类与 `badRounds`/`stuckFiles`、`/whale/live` 新增 `zstd`/`scan`/`diag`） |
| `0.7.6` | **回声自我放大治理**（回声落档改「稳定签名 + 幂等追加」，签名 = `类别\|一句话(≤90字)`；补 `META_ARTIFACT` 产物标识签名与「按出处整类拦截」；当日分片超 400 行自动轮转）· **暂存污染清理** `mine.cjs --forget-echo [--apply]`（实测 18 组里 13 组＝72% 是自引用输出，清理后剩 5 组真实发现）· **双计口径加固**（实测 live 与批扫指纹逐字节一致、无双计；改为把 `toolUnknown`/`skippedByFingerprint` 与不变量断言钉住结论） |
| `0.7.7` | **扫描让出事件循环**（`scanHistory`/`runScanInner` 改生成器 + 双驱动；宿主在让出点 `await setImmediate`；**大日志按 256KB 窗口续读** —— 第一版实测宿主仍卡 3857ms，修正后**最大卡顿 69ms**；`/whale/live` 增 `scanJob`，卸载即取消并保证释放锁）· **`--rebuild` 维护窗口**（标记文件 + TTL 兜底，实时采集让路但不丢事件、`heldByMaintenance` 可见）· **漂移分级**（`lifecycle check` 只在缺失/结构损坏/孤儿/待迁移时 exit 1，合法演进＝「待登记」exit 0；新增 `check --adopt`；**AGENTS 迁 `zones` 模式**，区外是你自己的内容、`remove` 只剥区不删整文件） |
| `0.7.4` | **安全审计 P0 三项修复**：① 打码补漏（Bearer/Basic 认证头、Cookie、URL 内凭据、连接串口令、snake_case 密钥名、`sk_live_`/`xoxb-`/`npm_`/`AIza` 等短前缀令牌此前全部漏网）② `state.json` 完整性（严格读＋损坏留证＋临时名带 pid＋写前 CAS 合并＋跨进程写锁＋编号下限取归档最大+1）③ 归档「已处置」签名修正（空列形态与复发行前缀导致 63% 签名失配，重建后重复开行）；顺带修 sidecar 路径泄露、编号 `^C\d{3,}$`、`--prewarm --dry`、面板删除原子写 |
| `0.7.3` | **讨论落点路由**（💬 按候选来源选落点：跨项目开在固定「鲸鱼全局」工作区；页脚三态开关可强制）· **类别展示契约**（`error` 有标题、文档墙与面板分组排序一致、未登记类别两侧都排末尾）· **CLI 退出码契约**（0 成功 / 2 前置缺失 / 1 失败）· 面板样式节点纳入 disposer |
| `0.7.2` | 回声表行判据修正：去掉行首锚（成功路径会把输出压成单行，带锚永不命中）＋时间戳行要求后随类别词 |
| `0.7.1` | 回声过滤补漏：`META_DUMP` 三类「转储/回显」签名；`deploy-web --check` 补与权威源逐文件字节对账（副本陈旧即 exit 1） |
| `0.7.0` | **同族确定化**：同一个坑的不同变体自动合并为一条候选；`/whale/related` 给讨论会话三块确定依据 |
| `0.6.x` | 拉取式采集（新发现先暂存，说「复盘」才入箱）· `--rebuild` 从头梳理 · 回声过滤与类别判定收紧 · 已处置签名去重 |
| `0.5.x` | 增量采集（热启动 ~10ms）· 运行中实时入库（零 token）· 聚簇索引（累加 / 复发） |
| `0.4.0` | 已解决墙 + 全局/项目两级适用范围（项目级不进全局注入） |
| `0.3.0` | 决策箱面板增强：一句话现象 / 详情 sidecar / 红 ✕ / `[WHALE-RISK]` 上报 |
| `0.2.1` | 面板真实挂载（host half API + browser half 悬浮 UI + 一键部署/回退） |
| `0.2.0` | 插件化模块重构（六模块 + 单向依赖） |
| `0.1.x` | 生命周期工具（安装/卸载/清单，三段足迹 + 两段式写操作）；v0.1.1 起 R 段如实登记 |
| `1.0` | 机制奠基：skill + scripts + AGENTS 注入链路打通 |

## 许可

[MIT](LICENSE) © 2026 HiccupGeng ｜ `plugin/package.json` 的 `license` 字段与之一致。
