// src/ui/server.cjs - 决策箱面板 host API（纯逻辑层；http 适配在 lib/index.js）
// 规则：列表解析复用 viewmodel（inbox 行格式不变式）；删除 = 移入当日归档（可恢复）
//       + 从 inbox 移除（与入库/忘掉的既有归档语义同构），detail sidecar 随行归档；
//       详情读取只读本地 details/C###.md，绝不触碰 entries 与 AGENTS。
'use strict';
const fs = require('fs');
const repo = require('../store/repo.cjs');
const { inboxViewModel, solvedViewModel } = require('./viewmodel.cjs');

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
function listPayload() {
  const vm = inboxViewModel();
  return { ok: true, pending: vm.pending, rows: vm.rows };
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

module.exports = { ID_RE, EID_RE, localStamp, ensureArchiveDir, listPayload, detailPayload, deleteCandidate, solvedPayload, entryPayload };
