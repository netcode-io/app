const { randomUUID } = require("node:crypto");
const http = require("node:http");
const { localhostHttpPort } = require("../lib/runtime.cjs");
const state = require("../state.cjs");

const RESPONSE_TIMEOUT_MS = 30 * 1000;
const LISTEN_TIMEOUT_MS = 10 * 1000;
const HEADER_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const servers = new Map();
const starting = new Map();
const pending = new Map();

function headerValue(value) {
	if (Array.isArray(value)) return value.join(", ");
	return value == null ? "" : String(value);
}

function plainHeaders(headers) {
	const result = {};
	for (const [key, value] of Object.entries(headers)) {
		if (Array.isArray(value)) {
			result[key] = key.toLowerCase() === "cookie" ? value.join("; ") : value.join(", ");
		} else if (value != null) {
			result[key] = String(value);
		}
	}
	return result;
}

function forward(port, requestId, req, body) {
	const entry = pending.get(requestId);
	if (!entry || entry.ended) return;
	const win = state.mainWindow;
	if (!win || win.isDestroyed()) {
		sendResponseError(requestId, "Shellular is not ready to proxy this request");
		return;
	}
	const host = headerValue(req.headers.host) || `127.0.0.1:${port}`;
	const url = `http://${host}${req.url || "/"}`;
	const headers = JSON.stringify(plainHeaders(req.headers));
	const js = `(() => {
		if (!window.__shellularProxy || typeof window.__shellularProxy.httpRequest !== "function") return false;
		window.__shellularProxy.httpRequest(${JSON.stringify(requestId)}, ${JSON.stringify(req.method || "GET")}, ${JSON.stringify(url)}, ${JSON.stringify(headers)}, ${JSON.stringify(body)});
		return true;
	})()`;
	win.webContents.executeJavaScript(js).then(
		(accepted) => {
			if (accepted === false) {
				sendResponseError(requestId, "Shellular is not ready to proxy this request");
			}
		},
		(error) => {
			sendResponseError(requestId, error instanceof Error ? error.message : String(error));
		},
	);
}

function onConnection(port, req, res) {
	const requestId = `req_${randomUUID().replace(/-/g, "")}`;
	const entry = {
		res,
		started: false,
		ended: false,
		finishRequested: false,
		nextIndex: 0,
		chunks: new Map(),
		timer: null,
	};
	entry.timer = setTimeout(() => {
		sendResponseError(requestId, "Proxy timed out");
	}, RESPONSE_TIMEOUT_MS);
	pending.set(requestId, entry);

	const chunks = [];
	let forwarded = false;
	const fail = (message) => {
		if (forwarded || entry.ended) return;
		forwarded = true;
		sendResponseError(requestId, message);
	};
	req.on("data", (chunk) => chunks.push(chunk));
	req.on("end", () => {
		if (forwarded || entry.ended) return;
		forwarded = true;
		const body = Buffer.concat(chunks).toString("utf8");
		forward(port, requestId, req, body);
	});
	req.on("error", () => fail("Request failed"));
	req.on("aborted", () => fail("Request aborted"));
	req.on("close", () => {
		if (!req.complete) fail("Request aborted");
	});
	res.on("error", () => {
		entry.ended = true;
		clearTimeout(entry.timer);
		pending.delete(requestId);
	});
}

