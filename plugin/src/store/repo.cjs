// store/repo.cjs - 数据访问层（单一事实源）
// v1 数据文件路径与格式是不变式（AGENTS/skill/历史脚本依赖）；本模块是所有读写入口，
// 未来换 sqlite/远程存储只改这里。写文件尽量走原子替换。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const NB_DIR = process.env.DSH_WHALE_NB_DIR || path.join(HOME, 'whale-notebook');
const SESSIONS_ROOT = path.join(HOME, 'sessions');

const P = {
  sessions: SESSIONS_ROOT,
  nb: NB_DIR,
  inbox: path.join(NB_DIR, 'inbox.md'),
  state: path.join(NB_DIR, 'state.json'),
  settings: path.join(NB_DIR, 'settings.json'),
  entries: path.join(NB_DIR, 'entries'),
  archive: path.join(NB_DIR, 'archive'),
  details: path.join(NB_DIR, 'details'),
  index: path.join(NB_DIR, 'INDEX.md'),
  agents: path.join(HOME, 'AGENTS.md'),
};

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function writeJson(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// ---- settings ----
function readSettings() { return readJson(P.settings, {}); }

// ---- state ----
function emptyState() { return { lastScan: 0, seenFingerprints: [], nextCandidateId: 1 }; }
function readState() { return readJson(P.state, emptyState()); }
function writeState(state) { writeJson(P.state, state); }

// ---- inbox ----
function readInboxText() { return fs.existsSync(P.inbox) ? fs.readFileSync(P.inbox, 'utf8') : ''; }
function pendingCount(text) { return (text.match(/^\| C\d+ /gm) || []).length; }
function appendInboxRows(rowsText) {
  const old = readInboxText();
  const body = old.trimEnd();
  const sep = body ? '\n' : '';
  fs.writeFileSync(P.inbox, body + sep + rowsText + '\n', 'utf8');
}
function initInboxIfMissing(headerText) {
  if (!fs.existsSync(P.inbox)) fs.writeFileSync(P.inbox, headerText + '\n', 'utf8');
}
// 从 inbox 移除指定 C 编号行；联动：被移除候选的 detail sidecar 移入 archive/details/（无源 no-op）。
// 面板删除 / 忘掉 / 入库移行全部收敛到本入口，保证 detail 与候选行同生命周期（归档不销毁）。
function removeInboxRows(ids) {
  const text = readInboxText();
  const set = new Set(ids);
  const kept = [];
  const gone = [];
  for (const l of text.split('\n')) {
    const m = l.match(/^\| (C\d+) /);
    if (m && set.has(m[1])) gone.push(m[1]);
    else kept.push(l);
  }
  const removed = gone.length;
  if (removed) fs.writeFileSync(P.inbox, kept.join('\n'), 'utf8');
  for (const id of gone) archiveDetail(id);
  return { removed };
}
// 追加归档
function archiveInboxRows(rowsText) {
  const name = `archive-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`;
  const file = path.join(P.archive, name);
  fs.appendFileSync(file, (fs.existsSync(file) ? '' : '# 归档\n\n| 编号 | 类别 | 次数 | 工作区 | 现象（已打码） | 时间 | 处置 |\n|---|---|---|---|---|---|---|\n') + rowsText + '\n', 'utf8');
}

// ---- candidate details（v0.3 sidecar：details/C###.md，随候选行同生命周期）----
// 内容协议见 collector/engine.cjs buildDetailMd：一句话 + 类别/次数 + 源引用 + 打码摘录。
function detailFilePath(id) { return path.join(P.details, id + '.md'); }
function writeDetail(id, md) {
  if (!/^C\d{3}$/.test(id) || typeof md !== 'string') return false;
  if (!fs.existsSync(P.details)) fs.mkdirSync(P.details, { recursive: true });
  const file = detailFilePath(id);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, md, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}
function readDetail(id) {
  if (!/^C\d{3}$/.test(id)) return null;
  const file = detailFilePath(id);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
// 候选行移出 inbox（删除/入库/忘掉）时调用：detail → archive/details/（保留可查，不销毁）
function archiveDetail(id) {
  const src = detailFilePath(id);
  if (!fs.existsSync(src)) return false;
  const dir = path.join(P.archive, 'details');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  let dst = path.join(dir, id + '.md');
  if (fs.existsSync(dst)) dst = path.join(dir, `${id}-${Date.now()}.md`);
  fs.renameSync(src, dst);
  return true;
}

// ---- entries ----
// 扫描 entries/*.md 的 frontmatter（最小解析，字段协议见 schema）
function listEntries() {
  if (!fs.existsSync(P.entries)) return [];
  const out = [];
  for (const f of fs.readdirSync(P.entries)) {
    if (!f.endsWith('.md')) continue;
    const p = path.join(P.entries, f);
    let raw;
    try { raw = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const fm = {};
    const m = raw.match(/^---\n([\s\S]*?)\n---/);
    if (m) for (const line of m[1].split('\n')) {
      const kv = line.match(/^([A-Za-z]+):\s*(.*)$/);
      if (kv) fm[kv[1]] = kv[2];
    }
    out.push({
      file: p,
      id: fm.id || f.replace(/\.md$/, ''),
      title: fm.title || '',
      category: fm.category || 'other',
      status: fm.status || 'active',
      occurrences: parseInt(fm.occurrences, 10) || 1,
      firstSeen: fm.firstSeen || '',
      lastSeen: fm.lastSeen || '',
      rule: fm.rule || '',
      workspaces: String(fm.workspaces || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean),
      updated: fm.updated || fm.created || '',
    });
  }
  out.sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return out;
}
function nextEntryId(entries) {
  let max = 0;
  for (const e of entries) { const n = parseInt(String(e.id).replace(/^E/, ''), 10); if (n > max) max = n; }
  return 'E' + String(max + 1).padStart(3, '0');
}

// ---- INDEX.md（重建入口，内容规范与 skill 一致）----
function buildIndexMd(entries) {
  const active = entries.filter((e) => e.status === 'active');
  const byCat = {};
  for (const e of active) (byCat[e.category] = byCat[e.category] || []).push(e);
  const L = [];
  L.push('# 鲸鱼小本本 · 经验索引（INDEX）');
  L.push('');
  L.push(`> 生成时间: ${new Date().toISOString().slice(0, 10)} ｜ 条目总数: ${active.length}（另有 disabled ${entries.length - active.length}）`);
  L.push('');
  for (const [cat, list] of Object.entries(byCat).sort((a, b) => b[1].length - a[1].length)) {
    L.push(`## ${cat}（${list.length}）`);
    L.push('');
    L.push('| 编号 | 标题 | 次数 | 工作区 | 最近 |');
    L.push('|---|---|---|---|---|');
    for (const e of list) L.push(`| ${e.id} | ${e.title} | ${e.occurrences} | ${e.workspaces.slice(0, 3).join(',')} | ${e.lastSeen} |`);
    L.push('');
  }
  if (!active.length) L.push('（暂无 active 条目）');
  return L.join('\n') + '\n';
}

module.exports = {
  HOME, NB_DIR, P,
  readJson, writeJson,
  readSettings, readState, emptyState, writeState,
  readInboxText, pendingCount, appendInboxRows, initInboxIfMissing, removeInboxRows, archiveInboxRows,
  detailFilePath, writeDetail, readDetail, archiveDetail,
  listEntries, nextEntryId, buildIndexMd,
};
