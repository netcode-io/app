import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const files = require("../services/files.cjs");
const state = require("../state.cjs");
const fsp = require("node:fs/promises");

function invoke(action, args) {
	return new Promise((resolve, reject) => {
		const callback = {
			keep: false,
			events: [],
			success(value) {
				if (callback.keep) {
					callback.events.push(value);
					return;
				}
				resolve({ value, events: callback.events });
			},
			error(error) {
				reject(error instanceof Error ? error : new Error(String(error)));
			},
		};
		Promise.resolve(action(args, callback)).catch((error) => {
			reject(error instanceof Error ? error : new Error(String(error)));
		});
	});
}

function decodeRead(raw) {
	if (typeof raw !== "string") throw new Error("read did not return a base64 string");
	const binary = atob(raw);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64(bytes) {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

describe("desktop FileHandler", () => {
	let root = "";

	beforeEach(async () => {
		root = await mkdtemp(path.join(tmpdir(), "shellular-files-"));
		state.userData = root;
	});

	afterEach(async () => {
		state.userData = "";
		if (root) await rm(root, { recursive: true, force: true });
	});

	it("writes utf8 text, creates parents, and reads it back as base64", async () => {
		const text = '{"a":"héllo 🌟","b":"abcd"}';
		await invoke(files.write, ["/files/nested/app-state.json", text, false]);
		const read = await invoke(files.read, ["/files/nested/app-state.json"]);
		expect(new TextDecoder().decode(decodeRead(read.value))).toBe(text);
		expect((await invoke(files.exists, ["/files/nested/app-state.json"])).value).toBe(true);
	});

	it("stores real base64 and leaves invalid base64 as utf8", async () => {
		const bytes = Uint8Array.from([0, 1, 10, 127, 128, 255]);
		await invoke(files.write, ["/cache/blob.bin", bytesToBase64(bytes), true]);
		expect(Buffer.from(decodeRead((await invoke(files.read, ["/cache/blob.bin"])).value))).toEqual(
			Buffer.from(bytes),
		);

		await invoke(files.write, ["/files/note.txt", "not base64!!!", true]);
		expect(new TextDecoder().decode(decodeRead((await invoke(files.read, ["/files/note.txt"])).value))).toBe(
			"not base64!!!",
		);
	});

	it("accepts binary arguments the bridge may not have encoded yet", async () => {
		const bytes = new Uint8Array([4, 5, 6]);
		await invoke(files.write, ["/files/raw.bin", bytes, true]);
		expect(Buffer.from(decodeRead((await invoke(files.read, ["/files/raw.bin"])).value))).toEqual(
			Buffer.from(bytes),
		);
	});

	it("errors when createDirectory or createFile hits an existing path", async () => {
		expect((await invoke(files.createDirectory, ["/files/box"])).value).toBe("Directory created");
		await expect(invoke(files.createDirectory, ["/files/box"])).rejects.toThrow("PATH ALREADY EXISTS");
		expect((await invoke(files.createFile, ["/files/box/empty.txt"])).value).toBe("File created");
		await expect(invoke(files.createFile, ["/files/box/empty.txt"])).rejects.toThrow(
			"PATH ALREADY EXISTS",
		);
		const meta = (await invoke(files.getMetadata, ["/files/box/empty.txt"])).value;
		expect(meta).toMatchObject({
			name: "empty.txt",
			path: path.join(root, "files", "box", "empty.txt"),
			size: 0,
			isDirectory: false,
		});
		expect(meta.lastModified).toBe(new Date(meta.lastModified).toISOString());
		expect(Object.keys(meta).sort()).toEqual([
			"isDirectory",
			"lastModified",
			"name",
			"path",
			"size",
		]);
	});

	it("lists names and reports file metadata", async () => {
		await invoke(files.write, ["/files/a.txt", "a", false]);
		await invoke(files.createDirectory, ["/files/sub"]);
		const listed = (await invoke(files.list, ["/files"])).value;
		expect(listed.slice().sort()).toEqual(["a.txt", "sub"]);
		expect(listed.every((entry) => typeof entry === "string" && !entry.includes(path.sep))).toBe(
			true,
		);
		await expect(invoke(files.list, ["/files/a.txt"])).rejects.toThrow("Not a directory");

		const meta = (await invoke(files.getMetadata, ["/files"])).value;
		expect(meta).toMatchObject({
			name: "files",
			path: path.join(root, "files"),
			isDirectory: true,
		});
		expect(typeof meta.size).toBe("number");
		expect(meta.lastModified).toBe(new Date(meta.lastModified).toISOString());
		expect((await invoke(files.isDirectory, ["/files"])).value).toBe(true);
		expect((await invoke(files.isFile, ["/files"])).value).toBe(false);
		expect((await invoke(files.isFile, ["/files/a.txt"])).value).toBe(true);
		expect((await invoke(files.isDirectory, ["/files/a.txt"])).value).toBe(false);
		expect((await invoke(files.exists, ["/files/missing"])).value).toBe(false);
		expect((await invoke(files.isFile, ["/../../outside"])).value).toBe(false);
	});

	it("refuses to delete the data root and honors recursive", async () => {
		await invoke(files.write, ["/files/keep.txt", "x", false]);
		await expect(invoke(files.delete, [root, true])).rejects.toThrow(/data directory/);
		await expect(invoke(files.delete, ["/", true])).rejects.toThrow(/data directory/);
		await expect(invoke(files.delete, ["/files", false])).rejects.toThrow("Directory is not empty");
		expect(new TextDecoder().decode(decodeRead((await invoke(files.read, ["/files/keep.txt"])).value))).toBe(
			"x",
		);
		await invoke(files.delete, ["/files", true]);
		expect((await invoke(files.exists, ["/files"])).value).toBe(false);
	});

	it("moves and copies, creating missing parents", async () => {
		await invoke(files.write, ["/files/note.txt", "payload", false]);
		const copied = await invoke(files.copy, ["/files/note.txt", "/files/copies/note.txt"]);
		expect(copied.value).toBe(path.join(root, "files", "copies", "note.txt"));
		expect((await invoke(files.exists, ["/files/note.txt"])).value).toBe(true);

		const moved = await invoke(files.move, ["/files/note.txt", "/files/box/note.txt"]);
		expect(moved.value).toBe(path.join(root, "files", "box", "note.txt"));
		expect((await invoke(files.exists, ["/files/note.txt"])).value).toBe(false);
		expect(
			new TextDecoder().decode(decodeRead((await invoke(files.read, ["/files/box/note.txt"])).value)),
		).toBe("payload");
		await expect(invoke(files.move, ["/files/missing.txt", "/files/other.txt"])).rejects.toThrow(
			"Path does not exist",
		);
		await expect(invoke(files.copy, ["/files/box/note.txt", "/files/copies/note.txt"])).rejects.toThrow(
			"PATH ALREADY EXISTS",
		);
	});

	it("falls back to copy when rename crosses devices", async () => {
		await invoke(files.write, ["/files/note.txt", "payload", false]);
		await invoke(files.createDirectory, ["/files/dir"]);
		await invoke(files.write, ["/files/dir/child.txt", "child", false]);
		const original = fsp.rename;
		let calls = 0;
		fsp.rename = async () => {
			calls += 1;
			const error = new Error("cross-device link not permitted");
			error.code = "EXDEV";
			throw error;
		};
		try {
			await invoke(files.move, ["/files/note.txt", "/cache/note.txt"]);
			const movedDir = await invoke(files.move, ["/files/dir", "/cache/dir"]);
			expect(calls).toBe(2);
			expect(movedDir.value).toBe(path.join(root, "cache", "dir"));
			expect((await invoke(files.exists, ["/files/note.txt"])).value).toBe(false);
			expect((await invoke(files.exists, ["/files/dir"])).value).toBe(false);
			expect(
				new TextDecoder().decode(decodeRead((await invoke(files.read, ["/cache/note.txt"])).value)),
			).toBe("payload");
			expect(
				new TextDecoder().decode(decodeRead((await invoke(files.read, ["/cache/dir/child.txt"])).value)),
			).toBe("child");
		} finally {
			fsp.rename = original;
		}
	});

	it("resolves sandbox paths and builds app urls", async () => {
		const resolved = await invoke(files.resolve, ["/files/notes.txt"]);
		expect(resolved.value).toBe(pathToFileURL(path.join(root, "files", "notes.txt")).href);
		expect((await invoke(files.toUrl, ["/files/notes.txt"])).value).toBe(
			"shellular-app://localhost/__file__/notes.txt",
		);
		expect((await invoke(files.toUrl, [path.join(root, "cache", "preview.png")])).value).toBe(
			"shellular-app://localhost/__cache__/preview.png",
		);
		await expect(invoke(files.toUrl, ["/tmp/secret"])).rejects.toThrow(/created by the app/);
		await expect(invoke(files.read, ["../../outside"])).rejects.toThrow(/escapes/);
	});

	it("downloads to a file path or into an existing directory", async () => {
		const body = Buffer.from("hello download");
		const server = http.createServer((request, response) => {
			response.writeHead(200, {
				"content-type": "text/plain",
				"content-length": String(body.length),
				"content-disposition": 'attachment; filename="../../saved.txt"',
			});
			response.end(body);
		});
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		const port = typeof address === "object" && address ? address.port : 0;
		try {
			const direct = await invoke(files.download, [
				`http://127.0.0.1:${port}/ignored.bin`,
				"/files/direct.bin",
				"none",
			]);
			expect(direct.value).toBe(1);
			expect(direct.events.every((value) => typeof value === "number" && value < 1)).toBe(true);
			expect(
				new TextDecoder().decode(decodeRead((await invoke(files.read, ["/files/direct.bin"])).value)),
			).toBe("hello download");

			await invoke(files.createDirectory, ["/files/incoming"]);
			await invoke(files.download, [`http://127.0.0.1:${port}/ignored.bin`, "/files/incoming", "none"]);
			expect(
				new TextDecoder().decode(
					decodeRead((await invoke(files.read, ["/files/incoming/saved.txt"])).value),
				),
			).toBe("hello download");
			expect((await invoke(files.exists, ["/saved.txt"])).value).toBe(false);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
