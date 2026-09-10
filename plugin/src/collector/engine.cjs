// collector/engine.cjs - 采集引擎 v0.5：增量水位线扫描 → 指纹去重 → 聚簇合并/复发 → (check) 入箱
// v0.5 相对 v0.4 的变化：
//   ① 增量：state.files 记每个会话日志的 {size, mtimeMs, offset}；未更新只 stat 跳过，
//      有更新只解 offset 之后的新帧（帧边界续扫，见 decoder.cjs）；末尾半写帧自动留待重试。
//   ② 聚簇索引：state.clusters 以聚簇哈希为键记住候选编号 → 同一坑跨轮次再次出现时【累加次数】
//      而不是新增重复行；候选已被处置（不在 inbox）后再出现 = 复发（新开候选并标「复发（原 C0xx）」，
//      冷却期内只静默计数，避免刷屏）。
//   ③ --stats 变为纯只读（旧版会把 seen 指纹写掉，等于静默吞掉这些候选）；
//      --check 支持 --dry（只看不写）；--full 强制全量；seenFingerprints 按上限截尾不再无限增长。
// 行为契约（v1 不变式）：inbox 行格式、打码、指纹算法、buildDetailMd 内容协议均未变。
'use strict';
const fs = require('fs');
const path = require('path');
const repo = require('../store/repo.cjs');
const { redactLines, hash36, canonText } = require('../core/privacy.cjs');
const { fmtTime } = require('../core/util.cjs');
const { oneLiner } = require('../core/summarize.cjs');
const { PAT_IDS } = require('./patterns.cjs');
const { collectEventsFrom } = require('./scanner.cjs');
const { INBOX_HEADER, inboxRow } = require('../core/schema.cjs');

const DEFAULT_READD_COOLDOWN_DAYS = 7;
const DEFAULT_MAX_FINGERPRINTS = 5000;
const MAX_DETAIL_EVENTS = 16;
const DETAIL_EXCERPT_MAX = 600;

// v0.5.1：回声落档时的列转义（与 core/schema.cell 同规则，避免 `|` 破坏表格）
const escCell = (s) => String(s == null ? '' : s).replace(/\|/g, '｜');

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

// 全部待扫会话日志（含工作区别名过滤）
function sessionFiles(settings) {
  const out = [];
  for (const dir of findWorkspaceDirs(settings)) {
    let names; try { names = fs.readdirSync(dir); } catch { continue; }
    for (const sid of names) {
      const file = path.join(dir, sid, 'session.jsonl.zstd');
      if (fs.existsSync(file)) out.push({ file, sid });
    }
  }
  return out;
}

// 增量/全量扫描：更新 state.files 水位线，返回事件与统计
function scanHistory(state, settings, opts) {
  const t0 = Date.now();
  const full = !!(opts && opts.full);
  const files = sessionFiles(settings);
  const events = [];
  let scanned = 0, skipped = 0, readBytes = 0, resets = 0, retryPending = 0, badFiles = 0;
  for (const f of files) {
    let st; try { st = fs.statSync(f.file); } catch { continue; }
    const wm = state.files[f.file];
    if (!full && wm && wm.size === st.size && wm.mtimeMs === st.mtimeMs) { skipped++; continue; }
    const from = full ? 0 : (wm && Number.isFinite(wm.offset) ? wm.offset : 0);
    let res;
    try { res = collectEventsFrom(f.file, from, full ? null : wm); }
    catch (err) { badFiles++; continue; } // 单文件解码失败跳过（v1 行为）
    if (res.badFrom) {
      resets++; // 水位线失效（截断/轮转）→ 该文件退回全量
      try { res = collectEventsFrom(f.file, 0, null); } catch (err) { badFiles++; continue; }
    }
    scanned++;
    readBytes += Math.max(0, st.size - res.readFrom);
    for (const ev of res.events) events.push(Object.assign({}, ev, { file: f.file }));
    state.files[f.file] = {
      size: st.size,
      mtimeMs: res.partial ? -1 : st.mtimeMs, // 半写/坏帧：下次必扫（从 offset 续，代价只有尾部）
      offset: res.nextOffset,
      frames: res.frames,
      sid: res.sid || f.sid,
      ws: res.ws || (wm && wm.ws) || f.sid,
      calls: res.calls || (wm && wm.calls) || {}, // 跨窗口继承 callId→工具名（否则 tool 退化成 '?'、聚簇键漂移）
    };
    if (res.partial) retryPending++;
  }
  events.sort((a, b) => a.at - b.at);
  return { events, stats: { files: files.length, scanned, skipped, readBytes, resets, retryPending, badFiles, ms: Date.now() - t0 } };
}

