// collector/live.cjs - v0.5 实时采集（宿主半边专用）
// 机制：宿主插件在 apply(ctx) 里订阅 `session/event`（DSH 会话事件总线，事件对象与磁盘
//   session.jsonl 的记录同形：{type,time,data}）→ 交给 collector/scanner 的同一套判定
//   （classifyRecord）→ 去抖合并 → 走 engine.ingestFresh 与批扫完全一致的入库路径。
// 因此「运行中反复重试且失败」的坑无需等下次扫描、也无需消耗任何模型 token。
// 安全：所有异常在监听器内吞掉（绝不打断用户的会话）；写盘串行化（同一进程内 promise 链）；
//   每轮 flush 现读 state.json 再写回，避免覆盖 CLI 批扫刚建立的水位线。
'use strict';
const repo = require('../store/repo.cjs');
const { ingestFresh, loadResolvedCached } = require('./engine.cjs');
const { classifyRecord, newSessionCtx } = require('./scanner.cjs');

const DEFAULT_FLUSH_MS = 1500;        // 去抖：一波重试合并成一次入库
const DEFAULT_MAX_NEW_ROWS = 6;       // 单次入箱上限（防噪声刷屏；指纹仍记，同一事件不再重复触发）
const MAX_BUFFER = 200;               // 缓冲区上限，超出立即 flush

function lastSeg(p) {
  const segs = String(p || '').split(/[\\/]/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}

function createLiveCollector(opts) {
  const o = opts || {};
  const log = o.logger || { info() {}, warn() {}, debug() {} };
  const flushMs = Number.isFinite(o.flushMs) ? o.flushMs : DEFAULT_FLUSH_MS;
  const maxNewRows = Number.isFinite(o.maxNewRows) ? o.maxNewRows : DEFAULT_MAX_NEW_ROWS;

  const sessions = new Map(); // sid -> 会话上下文（callId→工具名、工作区名）
  let buffer = [];
  let timer = null;
  let disposed = false;
  let chain = Promise.resolve(); // 写盘串行化
  const stats = { events: 0, flushes: 0, added: 0, bumped: 0, silent: 0, dropped: 0, echoGroups: 0, echoEvents: 0, deferredGroups: 0, deferredEvents: 0, skipped: 0, lastFlushAt: 0, lastError: null };

  function ctxOf(session) {
    const sid = String((session && session.id) || '?');
    let st = sessions.get(sid);
    if (!st) {
      const cwd = (session && session.header && session.header.cwd) || '';
      st = newSessionCtx(sid, lastSeg(cwd) || '?');
      sessions.set(sid, st);
    }
    return st;
  }

  // 宿主事件回调：任何异常都在此吞掉（采集绝不影响用户任务）
  function onEvent(session, event) {
    if (disposed) return;
    try {
      if (!event || !event.type) return;
      const ev = classifyRecord(event, ctxOf(session));
      if (!ev) return;
      stats.events++;
      buffer.push(ev);
      if (buffer.length >= MAX_BUFFER) { flush(); return; }
      if (!timer) timer = setTimeout(() => { timer = null; flush(); }, flushMs);
    } catch (err) {
      stats.lastError = err && err.message ? err.message : String(err);
    }
  }

  function flush(waitMs) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!buffer.length) return chain;
    const batch = buffer;
    const lockWait = Number.isFinite(waitMs) ? waitMs : 5000;
    buffer = [];
    chain = chain
      .then(async () => {
        const settings = repo.readSettings();
        if (settings.autoCollect === false || settings.liveCapture === false) {
          stats.skipped += batch.length;
          return null;
        }
        // v0.7.4（审计 N5）：与 CLI 扫描 / 面板删除互斥（它们持有同一把锁）。
        //   拿不到锁就把这批事件放回缓冲，下一轮再试 —— 绝不带着"可能被覆盖"的状态去写盘。
        const release = await repo.acquireLock(lockWait);
        if (!release) {
          buffer = batch.concat(buffer);
          stats.lockBusy = (stats.lockBusy || 0) + 1;
          log.warn(`[whale-notebook] 写入锁忙，本轮实时入库推迟（${buffer.length} 条事件留在缓冲）`);
          return null;
        }
        try {
          const state = repo.readState(); // 现读现写（writeState 内部还有 CAS 合并兜底）
          // v0.7.4（审计 N18）：传入已处置索引 —— 原来 live 路径不查归档，
          //   state 重置后撞见同内容会立刻开新行，与 CLI 行为不一致。
          const ing = ingestFresh(batch, state, settings, {
            now: Date.now(), maxNewRows, resolved: loadResolvedCached().index,
          });
          repo.writeState(state);
          stats.flushes++;
          stats.lastFlushAt = Date.now();
          stats.added += ing.added.length;
          stats.bumped += ing.bumped.length;
          stats.silent += ing.silent.length;
          stats.dropped += ing.dropped || 0;
          stats.echoGroups += ing.echo || 0;
          stats.echoEvents += ing.echoEvents || 0;
          stats.deferredGroups += (ing.deferred || []).length;
          stats.deferredEvents += (ing.deferred || []).reduce((n, d) => n + d.n, 0);
          if (ing.added.length) {
            log.info(`[whale-notebook] 实时入箱 +${ing.added.length} 条（${ing.added.map((a) => a.id).join(',')}）｜待审共 ${ing.pending}`);
          } else if (ing.deferredOn && (ing.deferred || []).length) {
            // v0.6 拉取式：只暂存，不写待审箱（用户「小本本复盘」时才入箱）
            log.debug(`[whale-notebook] 实时暂存 +${ing.deferred.length} 组（暂存共 ${ing.deferredTotal} 组，未入箱）`);
          } else if (ing.bumped.length) {
            log.debug(`[whale-notebook] 实时累加 ${ing.bumped.map((b) => b.id).join(',')}`);
          }
          return ing;
        } finally {
          release();
        }
      })
      .catch((err) => {
        stats.lastError = err && err.message ? err.message : String(err);
        log.warn('[whale-notebook] 实时入箱失败（已忽略）：' + stats.lastError);
        return null;
      });
    return chain;
  }

  return {
    onEvent,
    flush,
    status() {
      return Object.assign({ enabled: !disposed, buffered: buffer.length, sessions: sessions.size }, stats);
    },
    async dispose() {
      disposed = true;
      if (timer) { clearTimeout(timer); timer = null; }
      await flush(300).catch(() => {}); // 卸载时不长等锁（最多 300ms），拿不到就丢弃缓冲
      sessions.clear();
    },
  };
}

module.exports = { createLiveCollector };
