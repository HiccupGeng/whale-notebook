// scripts/links-doctor.cjs - 小本本维护工具：工具主目录的「悬空链接」体检与清理
//
// 为什么需要它：dsh 升级 / pnpm(npx) 重装会重写 profiles/node_modules，包缓存被清后留下指向
// 不存在目标的 junction/symlink（死链）。这类死链单看无害（解析本来就取不到），但会让一切
// 「跟随式」遍历整体失败——ripgrep 搜索模式对它们报 walk 错误并以 exit 2 结束，而 grep 工具把
// 非 0/1 退出码一律判失败 → 整次检索的结果被丢弃（经验见条目 E005）；复制/备份/索引同理。
//
// 用法（默认根 = DSH home，跳过 sessions 与 .git）:
//   node scripts/links-doctor.cjs                 # 只读体检（不写任何东西）
//   node scripts/links-doctor.cjs --json          # 机器可读输出
//   node scripts/links-doctor.cjs --root <dir>    # 指定扫描根（--apply 只删该根之内的条目）
//   node scripts/links-doctor.cjs --depth <n>     # 最大递归深度（默认 6；只跟随实体目录，不跟随链接）
//   node scripts/links-doctor.cjs --apply         # 删除悬空链接（逐条复验后才删；只摘链接、绝不递归进目标）
//   node scripts/links-doctor.cjs --help
//
// 退出码：0 = 无悬空（或 --apply 后已清零）｜3 = 体检发现悬空（仅 dry）｜1 = 用法/IO 错误或删除后有残留
//
// 安全边界（硬规则，勿放宽）：
//   ① 只处理「lstat = 符号链接/junction 且跟随式 stat 报 ENOENT/ENOTDIR」的条目；
//   ② 路径必须落在扫描根之内（内外一律跳过并计数）；
//   ③ 实体目录、仍有效的链接、普通文件一律不碰；
//   ④ 删除只摘链接本身（rmdir → unlink → `cmd /c rmdir` 兜底），不做任何递归删除。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_SKIP = new Set(['sessions', '.git']);
const DEFAULT_DEPTH = 6;
const MAX_LIST_LINES = 500;

function defaultRoot() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

// 路径是否在根之内（Windows 大小写不敏感；根自身也算在内）
function isUnder(root, p) {
  const r = path.resolve(root);
  const t = path.resolve(p);
  const cmp = process.platform === 'win32' ? (s) => s.toLowerCase() : (s) => s;
  const a = cmp(r);
  const b = cmp(t);
  return b === a || b.startsWith(a.endsWith(path.sep) ? a : a + path.sep);
}

// 只读扫描：返回 { root, links, dangling, realDirs, skipped, outside, errors }
//   links    = 扫描到的链接总数；dangling = 其中跟随式 stat 失败（死链）的绝对路径
//   只对实体目录递归（depth 上限），不跟随链接 → 不会走进链接目标，也不会被死链卡住
function scanDangling(root, opts = {}) {
  const resolved = path.resolve(root);
  const maxDepth = Number.isFinite(opts.depth) ? opts.depth : DEFAULT_DEPTH;
  const skip = opts.skip instanceof Set ? opts.skip : DEFAULT_SKIP;
  const out = { root: resolved, links: 0, dangling: [], realDirs: 0, skipped: [], outside: 0, errors: [] };
  if (!fs.existsSync(resolved)) {
    out.errors.push({ path: resolved, code: 'ENOENT', message: 'scan root does not exist' });
    return out;
  }
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      out.errors.push({ path: dir, code: error.code || 'EUNKNOWN', message: String(error.message || error).slice(0, 160) });
      return;
    }
    for (const entry of entries) {
      const p = path.join(dir, entry.name);
      if (depth === 0 && skip.has(entry.name)) { out.skipped.push(p); continue; }
      if (!isUnder(resolved, p)) { out.outside++; continue; }
      let st;
      try {
        st = fs.lstatSync(p);
      } catch (error) {
        out.errors.push({ path: p, code: error.code || 'EUNKNOWN', message: String(error.message || error).slice(0, 160) });
        continue;
      }
      if (st.isSymbolicLink()) {
        out.links++;
        try {
          fs.statSync(p); // 跟随：悬空链接在这里抛 ENOENT/ENOTDIR
        } catch (error) {
          if (error.code === 'ENOENT' || error.code === 'ENOTDIR') out.dangling.push(p);
          else out.errors.push({ path: p, code: error.code || 'EUNKNOWN', message: String(error.message || error).slice(0, 160) });
        }
      } else if (st.isDirectory()) {
        out.realDirs++;
        if (depth + 1 <= maxDepth) walk(p, depth + 1);
      }
    }
  };
  walk(resolved, 0);
  out.dangling.sort();
  return out;
}

