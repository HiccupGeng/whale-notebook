// scripts/panel-actions.selftest.cjs - v0.7.8 面板两个新入口的纯函数自测
// 手法：与 bundle-smoke/discuss-route 相同的 __ModuleLoader__ 桩加载 lib/client.js，
//       取 exports.__internals 里的纯函数做判定表断言（bundle 手写且零 require，这是唯一可测缝隙）。
// 覆盖：自动收集两态表 · 面板记忆 pin 的三态降级 · 深掘结果行 · 深掘开局消息（统计/清单上限/只读约束/落点）
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(file, 'utf8');
let loaded = null;
const sandbox = { console, setTimeout, clearTimeout, window: {} };
sandbox.window.window = sandbox.window;
sandbox.window.__ModuleLoader__ = { load(registration) { loaded = registration; } };
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
if (!loaded) throw new Error('bundle 未调用 __ModuleLoader__.load');
const out = loaded.factory(function (spec) { throw new Error('bundle 意外 require 了模块: ' + spec); });
const I = out.__internals;
if (!I) throw new Error('bundle 未导出 __internals（自测缝隙缺失）');

let fails = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log('PASS ' + name);
  else { fails++; console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))); }
}

// ---- 自动收集两态表（开关的语义完全由它承载，不许含糊）----
check('自动收集两态齐全且顺序固定（自动入箱 → 仅暂存）',
  I.SETTINGS_MODES.length === 2 && I.SETTINGS_MODES.map((m) => m.key).join(',') === 'auto,pull'
  && I.SETTINGS_MODES.map((m) => m.text).join(',') === '自动入箱,仅暂存',
  I.SETTINGS_MODES);
check('两态与 settings.autoAdd 的布尔值一一对应（auto=true / pull=false）',
  I.SETTINGS_MODES[0].value === true && I.SETTINGS_MODES[1].value === false,
  I.SETTINGS_MODES.map((m) => m.value));
check('两态都带可读说明（title 非空）', I.SETTINGS_MODES.every((m) => typeof m.title === 'string' && m.title.length > 10), I.SETTINGS_MODES.map((m) => m.title));

// ---- 面板记忆 pin：三态降级（有 storage / 无 storage / storage 抛错）----
check('pin 键名稳定（跨版本记忆不丢）', I.PIN_KEY === 'whale.panelPin', I.PIN_KEY);
check('无 localStorage → 未固定（保持原有"不打扰"行为）', I.readPin() === false);
sandbox.window.localStorage = { getItem: () => '1', setItem: () => {} };
check('读到已固定', I.readPin() === true);
sandbox.window.localStorage = { getItem: () => 'bogus', setItem: () => {} };
check('非法存量值 → 视为未固定（不猜）', I.readPin() === false);
sandbox.window.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
check('storage 抛错 → 读取降级 false 且写入不抛', I.readPin() === false && (I.writePin(true), true));
let pinned = null;
sandbox.window.localStorage = { getItem: () => pinned, setItem: (k, v) => { pinned = v; } };
I.writePin(true);
check('写入后能读回（pin 生效）', pinned === '1' && I.readPin() === true);
I.writePin(false);
check('可取消 pin', pinned === '0' && I.readPin() === false);

// ---- 深掘轮询参数（不能把宿主打死：间隔 ≥1s、上限 ≤5 分钟）----
check('深掘轮询间隔与上限合理', I.SWEEP_POLL_MS >= 1000 && I.SWEEP_POLL_MS <= 5000 && I.SWEEP_POLL_MAX >= 20 && I.SWEEP_POLL_MAX * I.SWEEP_POLL_MS <= 300000,
  { ms: I.SWEEP_POLL_MS, max: I.SWEEP_POLL_MAX });

// ---- 深掘结果行（页脚那一行的口径）----
const J = {
  ok: true, added: 3, bumped: 5, suppressed: 2, dropped: 0, echo: 4, echoEvents: 12,
  pending: 12, ms: 11487, flush: { added: 7, bumped: 0, remaining: 0 },
  scan: { files: 32, scanned: 32, skipped: 0, readBytes: 54815000, ms: 11400 },
};
const sum = I.sweepSummaryText(J);
check('结果行含新开/累加/MB/秒', sum.indexOf('新开 3') !== -1 && sum.indexOf('累加 5') !== -1 && sum.indexOf('52.28MB') !== -1 && sum.indexOf('11.5s') !== -1, sum);
check('结果行前缀只有一个 ⛏（不重复刷图标）', (sum.match(/⛏/g) || []).length === 1, sum);
check('结果行含压掉与回声过滤', sum.indexOf('压掉 2') !== -1 && sum.indexOf('回声过滤 4 组') !== -1, sum);
check('结果行在无压掉/回声时不啰嗦', I.sweepSummaryText({ added: 0, bumped: 0, ms: 0, scan: {} }).indexOf('压掉') === -1, I.sweepSummaryText({ added: 0, bumped: 0, ms: 0, scan: {} }));
check('结果行在 dropped>0 时显式告警（不静默丢件）', I.sweepSummaryText(Object.assign({}, J, { dropped: 9 })).indexOf('超上限丢弃 9') !== -1, I.sweepSummaryText(Object.assign({}, J, { dropped: 9 })));
check('空数据不抛错（宿主端点异常时不炸面板）', I.sweepSummaryText(null) === '' && typeof I.sweepSummaryText({}) === 'string');

