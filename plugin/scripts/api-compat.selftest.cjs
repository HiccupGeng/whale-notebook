// scripts/api-compat.selftest.cjs - v0.7.10：面板与 DSH 0.2.x 客户端服务时机/API 的兼容自测
//
// 背景（本机实测根因）：0.2.x 里 `sessions` / `workspaces` / `uiWorkspace` 由官方 dsh-api-*-controller 的
// **客户端半边**提供，而它们要等"连接建立 + remote 命名空间装好"才 provide；本面板 fiber 不声明 inject、
// 开机最先 apply —— 所以**开机那一刻这些服务必然取不到**。旧写法在 apply 时 get 一次并永久缓存，
// 于是 💬详细讨论 / ⚡自动处理 / ⛏总结会话 全都只弹「当前环境无会话服务」（与 desktop/web 形态无关）。
//
// 本文件覆盖：
//   ① svcOf：取到 / undefined / 抛错 三态降级；
//   ② deliverPrompt：retain(id,{source}) → await ready → binding.session.prompt(blocks,"queue") → release
//      的正序与四类失败降级（retain 抛错 / ready 拒绝 / 无 binding / prompt 拒绝）；
//   ③ callOpenSession：有 UI 服务 → 调用并 true；缺失或抛错 → false（不炸）；
//   ④ currentSessionId：mainView 口径（0.2.x 快照无 current）+ 旧字段兜底 + 空值安全；
//   ⑤ **端到端回归**：DOM 桩 boot 面板（服务缺席）→ 之后服务就绪 → 点 💬 必须真的建会话、投递开局消息、导航过去；
//   ⑥ 服务始终缺席时只降级提示、不抛错、不建会话。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let fails = 0;
let total = 0;
function check(name, cond, extra) {
  total++;
  if (cond) console.log('PASS ' + name);
  else { fails++; console.log('FAIL ' + name + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 300))); }
}

// ---------------------------------------------------------------- bundle 装载
// WHALE_CLIENT_BUNDLE：指向另一份 client.js —— 用于"变异反证"（把修复改回旧写法，确认本自测真能抓到）
const BUNDLE = process.env.WHALE_CLIENT_BUNDLE || path.join(__dirname, '..', 'lib', 'client.js');
function loadBundle(sandboxExtras) {
  const code = fs.readFileSync(BUNDLE, 'utf8');
  let loaded = null;
  const sandbox = Object.assign({
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,      // 面板的 30s 轮询在自测里不排程（避免进程挂住）
    clearInterval: () => {},
    window: {},
  }, sandboxExtras || {});
  sandbox.window = sandbox.window || {};
  sandbox.window.window = sandbox.window;
  sandbox.window.__ModuleLoader__ = { load(registration) { loaded = registration; } };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  if (!loaded) throw new Error('bundle 未调用 __ModuleLoader__.load');
  const out = loaded.factory(function (spec) { throw new Error('bundle 意外 require 了模块: ' + spec); });
  return { out, sandbox };
}
const { out, sandbox } = loadBundle();
const I = out.__internals;
if (!I || !I.svcOf || !I.deliverPrompt || !I.callOpenSession || !I.currentSessionId) {
  throw new Error('bundle 缺少 v0.7.10 自测缝隙（svcOf/deliverPrompt/callOpenSession/currentSessionId）');
}
const flush = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 0 : ms));

