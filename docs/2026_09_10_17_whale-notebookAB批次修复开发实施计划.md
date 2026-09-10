# whale-notebook A/B 批次修复开发实施计划

> 日期：2026-09-10 17 时 ｜ 作者：DSH 会话（待署名） ｜ 版本：v1.3（**S1–S8 全部完成并验收**，见 §9）
> 上游依据：`docs/2026_09_10_16_whale-notebook架构全景图.md` §11「缺口与风险」经「重要性 × 复杂度」四象限重排后的前两批
> 目标版本：插件包 **v0.7.3**（既有未登记内容收口 + 本批次修复，见 §3.4 裁定 D3）
> 本批次规模：5 个问题 · 代码改动 6 个文件 · 文档口径改动 8 个文件 15 处 · 新增断言 9 条

---

## 1. 背景与范围

### 1.1 从缺口清单到 A/B 批次

架构全景图 §11 列出 10 条缺口，经「重要性 × 复杂度」重排后分四批。本文件只做 **A、B** 两批（即"立即修"与"并入下一次重启窗口"），C/D 批不在本次范围。

| 批 | 判据 | 成员 | 生效代价 |
|---|---|---|---|
| **A** | 高价值 / 低成本 / **不需要重启 dsh web** | A1 CLI 退出码、A2 面板样式节点回收 | 立即 / 刷新页面 |
| **B** | 本轮该修，但要么需宿主重启、要么属跨库口径收口 | B1 版本口径、B2 部署与发布对账、B3 `error` 类别标题与排序 | 宿主重启 / 发布 |
| C（不做） | 中价值 / 中高成本 | 面板改 Slot 注册、漂移守卫信噪比、宿主版本可观测化 | — |
| D（不做） | 低价值 | 水位线理论漏采、`state.json` 明文运行细节、（待复核的）toast 重挂载 | — |

> **为什么把"不重启"当第一批的判据**：宿主半边（`lib/index.js` / `src/**`）的任何改动都要用户**亲自择时重启 `dsh web`**（会中断在线会话）。凡是能脱离重启窗口完成的修复，就该在窗口之外先落地。

### 1.2 本批次要修的问题（5 条）

| 编号 | 问题 | 一句话 | 归属批次 |
|---|---|---|---|
| A1 | CLI 退出码恒 0 | `mine.cjs` 成功与失败都是 `0`，调用方只能解析 stdout 判定成败 | A |
| A2 | 面板 `<style>` 节点未回收 | 唯一一个不在 `ctx.effect` disposer 里的副作用 | A |
| B1 | 版本口径三分裂 | 代码写 0.7.3、包写 0.7.2、发布库文档写 0.7.0，且断言计数三处不一致 | B |
| B2 | 部署副本 + 发布库双陈旧 | `deploy-web --check` exit 1（副本缺 2 文件、README 内容不同）；发布库 PROJECT-INTRO 落后 | B |
| B3 | `error` 类别无展示标题 | 量产最大的类别没有中文标题，且两个消费者对"未登记类别"的排序判断相反 | B |

### 1.3 非目标（明确不做）

- 不把面板从 DOM 外挂改成 client-plugin Slot 注册（C 批，1033 行重写）
- 不动回声过滤 / 类别判定 / 族合并 / 去重等**采集判定层**逻辑
- 不改 AGENTS.md 自动段的注入文本（`inject/agents.cjs` 的提醒句保持原样；退出码只是新增的旁路信号）
- 不扩展面板数据契约（如给 `/whale/inbox` 增加类别中文名；卡片继续显示原始类别键）
- 不改水位线判据、不改 `state.json` 字段、不修（尚未确认成立的）toast 重挂载问题

### 1.4 前置依赖

| 依赖 | 状态 | 说明 |
|---|---|---|
| 临时 DSH_HOME 沙盒自测范式 | ✅ 已具备 | `lifecycle/selftest.cjs`（spawnSync + 临时 home）、`src/collector/e2e.selftest.cjs`（临时 home + zstd 假会话）——新增断言直接复用，**不碰真实 `~/.dsh`** |
| 基线全绿 | ✅ 已实测 | 9 套件 **313 断言** + `bundle-smoke` + `redact.test`(13) + `links-doctor.selftest`(43) + `discuss-route.selftest`(28)，全部 exit 0（2026-09-10 17 时实测） |
| 部署工具 | ✅ 已具备 | `deploy-web.cjs`（R 段唯一写入者，`--check` 含逐文件字节对账） |
| 发布工具 | ✅ 已具备 | `<repo>/tools/sync-release.cjs`（镜像 → commit → push） |
| 用户择时的宿主重启窗口 | ⏳ 待用户 | B1 的 `/whale/live` 自报版本、B3 的墙分组改动**都只有在重启后才可验收** |

---

## 2. 问题判定（证据 → 影响）

### 2.1 A1 · CLI 退出码恒 0

**现场证据**

- `~/.dsh/whale-notebook/scripts/mine.cjs`（13 行薄壳）：`run(process.argv.slice(2))` 的返回值被丢弃，全程无 `process.exitCode`。
- `~/.dsh/whale-notebook/plugin/src/collector/cli.cjs`（45 行）：`run()` 在 `out.ok` 为假时只 `console.error(out.text)`，仍不设退出码；`--render-rules` / `--wall` 两个早返回分支同样只 `return`。
- **对照全项目约定**（说明这是遗漏而非设计）：

| 入口 | 退出码约定 |
|---|---|
| `plugin/lifecycle/cli.cjs` | 0 成功 / 1 有问题 / 2 前置或用法错误（19 处 `process.exitCode`） |
| `plugin/scripts/deploy-web.cjs` | 0 通过 / 1 副本陈旧或结构不符 |
| `plugin/scripts/links-doctor.cjs` | 0 正常 / 3 发现悬空 / 1 出错 |
| 全部 `*.selftest.cjs`（7 处） | 0 全绿 / 1 有失败 |
| **`scripts/mine.cjs` + `collector/cli.cjs`** | **无**（唯一例外） |

