// lifecycle/consts.cjs - 生命周期子模块: 常量与路径解析（自举约束: 仅 node 内建, 不 require 业务模块）
'use strict';
const path = require('path');
const os = require('os');

const VERSION = '0.2.0'; // v0.2.0（2026-09-12）：check 漂移分级（合法演进=待登记 / 结构损坏=exit 1）+ check --adopt + zones 模式区内容基线
const PLUGIN_NAME = '@deepseek-ai/dsh-whale-notebook';
const AGENTS_FILE = 'AGENTS.md';
const SKILL_FILE = 'whale-notebook.md';
const NB_DIRNAME = 'whale-notebook';
const LC_DIRNAME = '.lifecycle';
const BACKUPS_DIRNAME = 'backups';
const QUARANTINE_DIRNAME = 'quarantine';
const SITE_MANIFEST = 'manifest.json';

// 本模块所在目录的上级 = 插件包根（默认清单 manifest.json 所在处; 运行位置无关, __dirname 固定）
function pkgDir() {
  return path.resolve(__dirname, '..');
}
function defaultManifestPath() {
  return path.join(pkgDir(), 'manifest.json');
}

// DSH_HOME 解析: --home > DSH_HOME env > ~/.dsh
function resolveHome(flagHome) {
  if (flagHome) return path.resolve(flagHome);
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME);
  return path.join(os.homedir(), '.dsh');
}
function resolveNbDir(home) {
  return process.env.DSH_WHALE_NB_DIR ? path.resolve(process.env.DSH_WHALE_NB_DIR) : path.join(home, NB_DIRNAME);
}

function lcDir(home) {
  return path.join(resolveNbDir(home), LC_DIRNAME);
}
function backupsDir(home) {
  return path.join(lcDir(home), BACKUPS_DIRNAME);
}
function quarantineDir(home) {
  return path.join(lcDir(home), QUARANTINE_DIRNAME);
}
function siteManifestPath(home) {
  return path.join(lcDir(home), SITE_MANIFEST);
}

// 路径模板变量替换（清单内 {dshHome} {nbDir} {pkgDir} → 绝对路径）
function resolvePathTpl(tpl, ctx) {
  const vars = {
    '{dshHome}': ctx.home,
    '{nbDir}': ctx.nb,
    '{pkgDir}': ctx.pkg,
  };
  let out = String(tpl);
  for (const k of Object.keys(vars)) out = out.split(k).join(vars[k]);
  return path.resolve(out);
}

// 本地时间戳: 20260909_1630 与 ISO(带 +08:00 偏移)
function pad(n) { return String(n).padStart(2, '0'); }
function localStamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function isoLocal() {
  const d = new Date();
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

// 全新 whole 模式安装的 AGENTS.md 模板（无种子时使用; 内容即当前现场骨架, 含两类标记区）
const AGENTS_TEMPLATE = [
  '# 全局指令（用户级，注入本机每个 DSH 会话）',
  '',
  '本文件由 DSH 的 agent-instructions 机制在每个会话开始时自动注入（含后续变更提醒）。',
  '- 隐私边界：本文件内容会进入每个会话的模型上下文；**只允许放通用规则与对策，禁止放项目业务内容、个人路径、密钥、会话原文**。',
  '- 当前内容由「鲸鱼闪闪发光的小本本（whale-notebook）」项目维护其自动段；手动段留给你自己书写其他全局指令。',
  '',
  '## 手动段（用户自写区）',
  '',
  '（空——可自行追加任何希望每会话生效的指令；不要放进鲸鱼小本本自动段之外的经验规则。）',
  '',
  '<!-- whale-notebook:rules -->',
  '',
  '## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）',
  '',
  '状态：尚未完成首轮经验审核，暂无规则条目。',
  '',
  '<!-- /whale-notebook:rules -->',
  '',
  '<!-- whale-notebook:privacy -->',
  '',
  '## 隐私提示',
  '',
  '- 本条规则写入流程：候选 → 展示 → 用户确认 → 才入库；任何写入前先给用户看将要新增/修改的行。',
  '- 经验条目与规则行只写通用对策；来源仅存会话 ID 作统计溯源，不复制原文。',
  '',
  '<!-- /whale-notebook:privacy -->',
  '',
].join('\n');

const HELP = `dsh-whale-notebook lifecycle ${VERSION} — 安装/卸载/清单机制（第 0 功能, 见 docs/生命周期设计）

用法:
  node plugin/lifecycle/cli.cjs <cmd> [flags]

命令:
  status                      显示阶段/各级足迹/上次操作
  check                       清单 vs 现场对账 + 孤儿扫描（有差异时退出码 1）
  install                     安装/登记（计划式: 默认只出计划, --apply 才执行）
  uninstall <level>           卸载。level = detach|remove|purge
                                 detach: 仅 R 段(运行时足迹 = web 面板部署副本 + 加载器挂载行;
                                         动作由 scripts/deploy-web.cjs --undo 执行, 加 --yes 连副本目录一起删)
                                 remove: R+I 段, D 段原样保留
                                 purge:  R+I+D, 须 --export-dir + --yes
  help

标志:
  --apply                     执行（默认 dry-run 只输出计划）
  --adopt                     （check 用）把 I 段"内容已合法演进"的现场重新登记为基线（不改文件内容）
  --agents-mode whole|zones   AGENTS.md 归属模式（默认 whole = 整文件属本插件）
  --seed-dir <dir>            素材源目录（内含 AGENTS.md / whale-notebook.md,
                              目标缺失时用于创建; 迁移/全新机用）
  --export-dir <dir>          purge 导出目录（必填）
  --yes                       二次确认（purge 必填; remove 遇漂移时也需; detach 时=连副本目录一起删）
  --home <dir>                覆盖 DSH_HOME（沙盒自测用）

约定: 所有写操作先 --dry-run 出计划, 展示给用户确认后再 --apply。`;

module.exports = {
  VERSION, PLUGIN_NAME, AGENTS_FILE, SKILL_FILE, NB_DIRNAME, LC_DIRNAME, BACKUPS_DIRNAME,
  QUARANTINE_DIRNAME, SITE_MANIFEST,
  pkgDir, defaultManifestPath, resolveHome, resolveNbDir, lcDir, backupsDir, quarantineDir,
  siteManifestPath, resolvePathTpl, localStamp, isoLocal, AGENTS_TEMPLATE, HELP,
};
