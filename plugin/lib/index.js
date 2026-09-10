// lib/index.js - dsh-whale-notebook 插件宿主半边（v0.6：实时采集 + 决策箱面板 API + 拉取式暂存）
// 浏览器半边见 ./client.js（panel bundle，经 package.json dsh.client 声明由 client-modules 收录）。
// host half 职责：
//   ① 实时采集：订阅 DSH 会话事件总线 `session/event`，把「工具失败/特征」当场判出入待审箱
//      （判定与批扫共用 collector/scanner.cjs + engine.ingestFresh，零模型 token；见 src/collector/live.cjs）；
//   ② 经 webServer 注册 /whale/* JSON 端点；业务纯逻辑在 src/ui/server.cjs。
// 注意：新增/改动本文件的宿主能力需要重启 dsh web 才生效（浏览器半边 client.js 只需刷新页面）；
// 行注入用 profiles/web/cordis.patch.yml（deploy-web.cjs 管理）。会话平面能力另见 src/ui/contracts.md。
import server from '../src/ui/server.cjs';
import engine from '../src/collector/engine.cjs';
import liveModule from '../src/collector/live.cjs';
import repo from '../src/store/repo.cjs';

const PACKAGE = { name: 'dsh-whale-notebook', version: '0.6.2' };

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

  // ---- v0.5：面板 ⟳ 触发的增量扫描（先把实时缓冲落盘，再按水位线扫新增）----
  let scanning = false;
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/scan',
    handler: wrap(async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      if (scanning) return sendJson(res, 409, { ok: false, error: '扫描进行中，请稍后重试' });
      scanning = true;
      try {
        if (live) { try { await live.flush(); } catch (err) { /* 实时落盘失败不阻断批扫 */ } }
        const out = engine.runScan('--check');
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
      }
    }),
  }), 'whale-notebook: POST /whale/scan');

  // ---- v0.5：运行状态（自检/排障：实时采集是否生效、水位线与聚簇规模）----
  ctx.effect(() => web.register({
    kind: 'exact',
    path: '/whale/live',
    handler: wrap((req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
      const state = repo.readState();
      sendJson(res, 200, {
        ok: true,
        version: PACKAGE.version,
        live: live ? live.status() : null,
        watermarks: Object.keys(state.files || {}).length,
        clusters: Object.keys(state.clusters || {}).length,
        fingerprints: (state.seenFingerprints || []).length,
        lastScan: state.lastScan,
      });
    }),
  }), 'whale-notebook: GET /whale/live');

  ctx.logger.info(`[whale-notebook] v${PACKAGE.version} 决策箱面板 API 已注册：GET /whale/inbox, GET /whale/inbox/detail, GET /whale/solved, GET /whale/entry, GET /whale/live, POST /whale/inbox/delete, POST /whale/scan`);
}

export default { apply, name: PACKAGE.name, version: PACKAGE.version };
