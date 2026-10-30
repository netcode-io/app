const fs = require("node:fs");
const path = require("node:path");
const { session, shell } = require("electron");
const { authParams, isAuthCallbackUrl, localhostHttpPort, resolveAppPath } = require("../lib/runtime.cjs");
const native = require("./native.cjs");
const proxy = require("./proxy.cjs");
const state = require("../state.cjs");

const CHROME_HEIGHT = 52;
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const WINDOW_WIDTH = 1100;
const WINDOW_HEIGHT = 760;
const LOAD_TIMEOUT_MS = 15 * 1000;
const PAGE_ATTEMPTS = 10;
const PAGE_RETRY_MS = 300;
const PAGE_TIMEOUT_MS = PAGE_ATTEMPTS * PAGE_RETRY_MS + 1500;
const BROWSER_PARTITION = "persist:shellular-browser";

let browserWindow = null;
let chromeView = null;
let pageView = null;
let pageContents = null;
let chromeContents = null;
let pendingAuth = null;
let strandedAuthUrl = null;
let lastDeliveredAuthUrl = null;
let htmlPayload = "";
let shellularProtocolReady = false;
let allowLocalhostPort = 0;

// Do not call ensurePort from this script. sendSync while executeJavaScript is
// running deadlocks the main process.
const HOOK = `(() => {
	if (window.__shellularHooksInjected) return;
	window.__shellularHooksInjected = true;
	function ensure(input) {
		try {
			var parsed = new URL(String(input), location.href);
			if (parsed.protocol !== "http:" && parsed.protocol !== "ws:") return;
			var host = parsed.hostname;
			if (host !== "localhost" && host !== "127.0.0.1" && host !== "0.0.0.0") return;
			var port = parsed.port || "80";
			if (window.__shellularDesktop && window.__shellularDesktop.ensurePort) {
				window.__shellularDesktop.ensurePort(parseInt(port, 10));
			}
		} catch (error) {}
	}
	var originalFetch = window.fetch;
	if (originalFetch) {
		window.fetch = function (input, init) {
			var url = typeof input === "string" ? input : input && input.url;
			if (url) ensure(url);
			return originalFetch.apply(this, arguments);
		};
	}
	var originalOpen = XMLHttpRequest.prototype.open;
	XMLHttpRequest.prototype.open = function (method, url) {
		ensure(url);
		return originalOpen.apply(this, arguments);
	};
	var OriginalEventSource = window.EventSource;
	if (OriginalEventSource) {
		window.EventSource = function (url, config) {
			ensure(url);
			return new OriginalEventSource(url, config);
		};
		window.EventSource.prototype = OriginalEventSource.prototype;
		window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
		window.EventSource.OPEN = OriginalEventSource.OPEN;
		window.EventSource.CLOSED = OriginalEventSource.CLOSED;
	}
	var OriginalWebSocket = window.WebSocket;
	if (OriginalWebSocket) {
		window.WebSocket = function (url, protocols) {
			ensure(url);
			return new OriginalWebSocket(url, protocols);
		};
		window.WebSocket.prototype = OriginalWebSocket.prototype;
		window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
		window.WebSocket.OPEN = OriginalWebSocket.OPEN;
		window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
		window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
	}
})();`;

function themeColor(theme, key, fallback) {
	if (!theme || typeof theme !== "object") return fallback;
	const value = theme[key];
	if (typeof value !== "string") return fallback;
	return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) ? value : fallback;
}

function cssColor(theme, key, fallback) {
	const value = themeColor(theme, key, fallback);
	if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value)) return value;
	return fallback;
}

