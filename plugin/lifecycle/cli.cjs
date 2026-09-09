// lifecycle/cli.cjs - 安装/卸载/清单机制 CLI（v0.1: I+D 段; R 段 deferred 待 v2.1）
// 设计依据: docs/2026_09_09_16_whale-notebook生命周期设计.md
// 自举约束: 仅 node 内建; 从任意位置 node <pkg>/lifecycle/cli.cjs 均可运行。
// 所有写操作两段式: 默认 dry-run 出计划(展示给用户) → 确认后 --apply。
'use strict';
const path = require('path');
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

// ---------------- 参数解析 ----------------
function parseArgv(argv) {
  const flags = { apply: false, agentsMode: null, seedDir: null, exportDir: null, yes: false, home: null };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') flags.apply = true;
    else if (a === '--yes') flags.yes = true;
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

// ---------------- 现场评估: 每 installed/removed 条目 vs 现场; 孤儿扫描 ----------------
function assess(home, view) {
  const res = { diffs: [], fails: [], orphans: [] };
  for (const { def, site } of view.entries) {
    if (def.segment === 'R') continue; // deferred, v2.1
    const st = site ? site.state : def.state;
    if (st === 'deferred' || st === 'pending') continue;
    const p = entryPath(home, def, site);
    const present = X.exists(p);
    const isAgents = def.id === 'agents';
    const zonesMode = isAgents && site && site.agentsMode === 'zones';
    if (st === 'installed') {
      if (def.kind === 'dir') {
        if (!present) res.fails.push(`缺: ${p} (D 数据目录, state=installed)`);
        continue;
      }
      if (isAgents && zonesMode) {
        if (!present) { res.fails.push(`缺: ${p} (AGENTS.md)`); continue; }
        const text = X.readText(p);
        for (const label of [L.rules, L.privacy]) {
          const z = (def.zones || []).find((zz) => zz.label === label);
          if (z && !Z.hasZone(text, z.begin, z.end)) res.fails.push(`区缺: ${p} 无「${label}」标记`);
        }
        continue;
      }
      if (present) {
        const cur = X.sha256(p);
        if (site.hashAfter && site.hashAfter !== cur) {
          res.diffs.push(`漂移: ${p} 登记 ${site.hashAfter.slice(0, 12)}… ≠ 现场 ${(cur || '').slice(0, 12)}…`);
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
    if (!a.diffs.length && !a.fails.length && !a.orphans.length) out('status', '现场与清单一致');
  }
}

// ---------------- check ----------------
function cmdCheck(home) {
  const view = M.mergedView(home);
  const site = view.site;
  if (!site) out('check', '未安装（无站点清单）— 仅做足迹扫描:');
  const a = assess(home, view);
  for (const d of a.diffs) out('check', `差异: ${d}`);
  for (const f of a.fails) out('check', `失败: ${f}`);
  for (const o of a.orphans) out('check', `孤儿: ${o}`);
  if (!a.diffs.length && !a.fails.length && !a.orphans.length) {
    out('ok', 'check 通过: 清单 vs 现场一致, 无孤儿');
  } else {
    out('err', `check 未通过: 失败 ${a.fails.length} / 差异 ${a.diffs.length} / 孤儿 ${a.orphans.length}`);
    process.exitCode = 1;
  }
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
  out('plan', '- R 段(deferred): v2.1 真实挂载后再实施, 本次不动作');
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
      setEntry('agents', { state: 'installed', agentsMode: 'zones', adoptedAt: C.isoLocal(), hashAfter: null });
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
    // 6. 落站点清单 + 自检
    site.state = 'installed';
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
    out('plan', 'detach: R 段条目 state=deferred(v2.1 挂载后启用) → 零动作');
    if (flags.apply) out('ok', 'detach 完成: R 段当前未登记, 无运行时可摘');
    else out('info', 'dry-run: 未执行任何写操作');
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
    ? 'remove: 清除 R(未挂载,无) + I(AGENTS/skill); D 段(用户记忆)原样保留'
    : 'purge: 清除 R(未挂载,无) + I + D; 用户记忆数据永不静默删除 → 先导出后删除(不可逆)');
  for (const d of drift) out('plan', `差异: ${d}`);
  if (drift.length) out('warn', '漂移提示: --apply 需加 --yes(删除前仍先字节级快照留档)');

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
    else if (cmd === 'check') cmdCheck(home);
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
