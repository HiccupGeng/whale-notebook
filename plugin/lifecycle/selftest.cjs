// lifecycle/selftest.cjs - 生命周期端到端自测（沙盒: 临时 DSH home, 绝不触碰真实 ~/.dsh）
// 验收覆盖(设计文档 §13): 1 幂等 / 3 remove 后无残留且可恢复 / 4 purge 无导出+确认拒绝 / 5 中断可续(重跑幂等)
//              + §F6 R 段(运行时足迹): 清单与 deploy-web.cjs 逐字一致 / 现场探测登记 / 摘除只经唯一写入者
// 用法: node plugin/lifecycle/selftest.cjs   （退出码 0=全绿）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CLI = path.join(__dirname, 'cli.cjs');
const PKG = path.resolve(__dirname, '..');
const C = require('./consts.cjs'); // v0.7.9：{profile} 模板解析（F6a 直接验证解析结果）
let pass = 0;
let fail = 0;
let TMP = null;

function ok(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}
function run(args, opts) {
  // v0.7.9：opts.cli 可指定另一份 cli.cjs（F8 用它验证“从仓库素材安装”时仓库根的推导）
  const o = opts || {};
  const cli = o.cli || CLI;
  const rest = Object.assign({}, o);
  delete rest.cli;
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...rest });
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

  // ---- v0.7.8（审计第 4 项）：zones 模式下"区外改动"不算漂移；"区内改动"= 待登记（信息级，不 exit 1）----
  fs.appendFileSync(path.join(home, 'AGENTS.md'), '\n## 我后来自己加的一段（区外）\n\n- 用户内容追加\n');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F4f 用户在区外追加内容 → check 仍通过（区外不参与漂移判定）');
  ok(!r.text.includes('待登记'), 'F4f 区外改动不产生「待登记」');
  // 区内改动（模拟一次经验入库重写了自动段）
  const zoned2 = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8')
    .replace('状态：尚未完成首轮经验审核，暂无规则条目。', '状态：1 条全局规则生效中（自测注入）');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), zoned2);
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F4g 区内容变化 = 合法演进 → check 通过（不再恒 exit 1）');
  expectText(r, '待登记', 'F4g 以「待登记」如实提示');
  r = run(['check', '--adopt', '--home', home]);
  expectExit(r, 0, 'F4h check --adopt 重新登记区基线');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F4h adopt 后 check 通过');
  ok(!r.text.includes('待登记'), 'F4h adopt 后不再有待登记项');
  ok(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8').includes('自测注入'), 'F4h adopt 不修改文件内容(区内容原样保留)');
}

// ================= F5: 漂移分级（soft=待登记不拦 check / hard=结构损坏 exit 1 / remove 仍要 --yes） =================
// v0.7.8：结构探测需要一个"结构完好"的 skill —— 用可编程生成的长文本，避免把断言建立在真实技能内容上。
const SKILL_VALID = [
  '---',
  'name: whale-notebook',
  'description: 鲸鱼闪闪发光的小本本（自测用结构完好样本）',
  '---',
  '',
  '# whale-notebook — 自测样本',
  '',
  '## 架构速览',
  '',
  '- whale-notebook 自测种子内容。',
  '',
  '## 隐私铁律（每次执行前默念）',
  '',
  '- 先展示后写入。',
  '',
  '## 工作流',
  '',
  '- 运行 mine.cjs --check。',
  '',
  '## 记录格式与口径',
  '',
  ...Array.from({ length: 40 }, (_, i) => `- 填充行 ${i}：保证字节数超过结构校验下限。`),
  '',
].join('\n');

