// store/repo.cjs - 数据访问层（单一事实源）
// v1 数据文件路径与格式是不变式（AGENTS/skill/历史脚本依赖）；本模块是所有读写入口，
// 未来换 sqlite/远程存储只改这里。写文件尽量走原子替换。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { CATEGORY_TITLES } = require('../core/schema.cjs');

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
// v0.5 结构（旧 state.json 自动补齐，零迁移）：
//   files    : { "<会话日志绝对路径>": { size, mtimeMs, offset, frames, sid, ws } } ← 增量水位线
//   clusters : { "<聚簇哈希>": { cid, cat, text, n, first, last, reAddedAt, reAdds } } ← 跨轮次同坑合并
//   seenFingerprints：事件级指纹（防重读同一字节；按 maxFingerprints 截尾，不再无限增长）
const STATE_VERSION = 2;
function emptyState() { return { v: STATE_VERSION, lastScan: 0, seenFingerprints: [], nextCandidateId: 1, files: {}, clusters: {} }; }
function normalizeState(s) {
  const out = (s && typeof s === 'object') ? s : {};
  if (!Array.isArray(out.seenFingerprints)) out.seenFingerprints = [];
  if (!Number.isFinite(out.nextCandidateId) || out.nextCandidateId < 1) out.nextCandidateId = 1;
  if (!out.files || typeof out.files !== 'object') out.files = {};
  if (!out.clusters || typeof out.clusters !== 'object') out.clusters = {};
  if (!Number.isFinite(out.lastScan)) out.lastScan = 0;
  out.v = STATE_VERSION;
  return out;
}
function readState() { return normalizeState(readJson(P.state, emptyState())); }
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
// v0.5：待审行解析（行格式的唯一解析入口，viewmodel/engine 共用，避免两处正则漂移）
const INBOX_ROW_RE = /^\| (C\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/;
function parseInboxRows(text) {
  const src = text === undefined ? readInboxText() : String(text);
  return src.split('\n')
    .map((l) => l.match(INBOX_ROW_RE))
    .filter(Boolean)
    .map((m) => ({ id: m[1].trim(), cat: m[2].trim(), n: m[3].trim(), ws: m[4].trim(), text: m[5].trim(), time: m[6].trim() }));
}
function pendingIds(text) { return new Set(parseInboxRows(text).map((r) => r.id)); }
// 就地更新指定候选的「次数」列（只碰第 3 列，行内其余字节保持原样）
function bumpInboxRows(text, counts) {
  const get = (id) => (counts instanceof Map ? counts.get(id) : counts[id]);
  const lines = String(text).split('\n');
  let changed = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\| (C\d+) \|/);
    if (!m) continue;
    const n = get(m[1]);
    if (n === undefined || n === null) continue;
    const next = lines[i].replace(/^(\| C\d+ \| [^|]*\| )\d+( \|)/, `$1${n}$2`);
    if (next !== lines[i]) { lines[i] = next; changed++; }
  }
  return { text: lines.join('\n'), changed };
}
// 整文件原子替换（tmp + rename；批量追加/改次数走这一条，避免半写与多次写）
function writeInboxText(text) {
  const tmp = P.inbox + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, P.inbox);
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

