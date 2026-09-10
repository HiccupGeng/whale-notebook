// collector/e2e.selftest.cjs - mine 全链沙盒演练（v0.3 基线 + v0.5 增量/聚簇/复发）
// 临时 DSH_HOME 构造 zstd 假会话 → 断言：
//   v0.3：① inbox 追加一行「一句话」现象（无堆栈噪声）② details/C###.md sidecar 同步生成
//         ③ 幂等（重复扫描不重复加）④ 删除候选 → detail 归档
//   v0.5：⑤ 未更新的会话日志整文件跳过（只 stat 不解码）
//         ⑥ 追加一帧只读新增字节（readBytes 远小于文件大小），且【跨窗口继承 callId→工具名】——
//            只有 tool/result 没有 tool/call 的增量帧仍能命中同一聚簇 → 累加次数而非新增重复行
//         ⑦ --dry 只看不写（inbox 与 state 都不变）⑧ --stats 纯只读 ⑨ 已处置候选复发 → 标「复发（原 C0xx）」，
//            冷却期内再复发只静默计数 ⑩ --full 全量重扫不产生重复行
// 运行: node src/collector/e2e.selftest.cjs （退出码 0 = 全过）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-mine-test-'));
process.env.DSH_HOME = tmp;
const nb = path.join(tmp, 'whale-notebook');
fs.mkdirSync(nb, { recursive: true });
const sid = 'sess-e2e';
const wsDir = path.join(tmp, 'sessions', 'SandBox1');
fs.mkdirSync(path.join(wsDir, sid), { recursive: true });
const LOG = path.join(wsDir, sid, 'session.jsonl.zstd');

const T0 = Date.parse('2026-09-09T10:00:00+08:00');
function rec(type, data, t) { return JSON.stringify({ type, time: t, data }); }
function callRec(cid, name, t) { return rec('tool/call', { callId: cid, name }, t); }
function resultRec(cid, text, isError, t) {
  return rec('tool/result', { message: { source: { callId: cid }, content: [{ type: 'tool-result', isError: !!isError, content: [{ type: 'text', text }] }] } }, t);
}
function frame(text) { return zlib.zstdCompressSync(Buffer.from(text, 'utf8')); }
function append(records) { fs.appendFileSync(LOG, frame(records.join('\n') + '\n')); }
const ERR1 = "EPERM: operation not permitted, mkdir 'C:\\sandbox\\out'\n    at Object.mkdirSync (fs.js:1148:12)\n    at Module._compile (internal/modules/cjs/loader.js:1:1)";
const ERR2 = 'timeout: connect to 127.0.0.1:1234 failed';
const ERR3 = "fatal: Authentication failed for 'https://example.invalid/repo.git'";

fs.writeFileSync(LOG, frame([callRec('c1', 'pwsh', T0), resultRec('c1', ERR1, true, T0 + 1)].join('\n') + '\n'));

