// collector/engine.selftest.cjs - buildDetailMd 单测 + v0.7.5 解码失败分类/扫描健康度
// 运行: node src/collector/engine.selftest.cjs （退出码 0 = 全过）
// 隔离：先把 DSH_HOME 指向临时目录再 require（repo 的路径常量在 require 时固定）。
'use strict';
const fsx = require('fs');
const osx = require('os');
const pathx = require('path');
const zlibx = require('node:zlib');
const tmpHome = fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'whale-eng-'));
process.env.DSH_HOME = tmpHome;
const { buildDetailMd } = require('./engine.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

const T0 = new Date('2026-09-01T10:00:00+08:00').getTime();
const LONG_TEXT = '这是一条超长工具失败原文（打码后）。'.repeat(40); // >600 字
const r = {
  cat: 'sandbox-ep', n: 3,
  wsSet: new Set(['SandBox1']),
  first: T0,
  last: T0 + 3600e3,
  text: '受限沙箱下测试/构建子进程 EPERM 起不来，需宽松策略下运行',
  evs: [
    { sid: 'sess-a', at: T0, ws: 'SandBox1', file: 'C:\\x\\sessions\\SandBox1\\sess-a\\session.jsonl.zstd', text: '第一次 EPERM' },
    { sid: 'sess-b', at: T0 + 600e3, ws: 'SandBox1', file: 'C:\\x\\sessions\\SandBox1\\sess-b\\session.jsonl.zstd', text: '短错误' },
    { sid: 'sess-a', at: T0 + 1200e3, ws: 'SandBox1', file: 'C:\\x\\sessions\\SandBox1\\sess-a\\session.jsonl.zstd', text: '再次 EPERM（同会话重复）' },
    { sid: 'sess-c', at: T0 + 1800e3, ws: 'SandBox1', file: 'C:\\x\\sessions\\SandBox1\\sess-c\\session.jsonl.zstd', text: '第三次' },
    { sid: 'sess-d', at: T0 + 2400e3, ws: 'SandBox1', file: 'C:\\x\\sessions\\SandBox1\\sess-d\\session.jsonl.zstd', text: LONG_TEXT },
  ],
};

const md = buildDetailMd(8, r);
check('md 标题', md.indexOf('# C008 候选详情') === 0, md.slice(0, 40));
check('一句话与元信息', md.indexOf('受限沙箱下测试') !== -1 && md.indexOf('sandbox-ep') !== -1 && md.indexOf('次数：3') !== -1, md);
check('源引用去重且取最新 ≤3', (md.split('\n').filter((l) => /^  - .+ @ .+｜.+｜.+/.test(l)).length) === 3, md);
check('源引用最新三个会话(去重取较新那次)', md.indexOf('sess-d') !== -1 && md.indexOf('sess-c') !== -1 && md.indexOf('sess-a') !== -1 && md.indexOf('sess-b @') === -1 && md.indexOf('sess-a @ 2026-09-01 10:20') !== -1, md);
// v0.7.4（审计 N2）：源引用里的会话日志绝对路径必须打码（原来原样落盘，实测 119 个归档 sidecar 里 92 个含用户名）
check('源日志路径已打码为 <path>', (md.match(/session\.jsonl\.zstd/g) || []).length === 0 && md.indexOf('｜<path>') !== -1, md);
// v0.7.4（审计 N9）：实时采集的事件没有 file 字段，此时不能输出字面 undefined
const mdLive = buildDetailMd(9, Object.assign({}, r, { evs: [{ sid: 'sess-live', at: T0, ws: 'SandBox1', text: '实时事件' }] }));
check('实时来源无 file → 不出现 undefined', mdLive.indexOf('undefined') === -1 && mdLive.indexOf('实时采集，无日志文件') !== -1, mdLive);
check('摘录取最长文本', md.indexOf('这是一条超长工具失败原文') !== -1, md);
check('600 字截断', md.indexOf('（截断：完整错误见源日志') !== -1 && LONG_TEXT.length > 600, md);
check('代码围栏成对', (md.match(/```/g) || []).length === 2, md);
check('摘录正文本体 ≤600（注记行不计）', (() => { const body = (md.split('```text')[1] || '').split('```')[0].replace(/^\n/, '').split('\n…（截断')[0]; return body.length <= 600; })(), md.slice(0, 80));

// 空 evs 兜底
const md2 = buildDetailMd(9, { cat: 'other', n: 1, wsSet: new Set(['W']), first: T0, last: T0, text: 'x', evs: [] });
check('空 evs 兜底不抛错', typeof md2 === 'string' && md2.indexOf('无摘录文本') !== -1, md2.slice(0, 200));

// ================= v0.7.5（审计 N20）：解码失败分类 + 扫描健康度落水位线 =================
const repo2 = require('../store/repo.cjs');
const { decodeLinesFrom, scanFrames, zstdAvailable } = require('./decoder.cjs');
const { scanHistory, persistScanStats } = require('./engine.cjs');

check('v0.7.5 zstd 能力可探测（缺失时应明确报错而非静默停摆）', zstdAvailable() === true, zstdAvailable());

const frame = (s) => zlibx.zstdCompressSync(Buffer.from(s + '\n', 'utf8'));
const tmpLog = pathx.join(tmpHome, 'probe.zstd');
fsx.writeFileSync(tmpLog, Buffer.concat([frame('{"a":1}'), frame('{"b":2}')]));
const d1 = decodeLinesFrom(tmpLog, 0);
check('v0.7.5 正常两帧：全解且无异常标记', d1.lines.length === 2 && d1.corruptAt === null && d1.partial === false, d1);
const good1 = frame('{"a":1}');
const good2 = frame('{"b":2}');
// 截断位置要"真的会解压失败"——取第一个会抛的截断长度（不同 Node 版本的宽容度不同）
function truncatedFrame(buf) {
  for (let cut = 4; cut < buf.length; cut++) {
    try { zlibx.zstdDecompressSync(buf.subarray(0, cut)); } catch { return buf.subarray(0, cut); }
  }
  return null;
}
const half = truncatedFrame(good2);
fsx.writeFileSync(tmpLog, Buffer.concat([good1, half || good2.subarray(0, 6)]));
const d2 = decodeLinesFrom(tmpLog, 0);
check('v0.7.5 尾部半写帧 → 不算损坏（partial + offset 停在好帧之后）',
  d2.corruptAt === null && d2.partial === true && d2.nextOffset === good1.length,
  { c: d2.corruptAt, partial: d2.partial, next: d2.nextOffset, want: good1.length });

// 旧实现在这两种形态下会读越界抛 ERR_OUT_OF_RANGE，被上层当成"整文件解码失败"
fsx.writeFileSync(tmpLog, Buffer.concat([good1, Buffer.from([0x28, 0xb5])])); // 半个 magic
const dHalf = decodeLinesFrom(tmpLog, 0);
check('v0.7.5 半个帧头不抛异常（旧实现 ERR_OUT_OF_RANGE）',
  dHalf.corruptAt === null && dHalf.nextOffset === good1.length, { c: dHalf.corruptAt, next: dHalf.nextOffset });
fsx.writeFileSync(tmpLog, Buffer.concat([good1, Buffer.from([0, 0, 0, 0, 0x11]), frame('{"c":3}')])); // magic 错位但后面还有数据
const dBad = decodeLinesFrom(tmpLog, 0);
check('v0.7.5 中段 magic 错位 → mid（其后内容读不到）',
  dBad.corruptAt === 'mid' && dBad.nextOffset === good1.length, { c: dBad.corruptAt, next: dBad.nextOffset });

// 构造"帧头完好、内容/校验损坏"的中段帧（scanFrames 仍能识别三帧）
function midCorruptFixture() {
  const a = frame('{"type":"a"}');
  const c = frame('{"type":"c"}');
  for (let off = 5; off < c.length - 1; off++) {
    const cand = Buffer.from(c);
    cand[off] ^= 0xff;
    try { zlibx.zstdDecompressSync(cand); continue; } catch { /* 找到会抛的位置 */ }
    const buf = Buffer.concat([a, cand, c]);
    if (scanFrames(buf).length === 3) return { buf, firstLen: a.length };
  }
  return null;
}
const fx = midCorruptFixture();
check('v0.7.5 中段坏帧夹具可构造（三帧均可扫描）', !!fx);
if (fx) {
  fsx.writeFileSync(tmpLog, fx.buf);
  const d3 = decodeLinesFrom(tmpLog, 0);
  check('v0.7.5 中段坏帧 → mid 且 offset 停在坏帧之前',
    d3.corruptAt === 'mid' && d3.nextOffset === fx.firstLen && d3.lines.length === 1,
    { c: d3.corruptAt, next: d3.nextOffset, lines: d3.lines.length });

  // 集成：坏帧被计数、badRounds 落水位线、连续 2 轮升级为"卡住的文件"
  const wsDir = pathx.join(repo2.P.sessions, '--W--', 'sid-bad');
  fsx.mkdirSync(wsDir, { recursive: true });
  fsx.writeFileSync(pathx.join(wsDir, 'session.jsonl.zstd'), fx.buf);
  const st = repo2.emptyState();
  const s1 = scanHistory(st, {}, {}).stats;
  const wmKey = Object.keys(st.files)[0];
  check('v0.7.5 scanHistory：坏帧计数 + badRounds=1',
    s1.corruptFrames === 1 && st.files[wmKey] && st.files[wmKey].badRounds === 1,
    { corruptFrames: s1.corruptFrames, wm: st.files[wmKey] });
  const s2 = scanHistory(st, {}, {}).stats;
  check('v0.7.5 scanHistory：第二轮升级为 stuckFiles（可被告警）',
    s2.corruptFrames === 1 && s2.stuckFiles.length === 1 && s2.stuckFiles[0].rounds >= 2,
    s2.stuckFiles);
  check('v0.7.5 扫描健康度可直接落 state（lastScanStats）',
    (() => { persistScanStats(st, s2, '--check'); return st.lastScanStats && st.lastScanStats.corruptFrames === 1 && !!st.lastScanStats.stuckFiles[0].where; })(),
    st.lastScanStats);
}
try { fsx.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
