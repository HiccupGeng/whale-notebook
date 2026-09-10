// scripts/links-doctor.selftest.cjs - links-doctor 单测（临时夹具 + 真 junction，跑完自清）
// 运行: node scripts/links-doctor.selftest.cjs （退出码 0 = 全过；非 Windows 只报 SKIP）
// 夹具：real/（实体目录+文件）· valid（有效 junction）· dead（目标被删的悬空 junction）
//       scope/@x/dead2（嵌套悬空）· plain.txt（普通文件）· sessions/dead3（应被默认跳过）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { scanDangling, removeLinks, isUnder, parseArgs, main } = require('./links-doctor.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function junction(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  const r = spawnSync('cmd', ['/c', 'mklink', '/J', link, target], { windowsHide: true, encoding: 'utf8' });
  return r.status === 0;
}
function quiet(fn) { // 屏蔽 main() 的输出，只留断言
  const log = console.log;
  const err = console.error;
  const lines = [];
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { return { code: fn(), lines }; } finally { console.log = log; console.error = err; }
}
function linkExists(p) { // 悬空链接必须用 lstat（existsSync 会跟随 → 恒为 false，见 E005）
  try { fs.lstatSync(p); return true; } catch { return false; }
}

if (process.platform !== 'win32') {
  console.log('SKIP links-doctor.selftest（junction 仅 Windows 有意义）');
  process.exit(0);
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'links-doctor-selftest-'));
const root = path.join(base, 'home');
const store = path.join(base, 'store');
fs.mkdirSync(path.join(root, 'real'), { recursive: true });
fs.writeFileSync(path.join(root, 'real', 'keep.txt'), 'keep\n', 'utf8');
fs.writeFileSync(path.join(root, 'plain.txt'), 'plain\n', 'utf8');
fs.mkdirSync(path.join(root, 'sessions'), { recursive: true });

// 目标目录（用完即删 → 链接变悬空；这正是真实现场的成因：缓存被清、链接还在）
const tValid = path.join(store, 'valid-target');
const tDead = path.join(store, 'dead-target');
const tDead2 = path.join(store, 'dead2-target');
const tDead3 = path.join(store, 'dead3-target');
[tValid, tDead, tDead2, tDead3].forEach((d) => fs.mkdirSync(d, { recursive: true }));

const jValid = path.join(root, 'valid');
const jDead = path.join(root, 'dead');
const jDead2 = path.join(root, 'scope', '@x', 'dead2');
const jDead3 = path.join(root, 'sessions', 'dead3');
const made = [junction(jValid, tValid), junction(jDead, tDead), junction(jDead2, tDead2), junction(jDead3, tDead3)];
check('夹具：4 个 junction 建成', made.every(Boolean), made);
fs.rmdirSync(tDead);
fs.rmdirSync(tDead2);
fs.rmdirSync(tDead3); // 三条目标被删 → 悬空

// --- scanDangling：只认悬空链接，跳过 sessions，不跟随链接 ---
const s1 = scanDangling(root);
check('扫描根解析', s1.root === path.resolve(root), s1.root);
check('悬空数 = 2（dead + scope/@x/dead2，sessions 被跳过）', s1.dangling.length === 2, s1.dangling);
check('悬空名单正确', s1.dangling.join('|') === [jDead, jDead2].sort().join('|'), s1.dangling);
check('链接总数 = 3（有效 1 + 悬空 2；sessions 内不计）', s1.links === 3, s1.links);
check('实体目录被计入（real/scope/@x；sessions 被跳过故不计）', s1.realDirs === 3, s1.realDirs);
check('跳过项 = sessions', s1.skipped.length === 1 && path.basename(s1.skipped[0]) === 'sessions', s1.skipped);
check('悬空链接的判定陷阱：existsSync=false 而 lstat 可见', fs.existsSync(jDead) === false && linkExists(jDead) === true, [fs.existsSync(jDead), linkExists(jDead)]);
check('只读：扫描后悬空链接仍在', linkExists(jDead) && linkExists(jDead2));
check('只读：有效 junction 与其目标未动', fs.existsSync(jValid) && fs.existsSync(tValid) && fs.existsSync(path.join(tValid)));

// --- 深度限制：--depth 0 不递归（scope 下的悬空看不见） ---
const s0 = scanDangling(root, { depth: 0 });
check('depth=0 只扫顶层（只剩 dead 可见）', s0.dangling.length === 1 && s0.dangling[0] === jDead, s0.dangling);

