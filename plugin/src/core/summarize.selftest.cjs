// core/summarize.selftest.cjs - 现象一句话精炼纯函数单测
// 运行: node src/core/summarize.selftest.cjs （退出码 0 = 全过）
'use strict';
const { oneLiner } = require('./summarize.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); }
}

// 1) 堆栈行滤除 + Error: 前缀剥离
const s1 = oneLiner("Error: EPERM: operation not permitted, mkdir 'C:\\x'\n    at Object.mkdirSync (fs.js:1148:12)\n    at Module._compile (internal/modules/cjs/loader.js:1:1)");
check('堆栈滤除+前缀剥离', s1 === "EPERM: operation not permitted, mkdir 'C:\\x'", s1);

// 2) 引导行与实质行拼接（冒号结尾 → 空格连接）
const s2 = oneLiner('Command failed with exit code 1:\nnode scripts/build.mjs\n    at x (y.js:1)');
check('引导行拼接', s2 === 'Command failed with exit code 1: node scripts/build.mjs', s2);

// 3) 超长在中文标点断点截断并加 …
const s3 = oneLiner('A'.repeat(50) + '，' + 'B'.repeat(50), 60);
check('句界截断+省略号', s3.length === 52 && s3.endsWith('…') && s3.indexOf('，') === 50, s3);

// 4) 无断点超长硬截断
const s4 = oneLiner('x'.repeat(200), 60);
check('无断点硬截断', s4.length <= 61 && s4.endsWith('…'), s4);

// 5) 短句保真（≤max 不做任何改动）
const s5 = oneLiner('EPERM: operation not permitted', 90);
check('短句保真', s5 === 'EPERM: operation not permitted', s5);

// 6) 空/空白输入兜底
check('空输入兜底', oneLiner('') === '(无文本)', oneLiner(''));
check('空白输入兜底', oneLiner('   \n  ') === '(无文本)', oneLiner('   \n  '));

// 7) 全堆栈兜底不抛错且非空
const s7 = oneLiner('    at a (b.js:1)\n    at c (d.js:2)');
check('全堆栈兜底非空', typeof s7 === 'string' && s7.length > 0, s7);

// 8) 中文/打码文本不被破坏
const s8 = oneLiner('编辑工具报 old_string not found：同文件连环失败（文件被并发改动）', 90);
check('中文保真', s8.indexOf('old_string not found') !== -1 && s8.indexOf('文件被并发改动') !== -1, s8);

// 9) 输出长度上限协议
check('输出不超过 max', oneLiner('很长的内容：' + '很长很长的补充描述文字内容 '.repeat(20), 90).length <= 91);

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
