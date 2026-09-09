// collector/scanner.cjs - 单个会话文件的失败/特征事件抽取（只读）
'use strict';
const path = require('path');
const { decodeLines, textOf } = require('./decoder.cjs');
const { PATTERNS, NARRATION_IDS } = require('./patterns.cjs');

const COMMAND_TOOLS = ['pwsh', 'bash', 'node', '?'];
// 命令类工具成功结果的自引用排除（mine/统计/inbox 文本含类别词，不能当新发现）
const SELF_REF = /whale-notebook|mine\.cjs|--check|--stats|--prewarm|whale notebook|次 \| 工作区|inbox\.md|\| C\d\d+/;
// 系统框架/长叙述排除（AGENTS 注入、技能目录、技能正文、审核清单等）
const FRAME_RE = /system-reminder|Current runtime context|Instructions from:|workspace instructions|whale-notebook:rules|skill_content|available_skills|whale-notebook|小本本|复盘|候选|拟规则|E0\d\d/;
const STRONG_USER = /编码|乱码|报错|失败|坑|EPERM|拒绝|超时|token|密钥/;

function collectEvents(file) {
  const lines = decodeLines(file);
  const sid = path.basename(path.dirname(file));
  const wsDir = path.dirname(path.dirname(file));
  let wsName = path.basename(wsDir).replace(/^--|--$/g, '');
  const out = []; // { at, cat, tool, text, ws, sid }
  const callName = {};
  for (const line of lines) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (!r || typeof r !== 'object') continue;
    if (r.type === 'session' && r.cwd) {
      const segs = String(r.cwd).split(/[\\/]/).filter(Boolean);
      if (segs.length) wsName = segs[segs.length - 1];
    } else if (r.type === 'tool/call') {
      const cid = r.data && r.data.callId;
      if (cid) callName[cid] = r.data.name;
    } else if (r.type === 'tool/result') {
      const content = r.data && r.data.message && r.data.message.content;
      let isError = false, text = '';
      let callId = (r.data && r.data.message && r.data.message.source && r.data.message.source.callId) || null;
      if (Array.isArray(content)) for (const c of content) {
        if (c && c.type === 'tool-result') {
          if (c.isError) isError = true;
          if (Array.isArray(c.content)) for (const cc of c.content) if (cc && cc.type === 'text') text += cc.text;
        }
      }
      const tool = (callId && callName[callId]) || '?';
      if (isError && text.trim()) {
        out.push({ at: r.time, cat: 'error', tool, text: text.trim(), ws: wsName, sid });
      } else if (text.trim() && COMMAND_TOOLS.includes(tool)) {
        // read/grep 等结果内嵌文件内容，不参与特征扫描
        const flat = text.replace(/\s+/g, ' ').trim();
        const hit = !SELF_REF.test(flat) && PATTERNS.find((p) => p.re.test(flat) && !/Found \d+ matches|\.Contains\(|workspace instructions/i.test(flat.slice(0, 200)));
        if (hit && !/^\s*\{/.test(flat) && flat.length < 4000) {
          out.push({ at: r.time, cat: hit.id, tool, text: flat.slice(0, 500), ws: wsName, sid });
        }
      }
    } else if (r.type === 'user/message') {
      // v2.0 政策：叙述类只收【真实用户报障】(强关键词 + 短文本)。
      // 助手叙述(回声/元讨论)与长文一律不收——助手叙述多为对工具证据的复述，且
      // “讨论采集机制本身”的会话会产生自引用回声(实测 C013~C015 案例)。
      const t = textOf(r.data && r.data.content);
      const flat = t.replace(/\s+/g, ' ').trim();
      if (!flat) continue;
      if (FRAME_RE.test(flat.slice(0, 300))) continue;
      const hit = PATTERNS.find((p) => NARRATION_IDS.includes(p.id) && p.re.test(flat));
      if (hit && STRONG_USER.test(flat.slice(0, 120)) && flat.length > 12 && flat.length <= 400) {
        out.push({ at: r.time, cat: hit.id, tool: 'user/message', text: flat.slice(0, 400), ws: wsName, sid });
      }
    }
  }
  return out;
}

module.exports = { collectEvents };
