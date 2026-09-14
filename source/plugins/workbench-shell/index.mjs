import { readFile } from "node:fs/promises";
import { join } from "node:path";

const name = "betterCodex-workbench-shell";
const inject = ["webServer", "clientModules"];
const PWA_CAPTURE_SCRIPT = '(function(){if(window.__BETTER_CODEX_PWA_CAPTURE_READY__)return;window.__BETTER_CODEX_PWA_CAPTURE_READY__=true;window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__=window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__||null;document.documentElement.dataset.betterCodexPwaInstall="checking";window.addEventListener("beforeinstallprompt",function(event){event.preventDefault();window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__=event;document.documentElement.dataset.betterCodexPwaInstall="available";window.dispatchEvent(new CustomEvent("betterCodex:pwa-install-available"))});window.addEventListener("appinstalled",function(){window.__BETTER_CODEX_WORKBENCH_INSTALL_PROMPT__=null;document.documentElement.dataset.betterCodexPwaInstall="installed";document.documentElement.dataset.betterCodexDisplayMode="standalone";window.dispatchEvent(new CustomEvent("betterCodex:pwa-installed"))})})();';
const PWA_EARLY_BOOTSTRAP_SCRIPT = `(function(){if(window.__BETTER_CODEX_PWA_BOOTSTRAP_READY__)return;window.__BETTER_CODEX_PWA_BOOTSTRAP_READY__=true;if(!("serviceWorker" in navigator))return;var register=function(){if(window.__BETTER_CODEX_PWA_REGISTER_PROMISE__)return;window.__BETTER_CODEX_PWA_REGISTER_PROMISE__=navigator.serviceWorker.register("/workbench-sw.js",{scope:"/",updateViaCache:"none"}).catch(function(){return null})};var standalone=window.matchMedia&&window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;if(navigator.serviceWorker.controller||standalone){register();return}if(typeof window.requestIdleCallback==="function"){window.requestIdleCallback(register,{timeout:900})}else{window.setTimeout(register,900)}})();`;
const CRITICAL_CLIENT_PRELOAD_IDS = new Set([
	"@native-ai/betterCodex-client-ui-layout",
	"@native-ai/betterCodex-client-ui-sidebar",
	"@native-ai/betterCodex-client-ui-conversation",
	"betterCodex-workbench-shell",
	"betterCodex-universal-cockpit",
	"betterCodex-invest-portfolio",
	"betterCodex-invest-quant",
	"betterCodex-mentor-agenda",
	"betterCodex-chatgpt-archive"
]);

