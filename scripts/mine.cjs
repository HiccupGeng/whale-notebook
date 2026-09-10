// mine.cjs - 兼容薄壳（v1 入口不变: AGENTS 提醒句/skill/历史脚本都指向这里）
// 真实逻辑已模块化到 ../plugin/src/（collector/engine + cli）；本文件只转发并保持导出兼容。
// 用法不变:
//   node mine.cjs --check | --add | --rebuild | --stats | --prewarm [--full] [--dry] | --render-rules | --wall
// v0.7.3 退出码契约（唯一进程级出口；cli.run()/engine.runScan() 保持纯函数，供宿主复用）:
//   0 = 采集成功（"有新发现/有暂存"亦为成功——拉取式下这是常态）
//   2 = 前置缺失（sessions 根 / 数据目录不存在；与 lifecycle/cli.cjs 的 2 对齐）
//   1 = 失败或结果形状异常（含未捕获异常）
'use strict';
const { redact } = require('../plugin/src/core/privacy.cjs');
const { fmtTime } = require('../plugin/src/core/util.cjs');

function exitCodeOf(out) {
  if (out && out.ok === true) return 0;
  if (out && out.ok === false) return 2; // runScan 的两处 ok:false 均为前置缺失
  return 1;                              // 形状异常（未捕获异常时传入 null）
}

module.exports = { redact, fmtTime, exitCodeOf };

if (require.main === module) {
  const { run } = require('../plugin/src/collector/cli.cjs');
  let out = null;
  try {
    out = run(process.argv.slice(2));
  } catch (err) {
    console.error('[mine] 采集异常: ' + ((err && err.stack) || err));
  }
  process.exitCode = exitCodeOf(out); // 异常 → out 仍为 null → 1
}
