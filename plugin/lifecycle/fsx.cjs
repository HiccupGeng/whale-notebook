// lifecycle/fsx.cjs - 文件操作助手（原子写/哈希/快照/树复制删除; 全为 node 内建）
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function readText(p) { return fs.readFileSync(p, 'utf8'); }
function readBytes(p) { return fs.readFileSync(p); }
function isDir(p) { return exists(p) && fs.statSync(p).isDirectory(); }
function isFile(p) { return exists(p) && fs.statSync(p).isFile(); }

function sha256(p) {
  if (!exists(p)) return null;
  const h = crypto.createHash('sha256');
  h.update(readBytes(p));
  return 'sha256:' + h.digest('hex');
}
// v0.7.8：对"内存里的文本"求同一口径的哈希（AGENTS 标记区内容基线用；不必落临时文件）
function sha256Text(text) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(String(text == null ? '' : text), 'utf8'));
  return 'sha256:' + h.digest('hex');
}

// 原子写: 同目录 .tmp 再 rename（与 store/repo.cjs 一致）
function writeAtomic(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
function writeTextAtomic(p, text) { writeAtomic(p, text); }

function rmFile(p) {
  if (exists(p)) fs.rmSync(p, { force: true });
}
function rmTree(p) {
  if (exists(p)) fs.rmSync(p, { recursive: true, force: true });
}

// 复制单个文件（保持字节不变）
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

// 递归复制整棵树（保持字节不变）
function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    if (fs.statSync(s).isDirectory()) copyTree(s, d);
    else copyFile(s, d);
  }
}

// 目录顶层清单（名称 + 类型）, 用于 status/导出核对
function listTop(dir) {
  if (!isDir(dir)) return [];
  return fs.readdirSync(dir).sort().map((n) => {
    const p = path.join(dir, n);
    return { name: n, dir: fs.statSync(p).isDirectory() };
  });
}

module.exports = {
  exists, readText, readBytes, isDir, isFile, sha256, sha256Text,
  writeAtomic, writeTextAtomic, rmFile, rmTree, copyFile, copyTree, listTop,
};
