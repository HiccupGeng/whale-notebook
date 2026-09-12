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
const { bestFamily, DEFAULT_THRESHOLDS } = require('../core/similarity.cjs');
const { fmtTime } = require('../core/util.cjs');
const { oneLiner } = require('../core/summarize.cjs');
const { PAT_IDS } = require('./patterns.cjs');
// v0.7.6：isMetaEcho 供 --forget-echo（历史污染清理）复用同一套回声判定
const { collectEventsFrom, isMetaEcho } = require('./scanner.cjs');
const { zstdAvailable, ZSTD_REQUIRED_MSG } = require('./decoder.cjs');
const { INBOX_HEADER, inboxRow } = require('../core/schema.cjs');

const DEFAULT_READD_COOLDOWN_DAYS = 7;
const DEFAULT_MAX_FINGERPRINTS = 5000;
const DEFAULT_MAX_DEFERRED = 200;
const MAX_DETAIL_EVENTS = 16;
const DETAIL_EXCERPT_MAX = 600;

// v0.5.1：回声落档时的列转义（与 core/schema.cell 同规则，避免 `|` 破坏表格）
const escCell = (s) => String(s == null ? '' : s).replace(/\|/g, '｜');

// v0.7.6（回声自我放大治理 A1）：回声的**稳定签名**。
//   实测问题：回声分组原来用「聚簇哈希」（= hash36(cat|tool|整段文本)），同一现象第二次被打印时
//   尾部（打印出来的表行、行号、上下文）已不同 → 哈希不同 → **新开一行**而不是累加 n，
//   于是 archive/echo-*.md 单调增长（实测 231 行里只有 77 个不同现象，单现象最多 8 行）。
//   改用「类别 + 一句话现象（≤90，与归档列同口径）」作签名：同现象永远同一行；
//   落档前再与当日归档里的既有签名比对 → 已存在则跳过（幂等追加）。
function echoSig(cat, text) {
  return `${cat}|${escCell(text)}`;
}
function echoSigOf(ev) {
  return echoSig(ev.cat, oneLiner(redactLines(ev.text), 90));
}

function clusterKey(ev) {
  let body = canonText(ev.text);
  if (ev.cat === 'error') body = body.replace(/^error:\s*/, '').replace(/error:\s*/, '');
  return `${ev.cat}|${ev.tool}|${body}`;
}
function fpOf(ev, key) {
  return `${ev.sid}|${ev.at}|${hash36(key)}`;
}

