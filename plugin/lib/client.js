// lib/client.js - dsh-whale-notebook 浏览器半边：鲸鱼决策箱悬浮侧边面板
// 手写 __ModuleLoader__ bundle（与官方 client 产物同格式；零 require 依赖，纯 DOM + CSS）。
// 数据/动作通道：
//   GET  /whale/inbox            -> {pending, rows}                 （host half 注册）
//   POST /whale/inbox/delete     -> 删除（移入 archive，可恢复）
//   ctx.sessions / ctx.workspaces（官方 client-runtime 服务）-> 自动处理(投递当前会话)/详细讨论(新会话)
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
			".wh-n{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-acts{margin-left:auto;flex:none;display:flex;gap:1px;opacity:.35}",
			".wh-row:hover .wh-acts{opacity:1}",
			".wh-abtn{width:20px;height:20px;padding:0;border:none;border-radius:6px;background:transparent;cursor:pointer;font-size:11px;line-height:20px;color:inherit;text-align:center}",
			".wh-abtn:hover{background:rgba(128,128,128,.2)}",
			".wh-abtn-danger:hover{background:rgba(229,72,77,.22);color:#c93a3f}",
			".wh-text{margin-top:2px;color:var(--dsw-alias-label-secondary,#565b66);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-all}",
			".wh-empty{padding:18px 8px;text-align:center;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-foot{flex:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));padding:4px 10px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-toast{position:fixed;right:14px;bottom:14px;z-index:2147482100;max-width:320px;padding:7px 12px;border-radius:8px;font:12px/1.4 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#fff;background:rgba(28,32,38,.94);box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transform:translateY(6px);transition:opacity .18s,transform .18s;pointer-events:none}",
			".wh-toast-on{opacity:1;transform:none}"
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
		//#endregion
		//#region text builders（候选信息全部来自 inbox 已打码行，不引入新原文）
		function rowById(rows, id) {
			for (var i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i];
			return null;
		}
		function contextLine(r) {
			if (!r) return null;
			return "候选 " + r.id + "｜类别 " + r.cat + "｜出现 " + r.n + " 次｜工作区 " + r.ws + "｜首次出现 " + r.time + "｜现象：" + r.text;
		}
		function autoMessage(r) {
			var c = contextLine(r);
			if (!c) return null;
			return "【决策箱自动处理】用户已通过侧边面板授权自动处理 " + c + "。请按小本本技能流程处理：评估该问题并提炼为经验候选；先展示写入计划（拟新增 entries 文件内容 + AGENTS.md 自动段变更行），等待用户确认后再落盘；若判断已解决或与既有条目重复，建议改走归档。无需再询问「是否处理」。";
		}
		function discussMessage(r) {
			var c = contextLine(r);
			if (!c) return null;
			return "【决策箱转入·详细讨论】这条候选从侧边面板转到本会话单独讨论：" + c + "。请先确认你已理解该问题的实际情况（如需查证原始证据：只读、打码、不落库），然后给出你的判断：问题是否仍存在／是否值得沉淀为经验／建议如何处置。当前阶段不要执行任何写入或修改，也不要调用会改动文件的工具；等用户指示后再按小本本流程入库或归档。";
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
						meta.appendChild(el("span", "wh-cat", r.cat));
						meta.appendChild(el("span", "wh-n", "×" + r.n));
						var acts = el("span", "wh-acts");
						var b1 = el("button", "wh-abtn", "⚡");
						b1.title = "自动处理：告诉当前会话 AI 该候选简单、直接处理";
						var b2 = el("button", "wh-abtn", "💬");
						b2.title = "详细讨论：开新会话并携带该候选上下文";
						var b3 = el("button", "wh-abtn wh-abtn-danger", "🗑");
						b3.title = "删除：视为已解决/无需解决，移入归档（可恢复）";
						acts.appendChild(b1);
						acts.appendChild(b2);
						acts.appendChild(b3);
						meta.appendChild(acts);
						row.appendChild(meta);
						var text = el("div", "wh-text", r.text);
						text.title = "工作区 " + r.ws + "｜首次 " + r.time;
						row.appendChild(text);
						row.title = "自动处理⚡ / 讨论💬 / 删除🗑";
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
				if (!silent && open) {
					/* 展开态手动刷新时旋转图标略过：直接拉取 */
				}
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

			function doAuto(r) {
				if (!sessions) return toast("当前环境无会话服务，自动处理不可用");
				var cur;
				try { cur = sessions.list.getSnapshot().current; } catch (e) { cur = undefined; }
				if (!cur) return toast("请先打开一个会话（自动处理投递到当前会话）");
				var msg = autoMessage(r);
				if (!msg) return toast("候选数据缺失，无法构造消息");
				waitBinding(sessions, cur, 4000).then(function (bind) {
					if (!bind) return toast("会话服务尚未就绪，请稍后重试");
					try {
						bind.session.prompt([{ type: "text", text: msg }], "queue").then(function (res) {
							if (res && res.ok) toast("已交给当前会话自动处理 " + r.id);
							else toast("投递失败：" + ((res && res.error && (res.error.message || res.error.code)) || "未知错误"));
						}, function (err) {
							toast("投递失败：" + (err && err.message ? err.message : String(err)));
						});
					} catch (err) {
						toast("投递失败：" + (err && err.message ? err.message : String(err)));
					}
				});
			}

			function doDiscuss(r) {
				if (!sessions) return toast("当前环境无会话服务，无法开新会话");
				var msg = discussMessage(r);
				if (!msg) return toast("候选数据缺失，无法构造消息");
				var cur;
				try { cur = sessions.list.getSnapshot().current; } catch (e) { cur = undefined; }
				var workspaceId;
				try {
					var items = workspaces ? workspaces.list.getSnapshot().items : [];
					for (var i = 0; i < items.length; i++) {
						if (items[i] && items[i].sessionIds && items[i].sessionIds.indexOf(cur) !== -1) {
							workspaceId = items[i].workspaceId;
							break;
						}
					}
				} catch (e) { workspaceId = undefined; }
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

			function doDelete(r) {
				apiDelete(r.id).then(function () {
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
					document.removeEventListener("pointerdown", onDocDown, true);
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVis);
					if (toastTimer) clearTimeout(toastTimer);
					if (box && box.parentNode) box.parentNode.removeChild(box);
					if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
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
