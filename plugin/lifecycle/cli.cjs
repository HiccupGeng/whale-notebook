// lifecycle/cli.cjs - 安装/卸载/清单机制 CLI
// 段位: I 集成(AGENTS+skill) / D 数据(用户记忆) / R 运行时(web 面板部署副本, 动作归 scripts/deploy-web.cjs)
// 设计依据: docs/2026_09_09_16_whale-notebook生命周期设计.md
// 自举约束: 仅 node 内建; 从任意位置 node <pkg>/lifecycle/cli.cjs 均可运行。
// 所有写操作两段式: 默认 dry-run 出计划(展示给用户) → 确认后 --apply。
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./consts.cjs');
const Z = require('./zones.cjs');
const M = require('./manifest.cjs');
const X = require('./fsx.cjs');

const out = (prefix, msg) => console.log(`[${prefix}] ${msg}`);
const L = { rules: '规则自动段', privacy: '隐私提示区' };
const PRIVACY_BODY = '## 隐私提示\n\n- 本条规则写入流程：候选 → 展示 → 用户确认 → 才入库；任何写入前先给用户看将要新增/修改的行。\n- 经验条目与规则行只写通用对策；来源仅存会话 ID 作统计溯源，不复制原文。';
const RULES_EMPTY_BODY = '## 自动段：whale-notebook 经验规则（由小本本技能生成，勿手改）\n\n状态：尚未完成首轮经验审核，暂无规则条目。';

// 把规则区之后的尾部内容(已 trim 非空)原位纳入 privacy 标记: [规则区] → [规则区] + [privacy 区含 tail]
function wrapTail(text, rules, privacy, tail) {
  const r = Z.findZone(text, rules.begin, rules.end);
  const head = text.slice(0, r.end).trimEnd();
  return head + '\n\n' + privacy.begin + '\n' + tail + '\n' + privacy.end + '\n';
}

// ---------------- v0.7.8（审计第 4 项）：漂移判定的"分级" ----------------
// 背景：check 原来对 I 段文件做**整文件 hash 比对**。但这两个文件都会被**合法重写**：
//   · AGENTS.md 的自动段每次经验入库都会重写；
//   · skill 每次版本迭代都会被更新。
//   于是 `check` 恒 exit 1，"真损坏"与"我只是正常更新过"再也分不开（信号被稀释）。
// 现在分三级：
//   ① fails（exit 1）：缺失 / 区缺失 / **结构损坏**（截断、乱码、frontmatter 丢失、必需小节消失）
//   ② diffs（remove 仍要求 --yes）：内容与登记不一致 —— 删除前确认真的是你想要的
//   ③ stale（信息级，不影响退出码）：内容变了但**结构完好** = 一次合法演进，提示跑 `check --adopt` 重新登记
// 另：AGENTS 在 zones 模式下**只对账两个标记区**（区外是你自己的内容，永不算漂移）。

// 区内容基线：两个标记区正文按固定顺序拼接后的 sha256（区外内容完全不参与）
function zoneHashOf(text, rules, privacy) {
  const rb = Z.zoneBody(text, rules.begin, rules.end);
  const pb = Z.zoneBody(text, privacy.begin, privacy.end);
  if (rb === null || pb === null) return null;
  return X.sha256Text(rb + '\u0000' + pb);
}

