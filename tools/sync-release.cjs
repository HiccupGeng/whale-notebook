#!/usr/bin/env node
// tools/sync-release.cjs - 一键同步提交: 权威源 → 发布镜像库 → commit → push
//
// 权威源:
//   1) 运行源码   ~/.dsh/whale-notebook/plugin/   (或 DSH_HOME / DSH_WHALE_NB_DIR 覆盖)
//   2) 设计文档   <repo 同级的 workspace>/docs/    中文件名含 whale-notebook 的 .md
//   3) 兼容脚本   <数据目录>/scripts/ 的 mine.cjs 与 redact.test.cjs
//   4) 项目总览   <数据目录>/PROJECT-INTRO.md → 库根 PROJECT-INTRO.md(固定文件镜像)
// 目标: 本仓库(脚本所在库) 的 plugin/ docs/ scripts/ PROJECT-INTRO.md
//
// 语义: 镜像同步(目标目录先清空再整拷, 防残留/漂移); 无文件变化则不提交不推送。
// 隐私: 只同步上述路径; 数据文件(inbox/state/settings/entries/.lifecycle 等)
//       永不触碰——.gitignore 同步兜底; 本脚本自身也拒绝处理含这些名字的路径。
//
// 用法: node tools/sync-release.cjs [--no-push] [--msg "自定义提交信息"]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const NB = process.env.DSH_WHALE_NB_DIR || path.join(DSH_HOME, 'whale-notebook');
const WORKSPACE = path.resolve(REPO, '..');
const DOCS_SRC = path.join(WORKSPACE, 'docs');
// 固定文件镜像: { 数据目录内相对路径: 库内相对路径 }
const EXTRA_FILES = { 'PROJECT-INTRO.md': 'PROJECT-INTRO.md' };

const PRIVATE_NAMES = /(^|[\\/])(inbox\.md|state\.json|settings\.json|entries|archive|\.lifecycle|AGENTS\.md)([\\/]|$)/i;
const out = (prefix, m) => console.log(`[sync] ${prefix} ${m}`);
const git = (args) => spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function assertNoPrivate(p) {
  if (PRIVATE_NAMES.test(p)) {
    throw new Error(`路径含隐私/数据文件名, 已拒绝同步: ${p}`);
  }
}
function rmTree(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
// 整目录镜像: 先清空目标, 再逐文件复制(字节不变)
function mirrorDir(src, dst) {
  if (!fs.existsSync(src)) throw new Error(`权威源目录不存在: ${src}`);
  assertNoPrivate(src);
  rmTree(dst);
  fs.mkdirSync(dst, { recursive: true });
  const walk = (s, d) => {
    for (const name of fs.readdirSync(s)) {
      const sp = path.join(s, name);
      const dp = path.join(d, name);
      const rel = path.relative(REPO, dp);
      assertNoPrivate(rel);
      if (fs.statSync(sp).isDirectory()) { fs.mkdirSync(dp, { recursive: true }); walk(sp, dp); }
      else fs.copyFileSync(sp, dp);
    }
  };
  walk(src, dst);
}
// docs 镜像: 只处理文件名含 whale-notebook 的 .md; 目标旧文件先清
function mirrorDocs(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`docs 权威源目录不存在: ${srcDir}`);
  const pick = (dir) => fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.md') && /whale-notebook/.test(f))
    : [];
  fs.mkdirSync(dstDir, { recursive: true });
  for (const old of pick(dstDir)) fs.rmSync(path.join(dstDir, old), { force: true });
  for (const f of pick(srcDir)) {
    assertNoPrivate(f);
    fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
  }
}
// scripts 镜像: mine.cjs + redact.test.cjs
function mirrorScripts(srcDir, dstDir) {
  if (!fs.existsSync(srcDir)) throw new Error(`scripts 权威源目录不存在: ${srcDir}`);
  fs.mkdirSync(dstDir, { recursive: true });
  for (const f of ['mine.cjs', 'redact.test.cjs']) {
    const sp = path.join(srcDir, f);
    if (fs.existsSync(sp)) fs.copyFileSync(sp, path.join(dstDir, f));
    else out('warn', `权威源缺 ${f}（跳过）`);
  }
}
// 固定文件镜像(如 PROJECT-INTRO.md)
function mirrorExtraFiles(srcRoot, dstRoot) {
  for (const [rel, dstRel] of Object.entries(EXTRA_FILES)) {
    const sp = path.join(srcRoot, rel);
    const dp = path.join(dstRoot, dstRel);
    assertNoPrivate(path.relative(REPO, dp));
    if (!fs.existsSync(sp)) { out('warn', `权威源缺 ${rel}（跳过）`); continue; }
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.copyFileSync(sp, dp);
  }
}

