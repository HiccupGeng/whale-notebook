// collector/live.selftest.cjs - v0.5 实时采集单测（不依赖宿主）
// 覆盖：① classifyRecord 对内存事件对象的判定（与磁盘记录同形）
//       ② 去抖 flush → 待审写入 + sidecar ③ 同一失败重复 → 累加次数而非重复行
//       ④ dispose 冲刷缓冲区 ⑤ liveCapture=false 时不写 ⑥ 实时写入不覆盖 CLI 批扫的水位线
// 运行: node src/collector/live.selftest.cjs （退出码 0 = 全过）
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-live-test-'));
process.env.DSH_HOME = tmp;
const nb = path.join(tmp, 'whale-notebook');
fs.mkdirSync(nb, { recursive: true });

const repo = require('../store/repo.cjs');
const { createLiveCollector } = require('./live.cjs');
const { classifyRecord, newSessionCtx, extractToolResult, isMetaEcho, classifyUserMessage } = require('./scanner.cjs');
const { PATTERNS } = require('./patterns.cjs');

let fails = 0;
function check(name, cond, extra) {
  if (cond) { console.log('PASS ' + name); }
  else { fails++; console.error('FAIL ' + name + (extra !== undefined ? ' :: ' + JSON.stringify(extra).slice(0, 400) : '')); }
}
const rowOf = (id) => repo.parseInboxRows().find((r) => r.id === id) || null;

const T0 = Date.parse('2026-09-10T09:00:00+08:00');
const SESSION = { id: 'sess-live', header: { cwd: 'C:\\ws\\LiveBox' } };
const ERR1 = 'EPERM: operation not permitted, mkdir C:\\out\n    at Object.mkdirSync (fs.js:1:1)';
const logs = { info: [], warn: [], debug: [] };
const logger = { info: (m) => logs.info.push(m), warn: (m) => logs.warn.push(m), debug: (m) => logs.debug.push(m) };

function evCall(cid, name, t) { return { type: 'tool/call', time: t, data: { callId: cid, name } }; }
function evResult(cid, text, isError, t) {
  return { type: 'tool/result', time: t, data: { message: { source: { callId: cid }, content: [{ type: 'tool-result', isError: !!isError, content: [{ type: 'text', text }] }] } } };
}

