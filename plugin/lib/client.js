// lib/client.js - dsh-whale-notebook 浏览器半边：鲸鱼决策箱悬浮侧边面板（双卡：待审箱｜已解决墙）
// 手写 __ModuleLoader__ bundle（与官方 client 产物同格式；零 require 依赖，纯 DOM + CSS）。
// 数据/动作通道：
//   GET  /whale/inbox            -> {pending, rows}                 （host half 注册）
//   GET  /whale/inbox/detail     -> {ok, text} 候选详情 sidecar（v0.3）
//   POST /whale/inbox/delete     -> 删除（移入 archive，可恢复）
//   GET  /whale/solved           -> 已解决墙聚合 stats/global/projects/disabled（v0.4）
//   GET  /whale/entry?id=E###    -> 条目全文（v0.4；行展开详情）
//   ctx.sessions / ctx.workspaces（官方 client-runtime 服务）-> 自动处理(投递当前会话)/详细讨论(新会话)
// v0.3 语义：自动处理 = 判定表硬规则（模板内嵌）；重大隐患 -> agent 固定行 [WHALE-RISK]，
//            面板轮询会话消息快照（ConversationSnapshot.nodes / .partial）识别并弹红色警示条。
// v0.4 语义：已解决墙 = 轻口径（入库即已处理）；全局区/项目区分组，行点击拉条目全文展开；
//            无待审且无条目时整面板隐藏（不打扰）；project 级条目仅展示、不进任何注入面。
// v0.4.1（UI，2026-09）：⚡ 自动处理入口暂时隐藏（候选行只剩 💬 讨论 / ✕ 删除；代码与判定表保留，
//            apply() 内 AUTO_VISIBLE = true 即可一键恢复）；待审箱页头「✅」= 直达已解决墙（A2 页），
//            已解决页头「🐳」= 返回待审箱（双向直达，无需先收起再点侧边入口）。
// v0.5（2026-09）：⟳ 从「只重拉列表」升级为「先触发增量扫描再刷新」（POST /whale/scan，零 token：
//            宿主按水位线只解新增帧；会话运行中的失败另由宿主 session/event 实时入箱）。
//   POST /whale/scan             -> {ok, added, bumped, pending, ms}  面板 ⟳ 触发的增量扫描
//   GET  /whale/live             -> {ok, version, live, watermarks...} 运行状态（自检/排障）
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-whale-notebook",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region css
		var CSS_ID = "@deepseek-ai/dsh-whale-notebook/panel.css";
		var CSS = [
			".wh-box{position:fixed;right:8px;top:50%;transform:translateY(-50%);z-index:2147482000;font-family:system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,#24272d);-webkit-user-select:none;user-select:none}",
			".wh-tab{position:relative;display:flex;flex-direction:column;align-items:center;gap:3px;padding:9px 4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-bg-base,#ffffff) 78%,rgba(128,128,128,.22));border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));box-shadow:0 2px 10px rgba(0,0,0,.10);cursor:pointer;transition:background .12s}",
			".wh-tab:hover{background:var(--dsw-alias-bg-base,#ffffff)}",
			".wh-tab-ico{font-size:15px;line-height:1;filter:saturate(.9)}",
			".wh-tab-label{writing-mode:vertical-rl;letter-spacing:1px;color:var(--dsw-alias-label-tertiary,#8a90a0);font-size:10px;font-weight:600}",
			".wh-badge{position:absolute;top:-5px;right:-7px;min-width:15px;height:15px;padding:0 3px;border-radius:99px;background:#e5484d;color:#fff;font-size:10px;line-height:15px;text-align:center;font-weight:700;box-sizing:border-box}",
			".wh-card{display:none;flex-direction:column;width:280px;max-height:248px;border-radius:12px;background:var(--dsw-alias-bg-base,#ffffff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));box-shadow:0 10px 30px rgba(0,0,0,.20);overflow:hidden}",
			".wh-tab+.wh-tab{margin-top:6px}",
			".wh-open-inbox .wh-tab,.wh-open-solved .wh-tab{display:none}",
			".wh-open-inbox .wh-card-inbox{display:flex}",
			".wh-open-solved .wh-card-solved{display:flex}",
			".wh-card-solved{width:336px;max-height:460px}",
			".wh-badge2{position:absolute;top:-5px;right:-7px;min-width:15px;height:15px;padding:0 3px;border-radius:99px;background:#2f9e6e;color:#fff;font-size:10px;line-height:15px;text-align:center;font-weight:700;box-sizing:border-box}",
			".wh-stats{flex:none;display:flex;align-items:center;gap:10px;padding:4px 12px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0);border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06))}",
			".wh-sec{flex:none;display:flex;align-items:center;gap:6px;padding:6px 10px 2px;font-size:11px;font-weight:700;color:var(--dsw-alias-label-primary,#24272d)}",
			".wh-sec-n{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0);font-weight:600}",
			".wh-grp{padding:5px 8px 1px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0);font-weight:700}",
			".wh-srow{cursor:pointer}",
			".wh-srow .wh-rule{margin-top:2px;color:var(--dsw-alias-label-secondary,#565b66);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}",
			".wh-srow-open{background:rgba(90,130,255,.08)}",
			".wh-det{display:none;white-space:pre-wrap;word-break:break-all;margin-top:4px;padding:6px 8px;background:rgba(128,128,128,.09);border-radius:6px;font:11px/1.5 ui-monospace,Consolas,monospace;color:var(--dsw-alias-label-secondary,#565b66);max-height:210px;overflow:auto}",
			".wh-det-on{display:block}",
			".wh-scope{flex:none;font-size:10px;line-height:1;padding:2px 5px;border-radius:99px;font-weight:700}",
			".wh-scope-g{background:rgba(47,158,110,.16);color:#1f7a52}",
			".wh-scope-p{background:rgba(180,130,60,.18);color:#8a6414}",
			".wh-last{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-head{flex:none;display:flex;align-items:center;gap:4px;padding:7px 8px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
			".wh-head-title{flex:1;min-width:0;font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".wh-icn{flex:none;width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font-size:12px;line-height:20px;opacity:.5;text-align:center}",
			".wh-icn:hover{opacity:1;background:rgba(128,128,128,.16)}",
			".wh-list{flex:1;overflow-y:auto;min-height:0;padding:5px 6px 7px}",
			".wh-list::-webkit-scrollbar{width:6px}",
			".wh-list::-webkit-scrollbar-thumb{background:rgba(128,128,128,.35);border-radius:3px}",
			".wh-row{padding:5px 6px;border-radius:8px}",
			".wh-row+.wh-row{margin-top:1px}",
			".wh-row:hover{background:rgba(128,128,128,.13)}",
			".wh-meta{display:flex;align-items:center;gap:5px;min-width:0}",
			".wh-id{flex:none;font-weight:700;color:var(--dsw-alias-label-primary,#24272d)}",
			".wh-cat{flex:none;font-size:10px;line-height:1;padding:2px 5px;border-radius:99px;background:rgba(90,130,255,.18);color:var(--dsw-alias-label-secondary,#565b66)}",
			".wh-risk{flex:none;font-size:9px;line-height:1;padding:2px 5px;border-radius:99px;background:rgba(229,72,77,.15);color:#c93a3f;font-weight:700}",
			".wh-n{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-acts{margin-left:auto;flex:none;display:flex;gap:1px;opacity:.35}",
			".wh-row:hover .wh-acts{opacity:1}",
			".wh-abtn{width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;cursor:pointer;font-size:11px;line-height:20px;color:inherit;text-align:center}",
			".wh-abtn:hover{background:rgba(128,128,128,.2)}",
			".wh-abtn-danger{color:#e5484d;font-weight:700}",
			".wh-abtn-danger:hover{background:rgba(229,72,77,.2);color:#b02a2f}",
			".wh-text{margin-top:2px;color:var(--dsw-alias-label-secondary,#565b66);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}",
			".wh-empty{padding:18px 8px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-foot{flex:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));padding:4px 10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-toast{position:fixed;right:14px;bottom:14px;z-index:2147482100;max-width:320px;padding:7px 12px;border-radius:8px;font:12px/1.4 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#fff;background:rgba(28,32,38,.94);box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s;pointer-events:none}",
			".wh-toast-on{opacity:1;transform:none}",
			".wh-alert{display:none;position:fixed;right:8px;bottom:66px;width:300px;z-index:2147482060;background:var(--dsw-alias-bg-base,#ffffff);border:1px solid rgba(229,72,77,.6);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.24);overflow:hidden;font:12px/1.5 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:var(--dsw-alias-label-primary,#24272d)}",
			".wh-alert-on{display:block}",
			".wh-alert-head{display:flex;align-items:center;gap:6px;padding:7px 10px;background:rgba(229,72,77,.12);color:#c93a3f;font-weight:700}",
			".wh-alert-id{flex:none;font-size:10px;padding:1px 6px;border-radius:99px;background:#e5484d;color:#fff}",
			".wh-alert-body{padding:8px 10px 2px;color:var(--dsw-alias-label-secondary,#565b66);max-height:88px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}",
			".wh-alert-acts{display:flex;gap:6px;padding:8px 10px 9px}",
			".wh-alert-btn{flex:1;padding:5px 4px;border:none;border-radius:6px;cursor:pointer;font:600 11px/1 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:inherit}",
			".wh-alert-btn:hover{filter:brightness(.96)}",
			".wh-alert-btn-primary{background:#e5484d;color:#fff}",
			".wh-alert-btn-ghost{background:rgba(128,128,128,.14)}"
		].join("");
		function ensureCss() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") === null) {
				var tag = document.createElement("style");
				tag.dataset.plugin = "@deepseek-ai/dsh-whale-notebook";
				tag.dataset.pluginCss = CSS_ID;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}
		}
		//#endregion
		//#region helpers
		function el(tag, cls, text) {
			var n = document.createElement(tag);
			if (cls) n.className = cls;
			if (text !== undefined && text !== null) n.textContent = text;
			return n;
		}
		function apiGet() {
			return fetch("/whale/inbox", { headers: { accept: "application/json" } }).then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
		}
		// v0.7：同族/相关候选（讨论会话的确定性依据）；失败返回 null（调用方退回单条上下文）
		function apiRelated(id) {
			return fetch("/whale/related?id=" + encodeURIComponent(id), { headers: { accept: "application/json" } })
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { return (j && j.ok === true) ? j : null; })
				.catch(function () { return null; });
		}
		// v0.5：触发宿主增量扫描（POST /whale/scan）；失败返回 null（调用方回退为只刷新）
		function apiScan() {
			return fetch("/whale/scan", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}"
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (j) {
					if (!r.ok || !j || j.ok !== true) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
					return j;
				});
			}).catch(function (err) {
				console.warn("[whale-panel] 增量扫描失败（仅刷新列表）:", err && err.message ? err.message : err);
				return null;
			});
		}
		// v0.3：候选详情 sidecar；失败/旧候选一律返回 null（调用方回退无详情模板）
		function apiDetail(id) {
			return fetch("/whale/inbox/detail?id=" + encodeURIComponent(id), { headers: { accept: "application/json" } })
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { return (j && j.ok === true && j.text) ? j.text : null; })
				.catch(function () { return null; });
		}
		function apiDelete(id) {
			return fetch("/whale/inbox/delete", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ id: id })
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (j) {
					if (!r.ok || !j || j.ok !== true) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
					return j;
				});
			});
		}
		// v0.4：已解决墙聚合（只读 entries frontmatter）
		function apiSolved() {
			return fetch("/whale/solved", { headers: { accept: "application/json" } }).then(function (r) {
				if (!r.ok) throw new Error("HTTP " + r.status);
				return r.json();
			});
		}
		// v0.4：条目全文（行展开详情；失败/不存在 → null）
		function apiEntry(id) {
			return fetch("/whale/entry?id=" + encodeURIComponent(id), { headers: { accept: "application/json" } })
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { return (j && j.ok === true && j.text) ? j.text : null; })
				.catch(function () { return null; });
		}
		// 剥离条目全文 frontmatter（首行 --- 至第二个 --- 之间），只留可读正文
		function stripFrontmatter(text) {
			var i = String(text || "").indexOf("\n---\n");
			return i >= 0 ? text.slice(i + 5) : text;
		}
		function waitBinding(sessions, id, timeoutMs) {
			var t0 = Date.now();
			return new Promise(function (resolve) {
				(function poll() {
					try {
						var b = sessions.binding(id);
						if (b && b.session) return resolve(b);
					} catch (e) { /* keep polling */ }
					if (Date.now() - t0 >= timeoutMs) return resolve(null);
					setTimeout(poll, 60);
				})();
			});
		}
		function currentSessionId(sessions) {
			try { return sessions.list.getSnapshot().current; } catch (e) { return undefined; }
		}
		function workspaceIdOf(sessions, workspaces, cur) {
			try {
				var items = workspaces ? workspaces.list.getSnapshot().items : [];
				for (var i = 0; i < items.length; i++) {
					if (items[i] && items[i].sessionIds && items[i].sessionIds.indexOf(cur) !== -1) return items[i].workspaceId;
				}
			} catch (e) { /* fallthrough */ }
			return undefined;
		}
		// ---- 会话消息读取（RISK 观察器用；client-runtime ConversationSnapshot）----
		function sessionSnapshot(sessions, id) {
			try {
				var b = sessions.binding(id);
				if (b && b.session && typeof b.session.getSnapshot === "function") return b.session.getSnapshot();
			} catch (e) { /* keep polling */ }
			return null;
		}
		function blocksText(blocks) {
			if (!blocks) return "";
			var out = "";
			for (var i = 0; i < blocks.length; i++) {
				var b = blocks[i];
				if (b && b.kind === "text" && typeof b.text === "string") out += b.text;
			}
			return out;
		}
		// 最新可见的 assistant 文本：流式 partial 优先（更快触发），否则最后一个已定稿 assistant 节点
		function latestAssistantText(snap) {
			if (!snap) return null;
			try {
				if (snap.partial && snap.partial.blocks && snap.partial.blocks.length) {
					var t = blocksText(snap.partial.blocks);
					if (t) return t;
				}
				var nodes = snap.nodes;
				if (nodes) {
					for (var i = nodes.length - 1; i >= 0; i--) {
						var n = nodes[i];
						if (n && n.kind === "assistant") {
							var done = blocksText(n.blocks);
							if (done) return done;
						}
					}
				}
			} catch (e) { /* fallthrough */ }
			return null;
		}
		//#endregion
		//#region text builders（候选信息全部来自 inbox 已打码行 + 本地 detail sidecar）
		function rowById(rows, id) {
			for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
			return null;
		}
		function contextLine(r) {
			if (!r) return null;
			return "候选 " + r.id + "｜类别 " + r.cat + "｜出现 " + r.n + " 次｜工作区 " + r.ws + "｜首次出现 " + r.time + "｜现象：" + r.text;
		}
		function detailBlock(detail) {
			if (!detail) return "";
			return "\n\n—— 后台详情（候选详情 sidecar，错误摘录已打码；如需更多证据可按其中「源日志路径」只读查阅）：\n" + detail;
		}
		// v0.3：自动处理 = 判定表硬规则。可自动（补全型小修、禁区外、可自验证）→ 预告后执行；
		// 命中禁区 → 禁止任何修改，第一行回复固定标记 [WHALE-RISK]，面板据此弹红色警示条。
		function autoMessage(r, detail) {
			var c = contextLine(r);
			if (!c) return null;
			var L = [];
			L.push("【决策箱自动处理】用户通过侧边面板授权你自动处理本候选（信息来自已打码 inbox 行，可信但已脱敏）：");
			L.push(c + detailBlock(detail));
			L.push("");
			L.push("第一步【只读风险判定】：不要动任何东西，先按下面的规则判定能否自动执行。");
			L.push("");
			L.push("■ 可自动执行 —— 必须全部满足：");
			L.push("1. 问题单一、方案标准无歧义（只有一种公认修复做法，不存在需要用户权衡的多条路线）；");
			L.push("2. 修复动作属于「补全型小修」：新增/修正配置项、补环境变量或 PATH、安装缺失依赖等；不删除、不覆盖任何已有内容；");
			L.push("3. 影响域封闭：只动本机应用环境或单一项目配置；绝不触碰 DSH 本体（cordis 配置/插件/加载器/依赖树）、不触碰 ~/.dsh 运行结构、不触碰用户产出物（文档/代码/数据/仓库文件）、不触碰隐私敏感文件；");
			L.push("4. 修复后可自验证：重跑原失败操作能确认成功。");
			L.push("满足时按此纪律执行：①先输出一行「自动修复：将执行 <具体动作>」预告；②执行最小修改；③重跑原失败操作自验证；④报告改动与验证结果。");
			L.push("");
			L.push("■ 禁止自动 —— 命中任一条立即停止、禁止执行任何修改：");
			L.push("需要删除/覆盖任何已有内容（文件/行/数据）；修改 DSH 本体或 ~/.dsh 运行结构；改动用户产出文件/文档/代码/数据/仓库；方案存在多种互斥选择、需要用户权衡；原因不明或影响不明。");
			L.push("→ 此时不要执行任何写入或修改，回复第一行必须是固定标记行：「[WHALE-RISK] <一句话风险说明>」，随后可附建议的处置计划，等待用户指示（面板检测到该标记会提醒用户，并支持一键转入人工讨论会话）。");
			L.push("");
			L.push("铁律：不触碰 inbox.md / entries / AGENTS.md（小本本写入走既有「先展示→用户确认→落盘」流程）；执行中一旦发现自己落入禁止情形，立即停止并按上节上报。");
			return L.join("\n");
		}
		// v0.3：详细讨论（可带风险上报原文 riskText —— 自动处理被阻止后的转人工入口）
		function discussMessage(r, detail, riskText, related) {
			var c = contextLine(r);
			if (!c) return null;
			var L = [];
			L.push("【决策箱转入·详细讨论】这条候选从侧边面板转到本会话单独讨论：");
			L.push(c + detailBlock(detail));
			if (riskText) {
				L.push("");
				L.push("⚠ 该候选此前尝试「自动处理」时被判定为重大隐患并已阻止，以下是当时的风险上报原文（第一行为固定标记行）：");
				L.push(riskText);
				L.push("");
				L.push("请在讨论中重点评估其风险边界与处置方式；不要因该上报而执行其中任何修改。");
			}
			L.push("");
			// v0.7：把「同族/相似候选/可能已覆盖的条目」由程序算出后写进讨论消息——
			// 保证新会话开局就有确定依据，而不是等模型自己想起来去翻 inbox。
			var rel = relatedBlock(related);
			if (rel) L.push(rel);
			L.push("请先基于上述信息（如需更多证据可按源日志路径只读查阅）确认你已理解该问题的实际情况，再给出判断：问题是否真实存在／是否值得沉淀为经验／建议如何处置。");
			L.push("v0.7 固定动作：先看上面的「同族/相似候选」，判断它们是否与本案同一根因——是则建议合并为一条经验（occurrences 取总和、证据合并），不是则指出应拆分的边界；再核对「可能已被条目覆盖」的提示，避免重复建条目。");
			L.push("当前阶段约束：只读分析；不要执行任何写入或修改，不要调用会改动文件的工具；等用户指示后再按小本本流程入库或归档。");
			return L.join("\n");
		}
		// v0.7：同族块文本（related = GET /whale/related 的返回；缺失时返回空串，退回单条上下文）
		function relatedBlock(j) {
			if (!j) return "";
			var L = [];
			var fam = j.family || {};
			var vs = fam.variants || [];
			L.push("");
			L.push("—— 同族证据（程序按骨架相似度计算，非模型猜测）：本候选由 " + (fam.size || vs.length || 1) + " 个变体合并而成，合计 " + (fam.n || 0) + " 次");
			for (var i = 0; i < vs.length && i < 8; i++) {
				var v = vs[i];
				L.push("  · " + (v.score != null && v.score < 1 ? "相似度 " + v.score + "｜" : "") + "×" + (v.n || 1) + "｜" + (v.cat || "") + "｜" + String(v.text || "").slice(0, 100));
			}
			if (vs.length > 8) L.push("  · …另有 " + (vs.length - 8) + " 个变体（详情见 sidecar）");
			var rl = j.related || [];
			if (rl.length) {
				L.push("—— 其它相似候选（相似度 ≥" + ((j.thresholds && j.thresholds.related) || 0.35) + "，程序计算）：");
				for (var k = 0; k < rl.length; k++) {
					L.push("  · " + rl[k].id + "｜×" + rl[k].n + "｜相似度 " + rl[k].score + "｜" + String(rl[k].text || "").slice(0, 100));
				}
			}
			var es = j.entries || [];
			if (es.length) {
				L.push("—— 可能已被现有条目覆盖（入库前请核对，避免重复建条目）：");
				for (var m = 0; m < es.length; m++) {
					L.push("  · " + es[m].id + "（" + es[m].category + "，相似度 " + es[m].score + "）：" + String(es[m].rule || es[m].title || "").slice(0, 120));
				}
			}
			return L.join("\n");
		}
		//#endregion
		//#region panel
		function apply(ctx) {
			if (typeof document === "undefined") return;
			ensureCss();
			var sessions = null;
			var workspaces = null;
			try { sessions = ctx.get("sessions"); } catch (e) { /* 面板降级为只读 */ }
			try { workspaces = ctx.get("workspaces"); } catch (e) { /* 讨论时按默认工作区 */ }

			var rows = [];
			var pending = 0;
			var deferred = 0;    // v0.6：拉取式——已暂存、尚未入箱的新发现条数（/whale/inbox 附带）
			var solved = null;   // v0.4：已解决墙数据（/whale/solved 聚合）
			var open = null;     // null | 'inbox' | 'solved'
			var timer = null;
			var toastTimer = null;
			var toastEl = null;
			var riskFlags = {};   // id -> 一句话风险原因（警示条可见期间的「需人工」行标）
			var riskWatcher = null; // watchRisk 的 interval
			var alertEl = null;
			var alertTimer = null;
			var AUTO_VISIBLE = false; // v0.4.1：⚡ 自动处理入口暂时隐藏（投递当前会话+警示条效果用户不认可）；置 true 恢复

			var box = el("div", "wh-box");
			// 入口 tab A：待审（有待审核候选才显示；红徽 = 待审数）
			var tabA = el("div", "wh-tab");
			tabA.title = "鲸鱼待审箱：待审核候选（点击展开）";
			var tabIco = el("div", "wh-tab-ico", "🐳");
			var tabLabel = el("div", "wh-tab-label", "待审");
			var badge = el("div", "wh-badge", "0");
			tabA.appendChild(tabIco);
			tabA.appendChild(tabLabel);
			tabA.appendChild(badge);
			box.appendChild(tabA);
			// 入口 tab B：已解决（v0.4；有 active 条目才显示；绿徽 = 已解决数）
			var tabB = el("div", "wh-tab");
			tabB.title = "鲸鱼已解决墙：已入库条目（点击展开）";
			var tabIco2 = el("div", "wh-tab-ico", "✅");
			var tabLabel2 = el("div", "wh-tab-label", "已解决");
			var badge2 = el("div", "wh-badge2", "0");
			tabB.appendChild(tabIco2);
			tabB.appendChild(tabLabel2);
			tabB.appendChild(badge2);
			box.appendChild(tabB);

			// 卡 A：待审列表（原行为不变）
			var card = el("div", "wh-card wh-card-inbox");
			var head = el("div", "wh-head");
			var headTitle = el("div", "wh-head-title", "🐳 待审箱");
			// v0.4.1：页头快捷钮「进入 A2 已解决页」——贴刷新 ⟳ 左边，免去收起再点侧边 ✅ 入口
			var btnSolved = el("button", "wh-icn", "✅");
			btnSolved.title = "已解决墙（A2）：查看已入库条目";
			var btnRefresh = el("button", "wh-icn", "⟳");
			btnRefresh.title = "刷新";
			var btnClose = el("button", "wh-icn", "✕");
			btnClose.title = "收起 (Esc)";
			head.appendChild(headTitle);
			head.appendChild(btnSolved);
			head.appendChild(btnRefresh);
			head.appendChild(btnClose);
			card.appendChild(head);
			var list = el("div", "wh-list");
			card.appendChild(list);
			var foot = el("div", "wh-foot", "候选来自 inbox.md｜删除移入 archive");
			card.appendChild(foot);
			box.appendChild(card);
			// 卡 B：已解决墙（v0.4；轻口径：入库=已处理；与文档墙 INDEX.md 同源）
			var cardB = el("div", "wh-card wh-card-solved");
			var headB = el("div", "wh-head");
			var headTitleB = el("div", "wh-head-title", "✅ 已解决");
			// v0.4.1：对称返回钮「回待审箱」——贴刷新 ⟳ 左边
			var btnBack = el("button", "wh-icn", "🐳");
			btnBack.title = "待审箱：返回待审核候选列表";
			var btnRefreshB = el("button", "wh-icn", "⟳");
			btnRefreshB.title = "刷新";
			var btnCloseB = el("button", "wh-icn", "✕");
			btnCloseB.title = "收起 (Esc)";
			headB.appendChild(headTitleB);
			headB.appendChild(btnBack);
			headB.appendChild(btnRefreshB);
			headB.appendChild(btnCloseB);
			cardB.appendChild(headB);
			var statsB = el("div", "wh-stats");
			cardB.appendChild(statsB);
			var listB = el("div", "wh-list");
			cardB.appendChild(listB);
			var footB = el("div", "wh-foot", "轻口径：入库=已处理｜文档墙 INDEX.md 同源｜点击条目看详情");
			cardB.appendChild(footB);
			box.appendChild(cardB);
			document.body.appendChild(box);
			if (toastEl === null) {
				toastEl = el("div", "wh-toast");
				document.body.appendChild(toastEl);
			}
			if (alertEl === null) {
				alertEl = el("div", "wh-alert");
				document.body.appendChild(alertEl);
			}

			function toast(text) {
				if (!toastEl) return;
				toastEl.textContent = text;
				toastEl.classList.add("wh-toast-on");
				if (toastTimer) clearTimeout(toastTimer);
				toastTimer = setTimeout(function () {
					toastEl.classList.remove("wh-toast-on");
					toastTimer = null;
				}, 2800);
			}

			function renderRows() {
				list.textContent = "";
				if (rows.length === 0) {
					// v0.6：拉取式（autoAdd=false）下待审箱可能为空但仍有暂存发现——要说清楚怎么取
					list.appendChild(el("div", "wh-empty", deferred > 0
						? "（暂无待审候选；已暂存 " + deferred + " 条新发现——回复「小本本复盘」入箱后审核）"
						: "（暂无可审核候选）"));
					return;
				}
				for (var i = 0; i < rows.length; i++) {
					(function (r) {
						var row = el("div", "wh-row");
						var meta = el("div", "wh-meta");
						meta.appendChild(el("span", "wh-id", r.id));
						if (riskFlags[r.id]) meta.appendChild(el("span", "wh-risk", "需人工"));
						meta.appendChild(el("span", "wh-cat", r.cat));
						meta.appendChild(el("span", "wh-n", "×" + r.n));
						if (r.variants > 1) meta.appendChild(el("span", "wh-cat", "族×" + r.variants));
						var acts = el("span", "wh-acts");
						// v0.4.1：⚡ 自动处理入口暂时隐藏（AUTO_VISIBLE=false）；doAuto/watchRisk/RISK 警示保留待恢复
						if (AUTO_VISIBLE) {
							var b1 = el("button", "wh-abtn", "⚡");
							b1.title = "自动处理：只读诊断；补全型小修可直接执行，重大隐患自动上报";
							b1.addEventListener("click", function (ev) { ev.stopPropagation(); doAuto(r); });
							acts.appendChild(b1);
						}
						var b2 = el("button", "wh-abtn", "💬");
						b2.title = "详细讨论：开新会话并携带该候选上下文与后台详情";
						var b3 = el("button", "wh-abtn wh-abtn-danger", "✕");
						b3.title = "删除：视为已解决/无需解决，移入归档（可恢复）";
						acts.appendChild(b2);
						acts.appendChild(b3);
						meta.appendChild(acts);
						row.appendChild(meta);
						var text = el("div", "wh-text", r.text);
						text.title = "工作区 " + r.ws + "｜首次 " + r.time;
						row.appendChild(text);
						row.title = "讨论💬 / 删除✕";
						b2.addEventListener("click", function (ev) { ev.stopPropagation(); doDiscuss(r); });
						b3.addEventListener("click", function (ev) { ev.stopPropagation(); doDelete(r); });
						list.appendChild(row);
					})(rows[i]);
				}
			}

			// v0.4：已解决墙状态机（无待审且无已解决 → 整面板隐藏，保持「不打扰」）
			function applyState() {
				var showA = pending > 0 || deferred > 0;   // v0.6：仅有暂存发现时也保留入口（面板不躲起来）
				var showB = !!(solved && solved.stats && solved.stats.active > 0);
				if (!showA && !showB) {
					box.style.display = "none";
					open = null;
					box.classList.remove("wh-open-inbox", "wh-open-solved");
					return;
				}
				box.style.display = "";
				tabA.style.display = showA ? "" : "none";
				if (showA) {
					var badgeN = pending > 0 ? pending : deferred;
					badge.textContent = badgeN > 99 ? "99+" : String(badgeN);
					headTitle.textContent = "🐳 待审箱 · " + pending + (deferred > 0 ? "（暂存 " + deferred + "）" : "");
				}
				tabB.style.display = showB ? "" : "none";
				if (showB) {
					badge2.textContent = solved.stats.active > 99 ? "99+" : String(solved.stats.active);
					headTitleB.textContent = "✅ 已解决 · " + solved.stats.active;
				}
				if ((open === "inbox" && !showA) || (open === "solved" && !showB)) {
					open = null;
					box.classList.remove("wh-open-inbox", "wh-open-solved");
				}
			}

			function setMode(mode) {
				if (open === mode) {
					open = null;
					box.classList.remove("wh-open-inbox", "wh-open-solved");
					return;
				}
				open = mode;
				box.classList.remove("wh-open-inbox", "wh-open-solved");
				box.classList.add(mode === "solved" ? "wh-open-solved" : "wh-open-inbox");
				if (mode === "inbox") {
					refresh(true);
					renderRows();
				} else {
					refreshSolved(true);
					renderSolved();
				}
			}

			function refresh(silent) {
				return apiGet().then(function (j) {
					if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : "响应异常");
					rows = j.rows || [];
					pending = j.pending || 0;
					deferred = j.deferred || 0;
					applyState();
					if (open === "inbox") renderRows();
				}, function (err) {
					// 宿主 API 未就绪（服务重启窗口等）：静默降级，绝不打扰用户任务
					if (!silent) console.warn("[whale-panel] 拉取 /whale/inbox 失败:", err && err.message ? err.message : err);
				});
			}

			function refreshSolved(silent) {
				return apiSolved().then(function (j) {
					if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : "响应异常");
					solved = j;
					applyState();
					if (open === "solved") renderSolved();
				}, function (err) {
					if (!silent) console.warn("[whale-panel] 拉取 /whale/solved 失败:", err && err.message ? err.message : err);
				});
			}

			// ---- 已解决墙渲染（v0.4）----
			function solvedRowEl(e, withCat) {
				var row = el("div", "wh-row wh-srow");
				var meta = el("div", "wh-meta");
				meta.appendChild(el("span", "wh-id", e.id));
				meta.appendChild(el("span", "wh-scope " + (e.scope === "project" ? "wh-scope-p" : "wh-scope-g"), e.scope === "project" ? "项目" : "全局"));
				if (withCat) meta.appendChild(el("span", "wh-cat", e.category));
				meta.appendChild(el("span", "wh-n", "×" + e.occurrences));
				meta.appendChild(el("span", "wh-last", e.lastSeen || ""));
				row.appendChild(meta);
				row.appendChild(el("div", "wh-text", e.title || "（无标题）"));
				row.appendChild(el("div", "wh-rule", e.rule || ""));
				var det = el("div", "wh-det");
				row.appendChild(det);
				row.addEventListener("click", function () {
					var on = det.classList.contains("wh-det-on");
					if (on) {
						det.classList.remove("wh-det-on");
						row.classList.remove("wh-srow-open");
						return;
					}
					row.classList.add("wh-srow-open");
					det.textContent = "（加载中…）";
					det.classList.add("wh-det-on");
					apiEntry(e.id).then(function (text) {
						var head2 = "📌 " + e.id + " · " + (e.title || "") + "\n类别 " + e.category + "｜出现 " + e.occurrences + " 次｜最近 " + (e.lastSeen || "") +
							(e.scope === "project" ? "｜适用项目 " + ((e.projects || []).join(", ") || "?") : "｜全局适用") + "\n对策：" + (e.rule || "") + "\n\n";
						det.textContent = head2 + stripFrontmatter(text || "（条目文件缺失或不可读）");
					});
				});
				return row;
			}
			function renderSolved() {
				listB.textContent = "";
				var s = solved;
				if (!s || !s.stats) {
					listB.appendChild(el("div", "wh-empty", "（加载失败，请点 ⟳ 重试）"));
					return;
				}
				if (s.stats.active === 0 && s.stats.disabled === 0) {
					listB.appendChild(el("div", "wh-empty", "（暂无已入库条目——审核候选入库后，这里出现「已解决」清单）"));
					return;
				}
				if (s.stats.global > 0) {
					listB.appendChild(el("div", "wh-sec", "🐳 全局区（适用所有工作区）"));
					for (var gi = 0; gi < s.global.length; gi++) {
						(function (grp) {
							listB.appendChild(el("div", "wh-grp", grp.title));
							for (var k = 0; k < grp.entries.length; k++) listB.appendChild(solvedRowEl(grp.entries[k], false));
						})(s.global[gi]);
					}
				}
				if (s.stats.project > 0) {
					listB.appendChild(el("div", "wh-sec", "📁 项目区（仅对应项目适用 · 不进全局自动段）"));
					for (var pi = 0; pi < s.projects.length; pi++) {
						(function (grp) {
							listB.appendChild(el("div", "wh-grp", "项目 " + grp.ws));
							for (var k = 0; k < grp.entries.length; k++) listB.appendChild(solvedRowEl(grp.entries[k], false));
						})(s.projects[pi]);
					}
				}
				if (s.stats.disabled > 0) {
					listB.appendChild(el("div", "wh-sec", "🛑 停用 " + s.stats.disabled));
					for (var di = 0; di < s.disabled.length; di++) listB.appendChild(solvedRowEl(s.disabled[di], true));
				}
			}

			// ---- 新会话载体（详细讨论 / 风险转人工共用）----
			function openDiscussion(r, msg) {
				if (!sessions) return toast("当前环境无会话服务，无法开新会话");
				var cur = currentSessionId(sessions);
				var workspaceId = workspaceIdOf(sessions, workspaces, cur);
				var opts = workspaceId !== undefined ? { workspaceId: workspaceId } : {};
				sessions.create(opts).then(function (newId) {
					return waitBinding(sessions, newId, 5000).then(function (bind) {
						if (bind) {
							try {
								return bind.session.prompt([{ type: "text", text: msg }], "queue").then(function () {
									return newId;
								}, function () {
									return newId;
								});
							} catch (e) { return newId; }
						}
						return newId;
					});
				}, function (err) {
					toast("新建会话失败：" + (err && err.message ? err.message : String(err)));
					return null;
				}).then(function (newId) {
					if (!newId) return;
					sessions.open(newId);
					toast("已为新候选开独立会话：" + r.id);
				});
			}

			// ---- v0.3 RISK 观察器：投递自动处理后轮询会话回复，识别 [WHALE-RISK] 固定标记 ----
			function stopRiskWatch() {
				if (riskWatcher) { clearInterval(riskWatcher); riskWatcher = null; }
			}
			function showRiskAlert(r, reason, fullText) {
				riskFlags[r.id] = reason || "未说明";
				if (alertEl) {
					alertEl.textContent = "";
					var ah = el("div", "wh-alert-head");
					ah.appendChild(el("span", "wh-alert-id", r.id));
					ah.appendChild(document.createTextNode("⚠ 自动处理被阻止 · 需人工"));
					alertEl.appendChild(ah);
					var ab = el("div", "wh-alert-body", fullText || reason);
					alertEl.appendChild(ab);
					var aa = el("div", "wh-alert-acts");
					var btnGo = el("button", "wh-alert-btn wh-alert-btn-primary", "转人工讨论");
					btnGo.title = "新建会话携带该候选上下文与风险上报原文";
					var btnOk = el("button", "wh-alert-btn wh-alert-btn-ghost", "知道了");
					aa.appendChild(btnGo);
					aa.appendChild(btnOk);
					alertEl.appendChild(aa);
					btnGo.addEventListener("click", function () {
						hideRiskAlert();
						apiDetail(r.id).then(function (detail) {
							var msg = discussMessage(r, detail, fullText || reason);
							if (msg) openDiscussion(r, msg);
						});
					});
					btnOk.addEventListener("click", hideRiskAlert);
					alertEl.classList.add("wh-alert-on");
				}
				if (open === "inbox") renderRows();
				toast("⚠ " + r.id + " 自动处理被阻止：存在重大隐患");
			}
			function hideRiskAlert() {
				riskFlags = {};
				if (alertEl) alertEl.classList.remove("wh-alert-on");
				if (open === "inbox") renderRows();
			}
			function watchRisk(sid, r) {
				stopRiskWatch();
				var pre = latestAssistantText(sessionSnapshot(sessions, sid));
				var seenText = pre || null;
				var tries = 0;
				riskWatcher = setInterval(function () {
					tries++;
					var text = latestAssistantText(sessionSnapshot(sessions, sid));
					if (text && text !== seenText) {
						seenText = text;
						if (/^\s*\[WHALE-RISK\]/.test(text)) {
							stopRiskWatch();
							var lines = text.split("\n");
							var reason = (lines[0] || "").replace(/^\s*\[WHALE-RISK\]\s*/, "").trim() || "见下方风险上报原文";
							showRiskAlert(r, reason, text);
							return;
						}
					}
					if (tries >= 45) stopRiskWatch(); // ~180s 观察上限（4s × 45）
				}, 4000);
			}

			function doAuto(r) {
				if (!sessions) return toast("当前环境无会话服务，自动处理不可用");
				var cur = currentSessionId(sessions);
				if (!cur) return toast("请先打开一个会话（自动处理投递到当前会话）");
				apiDetail(r.id).then(function (detail) {
					var msg = autoMessage(r, detail);
					if (!msg) return toast("候选数据缺失，无法构造消息");
					waitBinding(sessions, cur, 4000).then(function (bind) {
						if (!bind) return toast("会话服务尚未就绪，请稍后重试");
						try {
							bind.session.prompt([{ type: "text", text: msg }], "queue").then(function (res) {
								if (res && res.ok) {
									toast("已交给当前会话自动处理 " + r.id);
									watchRisk(cur, r);
								} else {
									toast("投递失败：" + ((res && res.error && (res.error.message || res.error.code)) || "未知错误"));
								}
							}, function (err) {
								toast("投递失败：" + (err && err.message ? err.message : String(err)));
							});
						} catch (err) {
							toast("投递失败：" + (err && err.message ? err.message : String(err)));
						}
					});
				});
			}

			function doDiscuss(r) {
				// v0.7：先取详情与「同族/相似候选」再构造消息——新会话开局即带确定依据
				Promise.all([apiDetail(r.id), apiRelated(r.id)]).then(function (res) {
					var msg = discussMessage(r, res[0], null, res[1]);
					if (!msg) return toast("候选数据缺失，无法构造消息");
					openDiscussion(r, msg);
				});
			}

			function doDelete(r) {
				apiDelete(r.id).then(function () {
					delete riskFlags[r.id];
					toast("已移入归档：" + r.id);
					return refresh(true);
				}, function (err) {
					toast("删除失败：" + (err && err.message ? err.message : String(err)));
				});
			}

			// ---- 事件与生命周期 ----
			tabA.addEventListener("click", function () { setMode(open === "inbox" ? null : "inbox"); });
			tabB.addEventListener("click", function () { setMode(open === "solved" ? null : "solved"); });
			// v0.4.1：页头双向直达（✅ 进 A2 已解决页 / 🐳 回待审箱）——两钮只出现在各自卡片可见时
			btnSolved.addEventListener("click", function () { setMode("solved"); });
			btnBack.addEventListener("click", function () { setMode("inbox"); });
			btnClose.addEventListener("click", function () { setMode(null); });
			btnCloseB.addEventListener("click", function () { setMode(null); });
			// v0.5：⟳ = 先触发宿主增量扫描（零 token：按水位线只解新增帧），再刷新列表
			btnRefresh.addEventListener("click", function () {
				renderRows();
				apiScan().then(function (j) {
					if (j) {
						btnRefresh.title = j.added
							? "刷新（本次增量扫描：新发现 " + j.added + " 条｜待审共 " + j.pending + " 条）"
							: "刷新（本次增量扫描：无新发现｜" + j.ms + "ms）";
					}
					return refresh(false);
				});
			});
			btnRefreshB.addEventListener("click", function () { renderSolved(); refreshSolved(false); });
			function onDocDown(ev) {
				if (open && !box.contains(ev.target)) setMode(null);
			}
			function onKey(ev) {
				if (ev.key === "Escape") setMode(null);
			}
			function onFocus() { refresh(true); refreshSolved(true); }
			function onVis() { if (!document.hidden) { refresh(true); refreshSolved(true); } }
			document.addEventListener("pointerdown", onDocDown, true);
			window.addEventListener("keydown", onKey);
			window.addEventListener("focus", onFocus);
			document.addEventListener("visibilitychange", onVis);
			timer = setInterval(function () {
				if (!document.hidden) { refresh(true); refreshSolved(true); }
			}, 30000);

			ctx.effect(function () {
				return function () {
					if (timer) clearInterval(timer);
					stopRiskWatch();
					document.removeEventListener("pointerdown", onDocDown, true);
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVis);
					if (toastTimer) clearTimeout(toastTimer);
					if (alertTimer) clearTimeout(alertTimer);
					if (box && box.parentNode) box.parentNode.removeChild(box);
					if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
					if (alertEl && alertEl.parentNode) alertEl.parentNode.removeChild(alertEl);
				};
			}, "whale-panel: lifecycle");

			applyState();
			refresh(true);
			refreshSolved(true);
		}
		//#endregion
		exports.apply = apply;
		return module.exports;
	}
});
