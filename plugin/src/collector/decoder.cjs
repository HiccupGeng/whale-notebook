// collector/decoder.cjs - 会话日志解码（zstd 多帧 JSONL）+ 文本抽取（纯函数/只读）
// v0.5：新增 decodeLinesFrom(file, offset) —— 按【帧边界】增量解码。
//   实测依据（本机 13 个会话 / 22.93MB / 59,318 帧）：会话日志是纯追加写入的
//   多帧 zstd，每帧都以 '\n' 结尾（跨行帧 = 0），且帧起点在文件任意时刻都是
//   zstd magic 对齐的 → 只要记下「上一成功解码帧的结束偏移」，就能只读新增字节续扫，
//   无需回收半行、不重解历史帧。末尾写了一半的帧解压会抛错 → 不推进 offset → 下次自动重试。
'use strict';
const fs = require('fs');
const { zstdDecompressSync } = require('node:zlib');

const ZSTD_MAGIC = 4247762216;

// v0.7.5（审计 N20）：Node 内建 zstd 的可探测性 —— 旧 Node 上 `require('node:zlib')` 不报错、
//   但 `zstdDecompressSync` 是 undefined，于是每帧解压都抛：事件恒 0、offset 永不推进、
//   CLI 仍以 0 退出并打印「新发现 0 条」，实时采集也完全无感（它不读日志）——这是最危险的静默停摆。
//   探测到缺失就明确报错，宁可不采集，也不要假装"没有新发现"。
const ZSTD_OK = typeof zstdDecompressSync === 'function';
const ZSTD_REQUIRED_MSG = 'Node 缺少 zlib.zstdDecompressSync（需 Node ≥ 22.15 / 23.8）：会话日志无法解码，采集已停止（不是「无新发现」）';
function zstdAvailable() { return ZSTD_OK; }
function assertZstd() { if (!ZSTD_OK) throw new Error(ZSTD_REQUIRED_MSG); }

// v0.7.5（审计 N20）：帧扫描必须**自带边界检查**。
//   旧写法直接 readUIntLE 读块头：末尾半写帧会让它读越界抛 ERR_OUT_OF_RANGE，
//   于是"正在写入的尾巴"被上层当成"整文件解码失败"（badFiles++ 且不更新水位线），
//   而真正的中段损坏与它长得一样，没人能区分。
//   现在返回 { frames, end, reason }：
//     complete = 正好扫到缓冲区末尾；eof = 尾巴没写完（正常，下轮再来）；bad = 帧头不自洽且后面还有数据（真损坏）。
function scanFramesEx(buffer) {
  const frames = [];
  let offset = 0;
  const fail = (reason) => ({ frames, end: offset, reason });
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return fail('eof');           // 不足 4 字节：半个帧头
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return fail('bad'); // magic 不对且后面还有数据 → 中段损坏
    offset += 4;
    if (offset >= buffer.length) return fail('eof');
    const d = buffer.readUInt8(offset); offset += 1;
    const csf = d >>> 6; const single = (d & 32) !== 0; const checksum = (d & 4) !== 0;
    const df = d & 3; const db = df === 3 ? 4 : df;
    const cb = csf === 0 ? (single ? 1 : 0) : (1 << csf);
    const headSkip = (single ? 0 : 1) + db + cb;
    if (offset + headSkip > buffer.length) return fail('eof');     // 帧描述符/字典/FCS 被截断
    offset += headSkip;
    for (;;) {
      if (offset + 3 > buffer.length) return fail('eof');          // 块头被截断
      const bh = buffer.readUIntLE(offset, 3); offset += 3;
      const last = (bh & 1) !== 0; const bt = (bh >>> 1) & 3;
      const extra = bt === 1 ? 1 : (bh >>> 3);
      if (offset + extra > buffer.length) return fail('eof');      // 块内容被截断
      offset += extra;
      if (last) break;
    }
    if (checksum) {
      if (offset + 4 > buffer.length) return fail('eof');
      offset += 4;
    }
    frames.push([start, offset]);
    if (offset === start) return fail('bad'); // 理论上不可达：防死循环
  }
  return { frames, end: offset, reason: 'complete' };
}
function scanFrames(buffer) { return scanFramesEx(buffer).frames; }

