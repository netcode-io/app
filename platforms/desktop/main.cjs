const fs = require("node:fs");
const path = require("node:path");
const {
	app,
	BrowserWindow,
	dialog,
	ipcMain,
	Menu,
	protocol,
	session,
} = require("electron");
const { isAuthCallbackUrl, localhostHttpPort, resolveAppPath } = require("./lib/runtime.cjs");
const browser = require("./services/browser.cjs");
const device = require("./services/device.cjs");
const files = require("./services/files.cjs");
const native = require("./services/native.cjs");
const notification = require("./services/notification.cjs");
const proxy = require("./services/proxy.cjs");
const secureStore = require("./services/secure-store.cjs");
const state = require("./state.cjs");

const pkg = require("../../package.json");

protocol.registerSchemesAsPrivileged([
	{
		scheme: "shellular-app",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
		},
	},
	{
		scheme: "shellular",
		privileges: {
			standard: true,
			secure: true,
			supportFetchAPI: true,
			corsEnabled: true,
			stream: true,
		},
	},
]);

app.setName("Shellular");
if (process.platform === "win32") {
	app.setAppUserModelId(pkg.name);
}

const queuedAuthUrls = [];
let started = false;
let lastAuthUrl = "";
let lastAuthAt = 0;
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.exit(0);
} else {
	app.on("second-instance", (_event, argv) => {
		deliverAuthUrl(authUrlFromArgv(argv));
		focusMainWindow();
	});
	app.on("open-url", (event, url) => {
		event.preventDefault();
		const authUrl = authUrlFromArg(url);
		if (!authUrl) return;
		if (app.isReady() && started) {
			deliverAuthUrl(authUrl);
			focusMainWindow();
			return;
		}
		queuedAuthUrls.push(authUrl);
	});
	app.whenReady().then(start).catch((error) => {
		console.error("[desktop] failed to start", error);
		app.exit(1);
	});
}

const services = {
	Browser: browser,
	Device: device,
	EmbeddedProxy: {
		responseStart(args, callback) {
			proxy.sendResponseStart(args[0], args[1], args[2], args[3]);
			callback.success();
		},
		responseData(args, callback) {
			proxy.sendResponseData(args[0], args[1], args[2]);
			callback.success();
		},
		responseEnd(args, callback) {
			proxy.sendResponseEnd(args[0]);
			callback.success();
		},
		responseError(args, callback) {
			proxy.sendResponseError(args[0], args[1]);
			callback.success();
		},
	},
	FileHandler: files,
	Native: native,
	Notification: notification,
	SecureStore: secureStore,
};

function start() {
	state.packageInfo = {
		name: pkg.name,
		productName: "Shellular",
		version: pkg.version,
		versionCode: pkg.versionCode,
		displayName: pkg.displayName || "Shellular",
	};
	state.userData = app.getPath("userData");
	state.bundleDir = app.isPackaged
		? path.join(process.resourcesPath, "bundle")
		: path.join(__dirname, "bundle");
	state.devUrl = process.env.SHELLULAR_DEV_URL || "";
	state.isDev = process.env.SHELLULAR_DEV === "1" && Boolean(state.devUrl);
	state.devPort = readPort(state.devUrl);

	registerProtocolClient();
	registerProtocols();
	installRendererCors();
	installBrowserProxyHook();
	installIpc();
	installMenu();
	createMainWindow();
	started = true;

	const launchUrls = new Set(queuedAuthUrls.splice(0));
	const launchUrl = authUrlFromArgv(process.argv);
	if (launchUrl) launchUrls.add(launchUrl);
	for (const url of launchUrls) deliverAuthUrl(url);

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
	});
	app.on("window-all-closed", () => {
		// macOS keeps the process alive so activate can open a new window.
		if (process.platform !== "darwin") app.quit();
	});
	app.on("before-quit", () => {
		proxy.stopAll();
	});
}

