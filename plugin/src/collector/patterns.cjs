// collector/patterns.cjs - 坑特征模式表（采集信号词典；展示/未来硬拦共用）
'use strict';

const PATTERNS = [
  { id: 'encoding', title: '编码/中文乱码(命令链路/控制台)', re: /编码|乱码|GBK|GB2312|gb18030|code page|codepage|chcp|65001|误判|\?\?\?\?|console encoding|mojibake/i },
  { id: 'sandbox-ep', title: '沙箱限制(EPERM/执行策略/管道)', re: /EPERM|only core types|named pipes|ConstrainedLanguage|ExecutionPolicy|not digitally signed/i },
  // v0.6.2：权限类文本归口本类（标题本就含「路径/权限/升级」），但**不含**裸 `permission denied`
  //   ——ssh 的 `Permission denied (publickey)` 属 git/网络鉴权，见 git-net。
  { id: 'sandbox-file', title: '沙箱拒绝写(路径/权限/升级)', re: /\[sandbox: file access denied|sandbox_permissions|escalation available|not strictly wider|approval prompt|approval policy|insufficient permissions|access is denied|cannot read configuration file|拒绝访问|权限不足/i },
  { id: 'stale-fs', title: '文件读写前置要求/内容过期', re: /file changed since it was read|requires reading .* first|old_string was not found|re-read the file/i },
  { id: 'timeout', title: '超时/连接失败', re: /timeout|timed out|ETIMEDOUT|超时|connect to .* failed|Failed sending data to the peer/i },
  { id: 'git-net', title: 'git/网络(推送失败/鉴权/代理)', re: /fatal:.*(denied|auth|token|unable|not a git|repository)|authentication failed|SSL certificate|proxy|permission denied \(publickey\)|host key verification failed/i },
  // v0.6.2：收紧 model-api —— 原 `/429|insufficient|balance/` 过宽，实测把
  //   「文件名清单里某个字节数含 429」误判为模型 API 错、把「insufficient permissions」误判为余额不足。
  { id: 'model-api', title: '模型/API(429/限流/余额)', re: /rate limit|too many requests|429[^\d]{0,20}(?:too many|rate limit)|insufficient[_ ]?(?:quota|balance|credits|funds)|no (?:balance|credits)|api error|connection error|ECONNREFUSED|ECONNRESET/i },
  { id: 'file-missing', title: '文件/路径不存在', re: /not found|ENOENT|cannot find|no such file|无法找到/i },
  { id: 'port-busy', title: '端口占用/进程占用', re: /EADDRINUSE|EBUSY|already in use|被占用/i },
];
// v0.6.2：权限类文本归口 sandbox-file（标题本就含「路径/权限/升级」），
//   避免被 model-api 的 insufficient 抢走，也避免整条丢失。
const PERMISSION_RE = /insufficient permissions|access is denied|cannot read configuration file|拒绝访问|权限不足/i;
const PAT_IDS = new Set(PATTERNS.map((p) => p.id));
// 用户/助手叙述里值得收的高信号类别（其余类别收事件会产生大量回声）
const NARRATION_IDS = ['encoding', 'sandbox-ep', 'sandbox-file', 'git-net'];

module.exports = { PATTERNS, PAT_IDS, NARRATION_IDS, PERMISSION_RE };
