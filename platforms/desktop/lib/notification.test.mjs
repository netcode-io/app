import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const notification = require("../services/notification.cjs");

function invoke(action, args) {
	return new Promise((resolve, reject) => {
		const callback = {
			success(value) {
				resolve(value);
			},
			error(error) {
				reject(new Error(String(error)));
			},
		};
		Promise.resolve(action(args, callback)).catch((error) => {
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

describe("desktop notifications without Electron", () => {
	it("refuses to create a notification", async () => {
		await expect(invoke(notification.create, ["Title", "Body"])).rejects.toThrow(
			"Notifications are not supported on this system",
		);
	});

	it("reports that show is unavailable before it looks up an id", async () => {
		await expect(invoke(notification.show, [1])).rejects.toThrow(
			"Notifications are not supported on this system",
		);
		await expect(invoke(notification.show, [])).rejects.toThrow(
			"Notifications are not supported on this system",
		);
	});

	it("reports a missing notification id", async () => {
		await expect(invoke(notification.hide, [1])).rejects.toThrow("Notification not found");
		await expect(invoke(notification.delete, [1])).rejects.toThrow("Notification not found");
		await expect(invoke(notification.addListener, [1])).rejects.toThrow("Notification not found");
	});
});
