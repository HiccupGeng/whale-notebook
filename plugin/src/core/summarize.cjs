// core/summarize.cjs - 现象「一句话」纯规则精炼（v0.3）
// 说明：待审行现象列 = oneLiner(工具失败/特征原文 redact 后)；只做结构性清洗与句界截断，
//       不做语义改写（无模型依赖）。输出协议：单句、≤max 字符、不含堆栈行与 Error: 前缀。
'use strict';

// 行级噪声：JS/Python 堆栈行、Traceback 引导行
const NOISE_LINE = /^(at |in |\(at |File "|Traceback|=== |----|Exception in thread )/;
const ERR_PREFIX = /^[Ee]rror\s*:?\s*/;

function oneLiner(raw, max = 90) {
  const lines = String(raw == null ? '' : raw)
    .replace(/\r/g, '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !NOISE_LINE.test(s))
    .map((s) => s.replace(ERR_PREFIX, ''))
    .filter(Boolean);
  // 组合前两行（首行常为 "Command failed: …" 类引导，第二行才有实质内容）
  let out = lines[0] || '';
  if (lines.length > 1 && out.length < 40 && !/…$/.test(out)) {
    out += (out.endsWith(':') ? ' ' : '；') + lines[1];
  }
  out = out.replace(/\s+/g, ' ').trim();
  if (!out) {
    // 全噪声兜底：原样压白取前 max
    out = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!out) return '(无文本)';
    return out.length > max ? out.slice(0, max) + '…' : out;
  }
  if (out.length <= max) return out;
  const cut = out.slice(0, max);
  const breakers = ['，', '。', '；', '、', '：', '！', '？', ',', ';', ':', '!', '?', ' '];
  let idx = -1;
  for (const b of breakers) {
    const i = cut.lastIndexOf(b);
    if (i > idx) idx = i;
  }
  const keep = idx >= max * 0.4 ? cut.slice(0, idx + 1) : cut;
  // 保留断点标点（更像完整句尾），仅去除截断处遗留的空白
  return keep.replace(/\s+$/, '').trim() + '…';
}

module.exports = { oneLiner };