// --- isUnder 守卫 ---
check('isUnder 根自身', isUnder(root, root) === true);
check('isUnder 子路径', isUnder(root, jDead2) === true);
check('isUnder 拒绝外部路径', isUnder(root, path.join(base, 'elsewhere')) === false);
check('isUnder 拒绝前缀伪装（home2 vs home）', isUnder(root, root + '2') === false);
check('isUnder 大小写不敏感（Windows）', isUnder(root.toUpperCase(), jDead) === true);

// --- removeLinks：根外一律不删；删除时目标与实体目录不许被碰 ---
const outside = tDead3; // 目标已被删，但不在 root 内 → 必须拒绝
const guarded = removeLinks([outside], { root });
check('根外路径被拒（outside-root）', guarded.removed.length === 0 && guarded.kept.length === 1 && guarded.kept[0].reason === 'outside-root', guarded.kept);

const del = removeLinks(s1.dangling, { root });
check('删除 2 条悬空链接', del.removed.length === 2 && del.failed.length === 0, del);
check('悬空链接已消失', !linkExists(jDead) && !linkExists(jDead2));
check('有效 junction 仍在', fs.existsSync(jValid));
check('有效 junction 目标未被删', fs.existsSync(tValid));
check('实体目录与文件未动', fs.existsSync(path.join(root, 'real', 'keep.txt')) && fs.existsSync(path.join(root, 'plain.txt')));
check('被跳过的 sessions/dead3 未被动', linkExists(jDead3));

// --- 幂等：复查为 0 ---
const s2 = scanDangling(root);
check('复查：悬空 = 0', s2.dangling.length === 0, s2.dangling);
check('复查：有效链接仍计 1', s2.links === 1, s2.links);

// --- removeLinks 复验：目标已被修复的链接不删 ---
const jFix = path.join(root, 'fixed');
const tFix = path.join(store, 'fixed-target');
fs.mkdirSync(tFix, { recursive: true });
check('夹具：fixed junction 建成', junction(jFix, tFix));
const repaired = removeLinks([jFix], { root });
check('目标可达的链接不删（target-resolves-now）', repaired.removed.length === 0 && repaired.kept[0].reason === 'target-resolves-now', repaired.kept);
check('目标可达的链接仍在', fs.existsSync(jFix));

// --- parseArgs ---
check('parseArgs 默认', parseArgs([]).apply === false && parseArgs([]).depth === 6);
check('parseArgs --apply/--json', parseArgs(['--apply', '--json']).apply === true && parseArgs(['--apply', '--json']).json === true);
check('parseArgs --depth=2', parseArgs(['--depth=2']).depth === 2);
check('parseArgs --root 值缺失即报错', typeof parseArgs(['--root']).error === 'string', parseArgs(['--root']));
check('parseArgs --depth 值缺失即报错', typeof parseArgs(['--depth']).error === 'string', parseArgs(['--depth']));
check('parseArgs 未知参数即报错', typeof parseArgs(['--nope']).error === 'string', parseArgs(['--nope']));

// --- CLI 退出码 ---
const danglingAgain = path.join(root, 'dead-again');
fs.mkdirSync(path.join(store, 'dead-again-target'), { recursive: true });
check('夹具：dead-again junction 建成', junction(danglingAgain, path.join(store, 'dead-again-target')));
fs.rmdirSync(path.join(store, 'dead-again-target'));
const dirty = quiet(() => main(['--root', root]));
check('CLI dry 发现悬空 → exit 3', dirty.code === 3, dirty.code);
check('CLI dry 输出含悬空清单', dirty.lines.some((l) => l.indexOf(danglingAgain) >= 0));
check('CLI dry 不删（链接仍在，用 lstat 判断）', linkExists(danglingAgain));
const applied = quiet(() => main(['--root', root, '--apply']));
check('CLI --apply 清干净 → exit 0', applied.code === 0, applied.code);
check('CLI --apply 后悬空消失', !linkExists(danglingAgain));
const clean = quiet(() => main(['--root', root]));
check('CLI 干净根 → exit 0', clean.code === 0, clean.code);
const bad = quiet(() => main(['--nope']));
check('CLI 非法参数 → exit 1', bad.code === 1, bad.code);
const missing = quiet(() => main(['--root', path.join(base, 'nope')]));
check('CLI 根不存在 → exit 1', missing.code === 1, missing.code);

// 清理夹具
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 目标已删的 junction 可能残留，忽略 */ }

console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
process.exit(fails === 0 ? 0 : 1);
