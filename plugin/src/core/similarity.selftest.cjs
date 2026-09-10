// core/similarity.selftest.cjs - 同族判定纯函数单测（骨架/shingle/阈值/相容组）
// 运行: node src/core/similarity.selftest.cjs （退出码 0 = 全过）
'use strict';
const sim = require('./similarity.cjs');
let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
const { similarity, skeleton, bestFamily, thresholdFor } = sim;

// ---- 骨架归一化：易变部分必须被剥掉 ----
const A1 = "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 21000 ms";
const A2 = "fatal: unable to access 'https://github.com/x/y.git/': Failed to connect to github.com port 443 after 30512 ms";
check('骨架：端口/耗时/数字被归一', skeleton(A1) === skeleton(A2), [skeleton(A1), skeleton(A2)]);
check('骨架：IP/路径被归一',
  skeleton('connect to 140.82.114.3:443 failed at C:\\Users\\me\\repo\\a.txt') === skeleton('connect to 20.205.243.166:443 failed at C:\\Users\\you\\other\\b.txt'),
  [skeleton('connect to 140.82.114.3:443 failed at C:\\Users\\me\\repo\\a.txt')]);
check('骨架：时间戳被归一',
  skeleton('2026-09-10 12:10:46 timeout') === skeleton('2026-08-17 01:02:03 timeout'));
check('骨架：会话 id / uuid 被归一',
  skeleton('session-412db43e-84f3-4cd4-9022-ea015877549d failed') === skeleton('session-23230eaa-67f3-4617-8146-675c8a944cf5 failed'));

// ---- 同族：应当合并 ----
check('同族：同一命令不同耗时',
  similarity(A1, A2) >= 0.6, similarity(A1, A2));
check('同族：同一 git 坑的不同诊断片段（含度）',
  similarity('[stderr] ssh : Warning: Permanently added github.com', 'ssh : Warning: Permanently added github.com (ED25519) to the list of known hosts.') >= 0.6,
  similarity('[stderr] ssh : Warning: Permanently added github.com', 'ssh : Warning: Permanently added github.com (ED25519) to the list of known hosts.'));
check('同族：简洁版 vs 详细版（包含关系打折后仍达标）',
  similarity('remote: Permission to a/b.git denied to user', 'remote: Permission to a/b.git denied to user\nfatal: unable to access https://github.com/a/b.git') >= 0.6,
  similarity('remote: Permission to a/b.git denied to user', 'remote: Permission to a/b.git denied to user\nfatal: unable to access https://github.com/a/b.git'));
check('完全相同 = 1', similarity('old_string was not found in "x"', 'old_string was not found in "x"') === 1);

// ---- 不同族：不得误并 ----
check('不误并：端口占用 vs 文件占用',
  similarity('EADDRINUSE: address already in use :::3080', 'EBUSY: resource busy or locked, open file') < 0.6,
  similarity('EADDRINUSE: address already in use :::3080', 'EBUSY: resource busy or locked, open file'));
check('不误并：编码乱码 vs 沙箱拒绝',
  similarity('命令内联中文被控制台链路破坏成 ????', '[sandbox: file access denied under workspace-write mode]') < 0.6,
  similarity('命令内联中文被控制台链路破坏成 ????', '[sandbox: file access denied under workspace-write mode]'));
check('不误并：edit old_string 找不到 vs edit 需先读',
  similarity('old_string was not found in "src/a.ts"', 'edit requires reading "src/a.ts" first') < 0.6,
  similarity('old_string was not found in "src/a.ts"', 'edit requires reading "src/a.ts" first'));
check('短骨架不置 1（避免无信息文本乱命中）',
  similarity('timeout', 'timeout 120000 ms after retry') === 0, similarity('timeout', 'timeout 120000 ms after retry'));

// ---- 阈值与相容组 ----
check('同类阈值 0.6 / 跨类 0.8',
  thresholdFor('git-net', 'git-net') === 0.6 && thresholdFor('git-net', 'encoding') === 0.8, [thresholdFor('git-net', 'git-net'), thresholdFor('git-net', 'encoding')]);
check('相容组：net 组（git-net/timeout）按同类阈值', sim.catCompatible('git-net', 'timeout') === true && thresholdFor('git-net', 'timeout') === 0.6);
check('相容组：error 与任意类别相容', sim.catCompatible('error', 'encoding') === true);
check('相容组：sandbox 系列同类', sim.catCompatible('sandbox-file', 'sandbox-ep') === true && sim.catCompatible('sandbox-file', 'git-net') === false);
check('阈值可被 settings 覆盖', thresholdFor('git-net', 'encoding', { same: 0.5, cross: 0.9 }) === 0.9);

// ---- bestFamily ----
const families = [
  { key: 'f-git', cat: 'git-net', repr: "fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443" },
  { key: 'f-stale', cat: 'error', repr: 'old_string was not found in "src/a.ts"' },
];
check('bestFamily 命中同族', (bestFamily("fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 21000 ms", 'git-net', families) || {}).key === 'f-git',
  bestFamily("fatal: unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443 after 21000 ms", 'git-net', families));
check('bestFamily 跨类别（timeout→git 族）按同类阈值仍命中',
  (bestFamily("unable to access 'https://github.com/a/b.git/': Failed to connect to github.com port 443", 'timeout', families) || {}).key === 'f-git');
check('bestFamily 不匹配时返回 null',
  bestFamily('EADDRINUSE: address already in use :::3080', 'error', families) === null,
  bestFamily('EADDRINUSE: address already in use :::3080', 'error', families));

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