// 结构校验：返回问题列表（空数组 = 结构完好）。
// 只判"能不能用"，不判"内容对不对"——避免把正常演进误判成损坏。
const SKILL_MIN_BYTES = 2000;
function structureProblems(id, raw, ctx) {
  const probs = [];
  const text = String(raw == null ? '' : raw);
  if (!text) return ['内容为空'];
  // 乱码/截断的通用特征：UTF-8 解码出现替换字符
  if (text.indexOf('\uFFFD') !== -1) probs.push('含非法 UTF-8 替换字符（文件可能被截断或以错误编码写入）');
  if (id === 'skill') {
    if (Buffer.byteLength(text, 'utf8') < SKILL_MIN_BYTES) probs.push(`字节数过小（<${SKILL_MIN_BYTES}，疑似被截断）`);
    if (!/^---\r?\n[\s\S]*?\r?\n---/.test(text)) probs.push('缺少 frontmatter（--- 元信息块）');
    if (!/^name:\s*\S+/m.test(text)) probs.push('frontmatter 缺 name 字段');
    if (!/^description:\s*\S+/m.test(text)) probs.push('frontmatter 缺 description 字段');
    if (!/##\s*工作流/.test(text)) probs.push('缺少「## 工作流」小节（技能的执行流程入口）');
    if ((text.match(/^##\s+/gm) || []).length < 3) probs.push('小节过少（<3 个 ## 标题）');
    if (text.indexOf('whale-notebook') === -1) probs.push('正文未提及 whale-notebook（疑似被整体替换）');
  } else if (id === 'agents' && ctx && ctx.zones) {
    for (const z of ctx.zones) {
      const body = Z.zoneBody(text, z.begin, z.end);
      if (body === null) probs.push(`标记区缺失：${z.label}`);
      else if (!body.trim()) probs.push(`标记区为空：${z.label}`);
    }
  }
  return probs;
}

// ---------------- 参数解析 ----------------
function parseArgv(argv) {
  const flags = { apply: false, agentsMode: null, seedDir: null, exportDir: null, yes: false, home: null, adopt: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--yes') flags.yes = true;
    else if (a === '--adopt') flags.adopt = true; // v0.7.8：check --adopt 重新登记 I 段基线
    else if (a === '--agents-mode') flags.agentsMode = argv[++i] || null;
    else if (a === '--seed-dir') flags.seedDir = argv[++i] ? path.resolve(argv[i]) : null;
    else if (a === '--export-dir') flags.exportDir = argv[++i] ? path.resolve(argv[i]) : null;
    else if (a === '--home') flags.home = path.resolve(argv[++i] || '');
    else rest.push(a);
  }
  const cmd = rest[0] || 'help';
  const level = cmd === 'uninstall' ? (rest[1] || '').toLowerCase() : null;
  return { cmd, level, flags };
}

// 条目路径(站点已 realize 优先, 否则按默认清单模板解析)
function entryPath(home, def, site) {
  if (site && site.path) return site.path;
  return C.resolvePathTpl(def.path, M.ctxOf(home));
}

// 从默认条目取两个区的定义（顺序固定：规则自动段 → 隐私提示区），供 zoneHashOf 使用
function zoneRefs(def, labels) {
  const pick = (label) => (def.zones || []).find((z) => z.label === label) || { begin: '\u0000absent', end: '\u0000absent' };
  return [pick(labels.rules), pick(labels.privacy)];
}

// ---------------- 现场评估: 每 installed/removed 条目 vs 现场; 孤儿扫描 ----------------
function assess(home, view) {
  const res = { diffs: [], fails: [], orphans: [], runtime: [], stale: [] };
  for (const { def, site } of view.entries) {
    const st = site ? site.state : def.state;
    if (st === 'deferred' || st === 'pending') continue;
    const p = entryPath(home, def, site);
    // R 段(运行时): 写入/摘除动作归 managedBy 声明的工具(deploy-web.cjs), lifecycle 只登记与对账。
    // 对账结果进 res.runtime(信息级), 不参与 fails/diffs —— 因此不左右 check 退出码。
    if (def.segment === 'R') {
      const r = runtimeProbe(def, M.ctxOf(home), site);
      if (r) {
        r.state = st;
        r.expected = st === 'installed';
        r.ok = r.installed === r.expected;
        res.runtime.push(r);
      }
      continue;
    }
    const present = X.exists(p);
    const isAgents = def.id === 'agents';
    const zonesMode = isAgents && site && site.agentsMode === 'zones';
    if (st === 'installed') {
      if (def.kind === 'dir') {
        if (!present) res.fails.push(`缺: ${p} (D 数据目录, state=installed)`);
        continue;
      }
      if (isAgents && zonesMode) {
        // zones 模式（v0.7.8）：**只对账两个标记区** —— 区外是你自己的内容，改了永不算漂移。
        if (!present) { res.fails.push(`缺: ${p} (AGENTS.md)`); continue; }
        const text = X.readText(p);
        for (const label of [L.rules, L.privacy]) {
          const z = (def.zones || []).find((zz) => zz.label === label);
          if (z && !Z.hasZone(text, z.begin, z.end)) res.fails.push(`区缺: ${p} 无「${label}」标记`);
        }
        const probs = structureProblems('agents', text, { zones: (def.zones || []).map((z) => ({ label: z.label, begin: z.begin, end: z.end })) });
        if (probs.length) res.fails.push(`结构损坏: ${p} —— ${probs.join('；')}`);
        else if (site.zoneHash) {
          const live = zoneHashOf(text, ...zoneRefs(def, L));
          if (live && live !== site.zoneHash) res.stale.push(`标记区内容已变: ${p}（登记 ${site.zoneHash.slice(7, 19)}… ≠ 现场 ${live.slice(7, 19)}…；区外内容不参与判定）`);
        } else {
          res.stale.push(`尚未登记标记区基线: ${p}（跑 check --adopt 即可建立，之后才能看出区内容被动过）`);
        }
        continue;
      }
      if (present) {
        const cur = X.sha256(p);
        if (site.hashAfter && site.hashAfter !== cur) {
          // v0.7.8：内容变了 → 一律记 diffs（remove 仍要求 --yes，删除前确认是你想要的）；
          //   再看结构：结构损坏 = 真问题（fails，exit 1）；结构完好 = 合法演进（stale，信息级）
          res.diffs.push(`漂移: ${p} 登记 ${site.hashAfter.slice(0, 12)}… ≠ 现场 ${(cur || '').slice(0, 12)}…`);
          const probs = structureProblems(def.id, X.readText(p), { zones: (def.zones || []).map((z) => ({ label: z.label, begin: z.begin, end: z.end })) });
          if (probs.length) res.fails.push(`结构损坏: ${p} —— ${probs.join('；')}`);
          else res.stale.push(`内容已变(结构完好): ${p}（登记 ${site.hashAfter.slice(7, 19)}… ≠ 现场 ${String(cur).slice(7, 19)}…）`);
        }
      } else {
        res.fails.push(`缺: ${p} (state=installed)`);
      }
    } else if (st === 'removed') {
      if (present) {
        if (isAgents && zonesMode) {
          // zones 模式: 区外用户内容本就该保留; 仅当仍有 whale 标记才算残留
          const text = X.readText(p);
          const leftovers = [];
          for (const label of [L.rules, L.privacy]) {
            const z = (def.zones || []).find((zz) => zz.label === label);
            if (z && Z.hasZone(text, z.begin, z.end)) leftovers.push(`「${label}」`);
          }
          if (leftovers.length) res.fails.push(`残留: ${p} 含 ${leftovers.join('/')} 标记 (state=removed, zones 模式区外内容可留)`);
        } else {
          res.fails.push(`残留: ${p} (state=removed)`);
        }
      }
    }
  }
  // 孤儿扫描: 有名字但不在清单登记的游离物(skills 目录与 home 根)
  const skillsDir = path.join(home, 'skills');
  if (X.isDir(skillsDir)) {
    for (const n of X.listTop(skillsDir)) {
      if (!n.dir && /^whale-notebook/i.test(n.name) && n.name !== C.SKILL_FILE) {
        res.orphans.push(`${path.join(skillsDir, n.name)} (skills 游离物)`);
      }
    }
  }
  for (const n of X.listTop(home)) {
    if (/^whale-notebook/i.test(n.name) && n.name !== C.NB_DIRNAME) {
      res.orphans.push(`${path.join(home, n.name)} (home 游离物)`);
    }
  }
  return res;
}

// ---------------- R 段(运行时足迹): 探测 / 登记 / 摘除 ----------------
// 唯一写入者原则: R 段的实际写入与删除由包内 scripts/deploy-web.cjs 执行(它管复制包 + patch 挂载行,
// 幂等且有 --check/--undo); lifecycle 只负责"登记、对账、计划、快照、驱动"。
function deployToolPath() { return path.join(C.pkgDir(), 'scripts', 'deploy-web.cjs'); }

// 现场探测一条 R 条目: 目录看存在性; 带 markers 的(如 cordis.patch.yml)只看标记区是否在位 ——
// 该文件可能同时含其它插件的行, 故既不能整文件 hash 判漂移, 也不能整文件替换。
function runtimeProbe(def, ctx, se) {
  if (!se) return null;
  const p = se.path || C.resolvePathTpl(def.path, ctx);
  const fileExists = X.exists(p);
  let installed;
  let detail;
  if (def.kind === 'dir') {
    installed = fileExists;
    detail = fileExists ? '目录在位' : '目录不存在';
  } else if (def.markers) {
    const inZone = fileExists && Z.hasZone(X.readText(p), def.markers.begin, def.markers.end);
    installed = inZone;
    detail = !fileExists ? '文件不存在' : (inZone ? '标记区在位' : '无标记区(文件在但未挂载)');
  } else {
    installed = fileExists;
    detail = fileExists ? '文件在位' : '文件不存在';
  }
  return {
    id: def.id, kind: def.kind, path: p, fileExists, installed, detail,
    state: installed ? 'installed' : 'absent',
    managedBy: def.managedBy || 'scripts/deploy-web.cjs',
  };
}

// 站点清单补齐: 包内默认清单新增/改名的条目(例如 R 段 runtime-pkg → runtime-web-pkg)在旧站点清单里没有 →
// 按默认结构补骨架(pending), 随后由 realizeRuntime 用现场探测覆盖 R 段状态。
function ensureSiteEntries(site, def, ctx) {
  const added = [];
  for (const e of def.entries) {
    if (site.entries.some((x) => x.id === e.id)) continue;
    site.entries.push({
      id: e.id, segment: e.segment, kind: e.kind, owner: e.owner,
      path: C.resolvePathTpl(e.path, ctx),
      agentsMode: e.agentsMode || null,
      state: 'pending',
      hashAfter: null, hashBefore: null, adoptedAt: null, backups: [],
      note: e.note || '',
    });
    added.push(e.id);
  }
  return added;
}

// install --apply: 以现场为准登记 R 段(不写入、不删除任何东西); 同时把登记路径拉回默认清单(修旧版失效路径)
function realizeRuntime(home, site, def, ctx) {
  const list = [];
  for (const d of def.entries.filter((e) => e.segment === 'R')) {
    const se = site.entries.find((x) => x.id === d.id);
    const r = runtimeProbe(d, ctx, se);
    if (!r) continue;
    se.state = r.state;
    se.adoptedAt = C.isoLocal();
    se.hashAfter = null;
    se.hashBefore = null;
    if (se.path !== r.path) se.path = r.path;
    list.push(r);
  }
  return list;
}

// uninstall detach(以及 remove/purge 的 R 部分): 先计划 → 快照 → 驱动 deploy-web --undo → 重新登记现场
function detachRuntime(home, opts) {
  const { level, flags } = opts;
  const def = M.loadDefault();
  const ctx = M.ctxOf(home);
  // 用调用方传进来的 site 对象(而非重新 load): 否则本函数保存的 R 段状态会被调用方随后保存的旧对象覆盖
  const site = opts.site || M.loadSite(home);
  const probes = def.entries.filter((e) => e.segment === 'R')
    .map((d) => runtimeProbe(d, ctx, site.entries.find((x) => x.id === d.id))).filter(Boolean);
  out('plan', `${level}: R 段(运行时足迹) = web 面板部署副本 + 加载器挂载行`);
  for (const r of probes) out('plan', `  · ${r.id} [登记 ${r.state}] 现场: ${r.detail} → ${r.path}`);
  // "有无足迹"以标记区/目录是否真的在位为准: patch 文件本身可能仍含其它插件的行(那不是本插件的足迹)
  const touched = probes.filter((r) => r.installed);
  if (!touched.length) {
    out('ok', `${level}: R 段现场已无足迹(全部 absent) → 零动作`);
    if (flags.apply) {
      for (const r of probes) site.entries.find((e) => e.id === r.id).state = 'absent';
      site.lastOp = { cmd: `uninstall ${level}`, at: C.isoLocal(), ok: true };
      M.saveSite(home, site);
    }
    return 'noop';
  }
  const tool = deployToolPath();
  const args = ['--undo', '--apply', ...(flags.yes ? ['--yes'] : [])];
  out('plan', `动作交由唯一写入者: ${tool}`);
  out('plan', `  node "${tool}" ${args.join(' ')}`);
  if (!flags.yes) out('plan', '  (包目录会保留; 要连副本目录一起删, 请加 --yes)');
  if (!flags.apply) {
    out('info', 'dry-run: 未执行任何写操作(patch 未改、目录未删); 确认后重跑加 --apply');
    return 'planned';
  }
  if (!X.isFile(tool)) { out('err', `缺部署工具: ${tool}`); process.exitCode = 1; return 'failed'; }
  for (const r of probes) {
    if (!r.fileExists) continue;
    const rec = M.snapshot(home, site, r.id, r.path);
    if (rec) out('ok', `前像快照: ${rec.path}`);
  }
  const res = spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    env: { ...process.env, DSH_HOME: home }, // 关键: 让工具作用于同一个 home(含 --home 覆盖的场景)
  });
  const txt = `${res.stdout || ''}${res.stderr || ''}`.trim();
  if (txt) for (const line of txt.split('\n')) out('tool', line);
  if (res.status !== 0) {
    out('err', `${tool} 退出码 ${res.status}; R 段状态未更新(现场可能处于中间态, 复查后重跑)`);
    process.exitCode = 1;
    return 'failed';
  }
  const after = [];
  for (const d of def.entries.filter((e) => e.segment === 'R')) {
    const se = site.entries.find((e) => e.id === d.id);
    const r = runtimeProbe(d, ctx, se);
    if (!r) continue;
    se.state = r.state;
    se.adoptedAt = C.isoLocal();
    after.push(`${r.id}=${r.state}`);
  }
  site.lastOp = { cmd: `uninstall ${level}`, at: C.isoLocal(), ok: true };
  M.saveSite(home, site);
  out('ok', `${level} 完成: R 段已摘除并重新登记(${after.join(', ')})`);
  out('info', '重启 dsh web 后插件不再加载(界面上的决策箱面板随之消失)');
  return 'done';
}

// 旧站点清单可能缺少默认清单新增的条目(如 R 段改名) → 提示待迁移(install --apply 会自动补登记)
function untrackedEntries(view) {
  if (!view.site) return [];
  return view.entries.filter((x) => !x.site).map((x) => x.def.id);
}

// ---------------- status ----------------
function cmdStatus(home) {
  out('lifecycle', `${C.VERSION} · ${C.PLUGIN_NAME} · dshHome=${home}`);
  const ctx = M.ctxOf(home);
  out('status', `D 数据目录: ${ctx.nb}  [${X.isDir(ctx.nb) ? '存在' : '缺失'}]`);
  const site = M.loadSite(home);
  out('status', `站点清单: ${M.siteManifestPath(home)}  [${site ? `state=${site.state} phase=${site.phase}` : '无 → 未安装'}]`);
  if (site) {
    out('status', `安装于 ${site.installedAt || '-'} · 上次操作 ${site.lastOp ? `${site.lastOp.cmd} @ ${site.lastOp.at}` : '-'}`);
    out('status', '足迹清单(段 条目  类型  模式  状态  现场  备份数  hash12):');
    const view = M.mergedView(home);
    for (const { def, site: se } of view.entries) {
      if (!se) continue;
      const p = se.path || C.resolvePathTpl(def.path, ctx);
      const mode = def.id === 'agents' && se.agentsMode ? `[${se.agentsMode}]` : '';
      out('status', `  ${def.segment}  ${def.id.padEnd(10)} ${def.kind.padEnd(4)} ${mode.padEnd(8)} ${String(se.state).padEnd(9)} 存在=${X.exists(p) ? 'Y' : 'N'}  备份=${String((se.backups || []).length).padEnd(2)}  ${(se.hashAfter || '').slice(0, 12)}  ${p}`);
    }
    const a = assess(home, view);
    for (const d of a.diffs) out('status', `差异: ${d}`);
    for (const f of a.fails) out('status', `失败: ${f}`);
    for (const o of a.orphans) out('status', `孤儿: ${o}`);
    for (const r of a.runtime) {
      out('status', `R 段: ${r.id} 登记=${r.state} 现场=${r.installed ? 'installed' : 'absent'}(${r.detail}) ${r.ok ? '一致' : '不一致'} · 动作归 ${r.managedBy}`);
      if (!r.ok) out('status', `R 段提示: ${r.id} 与登记不一致 → 重跑 install --apply 重新登记, 或 uninstall detach 摘除`);
    }
    const untracked = untrackedEntries(view);
    if (untracked.length) out('status', `待迁移: ${untracked.join(', ')}(旧站点清单无此条目) → 重跑 install --apply 补登记`);
    if (!a.diffs.length && !a.fails.length && !a.orphans.length) out('status', '现场与清单一致(I/D 段; R 段见上, 归 deploy-web.cjs 管)');
  }
}

// ---------------- check ----------------
// v0.7.8（审计第 4 项）：退出码只反映**真问题**（缺失/结构损坏/孤儿/待迁移）；
//   "内容变了但结构完好" = 一次合法演进 → 打印为「待登记」并提示 `check --adopt`。
//   这样 check 的红灯重新变得可信（原来因 AGENTS/skill 每次合法重写而恒 exit 1）。
function cmdCheck(home, flags) {
  const view = M.mergedView(home);
  const site = view.site;
  if (!site) out('check', '未安装（无站点清单）— 仅做足迹扫描:');
  const a = assess(home, view);
  for (const d of a.diffs) out('check', `差异: ${d}`);
  for (const s of a.stale) out('check', `待登记: ${s}`);
  for (const f of a.fails) out('check', `失败: ${f}`);
  for (const o of a.orphans) out('check', `孤儿: ${o}`);
  for (const r of a.runtime) {
    out('check', `R 段: ${r.id} 登记=${r.state} 现场=${r.installed ? 'installed' : 'absent'}(${r.detail}) ${r.ok ? '一致' : '不一致'} · 动作归 ${r.managedBy}(信息级, 不影响本命令退出码)`);
    if (!r.ok) out('check', `R 段提示: 重跑 install --apply 重新登记, 或 uninstall detach 摘除运行时足迹`);
  }
  const untracked = untrackedEntries(view);
  if (untracked.length) {
    for (const id of untracked) out('check', `待迁移: ${id} 在默认清单里但站点清单未登记(旧版本清单)`);
    out('err', `check 未通过: 站点清单待迁移 ${untracked.length} 条 → 重跑 install --apply(幂等, 只补登记)`);
    process.exitCode = 1;
    return;
  }
  if (flags && flags.adopt) { adoptEntries(home, view, a); return; }
  if (!a.fails.length && !a.orphans.length) {
    const tail = a.stale.length
      ? `（另有 ${a.stale.length} 项「待登记」：内容已合法演进、结构完好；跑 check --adopt 重新登记即可清掉）`
      : '';
    out('ok', `check 通过: I/D 段清单 vs 现场一致(结构完好), 无孤儿(已对账 R 段 ${a.runtime.length} 条)${tail}`);
    return;
  }
  out('err', `check 未通过: 失败 ${a.fails.length} / 结构完好但待登记 ${a.stale.length} / 孤儿 ${a.orphans.length}（失败与孤儿才是真问题）`);
  process.exitCode = 1;
}

// check --adopt：把 I 段"内容已合法演进"的现场**重新登记**（只更新清单里的 hash 基线，不碰文件内容）
function adoptEntries(home, view, a) {
  const site = view.site;
  if (!site) { out('err', 'adopt 需要已安装（无站点清单）'); process.exitCode = 1; return; }
  const ctx = M.ctxOf(home);
  let n = 0;
  for (const { def, site: se } of view.entries) {
    if (!se || def.segment !== 'I' || def.kind === 'dir') continue;
    const st = se.state;
    if (st !== 'installed') continue;
    const p = entryPath(home, def, se);
    if (!X.exists(p)) continue;
    const text = X.readText(p);
    const probs = structureProblems(def.id, text, { zones: (def.zones || []).map((z) => ({ label: z.label, begin: z.begin, end: z.end })) });
    if (probs.length) { out('warn', `跳过 ${def.id}: 结构损坏，先修内容再登记 —— ${probs.join('；')}`); continue; }
    const before = se.hashAfter;
    se.hashAfter = X.sha256(p);
    se.adoptedAt = C.isoLocal();
    if (def.id === 'agents' && se.agentsMode === 'zones') {
      const [r, pv] = zoneRefs(def, L);
      se.zoneHash = zoneHashOf(text, r, pv);
    }
    if (before !== se.hashAfter) n++;
    out('ok', `已重新登记 ${def.id}: ${String(se.hashAfter).slice(0, 19)}…${def.id === 'agents' && se.zoneHash ? ` · 区基线 ${se.zoneHash.slice(7, 19)}…` : ''}`);
  }
  if (!n) out('info', '没有需要重新登记的条目（现场与登记一致）');
  M.saveSite(home, site);
  out('ok', `adopt 完成: 更新 ${n} 条登记基线（文件内容未改动）`);
}

// ---------------- install: 计划 ----------------
function planInstall(home, flags) {
  const ctx = M.ctxOf(home);
  const def = M.loadDefault();
  const site = M.loadSite(home);
  const defAgents = def.entries.find((e) => e.id === 'agents');
  const agentsPath = path.join(home, C.AGENTS_FILE);
  const skillPath = path.join(home, 'skills', C.SKILL_FILE);
  const seedAgents = flags.seedDir ? path.join(flags.seedDir, C.AGENTS_FILE) : null;
  const seedSkill = flags.seedDir ? path.join(flags.seedDir, C.SKILL_FILE) : null;
  const seedNb = flags.seedDir ? path.join(flags.seedDir, C.NB_DIRNAME) : null;
  const siteAgents = site ? site.entries.find((e) => e.id === 'agents') : null;
  const mode = flags.agentsMode || (siteAgents && siteAgents.agentsMode) || defAgents.agentsMode || 'whole';
  const steps = [];
  const notes = [];
  const blockers = [];
  const agentsText = X.exists(agentsPath) ? X.readText(agentsPath) : null;
  const rules = (defAgents.zones || []).find((z) => z.label === L.rules);
  const privacy = (defAgents.zones || []).find((z) => z.label === L.privacy);

  // D 段
  if (X.isDir(ctx.nb)) steps.push(`D 数据目录已存在 → 登记: ${ctx.nb}`);
  else if (seedNb && X.isDir(seedNb)) steps.push(`D 数据目录缺失 → 从种子整树复制: ${seedNb} → ${ctx.nb}`);
  else blockers.push(`数据目录不存在: ${ctx.nb}（请先放置数据目录, 或 --seed-dir 提供含 ${C.NB_DIRNAME}/ 的种子）`);

  // I: skill
  if (X.isFile(skillPath)) steps.push(`skill 已存在 → 登记: ${skillPath}`);
  else if (seedSkill && X.isFile(seedSkill)) steps.push(`skill 缺失 → 从种子复制: ${seedSkill}`);
  else if (M.latestBackup(home, 'skill')) steps.push('skill 缺失 → 从 .lifecycle/backups 最近快照恢复(remove 后可重装的依据)');
  else blockers.push(`skill 缺失且无种子/备份(--seed-dir 内含 ${C.SKILL_FILE}): ${skillPath}`);

  // I: AGENTS
  if (mode === 'zones') {
    if (!agentsText) blockers.push(`zones 模式要求 AGENTS.md 已存在(保护既有内容): ${agentsPath}`);
    else {
      const hasRules = Z.hasZone(agentsText, rules.begin, rules.end);
      steps.push('AGENTS[zones] 模式: 登记(只管理标记区, 区外内容不动)');
      if (!hasRules) steps.push('  · 文件尾创建空「规则自动段」标记区(幂等)');
      if (!Z.hasZone(agentsText, privacy.begin, privacy.end)) steps.push('  · 补齐「隐私提示区」标记(幂等; 改写前先字节级快照)');
    }
  } else if (agentsText) {
    const hasRules = Z.hasZone(agentsText, rules.begin, rules.end);
    if (!hasRules) {
      blockers.push(`AGENTS.md 已存在但不是本插件整文件形态(无「规则自动段」标记)。若整文件确归本插件(安装前无此文件): 加 --yes 强制登记(remove 将整文件删除); 若文件含你自己的内容: 改用 --agents-mode zones。`);
    } else {
      steps.push('AGENTS[whole] 模式: 登记(整文件归本插件)');
      if (!Z.hasZone(agentsText, privacy.begin, privacy.end)) {
        const tail = agentsText.slice(Z.findZone(agentsText, rules.begin, rules.end).end).trim();
        if (tail.startsWith('## 隐私提示')) steps.push('  · 整理: 将文件尾「## 隐私提示」纳入 privacy 标记区(区外不动, 改写前快照)');
        else if (!tail) steps.push('  · 整理: 追加空 privacy 标记区(改写前快照)');
        else notes.push('AGENTS 标记区后存在非标准尾注(非「## 隐私提示」开头); whole 模式整文件管理, 不自动改写');
      }
    }
  } else {
    const src = seedAgents && X.isFile(seedAgents) ? seedAgents : null;
    const hasBak = !!M.latestBackup(home, 'agents');
    if (src) steps.push(`AGENTS 缺失 → 从种子复制: ${src}`);
    else if (hasBak) steps.push('AGENTS 缺失 → 从 .lifecycle/backups 最近快照恢复(remove 后重装路径)');
    else steps.push('AGENTS 缺失 → 按内置模板创建(含 rules+privacy 标记区)');
  }
  return { def, site, mode, steps, notes, blockers, ctx, agentsPath, skillPath, agentsText, rules, privacy };
}

function cmdInstall(home, flags) {
  const p = planInstall(home, flags);
  out('plan', `install(${flags.apply ? 'apply' : 'dry-run'}) · agents-mode=${p.mode}`);
  if (p.blockers.length) {
    for (const b of p.blockers) out('err', b);
    out('err', '未产生完整计划(零写操作); 按上述提示准备后重跑');
    process.exitCode = 2;
    return;
  }
  for (const s of p.steps) out('plan', `- ${s}`);
  for (const n of p.notes) out('warn', n);
  out('plan', '- R 段(运行时): 只登记与对账, 不写入 —— 部署/摘除动作归 scripts/deploy-web.cjs');
  out('plan', '  · 登记时以现场探测为准: 有部署副本 → installed; 没有 → absent');
  out('plan', '  · 要部署或摘除运行时足迹: node scripts/deploy-web.cjs --apply | lifecycle/cli.cjs uninstall detach --apply');
  if (!flags.apply) {
    out('info', 'dry-run: 未执行任何写操作; 确认后重跑加 --apply');
    return;
  }
  applyInstall(home, flags, p);
}

// ---------------- install: 执行(幂等, 每步先查现场) ----------------
function applyInstall(home, flags, p) {
  const site = p.site || M.emptySite(p.def, M.ctxOf(home), 'none');
  const setEntry = (id, patch) => Object.assign(site.entries.find((x) => x.id === id), patch);
  const { agentsPath, skillPath, rules, privacy, ctx } = p;
  let touched = 0;
  try {
    // 1. 凡要改写既有 AGENTS 的目标, 先字节级前像
    const mayRewriteAgents =
      X.exists(agentsPath) && (
        (p.mode === 'zones' && (!Z.hasZone(X.readText(agentsPath), rules.begin, rules.end) || !Z.hasZone(X.readText(agentsPath), privacy.begin, privacy.end))) ||
        (p.mode !== 'zones' && !Z.hasZone(X.readText(agentsPath), privacy.begin, privacy.end))
      );
    if (mayRewriteAgents) {
      const rec = M.snapshot(home, site, 'agents', agentsPath);
      if (rec) { site.phase = 'backed-up'; M.saveSite(home, site); out('ok', `前像快照: ${rec.path}`); }
    }
    // 2. D 段
    if (!X.isDir(ctx.nb)) {
      const seedNb = flags.seedDir ? path.join(flags.seedDir, C.NB_DIRNAME) : null;
      X.copyTree(seedNb, ctx.nb);
      touched++;
      out('ok', `D: 已从种子复制数据目录 → ${ctx.nb}`);
    } else out('ok', 'D: 数据目录已存在, 登记完成');
    // 3. I: skill
    if (!X.isFile(skillPath)) {
      const seedSkill = flags.seedDir ? path.join(flags.seedDir, C.SKILL_FILE) : null;
      const latest = M.latestBackup(home, 'skill');
      if (seedSkill && X.isFile(seedSkill)) { X.copyFile(seedSkill, skillPath); out('ok', `I: skill 已创建 ← 种子`); }
      else if (latest) { X.copyFile(latest.path, skillPath); out('ok', `I: skill 已恢复 ← 备份 ${latest.path}`); }
      else throw new Error(`skill 无内容源(种子/备份均无): ${skillPath}`);
      touched++;
    } else out('ok', 'I: skill 已存在, 登记完成');
    // 4. I: AGENTS
    if (p.mode === 'zones') {
      let cur = X.readText(agentsPath); // 前置保证存在
      const before = cur;
      if (!Z.hasZone(cur, rules.begin, rules.end)) {
        cur = Z.ensureZone(cur, rules.begin, rules.end, RULES_EMPTY_BODY).text;
        out('ok', 'I: AGENTS 已补空「规则自动段」区(zones 模式, 文件尾)');
      }
      if (!Z.hasZone(cur, privacy.begin, privacy.end)) {
        const r = Z.findZone(cur, rules.begin, rules.end);
        const tail = cur.slice(r.end).trim();
        if (tail.startsWith('## 隐私提示')) {
          cur = wrapTail(cur, rules, privacy, tail);
          out('ok', 'I: AGENTS 尾注已原位纳入 privacy 标记区(zones 模式, 区外未动)');
        } else if (!tail) {
          cur = Z.ensureZone(cur, privacy.begin, privacy.end, PRIVACY_BODY).text;
          out('ok', 'I: AGENTS 文件尾已补默认 privacy 标记区');
        } else {
          cur = Z.ensureZone(cur, privacy.begin, privacy.end, PRIVACY_BODY).text;
          out('warn', 'I: AGENTS 规则区后有非标准内容(非「## 隐私提示」), 保持原样未纳入标记; remove 时该内容保留(zones 安全边界)');
        }
      }
      if (cur !== before) { X.writeTextAtomic(agentsPath, cur); touched++; }
      else out('ok', 'I: AGENTS zones 标记区齐备, 零改动');
      // v0.7.8：zones 模式登记**区内容基线**（区外是你自己的内容，永不参与漂移判定）
      const zr = zoneRefs(p.def.entries.find((e) => e.id === 'agents'), L);
      setEntry('agents', { state: 'installed', agentsMode: 'zones', adoptedAt: C.isoLocal(), hashAfter: X.sha256(agentsPath), zoneHash: zoneHashOf(X.readText(agentsPath), zr[0], zr[1]) });
    } else if (!X.exists(agentsPath)) {
      const seedAgents = flags.seedDir ? path.join(flags.seedDir, C.AGENTS_FILE) : null;
      const latest = M.latestBackup(home, 'agents');
      if (seedAgents && X.isFile(seedAgents)) { X.copyFile(seedAgents, agentsPath); out('ok', 'I: AGENTS 已创建 ← 种子'); }
      else if (latest) { X.copyFile(latest.path, agentsPath); out('ok', `I: AGENTS 已恢复 ← 备份 ${latest.path}`); }
      else { X.writeTextAtomic(agentsPath, C.AGENTS_TEMPLATE); out('ok', 'I: AGENTS 已按模板创建(whole 模式)'); }
      touched++;
      setEntry('agents', { state: 'installed', agentsMode: 'whole', adoptedAt: C.isoLocal(), hashAfter: X.sha256(agentsPath) });
    } else {
      let cur = X.readText(agentsPath);
      const before = cur;
      if (!Z.hasZone(cur, privacy.begin, privacy.end) && Z.hasZone(cur, rules.begin, rules.end)) {
        const r = Z.findZone(cur, rules.begin, rules.end);
        const tail = cur.slice(r.end).trim();
        if (tail.startsWith('## 隐私提示')) {
          cur = wrapTail(cur, rules, privacy, tail);
          out('ok', 'I: AGENTS 尾注已原位纳入 privacy 标记区(whole 整理, 区外未动)');
        } else if (!tail) {
          cur = Z.ensureZone(cur, privacy.begin, privacy.end, PRIVACY_BODY).text;
          out('ok', 'I: AGENTS 文件尾已补默认 privacy 标记区');
        } else {
          out('warn', 'I: AGENTS 规则区后存在非标准尾注(非「## 隐私提示」); whole 模式整文件管理, 不自动改写');
        }
      }
      if (cur !== before) { X.writeTextAtomic(agentsPath, cur); touched++; }
      out('ok', 'I: AGENTS whole 模式登记完成');
      setEntry('agents', { state: 'installed', agentsMode: 'whole', adoptedAt: C.isoLocal(), hashAfter: X.sha256(agentsPath) });
    }
    // 5. data/skill 状态
    setEntry('data', { state: 'installed', adoptedAt: C.isoLocal(), hashAfter: null });
    setEntry('skill', { state: 'installed', adoptedAt: C.isoLocal(), hashAfter: X.sha256(skillPath) });
    // 5b. 清单版本迁移(丢弃改名前的废弃条目) + 补齐默认清单新增条目 + R 段现场探测登记(不写入/不删除)
    const dropped = M.pruneSite(p.def, site);
    if (dropped.length) out('warn', `清单版本迁移: 丢弃已废弃条目 ${dropped.join(', ')}(结构以包内默认清单为准)`);
    const added = ensureSiteEntries(site, p.def, ctx);
    if (added.length) out('ok', `清单版本迁移: 补登记新条目 ${added.join(', ')}`);
    for (const r of realizeRuntime(home, site, p.def, ctx)) {
      out('ok', `R: ${r.id} → ${r.state} (${r.detail}) ${r.path} [managedBy ${r.managedBy}]`);
    }
    // 6. 落站点清单 + 自检
    site.state = 'installed';
    site.schemaVersion = p.def.schemaVersion;
    site.manifestVersion = p.def.manifestVersion; // 站点清单跟随包内默认清单的 schema 版本
    site.installedAt = site.installedAt || C.isoLocal();
    site.lastOp = { cmd: 'install', at: C.isoLocal(), ok: true };
    M.saveSite(home, site);
    const a = assess(home, M.mergedView(home));
    if (a.fails.length) {
      for (const f of a.fails) out('err', `verify: ${f}`);
      site.phase = 'verified-with-issues';
      M.saveSite(home, site);
      process.exitCode = 1;
    } else {
      site.phase = 'verified';
      M.saveSite(home, site);
      out('ok', touched ? `install --apply 完成: 本次改动文件 ${touched} 个; state=installed phase=verified` : 'install --apply 完成: 零文件改动(幂等); state=installed phase=verified');
    }
  } catch (e) {
    out('err', `install --apply 中断: ${e.message}`);
    out('err', '现场可续: 修复原因后重跑 --apply(幂等, 已完成步骤自动跳过); 前像在 .lifecycle/backups');
    process.exitCode = 1;
  }
}

// ---------------- 成果文件清点（卸载前与用户确认去留; 用户约定: AI 删除前必展示成果清单） ----------------
function artifactCounts(ctx) {
  const inboxFile = path.join(ctx.nb, 'inbox.md');
  let pending = 0;
  if (X.isFile(inboxFile)) pending = (X.readText(inboxFile).match(/^\| C\d+ /gm) || []).length;
  const entDir = path.join(ctx.nb, 'entries');
  const entriesN = X.isDir(entDir) ? X.listTop(entDir).filter((f) => !f.dir && f.name.endsWith('.md')).length : 0;
  const arcDir = path.join(ctx.nb, 'archive');
  const archiveN = X.isDir(arcDir) ? X.listTop(arcDir).filter((f) => !f.dir).length : 0;
  return { pending, entriesN, archiveN };
}

// ---------------- uninstall ----------------
function cmdUninstall(home, level, flags) {
  const site = M.loadSite(home);
  if (!site) {
    out('err', '未安装(无站点清单): 无需卸载; 先 install --apply 登记');
    process.exitCode = 2;
    return;
  }
  if (level === 'detach') {
    detachRuntime(home, { level, flags, site });
    return;
  }
  if (!['remove', 'purge'].includes(level)) {
    out('err', `未知卸载级别: ${level || ''}(应为 detach|remove|purge)`);
    process.exitCode = 2;
    return;
  }
  const def = M.loadDefault();
  const view = M.mergedView(home);
  const ctx = M.ctxOf(home);
  const agentsPath = path.join(home, C.AGENTS_FILE);
  const skillPath = path.join(home, 'skills', C.SKILL_FILE);
  const siteAgents = site.entries.find((e) => e.id === 'agents');
  const mode = (siteAgents && siteAgents.agentsMode) || 'whole';
  const defAgents = def.entries.find((e) => e.id === 'agents');
  const rules = (defAgents.zones || []).find((z) => z.label === L.rules);
  const privacy = (defAgents.zones || []).find((z) => z.label === L.privacy);
  const a = assess(home, view);
  const drift = a.diffs;
  const Iinstalled = view.entries.some(({ def: d, site: se }) => d.segment === 'I' && se && se.state === 'installed');
  const skillExists = X.isFile(skillPath);
  const agentsExists = X.exists(agentsPath);

  out('plan', level === 'remove'
    ? 'remove: 清除 R(运行时足迹, 动作归 deploy-web.cjs) + I(AGENTS/skill); D 段(用户记忆)原样保留'
    : 'purge: 清除 R + I + D; 用户记忆数据永不静默删除 → 先导出后删除(不可逆)');
  for (const d of drift) out('plan', `差异: ${d}`);
  if (drift.length) out('warn', '漂移提示: --apply 需加 --yes(删除前仍先字节级快照留档)');

  // R 段先摘(唯一写入者 deploy-web.cjs); 失败即中止, 避免留下"挂载行已删/副本残留"的半态继续动 I/D
  const rt = detachRuntime(home, { level, flags, site });
  if (rt === 'failed') {
    out('err', 'R 段摘除失败 → 中止后续段处理; 现场可能处于中间态, 复查后重跑本命令(幂等)');
    return;
  }
  if (flags.apply && !flags.yes && rt === 'done') {
    out('info', 'R 段副本目录保留(未传 --yes); 要连副本一起清: 重跑本命令加 --yes');
  }

  if (level === 'remove') {
    if (!Iinstalled && !skillExists && !agentsExists) {
      out('info', 'I 段已清/未登记 → 零动作(幂等)');
      if (flags.apply) out('ok', 'remove --apply 完成(零动作)');
      else out('info', 'dry-run: 未执行任何写操作');
      return;
    }
    const ac = artifactCounts(ctx);
    out('plan', '成果文件去留(删除前确认):');
    out('plan', `  · 保留(D 段记忆/数据): 待审候选 ${ac.pending} 条 · 经验条目 ${ac.entriesN} 个 · 归档 ${ac.archiveN} 个 · settings/state/README`);
    out('plan', '  · 删除(插件交付物; 删除前字节快照留档, 重装即还原):');
    if (agentsExists) out('plan', mode === 'whole'
      ? `    - AGENTS.md(whole 整文件; 内规则段为生成物, 可由 entries 再生)`
      : `    - AGENTS.md 标记区(zones; 区外内容保留)`);
    if (skillExists) out('plan', '    - skills/whale-notebook.md(L2 技能文件)');
    if (skillExists) out('plan', `- 快照后删除 skill: ${skillPath}`);
    if (agentsExists) out('plan', mode === 'whole'
      ? `- 快照后整文件删除 AGENTS(whole): ${agentsPath}`
      : `- 快照后剥离标记区(rules+privacy), 区外内容保留(zones): ${agentsPath}`);
    out('plan', `- 保留: ${ctx.nb}(含 .lifecycle 清单/备份, 供重装/恢复)`);
  } else {
    if (!flags.exportDir) {
      out('err', 'purge 需要 --export-dir <导出目录>(用户记忆先导出)与 --yes(二次确认)');
      process.exitCode = 2;
      return;
    }
    if (!flags.yes) {
      out('err', 'purge 需要 --yes 二次确认; 数据只以导出物留存, 删除不可逆');
      process.exitCode = 2;
      return;
    }
    const ex = path.resolve(flags.exportDir);
    if (ex === ctx.nb || ex.startsWith(ctx.nb + path.sep)) {
      out('err', '导出目录不能是数据目录本身或其子目录');
      process.exitCode = 2;
      return;
    }
    const ac = artifactCounts(ctx);
    out('plan', '成果文件清单(全部先导出、后删除; --yes = 你在会话中确认过成果删除):');
    out('plan', `  · 待审候选 ${ac.pending} 条 → inbox.md 导出`);
    out('plan', `  · 经验条目 ${ac.entriesN} 个 → entries/ 导出`);
    out('plan', `  · 归档 ${ac.archiveN} 个 → archive/ 导出`);
    out('plan', '  · settings.json / state.json / README.md 随 D 整目录导出');
    out('plan', `- 导出 → ${path.join(ex, `whale-notebook-export-${C.localStamp()}`)}/: D 整目录${agentsExists ? ' + AGENTS.md' : ''}${skillExists ? ' + skill' : ''}`);
    out('plan', `- 删除 I: ${agentsPath}${skillExists ? ` ; ${skillPath}` : ''}`);
    out('plan', `- 删除 D: ${ctx.nb}(含本 CLI 自身); 完成后本机不再有 whale-notebook 代码/数据/清单`);
    out('warn', '恢复 = 把导出物放回原位后重跑 install --apply(见导出物内 README.txt)');
  }
  if (!flags.apply) {
    out('info', 'dry-run: 未执行任何写操作; 确认后重跑加 --apply');
    return;
  }
  if (level === 'remove') applyRemove(home, flags, { site, drift, agentsPath, skillPath, mode, rules, privacy, ctx });
  else applyPurge(home, flags, { drift, agentsPath, skillPath, mode, rules, privacy, ctx });
}

function applyRemove(home, flags, q) {
  const { drift, agentsPath, skillPath, mode, rules, privacy, ctx } = q;
  if (drift.length && !flags.yes) {
    out('err', '现场与登记 hash 不一致(漂移), remove 已中止; 确认继续: 加 --yes(仍会先字节级快照留档)');
    process.exitCode = 2;
    return;
  }
  const site = q.site;
  try {
    // 1. 前像快照(卸载内容必须留档可恢复)
    const snaps = [];
    if (X.isFile(skillPath)) { const r = M.snapshot(home, site, 'skill', skillPath); if (r) snaps.push(r); }
    if (X.exists(agentsPath)) { const r = M.snapshot(home, site, 'agents', agentsPath); if (r) snaps.push(r); }
    if (snaps.length) { site.phase = 'backed-up'; M.saveSite(home, site); }
    for (const s of snaps) out('ok', `前像快照: ${s.path}`);
    // 2. 清 I
    if (X.isFile(skillPath)) {
      X.rmFile(skillPath);
      out('ok', 'I: skill 已删除(字节留档于快照)');
    }
    if (X.exists(agentsPath)) {
      if (mode === 'whole') {
        X.rmFile(agentsPath);
        out('ok', 'I: AGENTS 整文件已删除(whole 模式; 字节留档于快照)');
      } else {
        const before = X.readText(agentsPath);
        const after = Z.stripZone(Z.stripZone(before, rules.begin, rules.end), privacy.begin, privacy.end);
        if (after !== before) {
          if (after.trim()) { X.writeTextAtomic(agentsPath, after); out('ok', `I: AGENTS 已剥离标记区(zones 模式), 区外内容保留: ${agentsPath}`); }
          else { X.rmFile(agentsPath); out('ok', 'I: AGENTS 剥离后为空, 整文件已删除'); }
        } else out('warn', 'I: AGENTS 未见可剥离标记区, 原样保留(请人工裁决)');
      }
    }
    // 3. 状态
    for (const e of site.entries) if (e.segment === 'I' && e.state === 'installed') e.state = 'removed';
    site.state = 'removed';
    site.phase = 'verified';
    site.lastOp = { cmd: 'remove', at: C.isoLocal(), ok: true };
    M.saveSite(home, site);
    // 4. 自检
    const a = assess(home, M.mergedView(home));
    if (a.fails.length) { for (const f of a.fails) out('err', `verify: ${f}`); process.exitCode = 1; }
    else out('ok', `remove --apply 完成: I 段已清, state=${site.state} phase=verified`);
    out('info', `D 段原样保留(用户记忆): ${ctx.nb}`);
    out('info', '.lifecycle 保留: 清单+备份留档; 重装请运行 install --apply(自动从备份恢复字节)');
  } catch (e) {
    out('err', `remove --apply 中断: ${e.message}; 重跑可续(幂等)`);
    process.exitCode = 1;
  }
}

function applyPurge(home, flags, q) {
  const { agentsPath, skillPath, mode, rules, privacy, ctx } = q;
  const exRoot = path.resolve(flags.exportDir);
  const exDir = path.join(exRoot, `whale-notebook-export-${C.localStamp()}`);
  try {
    fsxChdirSafe(exRoot); // 先建导出目录并离开数据目录(最后要自删)
    // 1. 导出
    X.copyTree(ctx.nb, path.join(exDir, C.NB_DIRNAME));
    out('ok', `导出: D 数据目录 → ${path.join(exDir, C.NB_DIRNAME)}`);
    let readme = `# whale-notebook purge 导出 @ ${C.isoLocal()}\n\n- 数据内容遵循既有隐私规则(打码/指纹摘要, 无会话原文)\n`;
    if (X.isFile(skillPath)) {
      X.copyFile(skillPath, path.join(exDir, C.SKILL_FILE));
      readme += `- skill 字节副本: ${C.SKILL_FILE}\n`;
    }
    if (X.exists(agentsPath)) {
      if (mode === 'whole') {
        X.copyFile(agentsPath, path.join(exDir, C.AGENTS_FILE));
        readme += '- AGENTS.md 字节副本(whole 模式)\n';
      } else {
        const stripped = Z.stripZone(Z.stripZone(X.readText(agentsPath), rules.begin, rules.end), privacy.begin, privacy.end);
        if (stripped.trim()) {
          X.writeTextAtomic(path.join(exDir, C.AGENTS_FILE), stripped);
          readme += '- AGENTS.md 剥离标记区后的内容副本(zones 模式)\n';
        }
      }
    }
    readme += '- 恢复: 导出物放回原位(whale-notebook/ + 两文件)后运行 plugin/lifecycle/cli.cjs install --apply\n';
    X.writeTextAtomic(path.join(exDir, 'README.txt'), readme);
    // 2. 删 I
    if (X.isFile(skillPath)) X.rmFile(skillPath);
    if (X.exists(agentsPath)) {
      if (mode === 'whole') X.rmFile(agentsPath);
      else {
        const stripped = Z.stripZone(Z.stripZone(X.readText(agentsPath), rules.begin, rules.end), privacy.begin, privacy.end);
        if (stripped.trim()) X.writeTextAtomic(agentsPath, stripped); else X.rmFile(agentsPath);
      }
    }
    // 3. 删 D(自删)
    X.rmTree(ctx.nb);
    if (!X.exists(skillPath) && !X.exists(agentsPath) && !X.exists(ctx.nb)) {
      out('ok', `purge --apply 完成: R(未挂载)/I/D 全部清除; 导出物: ${exDir}`);
      out('info', '本机不再有 whale-notebook 代码/数据/清单(除导出物)');
    } else {
      out('err', 'purge 完成但仍有残留(skill/agents/data 部分存在); 请人工处理或重启后再试');
      process.exitCode = 1;
    }
  } catch (e) {
    out('err', `purge --apply 中断: ${e.message}; 导出物可能已生成于 ${exDir}, 未清除部分请人工核对`);
    process.exitCode = 1;
  }
}
function fsxChdirSafe(d) {
  require('fs').mkdirSync(d, { recursive: true });
  process.chdir(d);
}

// ---------------- main ----------------
function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === 'help' || argv.includes('--help') || argv.includes('-h')) {
    console.log(C.HELP);
    return;
  }
  const { cmd, level, flags } = parseArgv(argv);
  const home = C.resolveHome(flags.home);
  try {
    if (cmd === 'status') cmdStatus(home);
    else if (cmd === 'check') cmdCheck(home, flags);
    else if (cmd === 'install') cmdInstall(home, flags);
    else if (cmd === 'uninstall') cmdUninstall(home, level, flags);
    else { out('err', `未知命令: ${cmd}`); console.log(C.HELP); process.exitCode = 2; }
  } catch (e) {
    out('err', `${cmd} 执行异常: ${e.message}`);
    out('err', e.stack || '');
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { main };