function createMainWindow() {
	const win = new BrowserWindow({
		width: 1100,
		height: 800,
		minWidth: 800,
		minHeight: 640,
		show: false,
		backgroundColor: "#0d0d0f",
		title: "Shellular",
		icon: iconPath(),
		webPreferences: {
			preload: path.join(__dirname, "preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	state.mainWindow = win;
	win.once("ready-to-show", () => win.show());
	win.on("closed", () => {
		if (state.mainWindow === win) state.mainWindow = null;
		browser.close();
	});
	win.webContents.setWindowOpenHandler(({ url }) => {
		native.openExternal(url).catch((error) => {
			console.error("[desktop] blocked window open", error);
		});
		return { action: "deny" };
	});
	win.webContents.on("will-navigate", (event, url) => {
		if (allowsNavigation(url)) return;
		event.preventDefault();
		if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:")) {
			native.openExternal(url).catch(() => {});
		}
	});
	win.webContents.on("did-fail-load", (_event, code, description, url) => {
		console.error(`[desktop] load failed (${code}) ${url}: ${description}`);
	});
	win.webContents.on("did-finish-load", () => {
		console.info("[desktop] loaded");
	});
	win.webContents.on("console-message", (details) => {
		if (details.level === "error") console.error(`[desktop] ${details.message}`);
	});

	const target = state.isDev ? state.devUrl : "shellular-app://localhost/index.html";
	console.info(`[desktop] loading ${target}`);
	win.loadURL(target).catch((error) => {
		console.error("[desktop] loadURL failed", error);
	});
	return win;
}

function installIpc() {
	ipcMain.on("bridge:exec", (event, payload) => {
		const callback = createCallback(event.sender, payload?.id);
		const service = services[payload?.service];
		const action = service?.[payload?.action];
		if (typeof action !== "function") {
			callback.error(`${payload?.service}/${payload?.action} not found`);
			return;
		}
		Promise.resolve()
			.then(() => action(payload.args || [], callback))
			.catch((error) => {
				callback.error(error);
			});
	});
	ipcMain.on("browser:ensure-port", (event, port) => {
		const number = Number(port);
		if (!Number.isInteger(number) || number < 1 || number > 65535) {
			event.returnValue = false;
			return;
		}
		// Sync IPC hangs the renderer forever if returnValue is never set.
		try {
			const pending = proxy.ensure(number);
			if (pending && typeof pending.catch === "function") pending.catch(() => {});
			event.returnValue = true;
		} catch (error) {
			console.error("[desktop] ensure port failed", error);
			event.returnValue = false;
		}
	});
	ipcMain.on("browser:command", (_event, command, payload) => {
		browser.handleChromeCommand(command, payload);
	});
}

function installRendererCors() {
	// API responses allow https://app.shellular.dev. This window's origin is the
	// dev server or shellular-app://, so reflect that origin instead.
	const origin = appOrigin();
	session.defaultSession.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
		let finished = false;
		const done = (responseHeaders) => {
			if (finished) return;
			finished = true;
			try {
				callback({ responseHeaders });
			} catch (error) {
				console.error("[desktop] header callback failed", error);
			}
		};
		try {
			const headers = {};
			const source = details.responseHeaders || {};
			for (const key of Object.keys(source)) {
				const name = key.toLowerCase();
				if (name === "access-control-allow-origin" || name === "access-control-allow-credentials") {
					continue;
				}
				const value = source[key];
				headers[key] = Array.isArray(value) ? value.map(String) : [String(value)];
			}
			headers["access-control-allow-origin"] = [origin];
			headers["access-control-allow-credentials"] = ["true"];
			done(headers);
		} catch (error) {
			console.error("[desktop] cors rewrite failed", error);
			done(details.responseHeaders);
		}
	});
}

function installBrowserProxyHook() {
	const browserSession = session.fromPartition("persist:shellular-browser");
	browserSession.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
		let finished = false;
		const done = () => {
			if (finished) return;
			finished = true;
			try {
				callback({});
			} catch (error) {
				console.error("[desktop] proxy hook callback failed", error);
			}
		};
		try {
			const port = localhostHttpPort(details.url);
			// The dev server is a real local listener. Proxying it would steal the port.
			if (!port || port === state.devPort || proxy.has(port)) {
				done();
				return;
			}
			const pending = proxy.ensure(port);
			if (pending && typeof pending.finally === "function") pending.finally(done);
			else done();
		} catch (error) {
			console.error("[desktop] proxy hook failed", error);
			done();
		}
	});
}

