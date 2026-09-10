# 鲸鱼闪闪发光的小本本 · 插件生命周期设计（安装 / 卸载 / 清单机制）

> 日期：2026-09-09 ｜ 作者：whale-notebook 项目 ｜ 版本：v0.1（设计稿，待评审）
> 配套文档：《2026_09_09_16_whale-notebook插件化架构设计.md》（v2.0 架构）——本文档是其 v2.1「生命周期」部分的细化设计。

## 1. 背景与目标

### 1.1 触发背景

- v2.0 模块化重构完成，v2.1 将把 `@deepseek-ai/dsh-whale-notebook` 真实挂载进 DSH（profile bundles + node_modules）。
- 本插件的安装现实是：**整文件夹复制 / AI 代为安装删除**，而非用户手工执行安装器。
- 没有清单时，任何一方（含未来执行卸载的 AI）都无法回答「这个插件到底用了哪些文件、改过哪些文件」→ 删除必然不可信、必然有残留风险。

### 1.2 目标

1. **装得上**：安装过程确定性、可复核、可回滚；
2. **卸得净**：删除后 DSH 用户环境（`~/.dsh` 等）与安装前逐字节等价，无残留；
3. **可校验**：任何时候可对账「清单 vs 现场」；
4. **不破坏**：绝不越界触碰清单之外的用户/DSH 文件。

### 1.3 非目标（范围边界）

- ❌ 不做通用插件包管理器（不管理用户的其他插件）；
- ❌ 不替代 DSH 原生插件通道（见 §3），只补其未覆盖的缝；
- ❌ 不负责把插件分发给他人（无发布/依赖解析）。

## 2. 术语与三类足迹

插件的落地面按风险与所有权分三段，**卸载分级与实现都以此为基础**：

