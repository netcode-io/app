import { execSync } from "node:child_process";
import { ensureElectron } from "./ensure-electron.js";

export default async function build() {
  await ensureElectron();
  const askWin = process.argv.includes("--win");
  const askMac = process.argv.includes("--mac");
  const flags = [];
  if (!askWin && !askMac) {
    flags.push(process.platform === "darwin" ? "--mac" : "--win");
  } else {
    if (askWin) flags.push("--win");
    if (askMac) flags.push("--mac");
  }

  const command = `electron-builder --projectDir "${process.cwd()}" --config platforms/desktop/electron-builder.yml ${flags.join(" ")}`;
  console.log(command);
  execSync(command, { stdio: "inherit" });
}
