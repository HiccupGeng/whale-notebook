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
// v0.7.3（2026-09）：讨论落点路由 —— 💬 不再固定开在「当前会话的工作区」：
//   候选行「工作区」列含 ≥2 个工作区（跨项目） → 判为全局类，开在固定的「鲸鱼全局」工作区
//     （C:\DeepSeekHarnes\WhaleGlobal；首次使用时经 workspaces.createDirectory/create 惰性注册并命名）；
//   只出现在一个项目 → 开在该项目工作区（按 path 末段精确匹配，同名歧义不猜）；
//   工作区未知 / 未注册 / 同名歧义 → 回退当前工作区，并在 toast 里说明原因；
//   面板页脚常显三态开关「自动｜🐳 全局｜📁 项目」（选择记 localStorage）供手动覆盖；
//   落点与依据随每次 toast 报出，并写进新会话的开局消息（本会话工作区：… 路由依据：…）。
// v0.7.8（2026-09）：待审箱页两个新入口（需求：开关 + 一键历史深掘）——
//   ① 页脚「自动收集」开关（复用 .wh-seg 样式，两态：自动入箱｜仅暂存）：
//        状态**取自服务端** GET /whale/settings（不是 localStorage —— 它改的是真实采集行为）；
//        点击 POST /whale/settings {autoAdd:bool}，只写 settings.json（不碰 AGENTS.md），立即生效。
//   ② 页头 ⛏「历史深掘」：POST /whale/sweep -> {added,bumped,suppressed,echo,pending,scan,...}
//        宿主 = 阶段① --add（把已有暂存先入箱，防重建清空丢件）+ 阶段② --rebuild --add
//        （清空水位线/指纹/聚簇后从头梳理全部历史，直接入箱；已处置归档的不复活）；
//        运行中每 1.2s 轮询 GET /whale/live 取 scanJob 进度写到页脚状态行；结束后
//        另开一个会话（落点＝鲸鱼全局）让模型做「历史错误总结 / 同族合并建议 / 入库草案」，
//        开局消息由 sweepMessage() 生成（含扫描统计 + 待审清单 + 只读约束）。
//   GET  /whale/settings         -> {ok, autoAdd, autoCollect, liveCapture, scanMode}
//   POST /whale/settings         -> {ok, changed, autoAdd, pending, deferred}
//   POST /whale/sweep            -> {ok, dry, flush, added, bumped, ...}；{dry:true} = 只读预演
//   面板记忆（pin）：用户主动打开过面板后，即使待审为 0 也保留侧边入口 —— 否则「待审=0 且要切换
//     开关」时入口会消失，开关就够不着了。记在 localStorage['whale.panelPin']。
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
			".wh-icn:disabled{opacity:.3;cursor:default;background:transparent}",
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
			".wh-foot{flex:none;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));padding:5px 10px 6px;font-size:10px;color:var(--dsw-alias-label-tertiary,#8a90a0)}",
			".wh-route{display:flex;align-items:center;gap:5px;margin-bottom:3px}",
			".wh-route-label{flex:none;font-weight:700;opacity:.9}",
			".wh-seg{display:flex;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.14));border-radius:6px;overflow:hidden}",
			".wh-seg-btn{padding:1px 6px;border:none;background:transparent;color:inherit;cursor:pointer;font:600 10px/1.6 system-ui,-apple-system,'Segoe UI','Microsoft YaHei',sans-serif}",
			".wh-seg-btn+.wh-seg-btn{border-left:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08))}",
			".wh-seg-btn:hover{background:rgba(128,128,128,.16)}",
			".wh-seg-on{background:rgba(90,130,255,.22);color:var(--dsw-alias-label-primary,#24272d)}",
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
		// v0.7.3：返回"本次创建的 style 节点"（复用既有则返回 null）——谁创建谁回收：
		//   跨代复用的节点不能被后一代卸载时误删（否则会打断仍在运行的上一代面板）。
		function ensureCss() {
			if (typeof document === "undefined") return null;
			if (document.querySelector("style[data-plugin-css=\"" + CSS_ID + "\"]") !== null) return null;
			var tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-whale-notebook";
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
			return tag;
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
		// v0.7.8：运行状态（深掘进度用；失败返回 null，调用方保持上一行文字）
		function apiLive() {
			return fetch("/whale/live", { headers: { accept: "application/json" } })
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { return (j && j.ok === true) ? j : null; })
				.catch(function () { return null; });
		}
		// v0.7.8：读「自动收集」当前值（服务端为准）；损坏/失败返回 null（面板显示未知态，不假装）
		function apiSettings() {
			return fetch("/whale/settings", { headers: { accept: "application/json" } })
				.then(function (r) { return r.json().catch(function () { return null; }); })
				.then(function (j) { return (j && j.ok === true) ? j : null; })
				.catch(function () { return null; });
		}
		// v0.7.8：切换自动收集（POST /whale/settings）；失败抛错（调用方 toast 原文）
		function apiSetAutoAdd(v) {
			return fetch("/whale/settings", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ autoAdd: !!v })
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (j) {
					if (!r.ok || !j || j.ok !== true) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
					return j;
				});
			});
		}
		// v0.7.8：历史深掘（POST /whale/sweep）。dry=true 只读预演（不写盘）——面板不用，
		//   留给 curl 验收与自测；失败抛错（调用方 toast 原文，如「写入锁不可用」「扫描进行中」）。
		function apiSweep(dry) {
			return fetch("/whale/sweep", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(dry ? { dry: true } : {})
			}).then(function (r) {
				return r.json().catch(function () { return null; }).then(function (j) {
					if (!r.ok || !j || j.ok !== true) throw new Error(j && j.error ? j.error : "HTTP " + r.status);
					return j;
				});
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
		//#region panel actions（v0.7.8：自动收集开关 + 历史深掘）
		// 「自动收集」＝ settings.autoAdd：true=新发现直接进待审箱；false=只暂存（说「小本本复盘」才入箱）。
		// 两态展示（而不是一个滑动开关）：两种模式各自的名字比"开/关"更不容易误读。
		var SETTINGS_MODES = [
			{ key: "auto", text: "自动入箱", value: true, title: "自动收集：开启 —— 扫描与实时采集发现的问题直接写入待审箱（待审箱会自动出现新候选）；改的是 settings.json，立即生效、无需重启。" },
			{ key: "pull", text: "仅暂存", value: false, title: "自动收集：关闭 —— 只记进暂存区（state.deferred），待审箱不会自动增长；说「小本本复盘」或面板 ⟳ 后由 --add 冲入待审箱。" }
		];
		var PIN_KEY = "whale.panelPin";     // 面板记忆：主动打开过面板 → 待审为 0 也保留侧边入口
		var SWEEP_POLL_MS = 1200;           // 深掘期间轮询 /whale/live 的间隔
		var SWEEP_POLL_MAX = 150;           // 轮询次数上限（≈3 分钟），超时停轮询但请求照常等
		function readPin() {
			try { return window.localStorage.getItem(PIN_KEY) === "1"; } catch (e) { return false; }
		}
		function writePin(v) {
			try { window.localStorage.setItem(PIN_KEY, v ? "1" : "0"); } catch (e) { /* 隐私模式/无 storage：忽略 */ }
		}
		// 深掘完成后的页脚一行（人话 + 关键数字）
		function sweepSummaryText(j) {
			if (!j) return "";
			var mb = j.scan && j.scan.readBytes ? (j.scan.readBytes / 1048576).toFixed(2) + "MB" : "";
			var L = ["新开 " + (j.added || 0), "累加 " + (j.bumped || 0)];
			if (j.suppressed) L.push("压掉 " + j.suppressed);
			if (j.echo) L.push("回声过滤 " + j.echo + " 组");
			if (j.dropped) L.push("⚠ 超上限丢弃 " + j.dropped);
			if (mb) L.push(mb);
			L.push(((j.ms || 0) / 1000).toFixed(1) + "s");
			return "⛏ " + L.join("｜");
		}
		// 深掘开局消息（自动开启的新会话里那份"历史错误总结"任务书）。
		// 设计：数字与清单全部来自**宿主已经落盘的事实**（不靠模型回忆）；写入约束写在最后（最重要）。
		function sweepMessage(j, rows, route) {
			if (!j) return null;
			var s = j.scan || {};
			var L = [];
			L.push("【小本本·历史深掘】面板刚触发了一次「全量重扫历史」，结果**已由宿主直接写入待审箱**（不需要你再跑扫描）：");
			L.push("- 扫描：" + (s.files || 0) + " 个会话日志 / " + ((s.readBytes || 0) / 1048576).toFixed(2) + "MB / " + ((j.ms || 0) / 1000).toFixed(1) + "s（重建模式：水位线/指纹/聚簇清空后从头梳理全部历史）");
			L.push("- 结果：新开候选 " + (j.added || 0) + " 条｜累加已有候选 " + (j.bumped || 0) + " 条｜已处置签名压掉 " + (j.suppressed || 0) + " 条（归档/入库过的不复活）｜自引用回声过滤 " + (j.echo || 0) + " 组"
				+ (j.flush && j.flush.added ? "｜另有暂存冲入 " + j.flush.added + " 条" : ""));
			if (j.dropped) L.push("- ⚠ 有 " + j.dropped + " 组因单轮上限未入箱（已记指纹，不会再被扫到）——请在总结里明确告诉用户这一条。");
			L.push("- 待审箱现有 " + (j.pending || 0) + " 条候选。");
			if (route && route.label) L.push("- 本会话工作区：" + route.label + "（路由依据：" + route.reason + "）");
			var list = (rows || []).slice(0, 20);
			if (list.length) {
				L.push("");
				L.push("候选清单（最多列 20 条；现象列已打码）：");
				for (var i = 0; i < list.length; i++) {
					var r = list[i];
					L.push("  " + r.id + "｜" + r.cat + "｜×" + r.n + "｜" + (r.ws || "?") + "｜" + String(r.text || "").slice(0, 100));
				}
				if ((rows || []).length > list.length) L.push("  …另有 " + ((rows || []).length - list.length) + " 条（面板 ⟳ 可看全量）");
			}
			L.push("");
			L.push("请按技能 whale-notebook 的复盘流程完成这次「历史错误总结」：");
			L.push("① 读 `inbox.md` 全文；对需要更多证据的候选读对应的 `details/C###.md`（按需，别全读）；与 `entries/`、`INDEX.md` 比对做去重。");
			L.push("② 输出总览（类别｜次数｜受影响工作区｜首次~最近）与编号清单，每条两行：`C0xx｜现象：<一行>` / `拟对策：<一行祈使句>`。");
			L.push("③ 同族合并建议：指出哪些候选是同一根因、建议合并成一条经验（occurrences 取总和），哪些必须拆分——依据用「族×N」与 sidecar 里的「同族并入」段，不要凭感觉。");
			L.push("④ 每条给出拟 scope 建议（global / project + projects 列表）与理由。");
			L.push("⑤ **只读分析**：不要写 entries/、不要改 INDEX.md 与 AGENTS.md、不要改 inbox.md；等用户逐条确认后再按入库流程落盘。");
			L.push("固定约束：不要重复运行 `--rebuild`（本轮已完成）；如需补扫只跑 `mine.cjs --check`（增量、会跳过未更新的日志）。");
			return L.join("\n");
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
		function discussMessage(r, detail, riskText, related, route) {
			var c = contextLine(r);
			if (!c) return null;
			var L = [];
			L.push("【决策箱转入·详细讨论】这条候选从侧边面板转到本会话单独讨论：");
			L.push(c + detailBlock(detail));
			// v0.7.3：把「本会话落在哪个工作区、依据什么判的」写进开局消息，开局即知
			if (route && route.label) L.push("本会话工作区：" + route.label + "（路由依据：" + route.reason + "）");
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
		//#region discuss routing（v0.7.3：讨论落点）
		// 语义：全局类候选 → 固定「鲸鱼全局」工作区；项目级候选 → 该项目工作区；判不准 → 回退当前工作区。
		// 判定依据只能来自候选行第 4 列「工作区」（该聚簇出现过的工作区名，最多记 2 个）：出现逗号即 ≥2 个工作区。
		// scope 是入库审核时才定的语义，此处在点击瞬间只能用这个客观信号，故一律给手动覆盖开关兜底。
		var GLOBAL_WS = {
			parent: "C:\\DeepSeekHarnes",
			name: "WhaleGlobal",
			path: "C:\\DeepSeekHarnes\\WhaleGlobal",
			title: "鲸鱼全局"
		};
		var ROUTE_STORE_KEY = "whale.discussRoute";
		var ROUTE_MODES = [
			{ key: "auto", text: "自动", title: "自动分流：候选出现在 ≥2 个工作区 → 鲸鱼全局；只出现在一个项目 → 该项目工作区" },
			{ key: "global", text: "🐳 全局", title: "手动覆盖：本面板的讨论一律开到「鲸鱼全局」工作区" },
			{ key: "project", text: "📁 项目", title: "手动覆盖：一律开到候选所属的项目工作区（未知或不唯一时回退当前工作区）" }
		];
		function readRouteMode() {
			try {
				var v = window.localStorage.getItem(ROUTE_STORE_KEY);
				if (v === "auto" || v === "global" || v === "project") return v;
			} catch (e) { /* 隐私模式/无 storage：退回默认 */ }
			return "auto";
		}
		function writeRouteMode(v) {
			try { window.localStorage.setItem(ROUTE_STORE_KEY, v); } catch (e) { /* 忽略 */ }
		}
		// 路径末段（Windows / POSIX 分隔符都认）
		function baseName(p) {
			var s = String(p === undefined || p === null ? "" : p).replace(/[\\/]+$/, "");
			var i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
			return i >= 0 ? s.slice(i + 1) : s;
		}
		// 候选行「工作区」列 → 工作区名数组（空值与 "?" 表示未知，不算一个工作区）
		function wsNamesOf(cell) {
			var out = [];
			var parts = String(cell === undefined || cell === null ? "" : cell).split(/[,，、]/);
			for (var i = 0; i < parts.length; i++) {
				var s = parts[i].trim();
				if (s && s !== "?") out.push(s);
			}
			return out;
		}
		// 名字 → 侧栏工作区：0 个（没注册）或 ≥2 个（同名歧义）都返回 null —— 不猜
		function findWorkspace(items, name) {
			var want = String(name === undefined || name === null ? "" : name);
			if (!want) return null;
			var hits = [];
			for (var i = 0; i < items.length; i++) {
				var it = items[i];
				if (!it) continue;
				if (baseName(it.path) === want || it.title === want) hits.push(it);
			}
			return hits.length === 1 ? hits[0] : null;
		}
		function wsLabel(items, id) {
			for (var i = 0; i < items.length; i++) if (items[i] && items[i].workspaceId === id) return items[i].title || baseName(items[i].path);
			return null;
		}
		// 纯函数：候选行 + 工作区列表 + 模式("auto"|"global"|"project") → { kind:"global"|"project"|"current", reason }
		function planDiscuss(row, items, mode) {
			var names = wsNamesOf(row && row.ws);
			if (mode === "global") return { kind: "global", names: names, reason: "手动覆盖：全局" };
			if (mode === "project") {
				if (!names.length) return { kind: "current", names: names, reason: "手动覆盖：项目，但候选未记工作区" };
				var fh = findWorkspace(items, names[0]);
				if (fh) return { kind: "project", names: names, ws: fh, reason: "手动覆盖：项目 " + names[0] };
				return { kind: "current", names: names, reason: "手动覆盖：项目 " + names[0] + " 不在侧栏" };
			}
			if (names.length >= 2) return { kind: "global", names: names, reason: "出现在 " + names.length + " 个工作区（跨项目）" };
			if (!names.length) return { kind: "global", names: names, reason: "工作区未知，保守放全局" };
			var hit = findWorkspace(items, names[0]);
			if (hit) return { kind: "project", names: names, ws: hit, reason: "仅出现在 " + names[0] };
			return { kind: "current", names: names, reason: "侧栏无工作区 " + names[0] + "（或同名歧义）" };
		}
		//#endregion
		//#region panel
		function apply(ctx) {
			if (typeof document === "undefined") return;
			var cssNode = ensureCss(); // v0.7.3：本次创建的样式节点（卸载时由 disposer 回收）
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
			var discussMode = readRouteMode(); // v0.7.3：讨论落点 auto|global|project（localStorage 记忆）
			var globalWsId = null;             // v0.7.3：「鲸鱼全局」workspaceId 缓存（惰性注册后记住）
			var globalWsPromise = null;        // 并发合并：连点多条候选只准备一次
			var autoAddMode = null;            // v0.7.8：自动收集当前值（null＝还没读到/读失败，面板显示未知态）
			var settingsErr = null;            // v0.7.8：settings 读取失败原因（面板在开关上给出提示，不假装成功）
			var sweepBusy = false;             // v0.7.8：深掘进行中（按钮置灰 + 服务端 409 双保险）
			var sweepPoll = null;              // v0.7.8：深掘进度轮询 interval
			var sweepPollTicks = 0;
			var noteTimer = null;              // v0.7.8：状态行临时文案的回收定时器

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
			// v0.7.8：页头 ⛏「历史深掘」——全量重扫全部历史 → 抓所有历史错误 → 直接入待审箱 + 开会话做总结
			var btnSweep = el("button", "wh-icn", "⛏");
			btnSweep.title = "历史深掘：全量重扫全部会话历史 → 抓取所有历史错误 → 直接写入待审箱（已处置的不复活），并自动开一个总结会话（唯一花模型 token 的一步）";
			var btnRefresh = el("button", "wh-icn", "⟳");
			btnRefresh.title = "刷新";
			var btnClose = el("button", "wh-icn", "✕");
			btnClose.title = "收起 (Esc)";
			head.appendChild(headTitle);
			head.appendChild(btnSolved);
			head.appendChild(btnSweep);
			head.appendChild(btnRefresh);
			head.appendChild(btnClose);
			card.appendChild(head);
			var list = el("div", "wh-list");
			card.appendChild(list);
			var foot = el("div", "wh-foot");
			// v0.7.3：讨论落点三态开关（常显在页脚——状态一直看得见，误判一键纠正）
			var routeBar = el("div", "wh-route");
			routeBar.appendChild(el("span", "wh-route-label", "讨论落点"));
			var seg = el("div", "wh-seg");
			var routeBtns = [];
			for (var mi = 0; mi < ROUTE_MODES.length; mi++) {
				(function (m) {
					var b = el("button", "wh-seg-btn", m.text);
					b.title = m.title;
					b.addEventListener("click", function (ev) { ev.stopPropagation(); setDiscussMode(m.key); });
					routeBtns.push({ key: m.key, el: b });
					seg.appendChild(b);
				})(ROUTE_MODES[mi]);
			}
			routeBar.appendChild(seg);
			foot.appendChild(routeBar);
			// v0.7.8：自动收集开关（两态；状态以服务端 GET /whale/settings 为准）
			var collectBar = el("div", "wh-route");
			collectBar.appendChild(el("span", "wh-route-label", "自动收集"));
			var segC = el("div", "wh-seg");
			var collectBtns = [];
			for (var ci = 0; ci < SETTINGS_MODES.length; ci++) {
				(function (m) {
					var b = el("button", "wh-seg-btn", m.text);
					b.title = m.title;
					b.addEventListener("click", function (ev) { ev.stopPropagation(); setAutoAdd(m.value); });
					collectBtns.push({ key: m.key, el: b });
					segC.appendChild(b);
				})(SETTINGS_MODES[ci]);
			}
			collectBar.appendChild(segC);
			foot.appendChild(collectBar);
			// v0.7.8：状态行（默认是说明；深掘期间显示进度，完成后留 20s 结果再回默认）
			var noteEl = el("div", "wh-foot-note", "候选来自 inbox.md｜删除移入 archive");
			foot.appendChild(noteEl);
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

			// v0.7.3：讨论落点开关（三态：自动 / 强制🐳全局 / 强制📁项目）
			function paintRoute() {
				for (var i = 0; i < routeBtns.length; i++) {
					if (routeBtns[i].key === discussMode) routeBtns[i].el.classList.add("wh-seg-on");
					else routeBtns[i].el.classList.remove("wh-seg-on");
				}
			}
			function setDiscussMode(k) {
				discussMode = k;
				writeRouteMode(k);
				paintRoute();
				toast("讨论落点：" + (k === "auto" ? "自动分流" : k === "global" ? "强制 🐳 鲸鱼全局" : "强制 📁 项目工作区"));
			}
			paintRoute();

			// ---- v0.7.8：状态行（页脚第三行）----
			var NOTE_DEFAULT = "候选来自 inbox.md｜⛏ = 全量重扫历史入箱";
			function setNote(text, restoreMs) {
				if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
				noteEl.textContent = text || NOTE_DEFAULT;
				if (restoreMs) {
					noteTimer = setTimeout(function () {
						noteTimer = null;
						noteEl.textContent = NOTE_DEFAULT;
					}, restoreMs);
				}
			}

			// ---- v0.7.8：自动收集开关（settings.autoAdd；状态取自服务端）----
			function paintAutoAdd() {
				for (var i = 0; i < collectBtns.length; i++) {
					if (autoAddMode === null) collectBtns[i].el.classList.remove("wh-seg-on");
					else if (collectBtns[i].key === (autoAddMode ? "auto" : "pull")) collectBtns[i].el.classList.add("wh-seg-on");
					else collectBtns[i].el.classList.remove("wh-seg-on");
				}
				collectBar.title = autoAddMode === null
					? ("自动收集：读取中" + (settingsErr ? "（" + settingsErr + "）" : ""))
					: (autoAddMode ? "自动收集：已开启（新发现直接写入待审箱）" : "自动收集：已关闭（新发现只暂存，说「小本本复盘」才入箱）");
			}
			function refreshSettings(silent) {
				return apiSettings().then(function (j) {
					if (!j) {
						settingsErr = "端点不可用或 settings.json 读取失败";
						paintAutoAdd();
						if (!silent) toast("读取自动收集状态失败：宿主端点不可用或 settings.json 损坏");
						return null;
					}
					settingsErr = null;
					autoAddMode = j.autoAdd === true;
					paintAutoAdd();
					return j;
				});
			}
			function setAutoAdd(v) {
				if (autoAddMode !== null && autoAddMode === !!v) {
					toast(v ? "自动收集已是「自动入箱」" : "自动收集已是「仅暂存」");
					return;
				}
				apiSetAutoAdd(v).then(function (j) {
					autoAddMode = j.autoAdd === true;
					paintAutoAdd();
					if (j.changed === false) {
						toast("自动收集已是该模式（settings.json 未变）");
					} else {
						toast(v
							? "自动收集已开启：新发现直接进待审箱（立即生效，无需重启）"
							: "自动收集已关闭：新发现只暂存，说「小本本复盘」或点 ⟳ 入箱");
					}
					return refresh(true);
				}, function (err) {
					toast("切换失败：" + (err && err.message ? err.message : String(err)));
					refreshSettings(true);
				});
			}

			// ---- v0.7.8：历史深掘（⛏）----
			function stopSweepPoll() {
				if (sweepPoll) { clearInterval(sweepPoll); sweepPoll = null; }
				sweepPollTicks = 0;
			}
			function startSweepPoll() {
				stopSweepPoll();
				sweepPoll = setInterval(function () {
					sweepPollTicks++;
					if (sweepPollTicks > SWEEP_POLL_MAX) { stopSweepPoll(); return; }
					if (document.hidden) return; // 页面不可见时不打扰宿主
					apiLive().then(function (j) {
						if (!sweepBusy) return;
						var sj = j && j.scanJob;
						if (sj && sj.running) {
							setNote("⛏ 深掘中（" + (sj.phase === "rebuild" ? "全量重扫" : "冲入暂存") + "）：已扫 "
								+ (sj.scanned || 0) + "/" + (sj.files || 0) + " 个日志｜"
								+ ((sj.readBytes || 0) / 1048576).toFixed(1) + "MB…");
						}
					});
				}, SWEEP_POLL_MS);
			}
			function doSweep() {
				if (sweepBusy) return toast("深掘已在运行中…");
				if (!sessions) toast("提示：当前环境无会话服务，深掘仍会执行，但不会自动开总结会话");
				sweepBusy = true;
				btnSweep.disabled = true;
				btnSweep.textContent = "⛏…";
				setNote("⛏ 深掘中（全量重扫历史）：准备中…");
				startSweepPoll();
				apiSweep(false).then(function (j) {
					stopSweepPoll();
					var sum = sweepSummaryText(j);
					setNote(sum, 20000);
					toast(sum + "（待审箱现有 " + j.pending + " 条）");
					return refresh(true).then(function () { return j; });
				}, function (err) {
					stopSweepPoll();
					setNote("⛏ 深掘失败：" + (err && err.message ? err.message : String(err)), 20000);
					toast("深掘失败：" + (err && err.message ? err.message : String(err)));
					return null;
				}).then(function (j) {
					sweepBusy = false;
					btnSweep.disabled = false;
					btnSweep.textContent = "⛏";
					if (!j) return;
					openSweepSession(j);
				});
			}
			// 深掘完成后：开一个会话做「历史错误总结」。落点固定「鲸鱼全局」（历史深掘天生跨全部工作区，
			// 与既有「跨项目候选 → 鲸鱼全局」同源）；工作区不可用 → 回退当前工作区并在 toast 说明。
			// 无新发现且待审为空 → 不开（不白烧 token）。
			function openSweepSession(j) {
				var hasWork = (j.added || 0) + (j.bumped || 0) > 0 || (j.pending || 0) > 0;
				if (!hasWork) { toast("历史已是最新：无新发现、待审箱为空（未开总结会话）"); return; }
				if (!sessions) return;
				ensureGlobalWorkspace().then(function (wsId) {
					return { workspaceId: wsId, label: GLOBAL_WS.title, reason: "历史深掘跨全部工作区" };
				}, function () {
					var curWs = workspaceIdOf(sessions, workspaces, currentSessionId(sessions));
					return { workspaceId: curWs, label: (curWs !== undefined && curWs !== null ? wsLabel(wsItems(), curWs) : null) || "当前工作区", reason: "鲸鱼全局工作区不可用 → 回退当前工作区" };
				}).then(function (t) {
					var msg = sweepMessage(j, rows, t);
					if (!msg) return null;
					var opts = (t.workspaceId !== undefined && t.workspaceId !== null) ? { workspaceId: t.workspaceId } : {};
					return sessions.create(opts).then(function (newId) {
						return waitBinding(sessions, newId, 5000).then(function (bind) {
							if (bind) {
								try {
									return bind.session.prompt([{ type: "text", text: msg }], "queue").then(function () { return newId; }, function () { return newId; });
								} catch (e) { return newId; }
							}
							return newId;
						});
					}, function (err) {
						toast("总结会话新建失败：" + (err && err.message ? err.message : String(err)) + "（深掘结果已在待审箱）");
						return null;
					}).then(function (newId) {
						if (!newId) return;
						sessions.open(newId);
						toast("已开总结会话 → " + t.label + "（" + t.reason + "）");
					});
				}, function (err) {
					toast("开会话失败：" + (err && err.message ? err.message : String(err)) + "（深掘结果已在待审箱）");
				});
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
						b2.title = "详细讨论：开新会话并携带该候选上下文与后台详情（落点由页脚「讨论落点」开关决定）";
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
			// v0.7.8：新增「面板记忆」pin —— 用户主动打开过面板后，即使待审=0 也保留侧边入口。
			//   为什么必须加：页脚「自动收集」开关与页头 ⛏ 都在这张卡上，而"待审=0 且要切换的模式正是
			//   自动入箱"恰好会让整块面板消失（正是最需要开关的时候）。pin 只由用户的主动点击置位，
			//   所以对"从没开过面板"的人依旧是原来那套不打扰行为。
			function applyState() {
				var showA = pending > 0 || deferred > 0 || readPin();   // v0.6：有暂存也保留入口；v0.7.8：+ pin
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
					// v0.7.8：pin 生效且计数为 0 时不要挂一个红色「0」徽标（有 pin 没内容也是正常态）
					badge.style.display = badgeN > 0 ? "" : "none";
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
				if (mode !== null) {
					// v0.7.8：用户主动展开面板 → 记住这个入口（pin），并顺手对齐一次开关状态
					if (!readPin()) writePin(true);
					refreshSettings(true);
				}
				if (open === mode) {
					open = null;
					box.classList.remove("wh-open-inbox", "wh-open-solved");
					return;
				}
				open = mode;
				box.classList.remove("wh-open-inbox", "wh-open-solved");
				// v0.7.3 修复：mode=null（收起/外点/Esc）时旧写法走 else → 又补回 wh-open-inbox，
				// 于是 open=null 而待审卡仍可见（分裂态）：refresh 的 open==="inbox" 门禁永不成立
				// → 行列表静默冻结（删除照常成功、toast 照常弹、标题照常刷新，只有行不动）。
				if (mode !== null) box.classList.add(mode === "solved" ? "wh-open-solved" : "wh-open-inbox");
				if (mode === "inbox") {
					refresh(true);
					renderRows();
				} else if (mode === "solved") {
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
					// v0.7.3 加固：重绘判据以「卡片可见」兜底——只要待审卡在屏幕上，就必须跟着数据重绘；
					// 任何 open 与类名分裂的路径都会在一个刷新周期（30s/焦点/删除后）内自愈。
					if (open === "inbox" || box.classList.contains("wh-open-inbox")) renderRows();
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
					if (open === "solved" || box.classList.contains("wh-open-solved")) renderSolved();
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
			// v0.7.3：先定落点、再建会话；消息由 buildMsg(route) 现场构造（好把落点与依据写进开局消息）
			function wsItems() {
				try { return (workspaces && workspaces.list.getSnapshot().items) || []; } catch (e) { return []; }
			}
			// 「鲸鱼全局」工作区：首次使用时惰性准备（建目录 → 注册 → 命名），成功后缓存；
			// 失败不缓存（下次可重试），且**不**静默落到项目工作区 —— 由调用方报错中止。
			function ensureGlobalWorkspace() {
				if (globalWsId) return Promise.resolve(globalWsId);
				if (globalWsPromise) return globalWsPromise;
				if (!workspaces) return Promise.reject(new Error("当前环境无工作区服务"));
				globalWsPromise = Promise.resolve()
					.then(function () {
						var hit = findWorkspace(wsItems(), GLOBAL_WS.name) || findWorkspace(wsItems(), GLOBAL_WS.title);
						if (hit) return hit.workspaceId;
						return Promise.resolve()
							.then(function () { return workspaces.createDirectory(GLOBAL_WS.parent, GLOBAL_WS.name); })
							.catch(function () { return null; })   // 目录已存在即走到这里
							.then(function () { return workspaces.create({ path: GLOBAL_WS.path }); })
							.then(function (view) {
								return Promise.resolve()
									.then(function () { return workspaces.rename(view.workspaceId, GLOBAL_WS.title); })
									.then(function () { return view.workspaceId; }, function () { return view.workspaceId; });
							});
					})
					.then(function (id) {
						if (!id) throw new Error("工作区 id 解析为空");
						globalWsId = id;
						return id;
					}, function (err) {
						globalWsPromise = null;
						throw err;
					});
				return globalWsPromise;
			}
			function resolveDiscussTarget(r, mode, retried) {
				var plan = planDiscuss(r, wsItems(), mode);
				// 工作区基线还没到（刚刷新页面就点 💬）时先拉一次再判，避免把「还没加载」误判成「未注册」而回退；只重试一次
				if (!retried && plan.kind === "current" && wsItems().length === 0 && workspaces && typeof workspaces.refresh === "function") {
					return Promise.resolve(workspaces.refresh()).then(
						function () { return resolveDiscussTarget(r, mode, true); },
						function () { return resolveDiscussTarget(r, mode, true); }
					);
				}
				if (plan.kind === "global") {
					return ensureGlobalWorkspace().then(function (id) {
						return { workspaceId: id, label: GLOBAL_WS.title, reason: plan.reason };
					});
				}
				if (plan.kind === "project" && plan.ws) {
					return Promise.resolve({
						workspaceId: plan.ws.workspaceId,
						label: plan.ws.title || baseName(plan.ws.path),
						reason: plan.reason
					});
				}
				var curWs = workspaceIdOf(sessions, workspaces, currentSessionId(sessions));
				return Promise.resolve({
					workspaceId: curWs,
					label: (curWs !== undefined && curWs !== null ? wsLabel(wsItems(), curWs) : null) || "当前工作区",
					reason: plan.reason + " → 回退当前工作区"
				});
			}
			function openDiscussion(r, buildMsg, mode) {
				if (!sessions) return toast("当前环境无会话服务，无法开新会话");
				resolveDiscussTarget(r, mode || "auto").then(function (t) {
					var msg = buildMsg(t);
					if (!msg) return toast("候选数据缺失，无法构造消息");
					var opts = (t.workspaceId !== undefined && t.workspaceId !== null) ? { workspaceId: t.workspaceId } : {};
					return sessions.create(opts).then(function (newId) {
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
						toast("已开讨论会话：" + r.id + " → " + t.label + "（" + t.reason + "）");
					});
				}, function (err) {
					toast("鲸鱼全局工作区不可用：" + (err && err.message ? err.message : String(err)) + "（未开会话）");
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
							// v0.7.3：与 💬 共用同一套落点路由（自动/强制全局/强制项目）
							openDiscussion(r, function (t) { return discussMessage(r, detail, fullText || reason, null, t); }, discussMode);
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
				// v0.7.3：落点由页脚三态开关决定（自动 / 强制🐳全局 / 强制📁项目）
				Promise.all([apiDetail(r.id), apiRelated(r.id)]).then(function (res) {
					openDiscussion(r, function (t) { return discussMessage(r, res[0], null, res[1], t); }, discussMode);
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
			// v0.7.8：⛏ 历史深掘（全量重扫历史 → 入待审箱 + 开总结会话）
			btnSweep.addEventListener("click", function () { doSweep(); });
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
					stopSweepPoll();                      // v0.7.8：深掘进度轮询
					if (noteTimer) { clearTimeout(noteTimer); noteTimer = null; }
					document.removeEventListener("pointerdown", onDocDown, true);
					window.removeEventListener("keydown", onKey);
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onVis);
					if (toastTimer) clearTimeout(toastTimer);
					if (alertTimer) clearTimeout(alertTimer);
					if (box && box.parentNode) box.parentNode.removeChild(box);
					if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);
					if (alertEl && alertEl.parentNode) alertEl.parentNode.removeChild(alertEl);
					// v0.7.3：只回收本次创建的样式节点（复用既有时 cssNode 为 null，不动别人的节点）
					if (cssNode && cssNode.parentNode) cssNode.parentNode.removeChild(cssNode);
				};
			}, "whale-panel: lifecycle");

			applyState();
			paintAutoAdd();      // v0.7.8：先画「未知态」，再等 refreshSettings 落到真实值
			refresh(true);
			refreshSolved(true);
			refreshSettings(true);
		}
		//#endregion
		exports.apply = apply;
		// v0.7.3：把讨论路由的纯函数暴露给自测（bundle 不能 require，这是唯一可测缝隙）
		// v0.7.8：并入面板两个新入口的纯函数（开关两态表 / 深掘消息与结果行 / pin 读写）
		exports.__internals = {
			GLOBAL_WS: GLOBAL_WS,
			ROUTE_MODES: ROUTE_MODES,
			ROUTE_STORE_KEY: ROUTE_STORE_KEY,
			baseName: baseName,
			wsNamesOf: wsNamesOf,
			findWorkspace: findWorkspace,
			wsLabel: wsLabel,
			planDiscuss: planDiscuss,
			readRouteMode: readRouteMode,
			writeRouteMode: writeRouteMode,
			SETTINGS_MODES: SETTINGS_MODES,
			PIN_KEY: PIN_KEY,
			SWEEP_POLL_MS: SWEEP_POLL_MS,
			SWEEP_POLL_MAX: SWEEP_POLL_MAX,
			readPin: readPin,
			writePin: writePin,
			sweepSummaryText: sweepSummaryText,
			sweepMessage: sweepMessage
		};
		return module.exports;
	}
});
