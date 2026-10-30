const fs = require("node:fs/promises");
const path = require("node:path");

let app = null;
let safeStorage = null;
try {
	const electron = require("electron");
	if (electron && typeof electron === "object") {
		app = electron.app || null;
		safeStorage = electron.safeStorage || null;
	}
} catch {
	app = null;
	safeStorage = null;
}

const state = require("../state.cjs");

let tail = Promise.resolve();
let tmpSeq = 0;

function enqueue(task) {
	const run = tail.then(task, task);
	tail = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

function errorMessage(error) {
	return error instanceof Error ? error.message : String(error || "Unknown error");
}

function userDataDir() {
	if (state.userData) return state.userData;
	try {
		if (app && typeof app.getPath === "function") return app.getPath("userData");
	} catch {
		// userData is unset until the app is ready.
	}
	return "";
}

function storePath() {
	const root = userDataDir();
	if (!root) throw new Error("User data directory is unavailable");
	return path.join(root, "secure-store.json");
}

function readKey(args) {
	if (!Array.isArray(args)) return "";
	const key = args[0];
	if (typeof key !== "string" || key.length === 0) return "";
	return key;
}

function encrypt(value) {
	const text = String(value);
	try {
		if (
			safeStorage &&
			typeof safeStorage.isEncryptionAvailable === "function" &&
			safeStorage.isEncryptionAvailable() &&
			typeof safeStorage.encryptString === "function"
		) {
			const cipher = safeStorage.encryptString(text);
			const encoded = Buffer.isBuffer(cipher)
				? cipher.toString("base64")
				: Buffer.from(cipher).toString("base64");
			return `enc:${encoded}`;
		}
	} catch {
		// The OS keystore is missing or locked; keep the value readable locally.
	}
	return `plain:${Buffer.from(text, "utf8").toString("base64")}`;
}

function decrypt(stored) {
	if (typeof stored !== "string") throw new Error("Secure store value is corrupt");
	if (stored.startsWith("enc:")) {
		if (!safeStorage || typeof safeStorage.decryptString !== "function") {
			throw new Error("Secure store cannot be decrypted");
		}
		return safeStorage.decryptString(Buffer.from(stored.slice(4), "base64"));
	}
	if (stored.startsWith("plain:")) {
		return Buffer.from(stored.slice(6), "base64").toString("utf8");
	}
	throw new Error("Secure store value is corrupt");
}

function parseStore(raw) {
	const text = String(raw).replace(/^\uFEFF/, "").trim();
	if (!text) throw new Error("Secure store is corrupt");
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("Secure store is corrupt");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("Secure store is corrupt");
	}
	const store = Object.create(null);
	for (const key of Object.keys(parsed)) store[key] = parsed[key];
	return store;
}

async function readStore() {
	let raw;
	try {
		raw = await fs.readFile(storePath(), "utf8");
	} catch (error) {
		if (error && error.code === "ENOENT") return Object.create(null);
		throw error;
	}
	return parseStore(raw);
}

async function replaceFile(file, body) {
	const dir = path.dirname(file);
	await fs.mkdir(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
	await fs.writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
	try {
		await fs.rename(tmp, file);
		return;
	} catch (error) {
		const code = error && error.code;
		if (code !== "EEXIST" && code !== "EPERM") {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
	}
	// Windows cannot rename over an existing file. Move it aside and restore it if the swap fails.
	const backup = `${file}.bak`;
	let swapped = false;
	try {
		await fs.rm(backup, { force: true });
		await fs.rename(file, backup);
		swapped = true;
		await fs.rename(tmp, file);
		swapped = false;
	} catch (error) {
		if (swapped) await fs.rename(backup, file).catch(() => {});
		await fs.rm(tmp, { force: true }).catch(() => {});
		throw error;
	}
	await fs.rm(backup, { force: true }).catch(() => {});
}

async function writeStore(data) {
	await replaceFile(storePath(), JSON.stringify(data));
}

async function get(args, callback) {
	try {
		const key = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "";
		const data = await enqueue(() => readStore());
		if (!key || !Object.prototype.hasOwnProperty.call(data, key)) {
			callback.success(null);
			return;
		}
		callback.success(decrypt(data[key]));
	} catch (error) {
		callback.error(errorMessage(error));
	}
}

async function set(args, callback) {
	try {
		const key = readKey(args);
		if (!key) {
			callback.error("Missing key");
			return;
		}
		const value = !args || args.length < 2 || args[1] == null ? "" : String(args[1]);
		await enqueue(async () => {
			const data = await readStore();
			data[key] = encrypt(value);
			await writeStore(data);
		});
		callback.success();
	} catch (error) {
		callback.error(errorMessage(error));
	}
}

async function remove(args, callback) {
	try {
		const key = readKey(args);
		if (!key) {
			callback.error("Missing key");
			return;
		}
		await enqueue(async () => {
			const data = await readStore();
			if (!Object.prototype.hasOwnProperty.call(data, key)) return;
			delete data[key];
			await writeStore(data);
		});
		callback.success();
	} catch (error) {
		callback.error(errorMessage(error));
	}
}

module.exports = { get, remove, set };
