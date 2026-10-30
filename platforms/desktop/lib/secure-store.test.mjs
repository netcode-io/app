import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const store = require("../services/secure-store.cjs");
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
	root = await mkdtemp(path.join(tmpdir(), "shellular-secure-"));
	state.userData = root;
});

afterEach(async () => {
	state.userData = "";
	if (root) await rm(root, { recursive: true, force: true });
});

describe("desktop secure store", () => {
	it("round-trips a value with a prefixed encoding", async () => {
		await invoke(store.set, ["token", "hello secret"]);
		expect(await invoke(store.get, ["token"])).toBe("hello secret");
		const raw = await readFile(path.join(root, "secure-store.json"), "utf8");
		expect(raw).not.toContain("hello secret");
		expect(raw).toMatch(/"(enc|plain):/);
		await invoke(store.remove, ["token"]);
		expect(await invoke(store.get, ["token"])).toBeNull();
	});

	it("rejects an empty key and returns null for a missing one", async () => {
		for (const args of [undefined, null, [], [""], [1], [null]]) {
			await expect(invoke(store.set, args)).rejects.toThrow("Missing key");
			await expect(invoke(store.remove, args)).rejects.toThrow("Missing key");
			expect(await invoke(store.get, args)).toBeNull();
		}
	});

	it("reports corrupt JSON and does not rewrite the file", async () => {
		const file = path.join(root, "secure-store.json");
		await writeFile(file, "{not json", "utf8");
		await expect(invoke(store.get, ["token"])).rejects.toThrow("Secure store is corrupt");
		await expect(invoke(store.set, ["token", "x"])).rejects.toThrow("Secure store is corrupt");
		await expect(invoke(store.remove, ["token"])).rejects.toThrow("Secure store is corrupt");
		expect(await readFile(file, "utf8")).toBe("{not json");
	});

	it("keeps overlapping writes", async () => {
		await Promise.all([
			invoke(store.set, ["a", "alpha"]),
			invoke(store.set, ["b", "beta"]),
			invoke(store.set, ["a", "ALPHA"]),
		]);
		expect(await invoke(store.get, ["a"])).toBe("ALPHA");
		expect(await invoke(store.get, ["b"])).toBe("beta");
	});
});
