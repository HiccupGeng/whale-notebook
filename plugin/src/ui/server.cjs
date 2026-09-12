// src/ui/server.cjs - 决策箱面板 host API（纯逻辑层；http 适配在 lib/index.js）
// 规则：列表解析复用 viewmodel（inbox 行格式不变式）；删除 = 移入当日归档（可恢复）
//       + 从 inbox 移除（与入库/忘掉的既有归档语义同构），detail sidecar 随行归档；
//       详情读取只读本地 details/C###.md，绝不触碰 entries 与 AGENTS。
'use strict';
const fs = require('fs');
const repo = require('../store/repo.cjs');
const { inboxViewModel, solvedViewModel } = require('./viewmodel.cjs');
const { similarity, DEFAULT_THRESHOLDS } = require('../core/similarity.cjs');

// v0.7.4（审计 N23）：编号允许 3 位以上 —— 原来 `^C\d{3}$` 在编号过 999 后
//   会让详情写入静默失败、/whale/inbox/detail 与 /whale/inbox/delete 一律 400（面板删不掉候选）。
const ID_RE = /^C\d{3,}$/;
const EID_RE = /^E\d{3,}$/;

function pad(n) { return String(n).padStart(2, '0'); }
// 本地时间 'YYYY-MM-DD HH:mm'（+08 环境下的用户可读处置戳）
function localStamp(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ensureArchiveDir() {
  if (!fs.existsSync(repo.P.archive)) fs.mkdirSync(repo.P.archive, { recursive: true });
}

// GET /whale/inbox 数据：rows 形状与 viewmodel 一致（现象列已打码）
// v0.6：附带 deferred（拉取式下已暂存、尚未入箱的新发现组数），面板据此提示「回复小本本复盘入箱」
// v0.7：每行附带 variants（该候并由几个同族变体合并而成；=1 表示单变体），面板显示「族×N」小标
function variantCountByCid() {
  const state = repo.readState();
  const out = {};
  for (const h of Object.keys(state.clusters || {})) {
    const c = state.clusters[h];
    if (!c || !c.cid) continue;
    out[c.cid] = (out[c.cid] || 0) + 1;
  }
  return out;
}
function listPayload() {
  const vm = inboxViewModel();
  const state = repo.readState();
  const vc = variantCountByCid();
  const rows = vm.rows.map((r) => Object.assign({}, r, { variants: vc[r.id] || 1 }));
  return { ok: true, pending: vm.pending, rows, deferred: Object.keys(state.deferred || {}).length };
}

// ---- v0.7.8：面板「自动收集」开关（GET/POST /whale/settings）----
// 语义：settings.autoAdd ——
//   false = 拉取式：扫描照常（零 token）但新发现只写 state.deferred 暂存，说「小本本复盘」（mine.cjs --add）才入箱；
//   true  = 自动入箱：扫描/实时发现的问题直接写入待审箱。
//   缺键按默认 true —— 与 engine 的判定口径 `settings.autoAdd === false` 完全一致（不是"缺键=false"）。
// 写路径纪律（为什么值得单开一节）：
//   ① 用 readSettingsStrict 而不是 readSettings：后者解析失败静默返回 {}，一旦"读-改-写"会把用户
//      其它开关（scanMode/liveCapture/maxDeferred…）整批吃掉；损坏时这里**报错且一个字节都不写**。
//   ② 只动 settings.json —— 不碰 AGENTS.md（提醒句口径已在 inject/agents.cjs 内改成"以命令输出为准"
//      的双模式自述，所以切换开关不需要改写用户的全局记忆文件，也不会污染 lifecycle 的标记区基线）。
//   ③ 原子写（repo.writeSettings → writeJson：本进程独有 tmp + rename，见审计 N5）。
// 未知键一律拒绝：本版只开放 autoAdd，避免面板变成"偷偷改任意设置"的后门。
const SETTINGS_WRITABLE = ['autoAdd'];
function effectiveAutoAdd(s) { return (s && s.autoAdd) !== false; }
function settingsPayload() {
  const s = repo.readSettingsStrict();
  return {
    ok: true,
    autoAdd: effectiveAutoAdd(s),
    autoCollect: s.autoCollect !== false,
    liveCapture: s.liveCapture !== false,
    scanMode: s.scanMode === 'full' ? 'full' : 'incremental',
    writable: SETTINGS_WRITABLE.slice(),
  };
}
function updateAutoAdd(body) {
  const b = body || {};
  const unknown = Object.keys(b).filter((k) => SETTINGS_WRITABLE.indexOf(k) === -1);
  if (unknown.length) return { ok: false, code: 400, error: `本版只开放 ${SETTINGS_WRITABLE.join('/')}（收到未知键: ${unknown.join(', ')}）` };
  if (typeof b.autoAdd !== 'boolean') return { ok: false, code: 400, error: 'body 需含布尔 { autoAdd: true | false }' };
  let s;
  try { s = repo.readSettingsStrict(); }
  catch (err) { return { ok: false, code: 500, error: (err && err.message) || String(err) }; }
  const before = effectiveAutoAdd(s);
  const counts = () => ({
    pending: repo.pendingCount(repo.readInboxText()),
    deferred: Object.keys(repo.readState().deferred || {}).length,
  });
  if (before === b.autoAdd) return Object.assign({ ok: true, changed: false, autoAdd: before }, counts());
  s.autoAdd = b.autoAdd;
  try { repo.writeSettings(s); }
  catch (err) { return { ok: false, code: 500, error: `settings.json 写入失败：${(err && err.message) || String(err)}` }; }
  return Object.assign({ ok: true, changed: true, autoAdd: b.autoAdd }, counts());
}

// v0.7 GET /whale/related?id=C###：讨论某条候选时，程序给出确定依据（不靠模型猜测）
//   family   = 该候选所属族：由 state.clusters 里 cid 指向本行的全部聚簇构成（族合并的成员）
//   related  = 其它在箱候选里相似度 ≥0.35 的（降序，取前 5）——「还有类似的」这句话的确定性来源
//   entries  = 可能已被现有条目覆盖的（相似度 ≥0.25 或同类别），供入库前去重
function relatedPayload(id) {
  if (!ID_RE.test(id)) return { ok: false, error: `非法编号: ${id}（应为 C###）` };
  const rows = inboxViewModel().rows;
  const me = rows.find((r) => r.id === id);
  if (!me) return { ok: false, error: `候选 ${id} 不在待审箱（已处置？）` };
  const state = repo.readState();
  const clusters = state.clusters || {};
  const variants = Object.keys(clusters)
    .filter((h) => clusters[h] && clusters[h].cid === id)
    .map((h) => {
      const c = clusters[h];
      return {
        hash: h, cat: c.cat, n: c.n || 0, first: c.first || 0, last: c.last || 0,
        text: c.text || '', score: c.familyScore != null ? c.familyScore : 1,
      };
    })
    .sort((x, y) => (x.first || 0) - (y.first || 0));
  const related = rows
    .filter((r) => r.id !== id)
    .map((r) => ({ id: r.id, cat: r.cat, n: Number(r.n) || 0, ws: r.ws, text: r.text, score: Number(similarity(me.text, r.text).toFixed(2)) }))
    .filter((r) => r.score >= 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  const catOf = {};
  for (const v of variants) if (v.cat) catOf[v.cat] = true;
  const entries = repo.listEntries()
    .filter((e) => e.status === 'active')
    .map((e) => {
      const s = Math.max(similarity(me.text, `${e.title} ${e.rule}`), (catOf[e.category] || e.category === me.cat) ? 0.3 : 0);
      return { id: e.id, category: e.category, title: e.title, rule: e.rule, score: Number(s.toFixed(2)) };
    })
    .filter((e) => e.score >= 0.25)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return {
    ok: true,
    id,
    candidate: { id: me.id, cat: me.cat, n: me.n, ws: me.ws, text: me.text },
    family: { cid: id, size: variants.length, n: variants.reduce((s, v) => s + v.n, 0), variants },
    related,
    entries,
    thresholds: { same: DEFAULT_THRESHOLDS.same, cross: DEFAULT_THRESHOLDS.cross, related: 0.35, entry: 0.25 },
  };
}

// v0.4 GET /whale/solved：已解决墙聚合（轻口径：入库 = 已处理；只读 entries frontmatter）
// 形状与 solvedViewModel 一致：stats / global[] / projects[] / disabled[]
function solvedPayload() {
  return Object.assign({ ok: true }, solvedViewModel());
}

// v0.4 GET /whale/entry?id=E###：条目全文（只读 entries/ 文件；行展开详情用）
function entryPayload(id) {
  if (!EID_RE.test(id)) return { ok: false, error: `非法编号: ${id}（应为 E###）` };
  const text = repo.readEntryText(id);
  if (text === null) return { ok: false, error: `条目 ${id} 不存在（已删除？）` };
  return { ok: true, id, text };
}

// GET /whale/inbox/detail?id=C###：读候选详情 sidecar（只读本地文件；旧候选/已归档 → 无详情）
function detailPayload(id) {
  if (!ID_RE.test(id)) return { ok: false, error: `非法编号: ${id}（应为 C###）` };
  const md = repo.readDetail(id);
  if (md === null) return { ok: false, error: `候选 ${id} 暂无详情（旧候选未生成或已归档）` };
  return { ok: true, id, text: md };
}

// POST /whale/inbox/delete { id }：返回 {ok} 或 {ok:false, error}；未知编号不写盘（幂等安全）
// v0.7.4（审计 N5）：与 CLI 扫描/实时采集用同一把写锁 —— inbox.md 是读-改-写，
//   面板删除若与扫描并发，两边都会丢对方刚写的内容；拿不到锁就明说"请稍后重试"，不硬写。
function deleteCandidate({ id, now }) {
  if (!ID_RE.test(id)) return { ok: false, error: `非法编号: ${id}（应为 C###）` };
  const text = repo.readInboxText();
  let line = null;
  for (const l of text.split('\n')) {
    if ((l.match(/^\| (C\d+) /) || [])[1] === id) { line = l; break; }
  }
  if (line === null) return { ok: false, error: `inbox 中不存在候选 ${id}` };
  const release = repo.acquireLockSync(800);
  if (!release) return { ok: false, error: '采集正在写入（写锁忙），请稍后重试删除' };
  try {
    ensureArchiveDir();
    const stamp = localStamp(now || new Date());
    // 归档行 = 候选原文（去掉行尾 `|`）+ 处置列，严格对齐 archive-*.md 的 7 列表头
    // v0.7.3 修复：inbox 行本身以 `|` 结尾，旧写法直接续上 ` | 面板删除 …` → 表格多出一列、
    // 处置列显示为空、时间戳被挤到第 8 列（与入库路径 commit.cjs 写出的 7 列行不一致）。
    repo.archiveInboxRows(`${line.replace(/\s*\|?\s*$/, '')} | 面板删除 ${stamp} |`);
    const { removed } = repo.removeInboxRows([id]);
    if (removed !== 1) return { ok: false, error: `写入失败：${id} 未能从 inbox 移除` };
    return { ok: true, removed, id, archived: true };
  } finally {
    release();
  }
}

// v0.7.5（审计 N3/N4）：端点最小防护（纯函数，便于单测；HTTP 侧适配在 lib/index.js）
//   背景：8 个 /whale/* 端点无鉴权、无 Origin/Host 校验 —— 任意网页可对 127.0.0.1:3080
//   发跨站 POST 产生副作用（删候选、触发扫描），响应虽读不到但副作用已发生。
//   三道闸门（都不影响本机面板与 CLI/探针）：
//     ① Host 必须是回环地址 —— DNS rebinding 的正解是 Host 白名单（Sec-Fetch-Site 对同源重绑定无效）
//     ② Origin/Referer 若存在，必须是回环源 —— 挡住跨站发起
//     ③ 变更类请求必须 application/json —— 跨站"简单请求"（text/plain 等）就此失效，浏览器必发预检而我们不答 CORS
const LOOPBACK_HOSTNAME_RE = /^(?:127\.0\.0\.1|localhost|\[::1\]|::1)$/i;
function isLoopbackHostHeader(host) {
  const s = String(host || '').trim();
  if (!s) return true; // 无 Host 头（极少数裸 HTTP/1.0 客户端）：不因此拒绝
  return LOOPBACK_HOSTNAME_RE.test(s.replace(/:\d+$/, ''));
}
function originHostname(value) {
  try { return new URL(String(value)).hostname; } catch { return null; }
}
function guardRequest(input, opts) {
  const o = opts || {};
  const method = String((input && input.method) || 'GET').toUpperCase();
  const h = (input && input.headers) || {};
  if (!isLoopbackHostHeader(h.host)) {
    return { ok: false, code: 403, error: `已拒绝：Host=${String(h.host)} 不是回环地址（防 DNS rebinding）` };
  }
  const src = h.origin || h.referer;
  if (src) {
    const hn = originHostname(src);
    if (!hn || !LOOPBACK_HOSTNAME_RE.test(hn)) {
      return { ok: false, code: 403, error: `已拒绝：来源 ${hn || String(src).slice(0, 40)} 不是本机页面（防跨站请求）` };
    }
  }
  const sfs = String(h['sec-fetch-site'] || '').toLowerCase();
  if (sfs && sfs !== 'same-origin' && sfs !== 'none') {
    return { ok: false, code: 403, error: `已拒绝：Sec-Fetch-Site=${sfs}（跨站请求）` };
  }
  const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
  if (isWrite && o.requireJson !== false) {
    const ct = String(h['content-type'] || '').toLowerCase();
    if (ct.indexOf('application/json') !== 0) {
      return { ok: false, code: 415, error: '已拒绝：写操作必须 Content-Type: application/json（防跨站简单请求）' };
    }
  }
  return { ok: true };
}

module.exports = {
  ID_RE, EID_RE, localStamp, ensureArchiveDir, listPayload, detailPayload, deleteCandidate,
  solvedPayload, entryPayload, relatedPayload, guardRequest, isLoopbackHostHeader,
  // v0.7.8：面板开关（settings.autoAdd）
  SETTINGS_WRITABLE, effectiveAutoAdd, settingsPayload, updateAutoAdd,
};
