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

check('github_pat', redact('key=github_pat_11FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE'), '[REDACTED]');
noLeak('github_pat_no_leak', redact('token github_pat_11FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE end'), 'github_pat_11FAKEFAKE');
check('ghp', redact('ghp_abcdefghijklmnopqrstuvwxyz1234567890XYZ'), '[REDACTED]');
check('sk-', redact('sk-ABCDEF0123456789abcdefghijklmnop'), '[REDACTED]');
check('ak-suffix', redact('openai key: sk-proj-1234567890-abcdefghijklmnopqrstuvwxyz'), '[REDACTED]');
check('AKIA', redact('AKIAIOSFODNN7EXAMPLE'), '[REDACTED]');
check('password-kv', redact('password=superSecret123!'), '[REDACTED]');
check('long-token', redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'), '[REDACTED]');
check('base64-long', redact('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/='), '[REDACTED]');
check('home-path', redact('C:\\Users\\demo\\AppData\\Local\\Temp\\x.txt'), '~');
check('quoted-file', redact('cannot write "C:\\demo\\proj\\docs\\a.md"'), '<path>');
noLeak('real-pat-absent', redact('ok normal text with github token mention only'), 'github_pat');
check('normal-cjk-kept', redact('命令行中文被破坏成 ???? 后写文件解决'), '????');

// v0.7.4（安全审计 N1）：常见凭据形态全覆盖 —— 这几类在 v0.7.3 及之前全部漏网
const FAKE = 'ZZFAKEVALUEZZFAKEVALUE';
noLeak('bearer-no-leak', redact('curl -H "Authorization: Bearer ' + FAKE + '" https://api.example.com'), FAKE);
noLeak('basic-no-leak', redact('Authorization: Basic ' + FAKE), FAKE);
noLeak('cookie-no-leak', redact('Cookie: sessionid=' + FAKE + '; csrftoken=' + FAKE), FAKE);
noLeak('aws-secret-no-leak', redact('AWS_SECRET_ACCESS_KEY=' + 'A'.repeat(40)), 'A'.repeat(40));
noLeak('client-secret-no-leak', redact('{"client_secret":"' + FAKE + '"}'), FAKE);
noLeak('url-userinfo-no-leak', redact('fatal: could not read from https://user:' + FAKE + '@github.com/r.git'), FAKE);
noLeak('dsn-password-no-leak', redact('postgres://admin:' + FAKE + '@10.0.0.5:5432/db failed'), FAKE);
noLeak('stripe-no-leak', redact('sk_live_' + 'A'.repeat(24)), 'A'.repeat(24));
check('bearer-url-kept', redact('curl -H "Authorization: Bearer ' + FAKE + '" https://api.example.com'), 'https://api.example.com');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