// 只记指纹（--prewarm 基线）：返回本轮“被消费”的事件数
function markSeen(state, events, cap) {
  const seen = new Set(state.seenFingerprints || []);
  let fresh = 0;
  for (const ev of events) {
    const f = fpOf(ev, clusterKey(ev));
    if (!seen.has(f)) { seen.add(f); fresh++; }
  }
  let arr = [...seen];
  if (arr.length > cap) arr = arr.slice(-cap);
  state.seenFingerprints = arr;
  return fresh;
}

// 共享入库：指纹去重 → 聚簇合并/复发/新建 → 行与 sidecar 落盘（批扫与实时采集共用）
// opts: { dry, now, maxNewRows }
function ingestFresh(rawEvents, state, settings, opts) {
  const o = opts || {};
  const dry = o.dry === true;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxNewRows = Number.isFinite(o.maxNewRows) ? o.maxNewRows : 30; // v1 行为：单轮最多 30 行
  const cooldownMs = (Number.isFinite(settings.reAddCooldownDays) ? settings.reAddCooldownDays : DEFAULT_READD_COOLDOWN_DAYS) * 86400000;
  const cap = Number.isFinite(settings.maxFingerprints) ? settings.maxFingerprints : DEFAULT_MAX_FINGERPRINTS;
  const seen = new Set(state.seenFingerprints || []);
  const clusters = state.clusters || (state.clusters = {});

  const inboxOld = repo.readInboxText();
  const pendRows = repo.parseInboxRows(inboxOld);
  const pendIds = new Set(pendRows.map((r) => r.id));
  // 自愈：v0.4 时代的候选没有簇索引，同类别+同现象列时认领为同一聚簇（避免升级后第一次复发变重复行）
  const adoptBy = new Map();
  for (const r of pendRows) {
    const k = r.cat + '|' + r.text;
    if (!adoptBy.has(k)) adoptBy.set(k, r.id);
  }

  // ① 事件级指纹去重
  const fresh = [];
  for (const ev of rawEvents) {
    const key = clusterKey(ev);
    const f = fpOf(ev, key);
    if (seen.has(f)) continue;
    seen.add(f);
    fresh.push({ ev, key, hash: hash36(key) });
  }

  // ② 同聚簇聚合（n/时间窗/证据/一句话现象）；v0.5.1 先剔除自引用/探针回声（落档可审计）
  const agg = new Map();
  const echo = new Map(); // hash -> { cat, ws, n, last, text }
  for (const it of fresh) {
    const ev = it.ev;
    if (ev.meta) {
      const e = echo.get(it.hash) || { cat: ev.cat, n: 0, last: ev.at, ws: ev.ws, text: oneLiner(redactLines(ev.text), 90) };
      e.n++;
      if (ev.at > e.last) e.last = ev.at;
      echo.set(it.hash, e);
      continue;
    }
    if (ev.cat !== 'error' && !PAT_IDS.has(ev.cat)) continue;
    const redLines = redactLines(ev.text);
    let a = agg.get(it.hash);
    if (!a) {
      a = { hash: it.hash, cat: ev.cat, text: oneLiner(redLines, 90), n: 0, first: ev.at, last: ev.at, wsSet: new Set(), evs: [], cid: null, kind: 'new', origin: null };
      agg.set(it.hash, a);
    }
    a.n++;
    a.wsSet.add(ev.ws);
    if (ev.at < a.first) a.first = ev.at;
    if (ev.at > a.last) a.last = ev.at;
    if (a.evs.length < MAX_DETAIL_EVENTS) a.evs.push({ sid: ev.sid, at: ev.at, ws: ev.ws, file: ev.file, text: redLines });
  }

  // ③ 结局判定：累加已有候选 / 复发 / 冷却期静默 / 新建
  const decisions = [];
  for (const a of agg.values()) {
    const c = clusters[a.hash];
    if (c) {
      c.n = (c.n || 0) + a.n;
      c.last = Math.max(c.last || 0, a.last);
      if (!c.text) c.text = a.text;
      if (pendIds.has(c.cid)) { a.cid = c.cid; a.kind = 'bump'; decisions.push(a); continue; }
      if (now - (c.reAddedAt || 0) < cooldownMs) { a.cid = c.cid; a.kind = 'silent'; c.silentN = (c.silentN || 0) + a.n; decisions.push(a); continue; }
      a.cid = c.cid; a.origin = c.cid; a.kind = 'readd'; decisions.push(a); continue;
    }
    const adopted = adoptBy.get(a.cat + '|' + a.text);
    if (adopted) {
      clusters[a.hash] = { cid: adopted, cat: a.cat, text: a.text, n: a.n, first: a.first, last: a.last, reAddedAt: 0, reAdds: 0 };
      a.cid = adopted; a.kind = 'bump'; decisions.push(a); continue;
    }
    decisions.push(a);
  }

  // ④ 落盘（dry 时整段跳过；行与 sidecar 一次写入）
  decisions.sort((x, y) => x.first - y.first);
  const added = [];
  const bumped = [];
  const silent = [];
  let dropped = 0;
  const countMap = new Map();
  const newRowLines = [];
  let inboxText = inboxOld;
  for (const a of decisions) {
    if (a.kind === 'bump' || a.kind === 'silent') {
      const c = clusters[a.hash] || {};
      if (a.kind === 'bump') { countMap.set(a.cid, c.n || a.n); bumped.push({ id: a.cid, n: c.n || a.n, added: a.n }); }
      else silent.push({ id: a.cid, added: a.n, n: c.n || a.n });
      if (!dry) repo.appendDetailNote(a.cid, recurrenceNote(a, c, now));
      continue;
    }
    // new / readd（单轮上限：超出的只记指纹不开行，避免噪声刷屏）
    if (added.length >= maxNewRows) { dropped++; continue; }
    const cid = state.nextCandidateId++;
    const id = 'C' + String(cid).padStart(3, '0');
    const total = (clusters[a.hash] && clusters[a.hash].n) || a.n;
    const text = a.kind === 'readd' ? `复发（原 ${a.origin}）：${a.text}` : a.text;
    newRowLines.push(inboxRow(cid, { cat: a.cat, n: total, wsSet: a.wsSet, text: text.slice(0, 120), time: fmtTime(a.first) }));
    clusters[a.hash] = {
      cid: id, cat: a.cat, text: a.text, n: total, first: a.first, last: a.last,
      reAddedAt: a.kind === 'readd' ? now : 0,
      reAdds: a.kind === 'readd' ? (((clusters[a.hash] || {}).reAdds) || 0) + 1 : 0,
    };
    pendIds.add(id);
    added.push({ id, cat: a.cat, n: total, kind: a.kind, text });
    if (!dry) {
      // v0.3：同编号同步写详情 sidecar（源引用 + 打码摘录）；失败不阻断行写入
      try { repo.writeDetail(id, buildDetailMd(cid, a)); } catch (err) { /* detail 写入失败仅告警 */ }
    }
  }
  if (countMap.size) inboxText = repo.bumpInboxRows(inboxText, countMap).text;
  if (newRowLines.length) {
    const header = inboxText.trim() ? '' : INBOX_HEADER + '\n';
    inboxText = inboxText.trimEnd() + (inboxText.trim() ? '\n' : '') + header + newRowLines.join('\n') + '\n';
  }
  if (!dry && (countMap.size || newRowLines.length)) repo.writeInboxText(inboxText);
  // v0.5.1：回声落档（不占待审箱，但留证据可查）
  if (!dry && echo.size) {
    const rows = [...echo.values()].map((e) => `| ${fmtTime(e.last)} | ${e.cat} | ${e.n} | ${escCell(e.ws)} | ${escCell(e.text)} |`);
    try { repo.appendEchoArchive(rows.join('\n')); } catch (err) { /* 落档失败不阻断 */ }
  }

  // ⑤ 状态回写（seen 截尾，防止无限增长）
  let seenArr = [...seen];
  if (seenArr.length > cap) seenArr = seenArr.slice(-cap);
  state.seenFingerprints = seenArr;
  state.clusters = clusters;

  return { added, bumped, silent, dropped, echo: echo.size, echoEvents: [...echo.values()].reduce((a, e) => a + e.n, 0), pending: repo.pendingCount(inboxText), fresh: fresh.length, dry };
}

