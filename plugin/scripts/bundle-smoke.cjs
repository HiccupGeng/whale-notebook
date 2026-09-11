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
// v0.5 内容断言：⚡ 入口受开关控制（默认隐藏）、双卡互跳按钮、⟳ 触发增量扫描
const REQUIRED_V5 = ['/whale/scan', 'apiScan', 'AUTO_VISIBLE', 'btnSolved', 'btnBack'];
for (const s of REQUIRED_V5) {
  if (code.indexOf(s) === -1) throw new Error('bundle 缺少 v0.5 结构: ' + s);
}
if (!/var AUTO_VISIBLE = false/.test(code)) throw new Error('v0.5 约定：AUTO_VISIBLE 默认应为 false（⚡ 入口隐藏）');
// v0.6 内容断言：拉取式——面板必须读取并展示 deferred（暂存数）与取用提示
for (const s of ['deferred', '已暂存', '小本本复盘']) {
  if (code.indexOf(s) === -1) throw new Error('bundle 缺少 v0.6 结构: ' + s);
}
// v0.7 内容断言：同族/相似候选——讨论消息必须带上程序算出的依据，不能只给单条
for (const s of ['/whale/related', 'relatedBlock', '同族证据', '族×']) {
  if (code.indexOf(s) === -1) throw new Error('bundle 缺少 v0.7 结构: ' + s);
}
// v0.7.3 内容断言：讨论落点路由（三态开关 + 固定全局工作区 + 落点写进开局消息）
for (const s of ['GLOBAL_WS', 'planDiscuss', 'ROUTE_MODES', '讨论落点', 'wh-seg-btn', 'ensureGlobalWorkspace', 'resolveDiscussTarget', '本会话工作区：', '__internals']) {
  if (code.indexOf(s) === -1) throw new Error('bundle 缺少 v0.7.3 结构: ' + s);
}
if (!/var discussMode = readRouteMode\(\)/.test(code)) throw new Error('v0.7.3 约定：讨论模式必须从 localStorage 读初值');
// v0.7.3 内容断言：样式节点"谁创建谁回收"——apply 记住本次创建的节点，disposer 只回收它
if (!/var cssNode = ensureCss\(\)/.test(code) || code.indexOf('if (cssNode && cssNode.parentNode) cssNode.parentNode.removeChild(cssNode);') === -1) {
  throw new Error('bundle 缺少 v0.7.3 结构: 样式节点未纳入 disposer（cssNode 创建 + 回收）');
}
// v0.7.3 约定：复用既有样式节点时必须返回 null——否则后一代卸载会误删上一代仍在用的节点
if (code.indexOf('!== null) return null;') === -1) {
  throw new Error('v0.7.3 约定：ensureCss 复用分支必须返回 null（跨代不误删）');
}
console.log('bundle OK: id=' + loaded.id + ', apply=' + typeof out.apply + ', v0.4–v0.7.4 结构完整（⚡隐藏/双卡互跳/⟳增量扫描/暂存提示/同族证据/讨论落点路由/样式回收）');