function f5DriftGuard() {
  console.log('\n[F5] 漂移分级: 合法演进=待登记(不拦 check) / 结构损坏=exit 1 / remove 仍需 --yes');
  const home = path.join(TMP, 'f5-home');
  const seed = path.join(TMP, 'f5-seed');
  mkSeed(seed, SKILL_VALID, null);
  mkNb(home);
  run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  // 现场漂移(skill 被外部改动) —— 结构仍完好
  fs.appendFileSync(path.join(home, 'skills/whale-notebook.md'), '\n- 外部改动\n');
  let r = run(['uninstall', 'remove', '--apply', '--home', home]);
  expectExit(r, 2, 'F5a 漂移时 remove 被拒（删除前仍要确认）');
  expectText(r, '漂移', 'F5a');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F5b 结构完好的漂移 = 合法演进 → check 通过（不再恒 exit 1）');
  expectText(r, '待登记', 'F5b 以「待登记」如实提示');
  // 结构损坏（截断到半个 frontmatter 之前）→ 真问题
  fs.writeFileSync(path.join(home, 'skills/whale-notebook.md'), '---\nname: whale-notebook\ndescrip');
  r = run(['check', '--home', home]);
  expectExit(r, 1, 'F5b2 结构损坏(截断) → check exit 1');
  expectText(r, '结构损坏', 'F5b2 明确报「结构损坏」');
  // 恢复成"结构完好但内容变过"再 adopt
  fs.writeFileSync(path.join(home, 'skills/whale-notebook.md'), SKILL_VALID + '\n- 合法更新\n');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F5b3 修好后 check 通过');
  expectText(r, '待登记', 'F5b3 提示待登记');
  r = run(['check', '--adopt', '--home', home]);
  expectExit(r, 0, 'F5b4 check --adopt 重新登记');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F5b4 adopt 后 check 通过');
  ok(!r.text.includes('待登记'), 'F5b4 adopt 后无待登记项');
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
  ok(bak('skill.bak') !== null && bak('skill.bak').includes('合法更新'), 'F5c 漂移后快照保留最新字节');
}

// ================= F6: R 段(运行时足迹) —— 登记/对账/摘除 =================
// 关键安全前提: detach 把动作交给 scripts/deploy-web.cjs, 必须用 DSH_HOME=<home> 覆盖,
// 否则会在测试(或用户 --home)时误动真实 ~/.dsh 里的部署。本段同时用真实文件的 hash 做反证。
const DEPLOY_SRC = fs.readFileSync(path.join(PKG, 'scripts', 'deploy-web.cjs'), 'utf8');
function deployConst(name) {
  const m = DEPLOY_SRC.match(new RegExp(`const ${name} = '((?:[^'\\\\]|\\\\.)*)'`));
  return m ? m[1].replace(/\\n/g, '\n') : null;
}
const D_MARK_START = deployConst('MARK_START');
const D_MARK_END = deployConst('MARK_END');

function fakeDeploy(home) {
  const webDir = path.join(home, 'profiles', 'web');
  const pkgDir = path.join(webDir, 'node_modules', '@deepseek-ai', 'dsh-whale-notebook');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), '{"name":"@deepseek-ai/dsh-whale-notebook","version":"0.7.0"}\n');
  const patchFile = path.join(webDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, '# 其它插件的挂载行(必须原样保留)\n- insert:\n    - id: other-plugin\n      name: "@x/y"\n\n'
    + D_MARK_START + '- insert:\n    - id: whale-notebook\n' + D_MARK_END);
  return { pkgDir, patchFile };
}
function siteEntry(home, id) {
  const site = JSON.parse(fs.readFileSync(path.join(home, 'whale-notebook/.lifecycle/manifest.json'), 'utf8'));
  return site.entries.find((e) => e.id === id);
}

