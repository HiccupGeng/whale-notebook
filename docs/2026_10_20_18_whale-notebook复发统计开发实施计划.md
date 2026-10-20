# 小本本「复发统计」开发实施计划

> 日期：2026-10-20 ｜ 版本：0.8.1 提案 ｜ 作者：待填 ｜ 目标插件版本：0.7.12 → 0.8.1（纯增量，不改注入文本）

## 1. 目标与非目标

**目标**：把「这条规则到底有没有用」从感觉变成可计算的数字——对每条 active 条目，回答「入墙之后，同样的坑又出现过几次」。

**非目标**：

- 不做自动停用/自动改写（只出数字，处置由人决定）；
- 不改 AGENTS 注入文本（**token 增量为 0**）；
- 不追求历史精确回溯（现有 7 条没有签名绑定，只能给近似值，明确标注）。

## 2. 统计口径（先定口径，再写代码）

### 2.1 术语与数据链

```
工具失败/特征事件（hash、cat、text、ws、at）
   → 聚簇 clusters[hash] = { cid: 'C###', n, first, last }
   → 条目绑定 signatures[] = 该 cid 名下全部 hash
   → 命中 hit = 事件 hash ∈ 某 active 条目的 signatures
```

- `hash`：事件指纹（canonText 哈希，`core/privacy.cjs`），同一坑的不同变体在聚簇里各有一个 hash；
- 绑定时机：入库时把候选聚簇的**全部** hash 写进条目的 `signatures`；
- 命中时机：采集时（批扫 `ingestFresh` 与实时 `live.cjs` 共用同一路径）。

### 2.2 指标

设条目创建于 `created`，历史首次出现于 `firstSeen`：

| 指标 | 定义 |
|---|---|
| 基线次数 | `occurrences`（入墙前累计，含同族合并，口径近似） |
| 基线跨度 | `created - firstSeen`（天） |
| 入墙后命中 | `hits.n`（本计划新增记录） |
| 入墙后跨度 | `now - created`（天） |
| 基线日均 | 基线次数 ÷ 基线跨度 |
| 入墙后日均 | 命中次数 ÷ 入墙后跨度 |

### 2.3 判定表（报告里直接给结论，别让人自己算）

| 条件 | 结论 |
|---|---|
| 入墙后日均 ≈ 0 且跨度 ≥ 14 天 | **有效**（规则起作用，或坑不再出现） |
| 入墙后日均 ≥ 基线日均 | **无效**（规则没挡住，建议改写写法或停用） |
| 0 < 入墙后日均 < 基线日均 | **减弱**（部分有效） |
| 命中数 < 3 或跨度 < 14 天 | **样本不足**（不下结论） |

### 2.4 必须处理的口径陷阱

1. **rebuild 重放**：`--rebuild` 会清空 `seenFingerprints`，全量历史会重新流经判定层。若不排除，所有历史事件都会被记成「入墙后命中」，统计直接失真。→ **命中记录只在非 rebuild 扫描中写入**。
2. **重复处理**：崩溃重跑 / 并发扫描可能让同一事件流经两次。→ 聚合时按 `(hash, at 所在分钟)` 去重。
3. **工作区过滤**：全局条目统计所有工作区；`scope: project` 的条目只统计 `projects[]` 白名单内的事件（事件带 `ws`）。
4. **基线口径**：`occurrences` 含同族合并后的累计值，可能偏大 → 基线日均偏高 → **更容易判「有效」**。报告里必须标注这一点，避免自我安慰。
5. **活跃度**：放假两周没人干活也会让「入墙后日均」趋零。→ 用基线日均对比，不做绝对频次判断。

## 3. 数据模型

### 3.1 条目 frontmatter 新增字段

```yaml
signatures: [a1b2c3d4, 9f8e7d6c]   # 该候选聚簇名下全部 hash 的前 8 位；旧条目缺省 = 未绑定
```

写进 `core/schema.cjs:renderEntryFile` 与 `store/repo.cjs:listEntries`（缺省 `[]`，零迁移）。

### 3.2 命中记录：`~/.dsh/whale-notebook/hits.jsonl`（append-only）

```json
{"e":"E005","h":"a1b2c3d4","at":1792400000000,"ws":"SandBox1"}
```

- **为什么不放 state.json**：`state` 是派生态，`--rebuild` 会清理；统计不能跟着丢。
- **为什么不写 entry 文件**：engine 不应改写 `entries/`（那是 agent 经用户确认才动的区域）。
- **体积**：每条命中一行（约 80 字节）；按 5000 行轮转 `hits-YYYYMM.jsonl`，与 `echo-*` 归档同思路。

### 3.3 绑定信息来源

入库时 `planCommit` 能拿到候选编号；从 `state.clusters` 反查同 `cid` 的全部 hash 填进 `signatures`。历史条目（E001–E007）没有候选编号 → 标记「未绑定」，可用 `--bind` 手工补。

## 4. 改动清单

