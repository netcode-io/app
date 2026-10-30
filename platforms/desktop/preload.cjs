const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
	exec(payload) {
		ipcRenderer.send("bridge:exec", payload);
	},
	onCallback(handler) {
		ipcRenderer.on("bridge:callback", (_event, data) => {
			handler(data);
		});
	},
});
