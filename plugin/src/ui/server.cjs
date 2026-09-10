// src/ui/server.cjs - 决策箱面板 host API（纯逻辑层；http 适配在 lib/index.js）
// 规则：列表解析复用 viewmodel（inbox 行格式不变式）；删除 = 移入当日归档（可恢复）
//       + 从 inbox 移除（与入库/忘掉的既有归档语义同构），detail sidecar 随行归档；
//       详情读取只读本地 details/C###.md，绝不触碰 entries 与 AGENTS。
'use strict';
const fs = require('fs');
const repo = require('../store/repo.cjs');
const { inboxViewModel, solvedViewModel } = require('./viewmodel.cjs');
const { similarity, DEFAULT_THRESHOLDS } = require('../core/similarity.cjs');

const ID_RE = /^C\d{3}$/;
const EID_RE = /^E\d{3}$/;

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
function deleteCandidate({ id, now }) {
  if (!ID_RE.test(id)) return { ok: false, error: `非法编号: ${id}（应为 C###）` };
  const text = repo.readInboxText();
  let line = null;
  for (const l of text.split('\n')) {
    if ((l.match(/^\| (C\d+) /) || [])[1] === id) { line = l; break; }
  }
  if (line === null) return { ok: false, error: `inbox 中不存在候选 ${id}` };
  ensureArchiveDir();
  const stamp = localStamp(now || new Date());
  // 归档行 = 候选原文 + 处置列（对齐 archive-*.md 的 7 列表头；archiveInboxRows 自补换行）
  repo.archiveInboxRows(`${line.replace(/\r?$/, '')} | 面板删除 ${stamp}`);
  const { removed } = repo.removeInboxRows([id]);
  if (removed !== 1) return { ok: false, error: `写入失败：${id} 未能从 inbox 移除` };
  return { ok: true, removed, id, archived: true };
}

module.exports = { ID_RE, EID_RE, localStamp, ensureArchiveDir, listPayload, detailPayload, deleteCandidate, solvedPayload, entryPayload, relatedPayload };
