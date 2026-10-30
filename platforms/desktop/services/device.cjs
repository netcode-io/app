const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const os = require("node:os");

let app = null;
try {
	const electron = require("electron");
	if (electron && typeof electron === "object") app = electron.app || null;
} catch {
	app = null;
}

const state = require("../state.cjs");

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function safePart(read, fallback) {
	try {
		const value = String(read() || "")
			.replace(/[\r\n\0]/g, "")
			.trim();
		return value || fallback;
	} catch {
		return fallback;
	}
}

function compose(uuid) {
	const host = safePart(() => os.hostname(), "unknown");
	const platform = safePart(() => os.platform(), "unknown");
	const arch = safePart(() => os.arch(), "unknown");
	return `${host}_${platform}_${arch}_${uuid}`;
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

async function readOrCreate() {
	const root = userDataDir();
	if (!root) throw new Error("User data directory is unavailable");
	const file = path.join(root, "device-id");
	let stored = "";
	try {
		stored = (await fs.readFile(file, "utf8")).trim();
	} catch (error) {
		if (!error || error.code !== "ENOENT") throw error;
	}
	// A bare uuid is the previous on-disk form. Freeze the full id so a later hostname change cannot move it.
	if (stored && !UUID_RE.test(stored)) return stored;
	const id = compose(stored || randomUUID());
	await replaceFile(file, id);
	return id;
}

async function id(_args, callback) {
	let value = "";
	try {
		value = await enqueue(readOrCreate);
	} catch (error) {
		callback.error(errorMessage(error));
		return;
	}
	callback.success(value);
}

module.exports = { id };
