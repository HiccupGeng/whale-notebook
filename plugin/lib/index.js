// lib/index.js - dsh-whale-notebook 插件宿主半边（v2.1 主机平面：决策箱面板 API）
// 浏览器半边见 ./client.js（panel bundle，经 package.json dsh.client 声明由 client-modules 收录）。
// host half 职责：经 webServer 注册 /whale/* JSON 端点；业务纯逻辑在 src/ui/server.cjs。
// 注意：本机 cordis 装载器契约以 @deepseek-ai/dsh-* 包与 dump-config 为准；行注入用
// profiles/web/cordis.patch.yml（deploy-web.cjs 管理）。会话平面能力(工具/preset)另见 src/ui/contracts.md。
import server from '../src/ui/server.cjs';

const PACKAGE = { name: 'dsh-whale-notebook', version: '0.2.1' };

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

  ctx.logger.info('[whale-notebook] 决策箱面板 API 已注册：GET /whale/inbox, POST /whale/inbox/delete');
}

export default { apply, name: PACKAGE.name, version: PACKAGE.version };