function registerProtocols() {
	const sessions = [session.defaultSession, session.fromPartition("persist:shellular-browser")];
	for (const ses of sessions) {
		ses.protocol.handle("shellular-app", (request) => {
			try {
				return serveApp(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResponse(message, 404);
			}
		});
		ses.protocol.handle("shellular", async (request) => {
			try {
				return await serveShellularPage(request);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResponse(message, 500);
			}
		});
	}
}

function serveApp(request) {
	const url = new URL(request.url);
	const pathname = decodePathname(url.pathname);
	if (pathname.startsWith("/__file__/")) {
		return serveDataFile(path.join(state.userData, "files"), pathname.slice("/__file__/".length));
	}
	if (pathname.startsWith("/__cache__/")) {
		return serveDataFile(path.join(state.userData, "cache"), pathname.slice("/__cache__/".length));
	}
	const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
	if (!relative) return textResponse("Not found", 404);
	return serveDataFile(state.bundleDir, relative);
}

async function serveShellularPage(request) {
	const authUrl = authUrlFromArg(request.url);
	if (authUrl) {
		deliverAuthUrl(authUrl);
		focusMainWindow();
		return textResponse("Signed in. You can close this window.");
	}
	const url = new URL(request.url);
	const host = url.hostname.toLowerCase();
	if (host === "assets") {
		const relative = decodePathname(url.pathname).replace(/^\/+/, "");
		if (!relative) return textResponse("Not found", 404);
		return serveDataFile(state.bundleDir, relative);
	}
	if (host === "raw") {
		return htmlResponse(browser.takeHtml() || "<p>Nothing to show.</p>");
	}
	const win = state.mainWindow;
	if (!win || win.isDestroyed()) {
		return htmlResponse("<p>Shellular is still starting.</p>");
	}
	const name = host || "home";
	let html = "";
	try {
		html = await withTimeout(shellularPageHtml(win, name), 20000);
	} catch (error) {
		console.error("[desktop] shellular page failed", error);
		return htmlResponse("<p>Page unavailable.</p>");
	}
	return htmlResponse(typeof html === "string" && html ? html : "<p>Page unavailable.</p>");
}

async function shellularPageHtml(win, name) {
	await waitForMainFrame(win.webContents);
	if (win.isDestroyed()) return "";
	return win.webContents.executeJavaScript(
		`window.__shellularPage ? window.__shellularPage(${JSON.stringify(name)}) : ""`,
	);
}

function withTimeout(promise, ms) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("Timed out")), ms);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

function serveDataFile(root, relative) {
	const filePath = resolveAppPath(root, relative);
	if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
		return textResponse("Not found", 404);
	}
	const data = fs.readFileSync(filePath);
	// Copy out of the Node buffer pool. A Buffer body makes Chromium read slack bytes.
	const bytes = new Uint8Array(data.byteLength);
	bytes.set(data);
	return new Response(bytes, {
		headers: {
			"content-type": mimeType(filePath),
			"content-length": String(bytes.byteLength),
			"cache-control": "no-cache",
			"access-control-allow-origin": "*",
		},
	});
}

function registerProtocolClient() {
	const scheme = state.isDev ? "shellular-dev" : "shellular";
	if (process.defaultApp) {
		const script = devScriptPath();
		if (script) {
			app.setAsDefaultProtocolClient(scheme, process.execPath, [script]);
			return;
		}
	}
	app.setAsDefaultProtocolClient(scheme);
}

