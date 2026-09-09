# 鲸鱼决策箱悬浮侧边面板 · 设计与实施

> 类型：设计文档（v1.0 定稿）
> 日期：2026-09-09 18:00（+08:00）
> 项目：whale-notebook（鲸鱼闪闪发光的小本本）
> 范围：DSH Web GUI 的待审核候选（决策箱）交互入口 —— 常驻侧边悬浮面板 + 三条处置动作

## 1. 背景与需求

待审核候选（inbox.md 的 C001–C012）目前只能靠会话内「自动采集提醒」或用户说「小本本待审」才被看到。用户希望有一个**不打扰工作**的常驻入口，随时可以看到决策箱内容并处置：

1. 悬浮在屏幕（GUI 页面）侧边，**极小、绝不干扰 DSH 使用**；
2. 大约可见 5~6 条，多则滚动；
3. 鼠标悬停某一条出现三个动作：
   - **自动处理**：告诉 AI 该问题简单、自动处理即可；
   - **详细讨论**：把该问题（含上下文/实际情况）放到一个新会话；用户在该新会话里完成经验总结与写入全局小本本；
   - **删除**：该问题大概率已解决或无需解决 → 删除该内容。

## 2. 机制勘察结论（方案可行性依据）

全部基于本机 DSH 0.1.1-rc.2（npm 全局 + `~/.dsh/profiles/web` profile）实际源码/产物勘察：

| 需求面 | 结论 | 依据 |
|---|---|---|
| 浏览器扩展 | client-plugin：loader 行（entry name=包名）→ 包 `dsh.client {platform:"web"}` + `exports["./client"]` → `client-modules` 收录并 serve `/plugins/<包名>/client.js`；页面经 `__DSH_BOOT__` 图加载 | `dsh-client-modules/lib/index.js` |
| 插件双半 | 一个 npm 包 = host 半（`main` 的 cordis `apply`）+ browser 半（`lib/client.js`，格式 `window.__ModuleLoader__.load({id, factory})`），官方 client 包同款（如 `dsh-client-ui-skill`） | 各 `dsh-client-ui-*/package.json` |
| host 自定义 HTTP API | `webServer` service 提供 `register({kind:"exact"\|"prefix", path, handler(req,res)})`（node:http 原生），无鉴权层、与 GUI 同信任面；`/api` 前缀被网关占用 → 自定义路径用 `/whale/*` | `dsh-host-webserver/lib/index.js` |
| 当前会话/新会话（浏览器侧） | `ctx.sessions`（SessionRuntime）：`list.getSnapshot().current`、`binding(id).session.prompt(content,"queue")`、`create({workspaceId})`、`open(id)`；`ctx.workspaces.list` 得当前会话所在 workspace | `dsh-client-runtime` types + `dsh-client-ui-conversation` 调用点 |
| inbox 数据操作 | `repo.cjs` 原语齐备：`readInboxText/pendingCount/removeInboxRows/archiveInboxRows`；列表解析复用 `viewmodel.inboxViewModel()` | `plugin/src/store/repo.cjs`、`src/ui/viewmodel.cjs` |
| 浏览器 bundle 依赖 | 官方 client 产物可**零 require 依赖**手写（纯 DOM + CSS，样式用官方 `--dsw-alias-*` 主题变量 + fallback）→ 不需要 react/官方组件/tsdown 构建链 | `lib/client.js` 头部格式 |

关键约束：**loader 行集在 dsh web 启动时固定**（`plugin-set changes take effect on restart`），新增插件行或改动 bundle 内容都需重启 dsh web 一次；页面刷新只重渲染 index 注入。

## 3. 架构

```
浏览器（127.0.0.1:3080，dsh web）
  dsh-whale-notebook browser half（lib/client.js，纯 DOM 悬浮面板）
    ├─ 轮询 GET  /whale/inbox                    → {pending, rows}
    ├─ 动作「删除」POST /whale/inbox/delete {id} → 移入 archive + 从 inbox 移除
    ├─ 动作「自动处理」→ ctx.sessions 当前会话 prompt 授权消息（agent 走既有技能流程）
    └─ 动作「详细讨论」→ ctx.sessions.create({workspaceId}) → prompt 上下文模板 → open(id)
宿主 cordis（dsh web 进程）
  dsh-whale-notebook host half（lib/index.js apply，loader 行 inject: [webServer]）
    └─ webServer.register /whale/inbox、/whale/inbox/delete
        └─ 业务纯逻辑 src/ui/server.cjs（复用 repo.cjs + viewmodel.cjs）
```

不引入自定义 Remote/typert 域、不改任何官方包、不改 AGENTS/entries 写入口、不新增后台进程。

## 4. 包结构改动

| 文件 | 说明 |
|---|---|
| `plugin/lib/client.js`（新） | 浏览器半边：面板 bundle（`__ModuleLoader__.load`，零 require；CSS 注入 `<style data-plugin-css>`；类前缀 `wh-`） |
| `plugin/lib/index.js`（改） | host 半边：apply 注册两条 `/whale/*` 路由（`ctx.effect` 收尾注销）；webServer 缺失时 warn 跳过 |
| `plugin/src/ui/server.cjs`（新） | host 纯逻辑：`listPayload()`、`deleteCandidate({id, now})`（校验→归档+处置列→移除，幂等） |
| `plugin/src/ui/server.selftest.cjs`（新） | 沙盒单测（临时 DSH_HOME；17 断言） |
| `plugin/scripts/bundle-smoke.cjs`（新） | client bundle 桩执行（vm + `__ModuleLoader__` 桩） |
| `plugin/scripts/deploy-web.cjs`（新） | 部署工具（见 §7） |
| `plugin/package.json`（改） | version 0.2.1；`exports["./client"]`；`dsh.client {platform:"web", inject:["@deepseek-ai/dsh-client-runtime"]}`；files 增 lib/client.js |

