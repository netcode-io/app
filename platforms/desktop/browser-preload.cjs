const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__shellularDesktop", {
	ensurePort(port) {
		const number = Number(port);
		if (!Number.isInteger(number) || number < 1 || number > 65535) return false;
		try {
			return ipcRenderer.sendSync("browser:ensure-port", number) === true;
		} catch {
			return false;
		}
	},
});
