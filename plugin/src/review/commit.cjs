// review/commit.cjs - 审核层：候选→条目的"计划式入库"（纯函数，不做文件写）
// 隐私流程：commit 前必须把 plan 展示给用户；实际落盘由 agent 用 read/write/edit 工具执行
// （保证 agent-instructions 观测到 AGENTS.md 变更并即时注入）。
'use strict';
const repo = require('../store/repo.cjs');
const agents = require('../inject/agents.cjs');
const { renderEntryFile, ruleLine } = require('../core/schema.cjs');

// entries: 本次拟入库条目的完整对象（见 schema.renderEntryFile 字段）
// 返回：entryFiles / indexMd / agentsBody / ruleLines（全部为待写内容，未触碰磁盘）
function planCommit({ newEntries }) {
  const existing = repo.listEntries();
  const nextId = repo.nextEntryId(existing);
  const entryFiles = newEntries.map((e, i) => {
    const id = 'E' + String(parseInt(nextId.slice(1), 10) + i).padStart(3, '0');
    const full = { ...e, id };
    return { path: `${repo.P.entries}\\${id}-${String(e.slug || 'entry').replace(/[^\w-]/g, '')}.md`, entry: full, content: renderEntryFile(full) };
  });
  const all = [...existing, ...entryFiles.map((f) => f.entry)];
  const settings = repo.readSettings();
  return {
    entryFiles,
    indexMd: repo.buildIndexMd(all),
    agentsBody: agents.buildSectionBody(all, settings),
    ruleLines: entryFiles.map((f) => ruleLine(f.entry)),
  };
}

// 从 inbox 文本按编号取行（移入 archive 用的原文）
function pickInboxRows(text, ids) {
  const set = new Set(ids);
  return text.split('\n').filter((l) => set.has((l.match(/^\| (C\d+) /) || [])[1]));
}

module.exports = { planCommit, pickInboxRows };
