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
// v0.7.7：异步块要用到 runScanAsync / scanHistoryAsync（scanHistory 已在下方既有的解构里）
const { runScanAsync, scanHistoryAsync } = require('./engine.cjs');
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
// ---- v0.7.6（审计第 1 项）：echo 稳定签名 + 历史污染清理（--forget-echo 的纯函数内核）----
// 背景：回声分组原来按"聚簇哈希（整段文本）"，尾部一变就新开一行 → 231 行只对应 77 个现象。
{
  const { echoSig, echoSigOf, forgetEchoDeferred } = require('./engine.cjs');
  const evEcho = { cat: 'encoding', at: T0, ws: 'W', sid: 's', tool: 'pwsh', text: 'HTTP 200 {"ok":true,"id":"C122","candidate":{"id":"C122"' };
  check('v0.7.6 echo 签名与归档列同口径（类别|一句话）',
    echoSigOf(evEcho) === echoSig('encoding', 'HTTP 200 {"ok":true,"id":"C122","candidate":{"id":"C122"'), echoSigOf(evEcho));
  // 真实不变式：**前 90 字相同**（打码后）→ 同签名（尾部差异——正是"同一现象被二次打印"的形态——不影响）；
  // 前 90 字不同 → 必须仍是两个签名（否则会把不同内容压成同一行）。
  const tail80 = 'word '.repeat(40); // 200 字，含空格 → oneLiner 截到前 90 字 + '…'
  check('v0.7.6 echo 签名对同现象稳定（尾 90 字以外的差异不影响签名）',
    echoSigOf({ cat: 'error', text: tail80 + 'TAIL-A' }) === echoSigOf({ cat: 'error', text: tail80 + 'TAIL-B' }));
  check('v0.7.6 echo 签名不吞并不同内容（前 90 字不同 = 两个签名）',
    echoSigOf({ cat: 'error', text: 'first failure text AAAAAAAA' }) !== echoSigOf({ cat: 'error', text: 'second failure text BBBBBBB' }));

  const stateF = repo2.emptyState();
  stateF.deferred = {
    leak1: { cat: 'encoding', text: 'topKeys=ok,stats,global,projects,disabled rawHead={"ok":true', n: 1, first: 1, last: 1, ws: ['W'], refs: [], excerpt: '' },
    leak2: { cat: 'sandbox-file', text: 'lines=2946 chars=129046 idx=123471 286, "reAddedAt": 0', n: 2, first: 2, last: 2, ws: ['W'], refs: [], excerpt: '' },
    real3: { cat: 'git-net', text: '--- 1) DNS --- 20.205.243.166 --- 2) TCP443 --- github.com:443 reachable = False', n: 1, first: 3, last: 3, ws: ['W'], refs: [], excerpt: '' },
  };
  const dryOut = forgetEchoDeferred(stateF, {}, {});
  check('v0.7.6 --forget-echo 干跑：列出被污染条目但不动数据',
    dryOut.apply === false && dryOut.removed === 0 && dryOut.hits.length === 2 && Object.keys(stateF.deferred).length === 3,
    { hits: dryOut.hits.length, left: Object.keys(stateF.deferred).length });
  const appliedOut = forgetEchoDeferred(stateF, {}, { apply: true });
  check('v0.7.6 --forget-echo --apply：删掉自引用条目、保住真实故障',
    appliedOut.removed === 2 && Object.keys(stateF.deferred).length === 1 && !!stateF.deferred.real3,
    { removed: appliedOut.removed, left: Object.keys(stateF.deferred) });
}
// ---- v0.7.7（审计第 2/3 项）：异步扫描（让出事件循环）与 --rebuild 维护窗口 ----
// 造 9 份小日志：≥1 个让出点（每 8 个文件一次），才能观测 onProgress 与"窗口正开着"的瞬间。
fsx.mkdirSync(repo2.P.nb, { recursive: true }); // runScanAsync 的前置检查要求数据目录存在
for (let i = 0; i < 9; i++) {
  const d = pathx.join(repo2.P.sessions, '--W7--', 'sid-' + String(i).padStart(2, '0'));
  fsx.mkdirSync(d, { recursive: true });
  const line = JSON.stringify({ type: 'session', time: T0, cwd: 'C:\\ws\\W7' }) + '\n'
    + JSON.stringify({
      type: 'tool/result', time: T0 + i * 1000,
      data: { message: { source: { callId: 'x' + i }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'v0.7.7 fixture failure #' + i }] }] } },
    }) + '\n';
  fsx.writeFileSync(pathx.join(d, 'session.jsonl.zstd'), zlibx.zstdCompressSync(Buffer.from(line, 'utf8')));
}

