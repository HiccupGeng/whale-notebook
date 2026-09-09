// scripts/bundle-smoke.cjs - client bundle 桩执行检查
// 用最小 __ModuleLoader__ 桩加载 lib/client.js，断言注册 id 与 exports.apply；任何意外 require 或顶层异常即失败。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const file = path.join(__dirname, '..', 'lib', 'client.js');
const code = fs.readFileSync(file, 'utf8');
let loaded = null;
const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  window: {},
};
sandbox.window.window = sandbox.window;
sandbox.window.__ModuleLoader__ = {
  load(registration) { loaded = registration; },
};
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: 'client.js' });
if (!loaded) throw new Error('bundle 未调用 __ModuleLoader__.load');
if (loaded.id !== '@deepseek-ai/dsh-whale-notebook') throw new Error('bundle id 不符: ' + loaded.id);
let out;
try {
  out = loaded.factory(function (spec) { throw new Error('bundle 意外 require 了模块: ' + spec); });
} catch (e) { throw new Error('factory 执行失败: ' + e.message); }
if (!out || typeof out.apply !== 'function') throw new Error('exports.apply 缺失');
// v0.4 内容断言：新端点调用与双卡 DOM 结构必须在 bundle 源码中（防手写 bundle 漂移）
const REQUIRED = ['/whale/solved', '/whale/entry?id=', 'wh-card-solved', 'wh-badge2', 'refreshSolved', '已解决'];
for (const s of REQUIRED) {
  if (code.indexOf(s) === -1) throw new Error('bundle 缺少 v0.4 结构: ' + s);
}
console.log('bundle OK: id=' + loaded.id + ', apply=' + typeof out.apply + ', v0.4 结构完整');
