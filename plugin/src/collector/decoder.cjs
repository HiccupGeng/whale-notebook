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

function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) break;
    offset += 4;
    const d = buffer.readUInt8(offset); offset += 1;
    const csf = d >>> 6; const single = (d & 32) !== 0; const checksum = (d & 4) !== 0;
    const df = d & 3; const db = df === 3 ? 4 : df;
    const cb = csf === 0 ? (single ? 1 : 0) : (1 << csf);
    offset += (single ? 0 : 1) + db + cb;
    for (;;) { const bh = buffer.readUIntLE(offset, 3); offset += 3; const last = (bh & 1) !== 0; const bt = (bh >>> 1) & 3; offset += (bt === 1 ? 1 : (bh >>> 3)); if (last) break; }
    if (checksum) offset += 4;
    frames.push([start, offset]);
  }
  return frames;
}

// 从 offset 起到文件末尾的字节读入内存（只读该区间，不读全文件）
function readTail(file, offset) {
  const size = fs.statSync(file).size;
  let from = Number.isFinite(offset) && offset > 0 ? offset : 0;
  let reset = false;
  if (from > size) { from = 0; reset = true; } // 文件被截断/轮转 → 水位线失效
  const len = size - from;
  if (len <= 0) return { buf: Buffer.alloc(0), from, size, reset };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    let got = 0;
    while (got < len) {
      const n = fs.readSync(fd, buf, got, len - got, from + got);
      if (n <= 0) break;
      got += n;
    }
    return { buf: got === len ? buf : buf.subarray(0, got), from, size, reset };
  } finally {
    fs.closeSync(fd);
  }
}

// 增量解码：返回 { lines, nextOffset, frames, readFrom, badFrom, partial }
//   nextOffset 只推进到【最后一个成功解码帧】的结束位置 —— 半写帧/坏帧留待下次重试；
//   badFrom=true 表示 offset 不在帧头（水位线失效），调用方应退回 0 全量重扫该文件；
//   partial=true 表示尾部存在未完成/损坏帧（水位线已停在其前）。
function decodeLinesFrom(file, offset) {
  const tail = readTail(file, offset);
  const out = { lines: [], nextOffset: tail.from, frames: 0, readFrom: tail.from, badFrom: false, partial: false };
  if (tail.reset) out.badFrom = true;
  if (!tail.buf.length) return out;
  if (tail.buf.length < 4 || tail.buf.readUInt32LE(0) !== ZSTD_MAGIC) {
    out.badFrom = true;
    out.nextOffset = 0;
    return out;
  }
  const frames = scanFrames(tail.buf);
  out.frames = frames.length;
  let consumed = 0;
  let stopped = false;
  for (const [s, e] of frames) {
    let plain;
    try {
      plain = zstdDecompressSync(tail.buf.subarray(s, e)).toString('utf8');
    } catch {
      stopped = true; // 末帧仍在写 / 帧损坏：不推进 offset
      break;
    }
    for (const line of plain.split('\n')) if (line.trim().length) out.lines.push(line);
    consumed = e;
  }
  out.nextOffset = tail.from + consumed;
  // 尾部残留 = 有帧没被消费（半写或解码失败）→ 下次重试；也可能是被截断的半个帧头
  out.partial = stopped || consumed < tail.buf.length;
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

module.exports = { scanFrames, decodeLines, decodeLinesFrom, readTail, textOf, ZSTD_MAGIC };
