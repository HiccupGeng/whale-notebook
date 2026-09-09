// lib/client.js - dsh-whale-notebook 浏览器半边：鲸鱼决策箱悬浮侧边面板
// 手写 __ModuleLoader__ bundle（与官方 client 产物同格式；零 require 依赖，纯 DOM + CSS）。
// 数据/动作通道：
//   GET  /whale/inbox            -> {pending, rows}                 （host half 注册）
//   GET  /whale/inbox/detail     -> {ok, text} 候选详情 sidecar（v0.3）
//   POST /whale/inbox/delete     -> 删除（移入 archive，可恢复）
//   ctx.sessions / ctx.workspaces（官方 client-runtime 服务）-> 自动处理(投递当前会话)/详细讨论(新会话)
// v0.3 语义：自动处理 = 判定表硬规则（模板内嵌）；重大隐患 -> agent 固定行 [WHALE-RISK]，
//            面板轮询会话消息快照（ConversationSnapshot.nodes / .partial）识别并弹红色警示条。
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
			".wh-open .wh-tab{display:none}",
			".wh-open .wh-card{display:flex}",
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
		function discussMessage(r, detail, riskText) {
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
			L.push("请先基于上述信息（如需更多证据可按源日志路径只读查阅）确认你已理解该问题的实际情况，再给出判断：问题是否仍存在／是否值得沉淀为经验／建议如何处置。");
			L.push("当前阶段约束：只读分析；不要执行任何写入或修改，不要调用会改动文件的工具；等用户指示后再按小本本流程入库或归档。");
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
			var open = false;
			var timer = null;
			var toastTimer = null;
			var toastEl = null;
			var riskFlags = {};   // id -> 一句话风险原因（警示条可见期间的「需人工」行标）
			var riskWatcher = null; // watchRisk 的 interval
			var alertEl = null;
			var alertTimer = null;

			var box = el("div", "wh-box");
			var tab = el("div", "wh-tab");
			tab.title = "鲸鱼决策箱：待审核候选（点击展开）";
			var tabIco = el("div", "wh-tab-ico", "🐳");
			var tabLabel = el("div", "wh-tab-label", "待审");
			var badge = el("div", "wh-badge", "0");
			tab.appendChild(tabIco);
			tab.appendChild(tabLabel);
			tab.appendChild(badge);
			box.appendChild(tab);

			var card = el("div", "wh-card");
			var head = el("div", "wh-head");
			var headTitle = el("div", "wh-head-title", "🐳 待审箱");
			var btnRefresh = el("button", "wh-icn", "⟳");
			btnRefresh.title = "刷新";
			var btnClose = el("button", "wh-icn", "✕");
			btnClose.title = "收起 (Esc)";
			head.appendChild(headTitle);
			head.appendChild(btnRefresh);
			head.appendChild(btnClose);
			card.appendChild(head);
			var list = el("div", "wh-list");
			card.appendChild(list);
			var foot = el("div", "wh-foot", "候选来自 inbox.md｜删除移入 archive");
			card.appendChild(foot);
			box.appendChild(card);
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
					list.appendChild(el("div", "wh-empty", "（暂无可审核候选）"));
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
						var acts = el("span", "wh-acts");
						var b1 = el("button", "wh-abtn", "⚡");
						b1.title = "自动处理：只读诊断；补全型小修可直接执行，重大隐患自动上报";
						var b2 = el("button", "wh-abtn", "💬");
						b2.title = "详细讨论：开新会话并携带该候选上下文与后台详情";
						var b3 = el("button", "wh-abtn wh-abtn-danger", "✕");
						b3.title = "删除：视为已解决/无需解决，移入归档（可恢复）";
						acts.appendChild(b1);
						acts.appendChild(b2);
						acts.appendChild(b3);
						meta.appendChild(acts);
						row.appendChild(meta);
						var text = el("div", "wh-text", r.text);
						text.title = "工作区 " + r.ws + "｜首次 " + r.time;
						row.appendChild(text);
						row.title = "自动处理⚡ / 讨论💬 / 删除✕";
						b1.addEventListener("click", function (ev) { ev.stopPropagation(); doAuto(r); });
						b2.addEventListener("click", function (ev) { ev.stopPropagation(); doDiscuss(r); });
						b3.addEventListener("click", function (ev) { ev.stopPropagation(); doDelete(r); });
						list.appendChild(row);
					})(rows[i]);
				}
			}

			function applyState() {
				if (pending <= 0) {
					box.style.display = "none";
					open = false;
					return;
				}
				box.style.display = "";
				badge.textContent = pending > 99 ? "99+" : String(pending);
				headTitle.textContent = "🐳 待审箱 · " + pending;
			}

			function refresh(silent) {
				return apiGet().then(function (j) {
					if (!j || j.ok !== true) throw new Error(j && j.error ? j.error : "响应异常");
					rows = j.rows || [];
					pending = j.pending || 0;
					applyState();
					if (open) renderRows();
				}, function (err) {
					// 宿主 API 未就绪（服务重启窗口等）：静默降级，绝不打扰用户任务
					if (!silent) console.warn("[whale-panel] 拉取 /whale/inbox 失败:", err && err.message ? err.message : err);
				});
			}

			function setOpen(v) {
				if (v === open) return;
				open = v;
				box.classList.toggle("wh-open", open);
				if (open) { refresh(true); }
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
				if (open) renderRows();
				toast("⚠ " + r.id + " 自动处理被阻止：存在重大隐患");
			}
			function hideRiskAlert() {
				riskFlags = {};
				if (alertEl) alertEl.classList.remove("wh-alert-on");
				if (open) renderRows();
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
				apiDetail(r.id).then(function (detail) {
					var msg = discussMessage(r, detail, null);
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
			tab.addEventListener("click", function () { setOpen(!open); });
			btnClose.addEventListener("click", function () { setOpen(false); });
			btnRefresh.addEventListener("click", function () { renderRows(); refresh(false); });
			function onDocDown(ev) {
				if (open && !box.contains(ev.target)) setOpen(false);
			}
			function onKey(ev) {
				if (ev.key === "Escape") setOpen(false);
			}
			function onFocus() { refresh(true); }
			function onVis() { if (!document.hidden) refresh(true); }
			document.addEventListener("pointerdown", onDocDown, true);
			window.addEventListener("keydown", onKey);
			window.addEventListener("focus", onFocus);
			document.addEventListener("visibilitychange", onVis);
			timer = setInterval(function () {
				if (!document.hidden) refresh(true);
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
		}
		//#endregion
		exports.apply = apply;
		return module.exports;
	}
});
