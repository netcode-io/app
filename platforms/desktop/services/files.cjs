const fs = require("node:fs/promises");
const path = require("node:path");
const { constants } = require("node:os");
const { pathToFileURL } = require("node:url");
const { resolveAppPath, toAppUrl } = require("../lib/runtime.cjs");
const state = require("../state.cjs");

const NOT_FOUND = "Path does not exist";
const NOT_FILE = "Not a file";
const NOT_DIR = "Not a directory";
const ALREADY_EXISTS = "PATH ALREADY EXISTS";
const NOT_EMPTY = "Directory is not empty";

function electron() {
	return require("electron");
}

function rootDir() {
	if (state.userData) return state.userData;
	return electron().app.getPath("userData");
}

function resolve(input) {
	return resolveAppPath(rootDir(), input);
}

function samePath(left, right) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return a === b || a.toLowerCase() === b.toLowerCase();
}

async function statOrNull(filePath) {
	try {
		return await fs.stat(filePath);
	} catch (error) {
		if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) return null;
		throw error;
	}
}

async function isDataRoot(filePath) {
	const root = path.resolve(rootDir());
	if (samePath(filePath, root)) return true;
	try {
		const [realFile, realRoot] = await Promise.all([fs.realpath(filePath), fs.realpath(root)]);
		return samePath(realFile, realRoot);
	} catch {
		return false;
	}
}

function contentType(filename) {
	switch (path.extname(filename).toLowerCase()) {
		case ".txt":
			return "text/plain";
		case ".html":
			return "text/html";
		case ".json":
			return "application/json";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".png":
			return "image/png";
		case ".pdf":
			return "application/pdf";
		default:
			return "application/octet-stream";
	}
}

function isBase64Flag(value) {
	return value === true || value === 1 || value === "1" || value === "true";
}

// Flagged strings that are not valid base64 are stored as utf8, matching iOS.
function decodeBase64(content) {
	const normalized = content.replace(/\s+/g, "");
	if (!normalized) return Buffer.alloc(0);
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
	if (normalized.length % 4 === 1) return null;
	const data = Buffer.from(normalized, "base64");
	const again = data.toString("base64").replace(/=+$/, "");
	if (again !== normalized.replace(/=+$/, "")) return null;
	return data;
}

function bytesFromContent(content, base64) {
	if (typeof content === "string") {
		if (!base64) return Buffer.from(content, "utf8");
		const decoded = decodeBase64(content);
		if (decoded !== null) return decoded;
		return Buffer.from(content, "utf8");
	}
	if (ArrayBuffer.isView(content)) {
		return Buffer.from(content.buffer, content.byteOffset, content.byteLength);
	}
	if (content instanceof ArrayBuffer) return Buffer.from(content);
	return null;
}

function isCrossDevice(error) {
	return Boolean(error && (error.code === "EXDEV" || error.errno === constants.errno.EXDEV));
}

function safeName(name, fallback) {
	const base = path.basename(String(name || "").replace(/\\/g, "/"));
	if (!base || base === "." || base === "..") return fallback;
	return base;
}

async function writeAll(handle, bytes) {
	const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
	let offset = 0;
	while (offset < buffer.length) {
		const result = await handle.write(buffer.subarray(offset));
		const wrote = result && typeof result === "object" ? result.bytesWritten : result;
		if (!wrote) throw new Error("Failed to write file");
		offset += wrote;
	}
}

async function moveAcrossDevices(from, to) {
	await fs.cp(from, to, { recursive: true, errorOnExist: true, force: false });
	try {
		await fs.rm(from, { recursive: true, force: true });
	} catch (error) {
		await fs.rm(to, { recursive: true, force: true }).catch(() => {});
		throw error;
	}
}

async function read(args, callback) {
	const filePath = resolve(args[0]);
	const stat = await statOrNull(filePath);
	if (!stat) {
		callback.error(NOT_FOUND);
		return;
	}
	if (stat.isDirectory()) {
		callback.error(NOT_FILE);
		return;
	}
	const data = await fs.readFile(filePath);
	callback.success(data.toString("base64"));
}

