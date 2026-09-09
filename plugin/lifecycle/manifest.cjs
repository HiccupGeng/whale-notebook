// lifecycle/manifest.cjs - 清单存取与合并（包内默认清单 + 站点现场清单）
'use strict';
const fs = require('fs');
const path = require('path');
const fsx = require('./fsx.cjs');
const { defaultManifestPath, siteManifestPath, backupsDir, localStamp, resolvePathTpl } = require('./consts.cjs');

// ---- 上下文 ----
function ctxOf(home) {
  const nb = require('./consts.cjs').resolveNbDir(home);
  return { home, nb, pkg: path.resolve(__dirname, '..') };
}

// ---- 包内默认清单（只读） ----
function loadDefault() {
  const p = defaultManifestPath();
  if (!fsx.exists(p)) throw new Error(`包内默认清单缺失: ${p}`);
  return JSON.parse(fsx.readText(p));
}

// ---- 站点清单 ----
function loadSite(home) {
  const p = siteManifestPath(home);
  if (!fsx.exists(p)) return null;
  try { return JSON.parse(fsx.readText(p)); } catch { return null; }
}
function saveSite(home, site) {
  fsx.writeTextAtomic(siteManifestPath(home), JSON.stringify(site, null, 2) + '\n');
}
// 空站点清单骨架（默认清单 realize 前占位, 记录 schema/plugin 版本）
function emptySite(defaultManifest, ctx, state) {
  return {
    schemaVersion: defaultManifest.schemaVersion,
    plugin: defaultManifest.plugin,
    manifestVersion: defaultManifest.manifestVersion,
    state, // none | installed | removed
    phase: 'none', // none | backed-up | applied | verified
    installedAt: null,
    lastOp: null,
    entries: defaultManifest.entries.map((e) => ({
      id: e.id, segment: e.segment, kind: e.kind, owner: e.owner,
      path: resolvePathTpl(e.path, ctx),
      agentsMode: e.agentsMode || null,
      state: e.state === 'deferred' ? 'deferred' : 'pending',
      hashAfter: null,
      hashBefore: null,
      adoptedAt: null,
      backups: [],
      note: e.note || '',
    })),
  };
}

// 合并视图: 默认(结构) + 站点(状态) 按 id 对位。返回 defaultEntries 每条附 siteEntry(可空)
function mergedView(home) {
  const def = loadDefault();
  const site = loadSite(home);
  const byId = {};
  if (site) for (const se of site.entries) byId[se.id] = se;
  return { def, site, entries: def.entries.map((e) => ({ def: e, site: byId[e.id] || null })) };
}

// 默认清单区查找（按 label 与 begin/end 取出 zone 定义）
function zoneOf(defaultEntry, label) {
  return (defaultEntry.zones || []).find((z) => z.label === label) || null;
}

// ---- 快照/备份（站点清单 entries[i].backups 追加记录） ----
function snapshot(home, site, id, srcFile) {
  if (!fsx.isFile(srcFile)) return null;
  const base = localStamp();
  const dir = uniqueStampDir(home, base); // 同秒多次快照不互相覆盖
  const dst = path.join(dir, id + '.bak');
  fsx.copyFile(srcFile, dst);
  const rec = { stamp: path.basename(dir), path: dst, sha: fsx.sha256(dst), size: fsx.readBytes(dst).length };
  const se = site.entries.find((x) => x.id === id);
  if (se) {
    se.backups = se.backups || [];
    se.backups.push(rec);
    se.hashBefore = rec.sha;
  }
  return rec;
}
function uniqueStampDir(home, base) {
  const root = backupsDir(home);
  let stamp = base;
  let i = 1;
  while (fsx.exists(path.join(root, stamp))) stamp = `${base}-${i++}`;
  fs.mkdirSync(path.join(root, stamp), { recursive: true });
  return path.join(root, stamp);
}
// 最近一次备份
function latestBackup(home, id) {
  const root = backupsDir(home);
  if (!fsx.isDir(root)) return null;
  const dirs = fsx.listTop(root).filter((d) => d.dir).map((d) => d.name).sort();
  for (let i = dirs.length - 1; i >= 0; i--) {
    const p = path.join(root, dirs[i], id + '.bak');
    if (fsx.isFile(p)) return { stamp: dirs[i], path: p, sha: fsx.sha256(p) };
  }
  return null;
}

module.exports = {
  ctxOf, loadDefault, loadSite, saveSite, emptySite, mergedView, zoneOf, snapshot, latestBackup,
  defaultManifestPath, siteManifestPath,
};
