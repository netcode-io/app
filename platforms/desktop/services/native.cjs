const fs = require("node:fs/promises");
const os = require("node:os");
const { fileURLToPath } = require("node:url");
const { app, clipboard, dialog, shell } = require("electron");
const state = require("../state.cjs");

let intentCallback = null;

function emitIntent(intent) {
	if (!intentCallback) return;
	intentCallback.keep = true;
	intentCallback.success(intent);
}

function manufacturer() {
	if (process.platform === "darwin") return "Apple";
	if (process.platform === "win32") return "Microsoft";
	return os.type();
}

function openExternal(url) {
	let parsed;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid URL");
	}
	if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) {
		throw new Error("Only http, https, and mailto links can be opened");
	}
	return shell.openExternal(parsed.href);
}

function exitApp(_args, callback) {
	callback.success();
	app.quit();
}

function getVersionSdkInt(_args, callback) {
	callback.success(0);
}

async function shareFile(args, callback) {
	const raw = String(args[0] || "");
	if (!raw) {
		callback.error("Missing file");
		return;
	}
	const filePath = raw.startsWith("file:") ? fileURLToPath(raw) : raw;
	try {
		await fs.stat(filePath);
	} catch (error) {
		if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
			callback.error("Path does not exist");
			return;
		}
		throw error;
	}
	shell.showItemInFolder(filePath);
	callback.success();
}

function shareText(args, callback) {
	const text = String(args[0] ?? "");
	const address = String(args[1] ?? "");
	clipboard.writeText(text);
	if (address) {
		const mailto = `mailto:${encodeURIComponent(address)}?body=${encodeURIComponent(text)}`;
		shell.openExternal(mailto).catch(() => {});
	}
	callback.success();
}

async function getAppInfo(_args, callback) {
	const root = state.userData || app.getPath("userData");
	let birth = Date.now();
	let updated = birth;
	try {
		const stat = await fs.stat(root);
		birth = stat.birthtimeMs || stat.ctimeMs || birth;
		updated = stat.mtimeMs || updated;
	} catch {
		// The data directory is created on first file access.
	}
	const info = state.packageInfo;
	callback.success({
		arch: process.arch,
		platform: process.platform,
		firstInstallTime: String(Math.round(birth)),
		lastUpdateTime: Math.round(updated),
		label: info.productName,
		packageName: state.isDev ? `${info.name}.dev` : info.name,
		versionName: info.version,
		versionCode: String(info.versionCode),
	});
}

function getDeviceInfo(_args, callback) {
	callback.success({
		manufacturer: manufacturer(),
		model: `${os.type()} ${os.release()}`,
		product: os.hostname(),
		isEmulator: false,
	});
}

function requestPermission(_args, callback) {
	callback.success(true);
}

function requestPermissions(args, callback) {
	const list = Array.isArray(args[0]) ? args[0] : [];
	callback.success(list.map(() => true));
}

function hasPermission(_args, callback) {
	callback.success(true);
}

function setIntentHandler(_args, callback) {
	callback.keep = true;
	intentCallback = callback;
}

async function openInBrowser(args, callback) {
	try {
		await openExternal(String(args[0] || ""));
		callback.success();
	} catch (error) {
		callback.error(error instanceof Error ? error.message : String(error));
	}
}

function setTheme(args, callback) {
	const theme = args[0];
	const color = theme && typeof theme === "object" ? theme.primary : "";
	if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
		const win = state.mainWindow;
		if (win && !win.isDestroyed()) win.setBackgroundColor(color);
	}
	callback.success();
}

function setSystemBarColor(args, callback) {
	const color = args[0];
	if (typeof color === "string" && /^#[0-9a-fA-F]{6}$/.test(color)) {
		const win = state.mainWindow;
		if (win && !win.isDestroyed()) win.setBackgroundColor(color);
	}
	callback.success();
}

async function captureFromCamera(_args, callback) {
	const win = state.mainWindow;
	const parent = win && !win.isDestroyed() ? win : undefined;
	try {
		const picked = await dialog.showOpenDialog(parent, {
			title: "Choose a photo",
			properties: ["openFile"],
			filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
		});
		if (picked.canceled || !picked.filePaths[0]) {
			callback.success(null);
			return;
		}
		const data = await fs.readFile(picked.filePaths[0]);
		const ext = picked.filePaths[0].split(".").pop()?.toLowerCase();
		const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
		callback.success(`data:${mime};base64,${data.toString("base64")}`);
	} catch (error) {
		callback.error(error instanceof Error ? error.message : String(error));
	}
}

function getIpAddresses(_args, callback) {
	const addresses = [];
	for (const entries of Object.values(os.networkInterfaces())) {
		for (const entry of entries || []) {
			const family = entry.family;
			const isIpv4 = family === "IPv4" || family === 4;
			if (!entry.internal && isIpv4) addresses.push(entry.address);
		}
	}
	callback.success(addresses);
}

function restartApp(_args, callback) {
	callback.success();
	try {
		app.relaunch();
	} catch {
		// Relaunch failed; still exit so the process does not stay up.
	}
	app.exit(0);
}

function requestIgnoreBatteryOptimization(_args, callback) {
	callback.success();
}

function showToast(_args, callback) {
	callback.success();
}

function hideSplashScreen(_args, callback) {
	callback.success();
}

function getNavigationMode(_args, callback) {
	callback.success({
		mode: 0,
		hasButtons: false,
		navigationBarHeight: 0,
		statusBarHeight: 0,
	});
}

function haptic(_args, callback) {
	callback.success();
}

function setKeyboardSuggestionsEnabled(_args, callback) {
	callback.success();
}

module.exports = {
	captureFromCamera,
	emitIntent,
	exitApp,
	getAppInfo,
	getDeviceInfo,
	getIpAddresses,
	getNavigationMode,
	getVersionSdkInt,
	haptic,
	hasPermission,
	hideSplashScreen,
	openExternal,
	openInBrowser,
	requestIgnoreBatteryOptimization,
	requestPermission,
	requestPermissions,
	restartApp,
	setIntentHandler,
	setKeyboardSuggestionsEnabled,
	setSystemBarColor,
	setTheme,
	shareFile,
	shareText,
	showToast,
};
