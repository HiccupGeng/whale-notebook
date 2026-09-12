// inject/agents.cjs - 生效层 L1：AGENTS.md 自动段生成器（唯一规范来源）
// skill 与未来插件都调用这里，保证 AGENTS 自动段行文/标记永不漂移。
'use strict';
const repo = require('../store/repo.cjs');
const { AGENTS_MARK, ruleLine } = require('../core/schema.cjs');

// 自动段头部（紧跟 begin 标记之后）
const SECTION_HEADING = '## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）';

// 固定尾注（紧跟规则行之后，end 标记之前）
// v0.6：提醒句必须与实际采集行为一致，不能写着手动却偷偷入箱。
// v0.7.8：改为**双模式自述**（不再按 settings.autoAdd 二选一）。为什么：
//   模式从此可由面板「自动收集」开关即时切换，若注入文本仍写死一种模式，切换后每个新会话都会被
//   告知错的行为；而"按开关改写 AGENTS.md"意味着每次点击都动用户的全局记忆文件、并与 agent 入库
//   编辑抢写、还会把 lifecycle 的标记区基线打成「待登记」。改成"以命令输出为准"后：
//   注入文本永远不撒谎（--check 的输出本身就区分「新发现 N 条」/「新发现暂存 N 组」），
//   且开关切换只改 settings.json，一个字节都不碰 AGENTS.md。
function tailLines(settings) {
  const checkEnabled = settings.autoCollect !== false && settings.checkEnabled !== false;
  const listMax = Number.isFinite(settings.reminderListMax) ? settings.reminderListMax : 3;
  const lines = [];
  if (checkEnabled) {
    lines.push(`- **自动采集提醒**：每个新会话开始后运行 \`~/.dsh/whale-notebook/scripts/mine.cjs --check\`（增量扫描：未更新的会话日志只 stat 跳过、通常 <100ms；会话运行中出现的失败已由插件实时判定并落盘）。**本轮是"自动入箱"还是"仅暂存"以该命令的输出为准**（由 settings.autoAdd 决定，随时可用决策箱面板页脚的「自动收集」开关切换，切换后无需重启）：输出含「新发现暂存 N 组」＝**仅暂存**模式（拉取式），新发现**没有进待审箱**，只报一行「新发现 N 组已暂存（未入箱）」即可，不要展开清单、不要询问是否审核；用户说「小本本复盘 / 待审核箱 / 审核候选」时先跑 \`~/.dsh/whale-notebook/scripts/mine.cjs --add\` 把暂存冲入待审箱，再按技能流程展示候选。输出含「新发现 N 条」＝**自动入箱**模式，待审总数 ≤ ${listMax} 条时展示编号清单（每条一行：编号|类别|次数|工作区|现象简述）并询问是否审核；超过 ${listMax} 条只报「新增 N 条 / 待审共 M 条」并提示面板 ⟳ 可看（省 token），不再逐条列清单。两种模式下：待审箱本就有候选且用户没提「先不管」时，可 ≤ ${listMax} 条列编号清单并询问是否审核；用户表示「先不管」则本会话不再提醒；无新发现且待审为空时静默执行，不打断用户任务。`);
  } else {
    lines.push('- 自动采集已由 settings.json 关闭（autoCollect/checkEnabled=false）。');
  }
  lines.push('- 用户说「小本本复盘 / 经验入库 / 待审核箱 / 小本本讨论 <主题> / 小本本忘掉 <编号>」等时，加载技能 `whale-notebook` 并按其中流程执行（先展示候选、经用户确认后才写入 entries 与本自动段）。');
  lines.push('- 经验条目与规则行只写通用对策；来源仅存会话 ID 作统计溯源，不复制原文。');
  return lines;
}

// 生成「begin/end 之间」的完整内容（不含标记行本身）
// v0.4 B1 语义：自动段只收 scope=global 条目（项目级规则对跨项目会话是噪音，不进全局注入；
// 项目级条目在 INDEX 解决墙「项目区」按项目查阅，未来 B2 由各项目根 AGENTS.md 注入）。
function buildSectionBody(entries, settings) {
  const active = entries.filter((e) => e.status === 'active');
  const globals = active.filter((e) => e.scope !== 'project');
  const projects = active.length - globals.length;
  const cap = settings.maxRulesInAgents ?? 12;
  const top = globals.slice().sort((a, b) => (b.occurrences || 0) - (a.occurrences || 0)).slice(0, cap);
  const L = [];
  L.push(SECTION_HEADING);
  L.push('');
  if (!top.length) {
    if (!active.length) {
      L.push('状态：尚无经验规则（待审核箱候选经用户确认后自动生成）。');
    } else {
      L.push(`状态：暂无全局规则（另有 ${projects} 条项目级规则——仅对对应项目适用，不进全局注入；见 INDEX.md「已解决墙」项目区）。`);
    }
  } else {
    L.push(`状态：${top.length} 条全局规则生效中（active 共 ${active.length} 条：全局 ${globals.length}＋项目级 ${projects}；按出现次数取前 ${cap}；项目级不进全局注入，见 INDEX.md「已解决墙」）。`);
    L.push('');
    for (const e of top) L.push(ruleLine(e));
  }
  L.push('');
  L.push(...tailLines(settings));
  L.push('');
  return L.join('\n');
}

// 读现有 AGENTS.md 并在 begin/end 标记间整段替换（不动标记外内容）
// 注意：实际落盘应由 agent 用 edit 工具执行（保证 agent-instructions 观测到变更）。
function applyToText(agentsText, body) {
  const { begin, end } = AGENTS_MARK;
  const i = agentsText.indexOf(begin);
  const j = agentsText.indexOf(end);
  if (i < 0 || j < 0 || j < i) {
    return agentsText.trimEnd() + (agentsText.trim() ? '\n\n' : '') + begin + '\n' + body + end + '\n';
  }
  return agentsText.slice(0, i + begin.length) + '\n' + body + '\n' + agentsText.slice(j);
}

module.exports = { buildSectionBody, tailLines, applyToText, SECTION_HEADING };