function recurrenceNote(a, c, now) {
  const ws = [...a.wsSet].slice(0, 2).join(',') || '?';
  const tag = a.kind === 'silent' ? '复发冷却期内（不重复开候选，仅计数）' : `已并入候选 ${a.cid}`;
  const head = a.kind === 'silent' ? '## 复发记录（静默计数）' : '## 复发记录';
  return `${head}\n\n- ${fmtTime(now)}｜本次 +${a.n} 次（累计 ${(c && c.n) || a.n}）｜${ws}｜${tag}${a.evs && a.evs[0] ? `｜最近来源 ${a.evs[a.evs.length - 1].sid}` : ''}`;
}

// mode: '--check'(默认) | '--prewarm' | '--stats'；opts: { full, dry }
function runScan(mode, opts) {
  const o = opts || {};
  const t0 = Date.now();
  if (!fs.existsSync(repo.P.sessions)) return { ok: false, text: 'no sessions root' };
  if (!fs.existsSync(repo.P.nb)) return { ok: false, text: 'whale-notebook dir missing: ' + repo.P.nb };
  const settings = repo.readSettings();
  const state = repo.readState();
  // --stats/--prewarm 语义上是全量；settings.scanMode='full' 强制全量
  const full = o.full === true || mode === '--stats' || mode === '--prewarm' || settings.scanMode === 'full';
  const scan = scanHistory(state, settings, { full });
  const s = scan.stats;
  const scanLine = `解码 ${s.scanned}/${s.files} 文件（未更新跳过 ${s.skipped}）｜读取 ${(s.readBytes / 1048576).toFixed(2)}MB` +
    (s.resets ? `｜水位线重置 ${s.resets}` : '') + (s.retryPending ? `｜待重试 ${s.retryPending}` : '') +
    (s.badFiles ? `｜解码失败 ${s.badFiles}` : '');

  if (mode === '--stats') {
    // v0.5：纯只读 —— 不写任何文件（旧版会写掉 seen 指纹，静默吞掉这批候选）
    const catCount = {};
    for (const ev of scan.events) {
      const c = catCount[ev.cat] || (catCount[ev.cat] = { n: 0, ws: new Set(), first: ev.at, last: ev.at });
      c.n++; c.ws.add(ev.ws);
      if (ev.at < c.first) c.first = ev.at;
      if (ev.at > c.last) c.last = ev.at;
    }
    const lines = [];
    lines.push('== whale-notebook 全量统计（只读，不落盘）==');
    lines.push(`工作区: ${findWorkspaceDirs(settings).length} | 事件(工具失败/特征+用户报障): ${scan.events.length} | 已记指纹: ${(state.seenFingerprints || []).length}`);
    lines.push(`扫描: ${scanLine}｜用时 ${Date.now() - t0}ms`);
    for (const [cat, c] of Object.entries(catCount).sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`  ${cat}: ${c.n} 次 | 工作区: ${[...c.ws].slice(0, 3).join(', ')} | ${fmtTime(c.first)} ~ ${fmtTime(c.last)}`);
    }
    return { ok: true, text: lines.join('\n'), data: { events: scan.events.length, byCat: catCount, scan: s } };
  }

  if (mode === '--prewarm') {
    const consumed = markSeen(state, scan.events, Number.isFinite(settings.maxFingerprints) ? settings.maxFingerprints : DEFAULT_MAX_FINGERPRINTS);
    state.lastScan = Date.now();
    repo.writeState(state);
    const ms = Date.now() - t0;
    return {
      ok: true,
      text: `prewarm ok: scanned ${scan.events.length} events, recorded ${consumed} new fingerprints (${s.files} files)｜${scanLine}\n注意：prewarm 会把事件标记为已见 —— 这 ${consumed} 条不会再作为候选出现。`,
      data: { events: scan.events.length, fresh: consumed, files: s.files, ms },
    };
  }

  // 默认 --check：新事件按聚簇合并/复发后入箱
  const ing = ingestFresh(scan.events, state, settings, { dry: o.dry === true });
  state.lastScan = Date.now();
  if (!o.dry) repo.writeState(state);
  const ms = Date.now() - t0;
  const bits = [`新发现 ${ing.added.length} 条(${ing.added.map((r) => r.cat).join(',') || '无'})`];
  if (ing.bumped.length) bits.push(`累加已有候选 ${ing.bumped.length} 条(${ing.bumped.map((b) => b.id).join(',')})`);
  if (ing.silent.length) bits.push(`复发冷却静默 ${ing.silent.length} 条`);
  if (ing.dropped) bits.push(`超单轮上限丢弃 ${ing.dropped} 条(已记指纹)`);
  if (ing.echo) bits.push(`自引用回声过滤 ${ing.echo} 组/${ing.echoEvents} 条(落 archive/echo-*.md)`);
  bits.push(`待审共 ${ing.pending} 条`);
  bits.push(scanLine);
  bits.push(`${ms}ms`);
  return {
    ok: true,
    text: (o.dry ? '[dry 只读] ' : '') + bits.join(' | '),
    data: {
      added: ing.added, bumped: ing.bumped, silent: ing.silent, dropped: ing.dropped,
      echo: ing.echo, echoEvents: ing.echoEvents,
      pending: ing.pending, ms, scan: s, dry: !!o.dry,
    },
  };
}

