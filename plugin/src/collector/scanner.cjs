// collector/scanner.cjs - 失败/特征事件抽取（只读）
// v0.5：把「一条会话记录 → 一条事件」的判定抽成 classifyRecord（纯函数 + 会话上下文），
//   【批扫】（读磁盘 zstd）与【实时采集】（宿主 session/event，内存事件对象）共用同一函数：
//   两者的事件形状完全一致（type/time/data），因此判定表/过滤规则永不漂移。
//   批扫侧新增增量入口 collectEventsFrom(file, offset)。
'use strict';
const path = require('path');
const { decodeLinesFrom, textOf } = require('./decoder.cjs');
const { PATTERNS, NARRATION_IDS } = require('./patterns.cjs');

const COMMAND_TOOLS = ['pwsh', 'bash', 'node', '?'];
// 命令类工具成功结果的自引用排除（mine/统计/inbox 文本含类别词，不能当新发现）
const SELF_REF = /whale-notebook|mine\.cjs|--check|--stats|--prewarm|whale notebook|次 \| 工作区|inbox\.md|\| C\d\d+/;
// 系统框架/长叙述排除（AGENTS 注入、技能目录、技能正文、审核清单等）
// v0.6.2：补「讨论本机制本身」的元叙述（例如『帮我梳理运行记录、生成经验避坑』），
//   这类用户请求虽是真用户消息，但属元讨论，不是可沉淀的运行坑。
const FRAME_RE = /system-reminder|Current runtime context|Instructions from:|workspace instructions|whale-notebook:rules|skill_content|available_skills|whale-notebook|小本本|复盘|候选|拟规则|E0\d\d|生成经验|经验库|避坑|运行记录/;
// v2.1：encoding 类别的自引用过滤——为定位编码问题而跑的解码/探针脚本，其命令行与输出
// 天然含“乱码/????/GBK/代码页”等特征词，会被当成新发现反复进箱（实测 C001 之后新增 9 条回声）。
// 只过滤诊断签名（采集器源码名/探针输出标记），不碰真实用户报障与真实损坏证据。
const ENC_DIAG_RE = /collector\/|patterns\.cjs|scanner\.cjs|decoder\.cjs|--stats|qmark|rawLinesWithEncodingMarker|codepoints|Active code page|OutputEncoding|tool=[\w-]+\|enc|\|enc\||命令体内|byTool|inline body charCodes|--- kept|self-reference/;
const STRONG_USER = /编码|乱码|报错|失败|坑|EPERM|拒绝|超时|token|密钥/;

