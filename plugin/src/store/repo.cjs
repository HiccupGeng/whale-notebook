// store/repo.cjs - 数据访问层（单一事实源）
// v1 数据文件路径与格式是不变式（AGENTS/skill/历史脚本依赖）；本模块是所有读写入口，
// 未来换 sqlite/远程存储只改这里。写文件尽量走原子替换。
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { categoryTitle, sortCategoryKeys } = require('../core/schema.cjs');

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
  archiveDetails: path.join(NB_DIR, 'archive', 'details'),
  details: path.join(NB_DIR, 'details'),
  index: path.join(NB_DIR, 'INDEX.md'),
  agents: path.join(HOME, 'AGENTS.md'),
};

function readJson(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
// v0.7.4（审计 N5）：临时文件名必须是"本进程独有" —— 只做 tmp+rename 不够，
//   两个进程共用 `x.tmp` 时会互相覆盖/交错写（后者 rename 还可能 ENOENT）。
let tmpSeq = 0;
function tmpNameFor(file) { tmpSeq = (tmpSeq + 1) % 100000; return `${file}.${process.pid}.${tmpSeq}.tmp`; }
function writeJson(file, obj) {
  const tmp = tmpNameFor(file);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
// 文件身份（CAS 判据）：size + mtimeMs 变了才认为"别人写过"
function statOf(file) {
  try { const st = fs.statSync(file); return { exists: true, size: st.size, mtimeMs: st.mtimeMs }; }
  catch { return { exists: false, size: -1, mtimeMs: -1 }; }
}
// v0.7.4 严格读（state 专用，审计 N19）：只有 ENOENT 才算"没有历史"，其余一律报错；
//   内容损坏先改名 .corrupt-<ts> 留证再抛 —— 绝不用空状态静默覆盖好文件。
function readJsonStrict(file, def) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return def;
    throw new Error(`${path.basename(file)} 读取失败（${(err && err.code) || (err && err.message) || 'unknown'}）；已中止，原文件未被覆盖`);
  }
  try { return JSON.parse(raw); }
  catch (err) {
    const bak = `${file}.corrupt-${Date.now()}`;
    let moved = false;
    try { fs.renameSync(file, bak); moved = true; } catch { /* 备份失败不掩盖原错误 */ }
    throw new Error(`${path.basename(file)} 内容损坏（${err.message}）；${moved ? '已备份为 ' + path.basename(bak) + '，' : ''}重跑一次即可用空状态重建`);
  }
}

// ---- settings ----
function readSettings() { return readJson(P.settings, {}); }
// v0.7.8：settings 的**严格读**（面板「自动收集」开关的写路径专用）。
//   为什么不能沿用 readSettings：它解析失败时静默返回 {} —— 面板一旦"读-改-写"就会把用户
//   其它开关（scanMode/liveCapture/maxDeferred…）整批吃掉。这里区分两种情形：
//     · 文件不存在（ENOENT）= 首次使用 → 返回 {}（与默认值等价）
//     · 内容损坏/不是对象   = 报错，且**不改名、不覆盖**（settings 只几百字节，改名备份只会让人更慌，
//       与 state 的 readJsonStrict 刻意不同）
function readSettingsStrict() {
  let raw;
  try { raw = fs.readFileSync(P.settings, 'utf8'); }
  catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`settings.json 读取失败（${(err && err.code) || (err && err.message) || 'unknown'}）；未做任何写入`);
  }
  let obj;
  try { obj = JSON.parse(raw); }
  catch (err) { throw new Error(`settings.json 内容损坏（${err.message}）；未做任何写入，请先修好再试`); }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('settings.json 顶层不是对象（应为 {...}）；未做任何写入，请先修好再试');
  }
  return obj;
}
// 原子替换（本进程独有 tmp + rename，见审计 N5）。
// v0.7.8：settings.json **按人读的样式写回**（2 空格缩进 + 结尾换行），不复用 state.json 的 1 空格机器样式。
//   实测动因：面板第一次切换会把用户手写的 2 空格文件重排成 1 空格 —— 键值一个不丢，但"点一下开关、
//   配置文件排版就变了"是没必要的副作用（这是用户会手动编辑的配置文件）。内容只改被切换的那个键：
//   其余键（含用户自己写的 `_comment` 说明）逐键原样保留。
function writeSettings(obj) {
  const tmp = tmpNameFor(P.settings);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, P.settings);
}

