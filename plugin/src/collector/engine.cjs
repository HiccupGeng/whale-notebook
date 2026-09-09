// collector/engine.cjs - 采集引擎：扫描→指纹去重→(check) 聚簇追加待审行
// 行为与 v1 mine.cjs 完全一致；输出结构化结果供 cli / ui / 未来插件复用。
'use strict';
const fs = require('fs');
const path = require('path');
const repo = require('../store/repo.cjs');
const { redact, hash36, canonText } = require('../core/privacy.cjs');
const { fmtTime } = require('../core/util.cjs');
const { PAT_IDS } = require('./patterns.cjs');
const { collectEvents } = require('./scanner.cjs');
const { INBOX_HEADER, inboxRow } = require('../core/schema.cjs');

function clusterKey(ev) {
  let body = canonText(ev.text);
  if (ev.cat === 'error') body = body.replace(/^error:\s*/, '').replace(/error:\s*/, '');
  return `${ev.cat}|${ev.tool}|${body}`;
}
function fpOf(ev, key) {
  return `${ev.sid}|${ev.at}|${hash36(key)}`;
}
function findWorkspaceDirs(settings) {
  const denylist = settings.denylistWorkspaces || [];
  const dirs = [];
  for (const d of fs.readdirSync(repo.P.sessions)) {
    const full = path.join(repo.P.sessions, d);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (denylist.some((x) => d.includes(x) || x.includes(d))) continue;
    const has = fs.readdirSync(full).some((s) => fs.existsSync(path.join(full, s, 'session.jsonl.zstd')));
    if (has) dirs.push(full);
  }
  return dirs;
}

// mode: '--check'(默认) | '--prewarm' | '--stats'
function runScan(mode) {
  const t0 = Date.now();
  if (!fs.existsSync(repo.P.sessions)) return { ok: false, text: 'no sessions root' };
  if (!fs.existsSync(repo.P.nb)) return { ok: false, text: 'whale-notebook dir missing: ' + repo.P.nb };
  const settings = repo.readSettings();
  const state = repo.readState();
  const seen = new Set(state.seenFingerprints || []);
  const wsDirs = findWorkspaceDirs(settings);
  const events = [];
  for (const dir of wsDirs) {
    for (const sid of fs.readdirSync(dir)) {
      const file = path.join(dir, sid, 'session.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      try { events.push(...collectEvents(file)); } catch { /* 单文件解码失败跳过 */ }
    }
  }
  events.sort((a, b) => a.at - b.at);
  const fresh = [];
  for (const ev of events) {
    const key = clusterKey(ev);
    const f = fpOf(ev, key);
    if (!seen.has(f)) { seen.add(f); fresh.push({ ...ev, key }); }
  }
  state.seenFingerprints = [...seen];
  state.lastScan = Date.now();

  if (mode === '--prewarm') {
    repo.writeState(state);
    const ms = Date.now() - t0;
    return { ok: true, text: `prewarm ok: scanned ${events.length} events, recorded ${fresh.length} new fingerprints (${wsDirs.length} workspaces)`, data: { events: events.length, fresh: fresh.length, workspaces: wsDirs.length, ms } };
  }

  const catCount = {};
  for (const ev of events) {
    catCount[ev.cat] = catCount[ev.cat] || { n: 0, ws: new Set(), first: ev.at, last: ev.at };
    const c = catCount[ev.cat];
    c.n++; c.ws.add(ev.ws);
    if (ev.at < c.first) c.first = ev.at;
    if (ev.at > c.last) c.last = ev.at;
  }
  if (mode === '--stats') {
    repo.writeState(state);
    const lines = [];
    lines.push('== whale-notebook 全量统计 ==');
    lines.push(`工作区: ${wsDirs.length} | 事件(工具失败/特征+用户报障): ${events.length} | 去重指纹: ${seen.size}`);
    for (const [cat, c] of Object.entries(catCount).sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`  ${cat}: ${c.n} 次 | 工作区: ${[...c.ws].slice(0, 3).join(', ')} | ${fmtTime(c.first)} ~ ${fmtTime(c.last)}`);
    }
    return { ok: true, text: lines.join('\n'), data: { events: events.length, byCat: catCount } };
  }

  // 默认 --check: 新事件按聚簇聚合为待审行
  const rows = [];
  const rowMap = new Map();
  for (const ev of fresh) {
    if (ev.cat !== 'error' && !PAT_IDS.has(ev.cat)) continue;
    const existing = rowMap.get(ev.key);
    if (existing) {
      existing.n++; existing.last = ev.at; existing.wsSet.add(ev.ws);
    } else {
      rowMap.set(ev.key, { key: ev.key, cat: ev.cat, tool: ev.tool, n: 1, first: ev.at, last: ev.at, wsSet: new Set([ev.ws]), text: redact(ev.text).slice(0, 160) });
    }
  }
  for (const r of rowMap.values()) rows.push(r);
  rows.sort((a, b) => a.first - b.first);
  const minOcc = settings.minOccurrences ?? 1;
  const added = rows.filter((r) => r.n >= minOcc).slice(0, 30);

  let inboxOld = repo.readInboxText();
  const pendingCount = repo.pendingCount(inboxOld);
  if (added.length) {
    const header = inboxOld.trim() ? '' : INBOX_HEADER + '\n';
    const parts = [];
    for (const r of added) {
      parts.push(inboxRow(state.nextCandidateId++, { cat: r.cat, n: r.n, wsSet: r.wsSet, text: r.text.slice(0, 120), time: fmtTime(r.first) }));
    }
    fs.writeFileSync(repo.P.inbox, inboxOld.trimEnd() + (inboxOld.trim() ? '\n' : '') + header + parts.join('\n') + '\n', 'utf8');
  }
  repo.writeState(state);
  const total = pendingCount + added.length;
  const ms = Date.now() - t0;
  return {
    ok: true,
    text: `新发现 ${added.length} 条(${added.map((r) => r.cat).join(',') || '无'}) | 待审共 ${total} 条 | 扫描 ${ms}ms`,
    data: { added: added.map((r) => ({ cat: r.cat, n: r.n })), pending: total, ms },
  };
}

module.exports = { runScan, clusterKey, fpOf, findWorkspaceDirs };
