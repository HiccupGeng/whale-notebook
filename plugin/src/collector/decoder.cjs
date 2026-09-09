// collector/decoder.cjs - 会话日志解码（zstd 多帧 JSONL）+ 文本抽取（纯函数/只读）
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

function decodeLines(file) {
  const buf = fs.readFileSync(file);
  const lines = [];
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

module.exports = { scanFrames, decodeLines, textOf, ZSTD_MAGIC };
