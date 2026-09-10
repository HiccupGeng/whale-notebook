// scripts/deploy-web.cjs - 把 dsh-whale-notebook 部署到 dsh web profile（决策箱面板挂载）
// 两段式：默认 dry-run 只打印计划；--apply 执行；--undo 撤销 patch 行（--yes 一并删包目录）。
// 生效前提：loader 行集在 dsh web 启动时固定 → 部署后需重启 dsh web（页面刷新不够）。
// 幂等：文件字节相同跳过写；patch 行已存在跳过；重复执行结果不变。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const PROFILE_DIR = path.join(HOME, 'profiles', 'web');
const TARGET_ROOT = path.join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-whale-notebook');
const PATCH_FILE = path.join(PROFILE_DIR, 'cordis.patch.yml');
const SRC_ROOT = path.join(__dirname, '..'); // plugin/（scripts/..）
const PKG_ID = '@deepseek-ai/dsh-whale-notebook';

const MARK_START = '# --- whale-notebook 决策箱面板 (deploy-web.cjs managed) ---\n';
const ENTRY =
  '- insert:\n' +
  '    - id: whale-notebook\n' +
  "      name: '@deepseek-ai/dsh-whale-notebook'\n" +
  '      inject: [webServer]\n';
const MARK_END = '# --- /whale-notebook panel ---\n';
const PATCH_BLOCK = MARK_START + ENTRY + MARK_END;

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const UNDO = argv.includes('--undo');
const YES = argv.includes('--yes');
const CHECK = argv.includes('--check');

function out(s) { console.log(s); }

