const { contextBridge, ipcRenderer } = require("electron");

let lastState = null;
let lastTheme = null;
const stateHandlers = [];
const themeHandlers = [];

function dispatch(handlers, value) {
	for (const handler of handlers) {
		try {
			handler(value);
		} catch (error) {
			console.error("[desktop] browser chrome", error);
		}
	}
}

ipcRenderer.on("browser:state", (_event, state) => {
	lastState = state;
	dispatch(stateHandlers, state);
});
ipcRenderer.on("browser:theme", (_event, theme) => {
	lastTheme = theme;
	dispatch(themeHandlers, theme);
});

contextBridge.exposeInMainWorld("browserChrome", {
	command(command, payload) {
		ipcRenderer.send("browser:command", command, payload);
	},
	onState(handler) {
		stateHandlers.push(handler);
		if (lastState) dispatch([handler], lastState);
	},
	onTheme(handler) {
		themeHandlers.push(handler);
		if (lastTheme) dispatch([handler], lastTheme);
	},
});
