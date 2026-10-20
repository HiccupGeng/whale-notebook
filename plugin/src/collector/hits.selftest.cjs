// collector/hits.selftest.cjs - v0.8.1 复发统计（命中记录 / 绑定索引 / 有效性判定）
// 运行: node src/collector/hits.selftest.cjs （退出码 0 = 全过）
// 隔离：DSH_WHALE_NB_DIR 指向临时目录，绝不触碰真实 entries/hits。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-hits-'));
process.env.DSH_WHALE_NB_DIR = tmp;
const repo = require('../store/repo.cjs');
const engine = require('./engine.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS ' + name);
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

// ---------- ① 命中记录：追加 / 去重 / 坏行跳过 ----------
repo.appendHits([{ e: 'E009', h: 'hx', at: 1000, n: 2, ws: 'A' }]);
repo.appendHits([{ e: 'E009', h: 'hx', at: 1000, n: 2, ws: 'A' }]); // 崩溃重跑式重复追加
let hits = repo.readHits();
check('hit 往返（字段完整）', hits.length === 1 && hits[0].n === 2 && hits[0].ws === 'A' && hits[0].e === 'E009', hits);
check('同 (条目,hash,时间) 去重', hits.length === 1);
fs.appendFileSync(repo.hitsPath(), '{bad json}\n\n', 'utf8');
check('坏行跳过不影响其它行', repo.readHits().length === 1);

// ---------- ② 绑定索引：只收 active；项目级按白名单；创建前事件不算 ----------
const idx = engine.buildEntryIndex([
  { id: 'E001', status: 'active', scope: 'global', projects: [], created: '2026-01-01', signatures: ['h1', 'h2'] },
  { id: 'E002', status: 'disabled', scope: 'global', projects: [], created: '2026-01-01', signatures: ['h3'] },
  { id: 'E003', status: 'active', scope: 'project', projects: ['A'], created: '2026-01-01', signatures: ['h4'] },
  { id: 'E004', status: 'active', scope: 'global', projects: [], created: '2026-01-01', signatures: [] },
]);
check('只收 active 且跳过空签名', idx.has('h1') && idx.has('h2') && !idx.has('h3') && idx.size === 3, [...idx.keys()]);
check('全局条目任意工作区命中', engine.matchEntry(idx, 'h1', new Set(['Z']), Date.now()) !== null);
check('项目级只认白名单工作区', engine.matchEntry(idx, 'h4', new Set(['B']), Date.now()) === null
  && engine.matchEntry(idx, 'h4', new Set(['A']), Date.now()) !== null);
check('创建前的事件不算命中', engine.matchEntry(idx, 'h1', new Set(['Z']), Date.parse('2025-01-01')) === null);
check('未绑定 hash 不命中', engine.matchEntry(idx, 'nope', new Set(['Z']), Date.now()) === null);

// ---------- ③ 有效性判定（有效 / 未绑定 / 样本不足） ----------
const day = 86400000;
const d = (n) => new Date(Date.now() - n * day).toISOString().slice(0, 10);
const entry = (id, o) => `---\nid: ${id}\ntitle: t\ncategory: error\nstatus: active\nscope: global\nprojects: []\n` +
  `occurrences: ${o.occ || 5}\nfirstSeen: ${d(o.first || 60)}\nlastSeen: ${d(1)}\nworkspaces: [A]\n` +
  `signatures: [${o.sig || ''}]\nrule: r\ncreated: ${d(o.created || 30)}\nupdated: ${d(1)}\nsources: []\n---\n\n## 现象\n\nx\n`;
fs.mkdirSync(repo.P.entries, { recursive: true });
fs.writeFileSync(path.join(repo.P.entries, 'E001-a.md'), entry('E001', { sig: 'h1', created: 30, first: 60 }), 'utf8');
fs.writeFileSync(path.join(repo.P.entries, 'E002-b.md'), entry('E002', { sig: '', created: 30 }), 'utf8');
fs.writeFileSync(path.join(repo.P.entries, 'E003-c.md'), entry('E003', { sig: 'h3', created: 5 }), 'utf8');
const eff = engine.entryEffectiveness();
const by = Object.fromEntries(eff.map((r) => [r.id, r.verdict]));
check('跨度足 + 零命中 → 有效', by.E001 === '有效', by);
check('无 signatures → 未绑定', by.E002 === '未绑定', by);
check('入墙不足 14 天 → 样本不足', by.E003 === '样本不足', by);
check('报表包含基线与跨度', eff.find((r) => r.id === 'E001').base === 5 && eff.find((r) => r.id === 'E001').spanAfter >= 29, eff);

// ---------- ④ 端到端接线：ingestFresh 命中写 hits.jsonl；rebuild 不记 ----------
const settings = Object.assign({}, require('../core/schema.cjs').SETTINGS_DEFAULTS, { autoAdd: true });
const state = repo.readState();
const ev = { cat: 'error', tool: 'bash', text: 'boom failure', ws: 'W1', at: Date.now(), sid: 's1', file: 'f1' };
engine.ingestFresh([ev], state, settings, {});
const hash = Object.keys(state.clusters || {})[0];
check('首次采集建立聚簇', !!hash, Object.keys(state.clusters || {}));
fs.writeFileSync(path.join(repo.P.entries, 'E010-e.md'), entry('E010', { sig: hash, created: 30, first: 60 }), 'utf8');
state.seenFingerprints = []; // 模拟"再次发现同一事件"
engine.ingestFresh([ev], state, settings, { entryIndex: engine.buildEntryIndex(repo.listEntries()) });
let hh = repo.readHits().filter((r) => r.e === 'E010');
check('命中写入 hits.jsonl（含 hash 与次数）', hh.length === 1 && hh[0].h === hash && hh[0].n >= 1, hh);
state.seenFingerprints = [];
engine.ingestFresh([ev], state, settings, { rebuild: true, entryIndex: engine.buildEntryIndex(repo.listEntries()) });
check('rebuild 全量重放不记命中', repo.readHits().filter((r) => r.e === 'E010').length === 1);

console.log(fails ? `\n结果: ${fails} FAIL` : '\nALL PASS');
process.exitCode = fails ? 1 : 0;