// v0.3：候选详情 sidecar 内容协议（details/C###.md）。
// 摘录取簇内文本最长的一条（已 redact），上限 DETAIL_EXCERPT_MAX，超长截断并注明完整错误源路径；
// 源引用取去重后最新 ≤3 条（sid @ 时间｜工作区｜日志路径）。只含工具失败/特征文本，无 user 原文。
function buildDetailMd(cid, r) {
  const id = 'C' + String(cid).padStart(3, '0');
  let best = null;
  for (const ev of r.evs) if (!best || ev.text.length > best.text.length) best = ev;
  const seen = new Set();
  const srcList = [];
  for (let i = r.evs.length - 1; i >= 0 && srcList.length < 3; i--) {
    const ev = r.evs[i];
    if (seen.has(ev.sid)) continue;
    seen.add(ev.sid);
    srcList.push(ev);
  }
  const excerpt = (best && best.text) ? best.text : '';
  const L = [];
  L.push(`# ${id} 候选详情`);
  L.push('');
  L.push(`- 一句话：${r.text}`);
  L.push(`- 类别：${r.cat}｜次数：${r.n}｜工作区：${[...r.wsSet].slice(0, 2).join(',')}｜首次：${fmtTime(r.first)}｜最近：${fmtTime(r.last)}`);
  if (r.origin) L.push(`- 复发：原候选 ${r.origin}（已处置）后再次出现，本行是重开的候选`);
  L.push(`- 源会话（最近 ${srcList.length} 个）：`);
  for (const ev of srcList) L.push(`  - ${ev.sid} @ ${fmtTime(ev.at)}｜${ev.ws}｜${ev.file}`);
  L.push(`- 错误摘录（已打码，上限 ${DETAIL_EXCERPT_MAX} 字）：`);
  L.push('');
  L.push('```text');
  if (excerpt.length > DETAIL_EXCERPT_MAX) L.push(excerpt.slice(0, DETAIL_EXCERPT_MAX) + `\n…（截断：完整错误见源日志 ${best.file}）`);
  else L.push(excerpt || '（无摘录文本）');
  L.push('```');
  L.push('');
  return L.join('\n');
}

module.exports = {
  runScan, clusterKey, fpOf, findWorkspaceDirs, sessionFiles, scanHistory, ingestFresh, markSeen, buildDetailMd,
};
