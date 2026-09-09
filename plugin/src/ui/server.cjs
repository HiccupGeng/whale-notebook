// src/ui/server.cjs - 决策箱面板 host API（纯逻辑层；http 适配在 lib/index.js）
// 规则：列表解析复用 viewmodel（inbox 行格式不变式）；删除 = 移入当日归档（可恢复）
//       + 从 inbox 移除（与入库/忘掉的既有归档语义同构），绝不触碰 entries 与 AGENTS。
'use strict';
const fs = require('fs');
const repo = require('../store/repo.cjs');
const { inboxViewModel } = require('./viewmodel.cjs');

const ID_RE = /^C\d{3}$/;

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

module.exports = { ID_RE, localStamp, ensureArchiveDir, listPayload, deleteCandidate };