function escapeHtmlAttribute(value) {
	return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function criticalClientPreloadMarkup(graph) {
	if (!graph || !Array.isArray(graph.entries)) return "";
	return graph.entries
		.filter((entry) => CRITICAL_CLIENT_PRELOAD_IDS.has(entry.id) && typeof entry.url === "string")
		.map((entry) => `<link rel="preload" as="script" href="${escapeHtmlAttribute(entry.url)}" fetchpriority="high">`)
		.join("");
}
const MANIFEST = {
	id: "/",
	name: "Better Codex",
	short_name: "AI 工作台",
	description: "个人 AI、投资、量化、日程与 ChatGPT 工作台",
	lang: "zh-CN",
	start_url: "/",
	scope: "/",
	display: "standalone",
	display_override: ["standalone", "minimal-ui"],
	categories: ["productivity", "finance", "utilities"],
	launch_handler: { client_mode: "navigate-existing" },
	background_color: "#F4F1E8",
	theme_color: "#17211D",
	orientation: "any",
	prefer_related_applications: false,
	icons: [
		{ src: "/workbench-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
		{ src: "/workbench-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
		{ src: "/workbench-icon-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
		{ src: "/workbench-icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }
	],
	shortcuts: [
		{ name: "Cockpit", short_name: "Cockpit", url: "/?domain=cockpit" },
		{ name: "主动投资", short_name: "投资", url: "/?domain=active-investing" },
		{ name: "量化", short_name: "量化", url: "/?domain=quant" },
		{ name: "日程", short_name: "日程", url: "/?domain=agenda" },
		{ name: "ChatGPT", short_name: "ChatGPT", url: "/?domain=chatgpt" }
	]
};

function send(res, status, body, type, cacheControl, extraHeaders = {}) {
	const value = Buffer.isBuffer(body) ? body : Buffer.from(body);
	res.writeHead(status, {
		"content-type": type,
		"content-length": value.length,
		"cache-control": cacheControl,
		"x-content-type-options": "nosniff",
		...extraHeaders
	});
	res.end(value);
}

function registerTextRoute(ctx, routePath, body, type, cacheControl) {
	return ctx.webServer.register({
		kind: "exact",
		path: routePath,
		handler: (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				send(res, 405, "method_not_allowed", "text/plain; charset=utf-8", "no-store");
				return;
			}
			if (req.method === "HEAD") {
				res.writeHead(200, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": cacheControl, "x-content-type-options": "nosniff" });
				res.end();
				return;
			}
			send(res, 200, body, type, cacheControl);
		}
	});
}

function registerFileRoute(ctx, routePath, source, type, cacheControl = "public, max-age=86400") {
	return ctx.webServer.register({
		kind: "exact",
		path: routePath,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				send(res, 405, "method_not_allowed", "text/plain; charset=utf-8", "no-store");
				return;
			}
			const body = await readFile(typeof source === "function" ? source() : new URL(`./public/${source}`, import.meta.url));
			if (req.method === "HEAD") {
				res.writeHead(200, { "content-type": type, "content-length": body.length, "cache-control": cacheControl, "x-content-type-options": "nosniff", ...(routePath === "/workbench-sw.js" ? { "service-worker-allowed": "/", "x-workbench-sw-engine": "workbox-7.4.1" } : {}) });
				res.end();
				return;
			}
			send(res, 200, body, type, cacheControl, routePath === "/workbench-sw.js" ? { "service-worker-allowed": "/", "x-workbench-sw-engine": "workbox-7.4.1" } : {});
		}
	});
}

function generatedWorkerPath() {
	if (!process.env.BETTER_CODEX_HOME) throw new Error("BETTER_CODEX_HOME is required to serve the generated PWA worker");
	return join(process.env.BETTER_CODEX_HOME, "pwa", "workbench-sw.js");
}

function apply(ctx) {
	ctx.effect(() => registerTextRoute(
		ctx,
		"/healthz",
		JSON.stringify({ status: "ok", service: "betterCodex-workbench", schema: "betterCodex-workbench.health.v1" }),
		"application/json; charset=utf-8",
		"no-store"
	), "betterCodex-workbench-shell: lightweight health endpoint");
	ctx.effect(() => registerTextRoute(ctx, "/manifest.webmanifest", JSON.stringify(MANIFEST), "application/manifest+json; charset=utf-8", "public, max-age=300"), "betterCodex-workbench-shell: personal manifest");
	ctx.effect(() => registerFileRoute(ctx, "/workbench-sw.js", generatedWorkerPath, "text/javascript; charset=utf-8", "no-cache"), "betterCodex-workbench-shell: Workbox service worker");
	ctx.effect(() => registerFileRoute(ctx, "/offline.html", "offline.html", "text/html; charset=utf-8", "no-cache"), "betterCodex-workbench-shell: private-safe offline page");
	ctx.effect(() => registerFileRoute(ctx, "/workbench-icon-192.png", "workbench-icon-192.png", "image/png"), "betterCodex-workbench-shell: 192 icon");
	ctx.effect(() => registerFileRoute(ctx, "/workbench-icon-512.png", "workbench-icon-512.png", "image/png"), "betterCodex-workbench-shell: 512 icon");
	ctx.effect(() => ctx.on("webserver/index-inject", (table) => {
		// Capture Chromium's one-shot install event before any manifest link is parsed.
		table.push({ kind: "script", placement: "head", text: PWA_CAPTURE_SCRIPT });
		// BETTER_CODEX's official loader must still activate every plugin before mounting the
		// application. Start the largest critical bundles while the HTML parser and
		// official bootstrap are still running, using the live graph so revisions
		// remain aligned after every immutable release.
		const preloadMarkup = criticalClientPreloadMarkup(ctx.clientModules.graph());
		if (preloadMarkup) table.push({ kind: "html", placement: "head", html: preloadMarkup });
		// The public workbench protects its manifest with the same SSO session as the page.
		table.push({ kind: "html", placement: "head", html: '<link rel="manifest" href="/manifest.webmanifest" crossorigin="use-credentials"><meta name="theme-color" content="#17211D"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="AI 工作台"><link rel="icon" href="/workbench-icon-192.png"><link rel="apple-touch-icon" href="/workbench-icon-192.png">' });
		table.push({ kind: "script", placement: "head", text: PWA_EARLY_BOOTSTRAP_SCRIPT });
		table.push({ kind: "script", placement: "body", text: 'document.title="Better Codex";document.documentElement.lang="zh-CN";const viewportContent="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content";const syncViewport=function(){const viewport=document.querySelector("meta[name=viewport]");if(viewport&&viewport.getAttribute("content")!==viewportContent){viewport.setAttribute("content",viewportContent)}};syncViewport();const viewportObserver=new MutationObserver(syncViewport);viewportObserver.observe(document.head,{attributes:true,childList:true,subtree:true,attributeFilter:["content"]});window.addEventListener("load",syncViewport);const syncDisplayMode=function(){document.documentElement.dataset.betterCodexDisplayMode=window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true?"standalone":"browser"};syncDisplayMode();window.matchMedia("(display-mode: standalone)").addEventListener?.("change",syncDisplayMode)' });
	}), "betterCodex-workbench-shell: install metadata");
}

export { apply, criticalClientPreloadMarkup, inject, name, MANIFEST, generatedWorkerPath };