- `runScan` 返回 `ok:false` 的路径只有两处（`src/collector/engine.cjs:567-568`）：`sessions` 根不存在、`whale-notebook` 数据目录不存在——**都是前置缺失，不是"采集失败"**。

**影响**

1. 每个新会话开头都会被 AGENTS 自动段提醒去跑 `mine.cjs --check`；这条链路目前只能靠**读 stdout 文本**判成败（技能与提醒句都这么写），脚本化调用存在盲区。
2. 数据目录被移动/改名时，CLI 会打印一行错误但**返回 0**，调用方会误判为"采集成功、无新发现"——这是"静默失效"，与项目一贯的"痕迹必须可指认"相反。
3. 与其余五个入口的约定不一致，违反"同类事物同一形状"。

**分级**：重要性高（静默失效 + 每会话都走） / 复杂度低（1 个文件，~15 行）→ **A 批**。

### 2.2 A2 · 面板 `<style>` 节点未回收

**现场证据**（`plugin/lib/client.js`）

- `ensureCss()`（L107-116）：`document.querySelector('style[data-plugin-css=…]')` 为空时创建 `<style>` 并 `document.head.appendChild(tag)`；有幂等守卫，不会重复注入——但**从不移除**。
- 卸载 disposer（L996-1010）依次清理：`timer` / 风险监听 / 4 个事件监听 / `toastTimer` / `alertTimer` / `box` / `toastEl` / `alertEl`——**唯独没有 `<style>`**。
- `ensureCss()` 只在 `apply()` 内被调用一次（L428），没有其他调用点。

**影响**

- 严格意义上不满足"每个副作用必须可逆"（Cordis 生命周期契约）；面板卸载后页面上残留一个样式节点。
- 单节点、带幂等守卫、不影响任何行为与数据——**影响可忽略，但修复成本更低**，属"顺手做对"。
- 附带一个**必须避开的坑**：不能简单地在 disposer 里"看到样式就删"。若节点是上一代 `apply` 创建、被本次复用（`ensureCss` 的复用分支），删除它会连带打断仍在运行的上一代面板——必须按"**谁创建谁回收**"处理。

**分级**：重要性低 / 复杂度极低（1 处返回 + 1 行 disposer）→ **A 批**（零重启，只需刷新页面）。

### 2.3 B3 · `error` 类别无标题 + 两个消费者排序不一致

**现场证据**

- `error` 不是偶发键，而是**采集主力类别**：`src/collector/scanner.cjs:101` 把**任何工具失败结果**直接判为 `cat:'error'`（文本命中具体特征时才改判为 `encoding` / `git-net` 等）。
- 判定层为它开了**唯一特权**：`src/collector/engine.cjs:285` `if (ev.cat !== 'error' && !PAT_IDS.has(ev.cat)) continue;`（`error` 绕过模式白名单门）；`engine.cjs:34` 还单独剥掉 `error:` 前缀。
- 展示层却缺它的标题：`src/core/schema.cjs` 的 `CATEGORY_TITLES` 共 **16 键，没有 `error`**（17 个产出类别里唯一缺失的一个）。兜底写法是 `CATEGORY_TITLES[cat] || cat`，于是墙上直接显示裸键 `error`。
- **两个消费者对"未登记类别"的排序判断相反**：

| 消费者 | 代码 | 未登记类别的落点 |
|---|---|---|
| 面板（`src/ui/viewmodel.cjs:44-46`） | `catOrder.indexOf(x) - catOrder.indexOf(y)` → `-1` | **排到最前**（`error` 组因此占据面板已解决墙首组） |
| 文档墙（`src/store/repo.cjs:266-269`） | `catOrder.filter(...)` + `Object.keys(gByCat).filter((c) => !catOrder.includes(c))` | **追加到末尾**（`INDEX.md` 里排最后） |

**影响**

1. 同一份数据在面板与 `INDEX.md` 里分组顺序不同（`error` 一头一尾），"墙形状"这一契约在未登记类别上不成立。
2. 类别标题是文档质量的一部分：墙上出现 `error` / `git-net` / `sandbox-ep` 混排，读者需要在"中文标题"与"裸键"之间切换。
3. 诱因会被复制：今后任何新增类别只要忘了登记标题，就会**同时**触发"裸键显示 + 排序分裂"两个症状。修一条不如修这一类。

**分级**：重要性中高（用户可见 + 契约不一致 + 会复发） / 复杂度低（3 文件，1 处新增 + 3 处改调用）→ **B 批**。

### 2.4 B1 · 版本口径三分裂

**现场证据**（同一时刻的三份"当前版本"）

| 层 | 位置 | 现值 |
|---|---|---|
| 源码内容 | `lib/client.js`（v0.7.3 讨论落点路由）、`src/ui/server.cjs`（v0.7.3 归档列修复）、`scripts/bundle-smoke.cjs`（断言 v0.7.3 结构）、`scripts/discuss-route.selftest.cjs`（v0.7.3 自测） | **0.7.3** |
| 包元信息 | `plugin/package.json:4`、`lib/index.js:14`（`PACKAGE.version`）、运行进程 `GET /whale/live` 自报 | **0.7.2** |
| 发布库文档 | `README.md:6`（当前版本 + 断言数）、`CHANGELOG.md:4`（版本口径）与最新条目（止于 v0.7.0） | **0.7.0** |

补充事实：`CHANGELOG.md` 自称"版本沿革的唯一明细入口"，但 **v0.7.1 / v0.7.2 / v0.7.3 三条都没有条目**（明细目前只散落在 `PROJECT-INTRO.md` §8 与 `plugin/README.md` 的段落里）。

**断言计数同时漂移三处**（实测 2026-09-10 17 时）

