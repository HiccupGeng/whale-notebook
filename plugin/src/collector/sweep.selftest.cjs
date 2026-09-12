// collector/sweep.selftest.cjs - v0.7.8 面板「历史深掘」（POST /whale/sweep）等价链路端到端自测
// 被测语义（宿主端点就是这么调的）：
//   阶段① runScanAsync('--add')            先把暂存冲进待审箱（防重建清空丢件）
//   阶段② runScanAsync('--rebuild', {add}) 清空水位线/指纹/聚簇后从头梳理全部历史 → 直接入箱
// 断言：dry 零写盘 · 两阶段不丢件不重复 · 二次深掘幂等 · 已处置不复活 · maxNewRows 生效 · 无残留
// 独立临时 DSH_HOME（repo 路径常量在 require 时固定，故必须先设再 require）。
// 运行: node src/collector/sweep.selftest.cjs （退出码 0 = 全过）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-sweep-test-'));
process.env.DSH_HOME = tmp;
const nb = path.join(tmp, 'whale-notebook');
fs.mkdirSync(nb, { recursive: true });

const T0 = Date.parse('2026-09-12T09:00:00+08:00');
function rec(type, data, t) { return JSON.stringify({ type, time: t, data }); }
function callRec(cid, name, t) { return rec('tool/call', { callId: cid, name }, t); }
function resultRec(cid, text, isError, t) {
  return rec('tool/result', { message: { source: { callId: cid }, content: [{ type: 'tool-result', isError: !!isError, content: [{ type: 'text', text }] }] } }, t);
}
function frame(text) { return zlib.zstdCompressSync(Buffer.from(text, 'utf8')); }

// 10 条**结构上互不相同**的历史失败（分散在 2 个工作区 / 2 个会话日志里）+ 1 条重复（同坑累加，不新开行）
// 注意：夹具刻意不用「同一句话只改数字」——那种情况在引擎里是**同一族**，会被合并成一行（v0.7 语义），
//   于是"10 个坑"会变成"1 个坑"，断言就失去意义。
const N = 10;
const WS = { A: 'SandBox1', B: 'WhaleGlobal' };
const FAILURES = [
  { tool: 'pwsh', text: "EPERM: operation not permitted, mkdir 'C:\\sandbox\\out'" },
  { tool: 'pwsh', text: 'timeout: connect to 127.0.0.1:1234 failed' },
  { tool: 'pwsh', text: "fatal: Authentication failed for 'https://example.invalid/repo.git'" },
  { tool: 'pwsh', text: 'EADDRINUSE: address already in use :::3080' },
  { tool: 'pwsh', text: 'ENOSPC: no space left on device, write' },
  { tool: 'Bash', text: "ENOENT: no such file or directory, open 'C:\\x\\missing.md'" },
  { tool: 'Bash', text: 'zstd decompress failed: unknown frame descriptor' },
  { tool: 'Bash', text: 'stderr 全是树内子项的 找不到指定的文件 (os error 2)，判定为悬空链接' },
  { tool: 'pwsh', text: 'HTTP 429 Too Many Requests from upstream model api endpoint' },
  { tool: 'Bash', text: 'Error: spawn EPERM (pipe) rejected by sandbox policy' },
];
const dirs = {};
for (const [k, name] of Object.entries(WS)) {
  dirs[k] = path.join(tmp, 'sessions', name, 'sess-' + k.toLowerCase());
  fs.mkdirSync(dirs[k], { recursive: true });
}
const LOGS = {};
for (let i = 0; i < N; i++) {
  const k = i % 2 === 0 ? 'A' : 'B';
  const p = path.join(dirs[k], 'session.jsonl.zstd');
  if (!LOGS[k]) { LOGS[k] = p; fs.writeFileSync(p, ''); }
  const f = FAILURES[i];
  fs.appendFileSync(p, frame([callRec('s' + i, f.tool, T0 + i * 1000), resultRec('s' + i, f.text, true, T0 + i * 1000 + 1)].join('\n') + '\n'));
}
// 重复一次 #0（同一现象再次出现 → 只累加次数）
fs.appendFileSync(LOGS.A, frame([callRec('sdup', 'pwsh', T0 + 900e3), resultRec('sdup', FAILURES[0].text, true, T0 + 900e3 + 1)].join('\n') + '\n'));
// 后段（⑦ maxNewRows）再追加 5 条全新的坑：用来演示"上限太小会丢件、放大上限能补回"
const NEW_FAILURES = [
  { tool: 'pwsh', text: 'Error: EACCES: permission denied, unlink C:\\locked\\file.tmp' },
  { tool: 'Bash', text: 'fatal: unable to access repository: Could not resolve host: github.invalid' },
  { tool: 'pwsh', text: 'CommandNotFoundException: 无法将 term 识别为 cmdlet 的名称' },
  { tool: 'Bash', text: 'zstd: decompression error: Data corruption detected in frame' },
  { tool: 'pwsh', text: 'EPIPE: broken pipe, write after peer closed the connection' },
];
function appendNewFailures() {
  for (let j = 0; j < NEW_FAILURES.length; j++) {
    const k = j % 2 === 0 ? 'B' : 'A';
    const f = NEW_FAILURES[j];
    const t = T0 + 1000e3 + j * 1000;
    fs.appendFileSync(LOGS[k], frame([callRec('n' + j, f.tool, t), resultRec('n' + j, f.text, true, t + 1)].join('\n') + '\n'));
  }
}

