/** Shared handles for the desktop process. Services read this after startup. */
const state = {
	mainWindow: null,
	userData: "",
	bundleDir: "",
	isDev: false,
	devUrl: "",
	devPort: null,
	packageInfo: {
		name: "io.foxbiz.shellular",
		productName: "Shellular",
		version: "0.0.0",
		versionCode: "0",
		displayName: "Shellular",
	},
};

module.exports = state;