(async function main() {
  // ---------------------------------------------------------------- ① svcOf
  check('svcOf：取到即返回该服务', I.svcOf({ get: () => ({ tag: 'svc' }) }, 'sessions').tag === 'svc');
  check('svcOf：未提供（undefined）→ null', I.svcOf({ get: () => undefined }, 'sessions') === null);
  check('svcOf：get 抛错（未声明服务）→ null，不冒泡', I.svcOf({ get: () => { throw new Error('no such service'); } }, 'sessions') === null);
  check('svcOf：ctx 缺失 → null', I.svcOf({}, 'sessions') === null);

  // ---------------------------------------------------------------- ② deliverPrompt
  function fakeSessions(overrides) {
    const calls = { retain: [], prompt: [], release: [] };
    const svc = {
      calls,
      retain(id, opts) {
        calls.retain.push([id, opts]);
        if (overrides && overrides.retainThrows) throw new Error('released');
        const ref = {
          sessionId: id,
          ready: overrides && overrides.readyRejects ? Promise.reject(new Error('opening failed')) : Promise.resolve(),
          release() { calls.release.push(id); },
        };
        if (
          !(overrides && overrides.noBinding)
          && !(overrides && overrides.readyRejects)
        ) {
          // binding 必须是**稳定对象**（真实实现是 record.binding；每次新建会让"包一层"的探针失效）
          const binding = {
            session: {
              prompt(blocks, mode) {
                calls.prompt.push([blocks, mode]);
                if (overrides && overrides.promptRejects) return Promise.reject(new Error('admission refused'));
                return Promise.resolve({ ok: true });
              },
            },
          };
          Object.defineProperty(ref, 'binding', { get() { return binding; } });
        }
        return ref;
      },
    };
    return svc;
  }

  const s1 = fakeSessions();
  const ok1 = await I.deliverPrompt(s1, 'sess-1', '开篇消息');
  check('deliverPrompt：retain 带上 source（引用生命周期可追溯）',
    s1.calls.retain.length === 1 && s1.calls.retain[0][0] === 'sess-1' && s1.calls.retain[0][1] && s1.calls.retain[0][1].source === 'whalePanel',
    s1.calls.retain);
  check('deliverPrompt：prompt 收到文本块与 queue 模式',
    ok1 === true && s1.calls.prompt.length === 1
    && s1.calls.prompt[0][0][0].type === 'text' && s1.calls.prompt[0][0][0].text === '开篇消息'
    && s1.calls.prompt[0][1] === 'queue',
    s1.calls.prompt);
  check('deliverPrompt：投递成功仍 release（不留悬空引用）', s1.calls.release.length === 1 && s1.calls.release[0] === 'sess-1', s1.calls.release);

  const s2 = fakeSessions({ retainThrows: true });
  check('deliverPrompt：retain 抛错 → false（不抛给调用方）', (await I.deliverPrompt(s2, 'x', 'm')) === false);
  const s3 = fakeSessions({ readyRejects: true });
  check('deliverPrompt：ready 拒绝（会话打不开）→ false 且 release 一次',
    (await I.deliverPrompt(s3, 'x', 'm')) === false && s3.calls.release.length === 1, s3.calls);
  const s4 = fakeSessions({ noBinding: true });
  check('deliverPrompt：拿不到 binding → false 且不投递',
    (await I.deliverPrompt(s4, 'x', 'm')) === false && s4.calls.prompt.length === 0, s4.calls);
  const s5 = fakeSessions({ promptRejects: true });
  check('deliverPrompt：prompt 被宿主拒 → false 且 release 一次',
    (await I.deliverPrompt(s5, 'x', 'm')) === false && s5.calls.release.length === 1, s5.calls);
  let order = [];
  const s6 = fakeSessions();
  const origPrompt = s6.retain;
  s6.retain = function (id, opts) {
    const ref = origPrompt.call(this, id, opts);
    const origReady = ref.ready;
    ref.ready = origReady.then(() => { order.push('ready'); });
    const binding = ref.binding;
    const origFn = binding.session.prompt;
    binding.session.prompt = function (blocks, mode) { order.push('prompt'); return origFn.call(this, blocks, mode); };
    return ref;
  };
  await I.deliverPrompt(s6, 'x', 'm');
  check('deliverPrompt：顺序固定 ready 先于 prompt（旧 waitBinding 轮询在 0.2.x 必然超时）',
    order.join(',') === 'ready,prompt', order);

  // ---------------------------------------------------------------- ③ callOpenSession
  const opened = [];
  check('callOpenSession：有 UI 服务 → 调用并 true',
    I.callOpenSession({ openSession: (id) => opened.push(id) }, 'sess-9') === true && opened.join(',') === 'sess-9', opened);
  check('callOpenSession：服务缺失 → false（调用方降级提示）', I.callOpenSession(null, 'sess-9') === false);
  check('callOpenSession：对象无 openSession → false', I.callOpenSession({}, 'sess-9') === false);
  check('callOpenSession：openSession 抛错 → false 不冒泡',
    I.callOpenSession({ openSession: () => { throw new Error('layout disposed'); } }, 'sess-9') === false);

  // ---------------------------------------------------------------- ④ currentSessionId
  const snapSessions = (snap) => ({ list: { getSnapshot: () => snap } });
  check('currentSessionId：取主视图 retain 的那条（0.2.x 口径）',
    I.currentSessionId(snapSessions({
      ids: ['a', 'b'], byId: { a: { retainedBy: { sidebarView: 1 } }, b: { retainedBy: { mainView: 1 } } },
    })) === 'b');
  check('currentSessionId：无人 retain → undefined',
    I.currentSessionId(snapSessions({ ids: ['a'], byId: { a: { retainedBy: {} } } })) === undefined);
  check('currentSessionId：旧内核 current 字段兜底',
    I.currentSessionId(snapSessions({ current: 'legacy', byId: {} })) === 'legacy');
  check('currentSessionId：服务缺失/快照抛错 → undefined 不冒泡',
    I.currentSessionId(null) === undefined && I.currentSessionId({ list: { getSnapshot: () => { throw new Error('closed'); } } }) === undefined);

  // ---------------------------------------------------------------- ⑤⑥ 端到端：DOM 桩 boot 面板
  const ROW = { id: 'C001', cat: 'encoding', n: 2, ws: 'SandBox1', text: '现象样本：命令内联中文', time: '2026-10-02', variants: 1 };
  const WS_ITEMS = [{ workspaceId: 'w-sandbox', path: 'C:\\DeepseekHarnes\\SandBox1', title: 'SandBox1', sessionIds: [] }];

  function makeDom() {
    let seq = 0;
    function makeNode(tag) {
      const node = {
        _id: ++seq,
        tagName: String(tag || '').toUpperCase(),
        children: [],
        parentNode: null,
        className: '',
        _text: '',
        title: '',
        dataset: {},
        style: {},
        disabled: false,
        hidden: false,
        _handlers: {},
        classList: {
          _set: new Set(),
          add(c) { this._set.add(c); },
          remove(c) { this._set.delete(c); },
          contains(c) { return this._set.has(c); },
        },
        appendChild(child) { child.parentNode = node; node.children.push(child); return child; },
        removeChild(child) {
          const i = node.children.indexOf(child);
          if (i !== -1) node.children.splice(i, 1);
          child.parentNode = null;
          return child;
        },
        contains(other) {
          let cur = other;
          while (cur) { if (cur === node) return true; cur = cur.parentNode; }
          return false;
        },
        addEventListener(type, fn) { (node._handlers[type] = node._handlers[type] || []).push(fn); },
        removeEventListener(type, fn) {
          const list = node._handlers[type] || [];
          const i = list.indexOf(fn);
          if (i !== -1) list.splice(i, 1);
        },
        querySelector() { return null; },
        getAttribute() { return null; },
        setAttribute() {},
        focus() {},
        click() {
          const handlers = (node._handlers.click || []).slice();
          for (const fn of handlers) fn({ stopPropagation() {}, target: node });
        },
      };
      Object.defineProperty(node, 'textContent', {
        get() { return node._text; },
        set(value) {
          node._text = value === undefined || value === null ? '' : String(value);
          if (node._text !== '') node.children.length = 0;   // 与 DOM 一致：赋文本即清空子节点
        },
      });
      return node;
    }
    const document = {
      head: makeNode('head'),
      body: makeNode('body'),
      hidden: false,
      _handlers: {},
      createElement: makeNode,
      createTextNode: (t) => { const n = makeNode('#text'); n.textContent = t; return n; },
      querySelector: () => null,
      addEventListener(type, fn) { (document._handlers[type] = document._handlers[type] || []).push(fn); },
      removeEventListener() {},
    };
    return { document, makeNode };
  }

  function walk(node, fn) {
    fn(node);
    for (const child of node.children) walk(child, fn);
  }
  function find(node, pred) {
    let hit = null;
    walk(node, (n) => { if (hit === null && pred(n)) hit = n; });
    return hit;
  }
  function findByText(root, text) { return find(root, (n) => n.textContent === text); }

  function makeFetch(services) {
    return function (url) {
      let payload = { ok: true };
      if (url.indexOf('/whale/inbox?') === 0 || url === '/whale/inbox') {
        payload = { ok: true, pending: 1, deferred: 0, rows: [ROW] };
      } else if (url.indexOf('/whale/solved') === 0) {
        payload = { ok: true, stats: { active: 0, disabled: 0, global: 0, project: 0 }, global: [], projects: [], disabled: [] };
      } else if (url.indexOf('/whale/settings') === 0) {
        payload = { ok: true, autoAdd: true };
      } else if (url.indexOf('/whale/inbox/detail') === 0) {
        payload = { ok: true, text: '候选详情 sidecar 正文' };
      } else if (url.indexOf('/whale/related') === 0) {
        payload = { ok: true, family: { size: 1, n: 2, variants: [] }, related: [], entries: [] };
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) });
    };
  }

  function makeCtx(services) {
    const effects = [];
    return {
      effects,
      get(name) {
        if (!(name in services)) throw new Error('service not found: ' + name);
        return services[name];
      },
      effect(fn) {
        // 与 cordis 同口径：激活时执行一次，注册的清理函数留待卸载（自测不卸载）
        const disposer = fn();
        effects.push(disposer);
        return () => { if (typeof disposer === 'function') disposer(); };
      },
    };
  }

  function makeSessionCalls() {
    return { create: [], retain: [], prompt: [], release: [], open: [] };
  }
  function fakeSessionService(calls) {
    return {
      list: { getSnapshot: () => ({ ids: [], byId: {}, phase: 'ready' }) },
      create(opts) { calls.create.push(opts); return Promise.resolve('sess-new'); },
      retain(id, opts) {
        calls.retain.push([id, opts]);
        return {
          sessionId: id,
          ready: Promise.resolve(),
          release() { calls.release.push(id); },
          get binding() {
            return {
              session: {
                prompt(blocks, mode) { calls.prompt.push([blocks, mode]); return Promise.resolve({ ok: true }); },
              },
            };
          },
        };
      },
    };
  }

  // ---- ⑤ 服务缺席（开机）→ 服务就绪（连接建立后）→ 点 💬 必须真的开会话 ----
  {
    const { document, makeNode } = makeDom();
    const calls = makeSessionCalls();
    const services = {};   // 开机时：官方控制器还没 provide（get 会抛）
    const ctx = makeCtx(services);
    const box = loadBundle({
      document,
      window: { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} } },
      fetch: makeFetch(services),
    });
    const app = box.out;
    app.apply(ctx);
    await flush(5);

    const panelRoot = find(document.body, (n) => n.className.indexOf('wh-box') !== -1);
    check('端到端：面板 boot 成功（服务缺席也不影响只读功能）', !!panelRoot);
    check('端到端：boot 时服务确实取不到（模拟 0.2.x 开机时序）',
      Object.keys(services).length === 0);

    // 连接建立 + remote 命名空间装好 → 服务到位（此后不再变化）
    services.sessions = fakeSessionService(calls);
    services.workspaces = { list: { getSnapshot: () => ({ items: WS_ITEMS, phase: 'ready' }) }, create: () => Promise.resolve({ workspaceId: 'w-global' }), rename: () => Promise.resolve({}) };
    services.uiWorkspace = { openSession(id) { calls.open.push(id); } };

    const tabLabel = findByText(panelRoot, '待审');
    check('端到端：找到待审入口 tab', !!tabLabel);
    tabLabel.parentNode.click();      // 展开待审卡
    await flush(5);
    const discussBtn = findByText(panelRoot, '💬');
    check('端到端：候选行渲染出 💬 讨论入口', !!discussBtn);
    discussBtn.click();
    await flush(20);

    check('端到端：💬 真的建了会话（旧代码此处只弹"当前环境无会话服务"）',
      calls.create.length === 1, calls.create);
    check('端到端：落点=候选唯一工作区（planDiscuss 的口径未被破坏）',
      calls.create[0] && calls.create[0].workspaceId === 'w-sandbox', calls.create);
    check('端到端：开局消息经 retain→ready→prompt("queue") 送达',
      calls.prompt.length === 1 && calls.prompt[0][1] === 'queue'
      && calls.prompt[0][0][0].text.indexOf('【决策箱转入·详细讨论】') === 0,
      calls.prompt[0] && calls.prompt[0][0] && calls.prompt[0][0][0] && calls.prompt[0][0][0].text.slice(0, 40));
    check('端到端：开局消息带上落点与依据（原有契约）',
      calls.prompt.length === 1 && calls.prompt[0][0][0].text.indexOf('本会话工作区：SandBox1') !== -1
      && calls.prompt[0][0][0].text.indexOf('仅出现在 SandBox1') !== -1);
    check('端到端：导航走 ctx.uiWorkspace.openSession（旧 sessions.open 已移除）',
      calls.open.length === 1 && calls.open[0] === 'sess-new', calls.open);
    check('端到端：投递后释放面板自己的引用（不留悬空 retain）',
      calls.release.length === 1 && calls.release[0] === 'sess-new', calls.release);
    const toastEl = find(document.body, (n) => n.className.indexOf('wh-toast') !== -1);
    check('端到端：toast 报「已开讨论会话」而不是「无会话服务」',
      !!toastEl && toastEl.textContent.indexOf('已开讨论会话') === 0
      && toastEl.textContent.indexOf('无会话服务') === -1, toastEl && toastEl.textContent);
  }

  // ---- ⑥ 服务始终缺席：只降级提示，不抛错、不建会话 ----
  {
    const { document } = makeDom();
    const services = {};
    const ctx = makeCtx(services);
    let observedError = null;
    const box = loadBundle({
      document,
      window: { addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {} } },
      fetch: makeFetch(services),
    });
    box.out.apply(ctx);
    await flush(5);
    const panelRoot = find(document.body, (n) => n.className.indexOf('wh-box') !== -1);
    findByText(panelRoot, '待审').parentNode.click();
    await flush(5);
    try {
      findByText(panelRoot, '💬').click();
      await flush(20);
    } catch (e) { observedError = e; }
    const toastEl = find(document.body, (n) => n.className.indexOf('wh-toast') !== -1);
    check('端到端·降级：服务始终缺席时提示「当前环境无会话服务」且不抛错',
      observedError === null && !!toastEl && toastEl.textContent.indexOf('当前环境无会话服务') === 0,
      { err: observedError && observedError.message, toast: toastEl && toastEl.textContent });
  }

  console.log(fails ? ('FAILED: ' + fails) : 'ALL PASS（v0.7.10 面板 × DSH 0.2.x 客户端 API ' + total + ' 项断言）');
  process.exit(fails ? 1 : 0);
})().catch((error) => {
  console.error('SELFTEST CRASH:', error && error.stack ? error.stack : error);
  process.exit(1);
});