function ensure(port) {
	port = Number(port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve(false);
	if (state.devPort && port === state.devPort) return Promise.resolve(false);
	if (servers.has(port)) return Promise.resolve(true);
	const existing = starting.get(port);
	if (existing) return existing.promise;

	let settled = false;
	let server = null;
	let listenTimer = null;
	let finish = () => {};
	const promise = new Promise((resolve) => {
		finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(listenTimer);
			starting.delete(port);
			resolve(ok);
		};
	});
	const cancel = () => {
		clearTimeout(listenTimer);
		try {
			if (server) server.close();
		} catch {
			// Not listening yet.
		}
		finish(false);
	};
	starting.set(port, { promise, cancel });

	try {
		server = http.createServer((req, res) => onConnection(port, req, res));
		server.requestTimeout = RESPONSE_TIMEOUT_MS;
		server.headersTimeout = RESPONSE_TIMEOUT_MS;
		server.keepAliveTimeout = 1000;
		server.timeout = 0;
		server.on("clientError", (_error, socket) => {
			try {
				socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
			} catch {
				try {
					socket.destroy();
				} catch {
					// The socket is already gone.
				}
			}
		});
		server.on("error", (error) => {
			if (settled) return;
			console.error(`[desktop] proxy port ${port} failed: ${error.message}`);
			servers.delete(port);
			try {
				server.close();
			} catch {
				// Already closing.
			}
			finish(false);
		});
		server.listen(port, "127.0.0.1", () => {
			if (settled) {
				try {
					server.close();
				} catch {
					// Stop won the race with listen.
				}
				return;
			}
			// has() must mean the port is actually accepting connections.
			servers.set(port, server);
			console.info(`[desktop] proxy listening on 127.0.0.1:${port}`);
			finish(true);
		});
	} catch (error) {
		console.error(`[desktop] proxy port ${port} failed: ${error instanceof Error ? error.message : String(error)}`);
		if (server) {
			try {
				server.close();
			} catch {
				// Listen never started.
			}
		}
		finish(false);
		return promise;
	}

	listenTimer = setTimeout(() => {
		if (settled) return;
		console.error(`[desktop] proxy port ${port} timed out`);
		try {
			server.close();
		} catch {
			// Close raced with listen.
		}
		finish(false);
	}, LISTEN_TIMEOUT_MS);

	return promise;
}

function cleanHeaderValue(value) {
	return String(value).replace(/[\r\n]+/g, " ").trim();
}

function responseHeaders(headersJson) {
	let headers = {};
	try {
		headers = headersJson ? JSON.parse(headersJson) : {};
	} catch {
		headers = {};
	}
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) headers = {};
	const out = {};
	for (const [rawKey, value] of Object.entries(headers)) {
		const key = String(rawKey).trim();
		const lower = key.toLowerCase();
		// A short Content-Length with keep-alive makes Node hold the socket
		// until that many bytes are written, so the client waits forever.
		if (!HEADER_TOKEN.test(key) || lower === "transfer-encoding" || lower === "connection" || lower === "content-length") {
			continue;
		}
		if (lower === "set-cookie") {
			const parts = Array.isArray(value) ? value : String(value == null ? "" : value).split(/\r?\n/);
			const cookies = parts.map((part) => cleanHeaderValue(part)).filter(Boolean);
			if (cookies.length) out[key] = cookies;
			continue;
		}
		if (Array.isArray(value)) {
			const joined = value.map((part) => cleanHeaderValue(part)).filter(Boolean).join(", ");
			if (joined) out[key] = joined;
			continue;
		}
		if (value == null) continue;
		const text = cleanHeaderValue(value);
		if (text) out[key] = text;
	}
	out.Connection = "close";
	return out;
}

function writeBody(entry, chunk) {
	if (!chunk || !chunk.length || entry.ended) return;
	try {
		entry.res.write(chunk);
	} catch {
		entry.ended = true;
	}
}

function flushOrdered(entry) {
	if (!entry.started || entry.ended) return;
	while (entry.chunks.has(entry.nextIndex)) {
		const chunk = entry.chunks.get(entry.nextIndex);
		entry.chunks.delete(entry.nextIndex);
		entry.nextIndex += 1;
		writeBody(entry, chunk);
	}
}

function flushRemaining(entry) {
	if (!entry.started || entry.ended) return;
	const keys = [...entry.chunks.keys()].sort((a, b) => a - b);
	for (const key of keys) {
		writeBody(entry, entry.chunks.get(key));
		entry.chunks.delete(key);
	}
}