function electronBackground(color) {
	// Electron accepts #RRGGBB or #AARRGGBB. A 3-digit value throws.
	if (/^#[0-9a-fA-F]{3}$/.test(color)) {
		const red = color[1];
		const green = color[2];
		const blue = color[3];
		return `#${red}${red}${green}${green}${blue}${blue}`;
	}
	if (/^#[0-9a-fA-F]{6}$/.test(color)) return color;
	// Theme hex is #RRGGBBAA. Electron's window background is #AARRGGBB.
	if (/^#[0-9a-fA-F]{8}$/.test(color)) return `#${color.slice(7, 9)}${color.slice(1, 7)}`;
	return "#0d0d0f";
}

function normalizeUserUrl(input) {
	const value = String(input || "").trim();
	if (!value) return "shellular://home";
	if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
	if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
	return `https://${value}`;
}

function reportCallbackError(callback, error) {
	const message = error instanceof Error ? error.message : String(error);
	try {
		callback.error(message);
	} catch {
		// The bridge callback is already gone.
	}
}

function injectHooks() {
	if (!pageContents || pageContents.isDestroyed()) return;
	pageContents.executeJavaScript(HOOK).catch(() => {});
}

function attachPage(contents) {
	pageContents = contents;
	contents.setWindowOpenHandler(({ url }) => {
		loadPage(url).catch((error) => console.error("[desktop] browser window open", error));
		return { action: "deny" };
	});
	contents.on("will-navigate", (event, url) => {
		if (isAuthCallbackUrl(url)) {
			event.preventDefault();
			deliverAuth(url);
			return;
		}
		const port = localhostHttpPort(url);
		if (!port || port === state.devPort || proxy.has(port)) return;
		if (allowLocalhostPort === port) {
			allowLocalhostPort = 0;
			return;
		}
		event.preventDefault();
		proxy.ensure(port).finally(() => {
			if (contents.isDestroyed()) return;
			if (!proxy.has(port)) allowLocalhostPort = port;
			contents.loadURL(url).catch((error) => console.error("[desktop] browser load", error));
		});
	});
	contents.on("did-start-navigation", (_event, _url, _isInPlace, isMainFrame) => {
		if (isMainFrame === false) return;
		injectHooks();
	});
	contents.on("did-navigate", injectHooks);
	contents.on("dom-ready", injectHooks);
	contents.on("did-start-loading", publishChrome);
	contents.on("did-stop-loading", () => {
		publishChrome();
		rememberHistory();
	});
	contents.on("page-title-updated", publishChrome);
	contents.on("did-navigate", publishChrome);
	contents.on("did-navigate-in-page", publishChrome);
}

function historyFlags(contents) {
	try {
		const history = contents.navigationHistory;
		if (history && typeof history.canGoBack === "function" && typeof history.canGoForward === "function") {
			return {
				canGoBack: !!history.canGoBack(),
				canGoForward: !!history.canGoForward(),
			};
		}
	} catch {
		// Fall back to the deprecated methods.
	}
	try {
		return {
			canGoBack: !!contents.canGoBack(),
			canGoForward: !!contents.canGoForward(),
		};
	} catch {
		return { canGoBack: false, canGoForward: false };
	}
}

function publishChrome() {
	if (!pageContents || pageContents.isDestroyed() || !chromeContents || chromeContents.isDestroyed()) return;
	let url = "";
	let title = "";
	let loading = false;
	try {
		url = pageContents.getURL();
		title = pageContents.getTitle();
		loading = pageContents.isLoading();
	} catch {
		return;
	}
	const flags = historyFlags(pageContents);
	try {
		chromeContents.send("browser:state", {
			url,
			title,
			canGoBack: flags.canGoBack,
			canGoForward: flags.canGoForward,
			loading,
		});
	} catch {
		// Chrome view is closing.
	}
}

function rememberHistory() {
	if (!pageContents || pageContents.isDestroyed()) return;
	const win = state.mainWindow;
	if (!win || win.isDestroyed()) return;
	let url = "";
	let title = "";
	try {
		url = pageContents.getURL();
		title = pageContents.getTitle() || url;
	} catch {
		return;
	}
	if (!url.startsWith("http://") && !url.startsWith("https://")) return;
	let favicon = "";
	try {
		const parsed = new URL(url);
		favicon = `${parsed.origin}/favicon.ico`;
	} catch {
		favicon = "";
	}
	const entry = { url, title, favicon };
	const js = `window.__shellularHistory && window.__shellularHistory(${JSON.stringify(entry)})`;
	win.webContents.executeJavaScript(js).catch(() => {});
}

function loadContents(contents, url) {
	let timer = null;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(resolve, LOAD_TIMEOUT_MS);
	});
	const load = contents.loadURL(url).catch((error) => {
		console.error("[desktop] browser load", error);
	});
	return Promise.race([load, timeout]).finally(() => clearTimeout(timer));
}

async function loadPage(rawUrl) {
	const url = normalizeUserUrl(rawUrl);
	if (isAuthCallbackUrl(url)) {
		deliverAuth(url);
		return;
	}
	if (!pageContents || pageContents.isDestroyed()) return;
	if (url.startsWith("shellular://") || url.startsWith("http://") || url.startsWith("https://")) {
		const port = localhostHttpPort(url);
		if (port && port !== state.devPort && !proxy.has(port)) await proxy.ensure(port);
		if (!pageContents || pageContents.isDestroyed()) return;
		await loadContents(pageContents, url);
		return;
	}
	await native.openExternal(url);
}

