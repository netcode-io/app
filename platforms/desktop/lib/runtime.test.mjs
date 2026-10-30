import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const runtime = require("./runtime.cjs");
const root = path.resolve(path.sep, "shellular-user-data");

describe("desktop app paths", () => {
  it("keeps files and cache inside the data directory", () => {
    expect(runtime.resolveAppPath(root, "/files/app-state.json")).toBe(
      path.join(root, "files", "app-state.json"),
    );
    expect(runtime.resolveAppPath(root, "/cache/preview.png")).toBe(
      path.join(root, "cache", "preview.png"),
    );
  });

  it("accepts a path that is already inside the data directory", () => {
    const inside = path.join(root, "files", "notes.txt");
    expect(runtime.resolveAppPath(root, inside)).toBe(inside);
  });

  it("rejects a path that escapes the data directory", () => {
    expect(() => runtime.resolveAppPath(root, "/../../outside")).toThrow(/escapes/);
  });

  it("builds file and cache URLs the window can load", () => {
    expect(runtime.toAppUrl(root, "/files/notes.txt")).toBe(
      "shellular-app://localhost/__file__/notes.txt",
    );
    expect(runtime.toAppUrl(root, path.join(root, "cache", "preview.png"))).toBe(
      "shellular-app://localhost/__cache__/preview.png",
    );
  });

  it("refuses to address files outside the app directories", () => {
    expect(() => runtime.toAppUrl(root, "/tmp/secret")).toThrow(/created by the app/);
  });
});

describe("desktop auth callbacks", () => {
  it("recognizes shellular auth callback URLs", () => {
    expect(runtime.isAuthCallbackUrl("shellular://auth-callback?code=abc")).toBe(true);
    expect(runtime.isAuthCallbackUrl("shellular-dev://auth-callback?code=abc")).toBe(true);
    expect(runtime.isAuthCallbackUrl("https://shellular.dev/auth-callback")).toBe(false);
  });

  it("reads the callback query", () => {
    expect(runtime.authParams("shellular://auth-callback?code=abc&state=ok")).toEqual({
      code: "abc",
      state: "ok",
    });
  });

  it("reads the port from a localhost http URL", () => {
    expect(runtime.localhostHttpPort("http://127.0.0.1:3000/app")).toBe(3000);
    expect(runtime.localhostHttpPort("https://localhost/app")).toBe(null);
    expect(runtime.localhostHttpPort("http://example.com")).toBe(null);
  });
});