// v0.5.1：自引用/探针回声过滤（对失败与成功结果一视同仁）
// 背景：SELF_REF / ENC_DIAG_RE 原先只作用于「成功的命令结果」，`error` 类事件直接绕过 →
//   「维修采集器自身 / 研究会话日志格式」时产生的失败与探针输出会反复进待审箱
//   （实测真实历史 26 条新候选中约 20 条属此类）。
// 设计：两级签名，宁可漏滤不可误伤——
//   STRONG：单条命中即判回声（采集器自身产物、探针输出抬头等唯一性标记）
//   WEAK  ：需 ≥2 条同时命中（弱特征，单独出现时很可能是真实故障文本）
// 命中者不直接丢弃：标记 meta=true 交给 engine 落档（archive/echo-*.md）后再排除，全程可审计。
// v0.6.2 扩充（实测漏网的回声类别）：
//   ① 简报技能自己的扫描输出（sessions:/workspaces:/### WORKSPACE:/filesWritten:/recentFiles:/real user msgs:/user: N | asst: N）
//   ② DSH 源码与 profile 摘录（行号前缀 `361: …`、YAML 片段 `- id: …`）
//   ③ zstd 十六进制转储（连续 ≥8 个 hex 字节对）
const META_STRONG = /whale-notebook|mine\.cjs|inbox\.md|details[\\/]C\d{3,}|\[dry 只读\]|新发现 \d+ 条|待审共|byCat|byTool|ENC_DIAG|SELF_REF|(?:collector|scanner|decoder|patterns|engine|live|summarize|repo|agents|schema|server|cli)\.(?:selftest\.)?c?js|bundle-smoke|deploy-web|sync-release|clusterKey|fpOf|ingestFresh|AUTO_VISIBLE|frame layout|endNL=|P1-start|FULL FAILING COMMAND|variant A|ContentType without charset|hex:E4|提交详情|本地核对|远程库元信息|dsh-global-rules|fetch upstream main|real scanner|patched copy|### WORKSPACE:|filesWritten:|recentFiles:|real user msgs:|^\s*\d{1,5}: \S|(?:\b[0-9A-Fa-f]{2}\b[ ]){7,}/im;
const META_WEAK = [
  /cordis/i, /plugin-group/i, /dsh-host-webserver/i, /ctx\.router/i, /dump-config/i,
  /session\.jsonl\.zstd/i, /frames=\d+/, /midLineFrames/i, /gbk decode/i, /utf8 parse OK/i,
  /with \?\?\?\? runs=/, /maxlen=/, /runs=\d+/,
  /permission\/preset/, /sandbox\/mode/, /approval\/policy/, /types: \{/, /before : \{/, /after : \{/,
  /"git-net":\d+/, /"model-api":\d+/, /"file-missing":\d+/,
  /inbox HTTP/i, /"ok":true,"pending"/,
  /repo\?/, /--- remote ---/, /--- gh ---/,
  /AppData\\Roaming\\npm/i, /@deepseek-ai/,
  // v0.6.2：简报探针与源码摘录的弱特征（单独出现不算，≥2 条同时命中才判回声）
  /\bsessions: \d+/i, /\bworkspaces: \d+/i, /\buser: \d+ \| asst: \d+/i, /\basst: \d+/i,
  /disabled: true/, /- id: /i, /service-unavailable/i, /\bbyCat\b/i,
  // v0.6.2 二次：候选编号 / 探针输出抬头（如「命中 2 条：--- C030 | model-api | …」这类自查输出）
  /\bC\d{3,}\b/, /命中 \d+ 条/, /摘录[:：]/, /正则自检/, /候选详情/,
];
// v0.7.1 补漏：「转储/回显」型回声 —— 工具结果里把历史记录重新渲染出来的那类输出
// 实测漏网：为复核某个旧候选而跑的解码/转储脚本，输出是「转储信封 + 旧失败原文」，
//   信封与原文都不含 `whale-notebook`、`mine.cjs` 等既有强特征 →
//   三道过滤（SELF_REF / ENC_DIAG / META_*）全放过，于是同一物理事件被当成新事件开行、
//   反复「复发」。判据只认**渲染痕迹**（信封/表行），不认失败语义，故不误伤真实报错原文。
//   ① 会话日志转储信封：`==== L3199 tool/result`（行号+记录类型）、`kind=tool/call`、`type=assistant/message`
//   ② 会话记录 JSON 信封：`{"type":"tool/result"…}`（含反斜杠转义形态 `{\"type\":\"tool/result\"`）
//   ③ notebook 自身渲染的表行：候选行 `| C### | … |`、条目行 `| E### | … |`、回声归档行 `| 时间 | 类别 | … |`
// v0.7.1 修正（实测踩到）：③ **不能带 `^` 行首锚** —— 成功路径会先把输出压成单行
//   （`raw.replace(/\s+/g, ' ')`），带锚则永远匹配不到（实测：打印 echo 归档行的命令输出照样进暂存）。
//   故三条表行判据一律不锚定；「时间戳行」额外要求后随**类别词**，免得误伤普通表格。
// v0.7.6（审计第 1 项：回声自我放大）两层补漏，见 META_ARTIFACT / isOwnOutput：
//   A2 我们自己的产物标识与抬头（state 字段名、探针抬头、API 信封）→ 单条命中即判；
//   A3 按出处整类拦截（命令碰过数据产物/接口 + 结果是我们渲染的结构化输出）→ 未来新增形态无需再补签名。
const META_DUMP = /={3,}\s*L\d+\s+(?:tool|assistant|user|session|step|reasoning|text|permission|approval|sandbox|command|todo)[/-]|\bkind=(?:tool|assistant|user|step|session|permission|approval|sandbox|command)[/-]|\btype=(?:tool|assistant|user|step|session)[/-]|\\?"type\\?":\\?"(?:tool\/result|tool\/call|assistant\/(?:message|chunk)|user\/message|reasoning-chunks|text-chunks|tool-call-chunks|step\/(?:start|end)|session|command\/(?:run|done))\\?"|\|\s*C\d{3,}\s*\|[^|\n]*\|[^|\n]*\|[^|\n]*\||\|\s*E\d{3,}\s*\|[^|\n]*\|[^|\n]*\||\|\s*\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*\|\s*(?:encoding|stale-fs|sandbox-[a-z-]+|approval|tool-mode|git-net|secret|session-state|data-access|long-session|timeout|model-api|file-missing|port-busy|error|other)\s*\|/;

// v0.7.6（回声自我放大治理 A2）：把我们「自己的产物」独有的串收进强特征 —— 单条命中即判回声。
//   实测背景：v0.7.1 的三道签名只认渲染痕迹与源码名，而真实历史里 18 条暂存有 13 条（72%）是
//   我们自己的探针/接口/状态转储（`HTTP 200 {"ok":true,…}`、`"reAddedAt"` 字段名、`topKeys=` 抬头…），
//   它们以「命令类工具的成功结果」形态出现（甚至非零退出码 → 走 error 分支绕过 SELF_REF）→ 全部漏网。
//   选取原则：只放**真实故障文本里不可能出现**的串（我们自己的标识符与抬头），
//   每条都必须能被「真实故障反证集」证伪（宁可漏滤不可误伤）。
const META_ARTIFACT = new RegExp([
  // ① state.json 的字段名（全世界只有本插件用这五个标识符）
  '\\bseenFingerprints\\b', '\\bnextCandidateId\\b', '\\breAddedAt\\b', '\\blastScanStats\\b', '\\bfamilyScore\\b',
  // ② 一次性探针的抬头（我们自己写的排障脚本输出）
  'encoding-probe', 'topKeys=', 'panel_ids', 'rawHead=', 'exists=True lines=',
  'logged\\d+ statNow', '=== listEntries ===', 'parts=\\d+ \\[', '== clusters sample',
  'archive-\\d{8}\\.md rows', 'selftest\\.cjs', '\\btotal occurrences\\b',
  // ②b 我们自己的「一行式体检」输出（`deferred=5 seen=215 next=137 …`）——真实故障文本里不会出现这种计数形态
  '(?:deferred|seen|watermarks)=\\d+',
  // ③ 我们自己的渲染残留
  '--- echo tail ---', '\\|\\s*时间\\s*\\|\\s*类别\\s*\\|',
].join('|'));
// ④ 我们 API 的 JSON 信封：`"ok":true` 必须与我们的键名同时出现（单独出现太泛，会误伤）
const META_API_ENV = /"ok"\s*:\s*true/;
const META_API_KEY = /"(?:candidate|deferredTotal|entries|related|watermark|fingerprints)"\s*:/;

// v0.7.6（A3）：按「出处」整类拦截 —— 命令碰过我们自己的**数据产物/接口**，且结果里是**渲染出来的结构化输出**。
//   两个条件必须同时满足：只按命令判会误伤「跑自检发现的真实 bug」（历史上真发现过框架级 bug）；
//   只按文本判就是现状（漏）。命中后不丢弃：仍落 archive/echo-*.md 供审计。
//   注意：只认数据产物与 /whale/* 端点，**不认 plugin/src|lib|scripts**（开发我们自己的源码不算自引用）。
const OWN_ASSET_RE = /whale-notebook[\\/](?:state\.json|inbox\.md|INDEX\.md|details|archive|entries)|[\\/]whale[\\/](?:live|inbox|solved|scan|related|entry)\b|mine\.cjs/;
const RENDER_ROW_RE = /\|[^|\n]{0,200}\|[^|\n]{0,200}\|/;          // ≥3 列的表格行
const RENDER_JSON_RE = /\{\s*"[\w-]+"\s*:/;                        // JSON 对象字面量
function isOwnOutput(cmd, text) {
  const c = String(cmd == null ? '' : cmd);
  if (!c || !OWN_ASSET_RE.test(c)) return false;
  const s = String(text == null ? '' : text);
  return RENDER_ROW_RE.test(s) || RENDER_JSON_RE.test(s);
}

function isMetaEcho(text) {
  const s = String(text == null ? '' : text);
  if (!s) return false;
  if (META_STRONG.test(s)) return true;
  if (META_ARTIFACT.test(s)) return true; // v0.7.6（A2）：我们自己的产物标识/抬头（单条命中即判）
  if (META_API_ENV.test(s) && META_API_KEY.test(s)) return true; // v0.7.6（A2）：我们 API 的 JSON 信封
  if (META_DUMP.test(s)) return true; // v0.7.1：转储/回显型回声（单条命中即判）
  let n = 0;
  for (const re of META_WEAK) if (re.test(s)) { n++; if (n >= 2) return true; }
  return false;
}

function lastSeg(p) {
  const segs = String(p || '').split(/[\\/]/).filter(Boolean);
  return segs.length ? segs[segs.length - 1] : '';
}

// tool/result 事件 → { isError, text, callId }（不判定，只抽取）
function extractToolResult(data) {
  const content = data && data.message && data.message.content;
  let isError = false;
  let text = '';
  const callId = (data && data.message && data.message.source && data.message.source.callId) || null;
  if (Array.isArray(content)) {
    for (const c of content) {
      if (c && c.type === 'tool-result') {
        if (c.isError) isError = true;
        if (Array.isArray(c.content)) for (const cc of c.content) if (cc && cc.type === 'text') text += cc.text;
      }
    }
  }
  return { isError, text, callId };
}

// v0.7.6（A3）：从 tool/call 的 arguments（JSON 字符串）里取「命令/目标」摘要，供出处判定用。
//   取不到就返回 ''（判定自然不生效）——**绝不因为解析失败而改变既有判定**。
const CMD_KEYS = ['command', 'cmd', 'script', 'file_path', 'path', 'pattern', 'query', 'url', 'id'];
function cmdOf(args) {
  if (typeof args !== 'string' || !args) return '';
  let o = null;
  try { o = JSON.parse(args); } catch { return args.replace(/\s+/g, ' ').trim().slice(0, 400); }
  if (!o || typeof o !== 'object') return '';
  for (const k of CMD_KEYS) if (typeof o[k] === 'string' && o[k]) return o[k].replace(/\s+/g, ' ').trim().slice(0, 400);
  return '';
}

// 工具结果判定（失败优先；成功结果只对命令类工具做特征扫描）
function classifyToolResult(ev) {
  const raw = String(ev.text == null ? '' : ev.text);
  // v0.7.6（A3）：出处判定 —— 命令碰过我们的数据产物/接口，且结果是我们自己渲染出来的结构化输出
  const own = isOwnOutput(ev.cmd, raw);
  if (ev.isError && raw.trim()) {
    return { at: ev.at, cat: 'error', tool: ev.tool, text: raw.trim(), ws: ev.ws, sid: ev.sid, meta: own || isMetaEcho(raw) };
  }
  if (raw.trim() && COMMAND_TOOLS.includes(ev.tool)) {
    // read/grep 等结果内嵌文件内容，不参与特征扫描
    const flat = raw.replace(/\s+/g, ' ').trim();
    const hit = !SELF_REF.test(flat) && !ENC_DIAG_RE.test(flat) && PATTERNS.find((p) => p.re.test(flat) && !/Found \d+ matches|\.Contains\(|workspace instructions/i.test(flat.slice(0, 200)));
    if (hit && !/^\s*\{/.test(flat) && flat.length < 4000) {
      return { at: ev.at, cat: hit.id, tool: ev.tool, text: flat.slice(0, 500), ws: ev.ws, sid: ev.sid, meta: own || isMetaEcho(flat) };
    }
  }
  return null;
}

// 用户叙述判定（v2.0 政策：只收【真实用户报障】——强关键词 + 短文本；
// 助手叙述(回声/元讨论)与长文一律不收，避免“讨论采集机制本身”产生的自引用回声）
function classifyUserMessage(ev) {
  const flat = String(ev.text == null ? '' : ev.text).replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (FRAME_RE.test(flat.slice(0, 300))) return null;
  const hit = PATTERNS.find((p) => NARRATION_IDS.includes(p.id) && p.re.test(flat));
  if (hit && STRONG_USER.test(flat.slice(0, 120)) && flat.length > 12 && flat.length <= 400) {
    return { at: ev.at, cat: hit.id, tool: 'user/message', text: flat.slice(0, 400), ws: ev.ws, sid: ev.sid };
  }
  return null;
}

// 新会话上下文（批扫与实时共用；callName 记录 callId→工具名，callCmd 记录 callId→命令摘要）
function newSessionCtx(sid, ws, calls, cmds) {
  return {
    sid, ws: ws || '',
    callName: Object.assign(Object.create(null), calls || {}),
    callCmd: Object.assign(Object.create(null), cmds || {}), // v0.7.6（A3）：出处判定用
    callN: 0,
  };
}

// callId→工具名映射的容量上限（超限丢最旧；插入序即 Object.keys 顺序）
// 必要性：增量扫描的窗口常常只剩 tool/result 而没有对应的 tool/call —— 若不继承上次窗口的
// 映射，工具名会退化成 '?'，而 tool 是聚簇键的一部分 → 同一个坑会被当成新坑重复入箱。
function boundCalls(calls, cap) {
  const keys = Object.keys(calls);
  if (keys.length <= cap) return calls;
  for (const k of keys.slice(0, keys.length - cap)) delete calls[k];
  return calls;
}

// 一条会话记录（磁盘 JSONL 行解析出的对象 / 宿主 session/event 的事件对象，形状一致）→ 事件 | null
// 会就地更新 st.ws（会话记录带 cwd）与 st.callName（tool/call）
function classifyRecord(rec, st) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.type === 'session' && rec.cwd) {
    const ws = lastSeg(rec.cwd);
    if (ws) st.ws = ws;
    return null;
  }
  if (rec.type === 'tool/call') {
    const cid = rec.data && rec.data.callId;
    if (cid) {
      st.callName[cid] = rec.data.name;
      // v0.7.6（A3）：手搓的 ctx（自测/外部调用）可能没有 callCmd 字段 —— 就地补齐，绝不因此抛错
      if (!st.callCmd) st.callCmd = Object.create(null);
      st.callCmd[cid] = cmdOf(rec.data.arguments);
      st.callN = (st.callN || 0) + 1;
      if (st.callN % 256 === 0) { boundCalls(st.callName, 512); boundCalls(st.callCmd, 512); } // 定期裁剪，避免长会话无界增长
    }
    return null;
  }
  if (rec.type === 'tool/result') {
    const { isError, text, callId } = extractToolResult(rec.data);
    const tool = (callId && st.callName[callId]) || '?';
    const cmd = (callId && st.callCmd && st.callCmd[callId]) || '';
    return classifyToolResult({ at: rec.time, tool, isError, text, ws: st.ws, sid: st.sid, cmd });
  }
  if (rec.type === 'user/message') {
    return classifyUserMessage({ at: rec.time, text: textOf(rec.data && rec.data.content), ws: st.ws, sid: st.sid });
  }
  return null;
}

// 会话文件的工作区名兜底（目录名 `--C-...-SandBox1--` → `C-...-SandBox1`）
function wsFromDir(file) {
  return path.basename(path.dirname(path.dirname(file))).replace(/^--|--$/g, '');
}

// 增量批扫：从 offset 起解码新增帧并判定
// 返回 { events, nextOffset, frames, readFrom, badFrom, partial, corruptAt, more, sid, ws }
//   ws 取「会话记录里的 cwd 名」优先，其次水位线里记下的上一次结果，最后退回目录名——
//   增量扫描时开头的 session 记录往往不在新增区间内，必须靠水位线继承，否则工作区列会漂移。
//   opts.maxBytes（v0.7.7）：一次只解这么多字节 —— 宿主异步扫描把大日志切片，片间让出事件循环。
function collectEventsFrom(file, offset, wm, opts) {
  const dec = decodeLinesFrom(file, offset, opts);
  const sid = path.basename(path.dirname(file));
  const st = newSessionCtx(sid, (wm && wm.ws) || wsFromDir(file), wm && wm.calls, wm && wm.cmds);
  const out = [];
  for (const line of dec.lines) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const ev = classifyRecord(r, st);
    if (ev) out.push(ev);
  }
  return {
    events: out, nextOffset: dec.nextOffset, frames: dec.frames, readFrom: dec.readFrom,
    badFrom: dec.badFrom, partial: dec.partial, corruptAt: dec.corruptAt || null, // v0.7.5：解码失败分类透传（审计 N20）
    more: !!dec.more, truncated: !!dec.truncated, // v0.7.7：窗口化续读依据
    sid, ws: st.ws,
    // v0.7.6（A3）：callId→命令摘要 也必须跨窗口继承 —— 增量窗口常常只剩 tool/result，
    //   没了这份映射，出处判定在增量扫描里会失效（与 tool 退化成 '?' 是同一类问题）。
    calls: boundCalls(st.callName, 512), cmds: boundCalls(st.callCmd, 512),
  };
}

// 全量批扫（v1 行为不变）
function collectEvents(file) {
  return collectEventsFrom(file, 0, null).events;
}

module.exports = {
  collectEvents, collectEventsFrom,
  classifyRecord, classifyToolResult, classifyUserMessage,
  extractToolResult, newSessionCtx, wsFromDir, boundCalls, isMetaEcho,
  // v0.7.6（回声自我放大治理）：出处判定与命令摘要抽取（供自测与 engine 复用）
  isOwnOutput, cmdOf,
  COMMAND_TOOLS, SELF_REF, FRAME_RE, ENC_DIAG_RE, STRONG_USER, META_STRONG, META_WEAK, META_DUMP,
  META_ARTIFACT, META_API_ENV, META_API_KEY, OWN_ASSET_RE,
};