function pkgOf(dir) {
  const f = path.join(dir, 'package.json');
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function checkSrc() {
  const pkg = pkgOf(SRC_ROOT);
  const errs = [];
  if (pkg.name !== PKG_ID) errs.push('package name 应为 ' + PKG_ID);
  if (!pkg.main || !fs.existsSync(path.join(SRC_ROOT, pkg.main))) errs.push('main 缺失: ' + pkg.main);
  if (!pkg.exports || !pkg.exports['./client']) errs.push('exports["./client"] 缺失');
  if (!pkg.dsh || !pkg.dsh.client || pkg.dsh.client.platform !== 'web') errs.push('dsh.client {platform:"web"} 缺失');
  const clientPath = path.join(SRC_ROOT, pkg.exports['./client']);
  if (!fs.existsSync(clientPath)) errs.push('client bundle 缺失: ' + pkg.exports['./client']);
  if (errs.length) {
    out('[部署中止] 源包声明不完整：');
    for (const e of errs) out('  - ' + e);
    process.exit(1);
  }
  return { pkg, clientRel: pkg.exports['./client'] };
}

function filesChanged(srcDir, dstDir) {
  const changed = [];
  const walk = (s, d) => {
    fs.mkdirSync(d, { recursive: true });
    for (const en of fs.readdirSync(s, { withFileTypes: true })) {
      if (en.name === 'node_modules' || en.name === '.git') continue;
      const sp = path.join(s, en.name);
      const dp = path.join(d, en.name);
      if (en.isDirectory()) { walk(sp, dp); continue; }
      if (!en.isFile()) continue;
      if (fs.existsSync(dp) && fs.readFileSync(sp).equals(fs.readFileSync(dp))) continue;
      changed.push(path.relative(SRC_ROOT, sp));
    }
  };
  walk(srcDir, dstDir);
  return changed;
}

function patchText() {
  const raw = fs.existsSync(PATCH_FILE) ? fs.readFileSync(PATCH_FILE, 'utf8') : '';
  return raw;
}

function planPatch() {
  const raw = patchText();
  if (raw.includes('- id: whale-notebook')) return { action: 'skip', text: raw };
  // 空数组行（[ ] 单独成行，loader 顶层数组的空元素）→ 原位替换为 managed 块
  const re = /^[ \t]*\[\][ \t]*$/m;
  if (re.test(raw)) {
    return { action: 'replace', text: raw.replace(re, PATCH_BLOCK.trimEnd()) };
  }
  if (raw.trim() === '') {
    return { action: 'replace', text: PATCH_BLOCK };
  }
  return { action: 'append', text: raw.endsWith('\n') || raw === '' ? raw + PATCH_BLOCK : raw + '\n' + PATCH_BLOCK };
}

function undoPatchText() {
  const raw = patchText();
  const start = raw.indexOf(MARK_START);
  if (start === -1) return null;
  const end = raw.indexOf(MARK_END, start);
  if (end === -1) return null;
  const blockEnd = end + MARK_END.length;
  const before = raw.slice(0, start).replace(/[ \t]*\n?$/, '\n');
  const after = raw.slice(blockEnd).replace(/^\s*/, '');
  let text = before + after;
  text = text.trimEnd();
  // 撤销后若无顶层数组元素（纯注释/空）→ 补回空数组行，保证 YAML 顶层是数组
  const hasEntry = /(^|\n)[ \t]*-[ \t]/.test(text) || /(^|\n)[ \t]*\[/.test(text);
  if (!hasEntry) text = text + (text ? '\n' : '') + '[]';
  return text + '\n';
}

// v0.7.1：--check 原先只核结构（包目录在、package.json 可解析、patch 行在位），
//   副本内容陈旧照样「自检通过」——实测踩过：源已 0.7.1、副本仍是 0.7.0，check 却报通过，
//   于是「重启了却没生效」。这里补一层只读的逐文件字节对账（权威源 → 副本）：
//   缺失/内容不同 = 漂移（判失败，需 --apply）；副本多余文件只提示、不判失败
//   （dsh/pnpm 重装可能在包目录留下附带文件，不该因此让 check 变脆）。
function diffDeployed() {
  const drift = { missing: [], differ: [], extra: [] };
  if (!fs.existsSync(TARGET_ROOT)) return drift;
  const walk = (dir, base, acc) => {
    for (const en of fs.readdirSync(dir, { withFileTypes: true })) {
      if (en.name === 'node_modules' || en.name === '.git') continue;
      const p = path.join(dir, en.name);
      const rel = path.relative(base, p);
      if (en.isDirectory()) walk(p, base, acc);
      else if (en.isFile()) acc.push(rel);
    }
    return acc;
  };
  const src = walk(SRC_ROOT, SRC_ROOT, []);
  const dst = walk(TARGET_ROOT, TARGET_ROOT, []);
  const dstSet = new Set(dst);
  for (const rel of src) {
    const dp = path.join(TARGET_ROOT, rel);
    if (!dstSet.has(rel)) { drift.missing.push(rel); continue; }
    if (!fs.readFileSync(path.join(SRC_ROOT, rel)).equals(fs.readFileSync(dp))) drift.differ.push(rel);
  }
  const srcSet = new Set(src);
  for (const rel of dst) if (!srcSet.has(rel)) drift.extra.push(rel);
  return drift;
}

function verifyDeployed() {
  const errs = [];
  const notes = [];
  if (!fs.existsSync(TARGET_ROOT)) errs.push('包目录不存在: ' + TARGET_ROOT);
  else {
    try {
      const pkg = pkgOf(TARGET_ROOT);
      if (pkg.name !== PKG_ID) errs.push('目标包 name 不符');
      if (!pkg.exports || !pkg.exports['./client']) errs.push('目标 exports["./client"] 缺失');
      const cp = path.join(TARGET_ROOT, pkg.exports && pkg.exports['./client'] || '');
      if (!fs.existsSync(cp)) errs.push('目标 client bundle 缺失');
      if (!pkg.dsh || !pkg.dsh.client) errs.push('目标 dsh.client 缺失');
    } catch (e) { errs.push('目标 package.json 解析失败: ' + e.message); }
    const drift = diffDeployed();
    const bad = drift.missing.length + drift.differ.length;
    if (bad) {
      errs.push('副本内容与权威源不一致 ' + bad + ' 个文件（副本陈旧）——需执行 deploy-web.cjs --apply');
      for (const f of drift.missing.slice(0, 5)) errs.push('  · 副本缺失: ' + f);
      for (const f of drift.differ.slice(0, 5)) errs.push('  · 内容不同: ' + f);
      if (bad > 10) errs.push('  · …（其余 ' + (bad - 10) + ' 个）');
    }
    if (drift.extra.length) notes.push('副本多余 ' + drift.extra.length + ' 个文件（不影响判定）: ' + drift.extra.slice(0, 3).join(', '));
  }
  const pt = patchText();
  if (!pt.includes('- id: whale-notebook')) errs.push('profile patch 缺少 whale-notebook 行');
  if (errs.length) {
    out('[自检失败]');
    for (const e of errs) out('  - ' + e);
    return false;
  }
  for (const n of notes) out('[自检提示] ' + n);
  out('[自检通过] 副本与权威源逐字节一致 + patch 行在位。重启 dsh web 后生效。');
  return true;
}

// ── main ──────────────────────────────────────────────────────────────
if (CHECK) {
  checkSrc();
  process.exit(verifyDeployed() ? 0 : 1);
}

if (UNDO) {
  const plan = undoPatchText();
  if (plan === null) {
    out('[undo] 未找到 managed 块，无需撤销。');
    if (YES && fs.existsSync(TARGET_ROOT)) {
      out('[undo] --yes：删除包目录 ' + TARGET_ROOT);
      if (APPLY) fs.rmSync(TARGET_ROOT, { recursive: true, force: true });
    }
    process.exit(0);
  }
  out('[undo 计划] 将从 ' + PATCH_FILE + ' 移除 whale-notebook managed 块。');
  if (!APPLY) { out('（未传 --apply，仅展示）'); process.exit(0); }
  fs.writeFileSync(PATCH_FILE, plan, 'utf8');
  out('[undo 完成] patch 行已移除（未删除包目录；如需一并删除：node deploy-web.cjs --undo --apply --yes）。');
  out('重启 dsh web 后插件不再加载。');
  process.exit(0);
}

// deploy（dry 或 apply）
const { pkg } = checkSrc();
const changed = filesChanged(SRC_ROOT, TARGET_ROOT);
const pp = planPatch();

out('=== whale-notebook → dsh web profile 部署计划 ===');
out('源   : ' + SRC_ROOT);
out('目标 : ' + TARGET_ROOT);
out('版本 : ' + pkg.version + '（main=' + pkg.main + ', exports["./client"]=' + pkg.exports['./client'] + '）');
out('');
if (changed.length === 0) out('文件：无变更（目标已是最新）');
else {
  out('文件：将复制/更新 ' + changed.length + ' 个（字节不同才写）：');
  for (const f of changed.slice(0, 30)) out('  + ' + f);
  if (changed.length > 30) out('  … 其余 ' + (changed.length - 30) + ' 个');
}
out('');
if (pp.action === 'skip') out('patch：' + PATCH_FILE + ' 已含 whale-notebook 行，跳过');
else if (pp.action === 'replace') out('patch：空数组 [] → 插入 managed 块（' + PATCH_FILE + '）');
else out('patch：文件尾部追加 managed 块（' + PATCH_FILE + '）');
out('');

if (!APPLY) {
  out('（dry-run：未做任何修改。执行请加 --apply）');
  process.exit(0);
}

if (changed.length) {
  fs.rmSync(TARGET_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TARGET_ROOT, { recursive: true });
  const walk = (s, d) => {
    for (const en of fs.readdirSync(s, { withFileTypes: true })) {
      if (en.name === 'node_modules' || en.name === '.git') continue;
      const sp = path.join(s, en.name);
      const dp = path.join(d, en.name);
      if (en.isDirectory()) { fs.mkdirSync(dp, { recursive: true }); walk(sp, dp); }
      else if (en.isFile()) fs.copyFileSync(sp, dp);
    }
  };
  walk(SRC_ROOT, TARGET_ROOT);
  out('[apply] 已复制 ' + changed.length + ' 个文件到 ' + TARGET_ROOT);
} else {
  out('[apply] 文件已最新，跳过复制');
}

if (pp.action !== 'skip') {
  fs.writeFileSync(PATCH_FILE, pp.text, 'utf8');
  out('[apply] patch 已写入 ' + PATCH_FILE + '（' + pp.action + '）');
} else {
  out('[apply] patch 已在位');
}

out('');
if (verifyDeployed()) {
  out('');
  out('部署完成。下一步：重启 dsh web（示例命令见文档；重启后刷新页面即可看到决策箱面板）。');
}
