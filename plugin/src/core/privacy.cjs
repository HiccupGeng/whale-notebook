// core/privacy.cjs - 隐私边界：打码 / 指纹哈希 / 文本规范化（唯一出口）
// 铁律：任何将要离开本机日志进入 inbox/entries/AGENTS/UI 的文本，必须经过本模块。
// v0.3：拆出 applyRules（纯规则变换，保留换行结构）+ 两个出口：
//   redact      = applyRules + 压白（**不含凭据的文本**字节级不变 —— canonText/指纹不变式依赖它；
//                 v0.7.4 新增的凭据规则只改含凭据的文本，故普通文本指纹不漂移）
//   redactLines = applyRules + 行内压白但保留换行（现象一句话 / detail 摘录需要行结构时用）
'use strict';
const path = require('path');
const os = require('os');

// 打码规则（纯字符串变换；不压缩空白）。改动规则会影响 canonText 指纹，须谨慎并同步测试。
// v0.7.4 补漏（安全审计 N1）：原规则对最常见的几类凭据无效 ——
//   ① Bearer/Basic 认证头：`[^"',;\s]{6,}` 不能跨空格，只吃掉 "Bearer"，令牌落在匹配外；
//   ② Cookie 头：关键词表里根本没有 cookie；
//   ③ snake_case 密钥名（AWS_SECRET_ACCESS_KEY / client_secret）：`\bsecret\b` 在下划线里没有词边界；
//   ④ URL 内凭据（https://u:pw@host、postgres://u:pw@host/db）：完全没有规则；
//   ⑤ 短前缀令牌（sk_live_/xoxb-/npm_/AIza/ya29./ghs_/glpat-）长度不足 48，长串兜底救不了。
// 新增规则一律放在旧规则之前，且只吃"凭据形态"的文本：不含凭据的文本输出逐字节不变（指纹不漂移）。
function applyRules(s) {
  // 1) 凭据头打码（Bearer/Basic/任意 scheme；Set-Cookie/Cookie 同理）
  //    值吃到行尾或下一个引号为止 —— 这样 `curl -H "Authorization: Bearer X" URL` 只吃掉凭据，
  //    不会把同一行后面的 URL 也一起吞掉（保留排障价值）
  s = s.replace(/((?:proxy-)?authorization|(?:set-)?cookie)\s*:[^\r\n"]*/gi, '$1: [REDACTED]');
  // 2) URL 内凭据 → 只保留 scheme 与 @
  s = s.replace(/([a-z][a-z0-9+.\-]*:\/\/)[^/\s:@]+:[^@\s/]+@/gi, '$1[REDACTED]@');
  // 3) 已知前缀令牌（含长度不足 48 的形态）
  s = s.replace(/\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g, '[REDACTED]');
  s = s.replace(/\bxox[bpoas]-[A-Za-z0-9-]{10,}/g, '[REDACTED]');
  s = s.replace(/\bnpm_[A-Za-z0-9]{30,}/g, '[REDACTED]');
  s = s.replace(/\bAIza[0-9A-Za-z_\-]{35}/g, '[REDACTED]');
  s = s.replace(/\bya29\.[0-9A-Za-z_\-]{20,}/g, '[REDACTED]');
  s = s.replace(/\bgh[sru]_[A-Za-z0-9]{30,}/g, '[REDACTED]');
  s = s.replace(/\bglpat-[A-Za-z0-9_\-]{20,}/g, '[REDACTED]');
  s = s.replace(/\bSG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}/g, '[REDACTED]');
  // 4) 既有规则（顺序与输出保持历史行为，指纹兼容）
  s = s.replace(/(github_pat_|ghp_|gho_|github_)[A-Za-z0-9_]{16,}/g, 'github_token:[REDACTED]');
  s = s.replace(/(sk|ak|rk)-[A-Za-z0-9_\-]{16,}/g, '[REDACTED]');
  s = s.replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]');
  s = s.replace(/\beyJ[A-Za-z0-9_\-]{20,}\.\S*/g, 'jwt:[REDACTED]');
  // 5) 密钥名 = 值（v0.7.4：去掉 \b，覆盖 snake_case 名；分隔符允许 JSON 的 `":"` 形态；值支持引号包裹与裸值）
  s = s.replace(
    /([A-Za-z0-9_]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|apikey|credential|authorization|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)(\s*["']?\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi,
    '$1$2[REDACTED]');
  // 6) 超长无空格 token(hex/base64 形态, 长度>=48)
  s = s.replace(/[A-Za-z0-9+/=]{48,}/g, '[REDACTED]');
  // 7) 本机用户目录 -> ~ (弱化个人路径)
  const homePath = path.join(os.homedir()).replace(/\\/g, '/');
  s = s.replace(new RegExp(homePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '~');
  s = s.replace(/[A-Za-z]:\\Users\\[^\\"'\s]+/g, '~');
  // 8) 绝对路径参数化（保留盘符形态信息同时去掉具体路径）
  s = s.replace(/[A-Za-z]:\\[^"'\s\\]+(?:\\[^"'\s\\]+)*/g, (m) => (m.includes('node_modules') ? '<path:node_modules>' : '<path>'));
  s = s.replace(/"([^"]*\.(?:ts|tsx|js|json|md|cs|cshtml|py|ps1|bat|config|yml|yaml|xml|db|sqlite|png|zip|html|css|txt))"/g, '"<file>"');
  return s;
}

// 历史行为（v1 不变式：canonText/指纹依赖其输出）：全部空白 -> 单空格
function redact(text) {
  return applyRules(String(text)).replace(/\s+/g, ' ').trim();
}

// v0.3：保留换行结构（行内空白压缩、多余空行折叠），供行级清洗/详情摘录使用
function redactLines(text) {
  return applyRules(String(text))
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

module.exports = { redact, redactLines, hash36, canonText };