function finishResponse(requestId, entry) {
	if (!entry || entry.ended) return;
	entry.ended = true;
	clearTimeout(entry.timer);
	pending.delete(requestId);
	try {
		if (!entry.res.writableEnded && !entry.res.destroyed) entry.res.end();
	} catch {
		try {
			entry.res.destroy();
		} catch {
			// The socket is already gone.
		}
	}
}

function sendResponseStart(requestId, status, statusText, headersJson) {
	const entry = pending.get(requestId);
	if (!entry || entry.ended || entry.started) return;
	const code = Number(status);
	const safeStatus = Number.isInteger(code) && code >= 100 && code <= 599 ? code : 502;
	let message = String(statusText || (safeStatus === 502 ? "Bad Gateway" : "OK")).replace(/[^\t\x20-\x7e]+/g, " ").trim();
	if (!message) message = "OK";
	try {
		entry.res.writeHead(safeStatus, message, responseHeaders(headersJson));
		entry.started = true;
	} catch {
		try {
			if (!entry.res.headersSent) {
				entry.res.writeHead(502, "Bad Gateway", {
					"content-type": "text/plain",
					connection: "close",
				});
			}
			entry.started = true;
		} catch {
			finishResponse(requestId, entry);
			return;
		}
	}
	flushOrdered(entry);
	if (entry.finishRequested) {
		flushRemaining(entry);
		finishResponse(requestId, entry);
	}
}

function sendResponseData(requestId, chunkBase64, index) {
	const entry = pending.get(requestId);
	if (!entry || entry.ended) return;
	const chunk = Buffer.from(String(chunkBase64 || ""), "base64");
	let numeric = Number(index);
	if (!Number.isInteger(numeric) || numeric < 0) numeric = entry.nextIndex + entry.chunks.size;
	if (!entry.chunks.has(numeric)) entry.chunks.set(numeric, chunk);
	flushOrdered(entry);
	if (entry.finishRequested && entry.started) {
		flushRemaining(entry);
		finishResponse(requestId, entry);
	}
}

function sendResponseEnd(requestId) {
	const entry = pending.get(requestId);
	if (!entry || entry.ended) return;
	entry.finishRequested = true;
	if (!entry.started) return;
	flushOrdered(entry);
	flushRemaining(entry);
	finishResponse(requestId, entry);
}

function sendResponseError(requestId, message) {
	const entry = pending.get(requestId);
	if (!entry || entry.ended) return;
	entry.chunks.clear();
	entry.finishRequested = true;
	const body = Buffer.from(String(message || "Proxy error"), "utf8");
	try {
		if (!entry.res.headersSent && !entry.res.destroyed) {
			entry.res.writeHead(502, "Bad Gateway", {
				"content-type": "text/plain",
				"content-length": String(body.length),
				connection: "close",
			});
			entry.started = true;
			entry.res.end(body);
			entry.ended = true;
			clearTimeout(entry.timer);
			pending.delete(requestId);
			return;
		}
	} catch {
		// Fall through and destroy whatever is left.
	}
	finishResponse(requestId, entry);
}

function stopAll() {
	for (const [requestId, entry] of pending.entries()) {
		entry.ended = true;
		clearTimeout(entry.timer);
		try {
			entry.res.destroy();
		} catch {
			// The socket is already gone.
		}
		pending.delete(requestId);
	}
	for (const server of servers.values()) {
		try {
			server.close();
		} catch {
			// Already closing.
		}
	}
	servers.clear();
	for (const record of [...starting.values()]) {
		try {
			record.cancel();
		} catch {
			// Already settled.
		}
	}
	starting.clear();
}

function has(port) {
	return servers.has(Number(port));
}

async function ensureForUrl(value) {
	const port = localhostHttpPort(value);
	if (!port) return false;
	return ensure(port);
}

module.exports = {
	ensure,
	ensureForUrl,
	has,
	sendResponseData,
	sendResponseEnd,
	sendResponseError,
	sendResponseStart,
	stopAll,
};