// 删除悬空链接：删除前逐条复验（仍是链接 + 仍悬空 + 仍在根内），返回 { removed, failed, kept }
function removeLinks(paths, opts = {}) {
  const root = opts.root !== undefined ? path.resolve(opts.root) : undefined;
  const removed = [];
  const failed = [];
  const kept = [];
  for (const p of paths) {
    if (root !== undefined && !isUnder(root, p)) { kept.push({ path: p, reason: 'outside-root' }); continue; }
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (error) {
      kept.push({ path: p, reason: 'already-gone' });
      continue;
    }
    if (!st.isSymbolicLink()) { kept.push({ path: p, reason: 'not-a-link' }); continue; }
    try {
      fs.statSync(p);
      kept.push({ path: p, reason: 'target-resolves-now' }); // 期间被修复 → 不动
      continue;
    } catch { /* 仍悬空 → 可删 */ }
    let ok = false;
    let last = '';
    try { fs.rmdirSync(p); ok = true; } catch (error) { last = String(error.code || error.message); }
    if (!ok) { try { fs.unlinkSync(p); ok = true; } catch (error) { last = String(error.code || error.message); } }
    if (!ok && process.platform === 'win32') {
      const r = spawnSync('cmd', ['/c', 'rmdir', p], { windowsHide: true, encoding: 'utf8' });
      ok = r.status === 0;
      if (!ok) last = String(r.stderr || '').trim().slice(0, 160) || 'rmdir failed';
    }
    if (ok) removed.push(p); else failed.push({ path: p, code: last || 'EUNKNOWN' });
  }
  return { removed, failed, kept };
}

function parseArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const out = { apply: false, json: false, help: false, root: undefined, depth: DEFAULT_DEPTH };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--apply') out.apply = true;
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--root') {
      if (i + 1 >= args.length) return { error: '--root needs a value' };
      out.root = args[++i];
    } else if (a === '--depth') {
      if (i + 1 >= args.length) return { error: '--depth needs a value' };
      out.depth = Number(args[++i]);
    }
    else if (a.startsWith('--root=')) out.root = a.slice(7);
    else if (a.startsWith('--depth=')) out.depth = Number(a.slice(8));
    else return { error: `unknown argument: ${a}` };
  }
  if (out.root !== undefined && (typeof out.root !== 'string' || out.root.trim() === '')) return { error: '--root needs a non-empty directory' };
  if (!Number.isFinite(out.depth) || out.depth < 0) return { error: '--depth needs a non-negative number' };
  return out;
}

