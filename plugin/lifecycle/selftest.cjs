// lifecycle/selftest.cjs - 生命周期端到端自测（沙盒: 临时 DSH home, 绝不触碰真实 ~/.dsh）
// 验收覆盖(设计文档 §13): 1 幂等 / 3 remove 后无残留且可恢复 / 4 purge 无导出+确认拒绝 / 5 中断可续(重跑幂等)
// 用法: node plugin/lifecycle/selftest.cjs   （退出码 0=全绿）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'cli.cjs');
const PKG = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
let TMP = null;

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}
function run(args, opts) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...(opts || {}) });
  return { status: r.status, text: (r.stdout || '') + (r.stderr || '') };
}
function expectExit(r, code, msg) {
  ok(r.status === code, `${msg} (exit=${r.status}, 期望=${code})`);
  return r;
}
function expectText(r, needle, msg) {
  ok(r.text.includes(needle), `${msg} [输出含「${needle}」]`);
}
function mkNb(home) {
  const nb = path.join(home, 'whale-notebook');
  fs.mkdirSync(path.join(nb, 'entries'), { recursive: true });
  fs.mkdirSync(path.join(nb, 'archive'), { recursive: true });
  fs.writeFileSync(path.join(nb, 'inbox.md'), '| 编号 | 类别 | 次数 | 工作区 | 现象（已打码） | 时间 |\n|---|---|---|---|---|---|\n| C001 | other | 1 | demo-ws | 示例行(打码) | 2026-09-09 |\n');
  fs.writeFileSync(path.join(nb, 'state.json'), '{}\n');
  fs.writeFileSync(path.join(nb, 'settings.json'), '{}\n');
  return nb;
}
function mkSeed(seedDir, skillText, agentsText) {
  fs.mkdirSync(seedDir, { recursive: true });
  if (skillText) fs.writeFileSync(path.join(seedDir, 'whale-notebook.md'), skillText);
  if (agentsText) fs.writeFileSync(path.join(seedDir, 'AGENTS.md'), agentsText);
}

const SKILL_SRC = '# whale-notebook 技能(自测种子)\n\n- 测试用 L2 技能内容。\n- 第一行\n';
const AGENTS_USER = '# 我的笔记（用户自有内容）\n\n手动段:\n- 用户规则A\n';
const AGENTS_WHOLE_SEED = '# 种子 AGENTS(whole)\n\n- 内容B\n';
// 模拟当前现场形态: 用户内容 + 规则区 + 区外隐私尾注(无 privacy 标记)
const AGENTS_ZONED = AGENTS_USER +
  '<!-- whale-notebook:rules -->\n\n## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）\n\n状态：无规则\n\n- 规则占位\n\n<!-- /whale-notebook:rules -->\n\n## 隐私提示\n\n- 写入需先展示确认。\n';

// ---- 附加检查: 清单标记与 schema.cjs AGENTS_MARK 不漂移 ----
function markerConsistency() {
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
  const schema = fs.readFileSync(path.join(PKG, 'src/core/schema.cjs'), 'utf8');
  const defAgents = manifest.entries.find((e) => e.id === 'agents');
  const rules = defAgents.zones.find((z) => z.label === '规则自动段');
  ok(schema.includes(rules.begin) && schema.includes(rules.end), '规则区标记与 src/core/schema.cjs AGENTS_MARK 一致');
}