function f6RuntimeSegment() {
  console.log('\n[F6] R 段: 清单与 deploy-web.cjs 一致 / 探测登记 / 摘除归唯一写入者');
  const manifest = JSON.parse(fs.readFileSync(path.join(PKG, 'manifest.json'), 'utf8'));
  const defPkg = manifest.entries.find((e) => e.id === 'runtime-web-pkg');
  const defPatch = manifest.entries.find((e) => e.id === 'runtime-web-patch');
  ok(!!defPkg && !!defPatch, 'F6a 清单含 R 段两条(runtime-web-pkg / runtime-web-patch)');
  ok(defPkg.segment === 'R' && defPatch.segment === 'R', 'F6a 两条均归 R 段');
  ok(defPkg.state === 'probe' && defPatch.state === 'probe', 'F6a R 段状态为 probe(现场探测, 不写死)');
  ok(defPkg.managedBy === 'scripts/deploy-web.cjs' && defPatch.managedBy === 'scripts/deploy-web.cjs', 'F6a 声明唯一写入者 scripts/deploy-web.cjs');
  // v0.7.9：R 段路径改带 {profile} 模板 —— 桌面版(desktop)与纯 Web 形态(web)部署位不同，
  //   写死 web 会让桌面版"部署成功但面板不出现"（静默失效）。这里断言模板与解析后的真实部署位。
  ok(/\{profile\}[\\/]node_modules[\\/]@deepseek-ai[\\/]dsh-whale-notebook$/.test(defPkg.path),
    'F6a 包路径带 {profile} 模板 + 落在 @deepseek-ai/dsh-whale-notebook');
  ok(/\{profile\}[\\/]cordis\.patch\.yml$/.test(defPatch.path), 'F6a 挂载行条目 = profiles/{profile}/cordis.patch.yml');
  const ctxWeb = { home: TMP, nb: path.join(TMP, 'whale-notebook'), pkg: PKG, profile: 'web' };
  ok(/profiles[\\/]web[\\/]node_modules/.test(C.resolvePathTpl(defPkg.path, ctxWeb)),
    'F6a {profile}=web → 解析到 profiles/web/node_modules(向后兼容默认)');
  const ctxDesk = Object.assign({}, ctxWeb, { profile: 'desktop' });
  ok(/profiles[\\/]desktop[\\/]node_modules/.test(C.resolvePathTpl(defPkg.path, ctxDesk)),
    'F6a {profile}=desktop → 解析到 profiles/desktop/node_modules');
  ok(!!D_MARK_START && !!D_MARK_END, 'F6a 已从 deploy-web.cjs 取出 MARK_START/MARK_END');
  // 清单里只存"标记行"本身(不带尾换行): 便于 hasZone 匹配且不受行尾风格影响
  const markerLine = (s) => String(s || '').replace(/\s+$/, '');
  ok(markerLine(defPatch.markers.begin) === markerLine(D_MARK_START) && markerLine(defPatch.markers.end) === markerLine(D_MARK_END),
    'F6a 清单 markers 与 deploy-web.cjs 的 MARK_START/MARK_END 逐字一致');

  const home = path.join(TMP, 'f6-home');
  const seed = path.join(TMP, 'f6-seed');
  mkSeed(seed, SKILL_SRC, null);
  mkNb(home);
  // 未部署的新机: 登记为 absent
  let r = run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  expectExit(r, 0, 'F6b install --apply');
  expectText(r, 'R: runtime-web-pkg → absent', 'F6b 未部署 → R 段登记 absent');
  ok(siteEntry(home, 'runtime-web-pkg').state === 'absent', 'F6b 站点清单 R 状态 = absent');
  // 造出"已部署"现场(模拟 deploy-web --apply 的结果): 登记与实际不符时只提示, 不左右退出码
  const fake = fakeDeploy(home);
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F6c R 段不一致不改变 check 退出码');
  expectText(r, 'R 段: runtime-web-pkg', 'F6c R 段被对账');
  expectText(r, '不一致', 'F6c 与实际不符被标出');
  expectText(r, '不影响本命令退出码', 'F6c 明示信息级');
  // 重新登记 → installed
  r = run(['install', '--apply', '--home', home, '--seed-dir', seed]);
  expectExit(r, 0, 'F6d 重新登记 install --apply');
  expectText(r, 'R: runtime-web-pkg → installed', 'F6d 现场有副本 → 登记 installed');
  ok(siteEntry(home, 'runtime-web-patch').state === 'installed', 'F6d 站点清单 patch 条目 = installed');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F6e 登记一致后 check 通过');
  expectText(r, 'check 通过: I/D 段', 'F6e');
  // 摘除: 干跑零写
  const patchBefore = fs.readFileSync(fake.patchFile, 'utf8');
  const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const realPatch = path.join(realHome, 'profiles', 'web', 'cordis.patch.yml');
  const realHashBefore = fs.existsSync(realPatch) ? fs.readFileSync(realPatch).toString('base64') : null;
  r = run(['uninstall', 'detach', '--home', home]);
  expectExit(r, 0, 'F6f detach 干跑');
  expectText(r, 'deploy-web.cjs', 'F6f 计划点明唯一写入者');
  expectText(r, '--undo', 'F6f 计划含 --undo');
  expectText(r, 'dry-run', 'F6f 干跑未执行');
  ok(fs.readFileSync(fake.patchFile, 'utf8') === patchBefore, 'F6f 干跑零写(patch 字节不变)');
  // 摘除: apply(不删副本目录)
  r = run(['uninstall', 'detach', '--apply', '--home', home]);
  expectExit(r, 0, 'F6g detach --apply');
  const patchAfter = fs.readFileSync(fake.patchFile, 'utf8');
  ok(!patchAfter.includes(D_MARK_START), 'F6g 标记区已摘除');
  ok(patchAfter.includes('- id: other-plugin'), 'F6g 其它插件的行原样保留(不整文件替换)');
  ok(fs.existsSync(fake.pkgDir), 'F6g 未传 --yes → 副本目录保留');
  ok(siteEntry(home, 'runtime-web-patch').state === 'absent', 'F6g 摘除后重新登记: patch=absent');
  ok(siteEntry(home, 'runtime-web-pkg').state === 'installed', 'F6g 副本仍在 → pkg 仍登记 installed(如实)');
  r = run(['check', '--home', home]);
  expectExit(r, 0, 'F6h 摘除后 check 仍通过(R 段不左右退出码)');
  // 摘除: --yes 连副本目录一起删
  r = run(['uninstall', 'detach', '--apply', '--yes', '--home', home]);
  expectExit(r, 0, 'F6i detach --yes');
  ok(!fs.existsSync(fake.pkgDir), 'F6i 副本目录已删除');
  ok(siteEntry(home, 'runtime-web-pkg').state === 'absent', 'F6i site: pkg=absent');
  // 幂等: 已无足迹 → 零动作
  r = run(['uninstall', 'detach', '--apply', '--home', home]);
  expectExit(r, 0, 'F6j detach 幂等');
  expectText(r, 'R 段现场已无足迹', 'F6j 已清 → 零动作');
  // 反证: 全过程未触碰真实 home 的部署文件
  const realHashAfter = fs.existsSync(realPatch) ? fs.readFileSync(realPatch).toString('base64') : null;
  ok(realHashBefore === realHashAfter, 'F6k 反证: 真实 home 的 cordis.patch.yml 字节未变(DSH_HOME 覆盖生效)');

  // ---- F6l（v0.7.9）：desktop profile 端到端 —— 桌面版（Windows 的 DeepSeek Harness.exe）
  //   跑的是 desktop profile。若 R 段仍去 web 找足迹，会报“未部署”而把 desktop 上的
  //   真实足迹留成孤儿（卸载更是卸载错的 profile）。本段用独立 home 造 desktop 现场来钉住。
  const homeD = path.join(TMP, 'f6d-home');
  const seedD = path.join(TMP, 'f6d-seed');
  mkSeed(seedD, SKILL_SRC, null);
  mkNb(homeD);
  expectExit(run(['install', '--apply', '--home', homeD, '--seed-dir', seedD]), 0, 'F6l install(desktop 场景)');
  // 先断言"未记录 profile 时回退 web"（向后兼容）：此时 desktop 现场对 web 而言不存在 → 双方都 absent，
  //   但登记的 baseline 是"未部署"，所以仍是一致的（check 通过）；关键看下面的对照用例。
  r = run(['check', '--home', homeD]);
  expectExit(r, 0, 'F6l 无记录 → check 通过(回退 web)');
  ok(/R 段: runtime-web-pkg 登记=absent 现场=absent/.test(r.text), 'F6l 无记录时按默认 web 对账(desktop 现场未被看见)');
  // 造 desktop 现场: 副本目录 + patch 挂载行（与 deploy-web.cjs 的产物同形）
  const deskDir = path.join(homeD, 'profiles', 'desktop');
  const deskPkg = path.join(deskDir, 'node_modules', '@deepseek-ai', 'dsh-whale-notebook');
  fs.mkdirSync(deskPkg, { recursive: true });
  fs.writeFileSync(path.join(deskPkg, 'package.json'), '{"name":"@deepseek-ai/dsh-whale-notebook","version":"0.7.9"}\n');
  fs.writeFileSync(path.join(deskDir, 'cordis.patch.yml'),
    '# 桌面版用户自己的 patch 行(必须原样保留)\n- id: permission\n  name: "@deepseek-ai/dsh-permission-presets"\n\n'
    + D_MARK_START + '- insert:\n    - id: whale-notebook\n' + D_MARK_END);
  // deploy-web.cjs 部署成功后会写这条记录 —— 这里模拟同一产物
  fs.writeFileSync(path.join(homeD, 'whale-notebook', '.lifecycle', 'runtime-profile.json'),
    JSON.stringify({ profile: 'desktop', at: new Date().toISOString() }, null, 2) + '\n');
  // 重新登记 → 必须认到 desktop 的现场（而不是继续看 web）
  r = run(['install', '--apply', '--home', homeD, '--seed-dir', seedD]);
  expectExit(r, 0, 'F6l 记录 desktop 后重新登记');
  expectText(r, 'R: runtime-web-pkg → installed', 'F6l desktop 现场被认到 → installed(而非误报 absent)');
  ok(siteEntry(homeD, 'runtime-web-pkg').state === 'installed', 'F6l 站点清单 pkg=installed');
  ok(siteEntry(homeD, 'runtime-web-patch').state === 'installed', 'F6l 站点清单 patch=installed');
  ok(/profiles[\\/]desktop/.test(siteEntry(homeD, 'runtime-web-pkg').path), 'F6l 站点路径已落在 profiles/desktop');
  r = run(['check', '--home', homeD]);
  expectExit(r, 0, 'F6l desktop 登记一致后 check 通过');
  // 关键信号：R 段报"一致"= 探测确实打在 desktop 上（若还看 web，desktop 现场会被判 absent → 不一致）
  ok(/R 段: runtime-web-pkg 登记=installed 现场=installed\(目录在位\) 一致/.test(r.text),
    'F6l check 按 desktop 对账(R 段一致, 未误报 absent)');
  ok(/R 段: runtime-web-patch 登记=installed 现场=installed\(标记区在位\) 一致/.test(r.text),
    'F6l check 认出 desktop 的挂载行标记区');
  // 摘除必须摘 desktop 的（用户自己的行原样保留）；web profile 目录根本不存在 → 不该被动过
  r = run(['uninstall', 'detach', '--apply', '--home', homeD]);
  expectExit(r, 0, 'F6l detach --apply（desktop）');
  const deskPatchAfter = fs.readFileSync(path.join(deskDir, 'cordis.patch.yml'), 'utf8');
  ok(!deskPatchAfter.includes(D_MARK_START), 'F6l desktop 的挂载行已摘除');
  ok(deskPatchAfter.includes('- id: permission'), 'F6l desktop 用户自己的 patch 行原样保留');
  ok(siteEntry(homeD, 'runtime-web-patch').state === 'absent', 'F6l 摘除后 patch=absent');
}