| 段 | 内容 | 今天状态 | 卸载难度 | 所有权 |
|---|---|---|---|---|
| **R 运行时** | `profiles\node_modules\@deepseek-ai\dsh-whale-notebook\` 包本体 + `profiles\web\package.json` 的 `dsh.profile.bundles` 声明（+ 可能的 patch 层） | 未发生（v2.1 才做） | 最难：动 DSH 环境文件；运行中 GUI 可能占用 | 混合（声明属 DSH，包本体属本插件） |
| **I 集成** | `~/.dsh\AGENTS.md` 自动段（标记内）、`~/.dsh\skills\whale-notebook.md` | **已存在** | 易：AGENTS 已有 begin/end 标记；skill 整文件属本插件 | 混合（标记段内属本插件） |
| **D 数据** | `~/.dsh\whale-notebook\`（inbox / entries / state / settings / scripts / plugin 源码） | 已存在 | 敏感：**这是用户积累的记忆** | **用户**（源码部分属项目，数据全部属用户） |

## 3. 现场事实与原生通道盘点（Seam 盘点）

### 3.1 已确认事实

- profile 为 hoisted node_modules 布局，共享目录：`~/.dsh\profiles\node_modules\@deepseek-ai\`；`profiles\web\package.json` 结构为 `dsh.profile.bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`，dependencies 为空。
- 本会话（standard agent preset / web profile）**工具面无 cordis 自管理工具**（此前审计结论），但——
- rc.2 发行版 profile 的 node_modules **目录中存在**以下原生生命周期相关包（存在 ≠ 已对 agent 暴露，见 3.2）：

| 原生包 | 描述（摘自 package.json） | 潜在价值 |
|---|---|---|
| `@deepseek-ai/dsh-tool-cordis` | Self-referential cordis toolset：inspect 运行时、**mount and dispose model-written plugins** | 原生「模型装载/卸载插件」工具 |
| `@deepseek-ai/dsh-cordis-host-runner` | 动态包定义注册表、host 半场沙箱生命周期、model-mounted 双半场包调用表 | 运行时挂载能力（非仅重启生效） |
| `@deepseek-ai/dsh-host-plugin-inventory` | 只读投影当前 Cordis Loader 插件状态 | 原生库存查询 |
| `@deepseek-ai/dsh-client-ui-settings-plugins` | Web「插件设置」段：feature 卡片 + 可配置 host 插件卡 | 原生 UI 表面 |
| `cordis-plugin-loader` | 插件装载器本体 | — |

### 3.2 待探明项（Seam 探针清单，Step 0 执行）

1. `dsh-tool-cordis` 在 rc.2 的 web profile / standard 预设下，对 agent 的**暴露条件**（是否出现在工具面、是否需要配置或审批）；
2. 其 mount 行为**是否持久化**到 profile 声明文件，还是仅运行期生效；
3. `dsh-host-plugin-inventory` 能查询到什么粒度（仅 host 半场？含 client 半场？）；
4. 原生 dispose/卸载语义：是否清理包文件，还是仅摘声明。

### 3.3 决策 D1：适配器原则

> **原生通道可用时走原生通道；我们的工具只补原生未覆盖的缝（R 持久化声明、I 集成痕迹、D 数据），并作为原生通道的统一入口封装。**

理由：若原生 mount 与手工改 `bundles` 并存，等于同一状态双写，迟早不一致（双写冲突风险，见 §11）。

## 4. 总体设计

### 4.1 定位：第 0 功能（自举层），非业务功能

- 生命周期是 v2.1 挂载的**前提与信任基础**：装不上/卸不净，其余功能（记录/审核/展示）无从谈起。
- 独立于六大业务模块（core/store/collector/inject/review/ui），是横切的自管理层。
- 落位待定（决策 Q3，§10）：`plugin/lifecycle/` 独立子模块（可单测，推荐）或独立脚本。

### 4.2 运行约束：自举可用性

- lifecycle 工具**不依赖运行时装载**：插件源码未安装、甚至 D 段目录被移动时，从任意位置 `node <path>/lifecycle/cli.cjs ...` 仍须可用；
- 因此 lifecycle **只依赖 Node 内建模块**（fs/crypto/path），不得 import 业务模块（业务模块依赖 node:zlib 等运行时环境）。

### 4.3 命令面（全部两段式：`--dry-run` 计划 → 确认 → `apply`）

| 命令 | 作用 | 幂等 |
|---|---|---|
| `lifecycle.cjs install` | 按清单计划执行安装 | ✅（按清单 diff，只做缺的） |
| `lifecycle.cjs uninstall <level>` | detach / remove / purge 三级卸载 | ✅（已卸状态直接成功返回） |
| `lifecycle.cjs check` | 清单 vs 现场对账 + 孤儿扫描 + 越界报告 | — |
| `lifecycle.cjs status` | 显示当前阶段、各级足迹现状、上次操作时间 | — |

## 5. 清单机制（核心）manifest.json

### 5.1 存放与生命周期

- 单实例清单随插件包存放：`plugin/manifest.json`（包内版本化默认清单）+ 安装后镜像 `~/.dsh\whale-notebook\.lifecycle\manifest.json`（现场版本，含实际时间戳与前像记录）。
- **清单随最后一级卸载删除**：remove/purge 完成即无残留（含清单自身）。

### 5.2 Schema（草案）

```jsonc
{
  "schemaVersion": 1,
  "plugin": "@deepseek-ai/dsh-whale-notebook",
  "installedAt": "2026-09-09T16:30:00+08:00",
  "entries": [
    {
      "path": "C:\\Users\\<user>\\.dsh\\skills\\whale-notebook.md",
      "kind": "file",          // file: 整体属本插件；dir: 整目录属本插件；edit: 外部文件局部修改
      "owner": "plugin",       // plugin | user-memory(D段数据)
      "segment": "I",
      "state": "installed"
    },
    {
      "path": "C:\\Users\\<user>\\.dsh\\AGENTS.md",
      "kind": "edit",
      "segment": "I",
      "markerBegin": "<!-- whale-notebook:rules -->",
      "markerEnd": "<!-- /whale-notebook:rules -->",
      "backup": ".lifecycle/backups/20260909_1630/AGENTS.md",
      "hashBefore": "sha256:...",
      "hashAfter": "sha256:...",
      "state": "installed"
    },
    {
      "path": "C:\\Users\\<user>\\.dsh\\profiles\\web\\node_modules\\@deepseek-ai\\dsh-whale-notebook",
      "kind": "dir",
      "segment": "R",
      "state": "installed"     // 实现落点：web profile 的 node_modules(原设计稿写 profiles\node_modules, 已按 deploy-web.cjs 实际布局订正)
    }
  ]
}
```

### 5.3 条目的三重身份

1. **卸载白名单**：卸载只允许删除/还原清单内条目；
2. **越界黑名单**：清单外路径一律不碰（保护用户原 DSH 环境的机制性保证）；
3. **校验基准**：`check` 用 `hashBefore/hashAfter` 与现场逐项对账。

### 5.4 反向标记约定（防游离物）

写进他人/外部文件的一切痕迹必须可指认，`check` 据此扫描「有标记但不在清单」的孤儿（例如 AI 手工复制产生的游离物）：

| 目标文件 | 反向标记方式 |
|---|---|
| `~/.dsh\AGENTS.md` | begin/end 注释段（已有，沿用） |
| `profiles\web\package.json` | 只做 JSON 结构手术（增删 `bundles` 数组元素），清单记录原数组；**禁止文本替换** |
| 本插件数据/源码文件 | 文件头统一注释 `#/@ whale-managed: <plugin>` |
| skill 文件 | 整文件属本插件（file 类），无需内部标记 |

