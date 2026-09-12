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
const { fpOf, clusterKey } = require('./engine.cjs'); // v0.7.6：live/批扫指纹一致性不变量

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

    // ---- ①c v0.7.1：回声过滤补漏（转储信封 / 会话记录 JSON 信封 / notebook 渲染行）----
    // 三条都是「复核旧候选 / 自检采集器」时真实出现过的输出形态：信封与原文都不含既有强特征，
    // 旧版三道过滤全放过 → 同一物理事件被当成新事件开行、反复「复发」（实测 C109）。
    check('回声签名：会话日志转储信封（==== L### / kind= / type=）',
      isMetaEcho('==== L3199 tool/result [{"type":"text","text":"=== trying 10.0.0.1 ==="}]')
      && isMetaEcho('==== L2809 [1786939705608] kind=tool/call')
      && isMetaEcho('OLD TOTAL 5426 --- OLD L3197 type=assistant/message time=1786940004818'));
    check('回声签名：会话记录 JSON 信封（含反斜杠转义形态）',
      isMetaEcho('[{\\"type\\":\\"tool/result\\",\\"seq\\":1014}]') && isMetaEcho('{"type":"user/message","time":1}'));
    check('回声签名：notebook 渲染行（候选行 / 条目行 / echo 归档行）',
      isMetaEcho('| C109 | git-net | 1 | SandBox1 | 复发（原 C087）：… | 2026-09-10 11:03 |')
      && isMetaEcho('| E002 | 推送失败多为瞬时网络 | 先判瞬时再重试 | 6 | 2026-08-17 |')
      && isMetaEcho('--- echo tail ---\n| 2026-09-10 12:21 | error | 2 | SandBox1 | edit requires reading "<file>" first |'));
    // v0.7.1 修正：成功路径会把输出压成单行 → 表行判据必须不锚定（带 ^ 则实测漏网）
    check('回声签名：压成单行后的 notebook 表行（不锚定）',
      isMetaEcho('总行数=209 | 2026-09-10 14:22 | error | 1 | SandBox1 | edit requires reading "<file>" first')
      && isMetaEcho('inbox 25 行 | C109 | git-net | 1 | SandBox1 | 复发（原 C087）：… | 2026-09-10 11:03 |'));
    check('不误伤：普通表格（时间戳后不是类别词）不算回声',
      isMetaEcho('| 2026-09-10 14:22 | 某表头 | 某值 |') === false
      && isMetaEcho('| 2026-09-10 14:22 | foo | bar | baz |') === false);
    check('不误伤：同一失败原文本身（无转储信封）仍按真实故障处理',
      isMetaEcho("=== trying 140.82.114.3 ===\n=== trying 20.27.177.113 ===\nPUSH OK via 20.27.177.113\n[stderr]\ngit : fatal: unable to access 'https://github.com/o/r.git/': Recv failure: Connection was reset") === false);

    // ---- ①d v0.7.6（审计第 1 项 A2/A3）：回声自我放大治理 ——「我们自己的产物」不许进候选池 ----
    // 13 条样本全部取自真实历史（2026-09-11 实测：18 条暂存里 13 条是这种自引用输出，占 72%）。
    const REAL_LEAKS = [
      'HTTP 200 {"ok":true,"id":"C122","candidate":{"id":"C122","cat":"encoding"',
      'lines=2946 chars=129046 idx=123471 286, "reAddedAt": 0, "reAdds": 0, "family": null,',
      'encoding-probe: [stderr] [eval]:2 const {zstdDecompressSync}=require(node:zlib);',
      "exists=True lines=163 119: mirrorDir(path.join(NB, 'plugin'), path.join(REPO, 'plugin'));",
      '=== listEntries === E001 | active | global | occ=7 | 2026-08-17~2026-09-10 | ws=SillyTaver',
      'topKeys=ok,stats,global,projects,disabled rawHead={"ok":true,"stats":{"active":4,"global":',
      'panel_ids = E001(编码/中文乱码(命令链路/控制台),occ=7) ; E004(编码/中文乱码(命令链路/控制台)',
      'logged97 statNow ok=0 bad=97 ~\\.dsh\\profiles\\node_modules\\anser <= ENOENT',
      '== clusters sample (2614-2660) == "clusters": { "1bs4rio": { "cid": "C081", "cat":',
      '=== lifecycle/selftest.cjs === ok( total occurrences : 56 ok( statement-lines : 55 expectE',
      'archive-20260909.md rows 1 parsed 1 unparsed 0 disp非空 1 disp空 0 列数分布 {"8":1}',
      'C001 parts=7 ["C001","encoding","3+","SillyTavern-Agent 等","命令/请求体内联中文被控制台链路破坏',
      'v 2 lastScan 2026-09-11T03:00:07.431Z files 30 clusters 59 deferred 14 seen 200 nextCandidateId 137',
      // ← 本条是 v0.7.6 实施当天由"旧宿主进程"（尚未重启、仍是旧签名）漏进来的同类污染，故一并入样本
      'deferred=5 seen=215 next=137 zahbbc | error | n=1 | [sandbox: file access denied',
    ];
    check('A2 回声签名：14 条真实漏网样本全部命中',
      REAL_LEAKS.every((t) => isMetaEcho(t)), REAL_LEAKS.filter((t) => !isMetaEcho(t)));
    // 反证集：同机同日的真实报障必须继续进箱 —— 一条都不许被误伤（宁可漏滤不可误伤）
    const REAL_FAULTS = [
      '[sandbox: file access denied under workspace-write mode]',
      '--- 1) DNS --- 20.205.243.166 --- 2) TCP443 --- github.com:443 reachable = False --- 3) 退避重试（最多 3 次）',
      '--- SSH 认证探测（BatchMode，不会卡在输入）--- exit=255 ssh : git@github.com: Permission denied (publickey).',
      'Error: tool call timed out after 30000ms',
      'Error: unknown tool "bash"',
    ];
    check('A2 反证：5 条真实故障一条都不误伤',
      REAL_FAULTS.every((t) => isMetaEcho(t) === false), REAL_FAULTS.filter((t) => isMetaEcho(t)));
    // A3 出处判定：命令碰过我们的数据产物 + 结果是我们自己渲染的结构化输出 → 判回声
    const stP = newSessionCtx('s9', 'W');
    classifyRecord({ type: 'tool/call', time: T0, data: { callId: 'p1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-Content $env:DSH_HOME\\whale-notebook\\state.json -Raw' }) } }, stP);
    const ePrint = classifyRecord(evResult('p1', '[stderr] stray\n{ "foo": 1 }\n| a | b | c |', true, T0 + 1), stP);
    check('A3 出处判定：打印我们的 state.json（结构化输出）被判回声', !!ePrint && ePrint.meta === true, ePrint);
    // 反证 1：同一出处，但结果是"真实报错"（无渲染痕迹）→ 必须仍进箱
    const ePlain = classifyRecord(evResult('p1', "ENOENT: no such file or directory, open 'state.json'", true, T0 + 2), stP);
    check('A3 反证：同一出处的真实报错不被误伤', !!ePlain && ePlain.meta === false, ePlain);
    // 反证 2：开发我们自己的源码（plugin/src）不算"打印产物" —— 历史上真从自检里发现过框架级 bug
    const stD = newSessionCtx('s9', 'W');
    classifyRecord({ type: 'tool/call', time: T0, data: { callId: 'd1', name: 'node', arguments: JSON.stringify({ command: 'node plugin/src/collector/engine.selftest.cjs' }) } }, stD);
    const eDev = classifyRecord(evResult('d1', 'RangeError: The value of "offset" is out of range\n{ "x": 1 }', true, T0 + 1), stD);
    check('A3 反证：开发源码时的真实失败仍进箱', !!eDev && eDev.meta === false, eDev);
    // A3 前提：命令摘要必须跨窗口继承（增量窗口常常只剩 tool/result，没有 tool/call）
    const cInherit = newSessionCtx('s9', 'W', {}, { x1: 'Get-Content $env:DSH_HOME\\whale-notebook\\inbox.md' });
    const eInherit = classifyRecord(evResult('x1', '| C001 | error | 1 | W | x | 2026-09-11 10:00 |', true, T0), cInherit);
    check('A3 命令摘要跨窗口继承（增量扫描仍能判定出处）', !!eInherit && eInherit.meta === true, eInherit);
    // v0.7.6（审计第 5 项）：live 与批扫必须算出**逐字节相同**的指纹 —— 否则同一物理事件会被两侧各记一次。
    //   实测依据：25/25 指纹 sid 与磁盘会话目录名一致；本断言把"两条路同一函数、同一身份"钉进单测。
    const fpOfRec = (ctx) => { const ev = classifyRecord(evResult('c1', ERR1, true, T0 + 1), ctx); return fpOf(ev, clusterKey(ev)); };
    const fpLive = fpOfRec(newSessionCtx('sess-live', 'LiveBox', { c1: 'pwsh' }));
    const fpBatch = fpOfRec(newSessionCtx('sess-live', 'LiveBox', { c1: 'pwsh' }, { c1: 'Get-Content inbox.md' }));
    check('live 与批扫指纹逐字节一致（含命令摘要继承）', typeof fpLive === 'string' && fpLive.indexOf('sess-live|') === 0 && fpLive === fpBatch, { fpLive, fpBatch });

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
    // v0.7.6（审计第 5 项加固）：同一条事件重复投递（同 sid/时间/文本）= 指纹已见 → 不重复入库
    live.onEvent(SESSION, evResult('c1', ERR1, true, T0 + 4000));
    await live.flush();
    const stats2 = live.status();
    check('同指纹事件被跳过（skippedByFingerprint ≥ 1）', stats2.skippedByFingerprint >= 1, stats2);
    check('跳过不改变行数与次数', repo.pendingCount(repo.readInboxText()) === 1 && (rowOf('C001') || {}).n === '4', rowOf('C001'));
    check('工具名未解析（?）计数为 0：双计唯一残留风险的观测口径', stats2.toolUnknown === 0, stats2);

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
    // ---- ⑧ v0.7.4（审计 N18）：实时路径也查「已处置」索引（原来根本不传 resolved） ----
    const archDir = path.join(nb, 'archive');
    fs.mkdirSync(archDir, { recursive: true });
    fs.writeFileSync(path.join(archDir, 'archive-20260912.md'),
      '# 归档\n\n| 编号 | 类别 | 次数 | 工作区 | 现象（已打码） | 时间 | 处置 |\n|---|---|---|---|---|---|---|\n'
      + '| C950 | error | 1 | LiveBox | timeout: connect to host failed | 2026-09-10 09:00 | 面板删除 2026-09-10 09:00 |\n', 'utf8');
    const beforeRows = repo.pendingCount(repo.readInboxText());
    const live4 = createLiveCollector({ logger, flushMs: 5 });
    live4.onEvent(SESSION, evResult('c9', 'timeout: connect to host failed', true, T0 + 20000));
    await live4.flush();
    check('实时撞见已处置签名 → 不开新行', repo.pendingCount(repo.readInboxText()) === beforeRows,
      { before: beforeRows, after: repo.pendingCount(repo.readInboxText()), inbox: repo.readInboxText().trim().slice(-120) });
    await live4.dispose();

    // ---- ⑨ v0.7.7（审计第 3 项）：维护窗口期间让路但不丢事件 ----
    // 背景：`--rebuild` 会清空派生状态并从头梳理历史；期间实时采集若照写，就与"重建后的世界"交错。
    //   语义是"让路 + 不丢"：事件留在内存缓冲、1s 后重试；窗口由标记文件的 expiresAt 兜底自愈。
    const live5 = createLiveCollector({ logger, flushMs: 5 });
    // ⑥ 段把 liveCapture 关掉了，这里要先恢复（否则会走"开关关闭"分支而不是维护窗口分支）
    fs.writeFileSync(path.join(nb, 'settings.json'), JSON.stringify({ autoCollect: true, liveCapture: true }), 'utf8');
    repo.writeMaintenance({ kind: 'rebuild', expiresAt: Date.now() + 60000 });
    const heldBefore = repo.pendingCount(repo.readInboxText());
    live5.onEvent(SESSION, evResult('cm1', 'fatal: cannot flush while rebuilding', true, T0 + 30000));
    await live5.flush();
    const s5 = live5.status();
    check('维护窗口：flush 让路（heldByMaintenance ≥1 且不写盘）',
      s5.heldByMaintenance >= 1 && repo.pendingCount(repo.readInboxText()) === heldBefore && s5.buffered === 1, s5);
    check('维护窗口标记可读回（kind=rebuild）', (repo.readMaintenance() || {}).kind === 'rebuild', repo.readMaintenance());
    repo.clearMaintenance();
    await live5.flush();
    check('窗口关闭后缓冲补上（事件一条不丢）',
      repo.pendingCount(repo.readInboxText()) === heldBefore + 1 && live5.status().buffered === 0, live5.status());
    await live5.dispose();
  } catch (err) {
    fails++;
    console.error('FAIL 未捕获异常 :: ' + (err && err.stack ? err.stack : err));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(fails === 0 ? 'ALL PASS' : `FAILED: ${fails}`);
  process.exit(fails === 0 ? 0 : 1);
})();