host half 对 webServer 的依赖声明在 loader 行的 `inject: [webServer]`（host 侧 loader 语义；浏览器侧的依赖由 `dsh.client.inject` 表达，互不干扰）。

## 5. 数据与行为契约

### 5.1 API

- `GET /whale/inbox` → `200 {ok:true, pending, rows:[{id,cat,n,ws,text,time}]}`（rows 解析自 inbox.md 表行，现象已打码，格式不变式见 viewmodel）
- `POST /whale/inbox/delete` body `{id:"C012"}` → `200 {ok:true, removed:1}` | `404 {ok:false,error}`（非法编号 / 不存在）
- 其余方法 405、异常 500，全部 JSON；body 上限 16KB

### 5.2 删除语义（红线对齐）

`候选行原文 + " | 面板删除 <本地时间>"` → `archiveInboxRows`（`archive/archive-YYYYMMDD.md` 当日文件，对齐 7 列表头含处置列），随后 `removeInboxRows([id])`。**可恢复、不物理销毁**，与既有「入库后移 archive」归档语义同构；错误路径（未知/非法编号）不写盘。

### 5.3 UI 规格

- 收起态：右侧垂直居中胶囊细条（🐳 + 「待审」竖排 + 红色计数徽标），宽约 24px，几乎不占空间；0 条候选时整体隐藏。
- 展开态：点击条切换 280×248px 圆角卡片（约 6 行视口，`overflow-y:auto` 滚动）；头部「🐳 待审箱 · N」+ ⟳ 刷新 + ✕ 收起；底部一行说明。点击卡片外部或 Esc 收起。
- 行内容：`C###` 加粗 + 类别胶囊 + `×次数` + 现象两行截断（hover 显示完整现象/工作区/首次时间）。
- 行 hover：行尾显三按钮（⚡自动处理 / 💬详细讨论 / 🗑删除，title 提示）。按钮点击 `stopPropagation`，不收起面板。
- 刷新：展开立即 + `focus`/`visibilitychange` + 30s 轮询；fetch 失败静默降级（console.warn），绝不打扰用户任务。
- toast：右下角轻提示（成功/失败原因）。

### 5.4 动作语义（投递文本见 client.js）

- **自动处理**：要求存在当前会话（否则 toast 引导先开会话）；向当前会话 prompt 一条「用户已授权自动处理 C###」消息，AI 按小本本技能流程提炼 → **先展示写入计划 → 用户确认 → 落盘**（既有隐私红线原样保留，不做静默入库）。
- **详细讨论**：取当前会话所在 workspace（无则默认）`sessions.create` → 对新会话 prompt 「候选转入讨论」上下文消息（只读/打码/禁止改文件，等用户指示）→ `open(newId)` 切过去。
- 候选信息一律取自 inbox 已打码行，不读取/复制源会话原文。

## 6. 安全与信任面

- `/whale/*` 端点信任面与 GUI 自身一致（默认 127.0.0.1 loopback）；若 `--host 0.0.0.0` LAN 暴露，与现有 UI 同面（后续可加 Host 白名单，本期不做）。
- 面板仅展示 inbox 内容；不触 AGENTS.md、entries/、settings 与原始会话日志。

## 7. 部署 / 回退 / 升级

部署工具 `plugin/scripts/deploy-web.cjs`（幂等、两段式；源 = `~/.dsh/whale-notebook/plugin`）：

```powershell
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs"            # dry-run 计划
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --apply    # 执行：复制包 + patch cordis.patch.yml（managed 块）
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --check    # 自检
node "$env:DSH_HOME\whale-notebook\plugin\scripts\deploy-web.cjs" --undo --apply [--yes]  # 回退
```

- patch 目标：`~/.dsh/profiles/web/cordis.patch.yml` 写入 managed 块（`- insert:` 行 `id: whale-notebook` / `name: '@deepseek-ai/dsh-whale-notebook'` / `inject: [webServer]`）。
- **生效**：重启 dsh web（loader 行集启动时固定）。重启会中断当前会话进程；会话历史已持久化，重启后可在 GUI 恢复。
- dsh 升级 / pnpm 重装若清理 `profiles/node_modules` → 重跑 `deploy-web.cjs --apply` 即恢复。
- 回退：`--undo --apply`（可加 `--yes` 删除包目录）→ 重启后完全移除。
- 未来 bundle 改动：改 `plugin/lib/client.js` → 重跑 deploy → 重启。

## 8. 验收清单（重启 GUI 后）

1. 右缘收起细条 + 徽标 12；聊天区无遮挡/无布局位移。
2. 展开约 6 行可见、滚动正常；行与 inbox.md 一致（打码）。
3. hover 行三按钮；⚡ 投递当前会话并触发 AI 流程；💬 开新会话并含候选上下文、AI 不擅自写文件；🗑 行消失 + toast；核对 inbox/archive 文件变化（处置=面板删除）。
4. 外部点击/Esc 收起；focus 与 30s 轮询刷新正常；删除后计数即时更新。
5. lifecycle 现场仍 installed，AGENTS.md 自动段未被触碰。

## 9. 已知限制与后续（本期不做）

- 无服务端推送（30s 轮询 + focus 刷新足够）；无多选/批量；无面板位置/展开记忆；不做 LAN 白名单。
- 「自动处理」结果依赖当前会话 AI 是否在线与用户最终确认，面板只负责投递与提示（不轮询处理结果——pending 数变化会自动反映）。
- 桌宠形态、事件推送（whale/inbox-changed SSE）留待 v2.2（contracts.md 事件契约）。
