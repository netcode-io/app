import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { arch, hostname, platform, tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const device = require("../services/device.cjs");
const state = require("../state.cjs");

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

let root = "";

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "shellular-device-"));
	state.userData = root;
});

afterEach(async () => {
	state.userData = "";
	if (root) await rm(root, { recursive: true, force: true });
});

describe("desktop device id", () => {
	it("creates one stable hostname_platform_arch_uuid id", async () => {
		const first = await invoke(device.id, []);
		const second = await invoke(device.id, []);
		const file = await readFile(path.join(root, "device-id"), "utf8");
		expect(second).toBe(first);
		expect(file).toBe(first);
		expect(first.startsWith(`${hostname()}_${platform()}_${arch()}_`)).toBe(true);
	});

	it("freezes a bare uuid into the full id", async () => {
		const file = path.join(root, "device-id");
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		await writeFile(file, uuid, "utf8");
		const first = await invoke(device.id, []);
		const written = await readFile(file, "utf8");
		const before = await stat(file);
		const second = await invoke(device.id, []);
		const after = await stat(file);
		expect(first).toBe(`${hostname()}_${platform()}_${arch()}_${uuid}`);
		expect(written).toBe(first);
		expect(second).toBe(first);
		expect(after.mtimeMs).toBe(before.mtimeMs);
	});

	it("leaves an existing full id unchanged", async () => {
		const file = path.join(root, "device-id");
		await writeFile(file, "custom_full_id", "utf8");
		expect(await invoke(device.id, [])).toBe("custom_full_id");
		expect(await readFile(file, "utf8")).toBe("custom_full_id");
	});

	it("shares one id across concurrent calls", async () => {
		const ids = await Promise.all(Array.from({ length: 8 }, () => invoke(device.id, [])));
		expect(new Set(ids).size).toBe(1);
		expect(await readFile(path.join(root, "device-id"), "utf8")).toBe(ids[0]);
	});
});
