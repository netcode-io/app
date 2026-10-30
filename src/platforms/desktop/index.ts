import { bytesToBase64 } from "bridge/file";
import toast from "lib/toast";
import scanner from "platforms/browser/services/scanner";

type CallbackPair = {
	success: (data: unknown) => void;
	error: (error: Error) => void;
};

type LocalHandler = (callback: Callback, args: unknown[]) => unknown;

const callbacks = new Map<number, CallbackPair>();
let callbackId = 0;

const scannerActions: Record<string, LocalHandler> = {
	...(scanner as unknown as Record<string, LocalHandler>),
	update(callback) {
		callback.success();
	},
};

const localActions: Record<string, Record<string, LocalHandler>> = {
	Native: {
		showToast(callback, args) {
			toast(String(args[0] ?? ""));
			callback.success();
		},
		hideSplashScreen(callback) {
			callback.success();
		},
	},
	Scanner: scannerActions,
};

export default async function setup() {
	if (!window.desktop) {
		throw new Error("Desktop bridge preload is not available");
	}
	installBridge();

	const style = document.createElement("style");
	style.textContent = `
		::-webkit-scrollbar { width: 10px; height: 10px; }
		::-webkit-scrollbar-thumb { background: var(--accent); border-radius: 999px; }
		::-webkit-scrollbar-track { background: transparent; }
	`;
	document.head.append(style);

	const root = document.documentElement;
	const setViewport = () => {
		root.style.setProperty("--vh", `${window.innerHeight}px`);
		root.style.setProperty("--vw", `${window.innerWidth}px`);
	};
	setViewport();
	window.addEventListener("resize", setViewport);

	window.addEventListener("mouseup", (event) => {
		if (event.button !== 3) return;
		event.preventDefault();
		document.dispatchEvent(new Event("backbutton"));
	});

	document.body.dataset.message = "Initializing scanner...";
	await scanner.init();
}

function installBridge() {
	window.desktop.onCallback((payload) => {
		const callback = callbacks.get(payload.id);
		if (!callback) return;
		if (!payload.keep) callbacks.delete(payload.id);

		let value = payload.success;
		if (payload.isBinary && payload.length && typeof value === "string") {
			const bytes = new Uint8Array(payload.length);
			for (let i = 0; i < payload.length; i++) bytes[i] = value.charCodeAt(i);
			value = bytes;
		}

		if (payload.error) {
			callback.error(new Error(String(payload.error)));
			return;
		}
		callback.success(value);
	});

	window.Bridge = {
		exec(success, error, service, action, args) {
			const local = localActions[service]?.[action];
			if (local) {
				const callback: Callback = {
					success: (data) => success(data),
					error: (message) => error(new Error(message)),
				};
				Promise.resolve()
					.then(() => local.call(localActions[service], callback, args ?? []))
					.catch((err: unknown) => {
						error(err instanceof Error ? err : new Error(String(err)));
					});
				return;
			}

			const id = ++callbackId;
			callbacks.set(id, { success, error });
			window.desktop.exec({
				id,
				service,
				action,
				args: (args ?? []).map(serializeArg),
			});
		},
	};
}

function serializeArg(value: unknown): unknown {
	if (value instanceof ArrayBuffer) {
		return bytesToBase64(new Uint8Array(value));
	}
	if (ArrayBuffer.isView(value)) {
		const view = value as ArrayBufferView;
		return bytesToBase64(
			new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
		);
	}
	return value;
}