## 6. 安装流程（两段式 + 状态机）

### 6.1 流程

```
install --dry-run
  ├─ 1. 现场预检（目标文件现状、是否已有前像、DSH 是否运行中）
  ├─ 2. 生成计划（将新建/修改/备份的动作清单，逐条含目标 hash）
  └─ 输出人机可读计划 → 用户/AI 确认
install --apply
  ├─ 1. 对每个将被修改的外部文件做字节级前像备份 → .lifecycle/backups/<时间戳>/
  ├─ 2. 写入 I 段（AGENTS 自动段 / skill 文件）
  ├─ 3. 写入 R 段（经原生通道或声明修改，seam 实测后定）
  ├─ 4. 写现场清单（含各文件 hashAfter）
  └─ 5. 自检：check 通过 → 置 installed
```

### 6.2 状态机

`none → backed-up → partially-applied → installed`；阶段写入 `.lifecycle/state.json`：

- **中断可续**：apply 重跑只做未完成步骤（幂等）；
- **中断可回滚**：`uninstall` 可从任意中间态恢复前像；
- 任何一步失败：现场不动、清单不更新，报告差异。

### 6.3 运行中 GUI 约束（R 段）

- DSH web 运行中：R 段物理删除**不得直接删包文件**（进程占用 → 删不净还报错）；
- 两拍删除：① 摘声明（bundles / 原生 dispose）+ 包移入隔离区 `.lifecycle/quarantine/`；② 「重启后清理队列」（DSH 未运行时物理清除隔离区）。

## 7. 卸载分级

| 级别 | 清什么 | 留什么 | 适用 |
|---|---|---|---|
| `detach` | 仅 R 段（运行时消失） | I + D 全留 | 暂时不用/排查冲突，随时可重挂 |
| `remove` | R + I 段 | **D 原样保留**（用户记忆） | 不再使用但保留经验积累 |
| `purge` | R + I + D | 无（前置：自动导出归档到用户指定位置 + 二次确认） | 彻底告别 |

### 底线（与隐私原则一致）

> **用户的记忆数据（inbox/entries/D 段）永不随卸载静默删除；purge 前必须完成导出归档并经用户二次确认。** 归档导出物默认放用户指定路径，导出内容遵守既有打码规则（fingerprint-only，无原文）。

## 8. check / status 语义