| 位置 | 现值 | 实测 |
|---|---|---|
| `plugin/README.md:91` | 9 套件 312 断言 | **313**（`server.selftest` 实为 46，文中写 45） |
| `plugin/README.md:45` | `live(28)` | **34**（与同文件 L91 自相矛盾） |
| `PROJECT-INTRO.md:193` | `server.selftest.cjs (45 PASS)` | **46** |
| 发布库 `README.md:6` | 306 断言全绿 | **313**（差一个版本世代） |
| 发布库 `README.md:6` | 当前版本 0.7.0 | **0.7.3** |

**影响**：`/whale/live` 自报版本、`deploy-web --check` 的版本感知、人读文档三条路径都会误判"当前版本"；发布库读者看到的是落后两个世代的数字。这是**纯口径问题，但会污染每一次判断**（本项目的经验规则里就有"判定产物新旧以字节级为准"的同类教训）。

**分级**：重要性中（不伤运行，伤判断） / 复杂度低（改字符串 + 补三条 CHANGELOG）→ **B 批**。

### 2.5 B2 · 部署副本与发布库双陈旧

**现场证据**

- 部署对账：`deploy-web.cjs --check` → **exit 1**，副本陈旧 3 个文件：
  - 副本缺 `scripts/links-doctor.cjs`、`scripts/links-doctor.selftest.cjs`
  - `README.md` 内容不同
  - **`lib/*` 与权威源逐字节一致** → 面板功能不受影响
- 发布库：`<repo>/PROJECT-INTRO.md`（27710 B）落后于权威源（28779 B）；`<repo>/docs/` 只有 9 份文档，**缺本次新增的架构全景图**；工作区干净（上次同步提交 `a0a8e0a` @ 15:44）。
- 发布库的 `README.md` 与 `CHANGELOG.md` **不在 `sync-release.cjs` 的镜像范围内**（`EXTRA_FILES` 只登记了 `PROJECT-INTRO.md`），只能手工改，再由下一次同步的 `git add -A` 顺带提交。

**影响**

1. 副本陈旧会让"重启了却没生效"的旧坑重演（v0.7.1 就是为它加的字节对账）。
2. 发布库文档落后 → 公开读者读到 0.7.0 的口径与缺章节的文档集。
3. README 归属不清（镜像 / 手工两套并存）是**结构性风险**：本次先手工对齐，并把"README 是否纳入镜像"登记为后续裁定。

**分级**：重要性中（运维与发布面） / 复杂度低（一条 `--apply` + 一次同步 + 一次手改）→ **B 批**。

---

## 3. 修改方案

### 3.1 A1 · CLI 退出码契约与落点

**退出码契约**（新增，写入 `mine.cjs` 头注释与 `plugin/README.md` CLI 段）

| 退出码 | 含义 | 触发条件 |
|---|---|---|
| `0` | 采集流程成功。**「有新发现 / 有暂存」也是成功**——拉取式下这是常态，不是失败 | `run()` 返回 `{ ok: true }`（`--check` `--add` `--rebuild` `--stats` `--prewarm` `--render-rules` `--wall` 全部正常路径） |
| `2` | 前置缺失（环境不完整，不是"坏了"） | `runScan` 的两处 `ok:false`：`sessions` 根不存在、数据目录不存在。与 `lifecycle/cli.cjs` 的 `2 = 前置错误` 对齐 |
| `1` | 失败 / 结果形状异常 | 未捕获异常、`run()` 返回非对象 |

**落点裁定：只放在 `scripts/mine.cjs`（进程入口），不放 `cli.run()`**

- 证据：宿主半边 `lib/index.js:166` 调的是 `engine.runScan('--check')`（`POST /whale/scan`），**不经过 `cli.run()`**；`collector/cli.cjs:1` 的头注释"供…宿主插件复用"与事实不符。
- 结论：`cli.run()` / `engine.runScan()` 保持**纯函数**（只返回 `{ok,text,data}`，不产生进程级副作用）；设置 `process.exitCode` 是**进程入口的唯一职责**。这样即使将来宿主真的复用 `run()`，也不会污染 `dsh web` 进程的退出码。
- 顺带订正 `collector/cli.cjs:1` 的注释（写清"宿主走 `engine.runScan`"）。

**代码 · `~/.dsh/whale-notebook/scripts/mine.cjs`（改后全文）**

```js
// mine.cjs - 兼容薄壳（v1 入口不变: AGENTS 提醒句/skill/历史脚本都指向这里）
// 真实逻辑已模块化到 ../plugin/src/（collector/engine + cli）；本文件只转发并保持导出兼容。
// 用法不变:
//   node mine.cjs --check | --prewarm | --stats | --render-rules
// v0.7.3 退出码契约（唯一进程级出口；cli.run()/engine.runScan() 保持纯函数）:
//   0 = 采集成功（"有新发现/有暂存"亦为成功）  2 = 前置缺失（sessions 根 / 数据目录不存在）  1 = 失败或结果异常
'use strict';
const { redact } = require('../plugin/src/core/privacy.cjs');
const { fmtTime } = require('../plugin/src/core/util.cjs');
module.exports = { redact, fmtTime, exitCodeOf };

function exitCodeOf(out) {
  if (out && out.ok === true) return 0;
  if (out && out.ok === false) return 2; // runScan 的两处 ok:false 均为前置缺失
  return 1;                              // 形状异常（含未捕获异常时传入 null）
}

if (require.main === module) {
  const { run } = require('../plugin/src/collector/cli.cjs');
  let out = null;
  try {
    out = run(process.argv.slice(2));
  } catch (err) {
    console.error('[mine] 采集异常: ' + ((err && err.stack) || err));
  }
  process.exitCode = exitCodeOf(out); // 异常 → out 仍为 null → 1
}
```

> 备选（不推荐）：全部失败都归 `1`。好处是调用方只需 `!== 0`；代价是与 `lifecycle/cli.cjs` 的 0/1/2 语义分叉，且"环境缺失"与"逻辑坏了"无法区分。→ 见 §8 裁定 D1。