// v0.6.2：已处置签名索引 —— 防「重置后重扫」把同一行重复开成新候选。
//   为什么需要：state 被重置/重建后，同一段会话日志会拿到新指纹与新聚簇哈希，
//   于是同一个坑在每次重扫时又开一行候选（实测同一行先后出现 3 次）。
//   可靠的事实源是归档表：行已处置即「已解决」，据此拦住新聚簇。
//   摘要法：聚簇一句话文本被 oneLiner(…,90) 截断（JS slice 按 UTF-16 单元），
//   归档行文本 ≤120 字符，故把归档文本同样按 90 截断后比较前缀即可稳定匹配。
const SIG_TEXT_MAX = 90;
// v0.7.4（审计 N18）：复发行在现象列里带「复发（原 C0xx）：」前缀，而聚簇文本不带前缀
//   → 归档后签名永远对不上。归一化放在 resolvedSig 里，索引构建与在箱剔除两端同时生效。
const READD_PREFIX_RE = /^复发（原 C\d+）：\s*/;
function resolvedSig(cat, text) {
  const body = String(text == null ? '' : text)
    .replace(READD_PREFIX_RE, '')
    .replace(/\s+/g, ' ').trim().slice(0, SIG_TEXT_MAX);
  return body ? `${cat}|${body}` : '';
}
// 归档行形态（实测 99 行里只有 2 行能按固定列数解析）：历史渲染过两轮 ——
//   ① 早期：`| 编号 | 类别 | 次数 | 工作区 | 现象 | 时间 |`（6 列，无处置列）
//   ② 批量清理后：在时间列旁又追加一列，且**行内残留半角 `|`**（现象列里的 `[stderr] … | …`）
// 因此放弃"按列数解析"。稳定事实：前 4 列固定（编号/类别/次数/工作区）、末列=处置、次末列=时间。
// 从两端取，并把时间列切掉 —— 现象文本必须与引擎聚簇文本一致，否则签名永远对不上。
const ARCHIVE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
function parseArchiveRow(line) {
  const t = String(line || '').trim();
  if (!/^\|\s*C\d+\s*\|/.test(t)) return null;
  const parts = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((s) => s.trim());
  if (parts.length < 6) return null;
  const id = parts[0];
  if (!/^C\d+$/.test(id)) return null;
  const last = parts.length - 1;
  const disposition = parts[last];
  const hasTime = ARCHIVE_TIME_RE.test(parts[last - 1]);
  // 现象列 = [4, end)：有「时间」列时 end 指向它（last-1），否则 end 指向处置列（last）
  const end = hasTime ? last - 1 : last;
  // v0.7.4（审计 N18）：历史遗留的 8 列「空列」形态（旧版面板删除直接续写 `|` 造成）
  //   会让 parts[last-1] 变成空串 → hasTime=false → 尾部是空串，下面的 while 第一轮就停住
  //   → 时间被并进现象文本，签名永久失配。**先剔空列**，while 才能把时间列正常弹掉。
  const mid = parts.slice(4, Math.max(4, end)).filter((s) => s !== '');
  // 兜底：尾部纯「日期/时刻/日期+时刻」列一律切掉（无处置列的旧行、日期与时刻拆两列的行），
  // 否则时间会被并进现象文本、与引擎聚簇文本不一致，签名永远对不上。
  // v0.7.4：判据补 ARCHIVE_TIME_RE —— 8 列空列形态里时间是一整列 `YYYY-MM-DD HH:mm`，
  // 只认 `^\d{4}-\d{2}-\d{2}$` 会漏掉它（这正是 63% 归档行签名失配的直接原因）。
  while (mid.length > 1 && (ARCHIVE_TIME_RE.test(mid[mid.length - 1])
    || /^\d{4}-\d{2}-\d{2}$/.test(mid[mid.length - 1])
    || /^\d{2}:\d{2}$/.test(mid[mid.length - 1]))) mid.pop();
  const text = mid.join(' | ');
  return { id, cat: parts[1], ws: parts[3], text, disposition, hasTime };
}
function loadResolvedIndex(dir) {
  const index = new Set();
  const base = dir || repo.P.archive;
  let names; try { names = fs.readdirSync(base); } catch { return index; }
  for (const name of names) {
    if (!/^archive-.*\.md$/.test(name)) continue;
    let text; try { text = fs.readFileSync(path.join(base, name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const row = parseArchiveRow(line);
      if (!row || !row.disposition) continue;
      const sig = resolvedSig(row.cat, row.text);
      if (sig) index.add(sig);
    }
  }
  return index;
}

// v0.7.4（审计 N18/N19）：归档「已处置索引 + 最大编号」的 mtime 缓存。
//   实时采集每次 flush 都要用（原来根本没传），不能每轮重读 20–30KB 归档；
//   目录内 archive-*.md 的 (name,size,mtime) 拼成 key，变了才重建。
const archiveCache = { key: null, index: new Set(), maxId: 0 };
function statSafe(p) {
  try { const st = fs.statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; }
  catch { return { size: -1, mtimeMs: -1 }; }
}
function archiveCacheKey() {
  let names;
  try { names = fs.readdirSync(repo.P.archive); } catch { return ''; }
  let key = '';
  for (const name of names.slice().sort()) {
    if (!/^archive-.*\.md$/.test(name)) continue;
    const st = statSafe(path.join(repo.P.archive, name));
    key += `${name}:${st.size}:${st.mtimeMs};`;
  }
  return key;
}
function loadResolvedCached() {
  const key = archiveCacheKey();
  if (archiveCache.key !== null && archiveCache.key === key) return archiveCache;
  const index = loadResolvedIndex();
  let maxId = 0;
  let names = [];
  try { names = fs.readdirSync(repo.P.archive); } catch { /* 无归档目录：maxId 保持 0 */ }
  for (const name of names) {
    if (!/^archive-.*\.md$/.test(name)) continue;
    let text; try { text = fs.readFileSync(path.join(repo.P.archive, name), 'utf8'); } catch { continue; }
    // 编号扫描用宽松判据（不依赖整行能否解析）——畸形行也占过编号，必须计入下限，否则会撞号
    for (const line of text.split('\n')) {
      const m = String(line).match(/^\|\s*(C\d+)\s*\|/);
      if (!m) continue;
      const n = parseInt(m[1].slice(1), 10);
      if (Number.isFinite(n) && n > maxId) maxId = n;
    }
  }
  archiveCache.key = key;
  archiveCache.index = index;
  archiveCache.maxId = maxId;
  return archiveCache;
}

// v0.6.2：已开行（在箱/已处置）的聚簇，其复发窗口已随风干 — 从索引里剔除，可重新开行。
// 在 runScan 读 state 之后、ingest 之前调用（纯函数，便于单测）。
function pruneResolvedIndex(state, index) {
  const clusters = (state && state.clusters) || {};
  let pruned = 0;
  for (const h of Object.keys(clusters)) {
    const sig = resolvedSig(clusters[h].cat, clusters[h].text);
    if (sig && index.has(sig)) { index.delete(sig); pruned++; }
  }
  return pruned;
}

// v0.7：族（family）——同一坑的不同变体（IP/端口/耗时不同、详略不同）。
// 复用既有结构：state.clusters 里 **cid 相同的聚簇天然就是一族**（族合并时新变体的 cid 指向代表聚簇的行），
// 因此不需要新增状态字段；familyList() 只是把聚簇投影成相似度比对用的 { key, cat, repr } 列表。
function familyThresholds(settings) {
  const s = (settings && settings.familyThresholdSame);
  const c = (settings && settings.familyThresholdCross);
  return {
    same: Number.isFinite(s) ? s : DEFAULT_THRESHOLDS.same,
    cross: Number.isFinite(c) ? c : DEFAULT_THRESHOLDS.cross,
  };
}
function familyList(clusters) {
  const out = [];
  for (const h of Object.keys(clusters || {})) {
    const c = clusters[h];
    if (!c || !c.text) continue;
    out.push({ key: h, cat: c.cat, repr: c.text, cid: c.cid, n: c.n, first: c.first, last: c.last });
  }
  return out;
}
// 族并入的记录（写进代表候选的 detail sidecar：讨论会话据此看到「这条其实是 N 个变体」）
function familyNote(a, rep, now) {
  return `## 同族并入（v0.7）\n\n- ${fmtTime(now)}｜相似度 ${a.familyScore}｜本次 +${a.n} 次（族累计 ${(rep && rep.n) || a.n}）｜${escCell([...a.wsSet].slice(0, 2).join(',')) || '?'}\n- 变体现象：${escCell(a.text)}\n- 判定依据：与代表现象「${escCell((rep && rep.text) || '')}」的骨架相似度 ≥ 阈值（阈值可调 settings.familyThresholdSame/Cross）`;
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

// v0.7.7（审计第 2 项）：让出的两种驱动 —— 同一个生成器，同步驱动（CLI）忽略让出请求，
//   异步驱动（宿主 HTTP）在让出点 `await setImmediate`，把事件循环还给宿主。循环体只有一份。
const YIELD_EVERY_FILES = 8;               // 每 N 个文件让出一次
const YIELD_EVERY_BYTES = 4 * 1024 * 1024;  // 或每读取 ≥4MB 让出一次（大日志单文件也能让出）
function driveSync(gen) {
  let r = gen.next();
  while (!r.done) r = gen.next();
  return r.value;
}
async function driveAsync(gen, ctl) {
  let r = gen.next();
  while (!r.done) {
    await new Promise((resolve) => setImmediate(resolve));
    if (ctl && typeof ctl.cancelled === 'function' && ctl.cancelled()) {
      try { gen.return(); } catch { /* 收尾异常无妨 */ }
      return { ok: false, text: '扫描已取消（插件正在卸载）', cancelled: true };
    }
    r = gen.next();
  }
  return r.value;
}

// 增量/全量扫描：更新 state.files 水位线，返回事件与统计
function* scanHistoryGen(state, settings, opts) {
  const t0 = Date.now();
  const o = opts || {};
  const full = !!o.full;
  const ctl = o.ctl || null;
  const files = sessionFiles(settings);
  const events = [];
  let scanned = 0, skipped = 0, readBytes = 0, resets = 0, retryPending = 0, badFiles = 0;
  let corruptFrames = 0;                 // v0.7.5：非末帧损坏次数（其后的日志读不到）
  const stuckFiles = [];                 // v0.7.5：连续 ≥2 轮仍卡在同一坏帧的文件（最多记 5 条）
  let sinceYield = 0, bytesSinceYield = 0;
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
    const readN = Math.max(0, st.size - res.readFrom);
    readBytes += readN;
    for (const ev of res.events) events.push(Object.assign({}, ev, { file: f.file }));
    // v0.7.5（审计 N20）：中段坏帧 = 真损坏，且该帧之后的内容永远读不到 —— 记轮次，连续 ≥2 轮升级为可见告警
    const badRounds = res.corruptAt === 'mid' ? ((wm && Number.isFinite(wm.badRounds) ? wm.badRounds : 0) + 1) : 0;
    if (res.corruptAt === 'mid') {
      corruptFrames++;
      if (badRounds >= 2 && stuckFiles.length < 5) stuckFiles.push({ file: f.file, offset: res.nextOffset, rounds: badRounds });
    }
    state.files[f.file] = {
      size: st.size,
      mtimeMs: res.partial ? -1 : st.mtimeMs, // 半写/坏帧：下次必扫（从 offset 续，代价只有尾部）
      offset: res.nextOffset,
      frames: res.frames,
      badRounds, // v0.7.5：连续卡在同一坏帧的轮次（0 = 正常）
      sid: res.sid || f.sid,
      ws: res.ws || (wm && wm.ws) || f.sid,
      calls: res.calls || (wm && wm.calls) || {}, // 跨窗口继承 callId→工具名（否则 tool 退化成 '?'、聚簇键漂移）
      // v0.7.6（A3）：callId→命令摘要 同样跨窗口继承（出处判定在增量窗口里仍要生效）
      cmds: res.cmds || (wm && wm.cmds) || {},
    };
    if (res.partial) retryPending++;
    sinceYield++; bytesSinceYield += readN;
    if (ctl && (sinceYield >= YIELD_EVERY_FILES || bytesSinceYield >= YIELD_EVERY_BYTES)) {
      sinceYield = 0; bytesSinceYield = 0;
      if (typeof ctl.onProgress === 'function') ctl.onProgress({ files: files.length, scanned, skipped, readBytes });
      yield;
    }
  }
  events.sort((a, b) => a.at - b.at);
  return {
    events,
    stats: {
      files: files.length, scanned, skipped, readBytes, resets, retryPending, badFiles,
      corruptFrames, stuckFiles, // v0.7.5（审计 N20）：中段坏帧与"卡住的文件"必须能被看见
      ms: Date.now() - t0,
    },
  };
}
function scanHistory(state, settings, opts) { return driveSync(scanHistoryGen(state, settings, opts)); }
function scanHistoryAsync(state, settings, opts) { return driveAsync(scanHistoryGen(state, settings, opts), (opts && opts.ctl) || null); }

// v0.7.5（审计 N20）：把本轮扫描的"健康度"落进 state —— 排障信息（坏帧/待重试/解码失败/卡住的文件）
//   过去只出现在一次性 CLI 文本里，面板与 /whale/live 看不到，于是"半瘫"没人知道。
//   路径只留 sid/文件名（不落个人目录）。
function persistScanStats(state, s, mode) {
  state.lastScanStats = {
    at: Date.now(),
    mode: mode || '',
    files: s.files, scanned: s.scanned, skipped: s.skipped,
    readBytes: s.readBytes, resets: s.resets, retryPending: s.retryPending, badFiles: s.badFiles,
    corruptFrames: s.corruptFrames || 0,
    stuckFiles: (s.stuckFiles || []).map((x) => ({
      where: path.basename(path.dirname(x.file)) + '/' + path.basename(x.file),
      offset: x.offset,
      rounds: x.rounds,
    })),
    ms: s.ms,
  };
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

// v0.6 拉取式：暂存摘要的合并与裁剪
// 语义：settings.autoAdd=false 时，新发现只写进 state.deferred（不占待审箱、不发提醒清单），
//       等用户主动说「小本本复盘」再 mine.cjs --add 一次性冲入待审箱审核。
// 已存在且仍在待审箱里的候选不受影响：命中共聚簇时仍只累加次数（不新增行）。
function deferCluster(def, a, now) {
  const d = def[a.hash] || { cat: a.cat, text: a.text, n: 0, first: a.first, last: a.last, ws: [], refs: [], excerpt: '', at: now };
  d.n += a.n;
  if (a.first < d.first) d.first = a.first;
  if (a.last > d.last) d.last = a.last;
  for (const w of a.wsSet) if (w && d.ws.indexOf(w) === -1 && d.ws.length < 3) d.ws.push(w);
  const best = a.evs.reduce((x, y) => (!x || y.text.length > x.text.length ? y : x), null);
  if (best && best.text && best.text.length > (d.excerpt || '').length) d.excerpt = best.text.slice(0, DETAIL_EXCERPT_MAX);
  for (const ev of a.evs) {
    if (d.refs.length >= 3) break;
    if (d.refs.some((r) => r.sid === ev.sid)) continue;
    d.refs.push({ sid: ev.sid, at: ev.at, ws: ev.ws, file: ev.file });
  }
  d.at = now;
  def[a.hash] = d;
  return d;
}
function trimDeferred(def, cap) {
  const keys = Object.keys(def);
  if (keys.length <= cap) return 0;
  keys.sort((x, y) => (def[x].last || 0) - (def[y].last || 0));
  const drop = keys.slice(0, keys.length - cap);
  for (const k of drop) delete def[k];
  return drop.length;
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
  // v0.6.2：已处置签名（归档表）→ 同签名的新聚簇不再开行（防重置后重扫重复开行）
  const resolved = o.resolved instanceof Set ? o.resolved : new Set();

  const inboxOld = repo.readInboxText();
  const pendRows = repo.parseInboxRows(inboxOld);
  const pendIds = new Set(pendRows.map((r) => r.id));
  // v0.7.4（审计 N19 连带）：编号下限 = max(state, 在箱最大编号+1, 归档最大编号+1)。
  //   state 被清空/重置时 nextCandidateId 会归 1 —— 不拿归档兜底就会与历史编号撞号，
  //   之后面板按编号查详情/删除会命中上一轮的同号候选。
  const maxPendId = pendRows.reduce((m, r) => Math.max(m, parseInt(String(r.id).slice(1), 10) || 0), 0);
  const archived = loadResolvedCached();
  state.nextCandidateId = Math.max(state.nextCandidateId || 1, maxPendId + 1, (archived.maxId || 0) + 1);
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
  const echo = new Map(); // v0.7.6：回声签名 -> { cat, ws, n, last, text }（签名＝类别|一句话现象，见 echoSigOf）
  for (const it of fresh) {
    const ev = it.ev;
    if (ev.meta) {
      const sig = echoSigOf(ev);
      const e = echo.get(sig) || { cat: ev.cat, n: 0, last: ev.at, ws: ev.ws, text: oneLiner(redactLines(ev.text), 90) };
      e.n++;
      if (ev.at > e.last) e.last = ev.at;
      echo.set(sig, e);
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
    // v0.6.2：该内容已在归档里被处置过 → 不再开行（重置后重扫的重复候选由此被压掉）
    if (resolved.has(resolvedSig(a.cat, a.text))) {
      clusters[a.hash] = {
        cid: null, cat: a.cat, text: a.text, n: a.n, first: a.first, last: a.last,
        reAddedAt: now, reAdds: 0, silentN: a.n,
      };
      a.kind = 'resolved'; decisions.push(a); continue;
    }
    // v0.7：族匹配 —— 与某个已登记的族相似（同一坑的不同变体）时，并入该族已有的候选行，
    // 而不是新开一行；该族若已被判为「已处置」，这里同样压掉（与 v0.6.2 的文本级守卫同义，但按族生效）。
    const fam = bestFamily(a.text, a.cat, familyList(clusters), familyThresholds(settings));
    if (fam) {
      const fc = clusters[fam.key] || {};
      const entry = {
        cid: fc.cid == null ? null : fc.cid, cat: a.cat, text: a.text, n: a.n, first: a.first, last: a.last,
        reAddedAt: 0, reAdds: 0, family: fam.key, familyScore: fam.score,
      };
      if (fc.cid === null) { // 族已处置 → 压掉
        entry.reAddedAt = now; entry.silentN = a.n;
        clusters[a.hash] = entry;
        a.kind = 'resolved'; decisions.push(a); continue;
      }
      if (pendIds.has(fc.cid)) { // 族已有在箱候选 → 并入（族合并的核心收益）
        fc.n = (fc.n || 0) + a.n;
        fc.last = Math.max(fc.last || 0, a.last);
        clusters[a.hash] = entry;
        a.cid = fc.cid; a.kind = 'family'; a.familyKey = fam.key; a.familyScore = fam.score;
        decisions.push(a); continue;
      }
      // 族曾开行、后被处置 → 复发重开（新行成为该族新的代表）
      entry.n = (fc.n || 0) + a.n;
      clusters[a.hash] = entry;
      a.origin = fc.cid; a.kind = 'readd'; a.familyKey = fam.key; a.familyScore = fam.score;
      decisions.push(a); continue;
    }
    const adopted = adoptBy.get(a.cat + '|' + a.text);
    if (adopted) {
      clusters[a.hash] = { cid: adopted, cat: a.cat, text: a.text, n: a.n, first: a.first, last: a.last, reAddedAt: 0, reAdds: 0 };
      a.cid = adopted; a.kind = 'bump'; decisions.push(a); continue;
    }
    decisions.push(a);
  }

  // ④ 落盘（dry 时整段跳过；行与 sidecar 一次写入）
  // v0.6：deferredOn（autoAdd=false 且未显式 --add）时，新发现改为写暂存摘要，不新增待审行
  const deferredOn = o.add !== true && settings.autoAdd === false;
  const def = state.deferred || (state.deferred = {});
  const deferredList = [];
  decisions.sort((x, y) => x.first - y.first);
  const added = [];
  const bumped = [];
  const silent = [];
  const suppressed = [];
  let dropped = 0;
  const countMap = new Map();
  const newRowLines = [];
  let inboxText = inboxOld;
  for (const a of decisions) {
    if (a.kind === 'bump') {
      const c = clusters[a.hash] || {};
      countMap.set(a.cid, c.n || a.n);
      bumped.push({ id: a.cid, n: c.n || a.n, added: a.n });
      if (!dry) repo.appendDetailNote(a.cid, recurrenceNote(a, c, now));
      continue;
    }
    if (deferredOn) {
      // 暂存（new / readd / silent 一视同仁：合并进摘要，等 --add 再入箱）
      const d = deferCluster(def, a, now);
      deferredList.push({ hash: a.hash, cat: a.cat, n: d.n, text: d.text });
      continue;
    }
    if (a.kind === 'family') {
      // v0.7：并入同族已有的候选行 —— 只累加代表聚簇的次数，并在该行 sidecar 记下变体现象
      const rep = clusters[a.familyKey] || {};
      const total = rep.n || a.n;
      countMap.set(a.cid, total);
      bumped.push({ id: a.cid, n: total, added: a.n, family: a.familyKey, score: a.familyScore });
      if (!dry) repo.appendDetailNote(a.cid, familyNote(a, rep, now));
      continue;
    }
    if (a.kind === 'resolved') {
      suppressed.push({ cat: a.cat, n: a.n, text: a.text });
      continue;
    }
    if (a.kind === 'silent') {
      const c = clusters[a.hash] || {};
      silent.push({ id: a.cid, added: a.n, n: c.n || a.n });
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
  if (deferredOn) trimDeferred(def, Number.isFinite(settings.maxDeferred) ? settings.maxDeferred : DEFAULT_MAX_DEFERRED);
  if (countMap.size) inboxText = repo.bumpInboxRows(inboxText, countMap).text;
  if (newRowLines.length) {
    const header = inboxText.trim() ? '' : INBOX_HEADER + '\n';
    inboxText = inboxText.trimEnd() + (inboxText.trim() ? '\n' : '') + header + newRowLines.join('\n') + '\n';
  }
  if (!dry && (countMap.size || newRowLines.length)) repo.writeInboxText(inboxText);
  // v0.5.1：回声落档（不占待审箱，但留证据可查）
  // v0.7.6（A1）：幂等追加 —— 当日归档里已有同签名的行就不再写（否则"打印一次多一行"自我放大）。
  let echoDupSkipped = 0;
  if (!dry && echo.size) {
    const existing = o.echoSeen instanceof Set ? o.echoSeen : repo.readEchoSignatures();
    const rows = [];
    for (const [sig, e] of echo) {
      if (existing.has(sig)) { echoDupSkipped++; continue; }
      rows.push(`| ${fmtTime(e.last)} | ${e.cat} | ${e.n} | ${escCell(e.ws)} | ${escCell(e.text)} |`);
      existing.add(sig); // 同一轮里重复签名也只写一行
    }
    if (rows.length) {
      try { repo.appendEchoArchive(rows.join('\n')); } catch (err) { /* 落档失败不阻断 */ }
    }
  }

  // ⑤ 状态回写（seen 截尾，防止无限增长）
  let seenArr = [...seen];
  if (seenArr.length > cap) seenArr = seenArr.slice(-cap);
  state.seenFingerprints = seenArr;
  state.clusters = clusters;

  return {
    added, bumped, silent, suppressed, dropped, deferred: deferredList, deferredTotal: Object.keys(def).length, deferredOn,
    echo: echo.size, echoEvents: [...echo.values()].reduce((a2, e) => a2 + e.n, 0), echoDupSkipped,
    pending: repo.pendingCount(inboxText), fresh: fresh.length, dry,
    // v0.7.6（审计第 5 项加固）：本批里"因指纹已见而跳过"的条数（live 侧双计风险的观测口径）
    dupFingerprints: rawEvents.length - fresh.length,
  };
}

// v0.6：把暂存摘要冲入待审箱（用户说「小本本复盘」时执行；--add）
// 已在箱中的同坑只累加次数；曾经处置过的标「复发（原 C0xx）」；其余为新候选。
function flushDeferred(state, settings, opts) {
  const o = opts || {};
  const dry = o.dry === true;
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxNewRows = Number.isFinite(o.maxNewRows) ? o.maxNewRows : 30;
  const def = state.deferred || (state.deferred = {});
  const clusters = state.clusters || (state.clusters = {});
  const resolved = o.resolved instanceof Set ? o.resolved : new Set();
  const inboxOld = repo.readInboxText();
  const pendIds = repo.pendingIds(inboxOld);
  const hashes = Object.keys(def).sort((x, y) => (def[x].first || 0) - (def[y].first || 0));
  const added = [];
  const bumped = [];
  const suppressed = [];
  let dropped = 0;
  const countMap = new Map();
  const newRowLines = [];
  let inboxText = inboxOld;
  for (const h of hashes) {
    const d = def[h];
    const c = clusters[h];
    if (c && pendIds.has(c.cid)) {
      // 同坑候选已在待审箱 → 只累加，不新开行
      c.n = (c.n || 0) + d.n;
      c.last = Math.max(c.last || 0, d.last || 0);
      countMap.set(c.cid, c.n);
      bumped.push({ id: c.cid, n: c.n, added: d.n });
      if (!dry) repo.appendDetailNote(c.cid, `## 复发记录\n\n- ${fmtTime(d.last)}｜暂存合并 +${d.n} 次（累计 ${c.n}）｜${escCell((d.ws || []).join(',')) || '?'}｜经 --add 并入本候选`);
      delete def[h];
      continue;
    }
    if (added.length >= maxNewRows) { dropped++; continue; } // 留在暂存里，下次 --add 再说
    const dText = d.text || (c && c.text) || '';
    // v0.7：先按族合并 —— 同族已有在箱候选就并进去；该族已处置则压掉（与文本级守卫同义但按族生效）
    let famOrigin = null;
    const fam = bestFamily(dText, d.cat, familyList(clusters), familyThresholds(settings));
    if (fam) {
      const fc = clusters[fam.key] || {};
      if (fc.cid === null) {
        suppressed.push({ cat: d.cat, n: d.n, text: dText });
        clusters[h] = {
          cid: null, cat: d.cat, text: dText, n: ((c && c.n) || 0) + d.n, first: d.first, last: d.last,
          reAddedAt: now, reAdds: 0, silentN: ((c && c.silentN) || 0) + d.n, family: fam.key, familyScore: fam.score,
        };
        delete def[h];
        continue;
      }
      if (pendIds.has(fc.cid)) {
        fc.n = (fc.n || 0) + d.n;
        fc.last = Math.max(fc.last || 0, d.last || 0);
        countMap.set(fc.cid, fc.n);
        bumped.push({ id: fc.cid, n: fc.n, added: d.n, family: fam.key, score: fam.score });
        clusters[h] = {
          cid: fc.cid, cat: d.cat, text: dText, n: d.n, first: d.first, last: d.last,
          reAddedAt: 0, reAdds: 0, family: fam.key, familyScore: fam.score,
        };
        if (!dry) repo.appendDetailNote(fc.cid, `## 同族并入（v0.7）\n\n- ${fmtTime(d.last)}｜相似度 ${fam.score}｜暂存合并 +${d.n} 次（族累计 ${fc.n}）｜${escCell((d.ws || []).join(',')) || '?'}｜经 --add 并入本候选\n- 变体现象：${escCell(dText)}`);
        delete def[h];
        continue;
      }
      famOrigin = fc.cid; // 族曾开行后被处置 → 复发重开
    }
    // v0.6.2：该内容已在归档里被处置过 → 不入箱（重置后重扫产生的暂存组由此被压掉）
    if (resolved.has(resolvedSig(d.cat, dText))) {
      suppressed.push({ cat: d.cat, n: d.n, text: dText });
      clusters[h] = {
        cid: null, cat: d.cat, text: dText, n: (c && c.n ? c.n : 0) + d.n, first: d.first, last: d.last,
        reAddedAt: now, reAdds: 0, silentN: ((c && c.silentN) || 0) + d.n,
      };
      delete def[h];
      continue;
    }
    const cid = state.nextCandidateId++;
    const id = 'C' + String(cid).padStart(3, '0');
    const readd = !!(famOrigin || (c && c.cid && !pendIds.has(c.cid)));
    const origin = famOrigin || (c && c.cid) || null;
    const text = readd ? `复发（原 ${origin}）：${d.text}` : d.text;
    newRowLines.push(inboxRow(cid, { cat: d.cat, n: d.n, wsSet: d.ws || [], text: text.slice(0, 120), time: fmtTime(d.first) }));
    clusters[h] = {
      cid: id, cat: d.cat, text: d.text, n: d.n, first: d.first, last: d.last,
      reAddedAt: readd ? now : 0,
      reAdds: readd ? (((c && c.reAdds) || 0) + 1) : 0,
      family: (fam && fam.key) || null, familyScore: (fam && fam.score) || null,
    };
    pendIds.add(id);
    added.push({ id, cat: d.cat, n: d.n, kind: readd ? 'readd' : 'new', text });
    if (!dry) {
      // 暂存只留了 ≤3 条源引用与最长摘录，sidecar 内容按同一协议重建
      const evs = (d.refs || []).map((r) => ({ sid: r.sid, at: r.at, ws: r.ws, file: r.file, text: '' }));
      if (evs.length && d.excerpt) evs[0].text = d.excerpt;
      try {
        repo.writeDetail(id, buildDetailMd(cid, {
          cat: d.cat, n: d.n, wsSet: new Set(d.ws || []), text: d.text,
          first: d.first, last: d.last, evs, origin: readd ? origin : null,
        }));
      } catch (err) { /* detail 写入失败仅告警 */ }
    }
    delete def[h];
  }
  if (countMap.size) inboxText = repo.bumpInboxRows(inboxText, countMap).text;
  if (newRowLines.length) {
    const header = inboxText.trim() ? '' : INBOX_HEADER + '\n';
    inboxText = inboxText.trimEnd() + (inboxText.trim() ? '\n' : '') + header + newRowLines.join('\n') + '\n';
  }
  if (!dry && (countMap.size || newRowLines.length)) repo.writeInboxText(inboxText);
  return { added, bumped, suppressed, dropped, remaining: Object.keys(def).length, pending: repo.pendingCount(inboxText), dry };
}

// v0.7.6（数据修复）：把「自引用/探针回声」从**暂存**里清掉。
//   背景：v0.7.1 之前的签名覆盖不全，实测 18 条暂存里有 13 条（72%）是我们自己的探针/接口/状态转储 →
//   等用户做「小本本复盘」时得一条条手动排。签名补全（A2/A3）后，用同一套判定回头清理历史污染。
//   安全：默认**只干跑**（apply=false），列出将删除的条目；只有 --apply 才真的删。
function forgetEchoDeferred(state, settings, opts) {
  const o = opts || {};
  const apply = o.apply === true;
  const def = state.deferred || (state.deferred = {});
  const hits = [];
  for (const k of Object.keys(def)) {
    const d = def[k] || {};
    const t = String(d.text || '');
    const ex = String(d.excerpt || '');
    if ((t && isMetaEcho(t)) || (ex && isMetaEcho(ex))) {
      hits.push({ hash: k, cat: d.cat, n: d.n || 0, text: t.slice(0, 90) });
    }
  }
  if (apply) for (const h of hits) delete def[h.hash];
  return { hits, removed: apply ? hits.length : 0, remaining: Object.keys(def).length, apply };
}

function recurrenceNote(a, c, now) {
  const ws = [...a.wsSet].slice(0, 2).join(',') || '?';
  const tag = a.kind === 'silent' ? '复发冷却期内（不重复开候选，仅计数）' : `已并入候选 ${a.cid}`;
  const head = a.kind === 'silent' ? '## 复发记录（静默计数）' : '## 复发记录';
  return `${head}\n\n- ${fmtTime(now)}｜本次 +${a.n} 次（累计 ${(c && c.n) || a.n}）｜${ws}｜${tag}${a.evs && a.evs[0] ? `｜最近来源 ${a.evs[a.evs.length - 1].sid}` : ''}`;
}

// mode: '--check'(默认) | '--add' | '--prewarm' | '--stats'；opts: { full, dry }
// v0.7.4（审计 N5）：写路径互斥 —— CLI 扫描与宿主实时采集写同一批文件（state.json / inbox.md），
//   没有互斥就会互相覆盖（丢失更新、同号两行、--rebuild 被整段回滚）。
//   `--dry` 与 `--stats` 是纯只读，不加锁。锁超时则明确失败（exit 码由 CLI 置 1），不静默继续。
function runScan(mode, opts) {
  const o = opts || {};
  // 前置检查放在加锁之前：数据目录/会话根缺失时应当报"前置缺失"（CLI 退出码 2），
  // 而不是"锁忙" —— 数据目录不存在时连锁文件都建不出来。
  if (!fs.existsSync(repo.P.sessions)) return { ok: false, text: 'no sessions root' };
  if (!fs.existsSync(repo.P.nb)) return { ok: false, text: 'whale-notebook dir missing: ' + repo.P.nb };
  // v0.7.5（审计 N20）：运行环境缺 zstd 能力时**明确失败**，绝不"0 事件 + 退出码 0"地静默停摆
  if (!zstdAvailable()) return { ok: false, text: ZSTD_REQUIRED_MSG };
  const willWrite = o.dry !== true && mode !== '--stats';
  const release = willWrite ? repo.acquireLockSync(1500) : null;
  if (willWrite && !release) {
    return { ok: false, text: `写入锁不可用（${repo.stateDiag.lastLockError || 'timeout'}；另一个采集进程正在扫描或写盘），请稍后重试` };
  }
  try { return driveSync(runScanGen(mode, o, null)); }
  finally { if (release) release(); }
}

// v0.7.7（审计第 2 项）：宿主侧异步入口 —— 与 runScan 同形返回，差别只有三点：
//   ① 用异步写锁（await repo.acquireLock，不阻塞事件循环等锁）；② 扫描主体在让出点 await setImmediate；
//   ③ 支持 ctl.cancelled() 取消（插件卸载时用，保证一定释放锁）。
//   CLI 仍走同步 runScan：退出码语义与输出口径零变化。
async function runScanAsync(mode, opts) {
  const o = opts || {};
  const ctl = o.ctl || null;
  if (!fs.existsSync(repo.P.sessions)) return { ok: false, text: 'no sessions root' };
  if (!fs.existsSync(repo.P.nb)) return { ok: false, text: 'whale-notebook dir missing: ' + repo.P.nb };
  if (!zstdAvailable()) return { ok: false, text: ZSTD_REQUIRED_MSG };
  const willWrite = o.dry !== true && mode !== '--stats';
  let release = null;
  if (willWrite) {
    release = await repo.acquireLock(1500);
    if (!release) {
      return { ok: false, text: `写入锁不可用（${repo.stateDiag.lastLockError || 'timeout'}；另一个采集进程正在扫描或写盘），请稍后重试` };
    }
  }
  try { return await driveAsync(runScanGen(mode, o, ctl), ctl); }
  finally { if (release) release(); }
}

function* runScanGen(mode, o, ctl) {
  const t0 = Date.now();
  if (!fs.existsSync(repo.P.sessions)) return { ok: false, text: 'no sessions root' };
  if (!fs.existsSync(repo.P.nb)) return { ok: false, text: 'whale-notebook dir missing: ' + repo.P.nb };
  const settings = repo.readSettings();
  const state = repo.readState();
  // v0.6 --add：只把暂存摘要冲入待审箱，不重新扫描（O(暂存数)，与历史大小无关）
  if (mode === '--add') {
    const out = flushDeferred(state, settings, { dry: o.dry, resolved: loadResolvedIndex() });
    if (!o.dry) repo.writeState(state);
    const bits = [`入箱 ${out.added.length} 条(${out.added.map((r) => r.cat).join(',') || '无'})`];
    if (out.bumped.length) {
      const famN = out.bumped.filter((b) => b.family).length;
      bits.push(`并入已有候选 ${out.bumped.length} 条(${out.bumped.map((b) => b.id).join(',')}${famN ? `，其中同族 ${famN} 条` : ''})`);
    }
    if (out.suppressed.length) bits.push(`已处置签名压掉暂存重复 ${out.suppressed.length} 组(不再开行)`);
    if (out.dropped) bits.push(`超单轮上限留在暂存 ${out.dropped} 组`);
    bits.push(`待审共 ${out.pending} 条`);
    bits.push(`剩余暂存 ${out.remaining} 组`);
    bits.push(`${Date.now() - t0}ms`);
    return { ok: true, text: (o.dry ? '[dry 只读] ' : '') + bits.join(' | '), data: { added: out.added, bumped: out.bumped, suppressed: out.suppressed, dropped: out.dropped, remaining: out.remaining, pending: out.pending, dry: !!o.dry } };
  }
  // v0.6 --rebuild：清空派生状态后从头梳理全部历史
  // 语义：「第一次梳理」——水位线/指纹/聚簇/暂存全部清掉，历史里的每个坑都会被重新发现；
  // 候选编号继续递增（nextCandidateId 保留），不会与 archive/ 里的历史编号冲突。
  // 拉取式（autoAdd=false）下结果只进暂存，箱子不会被动增长；要入箱加 --add。
  // v0.7.7（审计第 3 项）：重建前先开**维护窗口**（repo.writeMaintenance）——宿主侧实时采集见到标记
  //   就让路（事件留在内存缓冲、不写盘、不丢），窗口在 finally 里无条件关闭（成功/失败/异常都关），
  //   进程被强杀时靠 expiresAt 自愈。语义上是"可见、有序、可恢复"，不是"暂停采集"。
  const rebuild = mode === '--rebuild';
  let maintenanceOn = false;
  try {
    if (rebuild) {
      if (!o.dry) maintenanceOn = repo.writeMaintenance({ kind: 'rebuild', expiresAt: Date.now() + 120000 });
      state.files = {};
      state.clusters = {};
      state.deferred = {};
      state.seenFingerprints = [];
    }
    // --stats/--prewarm 语义上是全量；settings.scanMode='full' 强制全量
    const full = rebuild || o.full === true || mode === '--stats' || mode === '--prewarm' || settings.scanMode === 'full';
    // v0.6.2：已处置签名索引（见 loadResolvedIndex）。重建时聚簇被清空，无需剔除；
    // 正常扫描时把「已开行的聚簇」从索引剔除，让它们走既有的复发语义（开「复发（原 C0xx）」行）而不是被压掉。
    const resolvedIndex = loadResolvedIndex();
    if (!rebuild) pruneResolvedIndex(state, resolvedIndex);
    const scan = yield* scanHistoryGen(state, settings, { full, ctl });
    return yield* runScanTail(mode, o, { t0, state, settings, scan, rebuild, resolvedIndex });
  } finally {
    if (maintenanceOn) repo.clearMaintenance();
  }
}

// --stats / --prewarm / 默认(--check|--rebuild) 的收尾（与扫描分离，便于生成器在扫描点让出）
function* runScanTail(mode, o, ctxIn) {
  const { t0, state, settings, scan, rebuild, resolvedIndex } = ctxIn;
  const s = scan.stats;
  const scanLine = `解码 ${s.scanned}/${s.files} 文件（未更新跳过 ${s.skipped}）｜读取 ${(s.readBytes / 1048576).toFixed(2)}MB` +
    (s.resets ? `｜水位线重置 ${s.resets}` : '') + (s.retryPending ? `｜待重试 ${s.retryPending}` : '') +
    (s.corruptFrames ? `｜帧损坏 ${s.corruptFrames}（其后日志读不到）` : '') +
    (s.stuckFiles && s.stuckFiles.length ? `｜⚠ 卡住 ${s.stuckFiles.length} 个文件（连续 ≥2 轮同一坏帧，见 /whale/live 的 scan.stuckFiles）` : '') +
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
    lines.push(`工作区: ${findWorkspaceDirs(settings).length} | 事件(工具失败/特征+用户报障): ${scan.events.length} | 已记指纹: ${(state.seenFingerprints || []).length} | 暂存: ${Object.keys(state.deferred || {}).length} 组`);
    lines.push(`扫描: ${scanLine}｜用时 ${Date.now() - t0}ms`);
    for (const [cat, c] of Object.entries(catCount).sort((a, b) => b[1].n - a[1].n)) {
      lines.push(`  ${cat}: ${c.n} 次 | 工作区: ${[...c.ws].slice(0, 3).join(', ')} | ${fmtTime(c.first)} ~ ${fmtTime(c.last)}`);
    }
    return { ok: true, text: lines.join('\n'), data: { events: scan.events.length, byCat: catCount, scan: s } };
  }

  if (mode === '--prewarm') {
    const consumed = markSeen(state, scan.events, Number.isFinite(settings.maxFingerprints) ? settings.maxFingerprints : DEFAULT_MAX_FINGERPRINTS);
    state.lastScan = Date.now();
    persistScanStats(state, s, mode); // v0.7.5：扫描健康度落 state（排障可见）
    if (!o.dry) repo.writeState(state); // v0.7.4（审计 N26）：--prewarm --dry 必须零写盘
    const ms = Date.now() - t0;
    return {
      ok: true,
      text: `prewarm ok: scanned ${scan.events.length} events, recorded ${consumed} new fingerprints (${s.files} files)｜${scanLine}\n注意：prewarm 会把事件标记为已见 —— 这 ${consumed} 条不会再作为候选出现。`,
      data: { events: scan.events.length, fresh: consumed, files: s.files, ms },
    };
  }

  // 默认 --check / --rebuild：新事件按聚簇合并/复发后入箱
  // v0.6：autoAdd=false 且未显式 --add 时改为暂存（不写 inbox）
  const ing = ingestFresh(scan.events, state, settings, { dry: o.dry === true, add: o.add === true, resolved: resolvedIndex });
  state.lastScan = Date.now();
  persistScanStats(state, s, mode); // v0.7.5：扫描健康度落 state（/whale/live 可视化）
  if (!o.dry) repo.writeState(state);
  const ms = Date.now() - t0;
  const bits = [];
  if (rebuild) bits.push('rebuild：已清空水位线/指纹/聚簇/暂存，从头梳理全部历史');
  if (ing.deferredOn) {
    bits.push(`新发现暂存 ${ing.deferred.length} 组(${ing.deferred.map((r) => r.cat).join(',') || '无'})`);
    bits.push(`暂存共 ${ing.deferredTotal} 组（未入箱；说「小本本复盘」或跑 --add 才入箱）`);
  } else {
    bits.push(`新发现 ${ing.added.length} 条(${ing.added.map((r) => r.cat).join(',') || '无'})`);
  }
  if (ing.bumped.length) {
    const famN = ing.bumped.filter((b) => b.family).length;
    bits.push(`累加已有候选 ${ing.bumped.length} 条(${ing.bumped.map((b) => b.id).join(',')}${famN ? `，其中同族并入 ${famN} 条` : ''})`);
  }
  if (ing.silent.length) bits.push(`复发冷却静默 ${ing.silent.length} 条`);
  if (ing.suppressed.length) bits.push(`已处置签名压掉重复候选 ${ing.suppressed.length} 条(重置后重扫不再重复开行)`);
  if (ing.dropped) bits.push(`超单轮上限丢弃 ${ing.dropped} 条(已记指纹)`);
  if (ing.echo) bits.push(`自引用回声过滤 ${ing.echo} 组/${ing.echoEvents} 条(落 archive/echo-*.md)` + (ing.echoDupSkipped ? `，其中 ${ing.echoDupSkipped} 组已在当日归档(不重复落档)` : ''));
  bits.push(`待审共 ${ing.pending} 条`);
  bits.push(scanLine);
  bits.push(`${ms}ms`);
  return {
    ok: true,
    text: (o.dry ? '[dry 只读] ' : '') + bits.join(' | '),
    data: {
      added: ing.added, bumped: ing.bumped, silent: ing.silent, suppressed: ing.suppressed, dropped: ing.dropped,
      deferred: ing.deferred, deferredTotal: ing.deferredTotal, deferredOn: ing.deferredOn,
      echo: ing.echo, echoEvents: ing.echoEvents, echoDupSkipped: ing.echoDupSkipped || 0,
      dupFingerprints: ing.dupFingerprints || 0,
      rebuild,
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
  // v0.7.4（审计 N2/N9）：ev.file 是会话日志的绝对路径，必须过打码 ——
  //   原来直接拼进 sidecar，实测 119 个归档 sidecar 里 92 个含用户名与目录结构；
  //   实时采集的事件没有 file 字段（批扫在 scanHistory 才补），此时退回工作区名而不是输出 undefined。
  for (const ev of srcList) {
    const src = ev.file
      ? redactLines(String(ev.file)).replace(/\s*\n+\s*/g, ' ')
      : `${ev.ws || '?'}（实时采集，无日志文件）`;
    L.push(`  - ${ev.sid} @ ${fmtTime(ev.at)}｜${ev.ws}｜${src}`);
  }
  L.push(`- 错误摘录（已打码，上限 ${DETAIL_EXCERPT_MAX} 字）：`);
  L.push('');
  L.push('```text');
  if (excerpt.length > DETAIL_EXCERPT_MAX) L.push(excerpt.slice(0, DETAIL_EXCERPT_MAX) + `\n…（截断：完整错误见源日志 ${best && best.file ? redactLines(String(best.file)).replace(/\s*\n+\s*/g, ' ') : '<path>'}）`);
  else L.push(excerpt || '（无摘录文本）');
  L.push('```');
  L.push('');
  return L.join('\n');
}

module.exports = {
  runScan, runScanAsync, clusterKey, fpOf, findWorkspaceDirs, sessionFiles, scanHistory, scanHistoryAsync, ingestFresh, markSeen, flushDeferred, buildDetailMd,
  // v0.7.6（回声自我放大治理）：回声稳定签名 + 历史污染清理
  echoSig, echoSigOf, forgetEchoDeferred,
  // v0.6.2：已处置签名索引（防重置后重扫重复开行）
  resolvedSig, loadResolvedIndex, pruneResolvedIndex, parseArchiveRow, SIG_TEXT_MAX,
  // v0.7.4：归档索引 + 最大编号的 mtime 缓存（实时采集与编号下限共用）
  loadResolvedCached, READD_PREFIX_RE,
  // v0.7.5：扫描健康度落 state（/whale/live 可视化；导出供自测）
  persistScanStats,
  // v0.7：族（同坑不同变体）—— 复用 state.clusters（同 cid 即同族）
  familyList, familyThresholds, familyNote,
};
