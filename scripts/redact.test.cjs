// redact.test.cjs - 打码回归测试: node redact.test.cjs
'use strict';
const { redact } = require('./mine.cjs');
let pass = 0, fail = 0;
function check(name, got, expectContains) {
  const ok = typeof got === 'string' && got.includes(expectContains);
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + ' => got: ' + got); }
}
function noLeak(name, got, secret) {
  const ok = typeof got === 'string' && !got.includes(secret);
  if (ok) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + ' => leaked: ' + got); }
}

check('github_pat', redact('key=github_pat_11AMOPDAA0nuzB2TrV0SAv_Q3oZiqtniF1r0kX'), '[REDACTED]');
noLeak('github_pat_no_leak', redact('token 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 end'), 'github_pat_11AMOPDAA0');
check('ghp', redact('ghp_abcdefghijklmnopqrstuvwxyz1234567890XYZ'), '[REDACTED]');
check('sk-', redact('sk-ABCDEF0123456789abcdefghijklmnop'), '[REDACTED]');
check('ak-suffix', redact('openai key: sk-proj-1234567890-abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
check('AKIA', redact('AKIAIOSFODNN7EXAMPLE'), '[REDACTED]');
check('password-kv', redact('password=superSecret123!'), '[REDACTED]');
check('long-token', redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), '[REDACTED]');
check('base64-long', redact('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='), '[REDACTED]');
check('home-path', redact('C:\\Users\\gengj\\AppData\\Local\\Temp\\x.txt'), '~');
check('quoted-file', redact('cannot write "C:\\DeepSeekHarnes\\SandBox1\\docs\\a.md"'), '<path>');
noLeak('real-pat-absent', redact('ok normal text with github token mention only'), 'github_pat');
check('normal-cjk-kept', redact('命令行中文被破坏成 ???? 后写文件解决'), '????');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