const HELP = [
  'links-doctor - 小本本维护工具：工具主目录的悬空链接体检与清理',
  '',
  '用法: node scripts/links-doctor.cjs [--json] [--root <dir>] [--depth <n>] [--apply]',
  '',
  '  默认（无 --apply）只读体检，不动任何文件；--apply 才删除「仍悬空」的链接。',
  '  退出码: 0=无悬空（或已清零）｜3=发现悬空（dry）｜1=用法/IO 错误或删除后有残留',
  '',
  `  默认根 = DSH_HOME 或 ${path.join('~', '.dsh')}，跳过 ${[...DEFAULT_SKIP].join(' / ')}，最大深度 ${DEFAULT_DEPTH}。`,
].join('\n');

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error !== undefined) {
    console.error('[links-doctor] ' + opts.error + '\n\n' + HELP);
    return 1;
  }
  if (opts.help) {
    console.log(HELP);
    return 0;
  }
  const root = opts.root !== undefined ? opts.root : defaultRoot();
  const before = scanDangling(root, { depth: opts.depth });
  if (before.errors.length > 0 && before.links === 0 && before.dangling.length === 0) {
    if (opts.json) console.log(JSON.stringify({ ok: false, root: before.root, errors: before.errors }, null, 1));
    else before.errors.slice(0, 5).forEach((e) => console.error(`[links-doctor] 读取失败 ${e.path} :: ${e.code}`));
    return 1;
  }
  let result = null;
  let after = before;
  if (opts.apply && before.dangling.length > 0) {
    result = removeLinks(before.dangling, { root: before.root });
    after = scanDangling(root, { depth: opts.depth });
  }
  const remaining = after.dangling.length;
  const cleaned = result !== null && result.removed.length > 0;

  if (opts.json) {
    console.log(JSON.stringify({
      ok: remaining === 0 && (result === null || result.failed.length === 0),
      root: before.root,
      depth: opts.depth,
      apply: opts.apply,
      links: before.links,
      realDirs: before.realDirs,
      skipped: before.skipped,
      found: before.dangling,
      removed: result ? result.removed : [],
      failed: result ? result.failed : [],
      kept: result ? result.kept : [],
      remaining: after.dangling,
      errors: before.errors.concat(after.errors),
    }, null, 1));
    if (result !== null && result.failed.length > 0) return 1;
    return remaining === 0 ? 0 : 3;
  }

  console.log(`[links-doctor] 根 = ${before.root}（链接 ${before.links} · 实体目录 ${before.realDirs} · 跳过 ${before.skipped.length} 项 · 深度 ${opts.depth}）`);
  before.errors.slice(0, 5).forEach((e) => console.error(`[links-doctor] 读取失败 ${e.path} :: ${e.code}`));
  if (before.dangling.length === 0) {
    console.log('[links-doctor] 体检通过：没有悬空链接（跟随式遍历不会因此失败）。');
    return 0;
  }
  console.log(`[links-doctor] 发现 ${before.dangling.length} 条悬空链接（目标已不存在）：`);
  before.dangling.slice(0, MAX_LIST_LINES).forEach((p, i) => console.log(String(i + 1).padStart(4) + '  ' + p));
  if (before.dangling.length > MAX_LIST_LINES) console.log(`       … 其余 ${before.dangling.length - MAX_LIST_LINES} 条见 --json`);
  console.log('[links-doctor] 提示：这类死链会让 ripgrep 搜索模式 exit 2、整次检索结果被丢弃（见条目 E005）。');
  if (result === null) {
    console.log('[links-doctor] 仅体检未删除；确认后可加 --apply 清理（只摘链接本身，不碰目标与实体目录）。');
    return 3;
  }
  console.log(`[links-doctor] 已删除 ${result.removed.length} 条${cleaned ? '' : '（无可删项）'}；失败 ${result.failed.length} 条；跳过 ${result.kept.length} 条。`);
  result.failed.slice(0, 5).forEach((f) => console.error(`[links-doctor] 删除失败 ${f.path} :: ${f.code}`));
  result.kept.slice(0, 5).forEach((k) => console.log(`[links-doctor] 跳过 ${k.path}（${k.reason}）`));
  console.log(`[links-doctor] 复查：剩余悬空 ${remaining} 条。`);
  if (result.failed.length > 0 || remaining > 0) return 1;
  console.log('[links-doctor] 清理完成。');
  return 0;
}

module.exports = { scanDangling, removeLinks, isUnder, defaultRoot, parseArgs, DEFAULT_SKIP, DEFAULT_DEPTH, MAX_LIST_LINES, main };

if (require.main === module) process.exit(main(process.argv.slice(2)));