function main() {
  const argv = process.argv.slice(2);
  const noPush = argv.includes('--no-push');
  const msgIdx = argv.indexOf('--msg');
  const customMsg = msgIdx >= 0 ? argv[msgIdx + 1] : null;

  if (!fs.existsSync(path.join(REPO, '.git'))) {
    out('err', `当前不是 git 仓库: ${REPO}`);
    process.exit(2);
  }
  if (!fs.existsSync(path.join(NB, 'plugin'))) {
    out('err', `权威数据目录缺失: ${NB}`);
    process.exit(2);
  }

  out('info', `发布镜像库: ${REPO}`);
  out('info', `权威源码: ${NB}\\plugin  →  docs: ${DOCS_SRC}  →  scripts: ${NB}\\scripts  →  PROJECT-INTRO: ${NB}\\PROJECT-INTRO.md`);
  try {
    mirrorDir(path.join(NB, 'plugin'), path.join(REPO, 'plugin'));
    mirrorDocs(DOCS_SRC, path.join(REPO, 'docs'));
    mirrorScripts(path.join(NB, 'scripts'), path.join(REPO, 'scripts'));
    mirrorExtraFiles(NB, REPO);
  } catch (e) {
    out('err', `同步失败: ${e.message}`);
    process.exit(1);
  }
  out('ok', '镜像同步完成(目标目录已与权威源逐字节一致)');

  const add = git(['add', '-A']);
  if (add.status !== 0) { out('err', `git add 失败: ${add.stderr || add.stdout}`); process.exit(1); }
  // 取变更清单必须关掉 quotepath 并用 -z 分隔: 否则非 ASCII 文件名被转义成 \346\226\207…,
  // 且 Windows 的 path.basename 会把转义里的反斜杠当路径分隔符, 摘要里出现 "222.md\"" 这类乱码。
  const names = git(['-c', 'core.quotepath=false', 'diff', '--cached', '--name-only', '-z'])
    .stdout.split('\0').filter(Boolean);
  if (!names.length) {
    out('ok', '无文件变化, 跳过提交与推送');
    return;
  }
  out('info', `变更 ${names.length} 个文件:`);
  for (const n of names.slice(0, 20)) out('info', `  + ${n}`);
  if (names.length > 20) out('info', `  … 另有 ${names.length - 20} 个`);

  const summary = names.slice(0, 8).map((n) => path.basename(n)).join('、');
  const msg = customMsg || `sync: 发布镜像同步 ${names.length} 个文件(${summary}${names.length > 8 ? ' …' : ''}) @ ${now()}`;
  const commit = git(['commit', '-m', msg]);
  if (commit.status !== 0) { out('err', `git commit 失败: ${commit.stderr || commit.stdout}`); process.exit(1); }
  out('ok', `已提交: ${git(['log', '-1', '--oneline']).stdout.trim()}`);

  if (noPush) {
    out('info', '--no-push: 跳过推送; 本地提交就绪');
    return;
  }
  const push = git(['push', 'origin', 'HEAD']);
  if (push.status !== 0) {
    out('err', `git push 失败(可能认证/网络): ${push.stderr || push.stdout}`);
    out('info', '本地提交已保留; 修复后重跑本脚本即可补推(幂等)');
    process.exit(1);
  }
  out('ok', `已推送: ${git(['log', '-1', '--oneline']).stdout.trim()} → origin`);
}

if (require.main === module) main();
module.exports = { mirrorDir, mirrorDocs, mirrorScripts, mirrorExtraFiles };