async function write(args, callback) {
	if (args[0] === undefined || args[0] === null || args[1] === undefined || args[1] === null) {
		callback.error("path and content required");
		return;
	}
	const filePath = resolve(args[0]);
	const data = bytesFromContent(args[1], isBase64Flag(args[2]));
	if (!data) {
		callback.error("path and content required");
		return;
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await fs.writeFile(filePath, data);
	callback.success();
}

async function remove(args, callback) {
	const filePath = resolve(args[0]);
	const recursive = args[1] !== false;
	const stat = await statOrNull(filePath);
	if (!stat) {
		callback.error(`${NOT_FOUND}: ${filePath}`);
		return;
	}
	if (await isDataRoot(filePath)) {
		callback.error("Refusing to delete the app data directory");
		return;
	}
	if (stat.isDirectory()) {
		const children = await fs.readdir(filePath);
		if (children.length > 0 && !recursive) {
			callback.error(NOT_EMPTY);
			return;
		}
		await fs.rm(filePath, { recursive: true, force: true });
	} else {
		await fs.unlink(filePath);
	}
	callback.success();
}

async function exists(args, callback) {
	try {
		const stat = await statOrNull(resolve(args[0]));
		callback.success(Boolean(stat));
	} catch {
		callback.success(false);
	}
}

async function move(args, callback) {
	const from = resolve(args[0]);
	const to = resolve(args[1]);
	const source = await statOrNull(from);
	if (!source) {
		callback.error(NOT_FOUND);
		return;
	}
	if (await statOrNull(to)) {
		callback.error(ALREADY_EXISTS);
		return;
	}
	await fs.mkdir(path.dirname(to), { recursive: true });
	try {
		await fs.rename(from, to);
	} catch (error) {
		if (!isCrossDevice(error)) throw error;
		await moveAcrossDevices(from, to);
	}
	callback.success(to);
}

async function copy(args, callback) {
	const from = resolve(args[0]);
	const to = resolve(args[1]);
	const source = await statOrNull(from);
	if (!source) {
		callback.error(NOT_FOUND);
		return;
	}
	if (await statOrNull(to)) {
		callback.error(ALREADY_EXISTS);
		return;
	}
	await fs.mkdir(path.dirname(to), { recursive: true });
	await fs.cp(from, to, { recursive: source.isDirectory(), errorOnExist: true, force: false });
	callback.success(to);
}

async function list(args, callback) {
	const filePath = resolve(args[0]);
	const stat = await statOrNull(filePath);
	if (!stat || !stat.isDirectory()) {
		callback.error(NOT_DIR);
		return;
	}
	const names = await fs.readdir(filePath, { encoding: "utf8" });
	callback.success(names.map((name) => String(name)));
}

async function isDirectory(args, callback) {
	try {
		const stat = await statOrNull(resolve(args[0]));
		callback.success(Boolean(stat?.isDirectory()));
	} catch {
		callback.success(false);
	}
}

async function isFile(args, callback) {
	try {
		const stat = await statOrNull(resolve(args[0]));
		callback.success(Boolean(stat?.isFile()));
	} catch {
		callback.success(false);
	}
}

async function createDirectory(args, callback) {
	const filePath = resolve(args[0]);
	if (await statOrNull(filePath)) {
		callback.error(ALREADY_EXISTS);
		return;
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	try {
		await fs.mkdir(filePath);
	} catch (error) {
		if (error && error.code === "EEXIST") {
			callback.error(ALREADY_EXISTS);
			return;
		}
		throw error;
	}
	callback.success("Directory created");
}

async function createFile(args, callback) {
	const filePath = resolve(args[0]);
	if (await statOrNull(filePath)) {
		callback.error(ALREADY_EXISTS);
		return;
	}
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	try {
		const handle = await fs.open(filePath, "wx");
		await handle.close();
	} catch (error) {
		if (error && error.code === "EEXIST") {
			callback.error(ALREADY_EXISTS);
			return;
		}
		throw error;
	}
	callback.success("File created");
}

async function getMetadata(args, callback) {
	const filePath = resolve(args[0]);
	const stat = await statOrNull(filePath);
	if (!stat) {
		callback.error(NOT_FOUND);
		return;
	}
	const modified = stat.mtime instanceof Date ? stat.mtime : new Date(stat.mtimeMs);
	callback.success({
		name: path.basename(filePath) || filePath,
		path: filePath,
		size: Number(stat.size) || 0,
		lastModified: modified.toISOString(),
		isDirectory: Boolean(stat.isDirectory()),
	});
}

function resolveAction(args, callback) {
	const filePath = resolve(args[0]);
	callback.success(pathToFileURL(filePath).href);
}

function toUrl(args, callback) {
	try {
		callback.success(toAppUrl(rootDir(), args[0]));
	} catch (error) {
		callback.error(error instanceof Error ? error.message : String(error));
	}
}

async function saveToDevice(args, callback) {
	const { app, dialog, Notification } = electron();
	const source = resolve(args[0]);
	const name = safeName(args[1] || path.basename(source), path.basename(source) || "download");
	const title = String(args[2] || "Download complete");
	const body = String(args[3] || `${name} saved`);
	const stat = await statOrNull(source);
	if (!stat || !stat.isFile()) {
		callback.error(NOT_FOUND);
		return;
	}
	const options = {
		defaultPath: path.join(app.getPath("downloads"), name),
		title: "Save file",
	};
	const parent = state.mainWindow;
	const picked = parent
		? await dialog.showSaveDialog(parent, options)
		: await dialog.showSaveDialog(options);
	if (picked.canceled || !picked.filePath) {
		callback.error("Save cancelled");
		return;
	}
	await fs.mkdir(path.dirname(picked.filePath), { recursive: true });
	await fs.copyFile(source, picked.filePath);
	if (Notification.isSupported()) {
		try {
			new Notification({ title, body }).show();
		} catch {
			// The file is already saved if the desktop cannot show a notification.
		}
	}
	callback.success(picked.filePath);
}

function downloadName(url, disposition) {
	const header = String(disposition || "");
	const named = header.split("filename=")[1]?.split(";")[0]?.replace(/"/g, "").trim();
	let fallback = "download";
	try {
		fallback = path.basename(new URL(url).pathname) || fallback;
	} catch {
		// Keep the generic name when the URL has no path.
	}
	return safeName(named, safeName(fallback, "download"));
}

async function download(args, callback) {
	const url = String(args[0] || "");
	const destination = String(args[1] || "");
	const open = String(args[2] || "none");
	if (!url || !destination) {
		callback.error("url and path required");
		return;
	}
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		callback.error(await response.text().catch(() => "Failed to download"));
		return;
	}
	const filename = downloadName(url, response.headers.get("content-disposition") || "");
	const resolvedDestination = resolve(destination);
	const dirStat = await statOrNull(resolvedDestination);
	const target = dirStat?.isDirectory()
		? resolve(path.join(resolvedDestination, filename))
		: resolvedDestination;
	await fs.mkdir(path.dirname(target), { recursive: true });
	const total = Number(response.headers.get("content-length") || 0);
	const handle = await fs.open(target, "w");
	let received = 0;
	try {
		const reader = response.body.getReader();
		try {
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) break;
				const bytes = Buffer.from(chunk.value);
				await writeAll(handle, bytes);
				received += bytes.length;
				if (total > 0) {
					callback.keep = true;
					callback.success(Math.min(received / total, 0.99));
				}
			}
		} finally {
			reader.releaseLock();
		}
	} catch (error) {
		await handle.close().catch(() => {});
		await fs.rm(target, { force: true }).catch(() => {});
		throw error;
	}
	await handle.close();
	if (open === "reveal" || open === "open") {
		const { shell } = electron();
		if (open === "reveal") shell.showItemInFolder(target);
		if (open === "open") await shell.openPath(target);
	}
	callback.keep = false;
	callback.success(1);
}

function reveal(args, callback) {
	electron().shell.showItemInFolder(resolve(args[0]));
	callback.success();
}

async function print(args, callback) {
	const { BrowserWindow } = electron();
	const filePath = resolve(args[0]);
	const stat = await statOrNull(filePath);
	if (!stat || !stat.isFile()) {
		callback.error(NOT_FILE);
		return;
	}
	const printOptions = args[1] && typeof args[1] === "object" ? args[1] : {};
	const printer = new BrowserWindow({ show: false });
	try {
		await printer.loadFile(filePath);
		await new Promise((resolvePrint, rejectPrint) => {
			printer.webContents.print(printOptions, (success, reason) => {
				if (success) resolvePrint();
				else rejectPrint(new Error(reason || "Print failed"));
			});
		});
		callback.success("printed");
	} finally {
		if (!printer.isDestroyed()) printer.close();
	}
}

module.exports = {
	copy,
	createDirectory,
	createFile,
	delete: remove,
	download,
	exists,
	getMetadata,
	isDirectory,
	isFile,
	list,
	move,
	print,
	read,
	resolve: resolveAction,
	reveal,
	saveToDevice,
	toUrl,
	write,
};
