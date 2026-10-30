const path = require("node:path");

const AUTH_SCHEMES = new Set(["shellular", "shellular-dev", "foxbiz"]);

/**
 * Map an app path onto the desktop data directory.
 * `/files` and `/cache` stay inside `root`, matching the mobile sandboxes.
 * Absolute paths that already live under `root` are kept. Anything that would
 * escape `root` is rejected.
 */
function resolveAppPath(root, input) {
	const base = path.resolve(root);
	let value = String(input ?? "");
	const prefix = base.endsWith(path.sep) ? base : base + path.sep;
	if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
		value = value.slice(prefix.length);
	} else if (value.toLowerCase() === base.toLowerCase()) {
		return base;
	}
	value = value.replace(/^[/\\]+/, "");
	const full = path.resolve(base, value);
	if (full !== base && !full.toLowerCase().startsWith(prefix.toLowerCase())) {
		throw new Error("Path escapes the app data directory");
	}
	return full;
}

/**
 * Turn an app file into a URL the desktop window can load.
 * Only files the app created under `/files` or `/cache` are addressable.
 */
function toAppUrl(root, input) {
	const base = path.resolve(root);
	let value = String(input ?? "");
	const prefix = base.endsWith(path.sep) ? base : base + path.sep;
	if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
		value = value.slice(prefix.length);
	}
	value = value.replace(/^[/\\]+/, "").replace(/\\/g, "/");
	if (value.startsWith("cache/")) {
		return `shellular-app://localhost/__cache__/${value.slice("cache/".length)}`;
	}
	if (value.startsWith("files/")) {
		return `shellular-app://localhost/__file__/${value.slice("files/".length)}`;
	}
	throw new Error("Cannot convert to url, must be a file created by the app");
}

function isAuthCallbackUrl(value) {
	try {
		const url = new URL(String(value));
		const scheme = url.protocol.replace(/:$/, "");
		return AUTH_SCHEMES.has(scheme) && url.hostname === "auth-callback";
	} catch {
		return false;
	}
}

function authParams(value) {
	const url = new URL(String(value));
	return Object.fromEntries(url.searchParams.entries());
}

function localhostHttpPort(value) {
	try {
		const url = new URL(String(value));
		if (url.protocol !== "http:") return null;
		const host = url.hostname;
		if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") {
			return null;
		}
		const port = Number(url.port || 80);
		if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
		return port;
	} catch {
		return null;
	}
}

module.exports = {
	authParams,
	isAuthCallbackUrl,
	localhostHttpPort,
	resolveAppPath,
	toAppUrl,
};