// 从 offset 起到文件末尾的字节读入内存（只读该区间，不读全文件）
// v0.7.7：新增 maxBytes —— 一次最多读这么多字节（窗口化增量解码：宿主异步扫描据此把大日志
//   切成小片，每片之间让出事件循环；实测 3.4MB 的单文件一次解完会让宿主卡住 ~1.6s）。
function readTail(file, offset, maxBytes) {
  const size = fs.statSync(file).size;
  let from = Number.isFinite(offset) && offset > 0 ? offset : 0;
  let reset = false;
  if (from > size) { from = 0; reset = true; } // 文件被截断/轮转 → 水位线失效
  const cap = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : Infinity;
  let len = size - from;
  const truncated = len > cap;
  if (truncated) len = cap;
  if (len <= 0) return { buf: Buffer.alloc(0), from, size, reset, truncated: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === len ? buf : buf.subarray(0, got), from, size, reset, truncated };
  } finally {
    fs.closeSync(fd);
  }
}

// 增量解码：返回 { lines, nextOffset, frames, readFrom, badFrom, partial, corruptAt, more, truncated }
//   nextOffset 只推进到【最后一个成功解码帧】的结束位置 —— 半写帧/坏帧留待下次重试；
//   badFrom=true 表示 offset 不在帧头（水位线失效），调用方应退回 0 全量重扫该文件；
//   partial=true 表示本次窗口尾部存在未完成/损坏帧（水位线已停在其前）；
//   more=true（v0.7.7）表示 nextOffset 之后还有字节没读（窗口被 maxBytes 截断，或尾巴是半写帧）——
//     调用方据此决定"再开一个窗口续读"还是"收工等下一轮"。
function decodeLinesFrom(file, offset, opts) {
  assertZstd();
  const maxBytes = opts && Number.isFinite(opts.maxBytes) ? opts.maxBytes : Infinity;
  const tail = readTail(file, offset, maxBytes);
  const out = { lines: [], nextOffset: tail.from, frames: 0, readFrom: tail.from, badFrom: false, partial: false, corruptAt: null, more: false, truncated: !!tail.truncated };
  if (tail.reset) out.badFrom = true;
  if (!tail.buf.length) return out;
  if (tail.buf.length < 4 || tail.buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    out.badFrom = true;
    out.nextOffset = 0;
    return out;
  }
  const ex = scanFramesEx(tail.buf);
  const frames = ex.frames;
  out.frames = frames.length;
  let consumed = 0;
  let stopped = false;
  for (let i = 0; i < frames.length; i++) {
    const s = frames[i][0];
    const e = frames[i][1];
    let plain;
    try {
      plain = zstdDecompressSync(tail.buf.subarray(s, e)).toString('utf8');
    } catch {
      stopped = true; // 解压失败：不推进 offset（下面按失败位置分类）
      // v0.7.5（审计 N20）：末帧失败 = 正在写入（正常，下次重试）；
      //   非末帧失败 = 文件真损坏，**该帧之后的所有日志永远读不到**（每轮都在同一处重试）——必须能被告警。
      out.corruptAt = i < frames.length - 1 ? 'mid' : 'tail';
      break;
    }
    for (const line of plain.split('\n')) if (line.trim().length) out.lines.push(line);
    consumed = e;
  }
  // 帧扫描本身停在"帧头不自洽"处（且后面还有字节）= 中段损坏；停在缓冲区末尾 = 尾巴没写完（正常重试）
  if (!stopped && ex.reason === 'bad') out.corruptAt = 'mid';
  out.nextOffset = tail.from + consumed;
  // 尾部残留 = 有帧没被消费（半写或解码失败）→ 下次重试；也可能是被截断的半个帧头
  out.partial = stopped || consumed < tail.buf.length;
  out.more = out.nextOffset < tail.size; // 后面还有字节（窗口截断 / 半写尾帧）
  return out;
}

// 全量解码（v1 行为不变：读整文件 + 逐帧解压）
function decodeLines(file) {
  const lines = [];
  const buf = fs.readFileSync(file);
  for (const [s, e] of scanFrames(buf)) {
    const plain = zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
    for (const line of plain.split('\n')) if (line.trim().length) lines.push(line);
  }
  return lines;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n').trim();
}

module.exports = { scanFrames, scanFramesEx, decodeLines, decodeLinesFrom, readTail, textOf, ZSTD_MAGIC, zstdAvailable, assertZstd, ZSTD_REQUIRED_MSG };