// ================= F1: 全新机 whole 安装（模板创建/种子 skill/幂等/check） =================
function f1FreshInstall() {
  console.log('\n[F1] 全新机 whole 模式安装 + 幂等 + check');
  const home = path.join(TMP, 'f1-home');
  const seed = path.join(TMP, 'f1-seed');
  mkSeed(seed, SKILL_SRC, null);
  // nb 缺失 → 计划阻塞
  let r = run(['install', '--home', home, '--seed-dir', seed]);
  expectExit(r, 2, 'F1a 数据目录缺失被阻塞');
  expectText(r, '数据目录不存在', 'F1a');
  mkNb(home);
  // dry-run 出计划, 零写
  r = run(['install', '--home', home, '--seed-dir', seed]);
  expectExit(r, 0, 'F1b 完整计划(干跑)');
  expectText(r, 'dry-run', 'F1b 干跑未执行');
  ok(!fs.existsSync(path.join(home, 'AGENTS.md')), 'F1b 干跑零写(AGENTS 未创建)');
  // apply
  r = run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  expectExit(r, 0, 'F1c install --apply');
  const agents = fs.existsSync(path.join(home, 'AGENTS.md')) ? fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8') : '';
  ok(agents.includes('<!-- whale-notebook:rules -->'), 'F1c AGENTS 含 rules 标记');
  ok(agents.includes('<!-- whale-notebook:privacy -->'), 'F1c AGENTS 含 privacy 标记');
  ok(fs.readFileSync(path.join(home, 'skills/whale-notebook.md'), 'utf8') === SKILL_SRC, 'F1c skill 字节 = 种子');
  ok(fs.existsSync(path.join(home, 'whale-notebook/.lifecycle/manifest.json')), 'F1c 站点清单已落盘');
  // 幂等
  r = run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  expectExit(r, 0, 'F1d 二次 apply');
  expectText(r, '零文件改动(幂等)', 'F1d 二次 apply 零动作');
  // check
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F1e check 通过');
  expectText(r, 'check 通过', 'F1e');
}