**【可选】让 AGENTS 提醒句吃到退出码**：本次**不做**。提醒句文本由 `inject/agents.cjs` 生成、每会话注入，改动它等于改所有会话的行为；退出码作为旁路信号先落地，等观察一轮再决定是否让提醒句引用它。

### 3.2 A2 · 面板样式节点回收（谁创建谁回收）

**方案**：`ensureCss()` 改为返回"本次创建的节点"（复用既有节点时返回 `null`），`apply()` 记住它，disposer 只回收属于本次的那个节点。

**代码 · `plugin/lib/client.js`**

① L107-116（改后）：

```js
		// v0.7.3：返回"本次创建的 style 节点"（复用既有则返回 null）——
		//   谁创建谁回收：跨代复用的节点不能被后一代卸载时误删。
		function ensureCss() {
			if (typeof document === "undefined") return null;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") !== null) return null;
			var tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-whale-notebook";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return tag;
		}
```

② L428（改前 `ensureCss();`）→

```js
			var cssNode = ensureCss(); // v0.7.3：本次创建的样式节点（下次卸载时回收）
```

③ L1008 之后（disposer 内追加一行）→

```js
					if (cssNode && cssNode.parentNode) cssNode.parentNode.removeChild(cssNode);
```

**不变的东西**：`CSS_ID` / `CSS` 常量、注入位置（`document.head`）、`data-plugin-css` 属性名、幂等语义（仍不会重复注入）。

### 3.3 B3 · 类别展示契约：单一入口 + 排序一致

**裁定**：把"标题兜底"与"排序秩"收进 `core/schema.cjs` 一处，两个消费者都改成调用它——**修掉这一类**，而不是只补一个 `error` 键。

**代码 · `plugin/src/core/schema.cjs`**

① `CATEGORY_TITLES` 新增 `error`（位置：`port-busy` 之后、`other` 之前——语义上"具体类别在前、通用兜底在后"）：

```js
  'port-busy': '端口/文件占用',
  error: '工具报错（未归类的失败结果）',   // v0.7.3：采集主力类别（scanner 对任何失败结果直接判 error），此前漏登记
  other: '其他',
```

② 文件末尾新增展示契约（与 `CATEGORY_TITLES` 一起导出）：

```js
// v0.7.3：类别展示契约（唯一入口）——此前 viewmodel 与 repo 各写一套，对"未登记类别"的排序判断相反
//   （viewmodel 的 indexOf → -1 → 排最前；repo 的 filter 追加 → 排最后）。
const CATEGORY_ORDER = Object.keys(CATEGORY_TITLES);
function categoryTitle(cat) { return CATEGORY_TITLES[cat] || String(cat); }
function categoryRank(cat) {           // 未登记类别一律排末尾
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}
function sortCategoryKeys(keys) {      // 秩相同再按字典序，保证可复现
  return keys.slice().sort((x, y) => categoryRank(x) - categoryRank(y) || String(x).localeCompare(String(y)));
}
```

③ 导出补 `CATEGORY_ORDER, categoryTitle, categoryRank, sortCategoryKeys`。

**代码 · `plugin/src/store/repo.cjs`（文档墙 `INDEX.md`）**

```js
// L266-269 改后
    const gByCat = {};
    for (const e of global) (gByCat[e.category] = gByCat[e.category] || []).push(e);
    const order = sortCategoryKeys(Object.keys(gByCat));
// L272 改后
      L.push(`### ${categoryTitle(cat)}（${list.length}）`);
// L303 改后（停用表）
    ... | ${esc(categoryTitle(e.category))} | ...
```

**代码 · `plugin/src/ui/viewmodel.cjs`（面板已解决墙）**

```js
// L44-47 改后
  const gByCat = {};
  for (const e of globals) (gByCat[e.category] = gByCat[e.category] || []).push(e);
  const global = sortCategoryKeys(Object.keys(gByCat))
    .map((cat) => ({ cat, title: categoryTitle(cat), entries: gByCat[cat].slice().sort(byNewest).map(entryLight) }));