// ---- 深掘开局消息（自动开的新会话里那份任务书）----
const ROWS = [];
for (let i = 0; i < 25; i++) {
  ROWS.push({ id: 'C' + String(120 + i).padStart(3, '0'), cat: i % 2 ? 'encoding' : 'git-net', n: i + 1, ws: i % 3 ? 'SandBox1' : 'SandBox1,WhaleGlobal', text: '现象样本 #' + i, variants: 1 });
}
const route = { label: '鲸鱼全局', reason: '历史深掘跨全部工作区' };
const msg = I.sweepMessage(J, ROWS, route);
check('消息非空且带固定抬头', typeof msg === 'string' && msg.indexOf('【小本本·历史深掘】') === 0, msg && msg.slice(0, 40));
check('消息含扫描统计（文件数/体积/耗时）', msg.indexOf('32 个会话日志') !== -1 && msg.indexOf('52.28MB') !== -1 && msg.indexOf('11.5s') !== -1, msg);
check('消息含入箱/累加/压掉/回声四个数字', msg.indexOf('新开候选 3 条') !== -1 && msg.indexOf('累加已有候选 5 条') !== -1 && msg.indexOf('压掉 2 条') !== -1 && msg.indexOf('回声过滤 4 组') !== -1, msg);
check('消息含暂存冲入数（阶段①的保底成果）', msg.indexOf('另有暂存冲入 7 条') !== -1, msg);
check('消息含待审总数与落点依据', msg.indexOf('待审箱现有 12 条候选') !== -1 && msg.indexOf('本会话工作区：鲸鱼全局') !== -1 && msg.indexOf('历史深掘跨全部工作区') !== -1, msg);
check('清单最多 20 条 + 其余只报数量（省 token）',
  msg.indexOf('C120｜') !== -1 && msg.indexOf('C139｜') !== -1 && msg.indexOf('C140｜') === -1 && msg.indexOf('…另有 5 条') !== -1, msg);
check('消息要求按技能流程复盘', msg.indexOf('whale-notebook') !== -1 && msg.indexOf('总览') !== -1 && msg.indexOf('同族合并建议') !== -1 && msg.indexOf('scope') !== -1, msg);
check('只读约束齐备（不写 entries/INDEX/AGENTS/inbox）',
  msg.indexOf('只读分析') !== -1 && msg.indexOf('不要写 entries') !== -1 && msg.indexOf('INDEX.md') !== -1
  && msg.indexOf('AGENTS.md') !== -1 && msg.indexOf('inbox.md') !== -1, msg);
check('消息禁止重复全量重建（只允许增量补扫）', msg.indexOf('不要重复运行') !== -1 && msg.indexOf('--rebuild') !== -1 && msg.indexOf('--check') !== -1, msg);
check('dropped=0 时不出告警行', msg.indexOf('超上限') === -1, msg);
const msgDrop = I.sweepMessage(Object.assign({}, J, { dropped: 4 }), ROWS, route);
check('dropped>0 时明确要求告知用户', msgDrop.indexOf('单轮上限') !== -1 && msgDrop.indexOf('4 组') !== -1 && msgDrop.indexOf('告诉用户') !== -1, msgDrop.split('\n').filter((l) => l.indexOf('单轮上限') !== -1)[0]);
check('空 rows / 空 route 不抛错（降级可用）',
  typeof I.sweepMessage(J, [], null) === 'string' && I.sweepMessage(J, [], null).indexOf('候选清单') === -1
  && typeof I.sweepMessage(J, ROWS, {}) === 'string', null);
check('无数据时返回 null（调用方据此中止开会话）', I.sweepMessage(null, ROWS, route) === null);

console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS（v0.7.8 面板两个新入口 ' + total + ' 项断言）');
process.exit(fails ? 1 : 0);
