import { createRequire } from "node:module";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { connectImsg } = require("./imsg.cjs");

function fakeSpawn() {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const child = { stdin, stdout, stderr, kill() {}, on() {} };
	return { child, stdin, stdout };
}

describe("imsg-plus rpc client", () => {
	it("sends a phone number or an email and reads the reply", async () => {
		const fake = fakeSpawn();
		const seen = [];
		fake.stdin.on("data", (chunk) => seen.push(String(chunk)));
		const client = connectImsg({ spawn: () => fake.child });
		const sending = client.send({ to: "+14155551212", text: "ping", idempotency_key: "spike-1" });
		const request = JSON.parse(seen[0]);
		expect(request.method).toBe("send");
		expect(request.params.to).toBe("+14155551212");
		fake.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true, outcome: "sent" } })}\n`,
		);
		await expect(sending).resolves.toMatchObject({ outcome: "sent" });

		const mailed = client.send({ to: "hangar@icloud.com", text: "ping" });
		const mailRequest = JSON.parse(seen[1]);
		expect(mailRequest.params.to).toBe("hangar@icloud.com");
		fake.stdout.write(
			`${JSON.stringify({ jsonrpc: "2.0", id: mailRequest.id, result: { ok: true, outcome: "accepted" } })}\n`,
		);
		await expect(mailed).resolves.toMatchObject({ outcome: "accepted" });
		client.close();
	});

	it("emits incoming message notifications", async () => {
		const fake = fakeSpawn();
		const client = connectImsg({ spawn: () => fake.child });
		const notes = [];
		client.onNotification((message) => notes.push(message));
		fake.stdout.write(
			`${JSON.stringify({
				jsonrpc: "2.0",
				method: "message",
				params: { subscription: 1, message: { text: "/compact", is_from_me: false } },
			})}\n`,
		);
		await new Promise((resolve) => setImmediate(resolve));
		expect(notes[0].params.message.text).toBe("/compact");
		client.close();
	});
});