```

**行为变化的可见面**（必须写进验收）

| 面 | 改前 | 改后 |
|---|---|---|
| `INDEX.md` 全局区分组标题 | 含裸键 `error`，排在最后 | `工具报错（未归类的失败结果）`，排在"端口/文件占用"之后、"其他"之前 |
| 面板已解决墙全局区 | `error` 组**排在首组**、标题为裸键 | 同上顺序，中文标题 |
| 未登记类别（未来新增漏登记时） | 面板排最前 / INDEX 排最后 | **两侧都排最后**（契约成立） |
| 面板待审箱卡片 `wh-cat` | 显示原始类别键 | **不变**（非目标） |

**文案待定**：`error` 的中文标题用「工具报错（未归类的失败结果）」还是更短的「工具报错」→ 见 §8 裁定 D2。

### 3.4 B1 · 版本口径收口到 v0.7.3

**裁定 D3**：0.7.3 从未部署、也从未发布（副本 `package.json` 仍是 0.7.2），因此**一次收口到 0.7.3**，把"已完成但未登记的 v0.7.3 内容"与"本批次修复"合并为同一个版本。备选的"先 0.7.3 对账、本批次记 0.7.4"见 §8。

**改动清单（15 处）**

| # | 库 | 文件 | 位置 | 现值 | 目标 |
|---|---|---|---|---|---|
| 1 | 数据 | `plugin/package.json` | L4 | `"version": "0.7.2"` | `"0.7.3"` |
| 2 | 数据 | `plugin/lib/index.js` | L14 | `PACKAGE = { …, version: '0.7.2' }` | `'0.7.3'` |
| 3 | 数据 | `plugin/README.md` | L1 | 标题 `（v0.7.2：…）` | `（v0.7.3：…）` |
| 4 | 数据 | `plugin/README.md` | L59 | `现状 v0.7.2` | `现状 v0.7.3` |
| 5 | 数据 | `plugin/README.md` | L63 | `现状语义速览（v0.7.2）` | `（v0.7.3）` |
| 6 | 数据 | `plugin/README.md` | L45 | `live(28)` | `live(34)`（消除与 L91 的自相矛盾） |
| 7 | 数据 | `plugin/README.md` | L91 | `9 套件 312 断言` + 逐套件计数 | `9 套件 320 断言`（server 46→50、e2e 60→63） |
| 8 | 数据 | `PROJECT-INTRO.md` | L28 / L149 / L165 | `权威源已 0.7.2` / `当前 plugin 版本 v0.7.2` | 0.7.3 |
| 9 | 数据 | `PROJECT-INTRO.md` | L163 | 0.7.2 行状态 `✅ 当前（宿主半边待重启）` | 改为 `✅`；**新增 0.7.3 行**并标 `✅ 当前（宿主半边待重启）` |
| 10 | 数据 | `PROJECT-INTRO.md` | L193 / L197 | `server.selftest.cjs (45 PASS)` / `zstd 全链(60)` | `(50 PASS)` / `zstd 全链(63)` |
| 11 | 数据 | `plugin/src/ui/contracts.md` | L28-29 | 重复的 ③ 桌宠 / ④ 外观两行 | 删除（保留 L26-27） |
| 12 | 发布 | `README.md` | L6 | `当前版本 0.7.0` ｜ `306 断言全绿` | `0.7.3` ｜ `320 断言全绿` |
| 13 | 发布 | `README.md` | L100-104 | 版本沿革表止于 `0.7.0` | 追加 `0.7.1` / `0.7.2` / `0.7.3` 三行 |
| 14 | 发布 | `CHANGELOG.md` | L4 | 口径 `（当前 0.7.0）` | `（当前 0.7.3）` |
| 15 | 发布 | `CHANGELOG.md` | L6 之前 | 最新条目为 v0.7.0 | 插入 **v0.7.3 / v0.7.2 / v0.7.1** 三条 |

**CHANGELOG 三条补录的取材**（`CHANGELOG.md` 自称"唯一明细入口"，不能空着）

- **v0.7.1** · 回声过滤补漏：新增 `META_DUMP` 三类「转储/回显」签名（`==== L### <kind>` 转储信封 / 会话记录 JSON 信封 / notebook 表行），只认渲染痕迹不认失败语义；`live.selftest` +4（含"不误伤原文"反证）。取材：`PROJECT-INTRO.md:166`、`plugin/README.md:71`。
- **v0.7.2** · 回声表行判据修正：去掉行首锚（成功路径会把输出压成单行，带锚永不命中）＋时间戳行要求后随类别词；自测 +2（含反证）。
- **v0.7.3** · 讨论落点路由（💬 不再固定开在当前工作区：跨项目候选 → 固定「鲸鱼全局」工作区；单项目 → 该项目工作区；未知/歧义 → 回退当前工作区并在 toast 说明；页脚三态开关 + `localStorage` 记忆；落点与依据写进新会话开局消息，`scripts/discuss-route.selftest.cjs` 28 断言）＋ `/whale/inbox` 归档列修复（`src/ui/server.cjs`，inbox 行尾 `|` 不再被续写成空列）＋ 本批次：CLI 退出码契约、面板样式节点回收、类别展示契约（`error` 标题 + 排序一致）。

> **写入时序（重要）**：发布库的 `README.md` 与 `CHANGELOG.md` **不在同步工具镜像范围内**，必须**先手工改**，再由下一次 `sync-release.cjs` 的 `git add -A` 随镜像一起提交；否则同步提交里只有镜像文件，这两份文档会一直落后。

### 3.5 B2 · 部署对账与发布时序

```powershell
# ① 交付前自检（改完代码后、部署前）
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs"            # dry-run：看将复制哪些文件
# ② 写入副本（清掉"缺 links-doctor×2 / README 内容不同"三项陈旧）
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --apply
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --check    # 期望 exit 0
# ③ 用户择时重启 dsh web（会中断在线会话）→ 重启后验证
#     GET /whale/live 应自报 version=0.7.3
# ④ 生命周期对账（R 段为信息级；AGENTS/skill 的漂移提示属预期）
node "$env:DSH_HOME\whale-notebook\plugin\lifecycle\cli.cjs" check           # 期望 exit 0
# ⑤ 发布镜像（先手改发布库 README/CHANGELOG，再同步；push 需用户确认）
node <repo>\tools\sync-release.cjs --no-push                                 # 先看变更清单
node <repo>\tools\sync-release.cjs                                           # 确认后提交并推送
```

**「README 归属」后续裁定（不在本批次实施）**：`sync-release.cjs` 的 `EXTRA_FILES` 只登记 `PROJECT-INTRO.md`，发布库 `README.md`（7793 B）与数据目录 `README.md`（7838 B）是两份各自维护、内容相近的文件——**要么把发布库 README 纳入镜像、要么在数据目录侧标注"本文件不发布"**，否则版本行会持续漂移。本次先手工对齐版本行，把归属问题登记为下一批候选。

---

## 4. 执行顺序与门禁

| 步 | 动作 | 文件 | 生效代价 | 门禁（不通过不进下一步） |
|---|---|---|---|---|
| S1 | A1 退出码 | `scripts/mine.cjs`（+订正 `collector/cli.cjs` 头注释） | **立即**（脚本，无需重启） | `mine.cjs --check` 正常路径 exit 0；§5 的 T1-T3 断言通过 |
| S2 | A2 样式回收 | `plugin/lib/client.js` | **刷新页面** | `bundle-smoke.cjs` 通过（含新增 2 条结构断言） |
| S3 | B3 类别契约 | `plugin/src/core/schema.cjs`、`store/repo.cjs`、`ui/viewmodel.cjs` | 宿主重启后生效 | §5 的 T4-T7 断言通过 |
| S4 | 补自测 | `src/ui/server.selftest.cjs`(+4)、`src/collector/e2e.selftest.cjs`(+3)、`scripts/bundle-smoke.cjs`(+2) | 无 | 9 套件 **320** 断言 + `bundle-smoke` + `redact.test`(13) + `links-doctor.selftest`(43) + `discuss-route.selftest`(28) **全绿** |
| S5 | B1 口径收口 | §3.4 表的 15 处（先数据目录，后发布库） | 无 | 两库版本行一致；断言计数与 S4 实测一致 |
| S6 | B2-1 部署 | `deploy-web --apply` → `--check` | 写入副本；**重启才生效** | `--check` exit 0 |
| S7 | B2-2 重启（**用户择时**） | — | 中断在线会话 | `/whale/live` `version=0.7.3`；刷新页面后面板双卡正常、💬 落点路由正常 |
| S8 | B2-3 发布 | 手改发布库 README/CHANGELOG → `sync-release.cjs` | 推送公开库 | 镜像完整（含新增架构全景图与本计划）；`git status` 干净 |

