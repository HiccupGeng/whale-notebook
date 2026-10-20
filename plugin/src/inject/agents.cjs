// inject/agents.cjs - 生效层 L1：AGENTS.md 自动段生成器（唯一规范来源）
// skill 与未来插件都调用这里，保证 AGENTS 自动段行文/标记永不漂移。
'use strict';
const repo = require('../store/repo.cjs');
const { AGENTS_MARK, ruleLine } = require('../core/schema.cjs');

// 自动段头部（紧跟 begin 标记之后）
const SECTION_HEADING = '## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）';

// 固定尾注（紧跟规则行之后，end 标记之前）
// v0.8.0 瘦身：尾注 3 行 ~705 字 → 2 行 ~180 字；规则行一字不动。
//   删掉的只有"为什么"和两种模式的细节（autoAdd 双模式自述、--add 语法、"先不管"、静默执行），
//   这些都在技能 whale-notebook 里（用户说「复盘/墙/忘掉」时才加载）。注入文本只保留行为契约：
//   ① 待审 ≤listMax 才列清单（防长篇）；② 写入前先把文本给用户确认。
//   另：不再要求"每个新会话都跑 --check"——改为"需要时跑"，实时采集仍兜底。
//   收益：约 −350 tokens/会话（尾注）+ 省掉每会话一次工具往返（≈100–150 tokens）。
function tailLines(settings) {
  const checkEnabled = settings.autoCollect !== false && settings.checkEnabled !== false;
  const listMax = Number.isFinite(settings.reminderListMax) ? settings.reminderListMax : 3;
  const lines = [];
  lines.push(checkEnabled
    ? `- 采集：需要时跑 \`~/.dsh/whale-notebook/scripts/mine.cjs --check\`（入箱/暂存以输出为准，细节见技能）；待审 ≤${listMax} 条才列编号清单，否则只报数字并提示面板 ⟳；用户说「小本本复盘 / 墙 / 忘掉 <编号>」时加载技能 \`whale-notebook\`。`
    : '- 采集：已在 settings.json 关闭（autoCollect/checkEnabled=false）；用户说「小本本复盘 / 墙 / 忘掉 <编号>」时加载技能 `whale-notebook`。');
  lines.push('- 写入：条目与规则只写通用对策，来源只存会话 ID；把文本给用户确认后再落盘。');
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
    // v0.8.0 瘦身：状态行 85 字 → ~44 字；刻意保留「项目级 N」「不进全局注入」两个关键词，
    //   因为 ui/server.selftest 的断言按这两个子串判定，改文案不必连带改断言。
    L.push(`状态：全局规则 ${top.length}/${cap} 生效｜active ${active.length}（项目级 ${projects} 不进全局注入，见 INDEX.md「已解决墙」）`);
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
