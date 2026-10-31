import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const airplane = require("./airplane.cjs");

describe("airplane messages", () => {
	it("leaves agent slash commands as text", () => {
		expect(airplane.classify("/compact")).toEqual({ kind: "text", text: "/compact" });
		expect(airplane.classify("please /use claude and @src/main.ts")).toMatchObject({
			kind: "text",
		});
	});

	it("recognizes a desktop handshake and ignores a lookalike sentence", () => {
		const hello = airplane.createHandshake("plane", "abc12345");
		expect(airplane.classify(hello)).toEqual({
			kind: "handshake",
			role: "plane",
			nonce: "abc12345",
		});
		expect(airplane.classify("shellular-airplane/1 plane hello")).toMatchObject({
			kind: "text",
		});
	});

	it("round-trips one session and keeps another session separate", () => {
		const assembler = airplane.createAssembler();
		const first = airplane.packSession({ type: "ai.prompt", text: "hello" }, "session-a");
		const second = airplane.packSession({ type: "ai.prompt", text: "other" }, "session-b");
		expect(first.length).toBeGreaterThan(0);
		let done = null;
		for (const bubble of [...second, ...first.slice(1), first[0]]) {
			const result = assembler.push(bubble);
			if (result) done = result;
		}
		expect(done).toEqual({
			sessionId: "session-a",
			body: { type: "ai.prompt", text: "hello" },
		});
		expect(assembler.push(second[0])).toEqual({
			sessionId: "session-b",
			body: { type: "ai.prompt", text: "other" },
		});
	});

	it("splits a large body into ordered frames", () => {
		const body = randomBytes(4000).toString("base64");
		const frames = airplane.packSession(body, "session-big");
		expect(frames.length).toBeGreaterThan(1);
		const assembler = airplane.createAssembler();
		let result = null;
		for (const frame of frames) result = assembler.push(frame) ?? result;
		expect(result).toEqual({ sessionId: "session-big", body });
	});
});
