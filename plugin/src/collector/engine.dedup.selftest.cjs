// collector/engine.dedup.selftest.cjs - v0.6.2 已处置签名去重（防「重置后重扫」重复开行）
// 运行: node src/collector/engine.dedup.selftest.cjs （退出码 0 = 全过）
// 隔离：先把 DSH_WHALE_NB_DIR 指向临时目录再 require，保证不触碰真实待审箱/状态。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-dedup-'));
process.env.DSH_WHALE_NB_DIR = tmp;
for (const d of ['archive', 'archive/details', 'details', 'entries']) fs.mkdirSync(path.join(tmp, d), { recursive: true });
const repo = require('../store/repo.cjs');
const { INBOX_HEADER, inboxRow } = require('../core/schema.cjs');
const { ingestFresh, resolvedSig, loadResolvedIndex, pruneResolvedIndex, SIG_TEXT_MAX } = require('./engine.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const LONG = 'X'.repeat(300);
const ev = (text, cat, at) => ({ sid: 'sess-a', at, ws: 'W', file: 'f', cat, tool: 'pwsh', text });
const T0 = Date.parse('2026-09-01T10:00:00+08:00');
const EV = ev('[sandbox: file access denied under workspace-write mode]' + LONG, 'error', T0);
// 注意：聚簇里存的是【打码后】文本，索引里 fixture 也必须用同一份文本（与真实归档行同源）。
const SIG = resolvedSig('error', '[sandbox: file access denied under workspace-write mode][REDACTED]');
const freshState = () => ({ v: 2, files: {}, clusters: {}, seenFingerprints: [], deferred: {}, nextCandidateId: 1, lastScan: 0 });

// ---------- ① 纯函数 ----------
check('签名稳定（空白归一 + 90 截断）', resolvedSig('error', '  a \n b  ') === resolvedSig('error', 'a b'), resolvedSig('error', '  a \n b  '));
check('签名按 90 单元截断', resolvedSig('error', 'x'.repeat(200)).length === 'error|'.length + SIG_TEXT_MAX);
check('类别参与签名', resolvedSig('error', 'abc') !== resolvedSig('timeout', 'abc'));
check('空文本无签名', resolvedSig('error', '   ') === '');

// ---------- ② 归档索引 ----------
const hdr = '| 编号 | 类别 | 次数 | 工作区 | 现象（已打码） | 时间 | 处置 |\n|---|---|---|---|---|---|---|\n';
// 真实归档行两种形态都要能解析：
//   ① 新行：时间列 + 处置列（文本必须不含时间，否则与引擎聚簇文本对不上）
//   ② 旧行：行内残留半角 `|`（历史批量清理留下的形态）
fs.writeFileSync(path.join(tmp, 'archive', 'archive-20260910.md'),
  '# 归档\n\n' + hdr +
  `| C900 | error | 1 | W | ${SIG.split('|')[1]} | 2026-09-01 10:00 | 同批合并→已解决 2026-09-10（测试） |\n` +
  `| C901 | error | 1 | W | pipe-in-text [ahead 1] | 2026-09-01 10:00 | 同批合并→已解决 2026-09-10（旧行形态） |\n` +
  `| C902 | error | 1 | W | ${SIG.split('|')[1]} | 同批合并→已解决 2026-09-10（时间列缺失兜底） |\n` +
  `| C903 | error | 1 | W | 这一行没有处置列 |\n`, 'utf8');
fs.writeFileSync(path.join(tmp, 'archive', 'echo-20260910.md'), '| 时间 | 类别 | 次数 | 工作区 | 现象 |\n|---|---|---|---|---|\n| 2026-09-01 10:00 | error | 1 | W | x |\n', 'utf8');
const idx = loadResolvedIndex();
check('归档已处置行进索引且文本不含时间', idx.has(SIG) && ![...idx].some((s) => /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)), [...idx]);
check('含半角 | 的真实旧行也能取到处置列', idx.has(resolvedSig('error', 'pipe-in-text [ahead 1]')), [...idx]);
check('空处置列被忽略', ![...idx].some((s) => s.indexOf('这一行没有处置列') !== -1));
check('echo 落档不计入已处置', idx.size === 2, idx.size);