// ---- state ----
// v0.5 结构（旧 state.json 自动补齐，零迁移）：
//   files    : { "<会话日志绝对路径>": { size, mtimeMs, offset, frames, sid, ws } } ← 增量水位线
//   clusters : { "<聚簇哈希>": { cid, cat, text, n, first, last, reAddedAt, reAdds } } ← 跨轮次同坑合并
//   seenFingerprints：事件级指纹（防重读同一字节；按 maxFingerprints 截尾，不再无限增长）
// v0.6 追加：
//   deferred : { "<聚簇哈希>": { cat, text, n, first, last, ws[], refs[], excerpt, at } } ← 拉取式暂存摘要
//              （settings.autoAdd=false 时新发现只进这里，不写 inbox；mine.cjs --add 才入箱）
const STATE_VERSION = 2;
function emptyState() { return { v: STATE_VERSION, lastScan: 0, seenFingerprints: [], nextCandidateId: 1, files: {}, clusters: {}, deferred: {}, lastScanStats: null }; }
function normalizeState(s) {
  const out = (s && typeof s === 'object') ? s : {};
  if (!Array.isArray(out.seenFingerprints)) out.seenFingerprints = [];
  if (!Number.isFinite(out.nextCandidateId) || out.nextCandidateId < 1) out.nextCandidateId = 1;
  if (!out.files || typeof out.files !== 'object') out.files = {};
  if (!out.clusters || typeof out.clusters !== 'object') out.clusters = {};
  if (!out.deferred || typeof out.deferred !== 'object') out.deferred = {};
  if (!Number.isFinite(out.lastScan)) out.lastScan = 0;
  if (out.lastScanStats == null || typeof out.lastScanStats !== 'object') out.lastScanStats = null; // v0.7.5：扫描健康度
  out.v = STATE_VERSION;
  return out;
}
// 最近一次 readState 观察到的文件身份（每个进程内 read→write 都在同一同步块里，用模块级变量即可）；
// stateDiag 供 /whale/live 与测试观测"是否发生过合并 / 锁超时"（审计 N5/N19 的可观测性）。
let lastReadMeta = { exists: false, size: -1, mtimeMs: -1 };
const stateDiag = { merges: 0, lastMergeError: null, lockTimeouts: 0, lastLockError: null };
function readState() {
  const state = normalizeState(readJsonStrict(P.state, emptyState()));
  lastReadMeta = statOf(P.state);
  return state;
}
// 并发合并（审计 N5）：本进程 read→加工 期间，别的进程（宿主 live / 另一个 CLI）可能已写过 state；
// 旧写法 writeState 会把对方整段覆盖。这里比对 size+mtimeMs，变了就把磁盘那份并集合并后重放。
function pickWatermark(a, b) {
  if (!a) return b;
  if (!b) return a;
  if ((b.size || 0) !== (a.size || 0)) return (b.size || 0) > (a.size || 0) ? b : a;
  return (b.offset || 0) >= (a.offset || 0) ? b : a;
}
function mergeCounted(a, b) { // clusters / deferred 同键合并
  if (!a) return b;
  if (!b) return a;
  const na = a.n || 0, nb = b.n || 0;
  const base = nb > na ? b : a;
  const firsts = [a.first, b.first].filter((x) => Number.isFinite(x));
  return Object.assign({}, base, {
    n: Math.max(na, nb),
    first: firsts.length ? Math.min.apply(null, firsts) : base.first,
    last: Math.max(a.last || 0, b.last || 0),
    cid: (a.cid === undefined || a.cid === null) ? (b.cid === undefined ? null : b.cid) : a.cid,
  });
}
function mergeStates(disk, mine) {
  const out = normalizeState(disk);
  const b = normalizeState(mine);
  for (const k of Object.keys(b.files || {})) out.files[k] = pickWatermark(out.files[k], b.files[k]);
  for (const k of Object.keys(b.clusters || {})) out.clusters[k] = mergeCounted(out.clusters[k], b.clusters[k]);
  for (const k of Object.keys(b.deferred || {})) out.deferred[k] = mergeCounted(out.deferred[k], b.deferred[k]);
  const seen = [];
  const has = new Set();
  for (const f of [...(out.seenFingerprints || []), ...(b.seenFingerprints || [])]) {
    if (!has.has(f)) { has.add(f); seen.push(f); }
  }
  out.seenFingerprints = seen;
  out.nextCandidateId = Math.max(out.nextCandidateId || 1, b.nextCandidateId || 1);
  out.lastScan = Math.max(out.lastScan || 0, b.lastScan || 0);
  // 扫描健康度取"更新的一次"（v0.7.5）
  const aStats = out.lastScanStats;
  const bStats = b.lastScanStats;
  if (bStats && (!aStats || (bStats.at || 0) >= (aStats.at || 0))) out.lastScanStats = bStats;
  return out;
}
function writeState(state) {
  const cur = statOf(P.state);
  let next = state;
  if (lastReadMeta.exists && cur.exists && (cur.size !== lastReadMeta.size || cur.mtimeMs !== lastReadMeta.mtimeMs)) {
    try {
      next = mergeStates(readJsonStrict(P.state, emptyState()), state);
      stateDiag.merges++;
    } catch (err) {
      // 磁盘那份已损坏：readJsonStrict 已把它改名留证，这里直接落我们这份（数据更好）
      stateDiag.lastMergeError = err && err.message ? err.message : String(err);
      next = state;
    }
  }
  writeJson(P.state, next);
  lastReadMeta = statOf(P.state);
}

