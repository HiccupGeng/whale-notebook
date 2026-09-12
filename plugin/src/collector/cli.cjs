// collector/cli.cjs - 采集 CLI（只供 scripts/mine.cjs 兼容薄壳复用）
// v0.7.3 边界：本模块与 engine.runScan 都是纯函数（返回 {ok,text,data}，不设 process.exitCode）——
//   退出码由进程入口 scripts/mine.cjs 统一给出；宿主半边 POST /whale/scan 走 engine.runScan，不经此处。
// 用法：node scripts/mine.cjs [--check|--add|--rebuild|--stats|--prewarm] [--full] [--dry]
//   --check    增量扫描（默认；未更新的会话日志只 stat 跳过）
//               autoAdd=true 时直接入箱；autoAdd=false（v0.6 拉取式）时只暂存 state.deferred
//   --add      把暂存摘要冲入待审箱（用户说「小本本复盘」时执行）；不重新扫描
//               --check/--rebuild 后跟 --add = 扫完直接入箱（一条命令）
//   --rebuild  清空水位线/指纹/聚簇/暂存后**从头梳理全部历史**（重新发现所有坑；编号继续递增）
//   --full     忽略水位线，全量重扫但仍按指纹去重（已报告过的不会重复进箱）
//   --dry      只报结果不落盘（含不写 state）
//   --stats    全量统计，纯只读（v0.5 起不再写 state —— 旧版会静默吞掉候选）
//   --prewarm  只记指纹与水位线不入箱（会消费这批候选，输出含警告）
//   --forget-echo [--apply]
//              清掉暂存里的自引用/探针回声（v0.7.6；默认干跑列清单，--apply 才删）
'use strict';
const repo = require('../store/repo.cjs');
const engine = require('./engine.cjs');
const { runScan } = engine;
const { listEntries } = repo;
const agents = require('../inject/agents.cjs');

const MODES = ['--check', '--add', '--rebuild', '--stats', '--prewarm'];

function run(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const flags = new Set(args);
  if (flags.has('--forget-echo')) {
    // v0.7.6（数据修复）：清掉暂存里的自引用/探针回声（历史签名不全留下的污染）。
    //   默认**只干跑**列清单；--apply 才真删（写路径与其它命令一致：持锁 + 原子写）。
    const apply = flags.has('--apply');
    const state = repo.readState();
    const out = engine.forgetEchoDeferred(state, repo.readSettings(), { apply });
    const L = [];
    L.push(`== 暂存里的自引用回声（${apply ? '已删除' : '干跑'}）: 命中 ${out.hits.length} 条 / 剩余暂存 ${out.remaining} 组 ==`);
    for (const h of out.hits) L.push(`  ${h.hash} | ${h.cat} | n=${h.n} | ${h.text}`);
    L.push(apply ? '已写回 state.json（真正被删掉的是"我们自己的探针输出"，真实故障不受影响）' : '干跑完成：要真删请加 --apply');
    const text = L.join('\n');
    if (apply) {
      const release = repo.acquireLockSync(1500);
      if (!release) return { ok: false, text: '写入锁不可用（另一个采集进程正在写盘），请稍后重试' };
      try { repo.writeState(state); } finally { release(); }
    }
    console.log(text);
    return { ok: true, text, data: out };
  }
  if (flags.has('--render-rules')) {
    // 预览：当前 active 条目 → AGENTS.md 自动段正文（agent 入库前先看它保证格式一致）
    const settings = repo.readSettings();
    const entries = listEntries();
    const body = agents.buildSectionBody(entries, settings);
    console.log(body);
    return { ok: true, text: body };
  }
  if (flags.has('--wall')) {
    // v0.4 预览：当前条目 → INDEX.md「已解决墙」正文（dry：只打印，落盘由 agent 展示确认后写）
    const text = repo.buildIndexMd(listEntries());
    console.log(text);
    return { ok: true, text };
  }
  const mode = args.find((a) => MODES.includes(a)) || '--check';
  // --add 与 --check/--rebuild 连用 = 「扫完直接入箱」（否则拉取式下只暂存）
  const out = runScan(mode, { full: flags.has('--full'), dry: flags.has('--dry'), add: flags.has('--add') });
  if (out.ok) console.log(out.text);
  else console.error(out.text);
  return out;
}

module.exports = { run, MODES };
