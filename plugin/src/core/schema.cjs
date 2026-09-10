// core/schema.cjs - 领域契约（v1 数据不变式 + 未来扩展字段）
// 说明：条目/待审行/设置的 schema 是全项目公共协议；展示、桌宠、审核面板都消费同一契约。
'use strict';

const CATEGORY_TITLES = {
  encoding: '编码/中文乱码(命令链路/控制台)',
  'stale-fs': '文件操作纪律(read-before-edit/过期重读)',
  'sandbox-file': '沙箱拒绝写(路径/权限/升级)',
  'sandbox-ep': '沙箱限制(EPERM/执行策略/管道)',
  approval: '审批策略',
  'tool-mode': '工具模式误用',
  'git-net': 'git/网络',
  secret: '密钥与隐私',
  'session-state': '会话状态/todo 收尾',
  'data-access': '会话数据访问(zstd)',
  'long-session': '长会话管理',
  timeout: '超时/连接失败',
  'model-api': '模型/API',
  'file-missing': '文件/路径不存在',
  'port-busy': '端口/文件占用',
  other: '其他',
};

// v0.4 适用范围维度（与 category 正交；判定为语义判断：入库审核时 AI 建议 + 用户确认）
const SCOPE_TITLES = {
  global: '全局适用',
  project: '项目级',
};

const SETTINGS_DEFAULTS = {
  autoCollect: true,
  denylistWorkspaces: [],
  minOccurrences: 1,
  maxRulesInAgents: 12,
  checkEnabled: true,
  // v0.5：增量采集与实时入库
  scanMode: 'incremental', // incremental（默认，按水位线只扫新增）| full（每轮全量重扫）
  liveCapture: true,       // 宿主 session/event 实时入箱（需重启 dsh web 生效）
  reAddCooldownDays: 7,    // 已处置的坑复发时，冷却期内只静默计数、不重开候选
  reminderListMax: 3,      // 会话开始提醒：待审 ≤ 该值才逐条列编号清单，否则只报数字（省 token）
  maxFingerprints: 5000,   // seenFingerprints 上限，超出按插入序截尾（防无限增长）
  // v0.6：拉取式（关掉自动入箱）
  autoAdd: true,           // false = 扫描照常但新发现只暂存 state.deferred，不自动写入待审箱；mine.cjs --add 入箱
  maxDeferred: 200,        // 暂存摘要上限（超出按最近出现时间保留最新的）
};

const AGENTS_MARK = {
  begin: '<!-- whale-notebook:rules -->',
  end: '<!-- /whale-notebook:rules -->',
};

// 待审行协议: `| C### | 类别 | 次数 | 工作区 | 现象(打码) | 时间 |`
// v0.5：现象/工作区列里的 `|` 换成全角 `｜` —— 否则该行无法被表格解析（面板看不见、也无法累加次数）
function cell(s) { return String(s == null ? '' : s).replace(/\|/g, '｜'); }
function inboxRow(candidateId, row) {
  const id = 'C' + String(candidateId).padStart(3, '0');
  return `| ${id} | ${cell(row.cat)} | ${cell(row.n)} | ${cell([...row.wsSet].slice(0, 2).join(','))} | ${cell(String(row.text).slice(0, 120))} | ${cell(row.time || '')} |`;
}
const INBOX_HEADER = '| 编号 | 类别 | 次数 | 工作区 | 现象（一行，已打码） | 时间 |\n|---|---|---|---|---|---|';

// 经验条目 frontmatter 模板（review/commit 用）
// v0.4 扩展：scope（global|project，缺省=global 兼容旧条目）+ projects（scope=project 时的适用项目白名单，可多项目）
function renderEntryFile(entry) {
  return `---
id: ${entry.id}
title: ${entry.title}
category: ${entry.category}
status: ${entry.status || 'active'}
scope: ${entry.scope || 'global'}
projects: [${(entry.projects || []).join(', ')}]
occurrences: ${entry.occurrences}
firstSeen: ${entry.firstSeen}
lastSeen: ${entry.lastSeen}
workspaces: [${(entry.workspaces || []).join(', ')}]
rule: "${String(entry.rule).replace(/"/g, '\\"')}"
created: ${entry.created}
updated: ${entry.updated}
sources: [${(entry.sources || []).join(', ')}]
---

## 现象

${entry.symptom}

## 根因

${entry.rootCause}

## 对策

${entry.actions}

## 验证

${entry.verification || '(待补充)'}
`;
}

// 规则行协议：进入 AGENTS.md 自动段的形态（一条 = 一行；v0.4 起自动段只收 scope=global 条目）
function ruleLine(entry) {
  return `- 【${entry.category}】${entry.rule}`;
}

module.exports = {
  CATEGORY_TITLES,
  SCOPE_TITLES,
  SETTINGS_DEFAULTS,
  AGENTS_MARK,
  INBOX_HEADER,
  inboxRow,
  renderEntryFile,
  ruleLine,
};
