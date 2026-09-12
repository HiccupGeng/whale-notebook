// lib/index.js - dsh-whale-notebook 插件宿主半边（v0.7.8：实时采集 + 决策箱面板 API + 拉取式暂存 + 自动收集开关 + 历史深掘）
// 浏览器半边见 ./client.js（panel bundle，经 package.json dsh.client 声明由 client-modules 收录）。
// host half 职责：
//   ① 实时采集：订阅 DSH 会话事件总线 `session/event`，把「工具失败/特征」当场判出入待审箱
//      （判定与批扫共用 collector/scanner.cjs + engine.ingestFresh，零模型 token；见 src/collector/live.cjs）；
//   ② 经 webServer 注册 /whale/* JSON 端点；业务纯逻辑在 src/ui/server.cjs。
// v0.7.8 新增：GET/POST /whale/settings（面板「自动收集」= settings.autoAdd 开关）、
//   POST /whale/sweep（面板 ⛏「历史深掘」= --add 保底 + --rebuild --add 全量重扫历史入箱）。
// 注意：新增/改动本文件的宿主能力需要重启 dsh web 才生效（浏览器半边 client.js 只需刷新页面）；
// 行注入用 profiles/web/cordis.patch.yml（deploy-web.cjs 管理）。会话平面能力另见 src/ui/contracts.md。
import server from '../src/ui/server.cjs';
import engine from '../src/collector/engine.cjs';
import liveModule from '../src/collector/live.cjs';
import repo from '../src/store/repo.cjs';
import { zstdAvailable } from '../src/collector/decoder.cjs';

const PACKAGE = { name: 'dsh-whale-notebook', version: '0.7.8' };

function sendJson(res, code, obj) {
  try {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  } catch (err) {
    /* 连接已断等：静默 */
  }
}

// 读 JSON body（上限 16KB，超限报错并销毁连接）
function readJsonBody(req, cap = 16384) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let done = false;
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      if (done) return;
      buf += chunk;
      if (buf.length > cap) {
        done = true;
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      if (buf === '') return resolve(null);
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid json body')); }
    });
    req.on('error', (err) => { if (!done) { done = true; reject(err); } });
  });
}

function wrap(handler) {
  return async (req, res) => {
    try {
      // v0.7.5（审计 N3/N4）：8 个端点统一过闸 —— Host 必须回环（防 DNS rebinding）、
      //   Origin/Referer 与 Sec-Fetch-Site 必须同源（防跨站请求）、写操作必须 JSON（防跨站简单请求）。
      //   本机面板、CLI 探针、curl 都不受影响（它们本就带回环 Host，写操作本就发 JSON）。
      const g = server.guardRequest({ method: req.method, headers: req.headers });
      if (!g.ok) return sendJson(res, g.code, { ok: false, error: g.error });
      await handler(req, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: `whale API 内部错误: ${err && err.message ? err.message : String(err)}` });
    }
  };
}

