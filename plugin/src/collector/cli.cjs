// collector/cli.cjs - 采集 CLI（供 scripts/mine.cjs 兼容壳与未来插件复用）
'use strict';
const repo = require('../store/repo.cjs');
const { runScan } = require('./engine.cjs');
const { listEntries } = repo;
const agents = require('../inject/agents.cjs');

function run(argv) {
  const mode = argv[0] || '--check'; // 调用方传 process.argv.slice(2), 故 mode 在 argv[0]
  if (mode === '--render-rules') {
    // 预览：当前 active 条目 → AGENTS.md 自动段正文（agent 入库前先看它保证格式一致）
    const settings = repo.readSettings();
    const entries = listEntries();
    const body = agents.buildSectionBody(entries, settings);
    console.log(body);
    return { ok: true, text: body };
  }
  if (mode === '--wall') {
    // v0.4 预览：当前条目 → INDEX.md「已解决墙」正文（dry：只打印，落盘由 agent 展示确认后写）
    const text = repo.buildIndexMd(listEntries());
    console.log(text);
    return { ok: true, text };
  }
  const out = runScan(mode);
  if (out.ok) console.log(out.text);
  else console.error(out.text);
  return out;
}

module.exports = { run };
