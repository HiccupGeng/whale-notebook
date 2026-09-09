// inject/agents.cjs - 生效层 L1：AGENTS.md 自动段生成器（唯一规范来源）
// skill 与未来插件都调用这里，保证 AGENTS 自动段行文/标记永不漂移。
'use strict';
const repo = require('../store/repo.cjs');
const { AGENTS_MARK, ruleLine } = require('../core/schema.cjs');

// 自动段头部（紧跟 begin 标记之后）
const SECTION_HEADING = '## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）';

// 固定尾注（紧跟规则行之后，end 标记之前）
function tailLines(settings) {
  const checkEnabled = settings.autoCollect !== false && settings.checkEnabled !== false;
  const lines = [];
  if (checkEnabled) {
    lines.push('- **自动采集提醒**：每个新会话开始后，若 `~/.dsh/whale-notebook/scripts/mine.cjs --check` 输出有新发现，向用户展示待审核箱 `inbox.md` 的小型编号列表（每条一行：编号|类别|次数|工作区|现象简述）并询问是否审核；用户表示「先不管」则本会话不再提醒。无待审时静默执行，不打断用户任务。');
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
