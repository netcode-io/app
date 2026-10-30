let Notification = null;
try {
	const electron = require("electron");
	if (electron && typeof electron === "object" && typeof electron.Notification === "function") {
		Notification = electron.Notification;
	}
} catch {
	Notification = null;
}

const state = require("../state.cjs");

const notifications = new Map();
let nextId = 1;

function focusMainWindow() {
	const win = state.mainWindow;
	if (!win) return;
	try {
		if (typeof win.isDestroyed === "function" && win.isDestroyed()) return;
		if (
			typeof win.isMinimized === "function" &&
			win.isMinimized() &&
			typeof win.restore === "function"
		) {
			win.restore();
		}
		if (typeof win.show === "function") win.show();
		if (typeof win.focus === "function") win.focus();
	} catch {
		// A missing display must not swallow the click callback.
	}
}

function notificationsSupported() {
	if (!Notification || typeof Notification.isSupported !== "function") return false;
	try {
		return Boolean(Notification.isSupported());
	} catch {
		return false;
	}
}

function unsupported(callback) {
	callback.error("Notifications are not supported on this system");
}

function titleFor(title) {
	const text = title == null ? "" : String(title);
	if (text) return text;
	if (state.packageInfo && state.packageInfo.productName) {
		return String(state.packageInfo.productName);
	}
	return "Shellular";
}

function readId(args) {
	if (!Array.isArray(args) || args.length === 0) return null;
	const raw = args[0];
	const id = typeof raw === "string" ? Number(raw) : raw;
	if (typeof id !== "number" || !Number.isInteger(id)) return null;
	return id;
}

function find(args) {
	const id = readId(args);
	if (id == null) return null;
	return notifications.get(id) || null;
}

function attach(record, notification) {
	if (!notification || typeof notification.on !== "function") return;
	notification.on("click", () => {
		focusMainWindow();
		const listener = record.onClick;
		if (!listener || typeof listener.success !== "function") return;
		try {
			listener.keep = true;
			listener.success();
		} catch {
			// The page callback must not take down the main process.
		}
	});
	notification.on("close", () => {
		record.isClosed = true;
		record.visible = false;
	});
}

function mount(record) {
	if (!Notification) throw new Error("Notifications are not supported on this system");
	const options = record.options && typeof record.options === "object" ? record.options : {};
	const notification = new Notification({
		title: record.title,
		body: record.message,
		silent: Boolean(options.silent),
	});
	attach(record, notification);
	record.notification = notification;
	record.isClosed = false;
	record.visible = false;
	return notification;
}

function present(record) {
	if (!record.notification || record.isClosed) mount(record);
	if (record.visible && !record.isClosed) return;
	if (!record.notification || typeof record.notification.show !== "function") {
		throw new Error("Notifications are not supported on this system");
	}
	try {
		record.notification.show();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		// Electron throws if show() runs twice on a notification that is still up.
		if (!/already|shown/i.test(message)) throw error;
	}
	record.visible = true;
	record.isClosed = false;
}

function create(args, callback) {
	try {
		if (!notificationsSupported()) {
			unsupported(callback);
			return;
		}
		const list = Array.isArray(args) ? args : [];
		const options = list[2] && typeof list[2] === "object" ? list[2] : {};
		const record = {
			id: nextId++,
			title: titleFor(list[0]),
			message: list[1] == null ? "" : String(list[1]),
			options,
			notification: null,
			onClick: null,
			isClosed: false,
			visible: false,
		};
		present(record);
		notifications.set(record.id, record);
		callback.success(record.id);
	} catch {
		unsupported(callback);
	}
}

function show(args, callback) {
	try {
		if (!notificationsSupported()) {
			unsupported(callback);
			return;
		}
		const record = find(args);
		if (!record) {
			callback.error("Notification not found");
			return;
		}
		present(record);
		callback.success();
	} catch {
		unsupported(callback);
	}
}

function dismiss(record) {
	try {
		if (record.notification && typeof record.notification.close === "function") {
			record.notification.close();
		}
	} catch {
		// Already dismissed.
	}
	record.isClosed = true;
	record.visible = false;
}

function hide(args, callback) {
	try {
		const record = find(args);
		if (!record) {
			callback.error("Notification not found");
			return;
		}
		dismiss(record);
		callback.success();
	} catch {
		callback.error("Notification not found");
	}
}

function removeNotification(args, callback) {
	try {
		const id = readId(args);
		const record = id == null ? null : notifications.get(id);
		if (!record) {
			callback.error("Notification not found");
			return;
		}
		dismiss(record);
		notifications.delete(id);
		callback.success();
	} catch {
		callback.error("Notification not found");
	}
}

function addListener(args, callback) {
	try {
		const record = find(args);
		if (!record) {
			callback.error("Notification not found");
			return;
		}
		callback.keep = true;
		record.onClick = callback;
	} catch {
		callback.error("Notification not found");
	}
}

module.exports = {
	addListener,
	create,
	delete: removeNotification,
	hide,
	show,
};
