// mine.cjs - 兼容薄壳（v1 入口不变: AGENTS 提醒句/skill/历史脚本都指向这里）
// 真实逻辑已模块化到 ../plugin/src/（collector/engine + cli）；本文件只转发并保持导出兼容。
// 用法不变:
//   node mine.cjs --check | --prewarm | --stats | --render-rules
'use strict';
const { redact } = require('../plugin/src/core/privacy.cjs');
const { fmtTime } = require('../plugin/src/core/util.cjs');
module.exports = { redact, fmtTime };

if (require.main === module) {
  const { run } = require('../plugin/src/collector/cli.cjs');
  run(process.argv.slice(2));
}