**并行性**：S1、S2、S3 互不依赖，可同批做完再统一验证；S5 依赖 S4 的实测计数；S6-S8 必须串行且 S7 由用户掌握时机。

---

## 5. 验收标准（可判定）

### 5.1 新增/扩展的断言（9 条）

| 编号 | 落点 | 断言 | 期望 |
|---|---|---|---|
| T1 | `e2e.selftest.cjs` | 临时 home 内 `nb` + `sessions` 齐备 → `spawnSync(process.execPath, [MINE, '--check'])` | `status === 0` |
| T2 | `e2e.selftest.cjs` | `DSH_HOME` 指向空的临时目录（无 `whale-notebook`）→ 同上 | `status === 2`，且 stderr 含 `whale-notebook dir missing` |
| T3 | `e2e.selftest.cjs` | `--render-rules` 早返回分支 | `status === 0` |
| T4 | `server.selftest.cjs` | `CATEGORY_TITLES` 覆盖 **全部** `PATTERNS.map(p => p.id)` **并含 `'error'`** | 无遗漏键 |
| T5 | `server.selftest.cjs` | `categoryTitle('error') !== 'error'`；`categoryTitle('未登记xyz') === '未登记xyz'` | 通过 |
| T6 | `server.selftest.cjs` | `sortCategoryKeys(['未登记xyz','port-busy','error','encoding'])` → 未登记键排最后、`error` 在 `port-busy` 之后 | 顺序确定且可复现（两次调用同序） |
| T7 | `server.selftest.cjs` | 墙渲染：含 `error` 与一个未登记类别的全局条目 → `INDEX.md` 与 `solvedViewModel()` **两侧分组顺序一致**，且 `error` 组标题非裸键 | 两侧一致 |
| T8 | `bundle-smoke.cjs` | bundle 源码含 `var cssNode = ensureCss()` 且 disposer 段含 `cssNode.parentNode.removeChild` | 命中 |
| T9 | `bundle-smoke.cjs` | `ensureCss` 的复用分支返回 `null`（跨代不误删） | 命中 |

> T4 是**防复发**断言：将来新增类别忘了登记标题，自测立刻失败。T8/T9 是**结构断言**（bundle 无 DOM 运行环境，无法真跑卸载；静态断言是该层能做到的最强约束，其局限如实记录在此）。

### 5.2 命令级验收

| 命令 | 期望 |
|---|---|
| `node scripts\mine.cjs --check` | exit **0**，输出一行摘要（"新发现 N 组 / 暂存共 N 组 / 待审 N 条"） |
| `node scripts\mine.cjs --stats` | exit **0** |
| `node plugin\src\ui\server.selftest.cjs` 等 9 个套件 | 全部 exit **0**，合计 **320** 断言 |
| `node plugin\scripts\bundle-smoke.cjs` | exit 0，输出含 `v0.4–v0.7.3 结构完整` |
| `node plugin\scripts\deploy-web.cjs --check` | exit **0**，输出 `[自检通过] 副本与权威源逐字节一致 + patch 行在位` |
| `node plugin\lifecycle\cli.cjs check` | exit **0**（AGENTS/skill 漂移提示为预期，非失败） |
| `GET http://127.0.0.1:3080/whale/live`（重启后） | `version` == `0.7.3`，`live.enabled` == true，`lastError` == null |
| `INDEX.md` 全局区 | 无裸键标题；`error` 组位于 `端口/文件占用` 之后 |
| 面板已解决墙 | 分组顺序与 `INDEX.md` 一致 |
| 面板待审箱 | 行为不变（行、✕、💬、族×N、暂存提示均正常）——**回归项** |

---

## 6. 回滚方案

| 步骤 | 可逆性 | 回滚动作 |
|---|---|---|
| S1 mine.cjs | 完全可逆（单文件，无状态） | 改回原 13 行薄壳（去掉 `exitCodeOf`），或 `git checkout -- scripts/mine.cjs`（发布库侧） |
| S2 client.js | 完全可逆（浏览器半边，刷新即回退） | 撤销 3 处改动；**无数据影响**（纯 DOM 生命周期） |
| S3 类别契约 | 完全可逆（纯展示层） | 还原 3 文件；`error` 键可保留（多一个标题不影响其他逻辑） |
| S4 自测 | 可逆 | 新增断言随代码一起回退 |
| S5 版本号 | 可逆但**需重跑部署** | 版本字符串改回 `0.7.2` → `deploy-web --apply`（副本要跟着回退，否则 `/whale/live` 与包再次不一致） |
| S6 部署 | 可逆 | `deploy-web.cjs --undo --apply`（只摘加载器行，插件不再加载）；彻底回退用 `lifecycle/cli.cjs uninstall detach`（含前像快照 `.lifecycle/backups/<时间戳>/`） |
| S8 发布 | 可逆 | `git revert <sync-sha>` + push（同步提交为单次原子提交，镜像可整体回退） |

**不可逆项**：无。本批次不改任何数据文件格式、不改 `state.json` 结构、不写用户记忆（`inbox.md` / `entries/` / `archive/` 全程不动）。

---

## 7. 风险与取舍