// ================= F8（v0.7.9）: 从仓库素材安装（--seed-from-repo） =================
// 动机（新机实测踩到）：install 把 L2 技能当必需前置（缺失 exit 2），而它此前从不进仓库
//   → 照 README 走必然卡死。现在仓库根自带 skills/whale-notebook.md，--seed-from-repo 自动补。
// 关键点：仓库根是**从 cli.cjs 自身位置推导**的（上两级），所以这里造一个"仓库布局"的沙盒：
//   <TMP>/f8-repo/{plugin/lifecycle/cli.cjs, skills/whale-notebook.md}
function f8SeedFromRepo() {
  console.log('\n[F8] 从仓库素材安装（--seed-from-repo）: 两段式 / 逐字节 / 幂等 / 缺素材明说');
  const repoRoot = path.join(TMP, 'f8-repo');
  const sbCli = path.join(repoRoot, 'plugin', 'lifecycle', 'cli.cjs');
  fs.mkdirSync(path.dirname(sbCli), { recursive: true });
  fs.copyFileSync(CLI, sbCli); // 用同一份 cli.cjs，确保测的是当前的推导逻辑
  const repoSkill = path.join(repoRoot, 'skills', 'whale-notebook.md');
  fs.mkdirSync(path.dirname(repoSkill), { recursive: true });
  // 素材来源：优先仓库根的 skills/（按目录名从 PKG 推导）；在"运行实例"里跑时回退到真实 ~/.dsh/skills/
  const realRepoSkill = path.join(path.dirname(PKG), 'skills', 'whale-notebook.md');
  const installedSkill = path.join(os.homedir(), '.dsh', 'skills', 'whale-notebook.md');
  const srcForFixture = fs.existsSync(realRepoSkill) ? realRepoSkill : installedSkill;
  if (!fs.existsSync(srcForFixture)) { fail++; console.log(`  FAIL F8 夹具缺素材: ${srcForFixture}`); return; }
  fs.copyFileSync(srcForFixture, repoSkill); // 真仓库素材

  const home = path.join(TMP, 'f8-home');
  mkNb(home);

  // a) dry-run：报告"将复制"，但零写盘（两段式纪律）
  let r = run(['install', '--seed-from-repo', '--home', home], { cli: sbCli });
  expectText(r, '将从仓库素材复制', 'F8a dry-run 报告将复制');
  expectText(r, 'dry-run 未写', 'F8a 明示未写');
  ok(!fs.existsSync(path.join(home, 'skills', 'whale-notebook.md')), 'F8a dry-run 零写盘（技能未落位）');
  // 不加 --seed-from-repo 时仍是老行为（阻塞）—— 防"偷偷自动复制"改变既有语义
  r = run(['install', '--home', home], { cli: sbCli });
  expectExit(r, 2, 'F8b 不加参数仍阻塞（语义未被偷偷改变）');
  expectText(r, 'skill 缺失且无种子/备份', 'F8b');
  // c) apply：复制成功 + 逐字节一致 + install 一并完成
  r = run(['install', '--apply', '--seed-from-repo', '--home', home], { cli: sbCli });
  expectExit(r, 0, 'F8c install --apply --seed-from-repo');
  expectText(r, 'skill 已从仓库素材复制', 'F8c 报告已复制');
  const placed = path.join(home, 'skills', 'whale-notebook.md');
  ok(fs.existsSync(placed), 'F8c 技能已落位');
  ok(fs.readFileSync(placed).equals(fs.readFileSync(repoSkill)), 'F8c 与仓库素材逐字节一致');
  ok(siteEntry(home, 'skill').state === 'installed', 'F8c 站点清单登记 skill=installed');
  // d) 幂等：再跑一次不重复复制、不报错
  r = run(['install', '--apply', '--seed-from-repo', '--home', home], { cli: sbCli });
  expectExit(r, 0, 'F8d 二次 apply 幂等');
  expectText(r, 'skill 已存在，仓库素材无需复制', 'F8d 幂等跳过复制');
  // e) 仓库里没有素材时明说（不静默成功）
  const emptyRepo = path.join(TMP, 'f8-empty');
  const emptyCli = path.join(emptyRepo, 'plugin', 'lifecycle', 'cli.cjs');
  fs.mkdirSync(path.dirname(emptyCli), { recursive: true });
  fs.copyFileSync(CLI, emptyCli);
  const home2 = path.join(TMP, 'f8-home2');
  mkNb(home2);
  r = run(['install', '--apply', '--seed-from-repo', '--home', home2], { cli: emptyCli });
  expectExit(r, 2, 'F8e 缺素材 → exit 2');
  expectText(r, '仓库里没有 skills/whale-notebook.md', 'F8e 明确指出缺什么');
  ok(!fs.existsSync(path.join(home2, 'skills', 'whale-notebook.md')), 'F8e 未落任何技能文件');
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
  f6RuntimeSegment();
  f8SeedFromRepo();
  console.log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  if (fail) process.exitCode = 1;
} finally {
  if (process.env.WHALE_KEEP_TMP) console.log(`保留沙盒: ${TMP}`);
  else try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理失败无碍 */ }
}