// 拉取式（autoAdd=false）：--check 只暂存 → 正是"需要保底冲入"的场景
fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, autoAdd: false, maxDeferred: 200 }), 'utf8');

const repo = require('../store/repo.cjs');
const { runScan, runScanAsync } = require('./engine.cjs');
const server = require('../ui/server.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const snap = (files) => files.map((f) => (fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : '<none>'));
const pendingRows = () => repo.parseInboxRows(repo.readInboxText());
const dupPairs = () => {
  const seen = new Set(); const dups = [];
  for (const r of pendingRows()) { const k = r.cat + '|' + r.text; if (seen.has(k)) dups.push(k); seen.add(k); }
  return dups;
};
const SWEEP = { add: true, maxNewRows: 500 };   // 宿主端点给深掘的参数（lib/index.js）

(async () => {
  try {
    // ---------- ① 拉取式侦察：--check 只暂存，箱子不动 ----------
    const sc = runScan('--check');
    check('深掘前置：拉取式下 --check 只暂存（暂存 ≥10 组、箱子为空）',
      sc.ok === true && sc.data.deferredOn === true && sc.data.added.length === 0
      && sc.data.deferredTotal >= N && repo.pendingCount(repo.readInboxText()) === 0,
      { deferred: sc.data.deferredTotal, added: sc.data.added.length });

    // ---------- ② dry 预演：零写盘、不开维护窗口 ----------
    const watch = [repo.P.state, repo.P.inbox, path.join(nb, 'settings.json')];
    const before = snap(watch);
    const detailsBefore = fs.existsSync(repo.P.details) ? fs.readdirSync(repo.P.details).sort().join(',') : '';
    const dry = await runScanAsync('--rebuild', { add: true, dry: true, maxNewRows: 500 });
    check('dry 预演：算出与真实重建同量的结果（added ≥ 8）', dry.ok === true && dry.data.dry === true && dry.data.added.length >= N, dry.ok ? { added: dry.data.added.length } : dry);
    check('dry 预演：state/inbox/settings 逐字节未变 + 不写 sidecar',
      JSON.stringify(before) === JSON.stringify(snap(watch))
      && (fs.existsSync(repo.P.details) ? fs.readdirSync(repo.P.details).sort().join(',') : '') === detailsBefore,
      { stateChanged: before[0] !== snap(watch)[0] });
    check('dry 预演：不开维护窗口（不是"假装只读"）', repo.readMaintenance() === null && !fs.existsSync(repo.maintenancePath()), repo.readMaintenance());
    check('dry 预演：不残留写锁', !fs.existsSync(repo.lockPath()));

    // ---------- ③ 阶段① --add：把已有暂存冲进待审箱（保底不丢件）----------
    const flush = await runScanAsync('--add', { maxNewRows: 500 });
    const afterFlushRows = pendingRows().length;
    check('阶段① --add：暂存全部入箱（新开+同族并入 ≥10）、暂存清空',
      flush.ok === true && flush.data.added.length + flush.data.bumped.length >= N && flush.data.remaining === 0 && afterFlushRows >= 8,
      flush.ok ? { added: flush.data.added.length, bumped: flush.data.bumped.length, remaining: flush.data.remaining, rows: afterFlushRows } : flush);
    check('阶段① --add：候选行都带 sidecar', pendingRows().every((r) => fs.existsSync(path.join(repo.P.details, r.id + '.md'))), pendingRows().map((r) => r.id));

    // ---------- ④ 阶段② --rebuild --add：全量重扫 → 认领既有行（不重复开行）----------
    const sweep1 = await runScanAsync('--rebuild', { add: true, maxNewRows: 500 });
    const rowsAfterSweep1 = pendingRows().length;
    check('阶段② --rebuild --add：重建标记 + 全部被认领（added=0、bumped ≥ 8、dropped=0）',
      sweep1.ok === true && sweep1.data.rebuild === true && sweep1.data.added.length === 0
      && sweep1.data.bumped.length >= N && sweep1.data.dropped === 0,
      sweep1.ok ? { added: sweep1.data.added.length, bumped: sweep1.data.bumped.length, dropped: sweep1.data.dropped } : sweep1);
    check('阶段②：箱子行数未被重建改变（同现象认领而非新开行）', rowsAfterSweep1 === afterFlushRows, { before: afterFlushRows, after: rowsAfterSweep1 });
    check('阶段②：无重复现象行（cat|text 唯一）', dupPairs().length === 0, dupPairs());
    check('阶段②：水位线重建到位', Object.keys(repo.readState().files).length >= 2
      && Object.values(repo.readState().files).every((w) => w.offset > 0), repo.readState().files);

    // ---------- ⑤ 幂等：再深掘一次不产生新行、不产生重复 ----------
    const sweep2 = await runScanAsync('--rebuild', { add: true, maxNewRows: 500 });
    check('深掘幂等：第二次 added=0 且箱子行数不变',
      sweep2.ok === true && sweep2.data.added.length === 0 && pendingRows().length === rowsAfterSweep1,
      sweep2.ok ? { added: sweep2.data.added.length, rows: pendingRows().length } : sweep2);
    check('深掘幂等：无重复现象行', dupPairs().length === 0, dupPairs());

    // ---------- ⑥ 已处置不复活：删掉一条（入归档）后重建，不得重新开行 ----------
    const victim = pendingRows()[0].id;
    const victimCat = pendingRows()[0].cat;
    const del = server.deleteCandidate({ id: victim });
    const rowsAfterDel = pendingRows().length;
    const sweep3 = await runScanAsync('--rebuild', { add: true, maxNewRows: 500 });
    check('已处置保护：删掉的候选被归档签名压掉（suppressed ≥ 1、不重新开行）',
      del.ok === true && sweep3.ok === true && sweep3.data.suppressed.length >= 1 && sweep3.data.added.length === 0,
      sweep3.ok ? { suppressed: sweep3.data.suppressed.length, added: sweep3.data.added.length } : sweep3);
    check('已处置保护：箱子行数只少了那一条，且该现象没有回来',
      pendingRows().length === rowsAfterDel && !pendingRows().some((r) => r.id === victim)
      && !pendingRows().some((r) => r.cat === victimCat && r.id === victim),
      { rows: pendingRows().length, victim });

    // ---------- ⑦ maxNewRows：默认上限会丢件、深掘上限不会（这是把 30 提到 500 的理由）----------
    // 先追加 5 条全新的坑（否则"全部已在箱"时没什么可开行，测不出上限）
    appendNewFailures();
    const capped = await runScanAsync('--rebuild', { add: true, maxNewRows: 2 });
    check('上限=2：只开 2 行、其余 3 条记 dropped（同时已记指纹 → 不重扫就再也抓不到）',
      capped.ok === true && capped.data.added.length === 2 && capped.data.dropped === NEW_FAILURES.length - 2,
      capped.ok ? { added: capped.data.added.length, dropped: capped.data.dropped } : capped);
    const uncapped = await runScanAsync('--rebuild', { add: true, maxNewRows: 500 });
    check('深掘上限（500）：上一轮被丢的坑全部补回（dropped=0、新开 3 条）',
      uncapped.ok === true && uncapped.data.dropped === 0 && uncapped.data.added.length === NEW_FAILURES.length - 2,
      uncapped.ok ? { added: uncapped.data.added.length, dropped: uncapped.data.dropped } : uncapped);
    check('补回过程也不产生重复现象行', dupPairs().length === 0, dupPairs());

    // ---------- ⑧ 收尾：无锁、无维护窗口、无临时文件 ----------
    const leftovers = fs.readdirSync(nb).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    check('深掘收尾：不残留写锁 / 维护窗口 / .tmp',
      !fs.existsSync(repo.lockPath()) && !fs.existsSync(repo.maintenancePath()) && repo.readMaintenance() === null && leftovers.length === 0,
      { leftovers, mk: repo.readMaintenance() });
    check('深掘收尾：settings.json 未被深掘改写（autoAdd 仍为 false）',
      JSON.parse(fs.readFileSync(path.join(nb, 'settings.json'), 'utf8')).autoAdd === false);
  } catch (err) {
    fails++;
    console.error('FAIL v0.7.8 深掘块异常 :: ' + (err && err.stack ? err.stack : err));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
  }
  console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})();