| 风险 | 评估 | 对策 |
|---|---|---|
| 退出码改动被误读为"每次会话都失败" | 低 | 契约明确"有新发现/有暂存也是 0"；AGENTS 提醒句文本不动 |
| 类别排序变化使用户"熟悉的墙顺序"变了 | 低-中 | 变化仅两类：`error` 组（从面板首组 → 中后位）+ 未来未登记类别（一律末尾）；在 §5 验收里显式列出 |
| 补 CHANGELOG 三条时把历史写错 | 中 | 取材**只从既有权威段落**（`PROJECT-INTRO.md:166`、`plugin/README.md:71`）转写，不凭记忆编造；v0.7.1/v0.7.2 描述与 `live.selftest` 断言数对齐 |
| 手工改发布库 README 与数据目录 README 再次分叉 | 中（结构性） | 本次只对齐版本行；把"README 是否纳入 `EXTRA_FILES` 镜像"登记为下一批候选裁量 |
| 重启窗口内的验收被跳过 | 中 | §5.2 把"重启后必验"的三条（`/whale/live` 版本、墙分组、面板回归）单列，重启当时就要过 |
| 静态结构断言（T8/T9）给出"已测"的错觉 | 低 | 已在 §5.1 注明其局限；真跑卸载需要 DOM 环境，属 C 批（改 Slot）时的收益 |

**取舍记录**

1. **只修 `error` 一类，还是修"类别展示契约"这一类？** 选后者：新增 3 个纯函数 + 改 3 处调用，成本与补一个键相当，却消除了"新增类别 → 裸键 + 排序分裂"这个复发模式。
2. **退出码是否顺手让 AGENTS 提醒句引用它？** 选"先不"。注入文本变更影响所有会话，收益（更早发现环境问题）不足以覆盖风险。
3. **是否把 `run()` 的失败也细分成 3/4 类？** 选"不"。0/1/2 已能区分"成功 / 环境缺失 / 逻辑坏了"，再细分属于过度设计。

---

## 8. 待确认裁定（3 项）

| 编号 | 问题 | 建议 | 影响面 |
|---|---|---|---|
| **D1** | 退出码是否采用 `2 = 前置缺失`？ | **采用**（与 `lifecycle/cli.cjs` 的 0/1/2 对齐；调用方 `!== 0` 依然可用） | 若改成"失败一律 1"，§3.1 与 T2 期望值同步改为 1 |
| **D2** | `error` 的中文标题与登记位置 | 标题「工具报错（未归类的失败结果）」，位置 `port-busy`之后 / `other` 之前 | 影响 `INDEX.md` 与面板墙的分组顺序；若想让它置顶，只需把键移到 `CATEGORY_TITLES` 首位 |
| **D3** | 版本收口方式 | **一次收口到 0.7.3**（0.7.3 从未部署/发布） | 备选：先 0.7.3 只做"已完成内容"对账、本批次记 0.7.4 → 需补 4 条 CHANGELOG（0.7.1–0.7.4） |

> 三项均可在开工前一句话定；若不定，按"建议"列执行。

---

## 9. 执行记录（S1–S4 已完成，2026-09-10 17 时）

**裁定已采纳**：D1 用 `2 = 前置缺失`（与 `lifecycle/cli.cjs` 对齐）· D2 标题「工具报错（未归类的失败结果）」、置于 `port-busy` 之后 · D3 一次收口到 **v0.7.3**。

**已改文件**

| 步 | 文件 | 改动 |
|---|---|---|
| S1 | `~/.dsh/whale-notebook/scripts/mine.cjs` | 新增 `exitCodeOf()` 与**唯一进程级** `process.exitCode`（0 / 2 / 1）；导出 `exitCodeOf` 便于自测 |
| S1 | `plugin/src/collector/cli.cjs` | 头注释订正：本模块只供薄壳复用、保持纯函数；宿主半边 `POST /whale/scan` 走 `engine.runScan` |
| S2 | `plugin/lib/client.js` | `ensureCss()` 返回**本次创建**的节点（复用既有则 `null`）；`apply` 记住 `cssNode`；disposer 回收它 |
| S3 | `plugin/src/core/schema.cjs` | 新增 `error` 标题；新增类别展示契约 `CATEGORY_ORDER` / `categoryTitle` / `categoryRank` / `sortCategoryKeys` 并导出 |
| S3 | `plugin/src/store/repo.cjs` | 全局区分组与停用表改用 `sortCategoryKeys` / `categoryTitle` |
| S3 | `plugin/src/ui/viewmodel.cjs` | 面板已解决墙分组改用同一契约（未登记类别两侧一致排末尾） |
| S4 | `plugin/src/ui/server.selftest.cjs` | **+4**：标题完备性（防复发）/ `error` 与兜底 / 排序秩与可复现 / 墙两侧分组一致 |
| S4 | `plugin/src/collector/e2e.selftest.cjs` | **+3**：CLI 退出码 0（正常）/ 2（两处 `ok:false` 全覆盖）/ 0（早返回分支） |
| S4 | `plugin/scripts/bundle-smoke.cjs` | **+2**：`cssNode` 创建 + disposer 回收 / 复用分支返回 `null` |
| S4 | `plugin/README.md`、`PROJECT-INTRO.md` | 计数与契约口径：server 45→50、e2e 60→63、合计 312→320、`live(28)`→`live(34)`；补 CLI 退出码说明 |
| S4 | `plugin/src/ui/contracts.md` | 删除 §2 中重复的 ③桌宠 / ④外观 两行 |

**验证证据（实测）**

