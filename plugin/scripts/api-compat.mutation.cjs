// 变异反证：把 v0.7.10 的"每次动作现取服务"改回"开机取一次"（旧写法），
// 确认 api-compat.selftest 的端到端断言真的会失败（不是只靠缝隙缺失）。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const src = path.join(__dirname, '..', 'lib', 'client.js');
// bundle 落盘是 CRLF：匹配前统一成 LF，写回时再还原（不然变异点永远命不中）
const raw = fs.readFileSync(src, 'utf8');
const code = raw.replace(/\r\n/g, '\n');
const OLD = `			var uiWorkspace = null;
			function syncServices() {
				sessions = svcOf(ctx, "sessions");`;
const MUT = `			var uiWorkspace = null;
			var __syncedOnce = false;
			syncServices();   // MUTANT: 旧写法——开机取一次就永久缓存
			function syncServices() {
				if (__syncedOnce) return sessions;
				__syncedOnce = true;
				sessions = svcOf(ctx, "sessions");`;
if (code.indexOf(OLD) === -1) { console.error('变异点未命中（bundle 结构已变）'); process.exit(2); }
const out = path.join(process.env.TEMP || '.', 'whale-client-mutant.js');
fs.writeFileSync(out, code.replace(OLD, MUT).replace(/\n/g, '\r\n'));

let status = 0;
try {
  execFileSync(process.execPath, [path.join(__dirname, 'api-compat.selftest.cjs')], {
    env: Object.assign({}, process.env, { WHALE_CLIENT_BUNDLE: out }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
} catch (error) {
  status = error.status;
  const text = String((error.stdout || '') + (error.stderr || ''));
  const lost = text.split('\n').filter((line) => line.startsWith('FAIL')).slice(0, 5);
  console.log('变异体退出码：' + status);
  console.log(lost.join('\n'));
}
fs.unlinkSync(out);
if (status === 0) { console.error('反证失败：变异体（旧写法）竟然全绿 —— 自测没有覆盖该回归'); process.exit(1); }
console.log('反证通过：把服务解析改回“开机取一次”后自测立即变红（' + status + '）');
