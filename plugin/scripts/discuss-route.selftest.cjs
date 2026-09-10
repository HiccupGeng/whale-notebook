// scripts/discuss-route.selftest.cjs - v0.7.3 讨论落点路由自测
// 手法：与 bundle-smoke 相同的 __ModuleLoader__ 桩加载 lib/client.js，取 exports.__internals 里的纯函数做判定表断言。
// （bundle 手写且零 require，无法从外部直接 import；把纯函数挂在 __internals 上是唯一的可测缝隙。）
// 覆盖：路径末段 / 工作区列解析 / 名字→工作区（含同名歧义不猜）/ 三种模式的判定表 / localStorage 记忆的降级。
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
if (!I) throw new Error('bundle 未导出 __internals（v0.7.3 自测缝隙缺失）');

let fails = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log('PASS ' + name);
  else { fails++; console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); }
}

// ---- 测试用工作区列表（末段 Proj 故意重复：同名歧义必须不猜）----
const ITEMS = [
  { workspaceId: 'w-sandbox', path: 'C:\\DeepSeekHarnes\\SandBox1', title: 'SandBox1', sessionIds: [] },
  { workspaceId: 'w-st', path: 'C:\\ClaudeCode\\SillyTavern-Agent', title: 'SillyTavern-Agent', sessionIds: [] },
  { workspaceId: 'w-dup1', path: 'C:\\a\\Proj', title: 'Proj', sessionIds: [] },
  { workspaceId: 'w-dup2', path: 'C:\\b\\Proj', title: 'Proj', sessionIds: [] },
];

// ---- 常量 ----
check('全局工作区常量形状（name/path/title）',
  I.GLOBAL_WS.name === 'WhaleGlobal' && I.GLOBAL_WS.path === 'C:\\DeepSeekHarnes\\WhaleGlobal' && !!I.GLOBAL_WS.title,
  I.GLOBAL_WS);
check('三态开关模式齐全且默认自动在最前',
  I.ROUTE_MODES.length === 3
  && I.ROUTE_MODES.map((m) => m.key).join(',') === 'auto,global,project'
  && I.ROUTE_MODES.every((m) => !!m.text && !!m.title),
  I.ROUTE_MODES);

// ---- baseName ----
check('baseName 去 Windows 末段', I.baseName('C:\\DeepSeekHarnes\\SandBox1') === 'SandBox1');
check('baseName 兼容 POSIX 与尾斜杠', I.baseName('/home/x/proj/') === 'proj');
check('baseName 空值安全', I.baseName(undefined) === '' && I.baseName(null) === '');

// ---- wsNamesOf（候选行第 4 列）----
check('单一工作区名', I.wsNamesOf('SandBox1').join('|') === 'SandBox1');
check('半角逗号 = 两个工作区', I.wsNamesOf('SandBox1,SillyTavern-Agent').length === 2);
check('全角逗号同样识别', I.wsNamesOf('SandBox1，SillyTavern-Agent').length === 2);
check('未知值 "?" 不算工作区', I.wsNamesOf('?').length === 0);
check('空串不算工作区', I.wsNamesOf('').length === 0 && I.wsNamesOf(undefined).length === 0);

// ---- findWorkspace ----
check('名字命中唯一工作区', (I.findWorkspace(ITEMS, 'SandBox1') || {}).workspaceId === 'w-sandbox');
check('未注册返回 null（不猜）', I.findWorkspace(ITEMS, 'NoSuchWs') === null);
check('同名歧义返回 null（不猜）', I.findWorkspace(ITEMS, 'Proj') === null);

// ---- planDiscuss（自动）----
const pA = I.planDiscuss({ ws: 'SandBox1' }, ITEMS, 'auto');
check('自动·单项目 → 该项目工作区', pA.kind === 'project' && pA.ws.workspaceId === 'w-sandbox', pA);
const pB = I.planDiscuss({ ws: 'SandBox1,SillyTavern-Agent' }, ITEMS, 'auto');
check('自动·≥2 个工作区 → 全局', pB.kind === 'global', pB);
const pC = I.planDiscuss({ ws: '?' }, ITEMS, 'auto');
check('自动·工作区未知 → 全局（保守）', pC.kind === 'global', pC);
const pD = I.planDiscuss({ ws: 'NoSuchWs' }, ITEMS, 'auto');
check('自动·未注册工作区 → 回退当前', pD.kind === 'current', pD);
const pE = I.planDiscuss({ ws: 'Proj' }, ITEMS, 'auto');
check('自动·同名歧义 → 回退当前', pE.kind === 'current', pE);

// ---- planDiscuss（手动覆盖）----
const pF = I.planDiscuss({ ws: 'SandBox1' }, ITEMS, 'global');
check('手动·强制全局 覆盖自动判定', pF.kind === 'global', pF);
const pG = I.planDiscuss({ ws: 'SandBox1,SillyTavern-Agent' }, ITEMS, 'project');
check('手动·强制项目 取候选首个工作区', pG.kind === 'project' && pG.ws.workspaceId === 'w-sandbox', pG);
const pH = I.planDiscuss({ ws: '?' }, ITEMS, 'project');
check('手动·强制项目 但工作区未知 → 回退当前', pH.kind === 'current', pH);
const pI = I.planDiscuss({ ws: 'NoSuchWs' }, ITEMS, 'project');
check('手动·强制项目 但未注册 → 回退当前', pI.kind === 'current', pI);

// ---- 每个决定都必须带可读依据（toast 与开局消息都依赖它）----
const plans = [pA, pB, pC, pD, pE, pF, pG, pH, pI];
check('九种判定都带非空 reason', plans.every((p) => typeof p.reason === 'string' && p.reason.length > 0),
  plans.map((p) => p.reason));

// ---- localStorage 记忆 + 降级 ----
check('无 localStorage → 默认自动', I.readRouteMode() === 'auto');
sandbox.window.localStorage = { getItem: () => 'project', setItem: () => {} };
check('读到已存模式', I.readRouteMode() === 'project');
sandbox.window.localStorage = { getItem: () => 'bogus', setItem: () => {} };
check('非法存量值 → 退回自动', I.readRouteMode() === 'auto');
sandbox.window.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
check('storage 抛错 → 读取降级自动且写入不抛', I.readRouteMode() === 'auto' && (I.writeRouteMode('global'), true));
let stored = null;
sandbox.window.localStorage = { getItem: () => stored, setItem: (k, v) => { stored = v; } };
I.writeRouteMode('global');
check('写入后能读回', stored === 'global' && I.readRouteMode() === 'global');

console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS（v0.7.3 讨论落点路由 ' + total + ' 项断言）');
process.exit(fails ? 1 : 0);
