const SCHEMA = "universal-cockpit.v1";
const STATUS_ORDER = new Map([
	["ok", 0],
	["healthy", 0],
	["idle", 0],
	["running", 0],
	["aging", 1],
	["stale", 1],
	["partial", 2],
	["warning", 2],
	["blocked", 3],
	["error", 4],
	["failed", 4],
	["unavailable", 5]
]);

function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boundedText(value, fallback = "", max = 180) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim();
	return trimmed ? trimmed.slice(0, max) : fallback;
}

function normalizeStatus(value) {
	const status = boundedText(value, "unavailable", 32).toLowerCase();
	return STATUS_ORDER.has(status) ? status : "unavailable";
}

function combineStatuses(values) {
	const statuses = values.map(normalizeStatus);
	if (!statuses.length) return "unavailable";
	return statuses.reduce((worst, current) => (STATUS_ORDER.get(current) > STATUS_ORDER.get(worst) ? current : worst), statuses[0]);
}

function money(value, currency = "CNY") {
	const number = finite(value);
	if (number === null) return "—";
	const symbol = currency === "USD" ? "$" : currency === "USDT" ? "" : "¥";
	const suffix = currency === "USDT" ? " USDT" : "";
	return `${symbol}${number.toLocaleString("zh-CN", { maximumFractionDigits: Math.abs(number) < 100 ? 2 : 0 })}${suffix}`;
}