function installMenu() {
	const about = {
		label: "About Shellular",
		click() {
			dialog.showMessageBox({
				type: "info",
				title: "About Shellular",
				message: "Shellular",
				detail: `Version ${state.packageInfo.version} (${state.packageInfo.versionCode})\nhttps://shellular.dev`,
			});
		},
	};
	const template =
		process.platform === "darwin"
			? [
					{
						role: "appMenu",
						submenu: [about, { type: "separator" }, { role: "services" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }, { role: "quit" }],
					},
					{ role: "editMenu" },
					{ role: "viewMenu" },
					{ role: "windowMenu" },
				]
			: [
					{
						label: "Shellular",
						submenu: [about, { type: "separator" }, { role: "quit" }],
					},
					{ role: "editMenu" },
					{ role: "viewMenu" },
					{ role: "windowMenu" },
				];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createCallback(sender, id) {
	let settled = false;
	const send = (payload) => {
		if (sender.isDestroyed()) return false;
		sender.send("bridge:callback", payload);
		return true;
	};
	const callback = {
		keep: false,
		success(value) {
			if (settled || sender.isDestroyed()) return;
			const keep = callback.keep === true;
			try {
				const delivered = send({
					id,
					keep,
					success: value === undefined ? null : value,
				});
				if (!delivered) return;
				if (!keep) settled = true;
			} catch (error) {
				// A non-cloneable payload would otherwise leave the renderer waiting.
				if (settled || sender.isDestroyed()) return;
				settled = true;
				const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
				try {
					send({ id, keep: false, error: message || "Unknown error" });
				} catch {
					// The channel rejected the error payload too.
				}
			}
		},
		error(error) {
			if (settled || sender.isDestroyed()) return;
			const message = error instanceof Error ? error.message : String(error ?? "Unknown error");
			try {
				if (!send({ id, keep: false, error: message || "Unknown error" })) return;
				settled = true;
			} catch {
				settled = true;
			}
		},
	};
	return callback;
}

function deliverAuthUrl(url) {
	if (!url) return;
	const now = Date.now();
	if (url === lastAuthUrl && now - lastAuthAt < 2000) return;
	lastAuthUrl = url;
	lastAuthAt = now;
	browser.deliverAuth(url);
}

function focusMainWindow() {
	let win = state.mainWindow;
	if ((!win || win.isDestroyed()) && started) win = createMainWindow();
	if (!win || win.isDestroyed()) return;
	if (win.isMinimized()) win.restore();
	win.show();
	win.focus();
}

function allowsNavigation(target) {
	try {
		const next = new URL(target);
		if (next.protocol === "shellular-app:" && next.hostname.toLowerCase() === "localhost") return true;
		if (state.isDev && state.devUrl) return next.origin === new URL(state.devUrl).origin;
	} catch {
		return false;
	}
	return false;
}

function appOrigin() {
	if (state.isDev && state.devUrl) {
		try {
			return new URL(state.devUrl).origin;
		} catch {
			return state.devUrl;
		}
	}
	return "shellular-app://localhost";
}

function devScriptPath() {
	for (const arg of process.argv.slice(1)) {
		if (!arg || arg.startsWith("-")) continue;
		const resolved = path.resolve(arg);
		if (resolved.toLowerCase().endsWith(`${path.sep}main.cjs`.toLowerCase())) return resolved;
	}
	const fallback = process.argv[1];
	if (fallback && !String(fallback).startsWith("-")) return path.resolve(fallback);
	return "";
}

const AUTH_URL = /(?:shellular-dev|shellular|foxbiz):\/\/auth-callback[^\s"'<>]*/i;

function authUrlFromArgv(argv) {
	const list = Array.isArray(argv) ? argv : [];
	for (let i = list.length - 1; i >= 0; i--) {
		const url = authUrlFromArg(list[i]);
		if (url) return url;
	}
	return "";
}

function authUrlFromArg(value) {
	let text = String(value ?? "").trim().replace(/^\uFEFF/, "");
	if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
		text = text.slice(1, -1).trim();
	}
	if (isAuthCallbackUrl(text)) return text;
	const match = text.match(AUTH_URL);
	const candidate = match ? match[0] : text;
	if (isAuthCallbackUrl(candidate)) return candidate;
	try {
		const url = new URL(candidate);
		const scheme = url.protocol.replace(/:$/, "").toLowerCase();
		if (!["shellular", "shellular-dev", "foxbiz"].includes(scheme)) return "";
		if (url.hostname.toLowerCase() !== "auth-callback") return "";
		url.protocol = `${scheme}:`;
		url.hostname = "auth-callback";
		const canonical = url.toString();
		return isAuthCallbackUrl(canonical) ? canonical : "";
	} catch {
		return "";
	}
}

function decodePathname(pathname) {
	try {
		return decodeURIComponent(pathname);
	} catch {
		return pathname;
	}
}

function waitForMainFrame(contents) {
	if (!contents || contents.isDestroyed()) return Promise.reject(new Error("Window is gone"));
	if (contents.getURL() && !contents.isLoadingMainFrame()) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error("Main window is still loading"));
		}, 20000);
		const done = () => {
			cleanup();
			resolve();
		};
		const fail = () => {
			cleanup();
			reject(new Error("Window is gone"));
		};
		const cleanup = () => {
			clearTimeout(timer);
			contents.removeListener("did-stop-loading", done);
			contents.removeListener("destroyed", fail);
		};
		contents.once("did-stop-loading", done);
		contents.once("destroyed", fail);
	});
}

function readPort(url) {
	if (!url) return null;
	try {
		const port = Number(new URL(url).port);
		return Number.isInteger(port) && port > 0 ? port : null;
	} catch {
		return null;
	}
}

function iconPath() {
	const candidates = [
		path.join(__dirname, "..", "..", "src", "res", "logo.png"),
		path.join(process.resourcesPath || "", "logo.png"),
	];
	return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function mimeType(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".html":
			return "text/html; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".css":
			return "text/css; charset=utf-8";
		case ".json":
			return "application/json";
		case ".svg":
			return "image/svg+xml";
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".ico":
			return "image/x-icon";
		case ".ttf":
			return "font/ttf";
		case ".woff":
			return "font/woff";
		case ".woff2":
			return "font/woff2";
		case ".webp":
			return "image/webp";
		default:
			return "application/octet-stream";
	}
}

function htmlResponse(html) {
	return new Response(html, {
		headers: { "content-type": "text/html; charset=utf-8" },
	});
}

function textResponse(message, status = 200) {
	return new Response(message, {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}