// v0.5.1：自引用/探针回声落档（被过滤的候选不静默丢失，可事后审计）
function appendEchoArchive(rowsText) {
  if (!rowsText) return false;
  if (!fs.existsSync(P.archive)) fs.mkdirSync(P.archive, { recursive: true });
  const name = `echo-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.md`;
  const file = path.join(P.archive, name);
  fs.appendFileSync(file, (fs.existsSync(file) ? '' : '# 自引用/探针回声（已过滤，未进待审箱）\n\n| 时间 | 类别 | 次数 | 工作区 | 现象（已打码） |\n|---|---|---|---|---|\n') + rowsText + '\n', 'utf8');
  return true;
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
// v0.5：候选复发时在 sidecar 末尾追加一段记录（sidecar 不存在则 no-op，绝不新建）
function appendDetailNote(id, note) {
  if (!/^C\d{3}$/.test(id) || typeof note !== 'string' || !note.trim()) return false;
  const file = detailFilePath(id);
  if (!fs.existsSync(file)) return false;
  fs.appendFileSync(file, '\n' + note.replace(/\s+$/, '') + '\n', 'utf8');
  return true;
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
function parseList(v) {
  return String(v || '').replace(/^\[|\]$/g, '').split(',').map((s) => s.trim()).filter(Boolean);
}
// YAML 双引号字符串去包裹（含 \" 转义；数组/裸值原样返回）
function unquote(v) {
  const s = String(v || '');
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  return s;
}
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
      if (kv) fm[kv[1]] = unquote(kv[2]);
    }
    out.push({
      file: p,
      id: fm.id || f.replace(/\.md$/, ''),
      title: fm.title || '',
      category: fm.category || 'other',
      status: fm.status || 'active',
      scope: fm.scope === 'project' ? 'project' : 'global', // v0.4：缺省/旧条目 = global（零迁移）
      projects: parseList(fm.projects),                      // v0.4：scope=project 时的适用项目白名单
      occurrences: parseInt(fm.occurrences, 10) || 1,
      firstSeen: fm.firstSeen || '',
      lastSeen: fm.lastSeen || '',
      rule: fm.rule || '',
      workspaces: parseList(fm.workspaces),
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
// 按编号读条目文件全文（只读；E### 文件名 = id-slug.md）
function readEntryText(id) {
  if (!/^E\d{3}$/.test(id) || !fs.existsSync(P.entries)) return null;
  for (const f of fs.readdirSync(P.entries)) {
    if (!f.endsWith('.md')) continue;
    if (f === id + '.md' || f.startsWith(id + '-')) {
      try { return fs.readFileSync(path.join(P.entries, f), 'utf8'); } catch { return null; }
    }
  }
  return null;
}

// ---- INDEX.md（v0.4 语义升级为「已解决墙」：全局区/项目区 × 类别分组 + 停用收尾）----
// 轻口径：入库 = 已处理；项目级条目不进全局自动段（B1），在项目区按适用项目查阅。
function buildIndexMd(entries) {
  const active = entries.filter((e) => e.status === 'active');
  const disabled = entries.filter((e) => e.status !== 'active');
  const global = active.filter((e) => e.scope !== 'project');
  const proj = active.filter((e) => e.scope === 'project');
  const esc = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const byNewest = (a, b) => (String(b.lastSeen || '')).localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  const tableHeader = () => ['| 编号 | 标题 | 对策（rule） | 次数 | 最近 |', '|---|---|---|---|---|'];
  const L = [];
  L.push('# 鲸鱼小本本 · 已解决墙（INDEX）');
  L.push('');
  L.push('> 轻口径：入库 = 已处理（已有对策），未做复发验证。项目级条目（scope: project）按 B1 语义不进全局自动段，按项目在「项目区」查阅；处置史见 archive/。');
  L.push(`> 生成: ${new Date().toISOString().slice(0, 10)} ｜ active ${active.length}（全局 ${global.length} + 项目级 ${proj.length}）｜ 停用 ${disabled.length}`);
  L.push('');
  if (!active.length) {
    L.push('（暂无 active 条目——审核候选入库后，此处出现「已解决」内容）');
    return L.join('\n') + '\n';
  }
  L.push('## 🐳 全局区（适用所有工作区 · 对策经 AGENTS 自动段注入每个会话）');
  L.push('');
  if (!global.length) {
    L.push('（暂无全局条目）');
  } else {
    const catOrder = Object.keys(CATEGORY_TITLES);
    const gByCat = {};
    for (const e of global) (gByCat[e.category] = gByCat[e.category] || []).push(e);
    const order = catOrder.filter((c) => gByCat[c]).concat(Object.keys(gByCat).filter((c) => !catOrder.includes(c)));
    for (const cat of order) {
      const list = gByCat[cat].slice().sort(byNewest);
      L.push(`### ${CATEGORY_TITLES[cat] || cat}（${list.length}）`);
      L.push('');
      L.push(...tableHeader());
      for (const e of list) L.push(`| ${e.id} | ${esc(e.title)} | ${esc(e.rule)} | ${e.occurrences} | ${e.lastSeen} |`);
      L.push('');
    }
  }
  L.push('## 📁 项目区（项目级条目，按适用项目查阅 · 不进全局自动段）');
  L.push('');
  if (!proj.length) {
    L.push('（暂无项目级条目）');
  } else {
    const byWs = {};
    for (const e of proj) {
      const wss = (e.projects && e.projects.length) ? e.projects : ['?'];
      for (const ws of wss) (byWs[ws] = byWs[ws] || []).push(e);
    }
    for (const ws of Object.keys(byWs).sort()) {
      const list = byWs[ws].slice().sort(byNewest);
      L.push(`### ${ws}（${list.length}）`);
      L.push('');
      L.push(...tableHeader());
      for (const e of list) L.push(`| ${e.id} | ${esc(e.title)} | ${esc(e.rule)} | ${e.occurrences} | ${e.lastSeen} |`);
      L.push('');
    }
  }
  if (disabled.length) {
    L.push('## 🛑 停用（disabled · 曾入库后停用/忘掉）');
    L.push('');
    L.push('| 编号 | 标题 | 类别 | 最近 |');
    L.push('|---|---|---|---|');
    for (const e of disabled.slice().sort(byNewest)) L.push(`| ${e.id} | ${esc(e.title)} | ${esc(CATEGORY_TITLES[e.category] || e.category)} | ${e.lastSeen} |`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

module.exports = {
  HOME, NB_DIR, P, STATE_VERSION,
  readJson, writeJson,
  readSettings, readState, emptyState, normalizeState, writeState,
  readInboxText, pendingCount, appendInboxRows, initInboxIfMissing, removeInboxRows, archiveInboxRows, appendEchoArchive,
  parseInboxRows, pendingIds, bumpInboxRows, writeInboxText,
  detailFilePath, writeDetail, readDetail, appendDetailNote, archiveDetail,
  listEntries, nextEntryId, readEntryText, buildIndexMd,
};
