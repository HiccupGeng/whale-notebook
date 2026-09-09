// ui/viewmodel.cjs - 展示层视图模型（纯函数：从 store 出可渲染结构）
// 未来：inbox 面板 / 独立小对话框 / 桌宠气泡全部消费这些形状，不直接碰文件。
'use strict';
const repo = require('../store/repo.cjs');
const { CATEGORY_TITLES } = require('../core/schema.cjs');

// 待审小列表（每条一行；供会话提醒 / GUI 面板 / 桌宠通知共用）
function inboxViewModel() {
  const text = repo.readInboxText();
  const rows = text.split('\n')
    .map((l) => l.match(/^\| (C\d+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/))
    .filter(Boolean)
    .map((m) => ({ id: m[1].trim(), cat: m[2].trim(), n: m[3].trim(), ws: m[4].trim(), text: m[5].trim(), time: m[6].trim() }));
  return { rows, pending: rows.length, headline: `待审核 ${rows.length} 条`, rowsByCat: countBy(rows, (r) => r.cat) };
}

function statsViewModel() {
  const entries = repo.listEntries();
  const active = entries.filter((e) => e.status === 'active');
  return {
    entries: entries.length,
    active: active.length,
    byCategory: countBy(active, (e) => e.category),
    topRules: active.slice().sort((a, b) => b.occurrences - a.occurrences).slice(0, 5).map((e) => ({ id: e.id, rule: e.rule })),
  };
}

// v0.4「已解决墙」视图模型（轻口径：入库 = 已处理；A1 INDEX 墙与 A2 面板共消费本形状）
// 行字段不含正文（现象/根因/对策/验证由 /whale/entry 单独拉取，避免整墙过大）。
function entryLight(e) {
  return {
    id: e.id, title: e.title, category: e.category, rule: e.rule,
    occurrences: e.occurrences, lastSeen: e.lastSeen,
    scope: e.scope || 'global', projects: e.projects || [], workspaces: e.workspaces || [],
  };
}
function solvedViewModel() {
  const entries = repo.listEntries();
  const active = entries.filter((e) => e.status === 'active');
  const globals = active.filter((e) => e.scope !== 'project');
  const proj = active.filter((e) => e.scope === 'project');
  const disabled = entries.filter((e) => e.status !== 'active');
  const byNewest = (a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true });

  const gByCat = {};
  for (const e of globals) (gByCat[e.category] = gByCat[e.category] || []).push(e);
  const catOrder = Object.keys(CATEGORY_TITLES);
  const global = Object.keys(gByCat)
    .sort((x, y) => (catOrder.indexOf(x) - catOrder.indexOf(y)) || String(x).localeCompare(y))
    .map((cat) => ({ cat, title: CATEGORY_TITLES[cat] || cat, entries: gByCat[cat].slice().sort(byNewest).map(entryLight) }));

  const byWs = {};
  for (const e of proj) {
    const wss = (e.projects && e.projects.length) ? e.projects : ['?'];
    for (const ws of wss) (byWs[ws] = byWs[ws] || []).push(e);
  }
  const projects = Object.keys(byWs).sort().map((ws) => ({ ws, entries: byWs[ws].slice().sort(byNewest).map(entryLight) }));

  return {
    stats: {
      active: active.length, global: globals.length, project: proj.length, disabled: disabled.length,
    },
    global,
    projects,
    disabled: disabled.slice().sort(byNewest).map(entryLight),
  };
}

function countBy(items, f) {
  const m = {};
  for (const it of items) { const k = f(it); m[k] = (m[k] || 0) + 1; }
  return m;
}

module.exports = { inboxViewModel, statsViewModel, solvedViewModel };