const repo = require('../store/repo.cjs');
const { runScan } = require('./engine.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const rowOf = (id) => repo.parseInboxRows().find((r) => r.id === id) || null;

try {
  // ---- v0.3 基线 ----
  const out1 = runScan('--check');
  check('runScan 新发现 1 条', out1.ok === true && out1.data.added.length === 1, out1);
  const inbox = fs.readFileSync(path.join(nb, 'inbox.md'), 'utf8');
  check('inbox 行形态 C001/error', /^\| C001 \| error \| 1 \| SandBox1 \|/m.test(inbox), inbox);
  check('现象列一句话（无堆栈噪声）', inbox.indexOf('EPERM: operation not permitted') !== -1 && inbox.indexOf('mkdirSync') === -1 && inbox.indexOf('Module._compile') === -1, inbox);

  const detailFile = path.join(nb, 'details', 'C001.md');
  check('detail sidecar 生成', fs.existsSync(detailFile), fs.readdirSync(path.join(nb, 'details') || []));
  const md = fs.readFileSync(detailFile, 'utf8');
  check('detail 标题与元信息', md.indexOf('# C001 候选详情') === 0 && md.indexOf('error') !== -1 && md.indexOf('SandBox1') !== -1, md.slice(0, 200));
  check('detail 源引用（sid+时间+日志路径）', md.indexOf(sid) !== -1 && md.indexOf('2026-09-09 10:00') !== -1 && md.indexOf('session.jsonl.zstd') !== -1, md);
  check('detail 摘录含错误正文与堆栈', md.indexOf('EPERM: operation not permitted') !== -1, md);

  // ---- v0.5 ⑤：未更新 → 整文件跳过 ----
  const out2 = runScan('--check');
  check('幂等：重复扫描不再追加', out2.ok === true && out2.data.added.length === 0 && out2.data.pending === 1, out2);
  check('未更新会话日志整文件跳过（未解码任何文件）', out2.data.scan.scanned === 0 && out2.data.scan.skipped === 1 && out2.data.scan.readBytes === 0, out2.data.scan);

  // ---- v0.5 ⑥：只读新增字节 + 跨窗口工具名继承 → 累加次数而非重复行 ----
  append([resultRec('c1', ERR1, true, T0 + 60e3)]); // 注意：只有 result，没有 tool/call
  const out3 = runScan('--check');
  check('增量帧命中同一聚簇 → 累加 C001（不新增行）', out3.data.added.length === 0 && out3.data.bumped.length === 1 && out3.data.bumped[0].id === 'C001' && out3.data.bumped[0].n === 2, out3.data);
  check('只读新增字节（readBytes 远小于文件体积）', out3.data.scan.scanned === 1 && out3.data.scan.readBytes > 0 && out3.data.scan.readBytes < 2048, out3.data.scan);
  check('待审仍 1 行且次数=2', repo.pendingCount(repo.readInboxText()) === 1 && (rowOf('C001') || {}).n === '2', repo.readInboxText());
  check('工具名未漂移成 ?（工作区/聚簇键稳定）', (rowOf('C001') || {}).ws === 'SandBox1', rowOf('C001'));
  check('sidecar 追加复发记录', fs.readFileSync(detailFile, 'utf8').indexOf('## 复发记录') !== -1, fs.readFileSync(detailFile, 'utf8').slice(-300));

  // ---- 新坑 → 新候选 ----
  append([callRec('c9', 'pwsh', T0 + 120e3), resultRec('c9', ERR2, true, T0 + 120e3 + 1)]);
  const out4 = runScan('--check');
  check('第二个不同错误 → C002', out4.data.added.length === 1 && out4.data.added[0].id === 'C002' && out4.data.added[0].cat === 'error' && out4.data.added[0].text.indexOf('timeout') === 0, out4.data);

  // ---- v0.5 ⑦：--dry 只看不写 ----
  append([callRec('c8', 'pwsh', T0 + 180e3), resultRec('c8', ERR3, true, T0 + 180e3 + 1)]);
  const stateBefore = fs.readFileSync(path.join(nb, 'state.json'), 'utf8');
  const inboxBefore = repo.readInboxText();
  const dry = runScan('--check', { dry: true });
  check('[dry] 报出将新增 C003', dry.data.dry === true && dry.data.added.length === 1 && dry.data.added[0].id === 'C003', dry.data);
  check('[dry] inbox 未变', repo.readInboxText() === inboxBefore, repo.readInboxText());
  check('[dry] state 未变（水位线/指纹都没落盘）', fs.readFileSync(path.join(nb, 'state.json'), 'utf8') === stateBefore);
  const out5 = runScan('--check');
  check('dry 之后正式跑仍能拿到该候选', out5.data.added.length === 1 && out5.data.added[0].id === 'C003', out5.data);
  check('待审共 3 行', repo.pendingCount(repo.readInboxText()) === 3, repo.readInboxText());

  // ---- v0.5 ⑧：--stats 纯只读 ----
  const stateBefore2 = fs.readFileSync(path.join(nb, 'state.json'), 'utf8');
  const st = runScan('--stats');
  check('--stats 只读不落盘', st.ok === true && fs.readFileSync(path.join(nb, 'state.json'), 'utf8') === stateBefore2, st.text);
  check('--stats 标注只读', st.text.indexOf('只读') !== -1 && st.text.indexOf('全量统计') !== -1, st.text.slice(0, 80));
  check('--stats 事件计数与全量一致', st.data.events >= 3, st.data.events);

  // ---- v0.5 ⑨：已处置候选复发 → 重开并标「复发」；冷却期内静默 ----
  const { deleteCandidate } = require('../ui/server.cjs');
  const d = deleteCandidate({ id: 'C001', now: new Date('2026-09-09T12:00:00+08:00') });
  check('删除成功', d.ok === true, d);
  check('inbox 少一行', repo.pendingCount(repo.readInboxText()) === 2, repo.readInboxText());
  check('detail 归档', !fs.existsSync(detailFile) && fs.existsSync(path.join(nb, 'archive', 'details', 'C001.md')), fs.readdirSync(path.join(nb, 'archive')));

  append([callRec('c7', 'pwsh', T0 + 240e3), resultRec('c7', ERR1, true, T0 + 240e3 + 1)]);
  const out6 = runScan('--check');
  const reRow = out6.data.added[0] || null;
  check('复发 → 新开候选并标「复发（原 C001）」', out6.data.added.length === 1 && reRow && reRow.kind === 'readd' && reRow.text.indexOf('复发（原 C001）') === 0, out6.data);
  const reId = reRow ? reRow.id : null;
  check('复发行次数为累计值 3', reId ? (rowOf(reId) || {}).n === '3' : false, reId ? rowOf(reId) : null);
  check('复发 sidecar 标注原候选', reId ? (repo.readDetail(reId) || '').indexOf('原候选 C001') !== -1 : false, reId ? (repo.readDetail(reId) || '').slice(0, 300) : null);

  deleteCandidate({ id: reId, now: new Date('2026-09-09T13:00:00+08:00') });
  append([callRec('c6', 'pwsh', T0 + 300e3), resultRec('c6', ERR1, true, T0 + 300e3 + 1)]);
  const out7 = runScan('--check');
  check('冷却期内复发 → 静默计数（不重开候选）', out7.data.added.length === 0 && out7.data.silent.length === 1, out7.data);

  // ---- v0.5 ⑩：--full 全量重扫不产生重复 ----
  const pendingBeforeFull = repo.pendingCount(repo.readInboxText());
  const outFull = runScan('--check', { full: true });
  check('--full 全量重扫：无新增、无重复', outFull.data.added.length === 0 && repo.pendingCount(repo.readInboxText()) === pendingBeforeFull, outFull.data);
  check('--full 确实重读全部文件', outFull.data.scan.scanned === 1 && outFull.data.scan.skipped === 0 && outFull.data.scan.readBytes > 0, outFull.data.scan);

  // ---- v0.5.1：自引用/探针回声过滤（不静默丢失，落 archive/echo-*.md 可审计）----
  // 三条都是「维修采集器自身」时真实会出现的失败形态（旧版 error 类绕过 SELF_REF，全部会进箱）
  const pendingBeforeEcho = repo.pendingCount(repo.readInboxText());
  const EH1 = 'grep search failed (exit 2): rg: ~\\.dsh\\whale-notebook\\tools\\sync-release.cjs: 系统找不到指定的文件。';
  const EH2 = 'cannot read "details/C012.md": not found';
  const EH3 = 'ReferenceError: ENC_DIAG_RE is not defined';
  append([callRec('ce1', 'pwsh', T0 + 360e3), resultRec('ce1', EH1, true, T0 + 360e3 + 1)]);
  append([callRec('ce2', 'read', T0 + 366e3), resultRec('ce2', EH2, true, T0 + 366e3 + 1)]);
  append([callRec('ce3', 'node', T0 + 372e3), resultRec('ce3', EH3, true, T0 + 372e3 + 1)]);
  const outEcho = runScan('--check');
  check('回声被过滤：不进待审箱', outEcho.data.added.length === 0 && outEcho.data.echo >= 3 && repo.pendingCount(repo.readInboxText()) === pendingBeforeEcho, outEcho.data);
  check('回声组数/条数与输出提示', outEcho.data.echo === 3 && outEcho.data.echoEvents === 3 && outEcho.text.indexOf('自引用回声过滤 3 组/3 条') !== -1, outEcho.text);
  const echoFiles = fs.readdirSync(path.join(nb, 'archive')).filter((f) => /^echo-\d{8}\.md$/.test(f));
  const echoText = echoFiles.length ? fs.readFileSync(path.join(nb, 'archive', echoFiles[0]), 'utf8') : '';
  check('回声落档（archive/echo-*.md 可审计）', echoFiles.length === 1 && echoText.indexOf('sync-release.cjs') !== -1 && echoText.indexOf('ENC_DIAG_RE') !== -1, echoFiles);

  // 弱特征只命中 1 条时不得误伤：真实故障文本常含单个技术词（cordis 只出现一次）
  append([callRec('cg1', 'pwsh', T0 + 378e3), resultRec('cg1', 'fatal: 无法连接 cordis 注册表，安装失败', true, T0 + 378e3 + 1)]);
  const outReal = runScan('--check');
  check('弱特征单命中不误伤真实故障（仍入箱）', outReal.data.added.length === 1 && outReal.data.added[0].cat === 'error' && outReal.data.echo === 0, outReal.data);

  // ---- v0.6 拉取式（autoAdd=false）：只暂存不写 inbox，--add 才入箱 ----
  fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, autoAdd: false, maxDeferred: 200 }), 'utf8');
  const pendingBeforeDefer = repo.pendingCount(repo.readInboxText());
  const inboxBeforeDefer = repo.readInboxText();
  append([callRec('cd1', 'pwsh', T0 + 420e3), resultRec('cd1', 'ENOENT: 部署脚本找不到 config.json', true, T0 + 420e3 + 1)]);
  append([callRec('cd2', 'pwsh', T0 + 426e3), resultRec('cd2', 'EADDRINUSE: 端口 3080 已被占用', true, T0 + 426e3 + 1)]);
  const outDefer = runScan('--check');
  check('拉取式：--check 不写待审箱', outDefer.data.deferredOn === true && outDefer.data.added.length === 0 && outDefer.data.deferred.length === 2 && repo.readInboxText() === inboxBeforeDefer, outDefer.data);
  check('拉取式：输出报「暂存」而非「新发现」', outDefer.text.indexOf('新发现暂存 2 组') !== -1 && outDefer.text.indexOf('未入箱') !== -1, outDefer.text);
  const stDefer = repo.readState();
  check('暂存摘要落 state.deferred（含组数与证据）', Object.keys(stDefer.deferred || {}).length === 2 && Object.values(stDefer.deferred).every((d) => d.n >= 1 && d.refs.length >= 1 && typeof d.excerpt === 'string'), Object.keys(stDefer.deferred || {}));
  check('拉取式仍推进水位线与指纹', !!stDefer.files[LOG] && stDefer.files[LOG].offset === fs.statSync(LOG).size && stDefer.seenFingerprints.length > 0, stDefer.files[LOG]);

  // 再出现一次同样的坑 → 仍只累加暂存，不新增组
  append([callRec('cd3', 'pwsh', T0 + 432e3), resultRec('cd3', 'EADDRINUSE: 端口 3080 已被占用', true, T0 + 432e3 + 1)]);
  const outDefer2 = runScan('--check');
  check('同坑复发只累加暂存（组数不变）', outDefer2.data.deferred.length === 1 && outDefer2.data.deferred[0].n === 2 && Object.keys(repo.readState().deferred).length === 2, outDefer2.data);

  // --add：冲入待审箱（含 sidecar 重建与暂存清空）
  const outAdd = runScan('--add');
  check('--add 入箱 2 条', outAdd.data.added.length === 2 && outAdd.data.remaining === 0 && outAdd.data.pending === pendingBeforeDefer + 2, outAdd.data);
  check('--add 后暂存清空', Object.keys(repo.readState().deferred || {}).length === 0);
  check('--add 生成候选行与 sidecar', !!rowOf(outAdd.data.added[0].id) && fs.existsSync(path.join(nb, 'details', outAdd.data.added[0].id + '.md')), outAdd.data);
  check('--add 的 sidecar 含源引用与摘录', (repo.readDetail(outAdd.data.added[0].id) || '').indexOf('session.jsonl.zstd') !== -1, (repo.readDetail(outAdd.data.added[0].id) || '').slice(0, 200));
  const outAdd2 = runScan('--add');
  check('--add 幂等（无暂存时入箱 0 条）', outAdd2.data.added.length === 0 && outAdd2.data.remaining === 0, outAdd2.data);

  // 拉取式下，已入箱候选再次出现 → 只累加次数，不新增行
  const pendingAfterAdd = repo.pendingCount(repo.readInboxText());
  append([callRec('cd4', 'pwsh', T0 + 438e3), resultRec('cd4', 'EADDRINUSE: 端口 3080 已被占用', true, T0 + 438e3 + 1)]);
  const outBump = runScan('--check');
  check('拉取式下在箱候选只累加次数', outBump.data.bumped.length === 1 && outBump.data.deferred.length === 0 && repo.pendingCount(repo.readInboxText()) === pendingAfterAdd, outBump.data);

  // 切回自动入箱（后续断言依赖 v0.5 行为）
  fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, autoAdd: true }), 'utf8');

  // ---- 水位线结构 ----
  const state = repo.readState();
  const wm = state.files[LOG];
  check('state v2 水位线存在', state.v === 2 && !!wm && wm.offset > 0 && wm.offset === fs.statSync(LOG).size, wm);
  check('水位线记录工作区与 callId 映射', !!wm && wm.ws === 'SandBox1' && !!wm.calls && wm.calls.c6 === 'pwsh', wm);
  check('聚簇索引有 cid 映射', Object.keys(state.clusters || {}).length >= 2 && Object.values(state.clusters).every((c) => /^C\d{3}$/.test(c.cid)), Object.keys(state.clusters || {}).length);

  // ---- v0.7：同族合并（同一坑的不同变体并成一行）+ related 端点 ----
  // 夹具要点：差异必须落在 canonText 的 90 字截断之内（否则是同一个精确聚簇，走 bump 而非族合并），
  // 且差异部分要能被骨架归一化（这里用两个不同 IP）→ 骨架相同、相似度 1、精确聚簇不同。
  const G1 = "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to 140.82.114.3 port 443";
  const G2 = "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to 20.205.243.166 port 443";
  const rowsBeforeFam = repo.pendingCount(repo.readInboxText());
  append([callRec('cf1', 'pwsh', T0 + 480e3), resultRec('cf1', G1, true, T0 + 480e3 + 1)]);
  const outFam1 = runScan('--check');
  append([callRec('cf2', 'pwsh', T0 + 486e3), resultRec('cf2', G2, true, T0 + 486e3 + 1)]);
  const outFam2 = runScan('--check');
  const famId = outFam1.data.added[0] ? outFam1.data.added[0].id : null;
  check('v0.7 同族合并：变体不新开行，累加到同一候选',
    outFam1.data.added.length === 1 && outFam2.data.added.length === 0 && outFam2.data.bumped.length === 1 &&
    repo.pendingCount(repo.readInboxText()) === rowsBeforeFam + 1, { a: outFam1.data, b: outFam2.data });
  check('v0.7 族成员指向同一候选（state.clusters 同 cid ×2）',
    !!famId && Object.values(repo.readState().clusters).filter((c) => c.cid === famId).length === 2,
    famId ? Object.values(repo.readState().clusters).map((c) => c.cid) : null);
  check('v0.7 同族并入记入 sidecar（讨论会话据此看到变体）',
    !!famId && (repo.readDetail(famId) || '').indexOf('同族并入') !== -1, famId ? (repo.readDetail(famId) || '').slice(-240) : null);
  const rel = require('../ui/server.cjs').relatedPayload(famId || 'C000');
  check('v0.7 GET /whale/related：族大小/相似候选/覆盖条目三块齐备',
    rel.ok === true && rel.family.size === 2 && rel.family.variants.length === 2 && Array.isArray(rel.related) && Array.isArray(rel.entries),
    rel.ok ? { size: rel.family.size, rel: rel.related.length, ent: rel.entries.length } : rel);
  check('v0.7 不误并：另一种坑仍单独开行', (() => {
    const before = repo.pendingCount(repo.readInboxText());
    append([callRec('cf3', 'pwsh', T0 + 492e3), resultRec('cf3', 'ENOSPC: no space left on device, write failed', true, T0 + 492e3 + 1)]);
    const o = runScan('--check');
    return o.data.added.length === 1 && repo.pendingCount(repo.readInboxText()) === before + 1;
  })());

  // ---- v0.6.1：--rebuild 从头梳理全部历史；--rebuild --add 一条命令扫完入箱 ----
  fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, autoAdd: false }), 'utf8');
  const pendingBeforeRebuild = repo.pendingCount(repo.readInboxText());
  const outRebuild = runScan('--rebuild');
  // 注意：历史里「现象列与在箱候选相同」的聚簇会被认领为同一坑 → 走 bump 而不是进暂存，
  // 所以断言取「暂存组数 + 并入条数」之和。
  check('--rebuild 重新发现历史全部坑（暂存+并入，不写箱）',
    outRebuild.data.rebuild === true && (outRebuild.data.deferredTotal + outRebuild.data.bumped.length) >= 4 &&
    outRebuild.data.added.length === 0 && repo.pendingCount(repo.readInboxText()) === pendingBeforeRebuild, outRebuild.data);
  check('--rebuild 后水位线重建到位', !!repo.readState().files[LOG] && repo.readState().files[LOG].offset === fs.statSync(LOG).size);
  const outRebuildAdd = runScan('--rebuild', { add: true });
  check('--rebuild --add 一条命令扫完直接入箱',
    outRebuildAdd.data.rebuild === true && (outRebuildAdd.data.added.length + outRebuildAdd.data.bumped.length) >= 4 &&
    repo.pendingCount(repo.readInboxText()) >= pendingBeforeRebuild, outRebuildAdd.data);
  check('--rebuild 不清 nextCandidateId（编号不与归档冲突）', repo.readState().nextCandidateId > 1);

  // ---- --prewarm 明确提示会消费候选 ----
  const pw = runScan('--prewarm');
  check('prewarm 提示会消费候选', pw.ok === true && pw.text.indexOf('不会再作为候选出现') !== -1, pw.text);

  // ---- v0.7.3：CLI 退出码契约（脚本化调用不再靠解析 stdout 判成败；判定层保持纯函数）----
  const { spawnSync } = require('child_process');
  const MINE = path.join(__dirname, '..', '..', '..', 'scripts', 'mine.cjs');
  const spawnMine = (args, home) => spawnSync(process.execPath, [MINE, ...args], {
    encoding: 'utf8', env: Object.assign({}, process.env, home ? { DSH_HOME: home } : {}),
  });
  const textOf = (r) => ((r.stdout || '') + (r.stderr || ''));
  const rOk = spawnMine(['--check'], tmp);
  check('v0.7.3 CLI 退出码：正常采集 = 0（"有新发现/有暂存"不算失败）', rOk.status === 0, { status: rOk.status, out: textOf(rOk).slice(0, 160) });
  const noNb = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cli-nonb-'));
  fs.mkdirSync(path.join(noNb, 'sessions'), { recursive: true });   // 有 sessions、无数据目录 → 命中第 2 处 ok:false
  const noSessions = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-cli-nosess-')); // 连 sessions 也没有 → 命中第 1 处
  const rNoNb = spawnMine(['--check'], noNb);
  const rNoSessions = spawnMine(['--check'], noSessions);
  check('v0.7.3 CLI 退出码：前置缺失 = 2（数据目录缺失 / sessions 根缺失）',
    rNoNb.status === 2 && rNoSessions.status === 2 &&
    textOf(rNoNb).indexOf('whale-notebook dir missing') !== -1 && textOf(rNoSessions).indexOf('no sessions root') !== -1,
    { noNb: { status: rNoNb.status, out: textOf(rNoNb).slice(0, 120) }, noSessions: { status: rNoSessions.status, out: textOf(rNoSessions).slice(0, 120) } });
  fs.rmSync(noNb, { recursive: true, force: true });
  fs.rmSync(noSessions, { recursive: true, force: true });
  const rRender = spawnMine(['--render-rules'], tmp);
  check('v0.7.3 CLI 退出码：早返回分支（--render-rules）= 0', rRender.status === 0, { status: rRender.status, out: textOf(rRender).slice(0, 120) });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
