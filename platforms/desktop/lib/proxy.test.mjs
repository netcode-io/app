import { createRequire } from "node:module";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const proxy = require("../services/proxy.cjs");
const state = require("../state.cjs");

function freePort() {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

function installWindow(mode) {
	state.mainWindow = {
		isDestroyed() {
			return false;
		},
		webContents: {
			executeJavaScript(js) {
				const match = String(js).match(/httpRequest\("([^"]+)"/);
				if (!match) return Promise.resolve(false);
				const id = match[1];
				setImmediate(() => {
					if (mode === "ordered") {
						proxy.sendResponseStart(
							id,
							200,
							"OK\r\nX-Injected: yes",
							JSON.stringify({
								"Content-Length": "100",
								"Transfer-Encoding": "chunked",
								Connection: "keep-alive",
								"Content-Type": "text/plain",
								"Set-Cookie": "a=1\r\nb=2",
								"X-Bad\r\nInjected": "no",
								"X-Ok": "yes\r\nno",
							}),
						);
						proxy.sendResponseData(id, Buffer.from("world").toString("base64"), 1);
						proxy.sendResponseData(id, Buffer.from("hello").toString("base64"), 0);
						proxy.sendResponseEnd(id);
						return;
					}
					if (mode === "end-first") {
						proxy.sendResponseEnd(id);
						proxy.sendResponseData(id, Buffer.from("late").toString("base64"), 0);
						proxy.sendResponseStart(id, 200, "OK", JSON.stringify({ "Content-Type": "text/plain" }));
						return;
					}
					if (mode === "bad-status") {
						proxy.sendResponseStart(id, 999, "", JSON.stringify({ "Content-Type": "text/plain" }));
						proxy.sendResponseData(id, Buffer.from("nope").toString("base64"), 0);
						proxy.sendResponseEnd(id);
					}
				});
				return Promise.resolve(mode === "missing" ? false : true);
			},
		},
	};
}

function get(port) {
	return new Promise((resolve, reject) => {
		const req = http.get({ hostname: "127.0.0.1", port, path: "/probe", timeout: 4000 }, (res) => {
			const chunks = [];
			res.on("data", (chunk) => chunks.push(chunk));
			res.on("end", () => {
				resolve({
					status: res.statusCode,
					message: res.statusMessage,
					headers: res.headers,
					raw: res.rawHeaders.join("\n").toLowerCase(),
					body: Buffer.concat(chunks).toString("utf8"),
				});
			});
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("client timeout")));
	});
}

afterEach(() => {
	proxy.stopAll();
	state.mainWindow = null;
	state.devPort = null;
});

describe("desktop localhost proxy", () => {
	it("skips the dev server port and https", async () => {
		const port = await freePort();
		state.devPort = port;
		expect(await proxy.ensure(port)).toBe(false);
		expect(proxy.has(port)).toBe(false);
		expect(await proxy.ensureForUrl(`https://localhost:${port}/`)).toBe(false);
	});

	it("listens once, orders chunks, and strips unsafe headers", async () => {
		const port = await freePort();
		installWindow("ordered");
		const first = proxy.ensure(port);
		const second = proxy.ensure(port);
		expect(second).toBe(first);
		expect(await first).toBe(true);
		expect(proxy.has(port)).toBe(true);

		const response = await get(port);
		expect(response.body).toBe("helloworld");
		expect(response.status).toBe(200);
		expect(response.message).toBe("OK X-Injected: yes");
		expect(response.headers).not.toHaveProperty("content-length");
		expect(response.raw).not.toContain("x-bad");
		expect(response.headers["x-ok"]).toBe("yes no");
		expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
	});

	it("finishes when end arrives before start", async () => {
		const port = await freePort();
		installWindow("end-first");
		expect(await proxy.ensure(port)).toBe(true);
		const response = await get(port);
		expect(response.status).toBe(200);
		expect(response.body).toBe("late");
	});

	it("turns an out-of-range status and a missing bridge into 502", async () => {
		const port = await freePort();
		installWindow("bad-status");
		expect(await proxy.ensure(port)).toBe(true);
		const bad = await get(port);
		expect(bad.status).toBe(502);

		installWindow("missing");
		const missing = await get(port);
		expect(missing.status).toBe(502);
		expect(missing.body).toContain("not ready");
	});

	it("settles an in-flight listen when the proxy stops", async () => {
		const port = await freePort();
		const pending = proxy.ensure(port);
		proxy.stopAll();
		expect(await pending).toBe(false);
		expect(proxy.has(port)).toBe(false);
	});
});
