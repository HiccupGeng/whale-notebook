// src/ui/server.selftest.cjs - 决策箱面板 host API 沙盒单测（临时 DSH_HOME，不触碰现场数据）
// 运行: node src/ui/server.selftest.cjs （退出码 0 = 全过）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-server-test-'));
// repo.cjs 在模块加载时读 DSH_HOME → 必须最先设置
process.env.DSH_HOME = tmp;
const nb = path.join(tmp, 'whale-notebook');
fs.mkdirSync(path.join(nb, 'archive'), { recursive: true });

const HEADER = '# 鲸鱼小本本 · 待审核箱（inbox）\n\n| 编号 | 类别 | 次数 | 工作区 | 现象（一行，已打码） | 首次出现 |\n|---|---|---|---|---|---|\n';
const LINES = [
  '| C001 | encoding | 3+ | SillyTavern-Agent 等 | 命令/请求体内联中文被控制台链路破坏成 `????` | 2026-08-17 19:33 |',
  '| C002 | stale-fs | 7 | 全部工作区 | edit 报 old_string not found，同文件连环失败 | 2026-08-17 18:15 |',
  '| C003 | secret | 1 | SandBox1 | GitHub PAT 曾明文贴进聊天 | 2026-09-01 11:57 |',
  '| C004 | session-state | 1 | SillyTavern-Agent | 任务全部完成但 todo 未翻 completed | 2026-08-17 19:20 |',
].join('\n');
fs.writeFileSync(path.join(nb, 'inbox.md'), HEADER + LINES + '\n', 'utf8');

const repo = require('../store/repo.cjs');
const server = require('./server.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

try {
  // list
  const l = server.listPayload();
  check('list.ok', l.ok === true && l.pending === 4, l);
  check('list.rows 形状与顺序', l.rows.length === 4 && l.rows[0].id === 'C001' && l.rows[3].time.indexOf('2026') === 0, l.rows);
  check('list.rows 中文/打码现象保真', l.rows[2].text.indexOf('明文贴进聊天') !== -1 && l.rows[0].cat === 'encoding', l.rows[2]);

  // v0.3 detail sidecar：写入 → detailPayload 命中/错误路径（只读不写盘）
  const DETAIL_MD = '# C002 候选详情\n\n- 一句话：edit 报 old_string not found\n\n- 错误摘录：\n```text\nError: EPERM: operation not permitted\n```\n';
  check('writeDetail 落盘', repo.writeDetail('C002', DETAIL_MD) === true && fs.existsSync(path.join(nb, 'details', 'C002.md')), fs.readdirSync(path.join(nb, 'details')));
  const dp = server.detailPayload('C002');
  check('detailPayload 命中', dp.ok === true && dp.text.indexOf('# C002 候选详情') === 0, dp);
  const dn = server.detailPayload('C099');
  check('detailPayload 未知编号', dn.ok === false && dn.error.indexOf('暂无详情') !== -1, dn);
  const dx = server.detailPayload('x02');
  check('detailPayload 非法编号', dx.ok === false && dx.error.indexOf('非法') !== -1, dx);
  check('detailPayload 错误路径不写盘', fs.readdirSync(path.join(nb, 'details')).length === 1, fs.readdirSync(path.join(nb, 'details')));

  // delete 命中
  const d = server.deleteCandidate({ id: 'C002', now: new Date('2026-09-10T12:34:00+08:00') });
  check('delete.ok', d.ok === true && d.removed === 1 && d.archived === true, d);
  const after = fs.readFileSync(path.join(nb, 'inbox.md'), 'utf8');
  check('inbox 移除 C002', /^\| C002 /m.test(after) === false && (after.match(/^\| C\d+ /gm) || []).length === 3, after);
  const archives = fs.readdirSync(path.join(nb, 'archive')).filter((f) => f.endsWith('.md'));
  check('archive 生成当日文件', archives.length === 1 && /^archive-\d{8}\.md$/.test(archives[0]), archives);
  const arc = fs.readFileSync(path.join(nb, 'archive', archives[0]), 'utf8');
  check('archive 含原行+处置列', arc.indexOf('| C002 | stale-fs | 7 |') !== -1 && arc.indexOf('面板删除 2026-09-10 12:34') !== -1, arc);
  check('archive 其余候选未误入', arc.indexOf('C001') === -1 && arc.indexOf('C003') === -1, arc);
  check('detail 随删除归档', !fs.existsSync(path.join(nb, 'details', 'C002.md')) && fs.existsSync(path.join(nb, 'archive', 'details', 'C002.md')), fs.readdirSync(path.join(nb, 'archive')));

  // 幂等/错误路径
  const u1 = server.deleteCandidate({ id: 'C099', now: new Date() });
  check('delete 未知编号报错', u1.ok === false && u1.error.indexOf('不存在') !== -1, u1);
  const u2 = server.deleteCandidate({ id: 'C002', now: new Date() });
  check('delete 重复报错', u2.ok === false, u2);
  const u3 = server.deleteCandidate({ id: 'x02', now: new Date() });
  check('delete 非法编号报错', u3.ok === false && u3.error.indexOf('非法') !== -1, u3);
  const archives2 = fs.readdirSync(path.join(nb, 'archive')).filter((f) => f.endsWith('.md'));
  check('错误路径不写盘', archives2.length === 1, archives2);
  const after2 = fs.readFileSync(path.join(nb, 'inbox.md'), 'utf8');
  check('错误路径 inbox 不变', (after2.match(/^\| C\d+ /gm) || []).length === 3, after2);

  // 删空
  const d2 = server.deleteCandidate({ id: 'C001', now: new Date() });
  const d3 = server.deleteCandidate({ id: 'C003', now: new Date() });
  const d4 = server.deleteCandidate({ id: 'C004', now: new Date() });
  check('删空到最后一条', d2.ok && d3.ok && d4.ok, [d2, d3, d4]);
  const l2 = server.listPayload();
  check('空箱 list', l2.ok === true && l2.pending === 0 && l2.rows.length === 0, l2);
  const archives3 = fs.readdirSync(path.join(nb, 'archive')).filter((f) => f.endsWith('.md'));
  check('全部归档同一文件', archives3.length === 1 && (fs.readFileSync(path.join(nb, 'archive', archives3[0]), 'utf8').match(/面板删除/g) || []).length === 4, archives3);

  check('localStamp 格式', server.localStamp(new Date('2026-09-10T07:05:06+08:00')) === '2026-09-10 07:05', server.localStamp(new Date('2026-09-10T07:05:06+08:00')));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
