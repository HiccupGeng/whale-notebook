// core/similarity.cjs - 「同族」判定：骨架归一化 + 字符 shingle 相似度（纯函数，零依赖）
// 用途（v0.7 家族合并 / 讨论会话的同族证据）：
//   把「同一个坑的不同变体」（不同 IP、端口、时间戳、行号、路径、字节数、详略不同）判为同一族，
//   从而① 采集阶段就合并成一条候选（而不是 13 条碎片）② 讨论某个候选时给出确定的同族清单。
// 口径：先 skeleton() 剥掉易变部分，再做字符 3-gram + 拉丁词的集合相似度（Jaccard 与包含度取较大者，
//   包含度打 0.9 折——短文本整体出现在长文本里通常就是同一坑，但不能满信）。
// 阈值：类别相同（含同组，如 git-net/timeout 视为 net；error 与任意类别视为相容）用 same（默认 0.6），
//   跨类别用 cross（默认 0.8，更保守）。全部可按 settings 调整，判定可复现、可解释、可写进断言。
'use strict';

const DEFAULT_THRESHOLDS = { same: 0.6, cross: 0.8 };
// 类别相容组：同组按 same 阈值比较（net 组 = 网络/超时/接口；sandbox* = 沙箱系列；error = 全类兜底）
const CAT_ALIAS = {
  'git-net': 'net', timeout: 'net', 'model-api': 'net',
  'sandbox-file': 'sandbox', 'sandbox-ep': 'sandbox',
  error: '*',
};
const MIN_SKELETON = 12; // 骨架太短（无信息量）时只认完全相等，避免乱命中

function catGroup(cat) { return CAT_ALIAS[cat] || cat || ''; }
function catCompatible(a, b) {
  const ga = catGroup(a); const gb = catGroup(b);
  return ga === gb || ga === '*' || gb === '*';
}
function thresholdFor(catA, catB, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  return catCompatible(catA, catB) ? (t.same ?? DEFAULT_THRESHOLDS.same) : (t.cross ?? DEFAULT_THRESHOLDS.cross);
}

// 骨架：剥掉易变部分，只留可比较的结构（大小写无关）
function skeleton(text) {
  let s = String(text == null ? '' : text).toLowerCase();
  s = s.replace(/session-[0-9a-f-]{20,}/g, ' <sid> ');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ' <uuid> ');
  s = s.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, ' <ip> ');                    // IPv4
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[t ]?\d{0,2}:?\d{0,2}:?\d{0,2}/g, ' <ts> '); // 日期/时间戳
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, ' <ts> ');
  s = s.replace(/\b\d+(?:\.\d+)?\s*(?:ms|sec|secs|seconds|bytes?|kb|mb|gb|files?|times?|runs?)\b/g, ' <num> ');
  s = s.replace(/[a-z]:\\[^\s"']*/gi, ' <path> ');                            // Windows 绝对路径
  s = s.replace(/(?:~|\.{1,2})?[\\/](?:[\w.\-]+[\\/])+[\w.\-]+/g, ' <path> '); // 相对路径
  s = s.replace(/:\d{2,5}\b/g, ':<n>');                                       // 端口/行列号后缀
  s = s.replace(/\b\d{2,}\b/g, ' <n> ');                                      // 其余长数字
  s = s.replace(/[^\p{L}\p{N}<>]+/gu, ' ');                                   // 标点→空格
  return s.replace(/\s+/g, ' ').trim();
}

// 字符 3-gram 集合（语言无关：中英混排都能用）
function shingles(s, k = 3) {
  const out = new Set();
  const t = String(s == null ? '' : s);
  if (!t) return out;
  if (t.length <= k) { out.add(t); return out; }
  for (let i = 0; i + k <= t.length; i++) out.add(t.slice(i, i + k));
  return out;
}

function jaccard(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
function containment(A, B) {
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / Math.min(A.size, B.size);
}

// 相似度 0..1（两段文本；内部各自取骨架）
function similarity(textA, textB) {
  const sa = skeleton(textA); const sb = skeleton(textB);
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  if (sa.length < MIN_SKELETON || sb.length < MIN_SKELETON) return 0;
  const A = shingles(sa); const B = shingles(sb);
  return Math.max(jaccard(A, B), containment(A, B) * 0.9);
}

// families: [{ key, cat, repr }] → 返回最佳匹配 { key, score } 或 null
function bestFamily(text, cat, families, thresholds) {
  let best = null;
  for (const f of families || []) {
    const t = thresholdFor(cat, f.cat, thresholds);
    const s = similarity(text, f.repr);
    if (s >= t && (!best || s > best.score)) best = { key: f.key, score: Number(s.toFixed(3)) };
  }
  return best;
}

module.exports = {
  skeleton, shingles, jaccard, containment, similarity, bestFamily,
  catGroup, catCompatible, thresholdFor, DEFAULT_THRESHOLDS, CAT_ALIAS, MIN_SKELETON,
};