// ================= F2: remove → 无残留 → 重装字节还原 =================
function f2RemoveReinstall() {
  console.log('\n[F2] remove(I 段) + 残留核对 + 重装字节等价');
  const home = path.join(TMP, 'f2-home');
  const seed = path.join(TMP, 'f2-seed');
  mkSeed(seed, SKILL_SRC, null);
  mkNb(home);
  run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  const agentsBefore = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  const skillBefore = fs.readFileSync(path.join(home, 'skills/whale-notebook.md'), 'utf8');
  const nbListBefore = fs.readdirSync(path.join(home, 'whale-notebook')).sort().join(',');
  // dry-run
  let r = run(['uninstall', 'remove', '--home', home]);
  expectExit(r, 0, 'F2a remove 干跑');
  expectText(r, 'dry-run', 'F2a 干跑未执行');
  ok(fs.existsSync(path.join(home, 'AGENTS.md')), 'F2a 干跑零写');
  // apply
  r = run(['uninstall', 'remove', '--apply', '--home', home]);
  expectExit(r, 0, 'F2b remove --apply');
  ok(!fs.existsSync(path.join(home, 'AGENTS.md')), 'F2b AGENTS 已删(whole)');
  ok(!fs.existsSync(path.join(home, 'skills/whale-notebook.md')), 'F2b skill 已删');
  const lc = path.join(home, 'whale-notebook/.lifecycle/backups');
  const snaps = fs.readdirSync(lc).filter((d) => fs.statSync(path.join(lc, d)).isDirectory());
  const files = snaps.flatMap((d) => fs.readdirSync(path.join(lc, d)));
  ok(files.includes('agents.bak') && files.includes('skill.bak'), 'F2b 快照已留档(agents+skill)');
  ok(fs.readdirSync(path.join(home, 'whale-notebook')).sort().join(',') === nbListBefore, 'F2b D 段除 .lifecycle 外原样');
  // check 通过(removed 状态一致)
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F2c remove 后 check 通过');
  // 手工制造残留 → check 报错
  fs.writeFileSync(path.join(home, 'skills/whale-notebook.md'), 'x');
  r = run(['check', '--home', home]);
  expectExit(r, 1, 'F2c2 残留被 check 检出');
  expectText(r, '残留', 'F2c2');
  fs.rmSync(path.join(home, 'skills/whale-notebook.md'));
  // 重装(无种子) → 从备份恢复, 字节等价
  r = run(['install', '--apply', '--home', home]);
  expectExit(r, 0, 'F2d 重装 --apply(自动从备份恢复)');
  ok(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8') === agentsBefore, 'F2d AGENTS 字节等价还原');
  ok(fs.readFileSync(path.join(home, 'skills/whale-notebook.md'), 'utf8') === skillBefore, 'F2d skill 字节等价还原');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F2e 重装后 check 通过');
}

// ================= F3: purge 保护(无导出/无确认拒绝) + 彻底清除 =================
function f3Purge() {
  console.log('\n[F3] purge 保护闸 + 导出 + 彻底清除');
  const home = path.join(TMP, 'f3-home');
  const seed = path.join(TMP, 'f3-seed');
  mkSeed(seed, SKILL_SRC, AGENTS_WHOLE_SEED);
  mkNb(home);
  run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  // 缺导出目录
  let r = run(['uninstall', 'purge', '--apply', '--home', home]);
  expectExit(r, 2, 'F3a 无 --export-dir 被拒');
  expectText(r, '--export-dir', 'F3a');
  // 有导出无 --yes
  const exRoot = path.join(TMP, 'f3-export');
  r = run(['uninstall', 'purge', '--apply', '--home', home, '--export-dir', exRoot]);
  expectExit(r, 2, 'F3b 无 --yes 被拒');
  expectText(r, '--yes', 'F3b');
  // 完整 purge
  r = run(['uninstall', 'purge', '--apply', '--home', home, '--export-dir', exRoot, '--yes']);
  expectExit(r, 0, 'F3c purge --apply');
  const exDirs = fs.readdirSync(exRoot).filter((d) => d.startsWith('whale-notebook-export-'));
  ok(exDirs.length === 1, `F3c 导出目录生成 (${exDirs.length})`);
  const ex = path.join(exRoot, exDirs[0]);
  ok(fs.existsSync(path.join(ex, 'whale-notebook/inbox.md')), 'F3c 导出含 D 数据');
  ok(fs.existsSync(path.join(ex, 'AGENTS.md')), 'F3c 导出含 AGENTS 字节副本');
  ok(fs.existsSync(path.join(ex, 'whale-notebook.md')), 'F3c 导出含 skill 字节副本');
  ok(fs.existsSync(path.join(ex, 'README.txt')), 'F3c 导出含 README');
  ok(!fs.existsSync(path.join(home, 'AGENTS.md')), 'F3c AGENTS 已清除');
  ok(!fs.existsSync(path.join(home, 'skills/whale-notebook.md')), 'F3c skill 已清除');
  ok(!fs.existsSync(path.join(home, 'whale-notebook')), 'F3c D 段已清除(含清单自身)');
  ok(fs.readFileSync(path.join(ex, 'AGENTS.md'), 'utf8') === AGENTS_WHOLE_SEED, 'F3c 导出字节 = 原文件');
}

// ================= F4: zones 模式(区外保护/尾注收纳/剥离) =================
function f4ZonesMode() {
  console.log('\n[F4] zones 模式: 保护用户内容, 剥离只清标记区');
  const home = path.join(TMP, 'f4-home');
  const seed = path.join(TMP, 'f4-seed');
  mkSeed(seed, SKILL_SRC, null);
  mkNb(home);
  fs.mkdirSync(path.join(home), { recursive: true });
  fs.writeFileSync(path.join(home, 'AGENTS.md'), AGENTS_ZONED);
  // 干跑应含「整理」步骤(尾注收纳)
  let r = run(['install', '--home', home, '--seed-dir', seed, '--agents-mode', 'zones']);
  expectExit(r, 0, 'F4a zones 干跑');
  expectText(r, '隐私提示区', 'F4a 计划含尾注收纳');
  // apply
  r = run(['install', '--apply', '--home', home, '--seed-dir', seed, '--agents-mode', 'zones']);
  expectExit(r, 0, 'F4b zones --apply');
  const zoned = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  ok(zoned.startsWith(AGENTS_USER), 'F4b 用户区内容保留且在文件首');
  ok(zoned.includes('<!-- whale-notebook:privacy -->') && zoned.includes('<!-- /whale-notebook:privacy -->'), 'F4b 隐私尾注已纳入标记区');
  ok((zoned.match(/写入需先展示确认。/g) || []).length === 1, 'F4b 尾注内容只出现一次(无重复)');
  // check
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F4c zones check 通过');
  // remove: 只剥标记区, 用户区保留
  r = run(['uninstall', 'remove', '--apply', '--home', home]);
  expectExit(r, 0, 'F4d zones remove --apply');
  ok(fs.existsSync(path.join(home, 'AGENTS.md')), 'F4d AGENTS 文件仍在(zones 只剥区)');
  const left = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  ok(!left.includes('whale-notebook:rules') && !left.includes('whale-notebook:privacy'), 'F4d 无任何标记残留');
  ok(!left.includes('写入需先展示确认。'), 'F4d 原隐私尾注已随标记区剥离');
  ok(left.trimEnd() === AGENTS_USER.trimEnd(), 'F4d 剩余内容 = 用户区字节');
  ok(!fs.existsSync(path.join(home, 'skills/whale-notebook.md')), 'F4d skill 已删');
  // 重装 zones: 标记区重建在尾, 用户内容仍在
  r = run(['install', '--apply', '--home', home, '--agents-mode', 'zones']);
  expectExit(r, 0, 'F4e zones 重装');
  const re = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
  ok(re.includes('<!-- whale-notebook:rules -->') && re.includes('<!-- whale-notebook:privacy -->'), 'F4e 标记区重建');
  ok(re.startsWith(AGENTS_USER.trimStart()), 'F4e 用户内容保留');
}

// ================= F5: 漂移守卫(remove 需 --yes) =================
function f5DriftGuard() {
  console.log('\n[F5] 漂移守卫: 登记后文件被改 → remove 需 --yes');
  const home = path.join(TMP, 'f5-home');
  const seed = path.join(TMP, 'f5-seed');
  mkSeed(seed, SKILL_SRC, null);
  mkNb(home);
  run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  // 现场漂移(skill 被外部改动)
  fs.appendFileSync(path.join(home, 'skills/whale-notebook.md'), '\n- 外部改动\n');
  let r = run(['uninstall', 'remove', '--apply', '--home', home]);
  expectExit(r, 2, 'F5a 漂移时 remove 被拒');
  expectText(r, '漂移', 'F5a');
  r = run(['check', '--home', home]);
  expectExit(r, 1, 'F5b 漂移被 check 检出');
  // --yes 放行且快照留档
  r = run(['uninstall', 'remove', '--apply', '--yes', '--home', home]);
  expectExit(r, 0, 'F5c --yes 放行 remove');
  ok(!fs.existsSync(path.join(home, 'skills/whale-notebook.md')), 'F5c skill 已删');
  const lc = path.join(home, 'whale-notebook/.lifecycle/backups');
  const snaps = fs.readdirSync(lc).filter((d) => fs.statSync(path.join(lc, d)).isDirectory());
  const bak = (name) => {
    for (const d of snaps.slice().sort()) {
      const p = path.join(lc, d, name);
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
    }
    return null;
  };
  ok(bak('skill.bak') !== null && bak('skill.bak').includes('外部改动'), 'F5c 漂移后快照保留最新字节');
}

// ================= main =================
TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-lc-'));
console.log(`自测沙盒: ${TMP}`);
try {
  markerConsistency();
  f1FreshInstall();
  f2RemoveReinstall();
  f3Purge();
  f4ZonesMode();
  f5DriftGuard();
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
} finally {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
}
