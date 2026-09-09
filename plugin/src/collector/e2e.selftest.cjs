// collector/e2e.selftest.cjs - mine 全链沙盒演练（v0.3）
// 临时 DSH_HOME 构造 zstd 假会话 → runScan('--check') → 断言：
//   ① inbox 追加一行「一句话」现象（无堆栈噪声）② details/C###.md sidecar 同步生成（源引用+路径）
//   ③ 幂等（重复扫描不重复加）④ 删除候选 → detail 归档
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

const T = Date.parse('2026-09-09T10:00:00+08:00');
function ev(type, data) { return JSON.stringify({ type, time: T, data }); }
const callId = 'call-1';
const errText = "EPERM: operation not permitted, mkdir 'C:\\sandbox\\out'\n    at Object.mkdirSync (fs.js:1148:12)\n    at Module._compile (internal/modules/cjs/loader.js:1:1)";
const jsonl = [
  ev('tool/call', { callId, name: 'pwsh' }),
  ev('tool/result', {
    callId,
    message: {
      source: { callId },
      content: [{ type: 'tool-result', isError: true, content: [{ type: 'text', text: errText }] }],
    },
  }),
].join('\n') + '\n';
fs.writeFileSync(path.join(wsDir, sid, 'session.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(jsonl, 'utf8')));

const repo = require('../store/repo.cjs');
const { runScan } = require('./engine.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

try {
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

  const out2 = runScan('--check');
  check('幂等：重复扫描不再追加', out2.ok === true && out2.data.added.length === 0 && out2.data.pending === 1, out2);

  // 删除候选 → inbox 少行 + detail 移入 archive/details/
  const { deleteCandidate } = require('../ui/server.cjs');
  const d = deleteCandidate({ id: 'C001', now: new Date('2026-09-09T12:00:00+08:00') });
  check('删除成功', d.ok === true, d);
  check('inbox 已空', repo.pendingCount(repo.readInboxText()) === 0, repo.readInboxText());
  check('detail 归档', !fs.existsSync(detailFile) && fs.existsSync(path.join(nb, 'archive', 'details', 'C001.md')), fs.readdirSync(path.join(nb, 'archive')));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