function contentSize() {
	let width = 0;
	let height = 0;
	try {
		if (typeof browserWindow.getContentSize === "function") {
			const size = browserWindow.getContentSize();
			width = Number(size[0]) || 0;
			height = Number(size[1]) || 0;
		} else {
			const bounds = browserWindow.getContentBounds();
			width = Number(bounds.width) || 0;
			height = Number(bounds.height) || 0;
		}
	} catch {
		width = 0;
		height = 0;
	}
	if (width < 1 || height < 1) return { width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
	return { width: Math.round(width), height: Math.round(height) };
}

function layout() {
	if (!browserWindow || browserWindow.isDestroyed() || !chromeView || !pageView) return;
	const size = contentSize();
	const pageHeight = Math.max(0, size.height - CHROME_HEIGHT);
	try {
		chromeView.setBounds({ x: 0, y: 0, width: size.width, height: CHROME_HEIGHT });
		pageView.setBounds({ x: 0, y: CHROME_HEIGHT, width: size.width, height: pageHeight });
	} catch {
		// Window is closing.
	}
}

function layoutSoon() {
	layout();
	setTimeout(layout, 0);
	setTimeout(layout, 50);
}

function destroyContents(contents) {
	if (!contents) return;
	try {
		if (!contents.isDestroyed()) contents.close();
	} catch {
		// Already destroyed.
	}
	try {
		if (!contents.isDestroyed() && typeof contents.destroy === "function") contents.destroy();
	} catch {
		// Already destroyed.
	}
}

function textResponse(message, status = 200) {
	return new Response(String(message), {
		status,
		headers: { "content-type": "text/plain; charset=utf-8" },
	});
}

function htmlResponse(html) {
	return new Response(String(html), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"access-control-allow-origin": "*",
		},
	});
}