export function apply(ctx) {
  // ---- ① 实时采集（不依赖 webServer，先挂）----
  let live = null;
  try {
    live = liveModule.createLiveCollector({ logger: ctx.logger });
    ctx.on('session/event', (session, event) => live.onEvent(session, event));
    ctx.effect(() => () => {
      const p = live.dispose();
      return p && typeof p.catch === 'function' ? p.catch(() => {}) : p;
    }, 'whale-notebook: 实时采集（session/event）');
    ctx.logger.info(`[whale-notebook] v${PACKAGE.version} 实时采集已启用：session/event → 待审箱（去抖 1.5s，串行写盘）`);
  } catch (err) {
    ctx.logger.warn('[whale-notebook] 实时采集挂载失败（不影响批扫）：' + (err && err.message ? err.message : String(err)));
  }

  const web = ctx.get('webServer');
  if (!web) {
    ctx.logger.warn('[whale-notebook] webServer 服务不可用，跳过决策箱面板 API 注册');
    return;
  }
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/inbox',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      sendJson(res, 200, server.listPayload());
    }),
  }), 'whale-notebook: GET /whale/inbox');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/inbox/detail',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const id = new URL(req.url, 'http://whale.local').searchParams.get('id') || '';
      const out = server.detailPayload(id);
      if (!out.ok) return sendJson(res, 404, out);
      sendJson(res, 200, out);
    }),
  }), 'whale-notebook: GET /whale/inbox/detail');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/solved',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      sendJson(res, 200, server.solvedPayload());
    }),
  }), 'whale-notebook: GET /whale/solved');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/entry',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const id = new URL(req.url, 'http://whale.local').searchParams.get('id') || '';
      const out = server.entryPayload(id);
      if (!out.ok) return sendJson(res, 404, out);
      sendJson(res, 200, out);
    }),
  }), 'whale-notebook: GET /whale/entry');

  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/inbox/delete',
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
      }
      if (!body || typeof body.id !== 'string' || body.id === '') {
        return sendJson(res, 400, { ok: false, error: 'body 需含 { id: "C###" }' });
      }
      const out = server.deleteCandidate({ id: body.id });
      if (!out.ok) return sendJson(res, 404, out);
      sendJson(res, 200, out);
    }),
  }), 'whale-notebook: POST /whale/inbox/delete');

  // ---- v0.7：同族/相关候选（讨论会话的确定性依据：家族成员 + 相似候选 + 可能覆盖的条目）----
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/related',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const id = new URL(req.url, 'http://whale.local').searchParams.get('id') || '';
      const out = server.relatedPayload(id);
      if (!out.ok) return sendJson(res, 404, out);
      sendJson(res, 200, out);
    }),
  }), 'whale-notebook: GET /whale/related');

  // ---- v0.7.8：面板「自动收集」开关（settings.autoAdd：拉取式 ⇄ 自动入箱）----
  // 只开放 autoAdd（server.SETTINGS_WRITABLE 白名单）；写路径 = 严格读 + 原子写，
  // 损坏的 settings.json 明确报错且一个字节都不写；**全程不触碰 AGENTS.md**（提醒句口径已在
  // src/inject/agents.cjs 内改成"以命令输出为准"的双模式自述，所以切开关不需要改写全局记忆文件）。
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/settings',
    handler: wrap(async (req, res) => {
      if (req.method === 'GET') {
        try { return sendJson(res, 200, server.settingsPayload()); }
        catch (err) { return sendJson(res, 500, { ok: false, error: (err && err.message) || String(err) }); }
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
      }
      const out = server.updateAutoAdd(body);
      if (!out.ok) return sendJson(res, out.code || 400, out);
      sendJson(res, 200, out);
    }),
  }), 'whale-notebook: GET/POST /whale/settings');

  // ---- v0.5：面板 ⟳ 触发的增量扫描（先把实时缓冲落盘，再按水位线扫新增）----
  // v0.7.7（审计第 2 项）：改走 `engine.runScanAsync` —— 扫描主体按"每 8 个文件 / 每 4MB"让出事件循环，
  //   全量扫描（实测 44MB ≈5s）期间宿主不再被独占（面板其它端点、实时采集去抖器、GUI 都照常响应）。
  //   HTTP 契约与返回体**不变**（面板零改动）；插件卸载时置取消位，扫描在下一个让出点退出并释放锁。
  let scanning = false;
  let scanJob = null;      // 正在飞的那一轮（/whale/live 可见）；空闲为 null
  let scanCancelled = false;
  ctx.effect(() => () => { scanCancelled = true; }, 'whale-notebook: 扫描取消位（卸载时让在飞的扫描尽快收尾）');
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/scan',
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      if (scanning) return sendJson(res, 409, { ok: false, error: '扫描进行中，请稍后重试' });
      scanning = true;
      scanJob = { running: true, startedAt: Date.now(), files: 0, scanned: 0, skipped: 0, readBytes: 0, ms: 0 };
      try {
        if (live) { try { await live.flush(); } catch (err) { /* 实时落盘失败不阻断批扫 */ } }
        const out = await engine.runScanAsync('--check', {
          ctl: {
            cancelled: () => scanCancelled,
            onProgress: (p) => { if (scanJob) Object.assign(scanJob, p, { ms: Date.now() - scanJob.startedAt }); },
          },
        });
        if (!out.ok) return sendJson(res, 500, { ok: false, error: out.text });
        sendJson(res, 200, {
          ok: true,
          added: out.data.added.length,
          bumped: out.data.bumped.length,
          pending: out.data.pending,
          deferredTotal: out.data.deferredTotal || 0,
          deferredOn: out.data.deferredOn === true,
          ms: out.data.ms,
          scan: out.data.scan,
          text: out.text,
        });
      } finally {
        scanning = false;
        scanJob = null;
      }
    }),
  }), 'whale-notebook: POST /whale/scan');

  // ---- v0.7.8：「历史深掘」（面板 ⛏ 触发）----
  // 语义 = 把**全部历史里出现过的错误**一次性挖出来并直接放进待审箱（需求②的宿主半边）：
  //   阶段① `--add`：先把已有暂存（拉取式下的 state.deferred）冲进待审箱 —— 阶段② 的 --rebuild
  //          会清空暂存，不先冲一遍，"日志已轮转/已删除"的老发现就再也回不来了（保底不丢件）；
  //   阶段② `--rebuild --add`：清空水位线/指纹/聚簇后从头梳理全部历史；add=true 覆盖拉取式直接入箱。
  //   已处置保护不变：archive 签名在重建时**不剔除** —— 归档过/入库过的坑不会被重新开行；
  //   在箱候选走"同类+同现象认领"与聚簇累加，只加次数不新开重复行；编号下限取 max(在箱,归档)+1。
  //   单轮开行上限提到 500（默认 30）：重建时"超出上限被丢弃"会同时记下指纹 = 永久抓不到，
  //   与"抓取历史所有的错误"直接冲突；真超了 dropped 会在返回体与面板 toast 里显式暴露，不静默丢。
  //   dry=true = 只读预演（零写盘、不开维护窗口）：供 curl 验收与自测，不动用户数据。
  // 与 /whale/scan 共用 scanning 互斥位（两者都是整机扫描，同时跑只会互相等锁）。
  const SWEEP_MAX_NEW_ROWS = 500;
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/sweep',
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      let body = null;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
      }
      const dry = !!(body && body.dry === true);
      if (scanning) return sendJson(res, 409, { ok: false, error: '扫描/深掘进行中，请稍后重试' });
      scanning = true;
      const t0 = Date.now();
      scanJob = { running: true, kind: 'sweep', dry, phase: 'flush', startedAt: t0, files: 0, scanned: 0, skipped: 0, readBytes: 0, ms: 0 };
      const ctl = {
        cancelled: () => scanCancelled,
        onProgress: (p) => { if (scanJob) Object.assign(scanJob, p, { ms: Date.now() - scanJob.startedAt }); },
      };
      try {
        if (live) { try { await live.flush(); } catch (err) { /* 实时落盘失败不阻断深掘 */ } }
        let flush = null;
        if (!dry) {
          const f = await engine.runScanAsync('--add', { maxNewRows: SWEEP_MAX_NEW_ROWS, ctl });
          flush = f.ok
            ? { added: f.data.added.length, bumped: f.data.bumped.length, suppressed: f.data.suppressed.length, dropped: f.data.dropped || 0, remaining: f.data.remaining }
            : { error: f.text }; // 阶段①失败不致命（暂存为空/无归档都能继续），原因带回给面板
        }
        if (scanJob) scanJob.phase = 'rebuild';
        const out = await engine.runScanAsync('--rebuild', { add: true, dry, maxNewRows: SWEEP_MAX_NEW_ROWS, ctl });
        if (!out.ok) return sendJson(res, 500, { ok: false, error: out.text, flush });
        const d = out.data;
        sendJson(res, 200, {
          ok: true,
          dry,
          flush,
          added: d.added.length,
          bumped: d.bumped.length,
          suppressed: d.suppressed.length,
          dropped: d.dropped || 0,
          echo: d.echo || 0,
          echoEvents: d.echoEvents || 0,
          echoDupSkipped: d.echoDupSkipped || 0,
          pending: d.pending,
          deferredTotal: d.deferredTotal || 0,
          ms: d.ms,
          wallMs: Date.now() - t0,
          scan: d.scan,
          text: out.text,
        });
      } finally {
        scanning = false;
        scanJob = null;
      }
    }),
  }), 'whale-notebook: POST /whale/sweep');

  // ---- v0.5：运行状态（自检/排障：实时采集是否生效、水位线与聚簇规模）----
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/live',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const state = repo.readState();
      const files = state.files || {};
      const liveStatus = live ? live.status() : null;
      sendJson(res, 200, {
        ok: true,
        version: PACKAGE.version,
        live: liveStatus,
        watermarks: Object.keys(files).length,
        clusters: Object.keys(state.clusters || {}).length,
        fingerprints: (state.seenFingerprints || []).length,
        lastScan: state.lastScan,
        // v0.7.5（审计 N20/N25）：把"采集是否健康"暴露出来 —— 环境能力、上轮扫描健康度、写盘诊断
        zstd: zstdAvailable(),
        scan: state.lastScanStats || null,
        stuckWatermarks: Object.keys(files).filter((k) => (files[k] && files[k].badRounds || 0) > 0).length,
        diag: Object.assign({}, repo.stateDiag),
        // v0.7.6（审计第 1 项 A4）：回声归档在不在长（自我放大的观测口径）
        echo: repo.echoStats(),
        // v0.7.7（审计第 2/3 项）：正在飞的扫描（让出事件循环后可观测）＋ 维护窗口（rebuild 期间 live 让路）
        scanJob: scanJob,
        maintenance: repo.readMaintenance(),
        // v0.7.6（审计第 5 项加固）：与批扫"是否双计"的两个口径 ——
        //   toolUnknown（应为 0）与 skippedByFingerprint（>0 说明 live 与批扫共用同一指纹）
        dedup: liveStatus ? { toolUnknown: liveStatus.toolUnknown || 0, skippedByFingerprint: liveStatus.skippedByFingerprint || 0 } : null,
        // v0.7.8：面板「自动收集」开关的当前值（缺键按默认 true）。settings.json 损坏时这里只报错，
        //   不让 /whale/live 整条挂掉（它同时是排障入口）。
        settings: (() => {
          try { return server.settingsPayload(); }
          catch (err) { return { ok: false, error: (err && err.message) || String(err) }; }
        })(),
      });
    }),
  }), 'whale-notebook: GET /whale/live');

  ctx.logger.info(`[whale-notebook] v${PACKAGE.version} 决策箱面板 API 已注册：GET /whale/inbox, GET /whale/inbox/detail, GET /whale/solved, GET /whale/entry, GET /whale/related, GET /whale/live, GET /whale/settings, POST /whale/inbox/delete, POST /whale/scan, POST /whale/settings, POST /whale/sweep`);
}

export default { apply, name: PACKAGE.name, version: PACKAGE.version };
