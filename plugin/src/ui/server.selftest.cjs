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
const agents = require('../inject/agents.cjs');
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

  // ============ v0.4 已解决墙：条目 roundtrip / solvedPayload / entryPayload / buildIndexMd ============
  const { renderEntryFile } = require('../core/schema.cjs');
  const entriesDir = path.join(nb, 'entries');
  fs.mkdirSync(entriesDir, { recursive: true });
  const mkEntry = (e) => fs.writeFileSync(path.join(entriesDir, `${e.id}-${e.slug}.md`), renderEntryFile(e), 'utf8');
  mkEntry({
    id: 'E001', slug: 'enc', title: '中文编码转义', category: 'encoding', status: 'active', scope: 'global', projects: [],
    occurrences: 5, firstSeen: '2026-08-17', lastSeen: '2026-09-01', workspaces: ['SandBox1', 'wsB'], rule: '命令与脚本不内联中文 | 走 UTF-8 文件引用', created: '2026-09-09', updated: '2026-09-09', sources: ['s1'],
    symptom: '内联中文被破坏', rootCause: '控制台链路编码', actions: '改文件引用', verification: '重跑成功',
  });
  mkEntry({
    id: 'E002', slug: 'pyenv', title: 'Python 环境路径', category: 'data-access', status: 'active', scope: 'project', projects: ['SandBox1'],
    occurrences: 2, firstSeen: '2026-08-20', lastSeen: '2026-08-21', workspaces: ['SandBox1'], rule: '先查 PATH 再报环境缺失', created: '2026-09-09', updated: '2026-09-09', sources: ['s2'],
    symptom: 'python 找不到', rootCause: '未配 PATH', actions: '配置路径', verification: '',
  });
  mkEntry({
    id: 'E003', slug: 'multi', title: '多项目共用经验', category: 'stale-fs', status: 'active', scope: 'project', projects: ['SandBox1', 'wsB'],
    occurrences: 3, firstSeen: '2026-08-18', lastSeen: '2026-08-30', workspaces: ['SandBox1', 'wsB'], rule: '编辑前先 read 最新', created: '2026-09-09', updated: '2026-09-09', sources: ['s3'],
    symptom: 'stale read', rootCause: '缓存旧', actions: '先 read', verification: '',
  });
  mkEntry({
    id: 'E004', slug: 'old', title: '已停用经验', category: 'other', status: 'disabled', scope: 'global', projects: [],
    occurrences: 1, firstSeen: '2026-07-01', lastSeen: '2026-07-02', workspaces: ['SandBox1'], rule: '旧规则', created: '2026-09-09', updated: '2026-09-09', sources: ['s4'],
    symptom: 'x', rootCause: 'y', actions: 'z', verification: '',
  });
  let es = repo.listEntries();
  check('entries roundtrip scope/projects', es.length === 4 && es.find((e) => e.id === 'E001').scope === 'global' &&
    es.find((e) => e.id === 'E002').scope === 'project' &&
    JSON.stringify(es.find((e) => e.id === 'E003').projects) === JSON.stringify(['SandBox1', 'wsB']) &&
    es.find((e) => e.id === 'E004').status === 'disabled', es.map((e) => [e.id, e.scope, e.projects]));
  check('entry rule 去引号解析', es.find((e) => e.id === 'E001').rule === '命令与脚本不内联中文 | 走 UTF-8 文件引用', es.find((e) => e.id === 'E001').rule);
  // 旧条目（无 scope/projects 行）缺省兼容
  fs.writeFileSync(path.join(entriesDir, 'E099-old.md'), '---\nid: E099\ntitle: 旧条目\ncategory: other\nstatus: active\noccurrences: 1\nfirstSeen: 2026-01-01\nlastSeen: 2026-01-01\nworkspaces: [SandBox1]\nrule: "旧格式"\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources: []\n---\n', 'utf8');
  es = repo.listEntries();
  const e99 = es.find((e) => e.id === 'E099');
  check('旧条目缺省 scope=global/projects=[]', e99.scope === 'global' && e99.projects.length === 0 && e99.status === 'active', e99);
  fs.rmSync(path.join(entriesDir, 'E099-old.md'));

  const sv = server.solvedPayload();
  check('solved.stats', sv.ok === true && sv.stats.active === 3 && sv.stats.global === 1 && sv.stats.project === 2 && sv.stats.disabled === 1, sv.stats);
  check('solved.global 分组（类别序）', sv.global.length === 1 && sv.global[0].cat === 'encoding' && sv.global[0].entries.length === 1 && sv.global[0].entries[0].id === 'E001' && sv.global[0].entries[0].scope === 'global', sv.global);
  check('solved.projects 多项目展开', sv.projects.length === 2 && sv.projects[0].ws === 'SandBox1' && sv.projects[0].entries.length === 2 &&
    sv.projects[1].ws === 'wsB' && sv.projects[1].entries.length === 1 && sv.projects[1].entries[0].id === 'E003', sv.projects);
  check('solved.disabled 独立', sv.disabled.length === 1 && sv.disabled[0].id === 'E004', sv.disabled);
  check('solved 行无正文（轻量）', JSON.stringify(sv).indexOf('rootCause') === -1 && JSON.stringify(sv).indexOf('## 现象') === -1, '含正文字段');

  const ep = server.entryPayload('E001');
  check('entryPayload 命中全文', ep.ok === true && ep.text.indexOf('id: E001') !== -1 && ep.text.indexOf('## 对策') !== -1, ep.ok);
  const en = server.entryPayload('E099');
  check('entryPayload 未知编号', en.ok === false && en.error.indexOf('不存在') !== -1, en);
  const ex = server.entryPayload('C001');
  check('entryPayload 非法编号', ex.ok === false && ex.error.indexOf('非法') !== -1, ex);
  check('entryPayload 错误路径不写盘', fs.readdirSync(entriesDir).length === 4, fs.readdirSync(entriesDir));
  const rt = repo.readEntryText('E003');
  check('readEntryText 命中', rt !== null && rt.indexOf('E003') !== -1, rt);
  check('readEntryText 未知 → null', repo.readEntryText('E777') === null && repo.readEntryText('x') === null);

  const md = repo.buildIndexMd(repo.listEntries());
  check('INDEX 墙标题/分区', md.indexOf('# 鲸鱼小本本 · 已解决墙（INDEX）') === 0 && md.indexOf('## 🐳 全局区') !== -1 && md.indexOf('## 📁 项目区') !== -1 && md.indexOf('🛑 停用') !== -1, md.slice(0, 300));
  check('INDEX 墙统计行', md.indexOf('active 3（全局 1 + 项目级 2）') !== -1 && md.indexOf('停用 1') !== -1, md.split('\n')[3]);
  check('INDEX 墙项目分组计数', md.indexOf('### SandBox1（2）') !== -1 && md.indexOf('### wsB（1）') !== -1, md);
  check('INDEX 墙 rule 管道转义', md.indexOf('\\| 走 UTF-8 文件引用') !== -1, md.split('\n').filter((l) => l.indexOf('E001') !== -1)[0]);
  check('INDEX 墙空兜底', repo.buildIndexMd([]).indexOf('暂无 active 条目') !== -1, repo.buildIndexMd([]));

  // ---- B1：AGENTS 自动段只收 scope=global（project 级绝不进全局注入）+ 状态行提示 ----
  const body = agents.buildSectionBody(repo.listEntries(), {});
  check('agents 排除 project 条目', body.indexOf('【encoding】') !== -1 && body.indexOf('【data-access】') === -1 &&
    body.indexOf('python') === -1 && body.indexOf('stale-fs') === -1, body);
  check('agents 状态行含项目级计数', body.indexOf('项目级 2') !== -1 && body.indexOf('不进全局注入') !== -1, body.split('\n').filter((l) => l.indexOf('状态：') !== -1)[0]);
  const body2 = agents.buildSectionBody([{ status: 'active', scope: 'project', category: 'secret', rule: 'r', occurrences: 99, id: 'E9' }], {});
  check('agents 只有项目级时提示去向', body2.indexOf('暂无全局规则') !== -1 && body2.indexOf('INDEX.md') !== -1 && body2.indexOf('【secret】') === -1, body2.split('\n').filter((l) => l.indexOf('状态：') !== -1)[0]);


} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
