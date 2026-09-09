// ui/viewmodel.cjs - 展示层视图模型（纯函数：从 store 出可渲染结构）
// 未来：inbox 面板 / 独立小对话框 / 桌宠气泡全部消费这些形状，不直接碰文件。
'use strict';
const repo = require('../store/repo.cjs');

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

function countBy(items, f) {
  const m = {};
  for (const it of items) { const k = f(it); m[k] = (m[k] || 0) + 1; }
  return m;
}

module.exports = { inboxViewModel, statsViewModel };
