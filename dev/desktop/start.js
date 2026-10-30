import { spawn } from "node:child_process";
import { join } from "node:path";
import { ensureElectron } from "./ensure-electron.js";

export default async function start(server, onDone) {
  const electronPath = await ensureElectron();
  const appPath = join(process.cwd(), "platforms", "desktop", "main.cjs");
  const url = server ? `${server.protocol}://${server.host}:${server.port}` : "";
  const env = { ...process.env, SHELLULAR_DEV: url ? "1" : "0", SHELLULAR_DEV_URL: url };
  delete env.ELECTRON_RUN_AS_NODE;
  const args = [];
  if (process.env.SHELLULAR_DEBUG_PORT) {
    args.push(`--remote-debugging-port=${process.env.SHELLULAR_DEBUG_PORT}`);
  }
  args.push(appPath);

  console.log(`-> Desktop window: ${url || "production bundle"}`);
  const child = spawn(electronPath, args, {
    stdio: "inherit",
    env,
    windowsHide: false,
  });
  onDone?.();

  child.on("error", (error) => {
    console.error(`Failed to launch the desktop app: ${error.message}`);
    process.exit(1);
  });

  child.on("close", (code) => {
    process.exit(code || 0);
  });
}