| # | 文件 / 位置 | 改动 | 说明 |
|---|---|---|---|
| 1 | `src/core/schema.cjs:67-101` `renderEntryFile` | 输出 `signatures: [...]` | 缺省空数组 |
| 2 | `src/store/repo.cjs:453-485` `listEntries` | 解析 `signatures` | 旧文件零迁移 |
| 3 | `src/store/repo.cjs`（新增） | `appendHits(rows)` / `readHits()` / 轮转 | 数据层，原子 append |
| 4 | `src/review/commit.cjs:11-27` `planCommit` | 入参 entry 支持 `candidate: 'C###'` → 读 `state.clusters` 填 `signatures`；无候选则空 | 纯函数边界保持（state 以参数传入） |
| 5 | `src/collector/engine.cjs`（新增） | `buildEntryIndex(entries)` → `Map(hash → {id, scope, projects})` | 供批扫与实时共用 |
| 6 | `src/collector/engine.cjs:413-530` `ingestFresh` | 决策完成后：命中且 `!rebuild` 且 ws 匹配 → 记录 hit | 不改判定结果，纯旁路记录 |
| 7 | `src/collector/engine.cjs:826-870` `runScanTail` | 构建一次 `entryIndex` 传入 `ingestFresh` | 每轮扫描一次 |
| 8 | `src/collector/live.cjs` | 每批构建 `entryIndex`（条目少，开销可忽略） | 实时也算命中 |
| 9 | `src/collector/engine.cjs:890-902` `--stats` 分支 | 新增「条目有效性」小节 | 见 §5 |
| 10 | `src/collector/cli.cjs` | 新增 `--bind C### [E###]`：打印该候选的 hash，供手工绑历史条目 | 只读 |
| 11 | `~/.dsh/skills/whale-notebook.md` | 入库流程加一步「记下聚簇 hash → 写入 signatures」 | 流程同步 |
| 12 | 自测 | 见 §6 | |

## 5. 输出形态（`mine.cjs --stats` 追加一节）

```
== 条目有效性（入墙后复发）==
E005 有效    入墙 41 天｜命中 0（基线 2 次/24 天）
E001 无效    入墙 41 天｜命中 3（基线 7 次/24 天）→ 建议改写或停用
E002 减弱    入墙 41 天｜命中 2（基线 6 次/28 天）
E007 样本不足 入墙 41 天｜命中 0（基线 1 次）
（4 条：有效 1｜减弱 1｜无效 1｜样本不足 1；基线口径含同族合并，偏大）
```

- 仅用户主动跑 `--stats` 时输出（≈10 行，200–300 tokens），**不进入任何注入文本**。

## 6. 验收标准

1. **命中**：绑定后让同一 hash 事件再出现一次 → `hits.jsonl` 恰好 +1；同一次扫描重复跑不重复记。
2. **rebuild 隔离**：`--rebuild` 全量重扫后，`hits.jsonl` 行数与内容不变。
3. **项目级过滤**：`scope: project` + `projects: [SandBox1]` 的条目，不统计其它工作区的事件。
4. **未绑定**：旧条目（无 `signatures`）在报表中显示「未绑定」，不报错、不误计。
5. **容错**：`hits.jsonl` 损坏行跳过并计数，不影响采集主流程（与现有 state 损坏策略一致）。
6. 全量自测通过：`engine.selftest`(+4)｜`repo.selftest`(+3)｜`server.selftest`(不变)｜`lifecycle.selftest`(不变)。

## 7. 风险与偏差

| 风险 | 影响 | 处置 |
|---|---|---|
| 基线含同族合并，偏大 | 更容易判「有效」 | 报告标注口径；后续可用"基线只算代表簇"修正 |
| 新变体 hash 不在 `signatures` | 漏计 → 偏「有效」 | 定期 `--bind --rebind`：把同 cid 新并入的 hash 补进条目 |
| 项目活跃度波动 | 「入墙后日均」失真 | 只做前后对比，不做绝对阈值判断 |
| 历史 7 条无绑定 | 无法精确回溯 | 明确标注「未绑定」；如需近似，按 category + 相似度给参考值并标「近似」 |

## 8. token 影响

- 注入段：**0**（不新增、不修改任何注入文本）。
- 采集：0（旁路写一行 JSON，不影响判定）。
- `--stats`：+10 行 ≈ 200–300 tokens，仅主动运行。

## 9. 实施顺序与工作量

| 阶段 | 内容 | 估时 |
|---|---|---|
| P0 | 数据层：schema `signatures`、repo `hits` 读写、commit 绑定 | 1 h |
| P1 | 采集：`buildEntryIndex` + `ingestFresh` 旁路记录 + live 接入 + rebuild 隔离 | 1–1.5 h |
| P2 | 报表：`--stats` 有效性小节 + `--bind` 只读工具 | 1 h |
| P3 | 技能流程同步 + 自测 + 首次运行（7 条现有条目显示「未绑定」） | 1 h |

合计约 4–4.5 h。P0–P2 完成即可产出第一张表；P3 是流程与回归。

## 10. 与「已过期」方案的关系

本计划独立可用；若将来恢复方案 C（过期机制），**复发统计正好充当"过期判据"**——由「入墙后命中不降」触发复核，而不是靠日历。两者无代码依赖，先做哪个都不阻塞。

## 11. 回滚方案

全部改动是**纯增量旁路**，回滚成本极低：

1. 代码回退到改动前版本即可——`ingestFresh` 的命中记录是决策之后的旁路写入，不影响入箱结果；
2. `signatures` 字段缺省为空数组，旧代码读到会当作未知字段忽略（`listEntries` 只取已知键）；
3. `hits.jsonl` 独立文件，回滚后可留档可删除，不参与任何判定；
4. 不需要数据迁移，不需要重建 `INDEX.md` / AGENTS 自动段。