function mimeFor(filePath) {
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

function fallbackPage(message) {
	const text = String(message || "Page unavailable.")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
	return `<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#0d0d0f;color:#f5f1e8;font-family:sans-serif;padding:24px">${text}</body></html>`;
}

function shellularPageHtml(name) {
	const win = state.mainWindow;
	if (!win || win.isDestroyed()) return Promise.resolve(fallbackPage("Shellular is still starting."));
	const js = `(() => {
		function attempt(left) {
			if (typeof window.__shellularPage !== "function") {
				if (left <= 0) return "";
				return new Promise((resolve) => {
					setTimeout(() => resolve(attempt(left - 1)), ${PAGE_RETRY_MS});
				});
			}
			try {
				return Promise.resolve(window.__shellularPage(${JSON.stringify(name)})).then(
					(html) => (typeof html === "string" ? html : ""),
					() => "",
				);
			} catch (error) {
				return "";
			}
		}
		return attempt(${PAGE_ATTEMPTS});
	})()`;
	let timer = null;
	const timeout = new Promise((resolve) => {
		timer = setTimeout(() => resolve(""), PAGE_TIMEOUT_MS);
	});
	return Promise.race([
		win.webContents.executeJavaScript(js).catch(() => ""),
		timeout,
	]).then((html) => {
		clearTimeout(timer);
		return typeof html === "string" && html ? html : fallbackPage("Page unavailable.");
	});
}

function serveAsset(relative) {
	try {
		if (!state.bundleDir) return textResponse("Not found", 404);
		const filePath = resolveAppPath(state.bundleDir, relative || "index.html");
		if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
			return textResponse("Not found", 404);
		}
		const data = fs.readFileSync(filePath);
		// Copy out of the Node buffer pool. A Buffer body makes Chromium read slack bytes.
		const bytes = new Uint8Array(data.byteLength);
		bytes.set(data);
		return new Response(bytes, {
			headers: {
				"content-type": mimeFor(filePath),
				"content-length": String(bytes.byteLength),
				"cache-control": "no-cache",
				"access-control-allow-origin": "*",
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResponse(message, 404);
	}
}

async function handleShellular(request) {
	try {
		if (isAuthCallbackUrl(request.url)) {
			deliverAuth(request.url);
			return textResponse("Signed in. You can close this window.");
		}
		const url = new URL(request.url);
		if (url.hostname === "assets") {
			return serveAsset(decodeURIComponent(url.pathname).replace(/^\/+/, ""));
		}
		if (url.hostname === "raw") {
			return htmlResponse(htmlPayload || "<p>Nothing to show.</p>");
		}
		const name = url.hostname || "home";
		return htmlResponse(await shellularPageHtml(name));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return textResponse(message, 500);
	}
}

function installShellularProtocol() {
	if (shellularProtocolReady) return;
	let browserSession = null;
	try {
		browserSession = session.fromPartition(BROWSER_PARTITION);
	} catch (error) {
		console.error("[desktop] browser session", error);
		return;
	}
	try {
		// main.cjs already registers shellular on this partition. A second
		// handle throws "Failed to register protocol: shellular".
		browserSession.protocol.handle("shellular", (request) => handleShellular(request));
		shellularProtocolReady = true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/already|failed to register protocol/i.test(message)) {
			shellularProtocolReady = true;
			return;
		}
		console.error("[desktop] shellular protocol", error);
	}
}

function createWindow(theme) {
	if (browserWindow && !browserWindow.isDestroyed()) {
		browserWindow.show();
		browserWindow.focus();
		layoutSoon();
		return browserWindow;
	}

	installShellularProtocol();
	const { BaseWindow, WebContentsView } = require("electron");
	const primary = cssColor(theme, "primary", "#0d0d0f");
	const win = new BaseWindow({
		width: WINDOW_WIDTH,
		height: WINDOW_HEIGHT,
		minWidth: 640,
		minHeight: 480,
		title: "Shellular Browser",
		backgroundColor: electronBackground(primary),
		autoHideMenuBar: true,
		show: false,
		useContentSize: true,
	});
	if (process.platform !== "darwin") {
		try {
			if (typeof win.setMenuBarVisibility === "function") win.setMenuBarVisibility(false);
			if (typeof win.setMenu === "function") win.setMenu(null);
		} catch {
			// This window has no menu bar.
		}
	}
	chromeView = new WebContentsView({
		webPreferences: {
			preload: path.join(__dirname, "..", "chrome-preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});
	pageView = new WebContentsView({
		webPreferences: {
			preload: path.join(__dirname, "..", "browser-preload.cjs"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			partition: BROWSER_PARTITION,
		},
	});
	try {
		if (typeof pageView.setBackgroundColor === "function") pageView.setBackgroundColor("#ffffff");
	} catch {
		// This build paints the page view without a separate background.
	}
	win.contentView.addChildView(chromeView);
	win.contentView.addChildView(pageView);
	browserWindow = win;
	chromeContents = chromeView.webContents;
	attachPage(pageView.webContents);
	win.on("resize", layout);
	win.on("maximize", layout);
	win.on("unmaximize", layout);
	win.on("restore", layout);
	win.on("enter-full-screen", layout);
	win.on("leave-full-screen", layout);
	win.on("show", layoutSoon);
	win.on("closed", () => {
		const page = pageContents;
		const chrome = chromeContents;
		browserWindow = null;
		chromeView = null;
		pageView = null;
		pageContents = null;
		chromeContents = null;
		destroyContents(page);
		destroyContents(chrome);
		proxy.stopAll();
	});
	chromeContents.once("did-finish-load", () => {
		if (!chromeContents || chromeContents.isDestroyed()) return;
		const colors = {
			primary,
			primaryText: cssColor(theme, "primaryText", "#f5f1e8"),
			accent: cssColor(theme, "info", "#d6c2a1"),
			secondary: cssColor(theme, "secondary", "#1b1b1f"),
		};
		try {
			chromeContents.send("browser:theme", colors);
		} catch {
			// Chrome view is closing.
		}
		publishChrome();
		layoutSoon();
	});
	chromeView.webContents.loadFile(path.join(__dirname, "..", "browser-chrome.html")).catch((error) => {
		console.error("[desktop] browser chrome", error);
	});
	layout();
	win.show();
	layoutSoon();
	return win;
}

function go(direction) {
	if (!pageContents || pageContents.isDestroyed()) return;
	const history = pageContents.navigationHistory;
	try {
		if (direction === "back") {
			if (history && typeof history.canGoBack === "function") {
				if (history.canGoBack()) history.goBack();
				return;
			}
			if (pageContents.canGoBack()) pageContents.goBack();
			return;
		}
		if (history && typeof history.canGoForward === "function") {
			if (history.canGoForward()) history.goForward();
			return;
		}
		if (pageContents.canGoForward()) pageContents.goForward();
	} catch (error) {
		console.error("[desktop] browser history", error);
	}
}

function handleChromeCommand(command, payload) {
	if (command === "refresh") {
		publishChrome();
		return;
	}
	if (!pageContents || pageContents.isDestroyed()) return;
	if (command === "navigate") {
		loadPage(payload).catch((error) => console.error("[desktop] browser navigate", error));
		return;
	}
	if (command === "back") go("back");
	if (command === "forward") go("forward");
	if (command === "reload") pageContents.reload();
	if (command === "stop") pageContents.stop();
	if (command === "home") loadPage("shellular://home").catch((error) => console.error("[desktop] browser home", error));
	if (command === "devtools") pageContents.toggleDevTools();
	if (command === "external") {
		let url = "";
		try {
			url = pageContents.getURL();
		} catch {
			return;
		}
		if (url.startsWith("http://") || url.startsWith("https://")) {
			shell.openExternal(url).catch(() => {});
		}
	}
}

function authResult(url) {
	return JSON.stringify({ url, params: authParams(url) });
}

function notifyAuthIntent(url) {
	try {
		native.emitIntent({
			action: "auth-callback",
			extras: authParams(url),
		});
	} catch (error) {
		console.error("[desktop] auth intent", error);
	}
}

function focusMainWindow() {
	const win = state.mainWindow;
	if (!win || win.isDestroyed()) return;
	try {
		if (typeof win.isMinimized === "function" && win.isMinimized()) win.restore();
		win.show();
		win.focus();
	} catch (error) {
		console.error("[desktop] focus", error);
	}
}

function succeedAuth(callback, url) {
	lastDeliveredAuthUrl = url;
	try {
		callback.success(authResult(url));
	} catch (error) {
		reportCallbackError(callback, error);
	}
}

function deliverAuth(url) {
	if (!isAuthCallbackUrl(url)) return false;
	if (url === lastDeliveredAuthUrl) return true;
	if (!pendingAuth) {
		if (strandedAuthUrl !== url) {
			strandedAuthUrl = url;
			notifyAuthIntent(url);
		}
		return true;
	}
	const current = pendingAuth;
	pendingAuth = null;
	clearTimeout(current.timer);
	succeedAuth(current.callback, url);
	notifyAuthIntent(url);
	focusMainWindow();
	return true;
}

function failPendingAuth(message) {
	if (!pendingAuth) return;
	const current = pendingAuth;
	pendingAuth = null;
	clearTimeout(current.timer);
	try {
		current.callback.error(message);
	} catch (error) {
		console.error("[desktop] auth callback", error);
	}
}

async function open(args, callback) {
	try {
		const url = args[0] ? String(args[0]) : "";
		createWindow(args[1]);
		await loadPage(url || "shellular://home");
		callback.success("Opened browser");
	} catch (error) {
		console.error("[desktop] browser open", error);
		reportCallbackError(callback, error);
	}
}

async function openHTML(args, callback) {
	try {
		const html = String(args[0] || "");
		if (!html) {
			callback.error("Missing HTML");
			return;
		}
		htmlPayload = html;
		createWindow(args[1]);
		await loadPage("shellular://raw");
		callback.success("Opened browser");
	} catch (error) {
		console.error("[desktop] browser open", error);
		reportCallbackError(callback, error);
	}
}

function openForAuth(args, callback) {
	const url = String(args[0] || "");
	if (!url) {
		callback.error("Missing URL");
		return;
	}
	if (strandedAuthUrl && isAuthCallbackUrl(strandedAuthUrl)) {
		const stranded = strandedAuthUrl;
		strandedAuthUrl = null;
		succeedAuth(callback, stranded);
		return;
	}
	failPendingAuth("Auth superseded");
	const timer = setTimeout(() => {
		if (pendingAuth && pendingAuth.callback === callback) failPendingAuth("Auth timed out");
	}, AUTH_TIMEOUT_MS);
	pendingAuth = { callback, timer };
	shell.openExternal(url).catch((error) => {
		if (!pendingAuth || pendingAuth.callback !== callback) return;
		failPendingAuth(error instanceof Error ? error.message : String(error));
	});
}

function close() {
	if (browserWindow && !browserWindow.isDestroyed()) browserWindow.close();
}

function takeHtml() {
	return htmlPayload;
}

module.exports = {
	close,
	deliverAuth,
	handleChromeCommand,
	open,
	openForAuth,
	openHTML,
	takeHtml,
};
