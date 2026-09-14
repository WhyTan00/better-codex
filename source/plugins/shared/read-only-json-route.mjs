import { createHash } from "node:crypto";

function writeJson(res, statusCode, value, headOnly = false, headers = {}) {
	const body = JSON.stringify(value);
	res.writeHead(statusCode, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"content-length": Buffer.byteLength(body),
		...headers
	});
	if (headOnly) {
		res.end();
		return;
	}
	res.end(body);
}

function registerReadOnlyJsonRoute(ctx, { path, schema, execute, memoryTtlMs = 5_000 }) {
	let cached = null;
	let inFlight = null;
	async function snapshot() {
		const now = Date.now();
		if (cached && now - cached.createdAt < memoryTtlMs) return cached;
		if (inFlight) return inFlight;
		inFlight = Promise.resolve(execute()).then((value) => {
			const body = JSON.stringify(value);
			cached = {
				value,
				body,
				etag: `\"${createHash("sha256").update(body).digest("base64url").slice(0, 20)}\"`,
				createdAt: Date.now()
			};
			return cached;
		}).finally(() => {
			inFlight = null;
		});
		return inFlight;
	}
	return ctx.webServer.register({
		kind: "exact",
		path,
		handler: async (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") {
				writeJson(res, 405, { schema, status: "unavailable", reason: "method_not_allowed" }, req.method === "HEAD");
				return;
			}
			try {
				const result = await snapshot();
				const headers = {
					"cache-control": "private, max-age=5, stale-while-revalidate=15",
					etag: result.etag,
					vary: "accept-encoding"
				};
				if (req.headers["if-none-match"] === result.etag) {
					res.writeHead(304, headers);
					res.end();
					return;
				}
				writeJson(res, 200, result.value, req.method === "HEAD", headers);
			} catch (error) {
				writeJson(res, 503, {
					schema,
					status: "unavailable",
					reason: "read_failed",
					message: String(error?.message || error).slice(0, 240)
				}, req.method === "HEAD");
			}
		}
	});
}

export { registerReadOnlyJsonRoute, writeJson };