// ---- 跨进程写锁（v0.7.4，审计 N5）----
// CLI 扫描 / 宿主实时 flush / 面板删除都改同一批文件（state.json、inbox.md）。
// lock 文件用 'wx' 原子创建；>15s 的陈旧锁可回收（进程崩溃残留）。
function lockPath() { return P.state + '.lock'; }
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); return; } catch { /* 回退忙等 */ }
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin（仅无法 Atomics.wait 时；总时长仍受 waitMs 上限约束） */ }
}
function tryLock() {
  try {
    const fd = fs.openSync(lockPath(), 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fs.closeSync(fd);
    stateDiag.lastLockError = null;
    return true;
  } catch (err) {
    const code = (err && err.code) || 'UNKNOWN';
    stateDiag.lastLockError = code;
    if (code === 'EEXIST') {
      const st = statOf(lockPath());
      if (st.exists && Date.now() - st.mtimeMs > 15000) { try { fs.unlinkSync(lockPath()); } catch { /* 回收失败下次再试 */ } }
    }
    return false;
  }
}
function unlockState() { try { fs.unlinkSync(lockPath()); } catch { /* 已释放 */ } }
// EEXIST = 别人持锁（值得等）；其它错误（ENOENT=目录还没建、EACCES=权限）= 等也没用，立刻返回
function lockRetryable() { return stateDiag.lastLockError === 'EEXIST'; }
function acquireLockSync(waitMs = 1500) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryLock()) return unlockState;
    if (!lockRetryable()) { stateDiag.lockTimeouts++; return null; }
    if (Date.now() >= deadline) { stateDiag.lockTimeouts++; return null; }
    sleepSync(25);
  }
}
async function acquireLock(waitMs = 5000) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if (tryLock()) return unlockState;
    if (!lockRetryable()) { stateDiag.lockTimeouts++; return null; }
    if (Date.now() >= deadline) { stateDiag.lockTimeouts++; return null; }
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---- 维护窗口标记（v0.7.7，审计第 3 项）----
// 用途：`--rebuild` 这类"清派生状态后从头梳理"的动作期间，宿主侧实时采集要**让路但不能丢事件**。
//   为什么用独立小文件而不是写进 state.json：① live 每轮 flush 都要判断，读一个 ~120 字节的标记
//   比解析整个 state 便宜得多；② 不必给 state 加字段、也就不必改 CAS 合并语义（加字段的合并策略
//   一旦写错就会把"正在重建"这个状态丢掉）；③ 进程被强杀时靠 expiresAt 自愈，不依赖任何清理逻辑。
const MAINTENANCE_MAX_MS = 10 * 60 * 1000; // 标记最长有效 10 分钟（远超 rebuild 实测 5s，防写坏的超长值）
function maintenancePath() { return path.join(P.nb, '.maintenance.json'); }
// 读标记：不存在/损坏/已过期 → null（过期时顺手清理，读路径不做重活）
function readMaintenance(now) {
  const t = Number.isFinite(now) ? now : Date.now();
  let raw;
  try { raw = fs.readFileSync(maintenancePath(), 'utf8'); } catch { return null; }
  let m = null;
  try { m = JSON.parse(raw); } catch { m = null; }
  if (!m || typeof m !== 'object') return null;
  if (!Number.isFinite(m.expiresAt) || m.expiresAt <= t) { clearMaintenance(); return null; }
  return m;
}
function writeMaintenance(m) {
  if (!fs.existsSync(P.nb)) return false; // 数据目录不存在：不建目录，直接视为"无窗口"
  const now = Date.now();
  const obj = Object.assign({ kind: 'maintenance', pid: process.pid, startedAt: now }, m || {});
  if (!Number.isFinite(obj.expiresAt) || obj.expiresAt - now > MAINTENANCE_MAX_MS) obj.expiresAt = now + MAINTENANCE_MAX_MS;
  const tmp = tmpNameFor(maintenancePath());
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
    fs.renameSync(tmp, maintenancePath());
    return true;
  } catch { try { fs.unlinkSync(tmp); } catch { /* 清理失败无妨 */ } return false; }
}
function clearMaintenance() { try { fs.unlinkSync(maintenancePath()); return true; } catch { return false; } }

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
  const tmp = tmpNameFor(P.inbox);
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
  if (removed) writeInboxText(kept.join('\n')); // v0.7.4：与其它路径统一走原子替换（审计 N6）
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
// v0.7.6（回声自我放大治理 A1/A4）：
//   ① 追加前由 engine 用 readEchoSignatures() 去重（同签名不再落档）——本函数只负责"写"，不判判定；
//   ② 当日文件行数超上限时自动轮转 echo-YYYYMMDD-2.md（防止单文件无限增长）。
const ECHO_MAX_ROWS = 400;
const ECHO_DAY_RE = /^echo-(\d{8})(?:-(\d+))?\.md$/;
const ECHO_ROW_RE = /^\|\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*\|([^|]*)\|([^|]*)\|([^|]*)\|(.*)\|\s*$/;
function echoDay() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function echoFilesOf(day) {
  let names; try { names = fs.readdirSync(P.archive); } catch { return []; }
  const want = day || echoDay();
  return names.filter((n) => { const m = ECHO_DAY_RE.exec(n); return !!m && m[1] === want; }).sort();
}
// 归档行形态：`| 时间 | 类别 | 次数 | 工作区 | 现象（已打码） |` → 签名为「类别|现象」（与 engine.echoSig 同口径）
function readEchoSignatures(day) {
  const out = new Set();
  for (const name of echoFilesOf(day)) {
    let text; try { text = fs.readFileSync(path.join(P.archive, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const m = ECHO_ROW_RE.exec(line.trim());
      if (m) out.add(`${m[1].trim()}|${m[4].trim()}`);
    }
  }
  return out;
}
// 当日回声归档的行数（/whale/live 观测用：回声在不在长，一眼可见）
function echoStats() {
  const day = echoDay();
  const files = echoFilesOf(day);
  let rows = 0, bytes = 0;
  for (const name of files) {
    let text; try { text = fs.readFileSync(path.join(P.archive, name), 'utf8'); } catch { continue; }
    bytes += Buffer.byteLength(text, 'utf8');
    for (const line of text.split('\n')) if (ECHO_ROW_RE.test(line.trim())) rows++;
  }
  let totalFiles = 0, totalRows = 0;
  let names; try { names = fs.readdirSync(P.archive); } catch { names = []; }
  for (const name of names) {
    if (!ECHO_DAY_RE.test(name)) continue;
    totalFiles++;
    let text; try { text = fs.readFileSync(path.join(P.archive, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) if (ECHO_ROW_RE.test(line.trim())) totalRows++;
  }
  return { day, files: files.length, rows, bytes, totalFiles, totalRows, cap: ECHO_MAX_ROWS };
}
function appendEchoArchive(rowsText) {
  if (!rowsText) return false;
  if (!fs.existsSync(P.archive)) fs.mkdirSync(P.archive, { recursive: true });
  const day = echoDay();
  const add = rowsText.split('\n').filter((l) => ECHO_ROW_RE.test(l.trim())).length || 1;
  const files = echoFilesOf(day);
  let name = files.length ? files[files.length - 1] : `echo-${day}.md`;
  let file = path.join(P.archive, name);
  // 轮转：当日当前分片已满则开下一个分片（第 2 片起带 -N 后缀）
  let cur = 0;
  if (fs.existsSync(file)) {
    let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { /* 读不到就当空 */ }
    for (const line of text.split('\n')) if (ECHO_ROW_RE.test(line.trim())) cur++;
  }
  if (cur >= ECHO_MAX_ROWS) {
    const m = ECHO_DAY_RE.exec(name);
    const idx = m && m[2] ? parseInt(m[2], 10) + 1 : 2;
    name = `echo-${day}-${idx}.md`;
    file = path.join(P.archive, name);
  }
  const header = '# 自引用/探针回声（已过滤，未进待审箱）\n\n| 时间 | 类别 | 次数 | 工作区 | 现象（已打码） |\n|---|---|---|---|---|\n';
  fs.appendFileSync(file, (fs.existsSync(file) ? '' : header) + rowsText + '\n', 'utf8');
  return name;
}

// ---- candidate details（v0.3 sidecar：details/C###.md，随候选行同生命周期）----
// 内容协议见 collector/engine.cjs buildDetailMd：一句话 + 类别/次数 + 源引用 + 打码摘录。
function detailFilePath(id) { return path.join(P.details, id + '.md'); }
function writeDetail(id, md) {
  if (!/^C\d{3,}$/.test(id) || typeof md !== 'string') return false;
  if (!fs.existsSync(P.details)) fs.mkdirSync(P.details, { recursive: true });
  const file = detailFilePath(id);
  const tmp = tmpNameFor(file);
  fs.writeFileSync(tmp, md, 'utf8');
  fs.renameSync(tmp, file);
  return true;
}
function readDetail(id) {
  if (!/^C\d{3,}$/.test(id)) return null;
  const file = detailFilePath(id);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}
// v0.5：候选复发时在 sidecar 末尾追加一段记录（sidecar 不存在则 no-op，绝不新建）
function appendDetailNote(id, note) {
  if (!/^C\d{3,}$/.test(id) || typeof note !== 'string' || !note.trim()) return false;
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
  if (!/^E\d{3,}$/.test(id) || !fs.existsSync(P.entries)) return null;
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
    const gByCat = {};
    for (const e of global) (gByCat[e.category] = gByCat[e.category] || []).push(e);
    const order = sortCategoryKeys(Object.keys(gByCat)); // v0.7.3：与面板同一套排序契约（未登记类别排末尾）
    for (const cat of order) {
      const list = gByCat[cat].slice().sort(byNewest);
      L.push(`### ${categoryTitle(cat)}（${list.length}）`);
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
    for (const e of disabled.slice().sort(byNewest)) L.push(`| ${e.id} | ${esc(e.title)} | ${esc(categoryTitle(e.category))} | ${e.lastSeen} |`);
    L.push('');
  }
  return L.join('\n') + '\n';
}

module.exports = {
  HOME, NB_DIR, P, STATE_VERSION,
  readJson, writeJson, readJsonStrict, statOf, tmpNameFor, mergeStates, stateDiag,
  readSettings, readSettingsStrict, writeSettings, readState, emptyState, normalizeState, writeState,
  lockPath, acquireLock, acquireLockSync, unlockState,
  // v0.7.7：维护窗口标记（rebuild 期间实时采集让路但不丢事件）
  maintenancePath, readMaintenance, writeMaintenance, clearMaintenance, MAINTENANCE_MAX_MS,
  readInboxText, pendingCount, appendInboxRows, initInboxIfMissing, removeInboxRows, archiveInboxRows, appendEchoArchive,
  // v0.7.6（回声自我放大治理）：回声签名去重 + 健康度观测
  readEchoSignatures, echoStats, ECHO_MAX_ROWS,
  parseInboxRows, pendingIds, bumpInboxRows, writeInboxText,
  detailFilePath, writeDetail, readDetail, appendDetailNote, archiveDetail,
  listEntries, nextEntryId, readEntryText, buildIndexMd,
};