(async () => {
  // ① 同步/异步两条驱动必须产出**完全相同**的事件与扫描统计（同一生成器、两个驱动，永不漂移）
  const stSync = repo2.emptyState();
  const stAsync = repo2.emptyState();
  const syncOut = scanHistory(stSync, {}, { full: true });
  let progressSeen = 0;
  const asyncOut = await scanHistoryAsync(stAsync, {}, { full: true, ctl: { onProgress: () => { progressSeen++; } } });
  check('v0.7.7 异步与同步扫描结果一致（事件逐字节 + 统计口径）',
    JSON.stringify(syncOut.events) === JSON.stringify(asyncOut.events)
    && syncOut.stats.scanned === asyncOut.stats.scanned && syncOut.stats.readBytes === asyncOut.stats.readBytes,
    { sync: syncOut.stats, async: asyncOut.stats });
  check('v0.7.7 异步驱动确实让出事件循环（onProgress 被调用）', progressSeen >= 1, progressSeen);

  // ② rebuild 期间维护窗口开启、结束后无条件关闭
  let markerDuring = null;
  const rb = await runScanAsync('--rebuild', { ctl: { onProgress: () => { markerDuring = repo2.readMaintenance(); } } });
  check('v0.7.7 rebuild 期间维护窗口开启（让出点可见 kind=rebuild）',
    !!markerDuring && markerDuring.kind === 'rebuild', markerDuring);
  check('v0.7.7 rebuild 结束后维护窗口关闭（标记文件已清理）',
    rb.ok === true && repo2.readMaintenance() === null && !fsx.existsSync(repo2.maintenancePath()), repo2.readMaintenance());
  check('v0.7.7 异步 rebuild 返回体与同步路径同形（rebuild=true + 扫描统计）',
    rb.ok === true && rb.data.rebuild === true && !!rb.data.scan, rb.ok ? String(rb.text).slice(0, 80) : rb);

  // ③ 窗口化聚合正确性：同一份大日志，"1KB 小窗口切片续读" 与 "一次整读" 必须产出**完全相同**的事件与水位线。
  //   （v0.7.7 第二轮修正：为了让出事件循环，大日志被切成 256KB 片；切片聚合一旦写错，
  //     症状是"少事件 / 水位线停在半路"，所以必须在单测里用小窗口把切片路径跑满。）
  const bigDir = pathx.join(repo2.P.sessions, '--W7--', 'sid-big');
  fsx.mkdirSync(bigDir, { recursive: true });
  const bigFrames = [];
  for (let i = 0; i < 120; i++) {
    const text = JSON.stringify({ type: 'session', time: T0, cwd: 'C:\\ws\\W7' }) + '\n'
      + JSON.stringify({
        type: 'tool/result', time: T0 + i,
        data: { message: { source: { callId: 'b' + i }, content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: 'windowed fixture failure #' + i }] }] } },
      }) + '\n';
    bigFrames.push(zlibx.zstdCompressSync(Buffer.from(text, 'utf8')));
  }
  const bigLog = pathx.join(bigDir, 'session.jsonl.zstd');
  fsx.writeFileSync(bigLog, Buffer.concat(bigFrames));
  const stWhole = repo2.emptyState();
  const wholeOut = scanHistory(stWhole, {}, { full: true });
  const stSliced = repo2.emptyState();
  let windows = 0;
  const slicedOut = await scanHistoryAsync(stSliced, {}, { full: true, ctl: { sliceBytes: 1024, onProgress: () => { windows++; } } });
  check('v0.7.7 窗口化(1KB 片)与整读产出完全相同的事件与水位线',
    JSON.stringify(slicedOut.events) === JSON.stringify(wholeOut.events)
    && JSON.stringify(stSliced.files[bigLog]) === JSON.stringify(stWhole.files[bigLog]),
    { evWhole: wholeOut.events.length, evSliced: slicedOut.events.length, wmWhole: stWhole.files[bigLog], wmSliced: stSliced.files[bigLog] });
  check('v0.7.7 小窗口确实切了多片（>5 次让出，切片路径被真正跑到）', windows > 5, windows);

  // ④ 取消：明确失败、释放写锁、关掉维护窗口（卸载路径不许留下半个窗口或一把死锁）
  const cancelled = await runScanAsync('--rebuild', { ctl: { cancelled: () => true, onProgress: () => {} } });
  check('v0.7.7 取消：明确失败（不静默成功）', cancelled.ok === false && cancelled.cancelled === true, cancelled);
  check('v0.7.7 取消后不残留写锁与维护窗口',
    !fsx.existsSync(repo2.lockPath()) && !fsx.existsSync(repo2.maintenancePath()) && repo2.readMaintenance() === null,
    { lock: fsx.existsSync(repo2.lockPath()), mk: repo2.readMaintenance() });
})()
  .catch((err) => { fails++; console.error('FAIL v0.7.7 异步块异常 :: ' + (err && err.stack ? err.stack : err)); })
  .then(() => {
    try { fsx.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* 清理失败不影响结论 */ }
    console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
    process.exit(fails === 0 ? 0 : 1);
  });
