// lifecycle/zones.cjs - AGENTS.md 标记区操作（纯文本; 区定义来自默认清单 zones 字段, 本文件只做几何运算）
'use strict';

// 找 begin 标记起始与 end 标记结束后的位置; 找不到返回 null
function findZone(text, begin, end) {
  const i = text.indexOf(begin);
  if (i < 0) return null;
  const j = text.indexOf(end, i + begin.length);
  if (j < 0) return null;
  return { start: i, end: j + end.length };
}
function hasZone(text, begin, end) {
  return findZone(text, begin, end) !== null;
}
// 区内部内容（不含标记行）
function zoneBody(text, begin, end) {
  const z = findZone(text, begin, end);
  if (!z) return null;
  return text.slice(z.start + begin.length, z.end - end.length);
}

// 整行级移除一个区（含标记行本身, 行首到行尾）
// 返回移除后的文本; 找不到则原样返回
function stripZone(text, begin, end) {
  const i = text.indexOf(begin);
  if (i < 0) return text;
  const j = text.indexOf(end, i + begin.length);
  if (j < 0) return text;
  // 标记行行首（含上一行换行后的位置）
  let lineStart = text.lastIndexOf('\n', i) + 1;
  // end 标记行行尾（含换行）
  let lineEnd = text.indexOf('\n', j + end.length);
  if (lineEnd < 0) lineEnd = text.length;
  else lineEnd += 1;
  let out = text.slice(0, lineStart) + text.slice(lineEnd);
  // 清理移除处残留的空白行(3 个以上连续换行压到 2 个)
  out = out.replace(/\n{3,}/g, '\n\n');
  return out;
}

// 若区不存在则追加到文件末尾; 存在则原样返回。insertAt: 可指定在某区(对象{begin,end})之后插入
function ensureZone(text, begin, end, body, insertAfterZone) {
  if (hasZone(text, begin, end)) return { text, inserted: false };
  let block = begin + '\n' + body + '\n' + end;
  let head = text.trimEnd();
  if (head) {
    if (insertAfterZone) {
      const after = findZone(head, insertAfterZone.begin, insertAfterZone.end);
      if (after) {
        // 在 insertAfterZone 区结束后空一行插入
        const rest = head.slice(after.end);
        head = head.slice(0, after.end).trimEnd();
        return { text: head + '\n\n' + block + (rest.trim() ? '\n\n' + rest.trimStart() : '') + '\n', inserted: true };
      }
    }
    head += '\n\n';
  }
  return { text: head + block + '\n', inserted: true };
}

// 替换区内部内容（含区内正文; 标记行保留）。区不存在时走 ensureZone 语义
function replaceZoneBody(text, begin, end, body) {
  const z = findZone(text, begin, end);
  if (!z) return ensureZone(text, begin, end, body).text;
  const before = text.slice(0, z.start + begin.length);
  const after = text.slice(z.end - end.length);
  return before + '\n' + body + '\n' + after;
}

module.exports = { findZone, hasZone, zoneBody, stripZone, ensureZone, replaceZoneBody };
