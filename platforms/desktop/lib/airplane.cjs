const { randomUUID } = require("node:crypto");
const zlib = require("node:zlib");

const HANDSHAKE_RE =
	/^shellular-airplane\/1 (plane|home) ([A-Za-z0-9-]{8,64})$/;
const FRAME_RE =
	/^shellular-frame\/1 ([A-Za-z0-9-]{8,80}) (\d+) (\d+) ([A-Za-z0-9_-]*)$/;
const CHUNK_CHARS = 2800;
const MAX_CHUNKS = 64;

function createHandshake(role, nonce = randomUUID()) {
	if (role !== "plane" && role !== "home") {
		throw new Error("Unknown airplane role");
	}
	const text = `shellular-airplane/1 ${role} ${nonce}`;
	if (!HANDSHAKE_RE.test(text)) throw new Error("Invalid handshake");
	return text;
}

function classify(raw) {
	const text = String(raw ?? "").replace(/\r\n/g, "\n").trim();
	const handshake = HANDSHAKE_RE.exec(text);
	if (handshake) {
		return { kind: "handshake", role: handshake[1], nonce: handshake[2] };
	}
	const frame = FRAME_RE.exec(text);
	if (frame) {
		const seq = Number(frame[2]);
		const total = Number(frame[3]);
		if (seq < 1 || total < 1 || seq > total || total > MAX_CHUNKS) {
			return { kind: "text", text };
		}
		return {
			kind: "frame",
			id: frame[1],
			seq,
			total,
			chunk: frame[4],
		};
	}
	return { kind: "text", text };
}

function packSession(body, sessionId) {
	const id = String(sessionId || "").trim();
	if (!id) throw new Error("Missing session id");
	const json = Buffer.from(JSON.stringify({ v: 1, sessionId: id, body }), "utf8");
	const packed = zlib.gzipSync(json).toString("base64url");
	const pieces = [];
	for (let index = 0; index < packed.length; index += CHUNK_CHARS) {
		pieces.push(packed.slice(index, index + CHUNK_CHARS));
	}
	if (!pieces.length) pieces.push("");
	if (pieces.length > MAX_CHUNKS) {
		throw new Error("Airplane payload is too large");
	}
	const frameId = randomUUID();
	return pieces.map(
		(chunk, index) =>
			`shellular-frame/1 ${frameId} ${index + 1} ${pieces.length} ${chunk}`,
	);
}

function createAssembler() {
	const pending = new Map();
	return {
		push(raw) {
			const part = classify(raw);
			if (part.kind !== "frame") return null;
			let entry = pending.get(part.id);
			if (!entry) {
				entry = { total: part.total, chunks: new Map() };
				pending.set(part.id, entry);
			}
			if (entry.total !== part.total) {
				pending.delete(part.id);
				throw new Error("Airplane frame length changed");
			}
			entry.chunks.set(part.seq, part.chunk);
			if (entry.chunks.size < entry.total) return null;
			const packed = Array.from({ length: entry.total }, (_, index) => {
				const chunk = entry.chunks.get(index + 1);
				if (chunk === undefined) throw new Error("Airplane frame is incomplete");
				return chunk;
			}).join("");
			pending.delete(part.id);
			let json;
			try {
				json = JSON.parse(zlib.gunzipSync(Buffer.from(packed, "base64url")).toString("utf8"));
			} catch {
				throw new Error("Airplane frame is corrupt");
			}
			if (!json || json.v !== 1 || typeof json.sessionId !== "string") {
				throw new Error("Airplane frame is corrupt");
			}
			return { sessionId: json.sessionId, body: json.body };
		},
	};
}

module.exports = {
	CHUNK_CHARS,
	classify,
	createAssembler,
	createHandshake,
	packSession,
};
