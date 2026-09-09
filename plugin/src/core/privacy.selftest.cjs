// core/privacy.selftest.cjs - 打码出口单测（redact 历史行为不变式 + redactLines 结构保留）
// 运行: node src/core/privacy.selftest.cjs （退出码 0 = 全过）
'use strict';
const { redact, redactLines, canonText, hash36 } = require('./privacy.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}

// redact：压白不变式（v1 行为，指纹依赖）
check('redact 压白', redact('A\n  B \tC\r\nD') === 'A B C D', redact('A\n  B \tC\r\nD'));
check('redact 密钥打码先行', redact('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef 保留') === 'token=[REDACTED] 保留', redact('token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef 保留'));
check('redact 用户目录弱化', redact("mkdir '" + process.env.USERPROFILE + "\\proj'").indexOf('Users\\') === -1 && redact("mkdir 'C:\\Users\\someone\\proj'").indexOf('someone') === -1, redact("mkdir 'C:\\Users\\someone\\proj'"));

// redactLines：保留换行结构 + 行内压白 + 空行折叠
check('redactLines 保留换行', redactLines('L1\n  L2\twith   spaces\nL3') === 'L1\nL2 with spaces\nL3', redactLines('L1\n  L2\twith   spaces\nL3'));
check('redactLines 空行折叠', redactLines('A\n\n\n\nB') === 'A\n\nB', redactLines('A\n\n\n\nB'));
check('redactLines 密钥同样打码', redactLines('key: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\nok').indexOf('ghp_') === -1, redactLines('key: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef\nok'));

// canonText：稳定、去标识、90 截断
const c1 = canonText('错误 Error at C:\\Users\\someone\\a\\b Error: session-0123456789abcdef0123456789abcdef\n第二行');
check('canonText 压白去标识', c1.indexOf('someone') === -1 && c1.indexOf('session-') === -1 && c1.indexOf('\n') === -1, c1);
check('canonText 长度上限', canonText('x'.repeat(300)).length <= 90);
check('canonText 确定性', canonText('同一段 文本 abc 123') === canonText('同一段 文本 abc 123'));
check('hash36 确定', hash36('k1') === hash36('k1') && hash36('k1') !== hash36('k2'));

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