(async () => {
  try {
    // ---- ① classifyRecord（内存事件对象；与 session.jsonl 记录同形）----
    const st = newSessionCtx('s1', 'W');
    const okRes = evResult('k1', 'read 结果内容', false, T0);
    const r = extractToolResult(okRes.data);
    check('extractToolResult 抽取形状', r.isError === false && r.callId === 'k1' && r.text === 'read 结果内容', r);
    check('tool/call 只记映射不产生事件', classifyRecord(evCall('k1', 'pwsh', T0), st) === null);
    const e1 = classifyRecord(evResult('k1', ERR1, true, T0 + 1), st);
    check('失败结果 → error 事件且带工具名', !!e1 && e1.cat === 'error' && e1.tool === 'pwsh' && e1.sid === 's1' && e1.ws === 'W', e1);
    const st2 = newSessionCtx('s1', 'W');
    check('未登记 callId 的工具名退化为 ?', (classifyRecord(evResult('zz', ERR1, true, T0), st2) || {}).tool === '?');
    // 注：'?'（未知工具）按 v0.4 既有行为属于 COMMAND_TOOLS（会做特征扫描）；已知非命令类工具才排除
    check('成功且非命令类工具（read）不产事件', classifyRecord(evResult('k2', '文件内容 timeout 字样', false, T0), { sid: 's1', ws: 'W', callName: { k2: 'read' } }) === null);
    const e2 = classifyRecord(evResult('k3', 'Command failed: git push\nfatal: Authentication failed', false, T0), { sid: 's1', ws: 'W', callName: { k3: 'pwsh' } });
    check('命令类成功结果仍做特征扫描（git-net）', !!e2 && e2.cat === 'git-net', e2);
    const e3 = classifyRecord({ type: 'user/message', time: T0, data: { content: [{ type: 'text', text: '这个中文乱码报错又出现了，帮我看看' }] } }, st2);
    check('用户报障叙述 → encoding 事件', !!e3 && e3.cat === 'encoding' && e3.tool === 'user/message', e3);
    check('系统注入/技能框架文本被排除', classifyRecord({ type: 'user/message', time: T0, data: { content: [{ type: 'text', text: 'system-reminder: 乱码报错 token 密钥 失败' }] } }, st2) === null);

    // ---- ①b v0.6.2：回声签名扩充 + 类别误判收紧 ----
    check('回声签名：简报探针输出', isMetaEcho('### WORKSPACE: SandBox1 | <path> filesWritten: ["<file>"]')
      && isMetaEcho('workspaces: 3 ### SandBox1 | sessions: 4 | filesWritten: 8 | recentFiles: 20')
      && isMetaEcho('sessions: 6 --- 2026/8/17 | cwd <path> real user msgs: 14'), 'briefing probe');
    check('回声签名：源码摘录 / YAML 片段 / 十六进制转储',
      isMetaEcho("361: # per-session realm would answer 'service-unavailable' for every browser call.")
      && isMetaEcho("- . > disabled: true # == @deepseek-ai/dsh-base - id: llm name: '@deepseek-ai/dsh-llm'")
      && isMetaEcho('28 B5 2F FD 04 58 ED 04 00 B2 CA 23 21 50 69 9C 03'), 'excerpt/hex');
    check('不误伤：真实权限错误不算回声', isMetaEcho('ERROR: Cannot read configuration file due to insufficient permissions.') === false);
    const sb = PATTERNS.find((p) => p.id === 'sandbox-file');
    check('权限类文本归口 sandbox-file', sb.re.test('Cannot read configuration file due to insufficient permissions'));
    const ma = PATTERNS.find((p) => p.id === 'model-api');
    check('收紧后不再误命中：文件名清单里的 429 / insufficient permissions',
      ma.re.test('0 \\S3\\某剧选中 重命名 把后缀 .pdf 去掉 即可观看.txt 1023316983 \\S5\\x.mp4') === false
      && ma.re.test('Cannot read configuration file due to insufficient permissions') === false
      && ma.re.test('HTTP 429 too many requests') === true);
    check('元讨论用户请求被排除（生成经验/避坑/运行记录）',
      classifyUserMessage({ at: T0, text: '帮我梳理本机 DSH 所有的运行记录，生成经验以便避开之前已经遇到的坑，比如命令编码问题', ws: 'W', sid: 's1' }) === null);
    check('真实用户报障仍照常收（未命中框架词）',
      (classifyUserMessage({ at: T0, text: '这个中文乱码报错又出现了，帮我看看', ws: 'W', sid: 's1' })?.cat) === 'encoding');
    // v0.6.2 二次：探针自查输出（含候选编号）与 ssh 鉴权归口
    check('回声签名：含候选编号的自查输出',
      isMetaEcho('命中 2 条：\n--- C030 | model-api | demo-proj-b | ERROR ( message:Configuration error\n    摘录: insufficient permissions'));
    const gn = PATTERNS.find((p) => p.id === 'git-net');
    check('ssh 鉴权失败归口 git-net（不被权限规则抢走）',
      gn.re.test('ssh : Warning: Permanently added ... Permission denied (publickey)')
      && sb.re.test('Permission denied (publickey)') === false);

    // ---- ② 实时入箱 ----
    const live = createLiveCollector({ logger, flushMs: 5 });
    live.onEvent(SESSION, { type: 'assistant/message', time: T0, data: {} }); // 无关事件
    live.onEvent(SESSION, evCall('c1', 'pwsh', T0));
    live.onEvent(SESSION, evResult('c1', ERR1, true, T0 + 1));
    await live.flush();
    check('实时入箱 1 行', repo.pendingCount(repo.readInboxText()) === 1, repo.readInboxText());
    check('行工作区取自会话 cwd（LiveBox）', (rowOf('C001') || {}).ws === 'LiveBox', rowOf('C001'));
    check('sidecar 同步生成', fs.existsSync(path.join(nb, 'details', 'C001.md')), fs.readdirSync(path.join(nb, 'details') || []));
    check('实时日志有入箱记录', logs.info.some((m) => m.indexOf('实时入箱 +1') !== -1), logs.info);

    // ---- ③ 反复重试同一失败 → 累加次数 ----
    live.onEvent(SESSION, evResult('c1', ERR1, true, T0 + 2000));
    live.onEvent(SESSION, evResult('c1', ERR1, true, T0 + 3000));
    live.onEvent(SESSION, evResult('c1', ERR1, true, T0 + 4000));
    await live.flush();
    check('反复重试不新增行', repo.pendingCount(repo.readInboxText()) === 1, repo.readInboxText());
    check('次数累加到 4', (rowOf('C001') || {}).n === '4', rowOf('C001'));
    const stats = live.status();
    check('status 计数（4 条失败事件 / 1 新行 / ≥1 次累加 / 1 会话）', stats.events === 4 && stats.added === 1 && stats.bumped >= 1 && stats.sessions === 1, stats);

    // ---- ④ 不覆盖 CLI 批扫的水位线 ----
    const stt = repo.readState();
    stt.files['C:\\fake\\session.jsonl.zstd'] = { size: 999, mtimeMs: 111, offset: 999, ws: 'Fake' };
    repo.writeState(stt);
    live.onEvent(SESSION, evResult('c1', 'timeout: connect to host failed', true, T0 + 5000));
    await live.flush();
    check('实时写入保留批扫水位线', !!repo.readState().files['C:\\fake\\session.jsonl.zstd'], Object.keys(repo.readState().files || {}));

    // 到此刻应有 3 行：C001（首条）、C002（保留水位线那轮新增）、C003（缓冲区里待冲刷的这条）
    live.onEvent(SESSION, evResult('c1', "fatal: Authentication failed for 'https://x.invalid/r.git'", true, T0 + 6000));
    await live.dispose();
    check('dispose 冲刷缓冲区（C003 落盘）', repo.pendingCount(repo.readInboxText()) === 3 && !!rowOf('C003'), repo.readInboxText());

    // ---- ⑥ 关闭开关 ----
    fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, liveCapture: false }), 'utf8');
    const live2 = createLiveCollector({ logger, flushMs: 5 });
    live2.onEvent(SESSION, evResult('c2', 'timeout: another failure', true, T0 + 9000));
    await live2.flush();
    check('liveCapture=false → 不写盘', repo.pendingCount(repo.readInboxText()) === 3 && live2.status().skipped === 1, live2.status());
    await live2.dispose();

    // ---- ⑦ 异常不外泄 ----
    const live3 = createLiveCollector({ logger, flushMs: 5 });
    let threw = false;
    try { live3.onEvent(null, null); live3.onEvent({}, { type: 'tool/result', data: { message: { content: 'not-an-array' } } }); } catch (err) { threw = true; }
    check('畸形事件不抛异常（不影响会话）', threw === false);
    await live3.dispose();
  } catch (err) {
    fails++;
    console.error('FAIL 未捕获异常 :: ' + (err && err.stack ? err.stack : err));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})();
