# 鲸鱼闪闪发光的小本本（whale-notebook）— DSH 自我进化机制 实施记录

> 日期：2026-09-09 ｜ 作者：DSH Agent（本机实施）｜ 版本：v1.0
> 定位：DeepSeek Harness 侧的经验固化体系，借鉴 `C:\ClaudeCode\SandBox3\docs\` 两份 Claude Code 实施方案（经验避坑手册/三层防线）后按 DSH 原生机制落地。

---

## 一、方案结论：用什么载体

**用 DSH 原生双层（L1 全局记忆 + L2 技能），不做 Web 客户端插件、不建 DSH 之外的外部机制。**

| DSH 侧 | Claude Code 对照 | 作用 | 生效方式（已实测） |
|---|---|---|---|
| L1 `~/.dsh/AGENTS.md` 自动段 | ~/.claude/CLAUDE.md | 每会话注入 ≤12 条高频规则 + 提醒句 | agent-instructions 插件由 standard preset 挂载（maxBytes 65536）；文件写入后**同会话立即注入**（本次实施中已验证：写文件后系统即推送 `Instructions from: ~/.dsh/AGENTS.md`） |
| L2 `~/.dsh/skills/whale-notebook.md` | ~/.claude/skills/ | 采集/审核/入库/讨论/忘掉/统计操作手册 | dsh-skill-filesystem 热扫描；技能文件写入后**同会话目录即更新**（本次已验证：系统推送新技能目录） |
| L3（近似） | PreToolUse Hook | DSH 无 hook 体系 → 用「L1 摘要 + 技能铁律 + 脚本兜底统计」软约束 | 不依赖模型自觉的硬拦截不可行，设计上回避需要硬拦的规则 |

- 插件方案评估后否决：需 `dsh plugin` + pnpm 安装与构建维护，收益（GUI 角标）与成本不成比例；本期不开发，列入可选二期。

## 二、部署文件清单（全部在 ~/.dsh 内）

| 路径 | 内容 |
|---|---|
| `~/.dsh/AGENTS.md` | L1 全局记忆：手动段（用户自写）+ `<!-- whale-notebook:rules -->` 自动段（规则行+自动采集提醒+触发词+隐私句） |
| `~/.dsh/skills/whale-notebook.md` | L2 技能（frontmatter: name/description/whenToUse/metadata；正文含隐私铁律与六步工作流） |
| `~/.dsh/whale-notebook/README.md` | 目录说明 + 隐私策略 |
| `~/.dsh/whale-notebook/settings.json` | autoCollect / denylistWorkspaces / minOccurrences / maxRulesInAgents |
| `~/.dsh/whale-notebook/state.json` | 增量指纹（FNV-1a hash36，不存原文）与候选编号 |
| `~/.dsh/whale-notebook/inbox.md` | ★待审核箱：12 条种子候选（C001–C012，用户决定暂缓入库） |
| `~/.dsh/whale-notebook/entries/`（空） | 经验条目 E0NN-*.md（待首次入库生成） |
| `~/.dsh/whale-notebook/archive/`（空） | 已处理候选归档 |
| `~/.dsh/whale-notebook/scripts/mine.cjs` | 采集脚本（只读扫描 + 打码 + 增量去重 + 追加待审行） |
| `~/.dsh/whale-notebook/scripts/redact.test.cjs` | 打码回归测试（13/13 PASS） |

## 三、采集脚本 mine.cjs 设计要点

- **只读**：仅解码读取 `~/.dsh/sessions` 全部工作区（3 个、9 会话）；写操作只限 inbox.md / state.json。
- **事件源**：`tool/result` 的 isError + 命令类工具（pwsh/bash）成功结果的特征扫描 + 用户/助手叙述中高信号类别；read/grep 等结果内嵌文件内容**不**参与扫描（防误报）。
- **特征表**：encoding / sandbox-ep / sandbox-file / stale-fs / timeout / git-net / model-api / file-missing / port-busy。
- **打码**：github_pat_*/ghp_*/sk-*/AKIA/JWT/超长 base64/键值密钥 → `[REDACTED]`；`C:\Users\gengj\...` → `~`；绝对路径参数化 `<path>`。
- **增量**：指纹 = `会话id|时间|hash36(规范化文本)`；只追加新发现；自引用输出（mine/stats 文本含类别词）显式排除。
- **命令**：`--check`（会话开头自动用，一行摘要）/ `--prewarm`（装机首扫，只记指纹）/ `--stats`（全量分布）。

## 四、自我进化闭环（现状与使用方式）

1. **自动采集**：每个新会话开头，模型按 AGENTS.md 提醒句运行 `mine.cjs --check`；有新发现则追加待审行。
2. **会话提醒**：有待审候选时向用户展示 inbox.md 小列表（编号|类别|次数|工作区|现象），用户可「先不管」。
3. **提炼入库（人工确认）**：用户说「小本本复盘/入库 C0xx/全部入库」→ 技能先展示拟规则行 → 确认后写 entries/、重建 INDEX.md、重写 AGENTS.md 自动段（≤12 条按 occurrences 降序）→ 候选行移 archive/。
4. **工作区讨论**：「小本本讨论 <主题/工作区>」按 entries 检索 + 会话内临时解码证据（打码）。
5. **忘掉/导出**：`忘掉 E0xx` 置 disabled 并同步自动段；导出打包仅通用经验。

**首轮审核结果**：12 条种子候选（源自当日《DSH 运行记录梳理与避坑经验总结》）已全部放入待审核箱；用户决定**暂不入库、全部保留待审**——entries 为空、AGENTS.md 规则段为空，待日后逐条决策。

## 五、验证结果（实施中实测）

- ✅ AGENTS.md 注入：写入后系统即时推送 `Instructions from: ~/.dsh/AGENTS.md`（含后续变更提醒能力）。
- ✅ 技能热注册：whale-notebook.md 写入后系统即时推送技能目录更新。
- ✅ 打码回归 13/13（PAT/ghp/sk-/AKIA/键值对/长 token/家目录/路径/正常中文保留）。
- ✅ 采集链路：prewarm 78 事件/78 指纹；`--check` 在无新事件时输出 `新发现 0 条 | 待审共 12 条`（无重复、无自引用噪声）；sessions 9 个文件全程零改动。
- ✅ 隐私核对：inbox/规则行无原文、无密钥；状态文件存 hash 指纹不存原文。

## 六、遗留与后续（待触发项）

- [ ] 首次「入库」演练：用户日后勾选候选后走一遍 entries→INDEX→AGENTS 自动段→archive 全链路（含 AGENTS.md 同会话二次注入观察）。
- [ ] 首次新会话端到端提醒验证（自动采集提醒句生效）。
- [ ] 可选二期：GUI 待审角标（client-plugin）；机制+空模板发布（不含本机经验数据）。

## 七、回滚方法

1. 删除 `~/.dsh/skills/whale-notebook.md`；
2. 删除 `~/.dsh/AGENTS.md` 自动段（或整文件）；
3. 删除 `~/.dsh/whale-notebook/` 目录。
三步互不依赖，可单独启停；对 `~/.dsh/sessions` 等原始数据零影响。