function percent(value, { ratio = false } = {}) {
	const number = finite(value);
	if (number === null) return "—";
	const pct = ratio ? number * 100 : number;
	return `${pct > 0 ? "+" : ""}${pct.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function numberText(value, digits = 0) {
	const number = finite(value);
	return number === null ? "—" : number.toLocaleString("zh-CN", { maximumFractionDigits: digits });
}

function toneForNumber(value) {
	const number = finite(value);
	if (number === null || number === 0) return "neutral";
	return number > 0 ? "positive" : "negative";
}

function metric(id, label, displayValue, options = {}) {
	return {
		id,
		label,
		displayValue: boundedText(String(displayValue ?? "—"), "—", 80),
		tone: options.tone || "neutral",
		...(finite(options.value) === null ? {} : { value: options.value }),
		...(options.unit ? { unit: boundedText(options.unit, "", 20) } : {}),
		...(options.detail ? { detail: boundedText(options.detail, "", 140) } : {})
	};
}

function alert(id, severity, title, detail, source, updatedAt = null) {
	return {
		id: boundedText(id, "alert", 96),
		severity: ["info", "warning", "critical"].includes(severity) ? severity : "warning",
		title: boundedText(title, "需要关注", 120),
		detail: boundedText(detail, "", 260),
		source: boundedText(source, "unknown", 64),
		...(updatedAt ? { updatedAt: boundedText(updatedAt, "", 80) } : {})
	};
}

function projectSection(projectOverview = {}) {
	const projects = Array.isArray(projectOverview.projects) ? projectOverview.projects.slice(0, 40) : [];
	const active = projects.filter((item) => item?.lifecycle === "active").length;
	const surfaces = projects.reduce((sum, item) => sum + (Array.isArray(item?.surfaces) ? item.surfaces.length : 0), 0);
	return {
		id: "projects",
		kind: "workspace",
		title: "项目组合",
		subtitle: "Project OS 中登记的项目与工作入口",
		status: normalizeStatus(projectOverview.status),
		metrics: [
			metric("total", "项目", String(projects.length), { value: projects.length }),
			metric("active", "Active", String(active), { value: active }),
			metric("surfaces", "工作入口", String(surfaces), { value: surfaces })
		],
		items: projects.slice(0, 10).map((item) => ({
			id: boundedText(item?.id, "project", 96),
			title: boundedText(item?.name, "未命名项目", 120),
			subtitle: boundedText(item?.portfolioGroup || item?.entityKind, "project", 100),
			status: boundedText(item?.lifecycle, "unknown", 32),
			meta: Array.isArray(item?.surfaces) ? item.surfaces.slice(0, 4).map((surface) => boundedText(surface?.label || surface?.id, "", 60)).filter(Boolean) : []
		})),
		alerts: []
	};
}

function portfolioSection(portfolio = {}) {
	const totals = portfolio?.totals && typeof portfolio.totals === "object" ? portfolio.totals : {};
	const attention = Array.isArray(portfolio.attention) ? portfolio.attention.slice(0, 8) : [];
	const alerts = attention.map((item, index) => alert(
		`portfolio:${boundedText(item?.symbol, String(index), 32)}`,
		"warning",
		`${boundedText(item?.symbol, "持仓", 32)} 需要检查`,
		item?.alert ? "持仓存在强提醒。" : item?.priceStale ? "当前展示的是最后已知价格。" : "当前价格不可用。",
		"active-investing",
		portfolio.asOf
	));
	if (finite(totals.missingPriceCount) > 0) alerts.unshift(alert("portfolio:missing-price", "warning", "行情覆盖不完整", `${totals.missingPriceCount} 个持仓缺少当前价格。`, "active-investing", portfolio.asOf));
	return {
		id: "active-investing",
		kind: "project",
		title: "主动投资",
		subtitle: "真实持仓、组合损益与行情健康",
		status: normalizeStatus(portfolio.status),
		metrics: [
			metric("market-value", "组合市值", money(totals.marketValueCny), { value: finite(totals.marketValueCny), unit: "CNY" }),
			metric("daily-pnl", "当日盈亏", money(totals.dailyPnlCny), { value: finite(totals.dailyPnlCny), unit: "CNY", tone: toneForNumber(totals.dailyPnlCny), detail: percent(totals.dailyPct) }),
			metric("unrealized-pnl", "浮动盈亏", money(totals.unrealizedPnlCny), { value: finite(totals.unrealizedPnlCny), unit: "CNY", tone: toneForNumber(totals.unrealizedPnlCny), detail: percent(totals.unrealizedPct) }),
			metric("price-health", "价格覆盖", `${numberText(totals.pricedCount)} / ${numberText((finite(totals.pricedCount) || 0) + (finite(totals.missingPriceCount) || 0))}`, { detail: `旧价 ${numberText(totals.stalePriceCount)}` })
		],
		items: (Array.isArray(portfolio.positions) ? portfolio.positions : []).slice(0, 8).map((item) => ({
			id: boundedText(item?.symbol, "position", 40),
			title: boundedText(item?.name || item?.symbol, "持仓", 100),
			subtitle: boundedText(item?.symbol, "", 40),
			status: item?.priceStale ? "stale" : item?.currentPrice === null ? "unavailable" : "ok",
			meta: [percent(item?.dailyPct), percent(item?.unrealizedPct)].filter((value) => value !== "—")
		})),
		alerts
	};
}

function quantSection(quant = {}) {
	const paper = quant?.paper && typeof quant.paper === "object" ? quant.paper : {};
	const perf = paper?.performance?.allEnabled && typeof paper.performance.allEnabled === "object" ? paper.performance.allEnabled : {};
	const alerts = [];
	if (finite(paper.runningCount) !== null && finite(paper.totalCount) !== null && paper.runningCount < paper.totalCount) {
		alerts.push(alert("quant:paper-not-all-running", "warning", "Paper 策略未全部运行", `${paper.runningCount}/${paper.totalCount} 个策略处于运行态。`, "quant", paper.generatedAt));
	}
	if (normalizeStatus(paper.status) === "unavailable") alerts.push(alert("quant:paper-unavailable", "critical", "Paper 汇总不可用", "量化 Cockpit 当前无法读取 Paper 策略汇总。", "quant", paper.generatedAt));
	return {
		id: "quant",
		kind: "project",
		title: "量化",
		subtitle: "Paper 策略池与执行证据的只读摘要",
		status: normalizeStatus(quant.status),
		metrics: [
			metric("paper-return", "Paper 累计收益", percent(perf.accountReturn, { ratio: true }), { value: finite(perf.accountReturn), tone: toneForNumber(perf.accountReturn) }),
			metric("paper-running", "运行策略", `${numberText(paper.runningCount)} / ${numberText(paper.totalCount)}`, { value: finite(paper.runningCount) }),
			metric("capital-utilization", "资金利用率", percent(perf.timeWeightedUtilization, { ratio: true }), { value: finite(perf.timeWeightedUtilization) }),
			metric("sharpe", "Sharpe", numberText(perf.annualizedSharpe, 2), { value: finite(perf.annualizedSharpe) })
		],
		items: (Array.isArray(paper.strategies) ? paper.strategies : []).slice(0, 8).map((item) => ({
			id: boundedText(item?.id || item?.strategyId || item?.name, "strategy", 120),
			title: boundedText(item?.name || item?.strategyId || item?.id, "Paper strategy", 120),
			subtitle: item?.pidAlive ? "运行中" : "未运行",
			status: item?.status === "healthy" && item?.pidAlive ? "running" : boundedText(item?.status, item?.pidAlive ? "running" : "idle", 32),
			meta: []
		})),
		alerts
	};
}

function agendaSection(agenda = {}) {
	const counts = agenda?.counts && typeof agenda.counts === "object" ? agenda.counts : {};
	const alerts = (Array.isArray(agenda.integrityIssues) ? agenda.integrityIssues : []).slice(0, 8).map((item, index) => alert(
		`agenda:${boundedText(item?.code, String(index), 64)}`,
		item?.severity === "critical" ? "critical" : "warning",
		"日程数据需要关注",
		boundedText(item?.detail, "日程投影存在完整性提示。", 260),
		"agenda",
		agenda.generatedAt
	));
	if ((finite(counts.agentBlocked) || 0) > 0) alerts.unshift(alert("agenda:agent-blocked", "warning", "Agent 有阻塞任务", `${counts.agentBlocked} 个 Agent 任务处于阻塞状态。`, "agenda", agenda.generatedAt));
	return {
		id: "agenda",
		kind: "agent",
		title: "日程与 Agent",
		subtitle: boundedText(agenda?.focus?.title, "今日动作、待判断事项与后台推进", 140),
		status: normalizeStatus(agenda.status),
		metrics: [
			metric("today", "今日事项", numberText(counts.today), { value: finite(counts.today) }),
			metric("human-needed", "需要你", numberText(counts.humanNeeded), { value: finite(counts.humanNeeded), tone: (finite(counts.humanNeeded) || 0) > 0 ? "warning" : "neutral" }),
			metric("agent-background", "Agent 推进", numberText(counts.agentBackground), { value: finite(counts.agentBackground) }),
			metric("agent-blocked", "Agent 阻塞", numberText(counts.agentBlocked), { value: finite(counts.agentBlocked), tone: (finite(counts.agentBlocked) || 0) > 0 ? "warning" : "neutral" })
		],
		items: (Array.isArray(agenda?.actions?.today) ? agenda.actions.today : []).slice(0, 8).map((item, index) => ({
			id: boundedText(item?.id, `today-${index}`, 100),
			title: boundedText(item?.title, "今日事项", 140),
			subtitle: boundedText(item?.project || item?.kind, "", 100),
			status: boundedText(item?.state, "open", 32),
			meta: []
		})),
		alerts
	};
}

export function buildCockpitSnapshot({ projectOverview = {}, portfolio = {}, quant = {}, agenda = {}, generatedAt = new Date().toISOString() } = {}) {
	const sections = [projectSection(projectOverview), portfolioSection(portfolio), quantSection(quant), agendaSection(agenda)];
	const alerts = sections.flatMap((section) => section.alerts || []).slice(0, 24);
	const projectCount = Array.isArray(projectOverview.projects) ? projectOverview.projects.length : 0;
	const runningJobs = (finite(quant?.paper?.runningCount) || 0) + (finite(agenda?.counts?.agentBackground) || 0);
	return {
		schema: SCHEMA,
		adapter: { id: "betterCodex-v1", label: "Native Harness", version: 1 },
		workspace: { id: "better-codex-ai", name: "Better Codex Cockpit", kind: "personal-workspace" },
		status: combineStatuses(sections.map((section) => section.status)),
		generatedAt,
		summary: {
			sectionCount: sections.length,
			projectCount,
			runningJobs,
			alertCount: alerts.length,
			criticalCount: alerts.filter((item) => item.severity === "critical").length,
			warningCount: alerts.filter((item) => item.severity === "warning").length
		},
		sections,
		alerts,
		capabilities: {
			refresh: true,
			navigateSections: true,
			widgetFullscreen: true,
			writeActions: false,
			tradeActions: false
		},
		boundaries: {
			readOnly: true,
			credentialsIncluded: false,
			commandBodiesIncluded: false,
			tradeActionsIncluded: false,
			conversationBodiesIncluded: false
		}
	};
}

export { SCHEMA as COCKPIT_SCHEMA };
