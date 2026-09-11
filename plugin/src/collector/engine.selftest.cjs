// collector/engine.selftest.cjs - buildDetailMd 纯函数单测（sidecar 内容协议；不跑全量扫描）
// 运行: node src/collector/engine.selftest.cjs （退出码 0 = 全过）
'use strict';
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

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
