// core/privacy.cjs - 隐私边界：打码 / 指纹哈希 / 文本规范化（唯一出口）
// 铁律：任何将要离开本机日志进入 inbox/entries/AGENTS/UI 的文本，必须经过本模块。
'use strict';
const path = require('path');
const os = require('os');

function redact(text) {
  let s = String(text);
  // 1) 常见凭据模式
  s = s.replace(/(github_pat_|ghp_|gho_|github_)[A-Za-z0-9_]{16,}/g, 'github_token:[REDACTED]');
  s = s.replace(/(sk|ak|rk)-[A-Za-z0-9_\-]{16,}/g, '[REDACTED]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_\-]{20,}\.\S*/g, 'jwt:[REDACTED]');
  s = s.replace(/\b(password|passwd|pwd|secret|api[_-]?key|token|authorization)\b(["']?\s*[:=]\s*["']?)[^"',;\s]{6,}/gi, '$1$2[REDACTED]');
  // 2) 超长无空格 token(hex/base64 形态, 长度>=48)
  s = s.replace(/[A-Za-z0-9+/=]{48,}/g, '[REDACTED]');
  // 3) 本机用户目录 -> ~ (弱化个人路径)
  const homePath = path.join(os.homedir()).replace(/\\/g, '/');
  s = s.replace(new RegExp(homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\"'\s]+/g, '~');
  // 4) 绝对路径参数化（保留盘符形态信息同时去掉具体路径）
  s = s.replace(/[A-Za-z]:\\[^"'\s\\]+(?:\\[^"'\s\\]+)*/g, (m) => (m.includes('node_modules') ? '<path:node_modules>' : '<path>'));
  s = s.replace(/"([^"]*\.(?:ts|tsx|js|json|md|cs|cshtml|py|ps1|bat|config|yml|yaml|xml|db|sqlite|png|zip|html|css|txt))"/g, '"<file>"');
  return s.replace(/\s+/g, ' ').trim();
}

// FNV-1a 32bit -> base36（指纹去重用，不存原文）
function hash36(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 0x01000193) >>> 0; }
  return h.toString(36);
}

// 规范文本：打码 + 去标识（会话/uuid/goal）+ 截断，供聚簇/指纹
function canonText(text) {
  let s = redact(text).toLowerCase();
  s = s.replace(/session-[0-9a-f-]{30,}/g, '<sid>');
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  s = s.replace(/goal-[a-z0-9-]+/g, '<goal>');
  return s.slice(0, 90);
}

module.exports = { redact, hash36, canonText };
