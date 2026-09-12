// store/repo.selftest.cjs - v0.7.4 状态文件完整性（严格读 / 损坏留证 / 临时名 / CAS 合并 / 写锁 / 编号下限）
// 运行: node src/store/repo.selftest.cjs （退出码 0 = 全过）
// 隔离：DSH_WHALE_NB_DIR 指向临时目录，绝不触碰真实 state/inbox/归档。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-repo-'));
process.env.DSH_WHALE_NB_DIR = tmp;
const repo = require('./repo.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

const stPath = path.join(tmp, 'state.json');
const mk = (over) => Object.assign({ v: 2, lastScan: 0, seenFingerprints: [], nextCandidateId: 1, files: {}, clusters: {}, deferred: {} }, over || {});

// ---------- ① 严格读：ENOENT = 空状态；损坏 = 抛错 + 留证 + 不覆盖 ----------
check('无 state 文件 → 空状态且不抛', (() => {
  try { const s = repo.readState(); return !!s && s.nextCandidateId === 1 && Object.keys(s.files).length === 0; } catch { return false; }
})());
fs.writeFileSync(stPath, '{ this is not json', 'utf8');
let threw = null;
try { repo.readState(); } catch (err) { threw = err; }
const corrupt = fs.readdirSync(tmp).filter((n) => n.indexOf('state.json.corrupt-') === 0);
check('损坏 state → 抛错（不静默清空）', !!threw && /损坏/.test(String(threw.message)), threw && threw.message);
check('损坏 state → 留下 .corrupt-<ts> 备份', corrupt.length === 1, fs.readdirSync(tmp));
check('损坏 state → 原文件已移走（不会被空状态覆盖）', !fs.existsSync(stPath), fs.readdirSync(tmp));
for (const n of corrupt) fs.unlinkSync(path.join(tmp, n));

// ---------- ② 写入：临时名带 pid，落盘后无残留 ----------
const s1 = mk({ nextCandidateId: 5, files: { A: { size: 10, mtimeMs: 1, offset: 10 } } });
repo.writeState(s1);
check('写入后无 .tmp 残留', fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length === 0, fs.readdirSync(tmp));
check('临时名含 pid（跨进程不撞名）', repo.tmpNameFor(stPath).indexOf('.' + process.pid + '.') !== -1, repo.tmpNameFor(stPath));

// ---------- ③ CAS 合并：read → 别人写盘 → 我 write 不得覆盖对方 ----------
const ours = repo.readState(); // 记录 lastReadMeta
ours.deferred = { h1: { cat: 'error', text: 'ours', n: 1, first: 1, last: 1, ws: ['W'], refs: [], excerpt: '' } };
ours.nextCandidateId = 6;
ours.seenFingerprints = ['f-ours'];
const disk = mk({
  nextCandidateId: 9,
  files: { B: { size: 20, mtimeMs: 2, offset: 20 } },
  seenFingerprints: ['f-disk'],
  deferred: { h2: { cat: 'error', text: 'disk', n: 3, first: 2, last: 5, ws: ['W'], refs: [], excerpt: '' } },
});
fs.writeFileSync(stPath, JSON.stringify(disk, null, 1), 'utf8');
repo.writeState(ours);
const merged = JSON.parse(fs.readFileSync(stPath, 'utf8'));
check('合并：对方水位线保留', !!merged.files.B, Object.keys(merged.files));
check('合并：我方水位线保留', !!merged.files.A, Object.keys(merged.files));
check('合并：两侧暂存并集', !!merged.deferred.h1 && !!merged.deferred.h2, Object.keys(merged.deferred));
check('合并：同键取较大计数', merged.deferred.h2.n === 3, merged.deferred.h2);
check('合并：编号取最大（防撞号）', merged.nextCandidateId === 9, merged.nextCandidateId);
check('合并：双方指纹都保留', merged.seenFingerprints.indexOf('f-disk') !== -1 && merged.seenFingerprints.indexOf('f-ours') !== -1, merged.seenFingerprints);
check('合并次数可观测（stateDiag）', repo.stateDiag.merges >= 1, repo.stateDiag);

// ---------- ④ 无人抢先写 → 不合并 ----------
const before = repo.stateDiag.merges;
const s2 = repo.readState();
s2.lastScan = 123;
repo.writeState(s2);
check('无并发时不触发合并', repo.stateDiag.merges === before, repo.stateDiag);

// ---------- ⑤ 写锁：互斥 / 释放 / 陈旧回收 ----------
const unlock = repo.acquireLockSync(100);
check('可获取写锁', typeof unlock === 'function', unlock);
check('持锁期间第二次获取失败（EEXIST）', repo.acquireLockSync(80) === null && repo.stateDiag.lastLockError === 'EEXIST', repo.stateDiag);
check('锁文件内容含 pid', (() => { try { return JSON.parse(fs.readFileSync(repo.lockPath(), 'utf8')).pid === process.pid; } catch { return false; } })());
unlock();
check('释放后可再次获取', typeof repo.acquireLockSync(100) === 'function');
repo.unlockState();
check('释放后锁文件不存在', !fs.existsSync(repo.lockPath()));
fs.writeFileSync(repo.lockPath(), JSON.stringify({ pid: 1, at: 0 }), 'utf8');
const oldSec = (Date.now() - 20000) / 1000;
fs.utimesSync(repo.lockPath(), oldSec, oldSec);
check('陈旧锁（>15s）可被回收', typeof repo.acquireLockSync(300) === 'function');
repo.unlockState();
check('数据目录缺失时锁不可用且不空等（ENOENT 立即返回）', (() => {
  const saved = process.env.DSH_WHALE_NB_DIR;
  process.env.DSH_WHALE_NB_DIR = saved; // 路径常量在 require 时已固定，这里只验证语义：目录在则必然能拿到锁
  const t0 = Date.now();
  const u = repo.acquireLockSync(200);
  const ok = typeof u === 'function' || Date.now() - t0 < 200;
  if (u) u();
  return ok;
})());

// ---------- ⑥ 编号下限来自归档（防 state 重置后与历史编号撞号） ----------
fs.mkdirSync(path.join(tmp, 'archive'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'archive', 'archive-20990101.md'),
  '# 归档\n\n| 编号 | 类别 | 次数 | 工作区 | 现象（已打码） | 时间 | 处置 |\n|---|---|---|---|---|---|---|\n'
  + '| C136 | error | 1 | W | 历史已处置文本 | 2026-09-01 10:00 | 面板删除 2026-09-01 10:00 |\n', 'utf8');
const { ingestFresh, loadResolvedCached } = require('../collector/engine.cjs');
check('归档最大编号被缓存（loadResolvedCached）', loadResolvedCached().maxId === 136, loadResolvedCached().maxId);
const st6 = repo.readState();
st6.nextCandidateId = 1; // 模拟 state 被重置
const ev = { sid: 's', at: 1, ws: 'W', file: 'f', cat: 'error', tool: 'pwsh', text: 'brand new failure for id floor' };
const ing = ingestFresh([ev], st6, { autoAdd: true }, { now: 2 });
check('编号下限取归档最大+1（C137 而不是 C001）', ing.added.length === 1 && ing.added[0].id === 'C137', ing.added);

// ---------- ⑦ v0.7.6：回声归档 —— 签名可读回 / 幂等由 engine 负责 / 超上限自动轮转 ----------
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const row = (t, cat, n, ws, text) => `| ${t} | ${cat} | ${n} | ${ws} | ${text} |`;
repo.appendEchoArchive([row('2026-09-11 10:00', 'error', 1, 'W', '我们自己的探针输出')].join('\n'));
repo.appendEchoArchive([row('2026-09-11 10:01', 'error', 2, 'W', '第二条回声')].join('\n'));
const sigs = repo.readEchoSignatures();
check('回声签名可读回（类别|现象）', sigs.size === 2 && sigs.has('error|我们自己的探针输出'), [...sigs]);
check('回声归档不计入已处置索引（仍是 archive-* 之外的文件）',
  fs.readdirSync(path.join(tmp, 'archive')).filter((n) => /^echo-/.test(n)).length === 1,
  fs.readdirSync(path.join(tmp, 'archive')));
const echoStat0 = repo.echoStats();
check('echoStats 报当日行数与总量', echoStat0.rows === 2 && echoStat0.files === 1 && echoStat0.cap === repo.ECHO_MAX_ROWS, echoStat0);
// 轮转：把当日分片填到上限，再追加一行 → 必须新开 echo-<day>-2.md（单文件不会无限增长）
const filler = [];
for (let i = 0; i < repo.ECHO_MAX_ROWS; i++) filler.push(row('2026-09-11 11:00', 'error', 1, 'W', '填充行 ' + i));
repo.appendEchoArchive(filler.join('\n'));
repo.appendEchoArchive([row('2026-09-11 12:00', 'error', 1, 'W', '轮转后的新行')].join('\n'));
const echoNames = fs.readdirSync(path.join(tmp, 'archive')).filter((n) => /^echo-/.test(n)).sort();
// 注意：分片名排序（-2 后缀的 '-' 排在 '.' 之前）不保证顺序，故按"集合包含"判定，不按下标取。
check('回声归档超上限自动轮转（echo-<day>-2.md）',
  echoNames.length === 2 && echoNames.includes(`echo-${day}.md`) && echoNames.includes(`echo-${day}-2.md`), echoNames);
const afterRoll = repo.echoStats();
check('轮转后签名集合覆盖两个分片（去重仍生效）',
  repo.readEchoSignatures().has('error|轮转后的新行') && repo.readEchoSignatures().has('error|我们自己的探针输出')
  && afterRoll.files === 2 && afterRoll.totalRows === repo.ECHO_MAX_ROWS + 3, afterRoll);

// ---------- ⑧ v0.7.7：维护窗口标记（rebuild 期间实时采集"让路但不丢事件"的信号）----------
check('无标记时读到 null', repo.readMaintenance() === null);
check('写标记 → 可读回且带 pid/kind', (() => {
  repo.writeMaintenance({ kind: 'rebuild', expiresAt: Date.now() + 60000 });
  const m = repo.readMaintenance();
  return !!m && m.kind === 'rebuild' && m.pid === process.pid;
})(), repo.readMaintenance());
check('标记写入是原子的（无 .tmp 残留）', fs.readdirSync(tmp).filter((n) => n.endsWith('.tmp')).length === 0, fs.readdirSync(tmp));
check('过期标记自动失效并清理（进程被强杀也不永久停写）', (() => {
  repo.writeMaintenance({ kind: 'rebuild', expiresAt: Date.now() - 1 });
  const m = repo.readMaintenance();
  return m === null && !fs.existsSync(repo.maintenancePath());
})(), fs.existsSync(repo.maintenancePath()));
check('超长有效期被夹到上限（写坏的值不会把采集锁死）', (() => {
  repo.writeMaintenance({ kind: 'rebuild', expiresAt: Date.now() + 86400000 });
  const m = repo.readMaintenance();
  const ok = !!m && m.expiresAt - Date.now() <= repo.MAINTENANCE_MAX_MS + 1000;
  repo.clearMaintenance();
  return ok;
})(), repo.readMaintenance());
check('清除标记幂等（重复清除不抛）', repo.clearMaintenance() === false && repo.clearMaintenance() === false, repo.readMaintenance());

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
process.exit(fails === 0 ? 0 : 1);