| 检查 | 方法 | 输出 |
|---|---|---|
| 清单对账 | 逐条比对 `hashAfter` vs 现场 | 通过 / 差异条目清单 |
| 越界检测 | 清单外路径是否被改动（对比预检基线） | 报告但不自动处理（不碰=安全承诺） |
| 孤儿扫描 | 按 §5.4 反向标记扫已知目录 | 游离文件清单（供人工/AI 裁决） |
| 一致性 | 现场清单 vs 包内默认清单 | 版本/条目差异 |

## 9. AI 可执行性约定

- 所有写操作默认 `--dry-run` 先行，输出计划后由 AI 展示给用户，**用户确认后才 apply**——与项目「先展示后落盘」哲学一致；
- 命令输出 stdout 为稳定文本（状态行 + 差异行），供 AI 直接引用复述，不依赖人工解析；
- 卸载执行前 AI 必须运行 `check`，把差异一并展示给用户。

## 10. 实施路线

| 步骤 | 内容 | 产出 | 前置 |
|---|---|---|---|
| **Step 0** | Seam 探针：实测 §3.2 四项（headless pilot 中验证 tool-cordis 暴露条件、mount 持久性、inventory 粒度、dispose 语义） | 原生能力边界表 | 本文档评审通过 |
| **Step 1** | 设计定稿：按探针结果修订 §5–§7（含 R 段走原生还是声明修改的最终方案）；答复 Q1–Q3 | 本文档 v1.0 | Step 0 |
| **Step 2** | v0.1 实现：先覆盖 **I + D 段**（今天即具备验证条件：真实卸载演练——删除 skill 文件 + 还原 AGENTS 标记段后，`~/.dsh` 与安装前逐字节等价） | lifecycle 工具 + 演练报告 | Step 1 |
| **Step 3** | v0.2 实现：R 段（按 Step 0 结论选通道）+ 隔离区/重启清理队列 | 完整生命周期 | Step 2 |

## 11. 风险与取舍记录

| 风险/取舍 | 说明 | 对策 |
|---|---|---|
| 双写冲突 | 原生 mount 与手工改 bundles 同时存在 → 声明状态不一致 | D1 适配器原则：单一通道封装 |
| 运行中占用 | GUI 运行时删除包文件失败 | 两拍删除 + 隔离区（§6.3） |
| 版本漂移 | 研究文档基于主分支，rc.2 实际行为不同 | 一切以本机实测为准；Seam 探针先行 |
| 卸载误伤 | 删除到用户/DSH 文件 | 白名单+黑名单双约束（§5.3）+ 前像恢复 |
| 数据归属 | D 段含用户记忆，删错不可逆 | purge 前置导出+二次确认；remove 永不碰 D（§7） |
| 清单自身残留 | 卸载后清单文件本身成为残留 | 清单随最后一级卸载删除（§5.1） |

## 12. 待决问题（Q1–Q3，Step 1 前拍板）

- **Q1**：Seam 实测是否排为下一步（推荐：是——决定轮子厚度，避免双写冲突）；
- **Q2**：卸载三级 detach/remove/purge + 「数据永不静默删除、purge 前导出+二次确认」底线是否认可（推荐：认可）；
- **Q3**：lifecycle 落位：`plugin/lifecycle/` 独立可单测模块（推荐）还是独立脚本（轻但难测）。

## 13. 验收标准（可判定）

1. `install` 幂等：连续两次 apply，第二次零动作；
2. 安装后 `check` 全绿；
3. `uninstall remove` 后：`~/.dsh` 中所有清单外路径 hash 与安装前一致；skills/AGENTS 与安装前逐字节等价；无 whale-notebook 相关文件残留（除 D 段）；清单自身已删除；
4. `purge` 在无导出确认时拒绝执行；导出物不含原始会话内容（仅打码摘要）；
5. 任一步骤中断后重跑，现场可续可回滚，无半成品状态残留；
6. DSH 运行中执行 R 段卸载不报文件占用错误（走隔离区）。
