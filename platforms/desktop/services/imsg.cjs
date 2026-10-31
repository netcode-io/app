const { spawn } = require("node:child_process");
const readline = require("node:readline");

function connectImsg(options = {}) {
	const command = options.command || "imsg-plus";
	const args = options.args || ["rpc", "--no-auto-read", "--no-auto-typing"];
	const launch = options.spawn || spawn;
	const child = launch(command, args, { stdio: ["pipe", "pipe", "pipe"] });
	if (!child.stdout || !child.stdin) {
		throw new Error("imsg-plus did not provide pipes");
	}

	let nextId = 1;
	const pending = new Map();
	const listeners = new Set();
	let closed = false;

	function failAll(error) {
		for (const waiter of pending.values()) waiter.reject(error);
		pending.clear();
	}

	const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
	lines.on("line", (line) => {
		if (!line.trim()) return;
		let message;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.id != null && pending.has(message.id)) {
			const waiter = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) {
				const text = message.error.message || "imsg-plus request failed";
				waiter.reject(new Error(text));
			} else {
				waiter.resolve(message.result);
			}
			return;
		}
		if (typeof message.method === "string") {
			for (const listener of listeners) listener(message);
		}
	});

	child.on("error", (error) => {
		closed = true;
		failAll(error);
	});
	child.on("exit", (code) => {
		closed = true;
		failAll(new Error(`imsg-plus exited (${code ?? "unknown"})`));
	});

	function request(method, params) {
		if (closed) return Promise.reject(new Error("imsg-plus is not running"));
		const id = nextId++;
		const result = new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params || {} })}\n`);
		return result;
	}

	return {
		request,
		send(params) {
			return request("send", params);
		},
		watch(params) {
			return request("watch.subscribe", params || {});
		},
		onNotification(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		close() {
			closed = true;
			lines.close();
			if (typeof child.kill === "function") child.kill();
			failAll(new Error("imsg-plus closed"));
		},
	};
}

module.exports = { connectImsg };
