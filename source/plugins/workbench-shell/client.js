window.__ModuleLoader__.load({
	id: "betterCodex-workbench-shell",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		const React = require("react");
		const h = React.createElement;
		const workbenchCache = window.__BETTER_CODEX_WORKBENCH_PREFETCH__ instanceof Map ? window.__BETTER_CODEX_WORKBENCH_PREFETCH__ : new Map();
		window.__BETTER_CODEX_WORKBENCH_PREFETCH__ = workbenchCache;
		window.__betterCodexWorkbenchInvalidate = (url) => workbenchCache.delete(url);
		window.__betterCodexWorkbenchFetchJson = (url, options = {}) => {
			if (options.force) workbenchCache.delete(url);
			if (workbenchCache.has(url)) return workbenchCache.get(url);
			const request = fetch(url, { method: "GET", cache: options.force ? "no-store" : "default", headers: { accept: "application/json" } }).then(async (response) => {
				const value = await response.json().catch(() => null);
				if (!response.ok) throw new Error(value?.reason || `HTTP ${response.status}`);
				return value;
			}).catch((error) => {
				workbenchCache.delete(url);
				throw error;
			});
			workbenchCache.set(url, request);
			return request;
		};

		function schedulePrefetch() {
			const run = () => ["/api/betterCodex-workbench/cockpit", "/api/betterCodex-workbench/modules/portfolio", "/api/betterCodex-workbench/modules/quant", "/api/betterCodex-workbench/modules/agenda", "/api/betterCodex-workbench/chatgpt/snapshot"].forEach((url) => void window.__betterCodexWorkbenchFetchJson(url).catch(() => {}));
			if (typeof window.requestIdleCallback === "function") {
				const id = window.requestIdleCallback(run, { timeout: 1800 });
				return () => window.cancelIdleCallback?.(id);
			}
			const id = window.setTimeout(run, 700);
			return () => window.clearTimeout(id);
		}

		const CSS = `
.betterCodex-domain-stack{--domain-accent:#c27a19;--domain-safe:#1f7a5a;--domain-danger:#b6403a;display:flex;flex:1;min-width:0;flex-direction:column;gap:4px;padding:2px 0;font-family:"IBM Plex Sans SC","Noto Sans SC",sans-serif}
.betterCodex-domain-entry{width:100%;min-height:36px;display:flex;align-items:center;gap:10px;padding:0 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#59616b);cursor:pointer;text-align:left}.betterCodex-domain-entry:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,140,155,.09));color:var(--dsw-alias-label-primary,#22262b)}.betterCodex-domain-entry[data-active=true]{border-color:color-mix(in srgb,var(--domain-accent) 42%,transparent);background:color-mix(in srgb,var(--domain-accent) 10%,transparent);color:var(--domain-accent)}.betterCodex-domain-entry:focus-visible,.betterCodex-domain-button:focus-visible{outline:2px solid var(--domain-accent);outline-offset:2px}.betterCodex-domain-stack[data-wide=false] .betterCodex-domain-entry{width:36px;justify-content:center;padding:0}.betterCodex-domain-entry-icon{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;flex:none;border-radius:6px;background:var(--dsw-alias-interactive-bg-base,rgba(127,140,155,.07));font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:10px;font-weight:700}.betterCodex-domain-entry-label{overflow:hidden;font-size:13px;font-weight:560;text-overflow:ellipsis;white-space:nowrap}
.betterCodex-domain-surface{--domain-accent:#c27a19;--domain-safe:#1f7a5a;--domain-danger:#b6403a;--domain-ink:#17211d;--domain-paper:#f4f1e8;--betterCodex-safe-top:env(safe-area-inset-top,0px);--betterCodex-safe-right:env(safe-area-inset-right,0px);--betterCodex-safe-bottom:env(safe-area-inset-bottom,0px);--betterCodex-safe-left:env(safe-area-inset-left,0px);position:relative;display:flex;flex:1;min-width:0;min-height:0;height:100%;overflow:hidden;color:var(--domain-ink);background:var(--domain-paper);font-family:"IBM Plex Sans SC","Noto Sans SC",sans-serif;overscroll-behavior:none}.betterCodex-domain-surface *{box-sizing:border-box}.betterCodex-domain-surface button,.betterCodex-domain-surface input,.betterCodex-domain-surface select,.betterCodex-domain-surface textarea{font:inherit}.betterCodex-domain-scroll{min-width:0;min-height:0;flex:1;overflow:auto;padding:22px 26px 32px;overscroll-behavior:contain;scroll-padding-block:20px 96px;-webkit-overflow-scrolling:touch}.betterCodex-domain-page{width:min(100%,1280px);margin:0 auto}.betterCodex-domain-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;margin-bottom:18px}.betterCodex-domain-kicker{color:#6d746e;font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10px;line-height:1.35;letter-spacing:.14em;text-transform:uppercase}.betterCodex-domain-head h1{margin:4px 0 0;font-size:25px;line-height:1.2;letter-spacing:-.025em}.betterCodex-domain-head p{max-width:700px;margin:7px 0 0;color:#59645e;font-size:12px;line-height:1.6}.betterCodex-domain-actions{display:flex;align-items:center;gap:8px;flex:none}.betterCodex-domain-button{min-height:32px;display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:0 10px;border:1px solid rgba(23,33,29,.24);border-radius:7px;background:#fffdf7;color:var(--domain-ink);cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}.betterCodex-domain-button:hover{border-color:var(--domain-accent);background:#fff8e9}.betterCodex-domain-button[data-kind=primary]{border-color:var(--domain-ink);color:#f4f1e8;background:var(--domain-ink)}.betterCodex-domain-button:disabled{cursor:not-allowed;opacity:.5}
.betterCodex-domain-grid{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));gap:11px}.betterCodex-domain-span-3{grid-column:span 3}.betterCodex-domain-span-4{grid-column:span 4}.betterCodex-domain-span-5{grid-column:span 5}.betterCodex-domain-span-6{grid-column:span 6}.betterCodex-domain-span-7{grid-column:span 7}.betterCodex-domain-span-8{grid-column:span 8}.betterCodex-domain-span-12{grid-column:span 12}.betterCodex-domain-panel{min-width:0;padding:15px;border:1px solid rgba(23,33,29,.16);border-radius:8px;background:#fffdf7}.betterCodex-domain-panel[data-tone=warm]{border-color:rgba(194,122,25,.42);background:#fff8e9}.betterCodex-domain-panel[data-tone=safe]{border-color:rgba(31,122,90,.38);background:#f2faf5}.betterCodex-domain-panel-head{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:11px}.betterCodex-domain-panel-head h2{margin:0;font-size:13px}.betterCodex-domain-panel-head small{color:#6d746e;font-size:10px}.betterCodex-domain-metric-label{color:#6d746e;font-size:10px}.betterCodex-domain-metric-value{margin-top:7px;overflow:hidden;font-size:21px;font-weight:680;letter-spacing:-.025em;text-overflow:ellipsis;white-space:nowrap}.betterCodex-domain-metric-value[data-tone=positive],*[data-tone=positive],.betterCodex-domain-positive{color:var(--domain-safe)}.betterCodex-domain-metric-value[data-tone=negative],*[data-tone=negative],.betterCodex-domain-negative{color:var(--domain-danger)}.betterCodex-domain-caption{margin-top:5px;color:#6d746e;font-size:10px;line-height:1.5}.betterCodex-domain-status{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;color:#59645e;font-size:10px}.betterCodex-domain-dot{width:7px;height:7px;border-radius:50%;background:var(--domain-danger)}.betterCodex-domain-dot[data-status=ok]{background:var(--domain-safe)}.betterCodex-domain-dot[data-status=stale],.betterCodex-domain-dot[data-status=partial],.betterCodex-domain-dot[data-status=loading]{background:var(--domain-accent)}.betterCodex-domain-list{display:flex;flex-direction:column}.betterCodex-domain-row{display:flex;align-items:flex-start;justify-content:space-between;gap:14px;padding:9px 0;border-top:1px solid rgba(23,33,29,.12);font-size:12px;line-height:1.45}.betterCodex-domain-row:first-child{border-top:0}.betterCodex-domain-row-label{color:#59645e}.betterCodex-domain-row-value{text-align:right;font-weight:560;overflow-wrap:anywhere}.betterCodex-domain-chip{display:inline-flex;align-items:center;min-height:22px;padding:0 7px;border:1px solid rgba(23,33,29,.16);border-radius:999px;color:#59645e;font-size:9px}.betterCodex-domain-table-wrap{overflow:auto}.betterCodex-domain-table{width:100%;border-collapse:collapse;font-size:11px}.betterCodex-domain-table th,.betterCodex-domain-table td{padding:9px 7px;border-top:1px solid rgba(23,33,29,.12);text-align:left;vertical-align:top}.betterCodex-domain-table th{border-top:0;color:#6d746e;font-size:9px;font-weight:520;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}.betterCodex-domain-table td{white-space:nowrap}.betterCodex-domain-empty{display:flex;min-height:260px;flex-direction:column;align-items:flex-start;justify-content:center;padding:24px;border:1px dashed rgba(23,33,29,.24);border-radius:8px;color:#59645e}.betterCodex-domain-empty strong{color:var(--domain-ink);font-size:14px}.betterCodex-domain-empty p{max-width:560px;margin:7px 0 15px;font-size:12px;line-height:1.55}.betterCodex-domain-boundary{padding:10px 11px;border:1px solid rgba(194,122,25,.34);border-radius:7px;background:#fff8e9;color:#8e570e;font-size:11px;line-height:1.55}.betterCodex-mono{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.betterCodex-quant-env-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:11px;margin-bottom:11px}.betterCodex-quant-env{min-width:0;padding:14px;border:1px solid rgba(23,33,29,.2);border-top:4px solid #6d746e;border-radius:7px;background:#fffdf7}.betterCodex-quant-env[data-env=demo]{border-top-color:var(--domain-safe)}.betterCodex-quant-env[data-env=real]{border-top-color:var(--domain-accent)}.betterCodex-quant-env-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.betterCodex-quant-env-head strong{display:block;margin-top:4px;font-size:13px}.betterCodex-quant-env-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:15px}.betterCodex-quant-env-metrics small{display:block;color:#6d746e;font-size:9px}.betterCodex-quant-env-metrics b{display:block;margin-top:4px;overflow:hidden;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.betterCodex-quant-strategy h2{margin-top:4px}.betterCodex-signal-score{display:flex;align-items:baseline;gap:8px}.betterCodex-signal-score strong{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:32px}.betterCodex-signal-score span{color:#6d746e;font-size:10px}.betterCodex-signal-track{height:8px;margin:10px 0 13px;overflow:hidden;border:1px solid rgba(23,33,29,.15);background:#eee9dc}.betterCodex-signal-track span{display:block;height:100%;background:var(--domain-accent)}.betterCodex-quant-position{margin:8px 0;padding:11px;border:1px solid rgba(23,33,29,.13);background:#f8f5ec}.betterCodex-quant-position>div:first-child{display:flex;align-items:center;justify-content:space-between}.betterCodex-quant-position-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;margin-top:9px;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px}
	.betterCodex-agenda-quick-add{display:grid;grid-template-columns:minmax(260px,1fr) 150px 120px 110px auto;align-items:end;gap:9px;margin-bottom:12px;padding:13px;border:1px solid rgba(23,33,29,.22);border-top:4px solid var(--domain-safe);border-radius:7px;background:#fffdf7}.betterCodex-agenda-quick-add label{display:flex;min-width:0;flex-direction:column;gap:5px;color:#6d746e;font-size:9px}.betterCodex-agenda-quick-add input,.betterCodex-agenda-quick-add select{width:100%;height:34px;padding:0 9px;border:1px solid rgba(23,33,29,.2);border-radius:5px;background:#fff;color:var(--domain-ink);font-size:12px}.betterCodex-agenda-quick-add input:focus,.betterCodex-agenda-quick-add select:focus{outline:2px solid rgba(31,122,90,.25);border-color:var(--domain-safe)}.betterCodex-agenda-layout>main,.betterCodex-agenda-agent{display:flex;flex-direction:column;gap:11px}.betterCodex-agenda-tasks{display:flex;flex-direction:column}.betterCodex-agenda-task{display:grid;grid-template-columns:26px minmax(0,1fr) auto;align-items:center;gap:9px;padding:11px 0;border-top:1px solid rgba(23,33,29,.12)}.betterCodex-agenda-task:first-child{border-top:0}.betterCodex-agenda-task[data-priority=high]{border-left:3px solid var(--domain-danger);padding-left:9px}.betterCodex-agenda-task[data-status=done] .betterCodex-agenda-task-copy strong{text-decoration:line-through;opacity:.55}.betterCodex-agenda-check{width:22px;height:22px;padding:0;border:1px solid rgba(23,33,29,.35);border-radius:50%;background:#fff;color:var(--domain-safe);cursor:pointer}.betterCodex-agenda-task[data-status=done] .betterCodex-agenda-check{border-color:var(--domain-safe);background:#e7f5ed}.betterCodex-agenda-task-actions{display:flex;gap:5px}.betterCodex-agenda-task-actions button{padding:3px 6px;border:0;background:transparent;color:#6d746e;cursor:pointer;font-size:9px}.betterCodex-agenda-task-actions button:hover{color:var(--domain-ink);text-decoration:underline}.betterCodex-agenda-project-action{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;padding:12px 0;border-top:1px solid rgba(23,33,29,.12)}.betterCodex-agenda-project-action:first-child{border-top:0}.betterCodex-agenda-index{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:18px;color:var(--domain-accent)}.betterCodex-agenda-project-action strong{font-size:12px}.betterCodex-agenda-project-action p{margin:5px 0 0;color:#59645e;font-size:10px;line-height:1.5}.betterCodex-agenda-inline-empty{padding:18px 0;color:#6d746e;font-size:11px}.betterCodex-agenda-advice{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px;padding:10px 0;border-top:1px solid rgba(23,33,29,.12)}.betterCodex-agenda-advice:first-child{border-top:0}.betterCodex-agenda-advice span{font-family:"IBM Plex Mono",ui-monospace,monospace;color:var(--domain-accent);font-size:10px}.betterCodex-agenda-advice p{margin:0;font-size:11px;line-height:1.55}.betterCodex-agenda-completed summary{cursor:pointer;font-size:12px;font-weight:650}
	.betterCodex-agenda-luna{display:flex;flex-direction:column;gap:11px;margin-bottom:12px;padding:16px;border:1px solid rgba(23,33,29,.22);border-top:4px solid var(--domain-safe);border-radius:7px;background:#fffdf7}.betterCodex-agenda-luna-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.betterCodex-agenda-luna-head strong{display:block;margin-top:4px;font-size:14px}.betterCodex-agenda-luna-lanes{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:6px}.betterCodex-agenda-luna-model{display:inline-flex;align-items:center;min-height:24px;padding:0 8px;border:1px solid rgba(31,122,90,.32);border-radius:999px;background:#f2faf5;color:var(--domain-safe);font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:9px;white-space:nowrap}.betterCodex-agenda-luna-model[data-lane=codex]{border-color:rgba(194,122,25,.38);background:#fff8e9;color:#8e570e}.betterCodex-agenda-luna-compose{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:stretch;gap:9px}.betterCodex-agenda-luna textarea{width:100%;min-height:58px;max-height:150px;padding:11px 12px;border:1px solid rgba(23,33,29,.22);border-radius:6px;resize:vertical;background:#fff;color:var(--domain-ink);font-size:12px;line-height:1.55}.betterCodex-agenda-luna textarea:focus{outline:2px solid rgba(31,122,90,.25);border-color:var(--domain-safe)}.betterCodex-agenda-luna-compose>.betterCodex-domain-button{min-width:132px}.betterCodex-agenda-luna-examples{color:#6d746e;font-size:10px;line-height:1.5}.betterCodex-agenda-luna-result{display:grid;grid-template-columns:24px minmax(0,1fr) auto;align-items:center;gap:9px;padding:10px 11px;border:1px solid rgba(31,122,90,.3);border-radius:6px;background:#f2faf5;color:#245d48}.betterCodex-agenda-luna-result[data-status=working],.betterCodex-agenda-luna-result[data-status=needs_input],.betterCodex-agenda-luna-result[data-status=needs_session_selection],.betterCodex-agenda-luna-result[data-status=answered],.betterCodex-agenda-luna-result[data-status=delegated]{border-color:rgba(194,122,25,.34);background:#fff8e9;color:#7c531a}.betterCodex-agenda-luna-result[data-status=completed]{border-color:rgba(31,122,90,.38);background:#f2faf5;color:#245d48}.betterCodex-agenda-luna-result[data-status=needs_confirmation]{border-color:rgba(182,64,58,.34);background:#fff4f1;color:#8f312c}.betterCodex-agenda-luna-result[data-status=error]{border-color:rgba(182,64,58,.45);background:#fff1ef;color:var(--domain-danger)}.betterCodex-agenda-luna-result-mark{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:50%;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px}.betterCodex-agenda-luna-result-copy{min-width:0}.betterCodex-agenda-luna-result p{margin:0;white-space:pre-wrap;font-size:11px;line-height:1.5}.betterCodex-agenda-luna-session{margin-top:5px;overflow:hidden;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:9px;opacity:.76;text-overflow:ellipsis;white-space:nowrap}.betterCodex-agenda-session-candidates{display:flex;flex-direction:column;gap:7px;margin-top:10px}.betterCodex-agenda-session-candidate{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;width:100%;padding:9px 10px;border:1px solid rgba(194,122,25,.3);border-radius:5px;background:#fffdf7;color:var(--domain-ink);cursor:pointer;text-align:left}.betterCodex-agenda-session-candidate:hover,.betterCodex-agenda-session-candidate:focus-visible{border-color:var(--domain-accent);background:#fff3da;outline:none}.betterCodex-agenda-session-candidate:disabled{cursor:not-allowed;opacity:.55}.betterCodex-agenda-session-candidate-title{overflow:hidden;font-size:11px;font-weight:650;text-overflow:ellipsis;white-space:nowrap}.betterCodex-agenda-session-candidate-meta{grid-column:1;color:#7c531a;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:9px}.betterCodex-agenda-session-candidate-action{grid-column:2;grid-row:1/span 2;align-self:center;color:#8e570e;font-size:10px;font-weight:650;white-space:nowrap}.betterCodex-agenda-luna-confirm{display:flex;gap:6px}.betterCodex-domain-button[data-kind=danger]{border-color:var(--domain-danger);background:var(--domain-danger);color:#fff}.betterCodex-domain-button[data-kind=danger]:hover{background:#92332e}
.betterCodex-agenda-luna-thread{display:flex;max-height:390px;min-height:92px;overflow:auto;flex-direction:column;gap:8px;padding:12px;border:1px solid rgba(23,33,29,.14);border-radius:7px;background:#f8f5ec}.betterCodex-agenda-luna-thread[data-empty=true]{align-items:center;justify-content:center}.betterCodex-agenda-luna-empty{max-width:660px;color:#6d746e;font-size:11px;line-height:1.6;text-align:center}.betterCodex-agenda-luna-message{max-width:min(88%,780px);padding:9px 11px;border:1px solid rgba(23,33,29,.14);border-radius:7px;background:#fffdf7}.betterCodex-agenda-luna-message[data-role=user]{align-self:flex-end;border-color:rgba(31,122,90,.3);background:#f2faf5}.betterCodex-agenda-luna-message[data-role=queued]{align-self:flex-end;border-style:dashed;border-color:rgba(194,122,25,.4);background:#fff8e9}.betterCodex-agenda-luna-message[data-role=error]{border-color:rgba(182,64,58,.38);background:#fff1ef;color:var(--domain-danger)}.betterCodex-agenda-luna-message-meta{margin-bottom:4px;color:#6d746e;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:8px}.betterCodex-agenda-luna-message p{margin:0;white-space:pre-wrap;font-size:11px;line-height:1.6}.betterCodex-agenda-luna-compose{grid-template-columns:minmax(0,1fr) 180px}.betterCodex-agenda-luna-controls{display:flex;flex-direction:column;gap:7px}.betterCodex-agenda-luna-controls label{display:flex;flex-direction:column;gap:4px;color:#6d746e;font-size:9px}.betterCodex-agenda-luna-controls select{width:100%;height:31px;padding:0 7px;border:1px solid rgba(23,33,29,.2);border-radius:5px;background:#fff;color:var(--domain-ink);font-size:10px}.betterCodex-agenda-luna-controls .betterCodex-domain-button{width:100%}
.betterCodex-agenda-luna-open,.betterCodex-agenda-luna-message-actions button,.betterCodex-agenda-luna-queue-editor button{padding:3px 7px;border:0;background:transparent;color:#6d746e;cursor:pointer;font-size:9px}.betterCodex-agenda-luna-open:hover,.betterCodex-agenda-luna-message-actions button:hover,.betterCodex-agenda-luna-queue-editor button:hover{color:var(--domain-ink);text-decoration:underline}.betterCodex-agenda-luna-message-actions{display:flex;align-items:center;justify-content:flex-end;gap:4px;margin-top:6px;color:#7c531a;font-size:9px}.betterCodex-agenda-luna-queue-editor{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:4px;margin-top:7px}.betterCodex-agenda-luna-queue-editor input{min-width:0;height:29px;padding:0 7px;border:1px solid rgba(23,33,29,.2);border-radius:4px;background:#fff;color:var(--domain-ink);font-size:10px}
.betterCodex-agenda-delegations{display:grid;gap:7px}.betterCodex-agenda-delegations-title{color:#6d746e;font-size:9px;font-weight:650;letter-spacing:.05em;text-transform:uppercase}.betterCodex-agenda-delegation{padding:9px 10px;border:1px solid rgba(194,122,25,.28);border-radius:6px;background:#fff8e9}.betterCodex-agenda-delegation[data-status=completed]{border-color:rgba(31,122,90,.32);background:#f2faf5}.betterCodex-agenda-delegation[data-status=failed],.betterCodex-agenda-delegation[data-verification=mismatch]{border-color:rgba(182,64,58,.38);background:#fff1ef}.betterCodex-agenda-delegation-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.betterCodex-agenda-delegation-head strong{font-size:11px}.betterCodex-agenda-delegation-head span{color:#7c531a;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:9px}.betterCodex-agenda-delegation p{margin:6px 0 0;white-space:pre-wrap;font-size:10px;line-height:1.5}.betterCodex-agenda-delegation-meta{margin-top:5px;color:#6d746e;font-size:9px;line-height:1.5}.betterCodex-agenda-delegation-status{margin-top:4px;font-size:9px;font-weight:650}
.betterCodex-luna-subtitle{max-width:560px!important;margin:4px 0 0!important;color:#59645e!important;font-size:10px!important;line-height:1.45!important}.betterCodex-luna-compose-shell{padding:11px;border:1px solid rgba(23,33,29,.18);border-radius:7px;background:#f8f5ec}.betterCodex-luna-compose-shell .betterCodex-agenda-luna-compose{grid-template-columns:minmax(0,1fr) 96px}.betterCodex-luna-compose-shell .betterCodex-domain-button{width:100%;min-width:0}.betterCodex-luna-settings{margin-top:7px;color:#6d746e;font-size:9px}.betterCodex-luna-settings summary{width:max-content;cursor:pointer}.betterCodex-luna-settings select{height:30px;margin-top:7px;padding:0 7px;border:1px solid rgba(23,33,29,.2);border-radius:5px;background:#fff;color:var(--domain-ink);font-size:10px}.betterCodex-luna-work-section{display:flex;flex-direction:column;gap:7px}.betterCodex-luna-work-section-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.betterCodex-luna-work-section-head strong{font-size:11px}.betterCodex-luna-work-section-head span{color:#6d746e;font-size:9px}.betterCodex-luna-work-list{display:flex;flex-direction:column;gap:7px}.betterCodex-luna-work-item{display:grid;grid-template-columns:25px minmax(0,1fr);gap:9px;padding:10px 11px;border:1px solid rgba(23,33,29,.15);border-radius:6px;background:#fffdf7}.betterCodex-luna-work-item[data-status=queued],.betterCodex-luna-work-item[data-status=accepted]{border-style:dashed;border-color:rgba(194,122,25,.38);background:#fff8e9}.betterCodex-luna-work-item[data-status=waiting_luna],.betterCodex-luna-work-item[data-status=luna_running],.betterCodex-luna-work-item[data-status=running],.betterCodex-luna-work-item[data-status=codex_running]{border-color:rgba(31,122,90,.34);background:#f2faf5}.betterCodex-luna-work-item[data-status=completed]{border-color:rgba(31,122,90,.28);background:#f7fbf8}.betterCodex-luna-work-item[data-status=needs_input]{border-color:rgba(194,122,25,.48);background:#fff4dc}.betterCodex-luna-work-item[data-status=failed],.betterCodex-luna-work-item[data-verification=mismatch]{border-color:rgba(182,64,58,.4);background:#fff1ef}.betterCodex-luna-work-mark{width:23px;height:23px;display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:50%;color:var(--domain-safe);font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:10px}.betterCodex-luna-work-item[data-status=queued] .betterCodex-luna-work-mark,.betterCodex-luna-work-item[data-status=accepted] .betterCodex-luna-work-mark,.betterCodex-luna-work-item[data-status=needs_input] .betterCodex-luna-work-mark{color:var(--domain-accent)}.betterCodex-luna-work-item[data-status=failed] .betterCodex-luna-work-mark{color:var(--domain-danger)}.betterCodex-luna-work-copy{min-width:0}.betterCodex-luna-work-copy>strong{display:block;overflow-wrap:anywhere;font-size:11px;line-height:1.5}.betterCodex-luna-work-meta{margin-top:3px;color:#6d746e;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:8px;line-height:1.45}.betterCodex-luna-work-copy>p,.betterCodex-luna-work-detail p{margin:7px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;color:#445049;font-size:10px;line-height:1.55}.betterCodex-luna-work-detail{margin-top:7px}.betterCodex-luna-work-detail summary{width:max-content;cursor:pointer;color:#6d746e;font-size:9px}.betterCodex-luna-work-facts{margin-top:6px;color:#6d746e;font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:8px;line-height:1.45}.betterCodex-luna-recent{padding-top:2px;border-top:1px solid rgba(23,33,29,.1)}.betterCodex-luna-recent>summary{padding:7px 0;cursor:pointer;color:#59645e;font-size:10px;font-weight:650}.betterCodex-luna-recent>.betterCodex-luna-work-list{padding-top:2px}.betterCodex-luna-idle{padding:18px;border:1px dashed rgba(23,33,29,.18);border-radius:6px;background:#f8f5ec;color:#6d746e;font-size:10px;line-height:1.55;text-align:center}
@media(max-width:900px){.betterCodex-agenda-quick-add{grid-template-columns:minmax(220px,1fr) 140px 110px}.betterCodex-agenda-quick-add .betterCodex-domain-button{grid-column:span 1}.betterCodex-quant-env-metrics{grid-template-columns:1fr}}
	@media(max-width:760px){.betterCodex-domain-scroll{padding:17px 12px 24px}.betterCodex-domain-head{margin-bottom:14px}.betterCodex-domain-head h1{font-size:21px}.betterCodex-domain-actions{gap:6px}.betterCodex-domain-button span[data-label]{display:none}.betterCodex-domain-span-3,.betterCodex-domain-span-4,.betterCodex-domain-span-5,.betterCodex-domain-span-6,.betterCodex-domain-span-7,.betterCodex-domain-span-8{grid-column:span 12}.betterCodex-domain-panel{padding:13px}.betterCodex-domain-table{font-size:10px}.betterCodex-quant-env-grid{grid-template-columns:1fr}.betterCodex-quant-env-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.betterCodex-agenda-quick-add{grid-template-columns:1fr 1fr}.betterCodex-agenda-title-field{grid-column:span 2}.betterCodex-agenda-quick-add .betterCodex-domain-button{grid-column:span 2}.betterCodex-agenda-luna-compose{grid-template-columns:1fr}.betterCodex-agenda-luna-compose>.betterCodex-domain-button{width:100%}.betterCodex-agenda-luna-result{grid-template-columns:24px minmax(0,1fr)}.betterCodex-agenda-luna-confirm{grid-column:2}.betterCodex-agenda-task{grid-template-columns:26px minmax(0,1fr)}.betterCodex-agenda-task-actions{grid-column:2}}
.betterCodex-foldable-dock{display:none}
@media(max-width:1023px){body:has(.betterCodex-domain-surface) [data-sidebar-collapsed]{grid-template-columns:minmax(0,1fr) 0 0!important}body:has(.betterCodex-domain-surface) [data-slot=sidebar]{display:none!important}.betterCodex-domain-surface{height:var(--betterCodex-visual-height,100dvh);max-height:100%;min-height:0}.betterCodex-domain-scroll{padding-top:max(14px,var(--betterCodex-safe-top));padding-right:max(12px,var(--betterCodex-safe-right));padding-bottom:calc(78px + var(--betterCodex-safe-bottom));padding-left:max(12px,var(--betterCodex-safe-left));scroll-padding-bottom:calc(92px + var(--betterCodex-safe-bottom) + var(--betterCodex-keyboard-inset,0px))}.betterCodex-foldable-dock{position:absolute;z-index:20;right:max(10px,var(--betterCodex-safe-right));bottom:max(8px,var(--betterCodex-safe-bottom));left:max(10px,var(--betterCodex-safe-left));display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;padding:6px;border:1px solid rgba(23,33,29,.18);border-radius:15px;background:color-mix(in srgb,#fffdf7 92%,transparent);box-shadow:0 10px 28px rgba(23,33,29,.18);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px)}.betterCodex-foldable-dock .betterCodex-domain-entry{width:100%;min-height:48px;justify-content:center;padding:0 8px;border-radius:10px}.betterCodex-foldable-dock .betterCodex-domain-entry-icon{width:24px;height:24px}.betterCodex-foldable-dock .betterCodex-domain-entry-label{display:block;font-size:11px}.betterCodex-domain-table-wrap{overscroll-behavior-inline:contain;scrollbar-width:thin;-webkit-overflow-scrolling:touch}}
@media(min-width:640px) and (max-width:1023px) and (min-aspect-ratio:4/5) and (max-aspect-ratio:5/4){.betterCodex-domain-scroll{padding-top:max(14px,var(--betterCodex-safe-top));padding-right:max(14px,var(--betterCodex-safe-right));padding-left:max(14px,var(--betterCodex-safe-left))}.betterCodex-domain-grid{gap:9px}.betterCodex-domain-span-3{grid-column:span 3}.betterCodex-domain-span-4{grid-column:span 4}.betterCodex-domain-span-5{grid-column:span 5}.betterCodex-domain-span-6{grid-column:span 6}.betterCodex-domain-span-7{grid-column:span 7}.betterCodex-domain-span-8{grid-column:span 8}.betterCodex-domain-panel{padding:12px}.betterCodex-domain-metric-value{font-size:18px}.betterCodex-domain-head{margin-bottom:12px}.betterCodex-domain-head p{max-width:560px}.betterCodex-agenda-page{display:grid;grid-template-columns:minmax(280px,5fr) minmax(360px,7fr);align-items:start;gap:11px}.betterCodex-agenda-page>.betterCodex-domain-head{grid-column:1/-1}.betterCodex-agenda-page>.betterCodex-agenda-luna{position:sticky;top:max(0px,var(--betterCodex-visual-offset-top,0px));grid-column:1;margin:0;max-height:calc(var(--betterCodex-visual-height,100dvh) - 112px - var(--betterCodex-safe-bottom));overflow:auto}.betterCodex-agenda-page>.betterCodex-domain-boundary{grid-column:1/-1}.betterCodex-agenda-page>.betterCodex-agenda-layout{grid-column:2;display:block}.betterCodex-agenda-layout>main,.betterCodex-agenda-layout>.betterCodex-agenda-agent{display:flex;gap:9px}.betterCodex-agenda-layout>.betterCodex-agenda-agent{margin-top:9px}.betterCodex-agenda-luna-head{flex-direction:column}.betterCodex-agenda-luna-lanes{justify-content:flex-start}.betterCodex-luna-compose-shell .betterCodex-agenda-luna-compose{grid-template-columns:1fr}.betterCodex-luna-compose-shell .betterCodex-domain-button{min-height:44px}.betterCodex-quant-env-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.betterCodex-quant-env{padding:11px}.betterCodex-quant-env-metrics{grid-template-columns:1fr}.betterCodex-quant-position-grid{grid-template-columns:1fr}.betterCodex-domain-table th:first-child,.betterCodex-domain-table td:first-child{position:sticky;left:0;z-index:1;background:#fffdf7}.betterCodex-domain-table th:first-child{z-index:2}}
@media(max-width:639px){.betterCodex-domain-head{padding-right:2px}.betterCodex-domain-head p{display:-webkit-box;overflow:hidden;-webkit-box-orient:vertical;-webkit-line-clamp:2}.betterCodex-domain-actions{align-self:flex-start}.betterCodex-domain-table-wrap{overflow:visible}.betterCodex-domain-table,.betterCodex-domain-table tbody,.betterCodex-domain-table tr{display:block}.betterCodex-domain-table thead{display:none}.betterCodex-domain-table tr{margin-top:8px;padding:8px 10px;border:1px solid rgba(23,33,29,.13);border-radius:7px;background:#fffdf7}.betterCodex-domain-table tr:first-child{margin-top:0}.betterCodex-domain-table td{display:grid;grid-template-columns:92px minmax(0,1fr);gap:8px;padding:5px 0;border:0;white-space:normal;text-align:right}.betterCodex-domain-table td::before{content:attr(data-label);color:#6d746e;font-size:9px;text-align:left}.betterCodex-domain-table td:first-child{display:block;padding-bottom:8px;border-bottom:1px solid rgba(23,33,29,.1);text-align:left}.betterCodex-domain-table td:first-child::before{display:none}.betterCodex-quant-env-grid{gap:8px}.betterCodex-foldable-dock{right:max(8px,var(--betterCodex-safe-right));left:max(8px,var(--betterCodex-safe-left))}.betterCodex-foldable-dock .betterCodex-domain-entry{flex-direction:column;gap:2px;min-height:56px}.betterCodex-foldable-dock .betterCodex-domain-entry-label{font-size:10px}}
@media(max-width:430px){.betterCodex-domain-grid{gap:8px}.betterCodex-domain-head{gap:10px}.betterCodex-domain-table th,.betterCodex-domain-table td{padding:8px 6px}}
@media(pointer:coarse){.betterCodex-domain-entry,.betterCodex-domain-button,.betterCodex-agenda-task-actions button,.betterCodex-agenda-luna-open,.betterCodex-agenda-luna-message-actions button,.betterCodex-agenda-luna-queue-editor button,.betterCodex-luna-settings summary,.betterCodex-luna-work-detail summary,.betterCodex-luna-recent>summary{min-height:44px}.betterCodex-agenda-check{width:32px;height:32px}.betterCodex-agenda-luna textarea{font-size:16px}.betterCodex-agenda-luna-controls select,.betterCodex-luna-settings select,.betterCodex-agenda-quick-add input,.betterCodex-agenda-quick-add select{min-height:44px;font-size:16px}.betterCodex-domain-entry,.betterCodex-domain-button,.betterCodex-agenda-check,.betterCodex-agenda-task-actions button{touch-action:manipulation;-webkit-tap-highlight-color:transparent}}
@media(horizontal-viewport-segments:2){.betterCodex-domain-surface{--betterCodex-hinge-width:calc(env(viewport-segment-left 1 0) - env(viewport-segment-right 0 0))}.betterCodex-foldable-dock{column-gap:max(6px,var(--betterCodex-hinge-width))}}
@media(prefers-reduced-motion:reduce){.betterCodex-domain-surface *{scroll-behavior:auto!important;transition:none!important}}
/* V10: unfolded foldables remain a vertical mobile app, not a compressed desktop dashboard. */
@media(max-width:1023px){
	html[data-betterCodex-domain-active] [data-mobile-nav="home"]{transform:translateX(-100%)!important;opacity:0!important;visibility:hidden!important;pointer-events:none!important}
	.betterCodex-domain-surface{z-index:8;height:var(--betterCodex-visual-height,100dvh);max-height:100%;overflow:hidden;flex-direction:column!important}
	.betterCodex-domain-mobile-bar{min-height:calc(52px + var(--betterCodex-safe-top));display:flex;align-items:flex-end;gap:10px;padding:max(8px,var(--betterCodex-safe-top)) max(12px,var(--betterCodex-safe-right)) 8px max(12px,var(--betterCodex-safe-left));border-bottom:1px solid rgba(23,33,29,.14);background:color-mix(in srgb,#f4f1e8 94%,transparent);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
	.betterCodex-domain-mobile-back{width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;flex:none;padding:0;border:0;border-radius:12px;background:#fffdf7;color:var(--domain-ink);font-size:22px;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
	.betterCodex-domain-mobile-title{min-width:0;align-self:center;overflow:hidden;font-size:15px;font-weight:680;text-overflow:ellipsis;white-space:nowrap}
	.betterCodex-domain-scroll{padding:max(14px,12px) max(12px,var(--betterCodex-safe-right)) calc(24px + var(--betterCodex-safe-bottom)) max(12px,var(--betterCodex-safe-left));scroll-padding-bottom:calc(32px + var(--betterCodex-safe-bottom) + var(--betterCodex-keyboard-inset,0px))}
	.betterCodex-domain-head{align-items:flex-start;gap:10px}.betterCodex-domain-head>div:first-child{min-width:0}.betterCodex-domain-head p{max-width:none}
	.betterCodex-domain-head .betterCodex-domain-actions [data-kind=primary]{display:none!important}
	.betterCodex-foldable-dock{display:none!important}
	.betterCodex-domain-grid{grid-template-columns:1fr!important;gap:10px}
	.betterCodex-domain-span-3,.betterCodex-domain-span-4,.betterCodex-domain-span-5,.betterCodex-domain-span-6,.betterCodex-domain-span-7,.betterCodex-domain-span-8,.betterCodex-domain-span-12{grid-column:1!important}
	.betterCodex-agenda-page{display:block!important}.betterCodex-agenda-page>.betterCodex-agenda-luna{position:static!important;max-height:none!important;overflow:visible!important;margin-bottom:12px!important}.betterCodex-agenda-layout{display:grid!important;grid-template-columns:1fr!important}.betterCodex-agenda-layout>main,.betterCodex-agenda-layout>.betterCodex-agenda-agent{display:flex!important;gap:10px}.betterCodex-agenda-layout>.betterCodex-agenda-agent{margin-top:10px}
	.betterCodex-quant-env-grid{grid-template-columns:1fr!important;gap:10px}.betterCodex-quant-env-metrics{grid-template-columns:repeat(3,minmax(0,1fr))!important}.betterCodex-quant-position-grid{grid-template-columns:repeat(2,minmax(0,1fr))!important}
	.betterCodex-domain-table-wrap{overflow:visible!important}.betterCodex-domain-table,.betterCodex-domain-table tbody,.betterCodex-domain-table tr{display:block!important}.betterCodex-domain-table thead{display:none!important}.betterCodex-domain-table tr{margin-top:8px;padding:9px 10px;border:1px solid rgba(23,33,29,.13);border-radius:8px;background:#fffdf7}.betterCodex-domain-table tr:first-child{margin-top:0}.betterCodex-domain-table td{position:static!important;display:grid!important;grid-template-columns:minmax(86px,32%) minmax(0,1fr);gap:10px;padding:6px 0!important;border:0!important;background:transparent!important;white-space:normal!important;text-align:right}.betterCodex-domain-table td::before{content:attr(data-label);color:#6d746e;font-size:9px;text-align:left}.betterCodex-domain-table td:first-child{display:block!important;padding-bottom:9px!important;border-bottom:1px solid rgba(23,33,29,.1)!important;text-align:left}.betterCodex-domain-table td:first-child::before{display:none}
	[data-mobile-nav="chip-row"]{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px!important;overflow:visible!important;padding-right:16px!important}
	[data-mobile-nav="chip"],[data-mobile-nav="chip-more"]{width:100%!important;min-width:0!important;justify-content:flex-start!important;overflow:hidden!important}
	[data-mobile-nav="chip"] span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
}
@media(min-width:1024px){.betterCodex-domain-mobile-bar{display:none}.betterCodex-domain-mobile-entry,.betterCodex-pwa-install-entry{display:none!important}}
.betterCodex-domain-mobile-entry,.betterCodex-pwa-install-entry{display:none!important}
.betterCodex-pwa-guide-backdrop{position:fixed;inset:0;z-index:10000;display:grid;align-items:end;justify-items:center;padding:max(12px,env(safe-area-inset-top,0px)) max(12px,env(safe-area-inset-right,0px)) max(12px,env(safe-area-inset-bottom,0px)) max(12px,env(safe-area-inset-left,0px));background:rgba(10,16,13,.58);backdrop-filter:blur(8px)}
.betterCodex-pwa-guide{width:min(100%,520px);max-height:min(78dvh,640px);overflow:auto;padding:20px;border:1px solid rgba(244,241,232,.22);border-radius:18px;background:#fffdf7;color:#17211d;box-shadow:0 24px 70px rgba(0,0,0,.28);font-family:"IBM Plex Sans SC","Noto Sans SC",sans-serif}.betterCodex-pwa-guide h2{margin:0;font-size:18px;line-height:1.35}.betterCodex-pwa-guide p{margin:10px 0 0;color:#59645e;font-size:13px;line-height:1.65}.betterCodex-pwa-guide ol{margin:14px 0 0;padding-left:21px;color:#303a35;font-size:13px;line-height:1.65}.betterCodex-pwa-guide-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:18px}.betterCodex-pwa-guide-actions button{min-height:44px;border:1px solid rgba(23,33,29,.24);border-radius:10px;background:#fff;color:#17211d;font:inherit;cursor:pointer;touch-action:manipulation}.betterCodex-pwa-guide-actions button[data-kind=primary]{border-color:#17211d;background:#17211d;color:#f4f1e8}.betterCodex-pwa-guide-actions button:focus-visible{outline:3px solid rgba(194,122,25,.42);outline-offset:2px}
`;

		const name = "betterCodex-workbench-shell";
		const inject = ["slots"];

		/**
		 * The official welcome notice deliberately falls back to process-local state
		 * for remote browsers. This private workbench is also opened through its
		 * protected remote hostname, so that fallback would show the internal-testing
		 * notice again in every new browser process. Shadow the notice's native Slot
		 * cell at an explicit lower priority and complete it immediately; model
		 * onboarding remains unchanged.
		 */
		function SuppressInternalTestingNotice({ complete }) {
			React.useEffect(() => {
				complete();
			}, [complete]);
			return null;
		}

		function apply(ctx) {
			document.title = "Better Codex";
			const titleElement = document.querySelector("title");
			const titleObserver = titleElement ? new MutationObserver(() => {
				if (document.title !== "Better Codex") document.title = "Better Codex";
			}) : null;
			titleObserver?.observe(titleElement, { childList: true });
			const slots = ctx.slots;
			// Reuse the official onboarding coordinator rather than hiding a runtime
			// DOM node. Slot shadowing is selected by priority; order only controls list
			// sequencing. A distinct lower priority avoids a fatal duplicate cell while
			// completing the step without rendering it.
			slots.inject("settings.onboarding", () => slots.register({
				name: "settings.onboarding",
				id: "welcome-notice",
				priority: -1000,
				order: -1000
			}, SuppressInternalTestingNotice));
			const listeners = new Set();
			const requestedDomain = new URLSearchParams(window.location.search).get("domain");
			let activeDomain = ["cockpit", "active-investing", "quant", "agenda", "chatgpt"].includes(requestedDomain) ? requestedDomain : null;
			let disposeDomainSurface = null;
			const cancelPrefetch = schedulePrefetch();
			const domainIds = new Set(["cockpit", "active-investing", "quant", "agenda", "chatgpt"]);
			const domainLabels = new Map([["cockpit", "Cockpit"], ["active-investing", "主动投资"], ["quant", "量化"], ["agenda", "日程"], ["chatgpt", "ChatGPT"]]);
			const historyKey = "__betterCodexWorkbenchDomain";
			const syncDomainDocument = () => {
				if (activeDomain) document.documentElement.dataset.betterCodexDomainActive = activeDomain;
				else delete document.documentElement.dataset.betterCodexDomainActive;
				const home = document.querySelector('[data-mobile-nav="home"]');
				if (home instanceof HTMLElement) home.inert = Boolean(activeDomain);
			};
			if (activeDomain && window.history.state?.[historyKey] !== activeDomain) {
				const domainUrl = new URL(window.location.href);
				const rootUrl = new URL(domainUrl);
				rootUrl.searchParams.delete("domain");
				const baseState = window.history.state && typeof window.history.state === "object" ? { ...window.history.state } : {};
				window.history.replaceState({ ...baseState, [historyKey]: null }, "", rootUrl);
				window.history.pushState({ ...baseState, [historyKey]: activeDomain }, "", domainUrl);
			}
			syncDomainDocument();

			const notify = () => { for (const listener of listeners) listener(); };
			const subscribeActive = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
			const getActive = () => activeDomain;

			function DomainSurface({ renderSlot }) {
				const active = React.useSyncExternalStore(subscribeActive, getActive, getActive);
				const [refreshRevision, setRefreshRevision] = React.useState(0);
				const surfaceRef = React.useRef(null);
				React.useEffect(() => {
					const surface = surfaceRef.current;
					if (!surface) return undefined;
					let frame = null;
					const displayMode = window.matchMedia("(display-mode: standalone)");
					const update = () => {
						if (frame !== null) window.cancelAnimationFrame(frame);
						frame = window.requestAnimationFrame(() => {
							const viewport = window.visualViewport;
							const height = Math.max(320, Math.round(viewport?.height || window.innerHeight));
							const offsetTop = Math.max(0, Math.round(viewport?.offsetTop || 0));
							const keyboardInset = Math.max(0, Math.round(window.innerHeight - height - offsetTop));
							const width = Math.max(320, Math.round(viewport?.width || window.innerWidth));
							const ratio = width / height;
							surface.style.setProperty("--betterCodex-visual-height", `${height}px`);
							surface.style.setProperty("--betterCodex-visual-offset-top", `${offsetTop}px`);
							surface.style.setProperty("--betterCodex-keyboard-inset", `${keyboardInset}px`);
							surface.dataset.displayMode = displayMode.matches ? "standalone" : "browser";
							surface.dataset.deviceShape = width >= 640 && width <= 1023 && ratio >= .8 && ratio <= 1.25 ? "foldable-unfolded" : width < 640 ? "cover" : "wide";
							const focused = document.activeElement;
							if (keyboardInset > 80 && focused && surface.contains(focused) && /^(INPUT|TEXTAREA|SELECT)$/.test(focused.tagName)) focused.scrollIntoView({ block: "nearest" });
							frame = null;
						});
					};
					update();
					window.visualViewport?.addEventListener("resize", update);
					window.visualViewport?.addEventListener("scroll", update);
					window.addEventListener("resize", update);
					window.addEventListener("orientationchange", update);
					displayMode.addEventListener?.("change", update);
					return () => {
						if (frame !== null) window.cancelAnimationFrame(frame);
						window.visualViewport?.removeEventListener("resize", update);
						window.visualViewport?.removeEventListener("scroll", update);
						window.removeEventListener("resize", update);
						window.removeEventListener("orientationchange", update);
						displayMode.removeEventListener?.("change", update);
					};
				}, []);
				if (!active) return null;
				const owner = { wide: true, activeDomain: active, refreshRevision, requestRefresh: () => setRefreshRevision((value) => value + 1), closeDomain, openDomain, subscribeActive, getActive };
				return h("div", { ref: surfaceRef, className: "betterCodex-domain-surface", "data-betterCodex-domain-surface": active }, [
					h("style", { "data-betterCodex-domain-style": "v5", key: "style" }, CSS),
					h("div", { className: "betterCodex-domain-mobile-bar", role: "banner", key: "mobile-bar" }, [
						h("button", { type: "button", className: "betterCodex-domain-mobile-back", onClick: closeDomain, "aria-label": "返回工作台与会话", key: "back" }, "←"),
						h("span", { className: "betterCodex-domain-mobile-title", key: "title" }, domainLabels.get(active) || "工作台")
					]),
					h("div", { className: "betterCodex-domain-scroll", key: "content" }, renderSlot("workspace.domain.page", owner, { only: active }))
				]);
			}

			function ensureSurface() {
				if (disposeDomainSurface) return;
				disposeDomainSurface = slots.register({
					name: "conversation",
					priority: -100,
					children: { "workspace.domain.page": { kind: "list", scope: "root" } }
				}, DomainSurface);
			}

			function closeConversationDetails() {
				const details = document.querySelector('[data-slot="details"]');
				if (!(details instanceof HTMLElement)) return;
				const rect = details.getBoundingClientRect();
				if (rect.width <= 0 || rect.height <= 0) return;
				const close = details.querySelector('button[aria-label="关闭详情"], button[aria-label="Close details"]');
				if (close instanceof HTMLButtonElement) close.click();
			}

			function openDomain(id) {
				if (typeof id !== "string" || !id) return;
				// A session-level details drawer can stay mounted after the mobile
				// home opens. It otherwise sits above the root-scoped workbench and
				// makes a successful domain transition look like a blank page.
				closeConversationDetails();
				ensureSurface();
				const replacing = Boolean(activeDomain);
				activeDomain = id;
				const url = new URL(window.location.href);
				url.searchParams.set("domain", id);
				const state = window.history.state && typeof window.history.state === "object" ? { ...window.history.state } : {};
				window.history[replacing ? "replaceState" : "pushState"]({ ...state, [historyKey]: id }, "", url);
				syncDomainDocument();
				notify();
			}

			function closeDomain(updateUrl = true) {
				if (updateUrl && window.history.state?.[historyKey] && window.history.length > 1) {
					window.history.back();
					return;
				}
				activeDomain = null;
				syncDomainDocument();
				const dispose = disposeDomainSurface;
				disposeDomainSurface = null;
				dispose?.();
				if (updateUrl) {
					const url = new URL(window.location.href);
					url.searchParams.delete("domain");
					const state = window.history.state && typeof window.history.state === "object" ? { ...window.history.state } : {};
					window.history.replaceState({ ...state, [historyKey]: null }, "", url);
				}
				notify();
			}

			function DomainSidebarHost({ wide, renderSlot }) {
				const active = React.useSyncExternalStore(subscribeActive, getActive, getActive);
				const owner = { wide: Boolean(wide), activeDomain: active, openDomain, closeDomain, subscribeActive, getActive };
				return h(React.Fragment, null, [
					h("style", { "data-betterCodex-domain-style": "v5", key: "style" }, CSS),
					h("nav", { className: "betterCodex-domain-stack", "data-mobile-nav": "domain-stack", "data-wide": wide ? "true" : "false", "aria-label": "个人工作区", key: "nav" }, renderSlot("workspace.domain.entry", owner))
				]);
			}

			function DomainMobileEntry({ domainId, label }) {
				return h("button", { type: "button", className: "betterCodex-domain-mobile-entry", onClick: () => openDomain(domainId), "aria-label": `打开工作台：${label}`, title: `工作台 · ${label}` }, `工作台 · ${label}`);
			}

			function showPwaInstallHelp() {
				document.querySelector("[data-betterCodex-pwa-guide]")?.remove();
				const backdrop = document.createElement("div");
				backdrop.className = "betterCodex-pwa-guide-backdrop";
				backdrop.dataset.betterCodexPwaGuide = "true";
				const panel = document.createElement("section");
				panel.className = "betterCodex-pwa-guide";
				panel.setAttribute("role", "dialog");
				panel.setAttribute("aria-modal", "true");
				panel.setAttribute("aria-labelledby", "betterCodex-pwa-guide-title");
				const title = document.createElement("h2");
				title.id = "betterCodex-pwa-guide-title";
				title.textContent = "浏览器还没有提供系统安装窗口";
				const intro = document.createElement("p");
				intro.textContent = "工作台已经具备独立 PWA 清单。浏览器刚完成登录、更新或仍记录旧快捷方式时，可能需要重新检测一次。";
				const steps = document.createElement("ol");
				for (const copy of ["确认当前地址是 http://localhost:3080/，并且已经进入工作台。", "点击“重新检测”；页面刷新后再次点击“安装工作台”。", "仍未出现时，删除旧 BETTER_CODEX 桌面图标并关闭旧标签页，再从首页重开；浏览器菜单应选择“安装应用”，不要只创建网页链接。"]) {
					const item = document.createElement("li");
					item.textContent = copy;
					steps.append(item);
				}
				const actions = document.createElement("div");
				actions.className = "betterCodex-pwa-guide-actions";
				const close = document.createElement("button");
				close.type = "button";
				close.textContent = "关闭";
				const retry = document.createElement("button");
				retry.type = "button";
				retry.dataset.kind = "primary";
				retry.textContent = "重新检测";
				const dismiss = () => {
					document.removeEventListener("keydown", onKeyDown);
					backdrop.remove();
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") dismiss();
				};
				close.addEventListener("click", dismiss);
				retry.addEventListener("click", () => window.location.reload());
				backdrop.addEventListener("click", (event) => {
					if (event.target === backdrop) dismiss();
				});
				document.addEventListener("keydown", onKeyDown);
				actions.append(close, retry);
				panel.append(title, intro, steps, actions);
				backdrop.append(panel);
				document.body.append(backdrop);
				close.focus({ preventScroll: true });
			}

			function PwaInstallEntry() {
				const standalone = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true || document.documentElement.dataset.betterCodexDisplayMode === "standalone";
				const [prompt, setPrompt] = React.useState(() => window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__ || null);
				React.useEffect(() => {
					const available = () => setPrompt(window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__ || null);
					const installed = () => setPrompt(null);
					window.addEventListener("betterCodex:pwa-install-available", available);
					window.addEventListener("betterCodex:pwa-installed", installed);
					return () => {
						window.removeEventListener("betterCodex:pwa-install-available", available);
						window.removeEventListener("betterCodex:pwa-installed", installed);
					};
				}, []);
				if (standalone) return null;
				const install = async () => {
					if (!prompt) {
						showPwaInstallHelp();
						return;
					}
					try {
						await prompt.prompt();
						await prompt.userChoice;
					} finally {
						window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__ = null;
						setPrompt(null);
					}
				};
				return h("button", { type: "button", className: "betterCodex-pwa-install-entry", onClick: install, "aria-label": "安装 Better Codex", title: "安装工作台" }, "安装工作台");
			}

			ctx.effect(() => {
				const onPopState = () => {
					const stateDomain = window.history.state?.[historyKey];
					const urlDomain = new URL(window.location.href).searchParams.get("domain");
					const next = domainIds.has(stateDomain) ? stateDomain : domainIds.has(urlDomain) ? urlDomain : null;
					if (!next) {
						closeDomain(false);
						return;
					}
					activeDomain = next;
					ensureSurface();
					notify();
				};
				window.addEventListener("popstate", onPopState);
				const disposeSidebar = slots.inject("sidebar.footer.action", () => slots.register({
					name: "sidebar.footer.action",
					id: "personal-domain-navigation",
					order: -30,
					label: "个人工作区",
					children: { "workspace.domain.entry": { kind: "list", scope: "root" } }
				}, DomainSidebarHost));
				const disposeMobileCockpit = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-domain-mobile-cockpit", order: -30 }, (props) => h(DomainMobileEntry, { ...props, domainId: "cockpit", label: "Cockpit" })));
				const disposeMobileInvesting = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-domain-mobile-active-investing", order: -29 }, (props) => h(DomainMobileEntry, { ...props, domainId: "active-investing", label: "主动投资" })));
				const disposeMobileQuant = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-domain-mobile-quant", order: -28 }, (props) => h(DomainMobileEntry, { ...props, domainId: "quant", label: "量化" })));
				const disposeMobileAgenda = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-domain-mobile-agenda", order: -27 }, (props) => h(DomainMobileEntry, { ...props, domainId: "agenda", label: "日程" })));
				const disposeMobileChatGPT = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-domain-mobile-chatgpt", order: -26 }, (props) => h(DomainMobileEntry, { ...props, domainId: "chatgpt", label: "ChatGPT" })));
				const disposePwaInstall = slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "personal-pwa-install", order: -25 }, PwaInstallEntry));
				let initialOpenTimer = null;
				if (activeDomain) {
					initialOpenTimer = window.setTimeout(() => {
						ensureSurface();
						notify();
					}, 250);
				}
				return () => {
					window.removeEventListener("popstate", onPopState);
					if (initialOpenTimer !== null) window.clearTimeout(initialOpenTimer);
					disposeSidebar();
					disposeMobileCockpit();
					disposeMobileInvesting();
					disposeMobileQuant();
					disposeMobileAgenda();
					disposeMobileChatGPT();
					disposePwaInstall();
					closeDomain(false);
					cancelPrefetch();
					titleObserver?.disconnect();
					listeners.clear();
				};
			}, "betterCodex-workbench-shell: direct domain navigation");
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
