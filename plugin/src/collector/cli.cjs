// collector/cli.cjs - 采集 CLI（供 scripts/mine.cjs 兼容壳与宿主插件复用）
// 用法：node scripts/mine.cjs [--check|--stats|--prewarm] [--full] [--dry]
//   --check    增量扫描并入箱（默认；未更新的会话日志只 stat 跳过）
//   --full     忽略水位线，全量重扫（只读全历史；用于排障/校验）
//   --dry      只报结果不落盘（含不写 state）
//   --stats    全量统计，纯只读（v0.5 起不再写 state —— 旧版会静默吞掉候选）
//   --prewarm  只记指纹与水位线不入箱（会消费这批候选，输出含警告）
'use strict';
const repo = require('../store/repo.cjs');
const { runScan } = require('./engine.cjs');
const { listEntries } = repo;
const agents = require('../inject/agents.cjs');

const MODES = ['--check', '--stats', '--prewarm'];

function run(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const flags = new Set(args);
  if (flags.has('--render-rules')) {
    // 预览：当前 active 条目 → AGENTS.md 自动段正文（agent 入库前先看它保证格式一致）
    const settings = repo.readSettings();
    const entries = listEntries();
    const body = agents.buildSectionBody(entries, settings);
    console.log(body);
    return { ok: true, text: body };
  }
  if (flags.has('--wall')) {
    // v0.4 预览：当前条目 → INDEX.md「已解决墙」正文（dry：只打印，落盘由 agent 展示确认后写）
    const text = repo.buildIndexMd(listEntries());
    console.log(text);
    return { ok: true, text };
  }
  const mode = args.find((a) => MODES.includes(a)) || '--check';
  const out = runScan(mode, { full: flags.has('--full'), dry: flags.has('--dry') });
  if (out.ok) console.log(out.text);
  else console.error(out.text);
  return out;
}

module.exports = { run, MODES };
