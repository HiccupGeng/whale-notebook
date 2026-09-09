// lib/index.js - dsh-whale-notebook 插件入口（v2.1 挂载用；v2.0 阶段仅占位与元信息）
// 设计：apply(ctx) 保持最小——只挂「主机平面」能力；会话平面能力(v2.2)另走 agent preset 行。
// 注意：本机安装的 cordis 装载器契约以 @deepseek-ai/dsh-* 包与 dump-config 为准，挂载前先做 pilot 验证。
const PACKAGE = { name: 'dsh-whale-notebook', version: '0.2.0' };

export function apply(/* ctx, config */) {
  // v2.1 TODO(主机平面, pilot 验证后启用):
  //  - 注册 ctx 服务 memoryStore(复用 core/store/repo.cjs)
  //  - 事件监听: tool/result / agent/request-error 失败信号(去重后写 evidence)
  //  - web API/UI 桥(未来: inbox 徽标、小对话框、桌宠桥接)
}

export default { apply, name: PACKAGE.name, version: PACKAGE.version };