- 9 套件 **320 PASS / 0 FAIL**，全部 exit 0：server **50** · privacy 10 · summarize 10 · similarity 20 · engine 10 · engine.dedup 19 · e2e **63** · live 34 · lifecycle 104
- 脚手架：`bundle-smoke` exit 0（`v0.4–v0.7.3 结构完整 … 样式回收`）· `redact.test` 13 passed / 0 failed · `links-doctor.selftest` ALL PASS(43) · `discuss-route.selftest` ALL PASS(28)
- CLI 实测（真实数据目录、只读路径）：`--check` / `--stats` / `--render-rules` / `--wall` 全部 **exit 0**；正常采集输出「新发现暂存 0 组（无）…待审共 2 条」
- **运行中的 GUI 未受影响**：宿主进程用的是已加载的旧模块，S1–S4 的改动要等 S6（`--apply`）+ S7（重启）才进入运行时

### 9.1 S5–S8 执行记录（同日 17:5x）

| 步 | 结果 | 证据 |
|---|---|---|
| S5 版本口径收口 | ✅ 两个库共 15 处改为 **0.7.3**；发布库 `CHANGELOG.md` 补上 **v0.7.3 / v0.7.2 / v0.7.1** 三条（此前最新条目只到 v0.7.0），口径行 0.7.0 → 0.7.3；发布库 `README.md` 当前版本 0.7.0 → 0.7.3、断言 306 → 320、版本沿革表补 3 行 | `plugin/package.json` / `lib/index.js` / `plugin/README.md` / `PROJECT-INTRO.md` / `<repo>/README.md` / `<repo>/CHANGELOG.md` |
| S6 部署 | ✅ `deploy-web --apply` 复制 **14 个文件**（含此前缺失的 `links-doctor.cjs` 及其自测）；`--check` **exit 0**（「副本与权威源逐字节一致 + patch 行在位」）；副本 `package.json` 已为 0.7.3 | 部署输出 + `--check` |
| S7 重启验证 | ✅ 用户重启后逐条实测：`GET /whale/live` → **`version: 0.7.3`**、`live.enabled: true`、`lastError: null`（新进程：sessions 1 / events 0 / flushes 0）；`GET /whale/solved` → **全局区三组标题为中文且秩序正确**（编码/中文乱码 → 工具模式误用 → git/网络），即 `sortCategoryKeys` 已在宿主生效；`GET /whale/inbox` → 200、待审 2 条未变（C128 / C129）、暂存 10 组；条目集未变（active 5 = 全局 4 + 项目级 1，停用 0）——**未触碰任何用户记忆** | 三端点 HTTP 实测均 200 |
| S8 生命周期对账 | ⚠️ `lifecycle/cli.cjs check` → **exit 1**：失败 0 / 差异 2 / 孤儿 0；两条差异是 `AGENTS.md` 与 `skills/whale-notebook.md` 的登记 hash ≠ 现场 hash。核对时间戳：两文件修改于 **16:35–16:36**、清单登记于 **11:46** → 属"登记后被合法内容更新"；且 AGENTS 自动段每次入库必然重写，**这是缺口 #7（漂移守卫为预期改动报警）的具体实证**，非本批次问题、非损坏 | `lifecycle check` 输出 + 文件时间戳 |
| S8 发布镜像 | ✅ 镜像 **20 个文件** → 本地提交 **`4d5484f`** → **已推送**（`9cf288f..4d5484f  HEAD -> main`，exit 0）；核验 `origin/main == HEAD == 4d5484f`、分支 main、工作树 clean | `git rev-parse` / `git status -sb` / `git log origin/main` |

**过程中修正的一处计划偏差（重要）**：用户在部署**之前**重启了一次 `dsh web`——那次重启只是把**未改动的副本**重新载入，运行时仍是 0.7.2。**正确顺序是"先 `--apply` 部署、再重启"**：部署只改磁盘上的副本，不影响正在运行的进程（实测：部署后 `/whale/live` 依旧自报 0.7.2，符合预期）。故 §4 的 S6 → S7 顺序不可颠倒。

**S7 验收清单（重启后逐条过）**：① `GET /whale/live` 的 `version` == `0.7.3`；② 面板已解决墙全局区分组标题为中文且与 `INDEX.md` 同序（当前数据不含 `error` 类别，故属"已具备"而非"可见变化"）；③ 面板待审箱回归（行、✕、💬、族×N 均正常）；④ 页面刷新后 `document.head` 里不残留插件注入的 `style` 节点、且不出现重复注入。另注：`INDEX.md` **无需**重生成——当前 active 集不含未登记类别，新旧排序结果逐字节相同。

---

## 附：本批次文件索引

| 文件 | 角色 |
|---|---|
| `~/.dsh/whale-notebook/scripts/mine.cjs` | A1 主体（唯一进程级退出码出口） |
| `~/.dsh/whale-notebook/plugin/src/collector/cli.cjs` | A1 关联（头注释订正；保持纯函数） |
| `~/.dsh/whale-notebook/plugin/lib/client.js` | A2 主体（`ensureCss` 所有权 + disposer） |
| `~/.dsh/whale-notebook/plugin/src/core/schema.cjs` | B3 主体（`error` 键 + 类别展示契约） |
| `~/.dsh/whale-notebook/plugin/src/store/repo.cjs` | B3 消费者一（`INDEX.md`） |
| `~/.dsh/whale-notebook/plugin/src/ui/viewmodel.cjs` | B3 消费者二（面板墙） |
| `~/.dsh/whale-notebook/plugin/src/ui/server.selftest.cjs` | T4-T7 |
| `~/.dsh/whale-notebook/plugin/src/collector/e2e.selftest.cjs` | T1-T3 |
| `~/.dsh/whale-notebook/plugin/scripts/bundle-smoke.cjs` | T8-T9 |
| `~/.dsh/whale-notebook/plugin/package.json`、`lib/index.js`、`plugin/README.md`、`PROJECT-INTRO.md`、`plugin/src/ui/contracts.md` | B1（数据目录侧） |
| `<repo>/README.md`、`<repo>/CHANGELOG.md` | B1（发布库侧，手工改，随下次同步入库） |
| `~/.dsh/whale-notebook/plugin/scripts/deploy-web.cjs` | B2 执行者（R 段唯一写入者） |
| `<repo>/tools/sync-release.cjs` | B2 发布镜像 |