// ---------- ③ 剔除在箱聚簇（保留复发语义） ----------
const stPrune = freshState();
stPrune.clusters['h1'] = { cid: 'C900', cat: 'error', text: SIG.split('|')[1], n: 1 };
const idx2 = loadResolvedIndex();
check('已开行的聚簇被剔除', pruneResolvedIndex(stPrune, idx2) === 1 && !idx2.has(SIG));

// ---------- ④ 端到端：重置后重扫不再重复开行 ----------
const st1 = freshState();
const r1 = ingestFresh([EV], st1, {}, { now: T0 + 1000 });
check('首扫开行 1 条', r1.added.length === 1 && r1.suppressed.length === 0, r1.added);
const inboxAfterFirst = repo.readInboxText();
check('首扫已写 inbox 行', inboxAfterFirst.indexOf('| C001 |') !== -1, inboxAfterFirst.trim().slice(-80));
// 模拟用户处置：行移出待审箱 → 进归档
repo.writeInboxText(INBOX_HEADER + '\n');
fs.appendFileSync(path.join(tmp, 'archive', 'archive-20260910.md'),
  `| C001 | error | 1 | W | ${SIG.split('|')[1]} | 2026-09-01 10:00 | 同批合并→已解决 2026-09-10（测试2） |\n`, 'utf8');

// 模拟 state 重置（水位线/指纹/聚簇全清）→ 同一段日志重扫
const st2 = freshState();
const idx3 = loadResolvedIndex();
const r2 = ingestFresh([EV], st2, {}, { now: T0 + 2000, resolved: idx3 });
check('重置后重扫：不开新行', r2.added.length === 0, r2.added);
check('重置后重扫：计入 suppressed', r2.suppressed.length === 1 && r2.suppressed[0].cat === 'error', r2.suppressed);
check('重置后重扫：inbox 无新增', repo.readInboxText().indexOf('| C00') === -1, repo.readInboxText().trim().slice(-80));
check('重置后重扫：聚簇已登记（记 cid=null + 计数）', (() => { const h = Object.keys(st2.clusters)[0]; const c = st2.clusters[h]; return !!c && c.cid === null && c.silentN === 1; })(), st2.clusters);

// 未处置签名（不在索引）仍应正常开行
const st3 = freshState();
const other = ev('some brand new failure text', 'error', T0 + 3000);
const r3 = ingestFresh([other], st3, {}, { now: T0 + 3000, resolved: new Set() });
check('未处置签名照常开行', r3.added.length === 1 && r3.suppressed.length === 0, r3.added);

// ---------- ⑤ 暂存冲箱路径（--add）同样压掉已处置签名 ----------
const { flushDeferred } = require('./engine.cjs');
const st4 = freshState();
st4.deferred = { h9: { cat: 'error', text: SIG.split('|')[1], n: 1, first: T0, last: T0, ws: ['W'], refs: [], excerpt: '' } };
const f1 = flushDeferred(st4, {}, { now: T0 + 4000, resolved: loadResolvedIndex() });
check('--add：已处置签名的暂存组不入箱', f1.added.length === 0 && f1.suppressed.length === 1, f1);
check('--add：暂存被消费且聚簇登记为已处置', Object.keys(st4.deferred).length === 0 && st4.clusters.h9.cid === null, st4);
const st5 = freshState();
st5.deferred = { h10: { cat: 'error', text: 'unseen deferred text', n: 1, first: T0, last: T0, ws: ['W'], refs: [], excerpt: '' } };
const f2 = flushDeferred(st5, {}, { now: T0 + 4000, resolved: loadResolvedIndex() });
check('--add：未处置签名照常入箱', f2.added.length === 1 && f2.suppressed.length === 0, f2);

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
process.exit(fails === 0 ? 0 : 1);
